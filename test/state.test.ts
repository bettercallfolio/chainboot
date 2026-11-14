import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildImage } from "../src/image/build.ts";
import { extractImage } from "../src/image/extract.ts";
import { parseManifest, serializeManifest } from "../src/image/manifest.ts";
import { readTar, writeTar, type Entry } from "../src/image/tar.ts";
import { decompress } from "../src/codec/index.ts";
import { Keypair } from "../src/solana/keys.ts";
import { RpcPool } from "../src/solana/rpc.ts";
import { ChainStore } from "../src/store/store.ts";
import { isUnsaved, scanMachine } from "../src/state/scan.ts";
import { applySnapshot, loadPacks, readHead, readIndex, readSnapshot, saveSnapshot } from "../src/state/snapshot.ts";
import { LOGIN_MESSAGE, deriveVault, objectKey, open, openFrom, openWithKey, parseShareAddress, seal, sealTo, sealWithKey, shareAddress, shareKeys, vaultFromKeypair } from "../src/state/vault.ts";
import { acceptImage, acceptMachine, listShares, myShareAddress, shareImage, shareMachine } from "../src/share/share.ts";
import { canReadXattrs, readXattrs, writeXattrs } from "../src/util/xattr.ts";
import type { MachineInfo } from "../src/engine/linux.ts";
import { FakeChain } from "./helpers/fakechain.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-state-"));
const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
// symlinks, owners and modes are Linux/macOS concepts; machines never run directly on Windows
const posix = process.platform !== "win32";
const T = 1_700_000_000;
const f = (p: string, data: string | Buffer, mode = 0o644): Entry => ({ path: p, type: "f", mode, uid, gid, mtime: T, data: Buffer.from(data) });
const d = (p: string, mode = 0o755): Entry => ({ path: p, type: "d", mode, uid, gid, mtime: T });

/** Every object below `root` as "path type mode size sha|target", for comparing two trees. */
function listing(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const p = rel ? `${rel}/${name}` : name, st = fs.lstatSync(path.join(root, p));
      if (st.isDirectory()) { out.push(`${p} d ${(st.mode & 0o7777).toString(8)}`); walk(p); }
      else if (st.isSymbolicLink()) out.push(`${p} l ${fs.readlinkSync(path.join(root, p))}`);
      else out.push(`${p} f ${(st.mode & 0o7777).toString(8)} ${st.size} ${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, p))).digest("hex").slice(0, 16)} ${Math.floor(st.mtimeMs / 1000)}`);
    }
  };
  walk("");
  return out;
}

