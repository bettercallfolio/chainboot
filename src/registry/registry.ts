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
import { openEither, type Vault } from "../state/vault.ts";
import { withLock } from "../util/lock.ts";

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
  /** True in a private catalog: manifest and new packs are encrypted with the owner's vault key. */
  private?: boolean;
  /**
   * Set for an image that another wallet shared: the account that stored it, and the key of
   * its encrypted manifest (base64), which the owner handed over.
   */
  publisher?: string;
  key?: string;
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
/** The tag under which a publisher's newest catalog is named. */
export const catalogTagOf = catalogTag;

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

const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/, LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const isHash = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
/** Text from somebody else's catalog or share, made safe to print: no control characters, no surprises in length. */
export const plainText = (x: unknown, max: number): string => String(x ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, max);

/** One catalog entry with exactly the fields chainboot knows, or null when it is not well formed. */
export function cleanRef(r: unknown): ImageRef | null {
  const x = r as ImageRef | null;
  if (!x || typeof x !== "object" || typeof x.sig !== "string" || x.sig.length > 90 || !isHash(x.sha256) || !isCount(x.size) || !isCount(x.rawSize) || !["xz", "zstd", "raw"].includes(x.codec) || !isHash(x.digest)) return null;
  if (x.publisher !== undefined) { try { addressToBytes(x.publisher); } catch { return null; } }
  if (x.key !== undefined && (typeof x.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(x.key))) return null;
  return {
    sig: x.sig, sha256: x.sha256, size: x.size, codec: x.codec, rawSize: x.rawSize, digest: x.digest,
    version: plainText(x.version, 64), created: isCount(x.created) ? x.created : 0,
    downloadSize: isCount(x.downloadSize) ? x.downloadSize : 0, unpackedSize: isCount(x.unpackedSize) ? x.unpackedSize : 0,
    ...(x.private === true && { private: true }), ...(x.publisher !== undefined && { publisher: x.publisher }), ...(x.key !== undefined && { key: x.key }),
  };
}

/**
 * The images of a catalog with everything dropped that is not well formed. A catalog is
 * written by its publisher; a reader (and a list that many publishers keep) must not trip
 * over what one of them wrote.
 */
export function cleanImages(images: unknown): Catalog["images"] {
  if (!images || typeof images !== "object" || Array.isArray(images)) throw new Error("its list of images is malformed");
  const out: Catalog["images"] = {};
  for (const [name, image] of Object.entries(images as Record<string, { description?: unknown; tags?: unknown } | null>)) {
    if (!NAME.test(name) || !image || typeof image !== "object" || !image.tags || typeof image.tags !== "object" || Array.isArray(image.tags)) continue;
    const tags: Catalog["images"][string]["tags"] = {};
    for (const [tag, arches] of Object.entries(image.tags as Record<string, unknown>)) {
      if (!LABEL.test(tag) || !arches || typeof arches !== "object" || Array.isArray(arches)) continue;
      for (const [arch, ref] of Object.entries(arches as Record<string, unknown>)) {
        const clean = LABEL.test(arch) ? cleanRef(ref) : null;
        if (clean) (tags[tag] ??= {})[arch] = clean;
      }
    }
    if (Object.keys(tags).length) out[name] = { ...(image.description !== undefined && { description: plainText(image.description, 300) }), tags };
  }
  return out;
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
  if (cat?.chainboot !== 1 || cat.kind !== "catalog" || cat.publisher !== publisher) throw new Error(`the catalog of ${publisher} is malformed`);
  try { cat.images = cleanImages(cat.images); } catch (e) { throw new Error(`the catalog of ${publisher} is malformed: ${(e as Error).message}`); }
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
  // a public manifest that named encrypted packs would be unreadable for others, or give away their keys
  if (m.packs.some((p) => p.enc || p.key)) throw new Error("a public image cannot reuse files of a private image. Build it without --reuse of a private image, or publish it as private.");
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
  // (read, change and write as one step: two publishes at once must not lose each other's entry)
  await withLock(`catalog-${payer.address}`, async () => {
    const cat = await readCatalog(store, payer.address);
    const image = (cat.images[m.name] ??= { tags: {} });
    if (opts.description ?? m.description) image.description = opts.description ?? m.description;
    for (const tag of opts.tags ?? [m.version, "latest"]) (image.tags[tag] ??= {})[m.arch] = ref;
    await writeCatalog(store, payer, cat, opts.commitment);
  });
  opts.onProgress?.({ phase: "catalog", done: 1, total: 1 });
  return ref;
}

/** Removes an image, a tag, or one architecture of a tag from the catalog. The data stays on the ledger. */
export async function unlistImage(store: ChainStore, payer: Keypair, name: string, tag?: string, arch?: string): Promise<boolean> {
  return withLock(`catalog-${payer.address}`, () => unlistLocked(store, payer, name, tag, arch));
}

