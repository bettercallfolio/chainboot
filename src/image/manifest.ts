// The image manifest: a complete, verifiable description of a root file system.
//
// An image is two things:
//   - packs: big blobs made of file contents glued together and compressed (stored on chain),
//   - tree:  one line per file system object saying what it is and where its content sits in the packs.
//
// The *digest* of an image depends only on the files (names, contents, owners, modes, times),
// never on how they were packed or where they are stored. Two people who package the same
// system get the same digest, and anyone can recompute it from an unpacked system.
import { createHash } from "node:crypto";
import type { Codec } from "../codec/index.ts";
import type { Entry } from "./tar.ts";

export const MANIFEST_VERSION = 1;

export interface PackInfo {
  /** Head signature of the pack object on chain ("" until it has been published). */
  sig: string;
  /** SHA-256 and size of the stored (compressed) pack. */
  sha256: string;
  size: number;
  codec: Codec;
  /** SHA-256 and size of the pack after decompression. */
  rawSha256: string;
  rawSize: number;
  /** 1 when the stored pack is encrypted with the owner's vault key (private images). */
  enc?: 0 | 1;
}

// Compact tuples keep the manifest small. Position 0 is always the path, position 1 the type.
export type FileNode = [path: string, type: "f", mode: number, uid: number, gid: number, mtime: number, size: number, sha256: string, pack: number, offset: number, xattrs?: Record<string, string>];
export type DirNode = [path: string, type: "d", mode: number, uid: number, gid: number, mtime: number, xattrs?: Record<string, string>];
export type LinkNode = [path: string, type: "l", mode: number, uid: number, gid: number, mtime: number, target: string];
export type HardNode = [path: string, type: "h", target: string];
export type DevNode = [path: string, type: "c" | "b", mode: number, uid: number, gid: number, mtime: number, major: number, minor: number];
export type FifoNode = [path: string, type: "p", mode: number, uid: number, gid: number, mtime: number];
export type TreeNode = FileNode | DirNode | LinkNode | HardNode | DevNode | FifoNode;

export interface ImageConfig {
  /** Command started by `chainboot run` (default: the root user's login shell). */
  cmd?: string[];
  env?: Record<string, string>;
}

export interface ImageManifest {
  chainboot: typeof MANIFEST_VERSION;
  kind: "image";
  name: string;
  version: string;
  /** Debian-style architecture name: amd64, arm64, riscv64, ... */
  arch: string;
  os: "linux";
  /** Seconds since 1970. */
  created: number;
  description?: string;
  /** Where the content came from, so others can check it against the original. */
  source?: { url?: string; sha256?: string; note?: string };
  config?: ImageConfig;
  /** Content identity, see treeDigest(). */
  digest: string;
  rawSize: number;
  fileCount: number;
  packs: PackInfo[];
  tree: TreeNode[];
}

export function comparePaths(a: string, b: string): number {
  return a === b ? 0 : Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sortedXattrs(x: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!x || !Object.keys(x).length) return undefined;
  return Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]!]));
}

/** The part of a node that describes content (no pack position). One JSON line per node feeds the digest. */
export function identityLine(n: TreeNode): string {
  switch (n[1]) {
    case "f": { const x = sortedXattrs(n[10]); return JSON.stringify(x ? [n[0], "f", n[2], n[3], n[4], n[5], n[6], n[7], x] : [n[0], "f", n[2], n[3], n[4], n[5], n[6], n[7]]); }
    case "d": { const x = sortedXattrs(n[6]); return JSON.stringify(x ? [n[0], "d", n[2], n[3], n[4], n[5], x] : [n[0], "d", n[2], n[3], n[4], n[5]]); }
    default: return JSON.stringify(n);
  }
}

/** SHA-256 over the identity lines of all nodes in path order. */
export function treeDigest(tree: readonly TreeNode[]): string {
  const h = createHash("sha256");
  h.update(`chainboot-tree-v${MANIFEST_VERSION}\n`);
  for (const n of tree) { h.update(identityLine(n)); h.update("\n"); }
  return h.digest("hex");
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function encodeXattrs(x: Record<string, Buffer> | undefined): Record<string, string> | undefined {
  if (!x || !Object.keys(x).length) return undefined;
  return Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]!.toString("base64")]));
}

/** Converts an Entry to a tree node. For files the caller supplies hash and pack position. */
export function toNode(e: Entry, file?: { sha256: string; pack: number; offset: number }): TreeNode {
  const x = encodeXattrs(e.xattrs);
  switch (e.type) {
    case "f": {
      if (!file) throw new Error("file node needs its hash and position");
      const n: FileNode = [e.path, "f", e.mode, e.uid, e.gid, e.mtime, e.data?.length ?? 0, file.sha256, file.pack, file.offset];
      if (x) n.push(x);
      return n;
    }
    case "d": { const n: DirNode = [e.path, "d", e.mode, e.uid, e.gid, e.mtime]; if (x) n.push(x); return n; }
    case "l": return [e.path, "l", e.mode, e.uid, e.gid, e.mtime, e.link ?? ""];
    case "h": return [e.path, "h", e.link ?? ""];
    case "c": case "b": return [e.path, e.type, e.mode, e.uid, e.gid, e.mtime, e.major ?? 0, e.minor ?? 0];
    case "p": return [e.path, "p", e.mode, e.uid, e.gid, e.mtime];
  }
}

const isInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/**
 * Checks everything a manifest promises before anything is written to disk:
 * well-formed nodes, sorted unique safe paths, parents that are real directories,
 * hard links that point at files, pack references inside the packs, and the digest.
 */
export function validateManifest(m: unknown): asserts m is ImageManifest {
  const fail = (why: string): never => { throw new Error(`invalid image manifest: ${why}`); };
  if (!m || typeof m !== "object") fail("not an object");
  const o = m as Record<string, unknown>;
  if (o.chainboot !== MANIFEST_VERSION) fail(`unsupported format version ${String(o.chainboot)} (this program understands version ${MANIFEST_VERSION}; update chainboot)`);
  if (o.kind !== "image") fail("not an image");
  for (const k of ["name", "version", "arch", "digest"]) if (typeof o[k] !== "string" || !o[k]) fail(`missing ${k}`);
  if (o.os !== "linux") fail("only linux images are supported");
  if (!Array.isArray(o.packs) || !Array.isArray(o.tree)) fail("missing packs or tree");
  const packs = o.packs as PackInfo[];
  for (const p of packs) {
    if (!p || typeof p.sig !== "string" || !isHash(p.sha256) || !isHash(p.rawSha256) || !isInt(p.size) || !isInt(p.rawSize) || !["xz", "zstd", "raw"].includes(p.codec) || (p.enc !== undefined && p.enc !== 0 && p.enc !== 1)) fail("malformed pack entry");
  }
  const kinds = new Map<string, string>();
  let prev: string | null = null;
  for (const n of o.tree as unknown[]) {
    if (!Array.isArray(n) || typeof n[0] !== "string" || typeof n[1] !== "string") fail("malformed tree node");
    const node = n as unknown[], path = node[0] as string, type = node[1] as string;
    if (!path || path.startsWith("/") || path.split("/").some((s) => s === "" || s === "." || s === "..") || path.includes("\0")) fail(`unsafe path ${JSON.stringify(path)}`);
    if (prev !== null && comparePaths(prev, path) >= 0) fail(`tree is not sorted or has a duplicate at ${path}`);
    prev = path;
    const slash = path.lastIndexOf("/");
    if (slash > 0 && kinds.get(path.slice(0, slash)) !== "d") fail(`parent of ${path} is not a directory in this image`);
    const common = () => { if (!isInt(node[2], 0o7777) || !isInt(node[3], 0xffff_ffff) || !isInt(node[4], 0xffff_ffff) || !isInt(node[5])) fail(`bad attributes for ${path}`); };
    switch (type) {
      case "f": {
        common();
        if (node.length < 10 || node.length > 11 || !isInt(node[6]) || !isHash(node[7]) || !Number.isInteger(node[8]) || !isInt(node[9])) fail(`bad file node ${path}`);
        const size = node[6] as number, pack = node[8] as number, offset = node[9] as number;
        if (size === 0) { if (node[7] !== EMPTY_SHA256) fail(`bad empty file ${path}`); }
        else if (pack < 0 || pack >= packs.length || offset + size > packs[pack]!.rawSize) fail(`file ${path} points outside its pack`);
        break;
      }
      case "d": common(); if (node.length > 7) fail(`bad directory node ${path}`); break;
      case "l": common(); if (node.length !== 7 || typeof node[6] !== "string" || !node[6]) fail(`bad symlink ${path}`); break;
      case "h": if (node.length !== 3 || typeof node[2] !== "string") fail(`bad hard link ${path}`); break;
      case "c": case "b": common(); if (node.length !== 8 || !isInt(node[6]) || !isInt(node[7])) fail(`bad device node ${path}`); break;
      case "p": common(); if (node.length !== 6) fail(`bad fifo ${path}`); break;
      default: fail(`unknown node type ${type} for ${path}`);
    }
    const x = type === "f" ? node[10] : type === "d" ? node[6] : undefined;
    if (x !== undefined && (typeof x !== "object" || x === null || Object.values(x).some((v) => typeof v !== "string"))) fail(`bad extended attributes for ${path}`);
    kinds.set(path, type);
  }
  for (const n of o.tree as TreeNode[]) if (n[1] === "h" && kinds.get(n[2]) !== "f") fail(`hard link ${n[0]} does not point at a regular file`);
  if (treeDigest(o.tree as TreeNode[]) !== o.digest) fail("digest does not match the tree");
}

/** Deterministic JSON: one tree node per line, so manifests are stable and diff-friendly. */
export function serializeManifest(m: ImageManifest): Buffer {
  const { tree, ...head } = m;
  const lines = tree.map((n) => JSON.stringify(n));
  return Buffer.from(`${JSON.stringify(head).slice(0, -1)},"tree":[\n${lines.join(",\n")}\n]}\n`, "utf8");
}

export function parseManifest(bytes: Uint8Array): ImageManifest {
  let m: unknown;
  try { m = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8")); } catch { throw new Error("invalid image manifest: not JSON"); }
  validateManifest(m);
  return m;
}
