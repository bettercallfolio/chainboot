// Turning a list of file system entries into an image: tree + packs.
import { createHash } from "node:crypto";
import { compress, decompress, type Codec } from "../codec/index.ts";
import { sha256, toHex } from "../util/bytes.ts";
import { EMPTY_SHA256, MANIFEST_VERSION, comparePaths, toNode, treeDigest, type FileNode, type ImageConfig, type ImageManifest, type PackInfo, type TreeNode } from "./manifest.ts";
import type { Entry } from "./tar.ts";

/** Largest pack before compression. One pack is one solid stream, so this also bounds memory use. */
export const MAX_PACK_RAW = 128 << 20;

export interface ImageMeta {
  name: string;
  version: string;
  arch: string;
  created?: number;
  description?: string;
  source?: ImageManifest["source"];
  config?: ImageConfig;
}

export interface BuildOptions {
  codec?: Codec;
  /** Manifests of images already on chain: files they contain are referenced instead of stored again. */
  reuse?: ImageManifest[];
  onProgress?: (text: string) => void;
}

export interface BuiltImage {
  manifest: ImageManifest;
  /** Stored bytes of every pack that still has to be published (index = position in manifest.packs). */
  newPacks: Map<number, Buffer>;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export function checkImageName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid image name "${name}": use lower-case letters, digits, ".", "_" or "-" (at most 63 characters)`);
}

/**
 * Sorts entries, adds directories the archive forgot to list, resolves hard links and
 * rejects anything that could not be unpacked safely.
 */
export function normalizeEntries(input: Entry[]): Entry[] {
  const byPath = new Map<string, Entry>();
  for (const e of input) {
    if (!e.path) continue;
    const old = byPath.get(e.path);
    // archives may list a path twice (the later one wins, like tar does when unpacking)
    if (old && old.type === "d" && e.type !== "d") throw new Error(`${e.path} is both a directory and a ${e.type} entry`);
    byPath.set(e.path, e);
  }
  for (const e of [...byPath.values()]) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      const p = byPath.get(parent);
      if (!p) byPath.set(parent, { path: parent, type: "d", mode: 0o755, uid: 0, gid: 0, mtime: 0 });
      else if (p.type !== "d") throw new Error(`${e.path} is inside ${parent}, which is not a directory`);
    }
  }
  for (const e of byPath.values()) {
    if (e.type !== "h") continue;
    let target = byPath.get(e.link ?? "");
    for (let hops = 0; target?.type === "h" && hops < 16; hops++) target = byPath.get(target.link ?? "");
    if (!target || target.type !== "f") throw new Error(`hard link ${e.path} points at ${e.link}, which is not a regular file in the archive`);
    e.link = target.path;
  }
  return [...byPath.values()].sort((a, b) => comparePaths(a.path, b.path));
}

function extension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const m = /\.([A-Za-z0-9_]+)(\.[0-9.]+)?$/.exec(base);
  return m ? m[1]!.toLowerCase() : "";
}

const isElf = (d: Buffer) => d.length > 4 && d.readUInt32BE(0) === 0x7f454c46;

/** Builds the manifest and compresses the packs. Nothing touches the network here. */
export function buildImage(input: Entry[], meta: ImageMeta, opts: BuildOptions = {}): BuiltImage {
  checkImageName(meta.name);
  const say = opts.onProgress ?? (() => {});
  const entries = normalizeEntries(input);

  // 1. hash every file, find the unique contents
  const hashOf = new Map<Entry, string>();
  const unique = new Map<string, Entry>();
  for (const e of entries) {
    if (e.type !== "f") continue;
    const data = e.data ?? Buffer.alloc(0);
    const h = data.length ? toHex(sha256(data)) : EMPTY_SHA256;
    hashOf.set(e, h);
    if (data.length && !unique.has(h)) unique.set(h, e);
  }

  // 2. contents that already exist on chain (in the packs of other images) are referenced, not repeated
  const packs: PackInfo[] = [];
  const where = new Map<string, { pack: number; offset: number }>();
  for (const base of opts.reuse ?? []) {
    const remap = new Map<number, number>();
    for (const n of base.tree) {
      if (n[1] !== "f" || n[6] === 0 || !unique.has(n[7]) || where.has(n[7])) continue;
      const src = base.packs[n[8]]!;
      if (!src.sig) continue;
      let idx = remap.get(n[8]);
      if (idx === undefined) {
        idx = packs.findIndex((p) => p.sig === src.sig);
        if (idx < 0) { idx = packs.length; packs.push({ ...src }); }
        remap.set(n[8], idx);
      }
      where.set(n[7], { pack: idx, offset: n[9] });
    }
  }
  const reused = where.size;

  // 3. order the remaining contents so that similar data sits together: machine code first, then by
  //    file type, bigger files first. (Measured on Ubuntu: this beats archive order and name order.)
  const fresh = [...unique.entries()].filter(([h]) => !where.has(h)).map(([h, e]) => ({ h, e, elf: isElf(e.data!), ext: extension(e.path) }));
  fresh.sort((a, b) => Number(b.elf) - Number(a.elf) || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0) || b.e.data!.length - a.e.data!.length || comparePaths(a.e.path, b.e.path));

  // 4. cut into packs and compress
  const newPacks = new Map<number, Buffer>();
  let group: typeof fresh = [], groupSize = 0;
  const flush = () => {
    if (!group.length) return;
    const raw = Buffer.concat(group.map((g) => g.e.data!));
    const index = packs.length;
    let offset = 0;
    for (const g of group) { where.set(g.h, { pack: index, offset }); offset += g.e.data!.length; }
    say(`compressing pack ${index + 1} (${(raw.length / 1e6).toFixed(1)} MB)`);
    const packed = compress(raw, { arch: meta.arch, codec: opts.codec });
    // never publish a pack that does not decode back to exactly what went in
    if (!decompress(packed.codec, packed.data, raw.length).equals(raw)) throw new Error("internal error: pack does not round-trip");
    packs.push({ sig: "", sha256: toHex(sha256(packed.data)), size: packed.data.length, codec: packed.codec, rawSha256: toHex(sha256(raw)), rawSize: raw.length });
    newPacks.set(index, packed.data);
    group = []; groupSize = 0;
  };
  for (const f of fresh) {
    if (groupSize && groupSize + f.e.data!.length > MAX_PACK_RAW) flush();
    group.push(f); groupSize += f.e.data!.length;
  }
  flush();

  // 5. the tree
  const tree: TreeNode[] = entries.map((e) => {
    if (e.type !== "f") return toNode(e);
    const h = hashOf.get(e)!;
    return toNode(e, h === EMPTY_SHA256 ? { sha256: h, pack: -1, offset: 0 } : { sha256: h, ...where.get(h)! });
  });
  // drop reused packs that ended up unused (cannot happen today, but keeps the invariant obvious)
  const used = new Set(tree.filter((n): n is FileNode => n[1] === "f" && n[6] > 0).map((n) => n[8]));
  if (used.size !== packs.length) throw new Error("internal error: unused pack in manifest");

  let created = meta.created;
  if (created === undefined) { created = 0; for (const e of entries) if (e.mtime > created) created = e.mtime; }
  const manifest: ImageManifest = {
    chainboot: MANIFEST_VERSION, kind: "image", name: meta.name, version: meta.version, arch: meta.arch, os: "linux", created,
    ...(meta.description && { description: meta.description }),
    ...(meta.source && { source: meta.source }),
    ...(meta.config && { config: meta.config }),
    digest: treeDigest(tree),
    rawSize: entries.reduce((n, e) => n + (e.data?.length ?? 0), 0),
    fileCount: entries.length,
    packs, tree,
  };
  say(`${entries.length} entries, ${unique.size} unique files (${reused} already on chain), ${packs.length} pack(s)`);
  return { manifest, newPacks };
}

/** Rebuilds the entries of an image from its manifest and decompressed packs (the inverse of buildImage). */
export function entriesFromImage(m: ImageManifest, rawPack: (index: number) => Buffer): Entry[] {
  const files = new Map(m.tree.filter((n): n is FileNode => n[1] === "f").map((n) => [n[0], n]));
  return m.tree.map((n): Entry => {
    const x = (n[1] === "f" ? n[10] : n[1] === "d" ? n[6] : undefined) as Record<string, string> | undefined;
    const xattrs = x ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Buffer.from(v, "base64")])) : undefined;
    switch (n[1]) {
      case "f": {
        const data = n[6] === 0 ? Buffer.alloc(0) : rawPack(n[8]).subarray(n[9], n[9] + n[6]);
        return { path: n[0], type: "f", mode: n[2], uid: n[3], gid: n[4], mtime: n[5], data, ...(xattrs && { xattrs }) };
      }
      case "d": return { path: n[0], type: "d", mode: n[2], uid: n[3], gid: n[4], mtime: n[5], ...(xattrs && { xattrs }) };
      case "l": return { path: n[0], type: "l", mode: n[2], uid: n[3], gid: n[4], mtime: n[5], link: n[6] };
      case "h": { // a hard link is another name of the same file, so it shares the file's attributes
        const t = files.get(n[2])!;
        return { path: n[0], type: "h", mode: t[2], uid: t[3], gid: t[4], mtime: t[5], link: n[2] };
      }
      case "c": case "b": return { path: n[0], type: n[1], mode: n[2], uid: n[3], gid: n[4], mtime: n[5], major: n[6], minor: n[7] };
      case "p": return { path: n[0], type: "p", mode: n[2], uid: n[3], gid: n[4], mtime: n[5] };
    }
  });
}

/** Checks a decompressed pack against the manifest and every file inside it against its own hash. */
export function verifyPack(m: ImageManifest, index: number, raw: Buffer): void {
  const p = m.packs[index];
  if (!p) throw new Error(`manifest has no pack ${index}`);
  if (raw.length !== p.rawSize || toHex(sha256(raw)) !== p.rawSha256) throw new Error(`pack ${index + 1} of ${m.name} is damaged (hash mismatch)`);
  for (const n of m.tree) {
    if (n[1] !== "f" || n[6] === 0 || n[8] !== index) continue;
    const h = createHash("sha256").update(raw.subarray(n[9], n[9] + n[6])).digest("hex");
    if (h !== n[7]) throw new Error(`file ${n[0]} in ${m.name} is damaged (hash mismatch)`);
  }
}