test("vault: one signature gives the same keys everywhere; encryption is authenticated", () => {
  const wallet = Keypair.generate();
  const a = vaultFromKeypair(wallet, "devnet"), b = deriveVault(wallet.address, wallet.sign(Buffer.from(LOGIN_MESSAGE)), "devnet");
  assert.equal(a.signer.address, b.signer.address);
  assert.deepEqual(a.encKey, b.encKey);
  assert.notEqual(a.signer.address, wallet.address, "the vault is a different account than the wallet");
  assert.notEqual(vaultFromKeypair(wallet, "mainnet-beta").signer.address, a.signer.address, "each network has its own vault");
  assert.throws(() => deriveVault(Keypair.generate().address, wallet.sign(Buffer.from(LOGIN_MESSAGE)), "devnet"), /not a valid signature/);
  const secret = crypto.randomBytes(5000), sealed = seal(a.encKey, secret, "pack");
  assert.deepEqual(open(b.encKey, sealed, "pack"), secret);
  // the same content sealed again gives the same bytes (an interrupted upload of it can continue);
  // any other content, or another purpose, gets another key and nonce
  assert.deepEqual(seal(a.encKey, secret, "pack"), sealed);
  const other = seal(a.encKey, Buffer.concat([secret, Buffer.from("!")]), "pack");
  assert.notDeepEqual(other.subarray(1, 29), sealed.subarray(1, 29), "other content: another key id and nonce");
  assert.notDeepEqual(seal(a.encKey, secret, "snapshot").subarray(1, 29), sealed.subarray(1, 29), "another purpose: another key id and nonce");
  assert.throws(() => open(a.encKey, sealed, "snapshot"), /could not decrypt/);
  assert.throws(() => open(vaultFromKeypair(Keypair.generate(), "devnet").encKey, sealed, "pack"), /could not decrypt/);
  const bad = Buffer.from(sealed); bad[40] = bad[40]! ^ 1;
  assert.throws(() => open(a.encKey, bad, "pack"), /could not decrypt/);

  // every object has a key of its own: it opens that object and no other
  // (objects with the very same content share a key; knowing it reveals nothing more than that content)
  const one = sealWithKey(a.encKey, secret, "pack"), two = sealWithKey(a.encKey, crypto.randomBytes(5000), "pack");
  assert.notEqual(one.key, two.key);
  assert.equal(objectKey(a.encKey, one.sealed, "pack")!.toString("base64"), one.key, "the owner can work the key out again");
  assert.deepEqual(openWithKey(Buffer.from(one.key, "base64"), one.sealed, "pack"), secret);
  assert.throws(() => openWithKey(Buffer.from(one.key, "base64"), two.sealed, "pack"), /could not decrypt/);
  assert.throws(() => openWithKey(Buffer.from(one.key, "base64"), one.sealed, "snapshot"), /could not decrypt/);
  // what earlier releases wrote ([1][nonce][ciphertext][tag], vault key used directly) still opens
  const nonce = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", a.encKey, nonce);
  c.setAAD(Buffer.from("pack"));
  const old = Buffer.concat([Uint8Array.of(1), nonce, c.update(secret), c.final(), c.getAuthTag()]);
  assert.deepEqual(open(a.encKey, old, "pack"), secret);
  assert.equal(objectKey(a.encKey, old, "pack"), null, "such an object has no key of its own");
});

test("share addresses: a message reaches one login, which can tell who sent it", () => {
  const alice = shareKeys(vaultFromKeypair(Keypair.generate(), "devnet")), carol = shareKeys(vaultFromKeypair(Keypair.generate(), "devnet"));
  const wallet = Keypair.generate(), bobVault = vaultFromKeypair(wallet, "devnet"), bob = shareKeys(bobVault);
  assert.deepEqual(shareKeys(vaultFromKeypair(wallet, "devnet")).publicKey, bob.publicKey, "the same wallet has the same share address everywhere");
  assert.notDeepEqual(shareKeys(vaultFromKeypair(wallet, "mainnet-beta")).publicKey, bob.publicKey);
  const address = shareAddress(bob.publicKey);
  assert.match(address, /^share_[1-9A-HJ-NP-Za-km-z]+$/);
  assert.deepEqual(parseShareAddress(address), bob.publicKey);
  assert.throws(() => parseShareAddress(wallet.address), /wallet address cannot receive shares/);
  assert.throws(() => parseShareAddress(address.slice(0, -1) + (address.endsWith("2") ? "3" : "2")), /checksum|length/);
  assert.throws(() => parseShareAddress("share_0OIl"), /characters/);

  const text = Buffer.from("the keys to the kingdom");
  const sealed = sealTo(bob.publicKey, alice, text, "share");
  const got = openFrom(bob, sealed, "share")!;
  assert.deepEqual(got.plain, text);
  assert.deepEqual(got.sender, alice.publicKey, "the receiver learns the sender's share address");
  assert.equal(openFrom(carol, sealed, "share"), null, "nobody else can read it");
  assert.equal(openFrom(bob, sealed, "share-record"), null, "the purpose is part of the seal");
  assert.ok(!sealed.includes(text));
  // a message that names somebody else as its sender does not open: the sender is proven, not claimed
  const forged = Buffer.from(sealTo(bob.publicKey, carol, text, "share"));
  alice.publicKey.copy(forged, 33);
  assert.equal(openFrom(bob, forged, "share"), null);
  const bad = Buffer.from(sealed); bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
  assert.equal(openFrom(bob, bad, "share"), null);
});

