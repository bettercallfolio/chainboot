// Reading and writing tar archives (ustar, pax and GNU long names), enough for any root filesystem.
import zlib from "node:zlib";
import { xzDecode } from "../codec/xz.ts";

export type EntryType = "f" | "d" | "l" | "h" | "c" | "b" | "p";

/** One file system object. Paths are relative, use "/" and never start with "./". */
export interface Entry {
  path: string;
  type: EntryType;
  mode: number;
  uid: number;
  gid: number;
  /** Modification time in whole seconds since 1970. */
  mtime: number;
  /** Symlink target, or the path of the file a hard link points to. */
  link?: string;
  /** Device numbers for "c" and "b". */
  major?: number;
  minor?: number;
  /** Extended attributes (name -> raw value). */
  xattrs?: Record<string, Buffer>;
  /** Content of a regular file. */
  data?: Buffer;
}

/** Undoes gzip / xz / zstd around a tar file, detected from the first bytes. */
export function decompressAuto(buf: Buffer): Buffer {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf, { maxOutputLength: 0xffff_ffff });
  if (buf.length >= 6 && buf.readUInt32BE(0) === 0xfd377a58) return xzDecode(buf);
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xfd2fb528) return zlib.zstdDecompressSync(buf, { maxOutputLength: 0xffff_ffff });
  return buf;
}

/** Normalises an archive path: no leading "./" or "/", no trailing "/", rejects ".." segments. */
export function cleanPath(p: string): string {
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) throw new Error(`unsafe path in archive: ${p}`);
  return parts.join("/");
}

function num(field: Buffer): number {
  if (field[0]! & 0x80) { // GNU base-256
    let v = 0;
    for (let i = 1; i < field.length; i++) v = v * 256 + field[i]!;
    return v;
  }
  const s = field.toString("latin1").replace(/\0.*$/s, "").trim();
  return s ? parseInt(s, 8) : 0;
}

function utf8(bytes: Buffer): string {
  const s = bytes.toString("utf8");
  // chainboot manifests are JSON, so names must be valid UTF-8 (true for every mainstream distribution)
  if (Buffer.byteLength(s) !== bytes.length || s.includes("\ufffd") && !bytes.includes(Buffer.from("\ufffd"))) {
    throw new Error(`file name is not valid UTF-8: ${JSON.stringify(s)}`);
  }
  return s;
}

function str(field: Buffer): string {
  const end = field.indexOf(0);
  return utf8(field.subarray(0, end < 0 ? field.length : end));
}

function parsePax(data: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    if (sp < 0) break;
    const len = parseInt(data.subarray(at, sp).toString("latin1"), 10);
    if (!Number.isFinite(len) || len <= 0 || at + len > data.length) throw new Error("corrupt pax header");
    const rec = data.subarray(sp + 1, at + len - 1); // without the trailing newline
    const eq = rec.indexOf(0x3d);
    if (eq > 0) out.set(rec.subarray(0, eq).toString("utf8"), rec.subarray(eq + 1));
    at += len;
  }
  return out;
}

/** Parses an uncompressed tar archive. File contents are views into `tar`, nothing is copied. */
export function readTar(tar: Buffer): Entry[] {
  const entries: Entry[] = [];
  let at = 0, pax: Map<string, Buffer> | null = null, longName: string | null = null, longLink: string | null = null;
  while (at + 512 <= tar.length) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== num(h.subarray(148, 156))) throw new Error(`corrupt tar header at byte ${at}`);
    let size = num(h.subarray(124, 136));
    const flag = String.fromCharCode(h[156]!);
    const body = at + 512;
    if (pax?.has("size")) size = parseInt(pax.get("size")!.toString("latin1"), 10);
    if (body + size > tar.length) throw new Error("truncated tar archive");
    const next = body + Math.ceil(size / 512) * 512;
    if (flag === "x") { pax = parsePax(tar.subarray(body, body + size)); at = next; continue; }
    if (flag === "g") { at = next; continue; }
    if (flag === "L") { longName = str(tar.subarray(body, body + size)); at = next; continue; }
    if (flag === "K") { longLink = str(tar.subarray(body, body + size)); at = next; continue; }

    const prefix = h.subarray(257, 263).toString("latin1") === "ustar\0" ? str(h.subarray(345, 500)) : "";
    let name = longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    let link = longLink ?? str(h.subarray(157, 257));
    let uid = num(h.subarray(108, 116)), gid = num(h.subarray(116, 124)), mtime = num(h.subarray(136, 148));
    let xattrs: Record<string, Buffer> | undefined;
    if (pax) {
      for (const [k, v] of pax) {
        if (k === "path") name = utf8(v);
        else if (k === "linkpath") link = utf8(v);
        else if (k === "uid") uid = parseInt(v.toString("latin1"), 10);
        else if (k === "gid") gid = parseInt(v.toString("latin1"), 10);
        else if (k === "mtime") mtime = Math.floor(parseFloat(v.toString("latin1")));
        else if (k.startsWith("SCHILY.xattr.")) (xattrs ??= {})[k.slice(13)] = Buffer.from(v);
        else if (k.startsWith("LIBARCHIVE.xattr.")) (xattrs ??= {})[decodeURIComponent(k.slice(17))] = Buffer.from(v.toString("latin1"), "base64");
      }
    }
    pax = null; longName = null; longLink = null;
    at = next;

    const path = cleanPath(name);
    if (!path) continue; // the archive's own "./" entry
    const base = { path, mode: num(h.subarray(100, 108)) & 0o7777, uid, gid, mtime, ...(xattrs && { xattrs }) };
    switch (flag) {
      case "0": case "\0": case "7":
        entries.push({ ...base, type: "f", data: tar.subarray(body, body + size) }); break;
      case "1": entries.push({ ...base, type: "h", link: cleanPath(link) }); break;
      case "2": entries.push({ ...base, type: "l", link }); break;
      case "3": case "4":
        entries.push({ ...base, type: flag === "3" ? "c" : "b", major: num(h.subarray(329, 337)), minor: num(h.subarray(337, 345)) }); break;
      case "5": entries.push({ ...base, type: "d" }); break;
      case "6": entries.push({ ...base, type: "p" }); break;
      default: throw new Error(`unsupported tar entry type "${flag}" for ${path}`);
    }
  }
  return entries;
}

