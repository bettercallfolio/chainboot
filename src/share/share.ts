// Sharing: giving another wallet a private image or a saved machine.
//
// Nothing is uploaded again. Every encrypted object on chain has a key of its own; sharing
// hands the receiver the keys of exactly the objects that make up the image or the save:
//
//   a private image   the key of its manifest (the manifest holds the keys of its packs)
//   a saved machine   the key of one snapshot (which holds the keys of its packs), and, if the
//                     machine was made from a private image, that image's manifest key
//
// The keys travel in a small record, encrypted to the receiver's share address and written
// under the receiver's inbox tag. Anybody can write there; only the receiver can read it, and
// the receiver sees which share address it came from.
//
// A share is a copy at one moment, and it cannot be taken back: the ledger keeps the data and
// the receiver keeps the keys.
import type { MachineInfo } from "../engine/linux.ts";
import { compress, decompress } from "../codec/index.ts";
import { parseManifest } from "../image/manifest.ts";
import { privateLock, readPrivateCatalog, writePrivateCatalog } from "../registry/private.ts";
import { cleanRef, plainText, type ImageRef } from "../registry/registry.ts";
import { addressToBytes } from "../solana/keys.ts";
import { checkImageRef, checkSnapshot, putDoc, readHead, readIndex, stateTagOf, writeIndex, type Snapshot, type StoredRef } from "../state/snapshot.ts";
import { sha256, toHex } from "../util/bytes.ts";
import { withLock } from "../util/lock.ts";
import { objectKey, open, openEither, openFrom, openWithKey, parseShareAddress, sealTo, shareAddress, shareKeys, type Vault } from "../state/vault.ts";
import { ChainStore, tagAddress } from "../store/store.ts";
import type { Commitment } from "../store/sender.ts";

export interface ShareRecord {
  chainboot: 1;
  kind: "share";
  what: "image" | "machine";
  /** The name the sender knows it by. The receiver may keep it under another one. */
  name: string;
  time: number;
  note?: string;
  /** The sender's wallet address, as the sender states it. (What is proven is the share address a record came from.) */
  wallet: string;
  image?: { description?: string; tag: string; arch: string; ref: ImageRef };
  machine?: {
    image: MachineInfo["image"];
    created: number;
    boot?: boolean;
    seq: number;
    saved: number;
    /** The snapshot, the account that stored it, and its key. */
    snapshot: StoredRef; signer: string; key: string;
    /** Keys of packs that the snapshot itself does not list (packs saved by early versions). */
    keys?: Record<string, string>;
  };
}

export interface Received {
  /** Signature of the transaction that delivered it: a share's identity. */
  id: string;
  /** When it arrived (seconds), when the network says. */
  arrived: number | null;
  /** Share address of the sender, proven by the encryption. */
  from: string;
  record: ShareRecord;
}

const inboxTag = (sharePublicKey: Uint8Array) => tagAddress("inbox", sharePublicKey);
const cannot = (what: string) => new Error(`${what} holds data that an early version of chainboot stored before objects had keys of their own, so it cannot be shared. ${what.startsWith("image") ? "Publish it again and share that." : "Make a new machine from the same image, copy your work into it, save it and share that one."}`);

export interface SendOptions { note?: string; journalDir?: string; commitment?: Commitment; cacheDir?: string }

async function send(store: ChainStore, v: Vault, to: Uint8Array, record: ShareRecord, opts: SendOptions): Promise<string> {
  const mine = shareKeys(v);
  if (mine.publicKey.equals(Buffer.from(to))) throw new Error("that is your own share address");
  const raw = Buffer.from(JSON.stringify(record), "utf8");
  const packed = compress(raw);
  let sealed = sealTo(to, mine, Buffer.from(JSON.stringify({ r: packed.data.toString("base64"), c: packed.codec, n: raw.length }), "utf8"), "share");
  if (sealed.length > store.pointerCapacity()) {
    // too long for one transaction (how long that is depends on the chain): the record becomes an object of its own, the inbox gets its address
    const o = await store.put(v.signer, sealTo(to, mine, packed.data, "share-record"), { journalDir: opts.journalDir, commitment: opts.commitment });
    sealed = sealTo(to, mine, Buffer.from(JSON.stringify({ o: { sig: o.sig, sha256: o.sha256, size: o.size }, by: v.signer.address, c: packed.codec, n: raw.length }), "utf8"), "share");
  }
  return store.putPointer(v.signer, inboxTag(to), sealed, { commitment: opts.commitment });
}

/** The key of one of the vault's own stored objects. */
async function keyOfObject(store: ChainStore, v: Vault, ref: { sig: string; sha256: string; size: number }, purpose: string, cacheDir?: string): Promise<string | null> {
  const sealed = await store.get(ref, { signers: [v.signer.publicKey], cacheDir });
  return objectKey(v.encKey, sealed, purpose)?.toString("base64") ?? null;
}

