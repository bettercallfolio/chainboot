// A read-only file system that shows an image without unpacking it, and fetches a file's
// content only when a program opens it. Written against the kernel's FUSE protocol directly
// (the /dev/fuse device), so it needs no library and no native code.
//
//   kernel  --request-->  /dev/fuse  --read-->  this file  --reply-->  /dev/fuse  --> kernel
//
// What a request needs comes from two places:
//   - names, sizes, owners, modes, links: from the image's manifest, which is in memory;
//   - file contents: from the image's packs. A pack is fetched the first time one of its
//     files is read, checked, and kept decompressed in the cache; after that a read is a
//     read from that file. The kernel keeps what it has read in its page cache.
//
// The image never changes, so the kernel is told to remember every answer for a long time,
// and most requests are asked only once.
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { FileNode, ImageManifest, TreeNode } from "../image/manifest.ts";

// ---- protocol numbers (include/uapi/linux/fuse.h)
const LOOKUP = 1, FORGET = 2, GETATTR = 3, READLINK = 5, OPEN = 14, READ = 15, STATFS = 17, RELEASE = 18, GETXATTR = 22, LISTXATTR = 23,
  FLUSH = 25, INIT = 26, OPENDIR = 27, READDIR = 28, RELEASEDIR = 29, FSYNCDIR = 30, ACCESS = 34, INTERRUPT = 36, DESTROY = 38, BATCH_FORGET = 42, FSYNC = 20, LSEEK = 46;
const ENOENT = 2, EIO = 5, ENOTDIR = 20, EISDIR = 21, EINVAL = 22, EROFS = 30, ERANGE = 34, ENOSYS = 38, ENODATA = 61;
const IN_HEADER = 40, OUT_HEADER = 16, ATTR = 88;
const FOPEN_KEEP_CACHE = 1 << 1, FOPEN_CACHE_DIR = 1 << 3;
const INIT_ASYNC_READ = 1 << 0, INIT_PARALLEL_DIROPS = 1 << 18, INIT_MAX_PAGES = 1 << 22, INIT_CACHE_SYMLINKS = 1 << 23;
/** How long the kernel may keep a name or the attributes of a file: the image does not change. */
const FOREVER = 365 * 86400;
const MAX_WRITE = 1 << 20, BUFFER = MAX_WRITE + 4096;
const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000, S_IFCHR = 0o020000, S_IFBLK = 0o060000, S_IFIFO = 0o010000;
const DT = { d: 4, f: 8, l: 10, c: 2, b: 6, p: 1 } as const;
/** CHAINBOOT_FUSE_TRACE=1 writes every request to the error output (for finding out what a program asked for). */
const TRACE = !!process.env.CHAINBOOT_FUSE_TRACE;

interface Inode {
  ino: number;
  type: "d" | "f" | "l" | "c" | "b" | "p";
  mode: number; uid: number; gid: number; mtime: number; size: number; nlink: number; rdev: number;
  /** f: the manifest entry (pack and offset). l: the link target. */
  file?: FileNode; target?: string;
  /** d: name -> inode, in the order of the manifest. */
  children?: Map<string, Inode>;
  parent: number;
  xattrs?: Record<string, string>;
}

/** Hands out the decompressed content of a pack as an open file. Called once per pack; may take a while (a download). */
export type PackSource = (index: number) => Promise<number>;

export interface LazyStats {
  requests: number; reads: number; bytesRead: number; packsOpened: number;
  /** Paths of the files whose content was read, in the order they were first read. */
  files: string[];
}

const makedev = (major: number, minor: number) => ((major & 0xfff) << 8) | (minor & 0xff) | ((minor & ~0xff) << 12);