// ---------------------------------------------------------------- writing

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, e: Entry, size: number, flag: string, link: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(octal(e.mode & 0o7777, 8), 100, "latin1");
  h.write(octal(Math.min(e.uid, 0o7777777), 8), 108, "latin1");
  h.write(octal(Math.min(e.gid, 0o7777777), 8), 116, "latin1");
  h.write(octal(size, 12), 124, "latin1");
  h.write(octal(Math.max(0, e.mtime), 12), 136, "latin1");
  h.fill(0x20, 148, 156);
  h.write(flag, 156, "latin1");
  h.write(link, 157, 100, "utf8");
  h.write("ustar\0" + "00", 257, "latin1");
  if (e.type === "c" || e.type === "b") { h.write(octal(e.major ?? 0, 8), 329, "latin1"); h.write(octal(e.minor ?? 0, 8), 337, "latin1"); }
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return h;
}

function paxRecord(key: string, value: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(` ${key}=`, "utf8"), value, Buffer.from("\n")]);
  let len = body.length + String(body.length).length;
  if (String(len).length + body.length !== len) len = String(len).length + body.length; // length of the length changed
  return Buffer.concat([Buffer.from(String(len)), body]);
}

const FLAG: Record<EntryType, string> = { f: "0", h: "1", l: "2", c: "3", b: "4", d: "5", p: "6" };

/** Header blocks (pax records when needed, then the ustar header) for one entry whose content is `size` bytes. */
export function tarHead(e: Entry, size: number): Buffer[] {
  const out: Buffer[] = [];
  {
    const name = e.type === "d" ? `${e.path}/` : e.path;
    const link = e.link ?? "";
    const records: Buffer[] = [];
    if (Buffer.byteLength(name) > 100) records.push(paxRecord("path", Buffer.from(name)));
    if (Buffer.byteLength(link) > 100) records.push(paxRecord("linkpath", Buffer.from(link)));
    if (e.uid > 0o7777777) records.push(paxRecord("uid", Buffer.from(String(e.uid))));
    if (e.gid > 0o7777777) records.push(paxRecord("gid", Buffer.from(String(e.gid))));
    if (size > 0o77777777777) records.push(paxRecord("size", Buffer.from(String(size))));
    for (const [k, v] of Object.entries(e.xattrs ?? {})) records.push(paxRecord(`SCHILY.xattr.${k}`, v));
    if (records.length) {
      const body = Buffer.concat(records);
      out.push(header("PaxHeader", { ...e, type: "f", mode: 0o644 }, body.length, "x", ""), body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    const short = (s: string) => (Buffer.byteLength(s) > 100 ? Buffer.from(s).subarray(0, 100).toString("latin1") : s);
    out.push(header(short(name), e, Math.min(size, 0o77777777777), FLAG[e.type], short(link)));
  }
  return out;
}

/** Zero bytes that follow a file's content to fill its last 512-byte block. */
export function tarPadding(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

/** The two empty blocks that end an archive. */
export const TAR_END = Buffer.alloc(1024);

/** Serialises entries as a pax tar archive, returned as a list of chunks (to avoid one huge copy). */
export function writeTar(entries: Iterable<Entry>): Buffer[] {
  const out: Buffer[] = [];
  for (const e of entries) {
    const size = e.type === "f" ? e.data?.length ?? 0 : 0;
    out.push(...tarHead(e, size));
    if (size) out.push(e.data!, tarPadding(size));
  }
  out.push(TAR_END);
  return out;
}