/**
 * Shares one of the vault's private images (one tag, one architecture) with a share address.
 * Returns the signature of the transaction that delivered it.
 */
export async function shareImage(store: ChainStore, v: Vault, name: string, tag: string, arch: string, to: string, opts: SendOptions = {}): Promise<string> {
  const receiver = parseShareAddress(to);
  const cat = await readPrivateCatalog(store, v);
  const image = cat.images[name];
  const ref = image?.tags[tag]?.[arch];
  if (!image || !ref) throw new Error(`you have no private image "${name}:${tag}" for ${arch}`);
  const publisher = ref.publisher ?? v.signer.address;
  // an image that was shared with us is passed on with the key we were given
  const sealed = await store.get({ sig: ref.sig, sha256: ref.sha256, size: ref.size }, { signers: [addressToBytes(publisher)], cacheDir: opts.cacheDir });
  const key = ref.key ?? objectKey(v.encKey, sealed, "image-manifest")?.toString("base64");
  if (!key) throw cannot(`image "${name}"`);
  const manifest = parseManifest(decompress(ref.codec, openEither(v.encKey, ref.key, sealed, "image-manifest"), ref.rawSize));
  if (manifest.packs.some((p) => p.enc && !p.key)) throw cannot(`image "${name}"`);
  const record: ShareRecord = {
    chainboot: 1, kind: "share", what: "image", name, time: Math.floor(Date.now() / 1000), wallet: v.wallet, ...(opts.note && { note: opts.note }),
    image: { ...(image.description && { description: image.description }), tag, arch, ref: { ...ref, private: true, publisher, key } },
  };
  return send(store, v, receiver, record, opts);
}

/** Shares the newest save of one of the vault's machines with a share address. */
export async function shareMachine(store: ChainStore, v: Vault, name: string, to: string, opts: SendOptions = {}): Promise<{ id: string; seq: number; saved: number }> {
  const receiver = parseShareAddress(to);
  const head = await readHead(store, v, name);
  if (!head) throw new Error(`"${name}" has no save on chain yet. Save it first: chainboot save ${name}`);
  const sealed = await store.get({ sig: head.ref.sig, sha256: head.ref.sha256, size: head.ref.size }, { signers: [v.signer.publicKey], cacheDir: opts.cacheDir });
  const key = objectKey(v.encKey, sealed, "snapshot")?.toString("base64");
  if (!key) throw cannot(`machine "${name}"`);
  const snap = JSON.parse(decompress(head.ref.codec, open(v.encKey, sealed, "snapshot"), head.ref.rawSize).toString("utf8")) as Snapshot;
  // packs that an early version saved do not have their key in the snapshot: look each one up
  const keys: Record<string, string> = {};
  for (const p of snap.packs) {
    if (!p.enc || p.key) continue;
    const k = await keyOfObject(store, v, p, "pack", opts.cacheDir);
    if (!k) throw cannot(`machine "${name}"`);
    keys[p.sha256] = k;
  }
  // a machine made from a private image needs that image too
  const image: MachineInfo["image"] = { ...snap.image, manifest: { ...snap.image.manifest } };
  if (image.private && !image.manifest.key) {
    const k = await keyOfObject(store, v, image.manifest, "image-manifest", opts.cacheDir);
    if (!k) throw cannot(`the image of machine "${name}"`);
    const manifestSealed = await store.get({ sig: image.manifest.sig, sha256: image.manifest.sha256, size: image.manifest.size }, { signers: [v.signer.publicKey], cacheDir: opts.cacheDir });
    const manifest = parseManifest(decompress(image.manifest.codec, open(v.encKey, manifestSealed, "image-manifest"), image.manifest.rawSize));
    if (manifest.packs.some((p) => p.enc && !p.key)) throw cannot(`the image of machine "${name}"`);
    image.manifest.key = k;
  }
  const index = await readIndex(store, v);
  const entry = index.machines[name];
  const record: ShareRecord = {
    chainboot: 1, kind: "share", what: "machine", name, time: Math.floor(Date.now() / 1000), wallet: v.wallet, ...(opts.note && { note: opts.note }),
    machine: {
      image, created: entry?.created ?? snap.time, ...(entry?.boot && { boot: true }), seq: head.seq, saved: head.time,
      snapshot: head.ref, signer: v.signer.address, key, ...(Object.keys(keys).length && { keys }),
    },
  };
  return { id: await send(store, v, receiver, record, opts), seq: head.seq, saved: head.time };
}

const IMAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/, LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, KEY = /^[A-Za-z0-9+/]{43}=$/;
const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isAddress = (x: unknown): x is string => { try { addressToBytes(x as string); return typeof x === "string"; } catch { return false; } };

/**
 * A received record with exactly the fields chainboot knows, each checked, or null when it is
 * not well formed. What comes out is what gets shown and what gets written into the receiver's
 * own catalog or list of machines; nothing else of what the sender wrote goes there.
 */
export function cleanShareRecord(r: ShareRecord | null): ShareRecord | null {
  if (!r || typeof r !== "object" || r.chainboot !== 1 || r.kind !== "share" || !IMAGE_NAME.test(String(r.name)) || !isAddress(r.wallet) || !isCount(r.time)) return null;
  const base = { chainboot: 1 as const, kind: "share" as const, name: r.name, time: r.time, wallet: r.wallet, ...(r.note !== undefined && { note: plainText(r.note, 200) }) };
  if (r.what === "image") {
    const i = r.image, ref = cleanRef(i?.ref);
    if (!i || !ref || !ref.key || !ref.publisher || !LABEL.test(String(i.tag)) || !LABEL.test(String(i.arch))) return null;
    return { ...base, what: "image", image: { ...(i.description !== undefined && { description: plainText(i.description, 300) }), tag: i.tag, arch: i.arch, ref: { ...ref, private: true } } };
  }
  if (r.what === "machine") {
    const m = r.machine, snap = m?.snapshot;
    if (!m || !snap || typeof snap.sig !== "string" || snap.sig.length > 90 || !/^[0-9a-f]{64}$/.test(String(snap.sha256)) || !isCount(snap.size) || !isCount(snap.rawSize) || !["xz", "zstd", "raw"].includes(snap.codec)) return null;
    if (!KEY.test(String(m.key)) || !isAddress(m.signer) || !isCount(m.created) || !isCount(m.seq) || !isCount(m.saved)) return null;
    try { checkImageRef(m.image); } catch { return null; }
    const keys: Record<string, string> = {};
    for (const [hash, key] of Object.entries(m.keys ?? {})) { if (!/^[0-9a-f]{64}$/.test(hash) || !KEY.test(String(key))) return null; keys[hash] = key; }
    const im = m.image;
    return {
      ...base, what: "machine",
      machine: {
        image: { publisher: im.publisher, name: im.name, tag: im.tag, arch: im.arch, digest: im.digest, ...(im.private && { private: true }), manifest: { sig: im.manifest.sig, sha256: im.manifest.sha256, size: im.manifest.size, codec: im.manifest.codec, rawSize: im.manifest.rawSize, ...(im.manifest.key && { key: im.manifest.key }) } },
        created: m.created, ...(m.boot === true && { boot: true }), seq: m.seq, saved: m.saved,
        snapshot: { sig: snap.sig, sha256: snap.sha256, size: snap.size, codec: snap.codec, rawSize: snap.rawSize }, signer: m.signer, key: m.key, ...(Object.keys(keys).length && { keys }),
      },
    };
  }
  return null;
}

/**
 * What was shared with this login, newest first. Records that are not readable or not well
 * formed are left out, and so is a second copy of a record (anybody can post somebody's
 * message again; the first one that arrived is the one that counts).
 */
export async function listShares(store: ChainStore, v: Vault, opts: { limit?: number; cacheDir?: string } = {}): Promise<Received[]> {
  const mine = shareKeys(v);
  const out: Received[] = [];
  const seen = new Map<string, number>();
  for (const p of await store.listPointers(inboxTag(mine.publicKey), { limit: opts.limit ?? 100 })) {
    const got = openFrom(mine, p.payload, "share");
    if (!got) continue;
    try {
      const m = JSON.parse(got.plain.toString("utf8")) as { r?: string; o?: { sig: string; sha256: string; size: number }; by?: string; c: StoredRef["codec"]; n: number };
      if (!Number.isInteger(m.n) || m.n < 0 || m.n > 4 << 20) continue;
      let packed: Buffer;
      if (typeof m.r === "string") packed = Buffer.from(m.r, "base64");
      else if (m.o && m.by) {
        if (!Number.isSafeInteger(m.o.size) || m.o.size < 0 || m.o.size > (8 << 20)) continue;
        const inner = openFrom(mine, await store.get(m.o, { signers: [addressToBytes(m.by)], cacheDir: opts.cacheDir }), "share-record");
        if (!inner || !inner.sender.equals(got.sender)) continue;
        packed = inner.plain;
      } else continue;
      const record = cleanShareRecord(JSON.parse(decompress(m.c, packed, m.n).toString("utf8")) as ShareRecord);
      if (!record) continue;
      // the same record from the same sender, delivered again: keep the one that arrived first (the list runs from new to old)
      const identity = toHex(sha256(Buffer.concat([got.sender, packed])));
      const earlier = seen.get(identity);
      const item: Received = { id: p.signature, arrived: p.blockTime, from: shareAddress(got.sender), record };
      if (earlier !== undefined) out[earlier] = item; else { seen.set(identity, out.length); out.push(item); }
    } catch { /* not a record we understand */ }
  }
  return out;
}