/** The image's tree as inodes. Inode 1 is the root directory, as FUSE wants it. */
export function buildInodes(manifest: ImageManifest): Inode[] {
  const root: Inode = { ino: 1, type: "d", mode: 0o755, uid: 0, gid: 0, mtime: manifest.created ?? 0, size: 4096, nlink: 2, rdev: 0, children: new Map(), parent: 1 };
  const inodes: Inode[] = [root];           // index = ino - 1
  const byPath = new Map<string, Inode>([["", root]]);
  const links: TreeNode[] = [];
  const place = (path: string, node: Omit<Inode, "ino" | "parent">): Inode | null => {
    const cut = path.lastIndexOf("/");
    const parent = byPath.get(cut < 0 ? "" : path.slice(0, cut));
    if (!parent?.children) return null; // the manifest was validated: every parent is a directory that came before
    const inode: Inode = { ...node, ino: inodes.length + 1, parent: parent.ino };
    inodes.push(inode);
    parent.children.set(path.slice(cut + 1), inode);
    byPath.set(path, inode);
    if (inode.type === "d") parent.nlink++;
    return inode;
  };
  for (const n of manifest.tree) {
    switch (n[1]) {
      case "d": place(n[0], { type: "d", mode: n[2] & 0o7777, uid: n[3], gid: n[4], mtime: n[5], size: 4096, nlink: 2, rdev: 0, children: new Map(), xattrs: n[6] }); break;
      case "f": place(n[0], { type: "f", mode: n[2] & 0o7777, uid: n[3], gid: n[4], mtime: n[5], size: n[6], nlink: 1, rdev: 0, file: n, xattrs: n[10] }); break;
      case "l": place(n[0], { type: "l", mode: 0o777, uid: n[3], gid: n[4], mtime: n[5], size: Buffer.byteLength(n[6]), nlink: 1, rdev: 0, target: n[6] }); break;
      case "c": case "b": place(n[0], { type: n[1], mode: n[2] & 0o7777, uid: n[3], gid: n[4], mtime: n[5], size: 0, nlink: 1, rdev: makedev(n[6], n[7]) }); break;
      case "p": place(n[0], { type: "p", mode: n[2] & 0o7777, uid: n[3], gid: n[4], mtime: n[5], size: 0, nlink: 1, rdev: 0 }); break;
      case "h": links.push(n); break;
    }
  }
  // a hard link is a second name for the same inode
  for (const n of links) {
    if (n[1] !== "h") continue;
    const target = byPath.get(n[2]), cut = n[0].lastIndexOf("/");
    const parent = byPath.get(cut < 0 ? "" : n[0].slice(0, cut));
    if (!target || !parent?.children) continue;
    parent.children.set(n[0].slice(cut + 1), target);
    byPath.set(n[0], target);
    target.nlink++;
  }
  return inodes;
}

const typeBits = (t: Inode["type"]) => (t === "d" ? S_IFDIR : t === "f" ? S_IFREG : t === "l" ? S_IFLNK : t === "c" ? S_IFCHR : t === "b" ? S_IFBLK : S_IFIFO);

function writeAttr(b: Buffer, at: number, i: Inode): void {
  b.writeBigUInt64LE(BigInt(i.ino), at);
  b.writeBigUInt64LE(BigInt(i.size), at + 8);
  b.writeBigUInt64LE(BigInt(Math.ceil(i.size / 512)), at + 16);
  for (const off of [24, 32, 40]) b.writeBigUInt64LE(BigInt(Math.max(0, i.mtime)), at + off);
  b.writeUInt32LE(typeBits(i.type) | i.mode, at + 60);
  b.writeUInt32LE(i.nlink, at + 64);
  b.writeUInt32LE(i.uid, at + 68);
  b.writeUInt32LE(i.gid, at + 72);
  b.writeUInt32LE(i.rdev, at + 76);
  b.writeUInt32LE(4096, at + 80);
}

/**
 * Serves `manifest` on an open /dev/fuse descriptor until the file system is unmounted.
 * Resolves when that happens. `concurrency` is how many requests may be waited for at once.
 */
