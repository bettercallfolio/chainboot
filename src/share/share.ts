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
import { readPrivateCatalog, writePrivateCatalog } from "../registry/private.ts";
import type { ImageRef } from "../registry/registry.ts";
import { addressToBytes } from "../solana/keys.ts";
import { putDoc, readHead, readIndex, stateTagOf, writeIndex, type Snapshot, type StoredRef } from "../state/snapshot.ts";
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
  let message = Buffer.from(JSON.stringify({ r: packed.data.toString("base64"), c: packed.codec, n: raw.length }), "utf8");
  if (message.length > 3000) {
    // too long for one transaction: the record becomes an object of its own, the inbox gets its address
    const o = await store.put(v.signer, sealTo(to, mine, packed.data, "share-record"), { journalDir: opts.journalDir, commitment: opts.commitment });
    message = Buffer.from(JSON.stringify({ o: { sig: o.sig, sha256: o.sha256, size: o.size }, by: v.signer.address, c: packed.codec, n: raw.length }), "utf8");
  }
  return store.putPointer(v.signer, inboxTag(to), sealTo(to, mine, message, "share"), { commitment: opts.commitment });
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

function valid(r: ShareRecord | null): r is ShareRecord {
  if (!r || r.chainboot !== 1 || r.kind !== "share" || typeof r.name !== "string" || typeof r.wallet !== "string") return false;
  if (r.what === "image") return !!r.image && typeof r.image.tag === "string" && typeof r.image.arch === "string" && typeof r.image.ref?.key === "string" && typeof r.image.ref.publisher === "string" && typeof r.image.ref.digest === "string";
  if (r.what === "machine") return !!r.machine && typeof r.machine.key === "string" && typeof r.machine.signer === "string" && typeof r.machine.snapshot?.sig === "string" && typeof r.machine.image?.digest === "string";
  return false;
}

/** What was shared with this login, newest first. Records that are not readable or not well-formed are left out. */
export async function listShares(store: ChainStore, v: Vault, opts: { limit?: number; cacheDir?: string } = {}): Promise<Received[]> {
  const mine = shareKeys(v);
  const out: Received[] = [];
  for (const p of await store.listPointers(inboxTag(mine.publicKey), { limit: opts.limit ?? 100 })) {
    const got = openFrom(mine, p.payload, "share");
    if (!got) continue;
    try {
      const m = JSON.parse(got.plain.toString("utf8")) as { r?: string; o?: { sig: string; sha256: string; size: number }; by?: string; c: StoredRef["codec"]; n: number };
      let packed: Buffer;
      if (m.r) packed = Buffer.from(m.r, "base64");
      else if (m.o && m.by) {
        const inner = openFrom(mine, await store.get(m.o, { signers: [addressToBytes(m.by)], cacheDir: opts.cacheDir }), "share-record");
        if (!inner || !inner.sender.equals(got.sender)) continue;
        packed = inner.plain;
      } else continue;
      if (!Number.isInteger(m.n) || m.n < 0 || m.n > 4 << 20) continue;
      const record = JSON.parse(decompress(m.c, packed, m.n).toString("utf8")) as ShareRecord;
      if (valid(record)) out.push({ id: p.signature, arrived: p.blockTime, from: shareAddress(got.sender), record });
    } catch { /* not a record we understand */ }
  }
  return out;
}

/** Adds a shared image to the vault's private catalog, under `name`. From then on it runs as me/<name>. */
export async function acceptImage(store: ChainStore, v: Vault, r: ShareRecord, name = r.name): Promise<void> {
  if (r.what !== "image" || !r.image) throw new Error("this share is not an image");
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) throw new Error(`invalid image name "${name}": use lower-case letters, digits, ".", "_" or "-"`);
  const cat = await readPrivateCatalog(store, v);
  const existing = cat.images[name]?.tags[r.image.tag]?.[r.image.arch];
  if (existing && existing.digest !== r.image.ref.digest) throw new Error(`you already have a different private image "${name}:${r.image.tag}" for ${r.image.arch}. Keep the shared one under another name: --name <name>`);
  const image = (cat.images[name] ??= { tags: {} });
  if (r.image.description && !image.description) image.description = r.image.description;
  (image.tags[r.image.tag] ??= {})[r.image.arch] = { ...r.image.ref, private: true };
  if (r.image.tag !== "latest") (image.tags.latest ??= {})[r.image.arch] ??= { ...r.image.ref, private: true };
  await writePrivateCatalog(store, v, cat);
}

/**
 * Makes a shared save a machine of the vault's own, named `name`: the snapshot is stored again
 * under the vault (a small document; the file contents stay where they are), and the machine
 * is added to the vault's list. `chainboot run <name>` then brings it back on any computer.
 */
export async function acceptMachine(store: ChainStore, v: Vault, r: ShareRecord, name = r.name, opts: { cacheDir?: string } = {}): Promise<void> {
  if (r.what !== "machine" || !r.machine) throw new Error("this share is not a machine");
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) throw new Error(`invalid machine name "${name}": use lower-case letters, digits, ".", "_" or "-"`);
  const index = await readIndex(store, v);
  if (index.machines[name] || (await readHead(store, v, name))) throw new Error(`you already have a saved machine named "${name}". Keep the shared one under another name: --name <name>`);
  const m = r.machine;
  const sealed = await store.get({ sig: m.snapshot.sig, sha256: m.snapshot.sha256, size: m.snapshot.size }, { signers: [addressToBytes(m.signer)], cacheDir: opts.cacheDir });
  const snap = JSON.parse(decompress(m.snapshot.codec, openWithKey(Buffer.from(m.key, "base64"), sealed, "snapshot"), m.snapshot.rawSize).toString("utf8")) as Snapshot;
  if (snap?.chainboot !== 1 || snap.kind !== "snapshot" || !Array.isArray(snap.tree) || !Array.isArray(snap.packs) || !Array.isArray(snap.deleted)) throw new Error("the shared snapshot is malformed");
  for (const p of snap.packs) {
    if (p.enc && !p.key) p.key = m.keys?.[p.sha256];
    if (p.enc && !p.key) throw new Error("the share does not carry the key of every pack it needs");
  }
  const time = Math.floor(Date.now() / 1000);
  const mine: Snapshot = { ...snap, machine: name, seq: 1, time, image: m.image, history: [] };
  await putDoc(store, v, stateTagOf(v, name), "snapshot", mine, { seq: 1, time });
  index.machines[name] = { image: m.image, created: m.created, ...(m.boot && { boot: true }) };
  await writeIndex(store, v, index);
}

/** This login's share address: what to give to people who should be able to share with it. */
export function myShareAddress(v: Vault): string { return shareAddress(shareKeys(v).publicKey); }