test("images: tar -> image -> disk -> tar keeps every file, link and attribute", { skip: !posix && "needs a POSIX file system" }, () => {
  const entries: Entry[] = [
    d("etc"), f("etc/hostname", "box\n"), f("etc/empty", ""), d("usr"), d("usr/bin"),
    f("usr/bin/tool", crypto.randomBytes(70_000), 0o755), { path: "usr/bin/alias", type: "h", mode: 0o755, uid, gid, mtime: T, link: "usr/bin/tool" },
    { path: "bin", type: "l", mode: 0o777, uid, gid, mtime: T, link: "usr/bin" },
    f("usr/share/doc/" + "x".repeat(120) + "/readme with spaces ünïcode.txt", "long path\n"), f("etc/copy-of-hostname", "box\n"),
  ];
  const built = buildImage(readTar(Buffer.concat(writeTar(entries))), { name: "demo", version: "1", arch: "amd64" });
  const m = parseManifest(serializeManifest(built.manifest));
  assert.equal(m.fileCount, 13, "missing parent directories were added");
  assert.equal(built.newPacks.size, 1);
  const raw = decompress(m.packs[0]!.codec, built.newPacks.get(0)!, m.packs[0]!.rawSize);
  assert.equal(raw.length, 70_000 + 4 + 10, "identical contents are stored once");
  const dest = path.join(tmp(), "root");
  extractImage(m, () => raw, dest);
  assert.equal(fs.readFileSync(path.join(dest, "bin/tool")).length, 70_000);
  assert.equal(fs.statSync(path.join(dest, "usr/bin/alias")).ino, fs.statSync(path.join(dest, "usr/bin/tool")).ino, "hard link restored");
  assert.equal(fs.statSync(path.join(dest, "usr/bin/tool")).mode & 0o777, 0o755);
  assert.equal(Math.floor(fs.statSync(path.join(dest, "etc")).mtimeMs / 1000), T, "directory times survive");
  // the same content gives the same digest, however it is packed
  const again = buildImage(readTar(Buffer.concat(writeTar([...entries].reverse()))), { name: "other", version: "2", arch: "arm64" }, { codec: "zstd" });
  assert.equal(again.manifest.digest, built.manifest.digest);
  // manifests that could write outside the target are refused
  for (const evil of ["../x", "/abs", "a/../../x", "etc/hostname/child"]) {
    const bad = JSON.parse(serializeManifest(built.manifest).toString()); bad.tree.push([evil, "d", 0o755, 0, 0, 0]);
    assert.throws(() => parseManifest(Buffer.from(JSON.stringify(bad))), /invalid image manifest/);
  }
});