export function serveImage(fd: number, manifest: ImageManifest, pack: PackSource, opts: { concurrency?: number; onError?: (what: string) => void } = {}): { done: Promise<void>; stats: LazyStats } {
  const inodes = buildInodes(manifest);
  const stats: LazyStats = { requests: 0, reads: 0, bytesRead: 0, packsOpened: 0, files: [] };
  const wasRead = new Set<number>();
  const packs = new Map<number, Promise<number>>();
  const packFd = (index: number): Promise<number> => {
    let p = packs.get(index);
    if (!p) {
      p = pack(index).then((f) => { stats.packsOpened++; return f; });
      // a failed download is tried again by the next read, not remembered
      p.catch(() => { if (packs.get(index) === p) packs.delete(index); });
      packs.set(index, p);
    }
    return p;
  };
  const totalBytes = inodes.reduce((n, i) => n + (i.type === "f" ? i.size : 0), 0);

  const reply = (unique: bigint, error: number, body?: Buffer) => {
    const out = Buffer.allocUnsafe(OUT_HEADER + (body?.length ?? 0));
    out.writeUInt32LE(out.length, 0);
    out.writeInt32LE(-error, 4);
    out.writeBigUInt64LE(unique, 8);
    if (body) body.copy(out, OUT_HEADER);
    try { fs.writeSync(fd, out); } catch (e) {
      // ENOENT: the request was interrupted and the kernel no longer waits for the answer
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") opts.onError?.(`reply failed: ${(e as Error).message}`);
    }
  };
  const entry = (i: Inode): Buffer => {
    const b = Buffer.alloc(40 + ATTR);
    b.writeBigUInt64LE(BigInt(i.ino), 0);
    b.writeBigUInt64LE(BigInt(FOREVER), 16);
    b.writeBigUInt64LE(BigInt(FOREVER), 24);
    writeAttr(b, 40, i);
    return b;
  };
  const cstring = (b: Buffer, at: number) => { const end = b.indexOf(0, at); return b.toString("utf8", at, end < 0 ? b.length : end); };

  const handle = async (req: Buffer): Promise<void> => {
    const opcode = req.readUInt32LE(4), unique = req.readBigUInt64LE(8), nodeid = Number(req.readBigUInt64LE(16));
    stats.requests++;
    if (TRACE) process.stderr.write(`fuse: opcode ${opcode} node ${nodeid} (${req.length} bytes)\n`);
    const node = inodes[nodeid - 1];
    const body = req.subarray(IN_HEADER);
    switch (opcode) {
      case INIT: {
        const major = body.readUInt32LE(0), minor = body.readUInt32LE(4), readahead = body.readUInt32LE(8), flags = body.readUInt32LE(12);
        const out = Buffer.alloc(64);
        out.writeUInt32LE(7, 0);
        if (major > 7) return reply(unique, 0, out.subarray(0, 8).fill(0, 4)); // the kernel asks again with a version we know
        out.writeUInt32LE(Math.min(minor, 31), 4);
        out.writeUInt32LE(readahead, 8);
        out.writeUInt32LE(flags & (INIT_ASYNC_READ | INIT_PARALLEL_DIROPS | INIT_MAX_PAGES | INIT_CACHE_SYMLINKS), 12);
        out.writeUInt16LE(64, 16);            // requests the kernel may run in the background
        out.writeUInt16LE(48, 18);
        out.writeUInt32LE(MAX_WRITE, 20);
        out.writeUInt32LE(1, 24);             // time granularity, nanoseconds
        out.writeUInt16LE(256, 28);           // pages per request: reads of up to 1 MiB
        return reply(unique, 0, out.subarray(0, minor >= 23 ? 64 : 24));
      }
      case LOOKUP: {
        if (!node?.children) return reply(unique, ENOTDIR);
        const child = node.children.get(cstring(body, 0));
        if (child) return reply(unique, 0, entry(child));
        // "there is no such name" is remembered as well: nodeid 0 with a validity
        const none = Buffer.alloc(40 + ATTR);
        none.writeBigUInt64LE(BigInt(FOREVER), 16);
        return reply(unique, 0, none);
      }
      case FORGET: case BATCH_FORGET: case INTERRUPT: return; // these get no answer
      case GETATTR: {
        if (!node) return reply(unique, ENOENT);
        const b = Buffer.alloc(16 + ATTR);
        b.writeBigUInt64LE(BigInt(FOREVER), 0);
        writeAttr(b, 16, node);
        return reply(unique, 0, b);
      }
      case READLINK: return node?.type === "l" ? reply(unique, 0, Buffer.from(node.target!, "utf8")) : reply(unique, EINVAL);
      case OPEN: case OPENDIR: {
        if (!node) return reply(unique, ENOENT);
        if (opcode === OPEN && node.type === "d") return reply(unique, EISDIR);
        if (opcode === OPENDIR && node.type !== "d") return reply(unique, ENOTDIR);
        if (opcode === OPEN && (body.readUInt32LE(0) & 3) !== 0) return reply(unique, EROFS);
        const b = Buffer.alloc(16);
        b.writeUInt32LE(opcode === OPEN ? FOPEN_KEEP_CACHE : FOPEN_CACHE_DIR, 8);
        return reply(unique, 0, b);
      }
      case READ: {
        if (node?.type !== "f" || !node.file) return reply(unique, node ? EISDIR : ENOENT);
        const offset = Number(body.readBigUInt64LE(8)), want = body.readUInt32LE(16);
        const len = Math.max(0, Math.min(want, node.size - offset));
        if (len === 0) return reply(unique, 0);
        let file: number;
        try { file = await packFd(node.file[8]); } catch (e) { opts.onError?.(`${node.file[0]}: ${(e as Error).message}`); return reply(unique, EIO); }
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        try { while (got < len) { const n = fs.readSync(file, buf, got, len - got, node.file[9] + offset + got); if (n <= 0) break; got += n; } } catch (e) { opts.onError?.(`${node.file[0]}: ${(e as Error).message}`); return reply(unique, EIO); }
        if (got < len) { opts.onError?.(`${node.file[0]}: its pack is shorter than the manifest says`); return reply(unique, EIO); }
        stats.reads++; stats.bytesRead += len;
        if (!wasRead.has(node.ino)) { wasRead.add(node.ino); stats.files.push(node.file[0]); }
        return reply(unique, 0, buf);
      }
      case READDIR: {
        if (!node?.children) return reply(unique, ENOTDIR);
        const offset = Number(body.readBigUInt64LE(8)), size = body.readUInt32LE(16);
        // entries 0 and 1 are "." and "..", then the children in manifest order
        const out = Buffer.alloc(size);
        let at = 0, index = 0;
        const add = (name: string, ino: number, type: number): boolean => {
          index++;
          if (index <= offset) return true;
          const nameLen = Buffer.byteLength(name), rec = 24 + ((nameLen + 7) & ~7);
          if (at + rec > size) return false;
          out.writeBigUInt64LE(BigInt(ino), at);
          out.writeBigUInt64LE(BigInt(index), at + 8);
          out.writeUInt32LE(nameLen, at + 16);
          out.writeUInt32LE(type, at + 20);
          out.write(name, at + 24, "utf8");
          at += rec;
          return true;
        };
        if (add(".", node.ino, DT.d) && add("..", node.parent, DT.d)) {
          for (const [name, child] of node.children) if (!add(name, child.ino, DT[child.type])) break;
        }
        return reply(unique, 0, out.subarray(0, at));
      }
      case STATFS: {
        const b = Buffer.alloc(80);
        b.writeBigUInt64LE(BigInt(Math.ceil(totalBytes / 4096)), 0);
        b.writeBigUInt64LE(BigInt(inodes.length), 24);
        b.writeUInt32LE(4096, 40); b.writeUInt32LE(255, 44); b.writeUInt32LE(4096, 48);
        return reply(unique, 0, b);
      }
      case GETXATTR: case LISTXATTR: {
        if (!node) return reply(unique, ENOENT);
        const size = body.readUInt32LE(0);
        let value: Buffer;
        if (opcode === GETXATTR) {
          const raw = node.xattrs?.[cstring(body, 8)];
          if (raw === undefined) return reply(unique, ENODATA);
          value = Buffer.from(raw, "base64");
        } else value = Buffer.from(Object.keys(node.xattrs ?? {}).map((n) => `${n}\0`).join(""), "utf8");
        if (size === 0) { const b = Buffer.alloc(8); b.writeUInt32LE(value.length, 0); return reply(unique, 0, b); }
        return value.length > size ? reply(unique, ERANGE) : reply(unique, 0, value);
      }
      case RELEASE: case RELEASEDIR: case FLUSH: case FSYNC: case FSYNCDIR: return reply(unique, 0);
      case ACCESS: case LSEEK: return reply(unique, ENOSYS); // the kernel does these itself from now on
      case DESTROY: return reply(unique, 0);
      default:
        // everything else would change the file system
        return reply(unique, opcode === 4 || (opcode >= 6 && opcode <= 13) || opcode === 16 || opcode === 21 || opcode === 24 || opcode === 35 ? EROFS : ENOSYS);
    }
  };

  const done = new Promise<void>((resolve) => {
    let live = 0, ended = false, connected = false;
    const began = Date.now();
    const end = () => { if (!ended) { ended = true; for (const p of packs.values()) p.then((f) => fs.closeSync(f)).catch(() => {}); resolve(); } };
    const loop = () => {
      live++;
      const buf = Buffer.allocUnsafe(BUFFER);
      const next = () => {
        if (ended) return;
        fs.read(fd, buf, 0, BUFFER, null, (err, n) => {
          if (err) {
            // EINTR / ENOENT: an interrupted request, read again. ENODEV: unmounted.
            if (err.code === "EINTR" || err.code === "EAGAIN" || err.code === "ENOENT") return next();
            // EPERM: the descriptor is not connected to a mount yet (the mount is still on its way)
            if (err.code === "EPERM" && !connected && Date.now() - began < 20_000) { setTimeout(next, 5); return; }
            if (--live === 0 || err.code === "ENODEV") end();
            return;
          }
          connected = true;
          if (n < IN_HEADER) return next();
          // the handler may wait for a download: it gets a copy, and the buffer goes back to reading
          const req = Buffer.from(buf.subarray(0, n));
          handle(req).catch((e: Error) => { opts.onError?.(`request failed: ${e.message}`); try { reply(req.readBigUInt64LE(8), EIO); } catch { /* unmounted */ } });
          next();
        });
      };
      next();
    };
    for (let i = 0; i < (opts.concurrency ?? 3); i++) loop();
  });
  return { done, stats };
}

