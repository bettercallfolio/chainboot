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
import { LOGIN_MESSAGE, deriveVault, open, seal, vaultFromKeypair } from "../src/state/vault.ts";
import type { MachineInfo } from "../src/engine/linux.ts";
import { FakeChain } from "./helpers/fakechain.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-state-"));
const uid = process.getuid!(), gid = process.getgid!();
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
  assert.notDeepEqual(seal(a.encKey, secret, "pack"), sealed, "a fresh nonce every time");
  assert.throws(() => open(a.encKey, sealed, "snapshot"), /could not decrypt/);
  assert.throws(() => open(vaultFromKeypair(Keypair.generate(), "devnet").encKey, sealed, "pack"), /could not decrypt/);
  const bad = Buffer.from(sealed); bad[40] = bad[40]! ^ 1;
  assert.throws(() => open(a.encKey, bad, "pack"), /could not decrypt/);
});

test("images: tar -> image -> disk -> tar keeps every file, link and attribute", () => {
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

test("save and restore: changes, deletions and history survive the round trip through the chain", async () => {
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
  assert.ok(isUnsaved("var/cache/apt/pkgcache.bin") && isUnsaved("tmp/junk") && isUnsaved("etc/resolv.conf") && !isUnsaved("etc/os-release"));

  const scan1 = scanMachine({ upper, merged, base, cacheFile: path.join(dir, "cache.json") });
  assert.deepEqual(scan1.deleted, ["etc/motd"]);
  assert.ok(!scan1.changes.some((c) => c.path.startsWith("var/cache/apt/") || c.path.startsWith("tmp/")), "caches and temporary files are left out");
  assert.ok(scan1.changes.some((c) => c.path === "root/bin/tool" && c.size === 300_000));
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
  assert.ok(!fs.existsSync(path.join(before, "root/second.bin")));

  // another wallet finds nothing and can read nothing
  const stranger = vaultFromKeypair(Keypair.generate(), "devnet");
  assert.equal(await readHead(store, stranger, "box"), null);
  await assert.rejects(readSnapshot(store, stranger, second!.head.ref), /not published by a trusted key|could not decrypt/);
});