test("save and restore: changes, deletions and history survive the round trip through the chain", { skip: !posix && "needs a POSIX file system" }, async () => {
  const chain = new FakeChain();
  const store = new ChainStore(new RpcPool(chain.urls(3), { fetch: chain.fetch, initialRate: 500 }));
  const vault = vaultFromKeypair(Keypair.generate(), "devnet");
  // an "image" and a machine directory that mimics the overlay layout: lower + upper, merged = both
  const base = buildImage([d("etc"), f("etc/os-release", "NAME=demo\n"), f("etc/motd", "welcome\n"), d("usr"), f("usr/lib.so", crypto.randomBytes(20_000)), d("var"), d("var/cache"), d("var/cache/apt"), d("root")],
    { name: "demo", version: "1", arch: "amd64" }).manifest;
  base.packs[0]!.sig = "pack-on-chain";
  const info: MachineInfo = { name: "box", created: T, image: { publisher: "P", name: "demo", tag: "1", arch: "amd64", digest: base.digest, manifest: { sig: "s", sha256: "0".repeat(64), size: 1, codec: "raw", rawSize: 1 } } };
  const dir = tmp(), upper = path.join(dir, "upper"), merged = path.join(dir, "merged");
  const put = (p: string, data: string | Buffer, mode = 0o644) => {
    for (const root of [upper, merged]) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), data, { mode }); fs.utimesSync(path.join(root, p), T + 5, T + 5); }
  };
  fs.mkdirSync(merged, { recursive: true });
  // merged starts as the image minus one deleted file ("etc/motd" is simply absent, as after `rm`)
  for (const n of base.tree) {
    if (n[1] === "d") fs.mkdirSync(path.join(merged, n[0]), { recursive: true });
    else if (n[1] === "f" && n[0] !== "etc/motd") fs.writeFileSync(path.join(merged, n[0]), "placeholder");
  }
  put("etc/os-release", "NAME=changed\n");
  put("root/notes.txt", "my notes\n");
  put("root/bin/tool", crypto.randomBytes(300_000), 0o755);
  put("usr/copy.so", "placeholder");                      // will be made identical to image content below
  fs.symlinkSync("notes.txt", path.join(upper, "root/link")); fs.symlinkSync("notes.txt", path.join(merged, "root/link"));
  put("var/cache/apt/pkgcache.bin", crypto.randomBytes(50_000)); // a cache: must not be saved
  put("tmp/junk", "x");
  // an extended attribute on a changed file (skipped where the file system or the tools do not allow it)
  const attr = { "user.chainboot.test": Buffer.from("kept across the chain").toString("base64") };
  const canAttr = canReadXattrs() && writeXattrs(path.join(upper, "root/notes.txt"), attr).length === 0 && writeXattrs(path.join(merged, "root/notes.txt"), attr).length === 0;
  assert.ok(isUnsaved("var/cache/apt/pkgcache.bin") && isUnsaved("tmp/junk") && isUnsaved("etc/resolv.conf") && !isUnsaved("etc/os-release"));

  const scan1 = scanMachine({ upper, merged, base, cacheFile: path.join(dir, "cache.json") });
  assert.deepEqual(scan1.deleted, ["etc/motd"]);
  assert.ok(!scan1.changes.some((c) => c.path.startsWith("var/cache/apt/") || c.path.startsWith("tmp/")), "caches and temporary files are left out");
  assert.ok(scan1.changes.some((c) => c.path === "root/bin/tool" && c.size === 300_000));
  if (canAttr) assert.deepEqual(scan1.changes.find((c) => c.path === "root/notes.txt")!.xattrs, attr, "the scan found the extended attribute");
  assert.equal(scanMachine({ upper, merged, base, cacheFile: path.join(dir, "cache.json") }).fingerprint, scan1.fingerprint, "scanning twice gives the same fingerprint");

  let asked = 0;
  const first = await saveSnapshot(store, vault, info, base, scan1, null, { approve: (plan) => { asked++; assert.ok(plan.newBytes >= 300_000 && plan.transactions > 70); return true; } });
  assert.equal(asked, 1);
  assert.equal(first!.head.seq, 1);
  assert.deepEqual(Object.keys((await readIndex(store, vault)).machines), ["box"]);
  // nothing readable on chain: no transaction contains the plain text
  for (const t of chain.txs.values()) assert.ok(!Buffer.from(t.raw, "base64").includes(Buffer.from("my notes")));

  // second save: one more file, one changed; only the new content is uploaded
  put("root/notes.txt", "my notes, edited\n");
  put("root/second.bin", crypto.randomBytes(40_000));
  const scan2 = scanMachine({ upper, merged, base, cacheFile: path.join(dir, "cache.json") });
  assert.notEqual(scan2.fingerprint, scan1.fingerprint);
  const head1 = (await readHead(store, vault, "box"))!;
  const txBefore = chain.txs.size;
  const second = await saveSnapshot(store, vault, info, base, scan2, { head: head1, snapshot: await readSnapshot(store, vault, head1.ref) });
  assert.equal(second!.head.seq, 2);
  assert.ok(second!.plan.newBytes < 45_000 && second!.plan.reusedFiles >= 2, "the 300 kB file was not uploaded again");
  assert.ok(chain.txs.size - txBefore < 25);
  assert.equal(await saveSnapshot(store, vault, info, base, scan2, null, { approve: () => false }), null, "declining sends nothing");

  // restore on "another computer": a fresh copy of the image, then apply
  const restore = async (seq: number) => {
    const head = (await readHead(store, vault, "box"))!;
    let snap = await readSnapshot(store, vault, head.ref);
    if (seq !== head.seq) snap = await readSnapshot(store, vault, snap.history.find((h) => h.seq === seq)!.ref);
    const target = path.join(tmp(), "merged");
    fs.mkdirSync(target, { recursive: true });
    for (const n of base.tree) { if (n[1] === "d") fs.mkdirSync(path.join(target, n[0]), { recursive: true }); else if (n[1] === "f") fs.writeFileSync(path.join(target, n[0]), "placeholder"); }
    const pack = await loadPacks(store, vault, snap, tmp());
    applySnapshot(snap, target, (n) => pack(n[8]).subarray(n[9], n[9] + n[6]));
    return target;
  };
  const want = (root: string) => listing(root).filter((l) => !/^(tmp|var\/cache\/apt)\//.test(l) && !l.startsWith("usr/lib.so ") && !/^(tmp|var\/cache\/apt|etc|root|root\/bin|usr|var|var\/cache) d /.test(l));
  const now = await restore(2);
  assert.deepEqual(want(now), want(merged));
  assert.ok(!fs.existsSync(path.join(now, "etc/motd")), "the deletion was applied");
  assert.equal(fs.readFileSync(path.join(now, "root/notes.txt"), "utf8"), "my notes, edited\n");
  const before = await restore(1);
  assert.equal(fs.readFileSync(path.join(before, "root/notes.txt"), "utf8"), "my notes\n", "an earlier save can be brought back");
  if (canAttr) assert.deepEqual(readXattrs(before)!.get("root/notes.txt"), attr, "extended attributes are restored");
  assert.ok(!fs.existsSync(path.join(before, "root/second.bin")));

  // another wallet finds nothing and can read nothing
  const stranger = vaultFromKeypair(Keypair.generate(), "devnet");
  assert.equal(await readHead(store, stranger, "box"), null);
  await assert.rejects(readSnapshot(store, stranger, second!.head.ref), /not published by a trusted key|could not decrypt/);
});