/**
 * Adds a shared image to the vault's private catalog, under `name`. From then on it runs as
 * me/<name>. An image the vault already has under that name is left alone unless `merge` says
 * that adding to it is what the user wants (they named it themselves).
 */
export async function acceptImage(store: ChainStore, v: Vault, shared: ShareRecord, name = shared.name, opts: { merge?: boolean } = {}): Promise<void> {
  const r = cleanShareRecord(shared);
  if (!r || r.what !== "image" || !r.image) throw new Error("this share is not an image");
  if (!IMAGE_NAME.test(name)) throw new Error(`invalid image name "${name}": use lower-case letters, digits, ".", "_" or "-"`);
  const { tag, arch, ref, description } = r.image;
  await withLock(privateLock(v), async () => {
    const cat = await readPrivateCatalog(store, v);
    const existing = cat.images[name]?.tags[tag]?.[arch];
    if (existing && existing.digest === ref.digest) return; // the very same image is there already: nothing to add, and their own entry stays theirs
    if (existing) throw new Error(`you already have a different private image "${name}:${tag}" for ${arch}. Keep the shared one under another name: --name <name>`);
    if (cat.images[name] && !opts.merge) throw new Error(`you already have a private image named "${name}". Keep the shared one under another name (--name <name>), or add it to yours by naming yours: --name ${name}`);
    const image = (cat.images[name] ??= { tags: {} });
    if (description && !image.description) image.description = description;
    (image.tags[tag] ??= {})[arch] = { ...ref, private: true };
    if (tag !== "latest") (image.tags.latest ??= {})[arch] ??= { ...ref, private: true };
    await writePrivateCatalog(store, v, cat);
  });
}

/**
 * Makes a shared save a machine of the vault's own, named `name`: the snapshot is stored again
 * under the vault (a small document; the file contents stay where they are), and the machine
 * is added to the vault's list. `chainboot run <name>` then brings it back on any computer.
 */
export async function acceptMachine(store: ChainStore, v: Vault, shared: ShareRecord, name = shared.name, opts: { cacheDir?: string } = {}): Promise<void> {
  const r = cleanShareRecord(shared);
  if (!r || r.what !== "machine" || !r.machine) throw new Error("this share is not a machine");
  if (!IMAGE_NAME.test(name)) throw new Error(`invalid machine name "${name}": use lower-case letters, digits, ".", "_" or "-"`);
  const m = r.machine;
  const taken = async () => { if ((await readIndex(store, v)).machines[name] || (await readHead(store, v, name))) throw new Error(`you already have a saved machine named "${name}". Keep the shared one under another name: --name <name>`); };
  await taken();
  const sealed = await store.get({ sig: m.snapshot.sig, sha256: m.snapshot.sha256, size: m.snapshot.size }, { signers: [addressToBytes(m.signer)], cacheDir: opts.cacheDir });
  const snap = JSON.parse(decompress(m.snapshot.codec, openWithKey(Buffer.from(m.key, "base64"), sealed, "snapshot"), m.snapshot.rawSize).toString("utf8")) as Snapshot;
  // everything the snapshot says is checked before it becomes one of this vault's own: it will be applied to a machine's files
  try { checkSnapshot(snap); } catch (e) { throw new Error(`the shared save cannot be kept: ${(e as Error).message}`); }
  for (const p of snap.packs) {
    if (p.enc && !p.key) p.key = m.keys?.[p.sha256];
    if (p.enc && !p.key) throw new Error("the share does not carry the key of every pack it needs");
  }
  const time = Math.floor(Date.now() / 1000);
  const mine: Snapshot = { chainboot: 1, kind: "snapshot", machine: name, seq: 1, time, image: m.image, packs: snap.packs, tree: snap.tree, deleted: snap.deleted, fingerprint: snap.fingerprint, history: [] };
  await withLock(`index-${v.signer.address}`, async () => {
    await taken();
    await putDoc(store, v, stateTagOf(v, name), "snapshot", mine, { seq: 1, time });
    const index = await readIndex(store, v);
    index.machines[name] = { image: m.image, created: m.created, ...(m.boot && { boot: true }) };
    await writeIndex(store, v, index);
  });
}

/** This login's share address: what to give to people who should be able to share with it. */
export function myShareAddress(v: Vault): string { return shareAddress(shareKeys(v).publicKey); }
