// Publishing and finding images on chain.
//
// Every publisher (a Solana public key) keeps one *catalog*: a small JSON object listing
// their images, tags and architectures. A pointer transaction under the publisher's catalog
// tag always names the newest catalog. Nobody else can change it, because readers only
// accept pointer and catalog transactions paid by the publisher's own key.
//
//   pointer --> catalog --> manifest --> packs
//   (signed by publisher)   (signed)     (verified by SHA-256 from the manifest)
import fs from "node:fs";
import path from "node:path";
import { compress, decompress, type Codec } from "../codec/index.ts";
import { addressToBytes, type Keypair } from "../solana/keys.ts";
import { ChainStore, tagAddress, type PutProgress } from "../store/store.ts";
import type { Commitment } from "../store/sender.ts";
import { verifyPack, type BuiltImage } from "../image/build.ts";
import { parseManifest, serializeManifest, type ImageManifest } from "../image/manifest.ts";

/** Where to find one stored object and how to unpack it. */
export interface StoredRef { sig: string; sha256: string; size: number; codec: Codec; rawSize: number }

/** A catalog entry: one image for one architecture. */
export interface ImageRef extends StoredRef {
  digest: string;
  version: string;
  created: number;
  /** Bytes to download (manifest + packs) and bytes on disk after unpacking. */
  downloadSize: number;
  unpackedSize: number;
}

export interface Catalog {
  chainboot: 1;
  kind: "catalog";
  publisher: string;
  updated: number;
  images: Record<string, { description?: string; tags: Record<string, Record<string, ImageRef>> }>;
}

export interface Progress { phase: string; done: number; total: number; detail?: string }

const catalogTag = (publisher: Uint8Array) => tagAddress("catalog", publisher);

async function putStored(store: ChainStore, payer: Keypair, raw: Buffer, opts: { arch?: string; journalDir?: string; commitment?: Commitment; onProgress?: (p: PutProgress) => void }): Promise<StoredRef> {
  const packed = compress(raw, { arch: opts.arch });
  if (!decompress(packed.codec, packed.data, raw.length).equals(raw)) throw new Error("internal error: object does not round-trip");
  const ref = await store.put(payer, packed.data, { journalDir: opts.journalDir, commitment: opts.commitment, onProgress: opts.onProgress });
  return { sig: ref.sig, sha256: ref.sha256, size: ref.size, codec: packed.codec, rawSize: raw.length };
}

