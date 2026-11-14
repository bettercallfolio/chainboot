// Finding what changed in a machine since its image: the content of the machine's own layer.
//
// The scan walks only the machine's upper layer (the files overlayfs copied or created), so its
// cost depends on how much was changed, not on the size of the system. It must run as root
// inside the machine's mount namespace, because deletions are confirmed against the merged view.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EMPTY_SHA256, comparePaths, identityLine, type ImageManifest, type TreeNode } from "../image/manifest.ts";
import { readXattrs } from "../util/xattr.ts";

/** One changed or added file system object. Regular files carry their hash and where to read them. */
export interface Change {
  path: string;
  type: "f" | "d" | "l" | "h" | "c" | "b" | "p";
  mode: number; uid: number; gid: number; mtime: number;
  link?: string;
  major?: number; minor?: number;
  size?: number;
  sha256?: string;
  /** Absolute path of the file's content on this computer. */
  src?: string;
  /** Extended attributes (name -> base64), when the file has any worth saving. */
  xattrs?: Record<string, string>;
}

export interface ScanResult {
  changes: Change[];
  /** Paths that exist in the image but were removed in the machine. */
  deleted: string[];
  /** Files left out on purpose (caches, temporary data) or because they cannot be saved. */
  skipped: { path: string; why: string }[];
  /** Fingerprint of the whole result: equal fingerprints mean nothing changed. */
  fingerprint: string;
  bytes: number;
}

/** Files larger than this are not saved (a transaction-based store is the wrong place for them). */
export const MAX_SAVED_FILE = 1 << 30;

// Never saved: provided by chainboot at start-up.
const RUNTIME_FILES = new Set(["etc/resolv.conf", "etc/hosts", "etc/hostname"]);
// Directories whose *contents* are not saved: runtime mounts, and caches the system rebuilds by itself.
const UNSAVED_DIRS = [
  "tmp", "run", "proc", "sys", "dev", "var/tmp",
  // package manager caches: large, and rebuilt by the next "apt update" / "apk update" / "dnf makecache"
  "var/lib/apt/lists", "var/cache/apt", "var/cache/apk", "var/cache/dnf", "var/cache/yum", "var/cache/pacman", "var/cache/zypp",
  "var/cache/man", "var/cache/ldconfig", "var/cache/fontconfig", "var/log/journal",
  "root/.cache",
];
const UNSAVED_PATTERNS = [/^home\/[^/]+\/\.cache\//];

export function isUnsaved(p: string): boolean {
  if (RUNTIME_FILES.has(p)) return true;
  for (const d of UNSAVED_DIRS) if (p.startsWith(d + "/")) return true;
  return UNSAVED_PATTERNS.some((re) => re.test(p));
}

interface CacheEntry { size: number; mtimeMs: number; ctimeMs: number; ino: number; sha256: string }

/** The hash of a file and the number of bytes that went into it (a file that is being written may be longer or shorter than it was a moment ago). */
function hashFile(file: string): { sha256: string; size: number } {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  let size = 0;
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n <= 0) break; h.update(buf.subarray(0, n)); size += n; }
  } finally { fs.closeSync(fd); }
  return { sha256: h.digest("hex"), size };
}

/** True for the error of a file that was there a moment ago and is gone now (a running system deletes files all the time). */
const gone = (e: unknown): boolean => { const code = (e as NodeJS.ErrnoException)?.code; return code === "ENOENT" || code === "ENOTDIR"; };