async function unlistLocked(store: ChainStore, payer: Keypair, name: string, tag?: string, arch?: string): Promise<boolean> {
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

/**
 * Adds an image that is already on chain to the payer's catalog, without storing it again:
 * "I vouch for exactly this image under this name". `publisher` is the account that stored
 * it. Used by lists, where several publishers must agree on an image.
 */
export async function endorseImage(store: ChainStore, payer: Keypair, e: { name: string; tags: string[]; arch: string; ref: ImageRef; publisher: string; description?: string }, commitment?: Commitment): Promise<void> {
  if (e.ref.private || e.ref.key) throw new Error("a private image cannot be endorsed");
  if (!NAME.test(e.name) || e.tags.some((t) => !LABEL.test(t)) || !LABEL.test(e.arch)) throw new Error("an image name is lower-case letters, digits, \".\", \"_\" or \"-\"; so are tags and architectures");
  await withLock(`catalog-${payer.address}`, async () => {
    const cat = await readCatalog(store, payer.address);
    const image = (cat.images[e.name] ??= { tags: {} });
    if (e.description && !image.description) image.description = e.description;
    const { sig, sha256, size, codec, rawSize, digest, version, created, downloadSize, unpackedSize } = e.ref;
    const entry: ImageRef = { sig, sha256, size, codec, rawSize, digest, version, created, downloadSize, unpackedSize, ...(e.publisher !== payer.address && { publisher: e.publisher }) };
    for (const tag of e.tags) (image.tags[tag] ??= {})[e.arch] = entry;
    await writeCatalog(store, payer, cat, commitment);
  });
}

export interface ImageName { publisher?: string; name: string; tag: string }

/** Parses "[publisher/]name[:tag]". The publisher is an alias or a base58 address. */
export function parseImageName(text: string): ImageName {
  const m = /^(?:([A-Za-z0-9._-]+)\/)?([a-z0-9][a-z0-9._-]*)(?::([A-Za-z0-9._-]+))?$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not an image name. Examples: ubuntu, ubuntu:26.04, <publisher-address>/alpine:3.22`);
  return { publisher: m[1], name: m[2]!, tag: m[3] ?? "latest" };
}

export interface PulledImage {
  manifest: ImageManifest;
  ref: StoredRef & { digest: string; private?: boolean };
  /** Returns the verified, decompressed pack `index`. */
  pack(index: number): Buffer;
}

/** Downloads (or takes from cache) only the manifest of an image: the list of its files, without their contents. */
export async function pullManifest(store: ChainStore, publisher: string, ref: StoredRef & { digest: string; private?: boolean; publisher?: string; key?: string }, opts: { cacheDir: string; signal?: AbortSignal; vault?: Vault }): Promise<ImageManifest> {
  const objects = path.join(opts.cacheDir, "objects");
  fs.mkdirSync(objects, { recursive: true });
  let body = await store.get({ sig: ref.sig, sha256: ref.sha256, size: ref.size }, { signers: [addressToBytes(ref.publisher ?? publisher)], cacheDir: objects, signal: opts.signal });
  if (ref.private && !ref.key && !opts.vault) throw new Error("this is a private image: sign in with the wallet that published it (chainboot login)");
  if (ref.private) body = openEither(opts.vault?.encKey, ref.key, body, "image-manifest");
  const manifest = parseManifest(decompress(ref.codec, body, ref.rawSize));
  if (manifest.digest !== ref.digest) throw new Error(`the manifest of ${manifest.name} does not match its catalog entry`);
  return manifest;
}

/** Downloads (or takes from cache) the manifest and all packs of an image, fully verified. */
export async function pullImage(store: ChainStore, publisher: string, ref: StoredRef & { digest: string; private?: boolean; publisher?: string; key?: string }, opts: { cacheDir: string; onProgress?: (p: Progress) => void; signal?: AbortSignal; vault?: Vault }): Promise<PulledImage> {
  const key = addressToBytes(ref.publisher ?? publisher);
  const objects = path.join(opts.cacheDir, "objects");
  fs.mkdirSync(objects, { recursive: true });
  opts.onProgress?.({ phase: "manifest", done: 0, total: ref.size });
  let body = await store.get({ sig: ref.sig, sha256: ref.sha256, size: ref.size }, { signers: [key], cacheDir: objects, signal: opts.signal, onProgress: (g) => opts.onProgress?.({ phase: "manifest", done: g.bytes, total: g.size }) });
  if (ref.private && !ref.key && !opts.vault) throw new Error("this is a private image: sign in with the wallet that published it (chainboot login)");
  if (ref.private) body = openEither(opts.vault?.encKey, ref.key, body, "image-manifest");
  const manifest = parseManifest(decompress(ref.codec, body, ref.rawSize));
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
        r = decompress(p.codec, p.enc ? openEither(opts.vault?.encKey, p.key, stored[index]!, "pack") : stored[index]!, p.rawSize);
        verifyPack(manifest, index, r);
        raw.set(index, r);
      }
      return r;
    },
  };
}
