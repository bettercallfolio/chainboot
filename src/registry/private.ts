// Private images: systems on chain that only one wallet can read.
//
// A private image is stored like any other image, with three differences:
//   - its new packs are encrypted before upload, each with a key of its own that is derived
//     from the owner's vault key and written into the manifest,
//   - its manifest (all file names, sizes, hashes, and those pack keys) is encrypted too,
//   - it is listed in a private catalog, itself encrypted, under a tag of the owner's vault.
// Files that are byte-for-byte identical to files of a public image (for example the Ubuntu
// base it was built on) are referenced there and not uploaded again; nothing on chain links
// the private image to them.
//
// Everything is signed by the vault account, so readers of the owner's catalog accept nothing
// that somebody else wrote, and without the wallet's signature nobody can decrypt anything.
import { compress } from "../codec/index.ts";
import type { BuiltImage } from "../image/build.ts";
import { serializeManifest } from "../image/manifest.ts";
import { getDocByRef, getPointer, putDoc } from "../state/snapshot.ts";
import { seal, sealWithKey, type Vault } from "../state/vault.ts";
import { tagAddress, type ChainStore, type PutProgress } from "../store/store.ts";
import type { Commitment } from "../store/sender.ts";
import type { Catalog, ImageRef, Progress } from "./registry.ts";

export interface PrivateCatalog { chainboot: 1; kind: "private-catalog"; updated: number; images: Catalog["images"] }

const privateTag = (v: Vault) => tagAddress("private-images", v.signer.publicKey);
/** The tag under which a vault's newest private catalog is named. */
export const privateTagOf = privateTag;

/** The signed-in wallet's private images. Empty when it has none. */
export async function readPrivateCatalog(store: ChainStore, v: Vault): Promise<PrivateCatalog> {
  const p = await getPointer<object>(store, v, privateTag(v), "private-catalog");
  if (!p) return { chainboot: 1, kind: "private-catalog", updated: 0, images: {} };
  const cat = await getDocByRef<PrivateCatalog>(store, v, "private-catalog", p.ref);
  if (cat?.chainboot !== 1 || cat.kind !== "private-catalog" || typeof cat.images !== "object") throw new Error("your private catalog is malformed");
  return cat;
}

export async function writePrivateCatalog(store: ChainStore, v: Vault, cat: PrivateCatalog, commitment?: Commitment): Promise<void> {
  cat.updated = Math.floor(Date.now() / 1000);
  await putDoc(store, v, privateTag(v), "private-catalog", cat, {}, { commitment });
}

export interface PrivatePublishOptions { tags?: string[]; description?: string; journalDir?: string; commitment?: Commitment; onProgress?: (p: Progress) => void }

/** Encrypts and uploads the new packs and the manifest, then lists the image in the private catalog. */
export async function publishPrivateImage(store: ChainStore, v: Vault, built: BuiltImage, opts: PrivatePublishOptions = {}): Promise<ImageRef> {
  const m = built.manifest;
  const say = (phase: string) => (p: PutProgress) => opts.onProgress?.({ phase, done: p.done, total: p.total, detail: p.phase });
  for (const [index, data] of [...built.newPacks.entries()].sort((a, b) => a[0] - b[0])) {
    const { sealed, key } = sealWithKey(v.encKey, data, "pack");
    const ref = await store.put(v.signer, sealed, { journalDir: opts.journalDir, commitment: opts.commitment, onProgress: say(`pack ${index + 1}/${m.packs.length}`) });
    const p = m.packs[index]!;
    p.sig = ref.sig; p.sha256 = ref.sha256; p.size = ref.size; p.enc = 1; p.key = key;
  }
  if (m.packs.some((p) => !p.sig)) throw new Error("internal error: a pack has no on-chain address");
  const raw = serializeManifest(m);
  const packed = compress(raw);
  const o = await store.put(v.signer, seal(v.encKey, packed.data, "image-manifest"), { journalDir: opts.journalDir, commitment: opts.commitment, onProgress: say("manifest") });
  const ref: ImageRef = {
    sig: o.sig, sha256: o.sha256, size: o.size, codec: packed.codec, rawSize: raw.length,
    digest: m.digest, version: m.version, created: m.created,
    downloadSize: o.size + m.packs.reduce((n, p) => n + p.size, 0), unpackedSize: m.rawSize, private: true,
  };
  opts.onProgress?.({ phase: "catalog", done: 0, total: 1 });
  const cat = await readPrivateCatalog(store, v);
  const image = (cat.images[m.name] ??= { tags: {} });
  if (opts.description ?? m.description) image.description = opts.description ?? m.description;
  for (const tag of opts.tags ?? [m.version, "latest"]) (image.tags[tag] ??= {})[m.arch] = ref;
  await writePrivateCatalog(store, v, cat, opts.commitment);
  opts.onProgress?.({ phase: "catalog", done: 1, total: 1 });
  return ref;
}

/** Removes an image, a tag, or one architecture from the private catalog. The encrypted data stays on the ledger. */
export async function unlistPrivateImage(store: ChainStore, v: Vault, name: string, tag?: string, arch?: string): Promise<boolean> {
  const cat = await readPrivateCatalog(store, v);
  const image = cat.images[name];
  if (!image) return false;
  if (!tag) delete cat.images[name];
  else if (!image.tags[tag]) return false;
  else if (!arch) delete image.tags[tag];
  else if (!image.tags[tag][arch]) return false;
  else { delete image.tags[tag][arch]; if (!Object.keys(image.tags[tag]).length) delete image.tags[tag]; }
  if (cat.images[name] && !Object.keys(cat.images[name].tags).length) delete cat.images[name];
  await writePrivateCatalog(store, v, cat);
  return true;
}