test("private images: only the wallet that published them can list, fetch or read them", { skip: !posix && "needs a POSIX file system" }, async () => {
  const { publishImage, pullImage, readCatalog } = await import("../src/registry/registry.ts");
  const { publishPrivateImage, readPrivateCatalog, unlistPrivateImage } = await import("../src/registry/private.ts");
  const chain = new FakeChain();
  const store = new ChainStore(new RpcPool(chain.urls(3), { fetch: chain.fetch, initialRate: 500 }));
  const publisher = Keypair.generate();
  const owner = vaultFromKeypair(Keypair.generate(), "devnet"), stranger = vaultFromKeypair(Keypair.generate(), "devnet");
  const cache = tmp();

  // a public base image, and a private image built on it that adds secret files
  const baseFiles = [d("etc"), f("etc/os-release", "NAME=base\n"), d("usr"), f("usr/lib.so", crypto.randomBytes(30_000))];
  const base = buildImage(baseFiles, { name: "base", version: "1", arch: "amd64" });
  await publishImage(store, publisher, base, { commitment: "confirmed" });
  const secret = crypto.randomBytes(40_000);
  const built = buildImage([...baseFiles, d("srv"), f("srv/customer-list-TOPSECRET.db", secret), f("srv/notes.txt", "the launch code is 4242\n")],
    { name: "vaultbox", version: "1", arch: "amd64", description: "my private system" }, { reuse: [base.manifest] });
  assert.equal(built.newPacks.size, 1, "only content that is not public already is uploaded");
  const before = new Set(chain.txs.keys());
  const ref = await publishPrivateImage(store, owner, built, { commitment: "confirmed" });
  assert.equal(ref.private, true);

  // nothing the private publish wrote reveals names or contents
  const written = [...chain.txs.entries()].filter(([sig]) => !before.has(sig)).map(([, t]) => Buffer.from(t.raw, "base64"));
  assert.ok(written.length > 10);
  for (const raw of written) {
    for (const needle of ["TOPSECRET", "vaultbox", "launch code", "customer-list", "my private system"]) assert.ok(!raw.includes(Buffer.from(needle)), `"${needle}" is visible on chain`);
    assert.ok(!raw.includes(secret.subarray(0, 64)), "file content is visible on chain");
  }
  assert.deepEqual(Object.keys((await readCatalog(store, owner.signer.address)).images), [], "it is not in any public catalog");

  // the owner finds it, fetches it and gets the exact files back; public content comes from the public pack
  const mine = await readPrivateCatalog(store, owner);
  assert.deepEqual(Object.keys(mine.images), ["vaultbox"]);
  const entry = mine.images.vaultbox!.tags.latest!.amd64!;
  const pulled = await pullImage(store, owner.signer.address, entry, { cacheDir: cache, vault: owner });
  assert.equal(pulled.manifest.digest, built.manifest.digest);
  assert.deepEqual(pulled.manifest.packs.map((p) => p.enc ?? 0).sort(), [0, 1]);
  const dest = path.join(tmp(), "root");
  extractImage(pulled.manifest, (i) => pulled.pack(i), dest);
  assert.ok(fs.readFileSync(path.join(dest, "srv/customer-list-TOPSECRET.db")).equals(secret));
  assert.equal(fs.readFileSync(path.join(dest, "etc/os-release"), "utf8"), "NAME=base\n");
  // what is kept in the local cache is still encrypted
  for (const file of fs.readdirSync(path.join(cache, "objects"))) assert.ok(!fs.readFileSync(path.join(cache, "objects", file)).includes(Buffer.from("TOPSECRET")));

  // everyone else: not listed, and the entry is useless without the wallet
  assert.deepEqual(Object.keys((await readPrivateCatalog(store, stranger)).images), []);
  await assert.rejects(pullImage(store, owner.signer.address, entry, { cacheDir: tmp() }), /private image/);
  await assert.rejects(pullImage(store, owner.signer.address, entry, { cacheDir: tmp(), vault: stranger }), /could not decrypt/);
  const blind = await pullImage(store, owner.signer.address, entry, { cacheDir: tmp(), vault: owner });
  const forged = { ...blind, pack: blind.pack };
  assert.ok(forged.manifest.packs.some((p) => p.enc === 1));
  // a stranger cannot plant an image in the owner's private catalog
  const fake = buildImage([d("etc"), f("etc/evil", "x")], { name: "vaultbox", version: "9", arch: "amd64" });
  await publishPrivateImage(store, stranger, fake, { commitment: "confirmed" });
  assert.equal((await readPrivateCatalog(store, owner)).images.vaultbox!.tags.latest!.amd64!.version, "1");

  assert.equal(await unlistPrivateImage(store, owner, "vaultbox"), true);
  assert.deepEqual(Object.keys((await readPrivateCatalog(store, owner)).images), []);
});