async function getStored(store: ChainStore, ref: StoredRef, opts: { signers?: Uint8Array[]; cacheDir?: string; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<Buffer> {
  const data = await store.get({ sig: ref.sig, sha256: ref.sha256, size: ref.size }, {
    signers: opts.signers, cacheDir: opts.cacheDir, signal: opts.signal,
    onProgress: (p) => opts.onProgress?.(p.bytes, p.size),
  });
  return decompress(ref.codec, data, ref.rawSize);
}

/** Reads a publisher's catalog. Returns an empty catalog when they have not published anything yet. */
export async function readCatalog(store: ChainStore, publisher: string, cacheDir?: string): Promise<Catalog> {
  const key = addressToBytes(publisher);
  const ptr = await store.getPointer(catalogTag(key), [key]);
  if (!ptr) return { chainboot: 1, kind: "catalog", publisher, updated: 0, images: {} };
  let ref: StoredRef;
  try { ref = JSON.parse(ptr.payload.toString("utf8")) as StoredRef; } catch { throw new Error(`the catalog pointer of ${publisher} is malformed`); }
  const raw = await getStored(store, ref, { signers: [key], cacheDir });
  const cat = JSON.parse(raw.toString("utf8")) as Catalog;
  if (cat?.chainboot !== 1 || cat.kind !== "catalog" || cat.publisher !== publisher || typeof cat.images !== "object") throw new Error(`the catalog of ${publisher} is malformed`);
  return cat;
}

async function writeCatalog(store: ChainStore, payer: Keypair, cat: Catalog, commitment?: Commitment): Promise<void> {
  cat.updated = Math.floor(Date.now() / 1000);
  const ref = await putStored(store, payer, Buffer.from(JSON.stringify(cat)), { commitment });
  await store.putPointer(payer, catalogTag(payer.publicKey), Buffer.from(JSON.stringify(ref)), { commitment });
}

export interface PublishOptions {
  /** Tags that will point at this image (default: its version and "latest"). */
  tags?: string[];
  description?: string;
  journalDir?: string;
  commitment?: Commitment;
  onProgress?: (p: Progress) => void;
}

/** Uploads the new packs and the manifest, then lists the image in the publisher's catalog. */
export async function publishImage(store: ChainStore, payer: Keypair, built: BuiltImage, opts: PublishOptions = {}): Promise<ImageRef> {
  const m = built.manifest;
  const say = (phase: string) => (p: PutProgress) => opts.onProgress?.({ phase, done: p.done, total: p.total, detail: p.phase });
  for (const [index, data] of [...built.newPacks.entries()].sort((a, b) => a[0] - b[0])) {
    const ref = await store.put(payer, data, { journalDir: opts.journalDir, commitment: opts.commitment, onProgress: say(`pack ${index + 1}/${m.packs.length}`) });
    if (ref.sha256 !== m.packs[index]!.sha256) throw new Error("internal error: pack hash changed during upload");
    m.packs[index]!.sig = ref.sig;
  }
  if (m.packs.some((p) => !p.sig)) throw new Error("internal error: a pack has no on-chain address");
  const mref = await putStored(store, payer, serializeManifest(m), { journalDir: opts.journalDir, commitment: opts.commitment, onProgress: say("manifest") });
  const ref: ImageRef = {
    ...mref, digest: m.digest, version: m.version, created: m.created,
    downloadSize: mref.size + m.packs.reduce((n, p) => n + p.size, 0), unpackedSize: m.rawSize,
  };
  opts.onProgress?.({ phase: "catalog", done: 0, total: 1 });
  const cat = await readCatalog(store, payer.address);
  const image = (cat.images[m.name] ??= { tags: {} });
  if (opts.description ?? m.description) image.description = opts.description ?? m.description;
  for (const tag of opts.tags ?? [m.version, "latest"]) (image.tags[tag] ??= {})[m.arch] = ref;
  await writeCatalog(store, payer, cat, opts.commitment);
  opts.onProgress?.({ phase: "catalog", done: 1, total: 1 });
  return ref;
}

/** Removes an image, a tag, or one architecture of a tag from the catalog. The data stays on the ledger. */
export async function unlistImage(store: ChainStore, payer: Keypair, name: string, tag?: string, arch?: string): Promise<boolean> {
  const cat = await readCatalog(store, payer.address);
  const image = cat.images[name];
  if (!image) return false;
  if (!tag) delete cat.images[name];
  else if (!image.tags[tag]) return false;
  else if (!arch) delete image.tags[tag];
  else if (!image.tags[tag][arch]) return false;
  else { delete image.tags[tag][arch]; if (!Object.keys(image.tags[tag]).length) delete image.tags[tag]; }
  if (cat.images[name] && !Object.keys(cat.images[name].tags).length) delete cat.images[name];
  await writeCatalog(store, payer, cat);
  return true;
}

export interface ImageName { publisher?: string; name: string; tag: string }

/** Parses "[publisher/]name[:tag]". The publisher is an alias or a base58 address. */
export function parseImageName(text: string): ImageName {
  const m = /^(?:([A-Za-z0-9._-]+)\/)?([a-z0-9][a-z0-9._-]*)(?::([A-Za-z0-9._-]+))?$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not an image name. Examples: solbuntu, solbuntu:26.04, <publisher-address>/alpine:3.22`);
  return { publisher: m[1], name: m[2]!, tag: m[3] ?? "latest" };
}

export interface PulledImage {
  manifest: ImageManifest;
  ref: ImageRef;
  /** Returns the verified, decompressed pack `index`. */
  pack(index: number): Buffer;
}

/** Downloads (or takes from cache) the manifest and all packs of an image, fully verified. */
export async function pullImage(store: ChainStore, publisher: string, ref: ImageRef, opts: { cacheDir: string; onProgress?: (p: Progress) => void; signal?: AbortSignal }): Promise<PulledImage> {
  const key = addressToBytes(publisher);
  const objects = path.join(opts.cacheDir, "objects");
  fs.mkdirSync(objects, { recursive: true });
  opts.onProgress?.({ phase: "manifest", done: 0, total: ref.size });
  const manifest = parseManifest(await getStored(store, ref, { signers: [key], cacheDir: objects, signal: opts.signal, onProgress: (d, t) => opts.onProgress?.({ phase: "manifest", done: d, total: t }) }));
  if (manifest.digest !== ref.digest) throw new Error(`the manifest of ${manifest.name} does not match its catalog entry`);
  const total = manifest.packs.reduce((n, p) => n + p.size, 0);
  const got = new Array<number>(manifest.packs.length).fill(0);
  const report = () => opts.onProgress?.({ phase: "download", done: got.reduce((a, b) => a + b, 0), total });
  report();
  const stored = await Promise.all(manifest.packs.map((p, i) =>
    store.get({ sig: p.sig, sha256: p.sha256, size: p.size }, { cacheDir: objects, signal: opts.signal, onProgress: (g) => { got[i] = g.bytes; report(); } })));
  const raw = new Map<number, Buffer>();
  return {
    manifest, ref,
    pack(index: number): Buffer {
      let r = raw.get(index);
      if (!r) {
        const p = manifest.packs[index]!;
        r = decompress(p.codec, stored[index]!, p.rawSize);
        verifyPack(manifest, index, r);
        raw.set(index, r);
      }
      return r;
    },
  };
}