const sameAttrs = (a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean => {
  const ka = Object.keys(a ?? {}), kb = Object.keys(b ?? {});
  return ka.length === kb.length && ka.every((k) => a![k] === b?.[k]);
};

function changeToNode(c: Change): TreeNode {
  switch (c.type) {
    case "f": return c.xattrs ? [c.path, "f", c.mode, c.uid, c.gid, c.mtime, c.size ?? 0, c.sha256 ?? EMPTY_SHA256, 0, 0, c.xattrs] : [c.path, "f", c.mode, c.uid, c.gid, c.mtime, c.size ?? 0, c.sha256 ?? EMPTY_SHA256, 0, 0];
    case "d": return c.xattrs ? [c.path, "d", c.mode, c.uid, c.gid, c.mtime, c.xattrs] : [c.path, "d", c.mode, c.uid, c.gid, c.mtime];
    case "l": return [c.path, "l", c.mode, c.uid, c.gid, c.mtime, c.link ?? ""];
    case "h": return [c.path, "h", c.link ?? ""];
    case "c": case "b": return [c.path, c.type, c.mode, c.uid, c.gid, c.mtime, c.major ?? 0, c.minor ?? 0];
    case "p": return [c.path, "p", c.mode, c.uid, c.gid, c.mtime];
  }
}

export interface ScanOptions {
  /** The machine's own layer. */
  upper: string;
  /** The merged view (image + layer), mounted. */
  merged: string;
  base: ImageManifest;
  /** Remembers file hashes between scans, so unchanged files are not read again. */
  cacheFile?: string;
}

export function scanMachine(o: ScanOptions): ScanResult {
  const baseNodes = new Map<string, TreeNode>();
  const baseChildren = new Map<string, string[]>();
  for (const n of o.base.tree) {
    baseNodes.set(n[0], n);
    const slash = n[0].lastIndexOf("/");
    const parent = slash < 0 ? "" : n[0].slice(0, slash);
    let list = baseChildren.get(parent);
    if (!list) baseChildren.set(parent, (list = []));
    list.push(n[0].slice(slash + 1));
  }
  let cache: Record<string, CacheEntry> = {};
  if (o.cacheFile) { try { cache = JSON.parse(fs.readFileSync(o.cacheFile, "utf8")) as Record<string, CacheEntry>; } catch { /* first scan */ } }
  const nextCache: Record<string, CacheEntry> = {};

  const changes: Change[] = [];
  const deleted = new Set<string>();
  const skipped: { path: string; why: string }[] = [];
  const inodes = new Map<string, string>(); // "dev:ino" -> first path, to keep hard links

  const lexists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

  const walk = (rel: string) => {
    const dir = rel ? path.join(o.upper, rel) : o.upper;
    let names: string[];
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const p = rel ? `${rel}/${name}` : name;
      if (Buffer.byteLength(name) !== Buffer.from(name, "utf8").length || name.includes("�")) { skipped.push({ path: p, why: "file name is not valid UTF-8" }); continue; }
      if (isUnsaved(p)) continue;
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try { st = fs.lstatSync(abs); } catch (e) { if (gone(e)) continue; throw e; }
      const mtime = Math.floor(st.mtimeMs / 1000);
      const common = { path: p, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, mtime };
      if (st.isCharacterDevice() && st.rdev === 0) { // overlay whiteout: "this path is deleted"
        if (baseNodes.has(p)) deleted.add(p);
        continue;
      }
      if (st.isDirectory()) {
        changes.push({ ...common, type: "d" });
        // children of the image that are gone from the merged view (covers directories that were deleted and re-created)
        for (const child of baseChildren.get(p) ?? []) {
          const cp = `${p}/${child}`;
          if (!isUnsaved(cp) && !lexists(path.join(o.merged, cp))) deleted.add(cp);
        }
        walk(p);
      } else if (st.isFile()) {
        if (st.size > MAX_SAVED_FILE) { skipped.push({ path: p, why: "larger than 1 GiB" }); continue; }
        const id = `${st.dev}:${st.ino}`;
        const first = st.nlink > 1 ? inodes.get(id) : undefined;
        if (first) { changes.push({ ...common, type: "h", link: first }); continue; }
        if (st.nlink > 1) inodes.set(id, p);
        const known = cache[p];
        let sha256: string, size = st.size;
        if (st.size === 0) sha256 = EMPTY_SHA256;
        else if (known && known.size === st.size && known.mtimeMs === st.mtimeMs && known.ctimeMs === st.ctimeMs && known.ino === st.ino) sha256 = known.sha256;
        else {
          let hashed: { sha256: string; size: number };
          try { hashed = hashFile(abs); } catch (e) { if (gone(e)) continue; throw e; }
          // size and hash must describe the same bytes: the size is what was hashed, not what the file had a moment before
          sha256 = hashed.sha256; size = hashed.size;
        }
        // (a file that changed while it was read is not remembered: the next scan reads it again)
        if (size === st.size) nextCache[p] = { size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, sha256 };
        changes.push({ ...common, type: "f", size, sha256: size === 0 ? EMPTY_SHA256 : sha256, src: abs });
      } else if (st.isSymbolicLink()) {
        let link: string;
        try { link = fs.readlinkSync(abs); } catch (e) { if (gone(e)) continue; throw e; }
        changes.push({ ...common, type: "l", link });
      } else if (st.isFIFO()) {
        changes.push({ ...common, type: "p" });
      } else if (st.isCharacterDevice() || st.isBlockDevice()) {
        changes.push({ ...common, type: st.isCharacterDevice() ? "c" : "b", major: (st.rdev >> 8) & 0xfff, minor: (st.rdev & 0xff) | ((st.rdev >> 12) & 0xfff00) });
      } else {
        skipped.push({ path: p, why: "sockets cannot be saved" });
      }
    }
  };
  walk("");
  // extended attributes (capabilities, ACLs, user.*) of what was found, when a tool to read them exists
  const attrs = readXattrs(o.upper);
  if (attrs?.size) for (const c of changes) { const x = (c.type === "f" || c.type === "d") && attrs.get(c.path); if (x) c.xattrs = x; }

  // a deleted directory already covers everything below it
  const removed = [...deleted].sort(comparePaths).filter((p, _i, all) => !all.some((q) => q !== p && p.startsWith(q + "/")));
  // drop entries that are identical to the image (overlayfs copies parents up without changing them)
  const linkTargets = new Set(changes.filter((c) => c.type === "h").map((c) => c.link!));
  const real = changes.filter((c) => {
    const b = baseNodes.get(c.path);
    if (!b || linkTargets.has(c.path)) return true;
    // (attributes count too: a capability or an ACL set on a file of the image is a change)
    if (c.type === "f" && b[1] === "f") return !(b[2] === c.mode && b[3] === c.uid && b[4] === c.gid && b[5] === c.mtime && b[7] === c.sha256 && sameAttrs(b[10], c.xattrs));
    return identityLine(changeToNode(c)) !== identityLine(b);
  }).sort((a, b) => comparePaths(a.path, b.path));

  const h = createHash("sha256");
  for (const c of real) h.update(identityLine(changeToNode(c)) + "\n");
  for (const p of removed) h.update(`-${p}\n`);
  if (o.cacheFile) { try { fs.writeFileSync(o.cacheFile, JSON.stringify(nextCache)); } catch { /* the cache is only an optimisation */ } }
  return { changes: real, deleted: removed, skipped, fingerprint: h.digest("hex"), bytes: real.reduce((n, c) => n + (c.size ?? 0), 0) };
}
