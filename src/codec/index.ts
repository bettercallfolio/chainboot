// Compression used for packs and manifests.
//
//   xz   - smallest output; made with the system `xz` tool when publishing, read with chainboot's own decoder
//   zstd - built into Node; used when `xz` is not installed on the publishing machine
//   raw  - stored as is (data that does not shrink)
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { xzDecode } from "./xz.ts";

export type Codec = "xz" | "zstd" | "raw";

let xzAvailable: boolean | null = null;
export function hasXzTool(): boolean {
  xzAvailable ??= spawnSync("xz", ["--version"], { stdio: "ignore" }).status === 0;
  return xzAvailable;
}

const MAX_DICT = 128 << 20;

/** Compresses as small as possible. `arch` enables the executable filter that suits the machine code inside. */
export function compress(data: Uint8Array, opts: { arch?: string; codec?: Codec } = {}): { codec: Codec; data: Buffer } {
  const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const want = opts.codec ?? (hasXzTool() ? "xz" : "zstd");
  let out: Buffer | null = null;
  if (want === "xz") {
    if (!hasXzTool()) throw new Error("the `xz` tool is not installed; install it or use the zstd codec");
    let dict = 1 << 16;
    while (dict < raw.length && dict < MAX_DICT) dict <<= 1;
    const filter = opts.arch === "amd64" || opts.arch === "i386" ? ["--x86"] : opts.arch === "arm64" ? ["--arm64"] : [];
    const r = spawnSync("xz", ["-T1", "-c", "--check=crc32", ...filter, `--lzma2=preset=9e,dict=${dict}`], { input: raw, maxBuffer: 0xffff_ffff });
    if (r.status !== 0) throw new Error(`xz failed: ${r.stderr?.toString().trim() || r.error?.message}`);
    out = r.stdout;
  } else if (want === "zstd") {
    const c = zlib.constants;
    out = zlib.zstdCompressSync(raw, { params: { [c.ZSTD_c_compressionLevel]: 22, [c.ZSTD_c_windowLog]: 27, [c.ZSTD_c_enableLongDistanceMatching]: 1 }, pledgedSrcSize: raw.length });
  }
  if (!out || out.length >= raw.length) return { codec: "raw", data: raw };
  return { codec: want, data: out };
}

/** Large packs decode several times faster with the system `xz` tool; the built-in decoder is the fallback. */
function xzFast(data: Uint8Array, rawSize: number): Buffer | null {
  if (data.length < (1 << 20) || !hasXzTool()) return null;
  const r = spawnSync("xz", ["-dc"], { input: data, maxBuffer: Math.max(rawSize, 1) + 1024 });
  return r.status === 0 && r.stdout.length === rawSize ? r.stdout : null;
}

export function decompress(codec: Codec, data: Uint8Array, rawSize: number): Buffer {
  let out: Buffer;
  if (codec === "raw") out = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (codec === "xz") out = xzFast(data, rawSize) ?? xzDecode(data);
  else if (codec === "zstd") out = zlib.zstdDecompressSync(data, { maxOutputLength: Math.max(rawSize, 1) });
  else throw new Error(`unknown codec "${codec as string}"`);
  if (out.length !== rawSize) throw new Error(`decompressed size is ${out.length}, expected ${rawSize}`);
  return out;
}