/**
 * Mounts a FUSE file system at `mountpoint`. Returns the descriptor to serve it on at once,
 * and a promise for the mount itself.
 *
 * The two must overlap: mount(8) looks at the new file system before it returns, and those
 * looks are requests that somebody has to answer. So the caller starts serveImage() on the
 * descriptor first and waits for `mounted` afterwards; nothing in the serving process may wait
 * for a mount or an unmount of its own file system with a blocking call.
 *
 * The caller must be allowed to mount there (root, or root of the user namespace that owns
 * the mount namespace).
 */
export function mountFuse(mountpoint: string, name = "chainboot"): { fd: number; mounted: Promise<void> } {
  const fd = fs.openSync("/dev/fuse", "r+");
  const st = fs.statSync(mountpoint);
  // the descriptor is handed to mount(8) as its descriptor 3; "-i" keeps it from looking for a helper program
  const child = spawn("mount", ["-i", "-t", "fuse", "-o", `ro,nosuid,fd=3,rootmode=${(st.mode & 0o170000).toString(8)},user_id=0,group_id=0,allow_other,default_permissions`, name, mountpoint],
    { stdio: ["ignore", "pipe", "pipe", fd] });
  let output = "";
  child.stdout!.on("data", (d: Buffer) => { output += d.toString(); });
  child.stderr!.on("data", (d: Buffer) => { output += d.toString(); });
  const mounted = new Promise<void>((resolve, reject) => {
    child.on("error", (e) => reject(new Error(`could not mount the image at ${mountpoint}: ${e.message}`)));
    child.on("close", (status) => (status === 0 ? resolve() : reject(new Error(`could not mount the image at ${mountpoint}: ${output.trim() || `mount ended with status ${status}`}`))));
  });
  return { fd, mounted };
}