test("sharing: a private image and a saved machine reach the wallet they were shared with, and nobody else", { skip: !posix && "needs a POSIX file system" }, async () => {
  const { publishImage, pullImage } = await import("../src/registry/registry.ts");
  const { publishPrivateImage, readPrivateCatalog } = await import("../src/registry/private.ts");
  const chain = new FakeChain();
  const store = new ChainStore(new RpcPool(chain.urls(3), { fetch: chain.fetch, initialRate: 500 }));
  const alice = vaultFromKeypair(Keypair.generate(), "devnet"), bob = vaultFromKeypair(Keypair.generate(), "devnet"), carol = vaultFromKeypair(Keypair.generate(), "devnet");

  // alice: a public base, a private image on top of it, and a machine made from that private image
  const baseFiles = [d("etc"), f("etc/os-release", "NAME=base\n"), d("usr"), f("usr/lib.so", crypto.randomBytes(30_000)), d("root")];
  const base = buildImage(baseFiles, { name: "base", version: "1", arch: "amd64" });
  await publishImage(store, Keypair.generate(), base, { commitment: "confirmed" });
  const secret = crypto.randomBytes(40_000);
  const built = buildImage([...baseFiles, d("srv"), f("srv/customers-TOPSECRET.db", secret)], { name: "vaultbox", version: "1", arch: "amd64", description: "my private system" }, { reuse: [base.manifest] });
  const ref = await publishPrivateImage(store, alice, built, { commitment: "confirmed" });
  assert.ok(built.manifest.packs.filter((p) => p.enc).every((p) => typeof p.key === "string"), "the manifest lists the key of each encrypted pack");
  await assert.rejects(publishImage(store, Keypair.generate(), buildImage([...baseFiles, d("srv"), f("srv/customers-TOPSECRET.db", secret), f("srv/x", "y")], { name: "leak", version: "1", arch: "amd64" }, { reuse: [built.manifest] })),
    /cannot reuse files of a private image/, "pack keys never end up in a public manifest");

  // ---- the image
  const before = new Set(chain.txs.keys());
  await assert.rejects(shareImage(store, alice, "vaultbox", "latest", "amd64", alice.wallet), /not a share address/);
  await assert.rejects(shareImage(store, alice, "vaultbox", "latest", "amd64", myShareAddress(alice)), /your own share address/);
  await assert.rejects(shareImage(store, alice, "nothing", "latest", "amd64", myShareAddress(bob)), /no private image/);
  await shareImage(store, alice, "vaultbox", "latest", "amd64", myShareAddress(bob), { note: "for the audit" });
  const sent = [...chain.txs.entries()].filter(([sig]) => !before.has(sig)).map(([, t]) => Buffer.from(t.raw, "base64"));
  assert.equal(sent.length, 1, "sharing an image is one transaction");
  for (const needle of ["vaultbox", "audit", "TOPSECRET", alice.wallet, ref.sig]) assert.ok(!sent[0]!.includes(Buffer.from(needle)), `"${needle}" is visible in the share`);

  assert.deepEqual(await listShares(store, carol), [], "nobody else sees it");
  const inbox = await listShares(store, bob);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.from, myShareAddress(alice), "the receiver sees which share address it came from");
  assert.equal(inbox[0]!.record.what, "image");
  assert.equal(inbox[0]!.record.note, "for the audit");
  // junk in the inbox (anybody may write there) is ignored
  await store.putPointer(carol.signer, (await import("../src/store/store.ts")).tagAddress("inbox", shareKeys(bob).publicKey), crypto.randomBytes(200), { commitment: "confirmed" });
  assert.equal((await listShares(store, bob)).length, 1);

  await acceptImage(store, bob, inbox[0]!.record, "audit-box");
  const entry = (await readPrivateCatalog(store, bob)).images["audit-box"]!.tags.latest!.amd64!;
  assert.equal(entry.publisher, alice.signer.address);
  const pulled = await pullImage(store, bob.signer.address, entry, { cacheDir: tmp(), vault: bob });
  assert.equal(pulled.manifest.digest, built.manifest.digest);
  const dest = path.join(tmp(), "root");
  extractImage(pulled.manifest, (i) => pulled.pack(i), dest);
  assert.ok(fs.readFileSync(path.join(dest, "srv/customers-TOPSECRET.db")).equals(secret), "the receiver gets the exact files");
  // the keys bob received open this image only: alice's catalog and vault key stay hers
  await assert.rejects(readPrivateCatalog(store, { ...bob, signer: alice.signer }), /could not decrypt/);
  await assert.rejects(acceptImage(store, bob, { ...inbox[0]!.record, image: { ...inbox[0]!.record.image!, ref: { ...entry, digest: "f".repeat(64) } } }, "audit-box"), /already have a different private image/);

  // ---- the machine (made from the private image)
  const info: MachineInfo = { name: "work", created: T, boot: true, image: { publisher: alice.signer.address, name: "vaultbox", tag: "1", arch: "amd64", digest: built.manifest.digest, private: true, manifest: { sig: ref.sig, sha256: ref.sha256, size: ref.size, codec: ref.codec, rawSize: ref.rawSize } } };
  const dir = tmp(), upper = path.join(dir, "upper"), merged = path.join(dir, "merged");
  const layout = (root: string) => { for (const n of built.manifest.tree) { if (n[1] === "d") fs.mkdirSync(path.join(root, n[0]), { recursive: true }); else if (n[1] === "f") fs.writeFileSync(path.join(root, n[0]), "placeholder"); } };
  layout(merged);
  const put = (p: string, data: string | Buffer) => { for (const root of [upper, merged]) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), data); fs.utimesSync(path.join(root, p), T + 5, T + 5); } };
  const work = crypto.randomBytes(60_000);
  put("root/work.bin", work);
  put("root/notes.txt", "alice's notes\n");
  await assert.rejects(shareMachine(store, alice, "work", myShareAddress(bob)), /no save on chain yet/);
  await saveSnapshot(store, alice, info, built.manifest, scanMachine({ upper, merged, base: built.manifest, cacheFile: path.join(dir, "cache.json") }), null);
  const shared = await shareMachine(store, alice, "work", myShareAddress(bob));
  assert.equal(shared.seq, 1);

  const second = (await listShares(store, bob)).find((r) => r.record.what === "machine")!;
  assert.equal(second.from, myShareAddress(alice));
  assert.equal(second.record.machine!.image.manifest.key, entry.key, "the machine's private image comes with it");
  assert.equal((await listShares(store, carol)).length, 0);
  await acceptMachine(store, bob, second.record, "from-alice");
  await assert.rejects(acceptMachine(store, bob, second.record, "from-alice"), /already have a saved machine/);
  assert.deepEqual((await readIndex(store, bob)).machines["from-alice"]!.boot, true, "how the machine starts travels with it");

  // bob restores it like any machine of his own, on a computer that has seen nothing yet
  const restore = async () => {
    const head = (await readHead(store, bob, "from-alice"))!;
    const snap = await readSnapshot(store, bob, head.ref);
    const target = path.join(tmp(), "merged");
    layout(target);
    const pack = await loadPacks(store, bob, snap, tmp());
    applySnapshot(snap, target, (n) => pack(n[8]).subarray(n[9], n[9] + n[6]));
    return { head, snap, target };
  };
  const first = await restore();
  assert.equal(first.snap.machine, "from-alice");
  assert.ok(fs.readFileSync(path.join(first.target, "root/work.bin")).equals(work));
  assert.equal(fs.readFileSync(path.join(first.target, "root/notes.txt"), "utf8"), "alice's notes\n");

  // and it is his from here on: his next save keeps using the content alice stored, without uploading it again
  const dir2 = tmp(), upper2 = path.join(dir2, "upper"), merged2 = path.join(dir2, "merged");
  layout(merged2);
  for (const [p, data] of [["root/work.bin", work], ["root/notes.txt", Buffer.from("bob's notes now\n")], ["root/bob.bin", crypto.randomBytes(20_000)]] as const) {
    for (const root of [upper2, merged2]) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), data); fs.utimesSync(path.join(root, p), T + 9, T + 9); }
  }
  const bobInfo: MachineInfo = { ...info, name: "from-alice", image: first.snap.image };
  const again = await saveSnapshot(store, bob, bobInfo, built.manifest, scanMachine({ upper: upper2, merged: merged2, base: built.manifest, cacheFile: path.join(dir2, "cache.json") }), { head: first.head, snapshot: first.snap });
  assert.equal(again!.head.seq, 2);
  assert.ok(again!.plan.newBytes < 25_000 && again!.plan.reusedFiles >= 1, "the 60 kB file alice stored is referenced, not uploaded again");
  const later = await restore();
  assert.ok(fs.readFileSync(path.join(later.target, "root/work.bin")).equals(work));
  assert.equal(fs.readFileSync(path.join(later.target, "root/notes.txt"), "utf8"), "bob's notes now\n");

  // alice's own machine is untouched, and her later saves do not reach bob
  assert.equal((await readHead(store, alice, "work"))!.seq, 1);
  assert.equal(await readHead(store, alice, "from-alice"), null);
});
