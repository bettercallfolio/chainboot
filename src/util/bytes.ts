// Small byte helpers shared by every layer. No dependencies beyond node:crypto.
import { createHash } from "node:crypto";

export type Bytes = Uint8Array;

export function sha256(data: Bytes): Buffer {
  return createHash("sha256").update(data).digest();
}

export function toHex(b: Bytes): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
}

export function fromHex(s: string): Buffer {
  if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error("invalid hex string");
  return Buffer.from(s, "hex");
}

export function concat(parts: readonly Bytes[]): Buffer {
  return Buffer.concat(parts as Uint8Array[]);
}

export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Solana "compact-u16" (shortvec) length prefix. */
export function encodeShortU16(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`shortvec out of range: ${n}`);
  const out: number[] = [];
  for (;;) {
    const low = n & 0x7f;
    n >>= 7;
    if (n === 0) { out.push(low); return out; }
    out.push(low | 0x80);
  }
}

export function decodeShortU16(buf: Bytes, at: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = buf[at + i];
    if (byte === undefined) throw new Error("shortvec: truncated");
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  throw new Error("shortvec: too long");
}

export function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Human readable size, e.g. "34.9 MB". */
export function fmtBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n, i = -1;
  do { v /= 1000; i++; } while (v >= 1000 && i < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "?";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}
