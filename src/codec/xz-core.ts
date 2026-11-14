// A complete .xz decoder in plain TypeScript (LZMA2 + x86/ARM64 BCJ filters + integrity checks).
//
// xz gives the smallest files of the common compressors, which matters when every kilobyte
// is a transaction. Node has no built-in xz support, so chainboot carries its own decoder:
// no native add-ons, no dependencies, the same result on every platform.
//
// The decoder is "one shot": the whole compressed file goes in, the whole content comes out.
// This file uses nothing but typed arrays, so it runs unchanged in Node and in a browser.

const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1; crcTable[i] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (~c) >>> 0;
}

const FILTER_LZMA2 = 0x21n, FILTER_X86 = 0x04n, FILTER_ARM64 = 0x0an;

class XzError extends Error {
  constructor(message: string) { super(`xz: ${message}`); this.name = "XzError"; }
}

// ---------------------------------------------------------------- container

function vli(buf: Uint8Array, at: number, end: number): { value: bigint; next: number } {
  let value = 0n;
  for (let i = 0; i < 9; i++) {
    if (at + i >= end) throw new XzError("truncated number");
    const b = buf[at + i]!;
    value |= BigInt(b & 0x7f) << BigInt(7 * i);
    if ((b & 0x80) === 0) {
      if (b === 0 && i > 0) throw new XzError("malformed number");
      return { value, next: at + i + 1 };
    }
  }
  throw new XzError("malformed number");
}

const CHECK_SIZE = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

/** Uncompressed size of an .xz file, read from its index without decoding anything. */
export function xzUncompressedSize(input: Uint8Array): number {
  return parseIndex(input).total;
}

function parseIndex(input: Uint8Array): { total: number; indexStart: number; checkType: number } {
  const buf = input;
  if (buf.length < 32 || u32be(buf, 0) !== 0xfd377a58 || buf[4] !== 0x5a || buf[5] !== 0x00) throw new XzError("not an xz file");
  if (buf[6] !== 0 || buf[7]! > 15) throw new XzError("unsupported stream flags");
  if (crc32(buf.subarray(6, 8)) !== u32le(buf, 8)) throw new XzError("corrupt stream header");
  const end = buf.length;
  if (buf[end - 2] !== 0x59 || buf[end - 1] !== 0x5a) throw new XzError("truncated file or unsupported trailing data");
  if (crc32(buf.subarray(end - 8, end - 2)) !== u32le(buf, end - 12)) throw new XzError("corrupt stream footer");
  if (buf[end - 4] !== buf[6] || buf[end - 3] !== buf[7]) throw new XzError("stream header and footer disagree");
  const indexSize = (u32le(buf, end - 8) + 1) * 4;
  const indexStart = end - 12 - indexSize;
  if (indexStart < 12 || buf[indexStart] !== 0) throw new XzError("corrupt index");
  if (crc32(buf.subarray(indexStart, end - 16)) !== u32le(buf, end - 16)) throw new XzError("corrupt index");
  let at = indexStart + 1;
  const count = vli(buf, at, end - 16); at = count.next;
  let total = 0n;
  for (let i = 0n; i < count.value; i++) {
    const unpadded = vli(buf, at, end - 16); at = unpadded.next;
    const size = vli(buf, at, end - 16); at = size.next;
    total += size.value;
  }
  if (total > 0xffff_ffffn) throw new XzError("content larger than 4 GiB is not supported");
  return { total: Number(total), indexStart, checkType: buf[7]! };
}

/**
 * Decodes a whole .xz file and verifies its integrity check. `sha256` is needed only for files
 * whose check is SHA-256 (xz -C sha256); without it that check is skipped.
 */
export function xzDecodeBytes(input: Uint8Array, sha256?: (data: Uint8Array) => Uint8Array): Uint8Array {
  const buf = input;
  const { total, indexStart, checkType } = parseIndex(buf);
  const out = new Uint8Array(total);
  let at = 12, outPos = 0;
  while (at < indexStart) {
    // ---- block header
    const headerSize = (buf[at]! + 1) * 4;
    if (buf[at] === 0 || at + headerSize > indexStart) throw new XzError("corrupt block header");
    if (crc32(buf.subarray(at, at + headerSize - 4)) !== u32le(buf, at + headerSize - 4)) throw new XzError("corrupt block header");
    const flags = buf[at + 1]!;
    if (flags & 0x3c) throw new XzError("unsupported block flags");
    let p = at + 2;
    const hEnd = at + headerSize - 4;
    if (flags & 0x40) p = vli(buf, p, hEnd).next;
    let declared = -1;
    if (flags & 0x80) { const v = vli(buf, p, hEnd); p = v.next; declared = Number(v.value); }
    const filters: { id: bigint; props: Uint8Array }[] = [];
    for (let i = 0; i <= (flags & 3); i++) {
      const id = vli(buf, p, hEnd); p = id.next;
      const n = vli(buf, p, hEnd); p = n.next;
      const len = Number(n.value);
      if (p + len > hEnd) throw new XzError("corrupt filter list");
      filters.push({ id: id.value, props: buf.subarray(p, p + len) }); p += len;
    }
    for (; p < hEnd; p++) if (buf[p] !== 0) throw new XzError("corrupt block header padding");
    const last = filters.at(-1)!;
    if (last.id !== FILTER_LZMA2 || last.props.length !== 1) throw new XzError("the last filter must be LZMA2");
    for (const f of filters.slice(0, -1)) {
      if (f.id !== FILTER_X86 && f.id !== FILTER_ARM64) throw new XzError(`unsupported filter 0x${f.id.toString(16)}`);
      if (f.props.length !== 0) throw new XzError("filters with a start offset are not supported");
    }
    const dictBits = last.props[0]!;
    if (dictBits > 40) throw new XzError("unsupported dictionary size");
    const dictSize = dictBits === 40 ? 0xffffffff : (2 | (dictBits & 1)) * 2 ** ((dictBits >> 1) + 11);

    // ---- block data
    const start = at + headerSize, blockOut = outPos;
    const dec = new Lzma2(buf, start, indexStart, out, outPos, dictSize);
    dec.run();
    outPos = dec.outPos;
    if (declared >= 0 && outPos - blockOut !== declared) throw new XzError("block size does not match its header");
    const block = out.subarray(blockOut, outPos);
    // filters are applied by the encoder first to last, so undo them last to first
    for (let i = filters.length - 2; i >= 0; i--) {
      if (filters[i]!.id === FILTER_X86) bcjX86(block); else bcjArm64(block);
    }
    at = dec.inPos;
    while ((at - start) & 3) { if (buf[at] !== 0) throw new XzError("corrupt block padding"); at++; }
    const checkSize = CHECK_SIZE[checkType]!;
    if (at + checkSize > indexStart) throw new XzError("truncated block");
    const check = buf.subarray(at, at + checkSize);
    if (checkType === 1) { if (crc32(block) !== u32le(check, 0)) throw new XzError("data failed its CRC32 check"); }
    else if (checkType === 4) { const [lo, hi] = crc64(block); if (lo !== u32le(check, 0) || hi !== u32le(check, 4)) throw new XzError("data failed its CRC64 check"); }
    else if (checkType === 10 && sha256) { const d = sha256(block); if (d.length !== 32 || d.some((b, i) => b !== check[i])) throw new XzError("data failed its SHA-256 check"); }
    at += checkSize;
  }
  if (at !== indexStart || outPos !== total) throw new XzError("content does not match the index");
  return out;
}

// ---------------------------------------------------------------- CRC64 (ECMA-182), as two 32-bit halves

let crcLo: Uint32Array | null = null, crcHi: Uint32Array | null = null;
function crc64(data: Uint8Array): [number, number] {
  if (!crcLo || !crcHi) {
    crcLo = new Uint32Array(256); crcHi = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let lo = i, hi = 0;
      for (let k = 0; k < 8; k++) {
        const bit = lo & 1;
        lo = ((lo >>> 1) | (hi << 31)) >>> 0; hi >>>= 1;
        if (bit) { lo = (lo ^ 0xd7870f42) >>> 0; hi = (hi ^ 0xc96c5795) >>> 0; }
      }
      crcLo[i] = lo; crcHi[i] = hi;
    }
  }
  let lo = 0xffffffff, hi = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    const idx = (lo ^ data[i]!) & 0xff;
    lo = (crcLo[idx]! ^ ((lo >>> 8) | (hi << 24))) >>> 0;
    hi = (crcHi[idx]! ^ (hi >>> 8)) >>> 0;
  }
  return [(~lo) >>> 0, (~hi) >>> 0];
}

// ---------------------------------------------------------------- BCJ filters (decoding direction)

function bcjX86(buf: Uint8Array): void {
  const ALLOWED = [true, true, true, false, true, false, false, false];
  const BIT_NUM = [0, 1, 2, 2, 3, 3, 3, 3];
  if (buf.length <= 4) return;
  const size = buf.length - 4;
  let prevPos = -1, prevMask = 0;
  const msbyte = (b: number) => b === 0x00 || b === 0xff;
  for (let i = 0; i < size; i++) {
    if ((buf[i]! & 0xfe) !== 0xe8) continue;
    const gap = i - prevPos;
    if (gap > 3) {
      prevMask = 0;
    } else {
      prevMask = (prevMask << (gap - 1)) & 7;
      if (prevMask !== 0) {
        const b = buf[i + 4 - BIT_NUM[prevMask]!]!;
        if (!ALLOWED[prevMask] || msbyte(b)) { prevPos = i; prevMask = ((prevMask << 1) | 1) & 0xff; continue; }
      }
    }
    prevPos = i;
    if (msbyte(buf[i + 4]!)) {
      let src = (buf[i + 1]! | (buf[i + 2]! << 8) | (buf[i + 3]! << 16) | (buf[i + 4]! << 24)) >>> 0;
      let dest: number;
      for (;;) {
        dest = (src - (i + 5)) >>> 0;
        if (prevMask === 0) break;
        const j = BIT_NUM[prevMask]! * 8;
        const b = (dest >>> (24 - j)) & 0xff;
        if (!msbyte(b)) break;
        src = (dest ^ ((2 ** (32 - j)) - 1)) >>> 0;
      }
      dest &= 0x01ffffff;
      dest = (dest | (0 - (dest & 0x01000000))) >>> 0;
      buf[i + 1] = dest & 0xff; buf[i + 2] = (dest >>> 8) & 0xff; buf[i + 3] = (dest >>> 16) & 0xff; buf[i + 4] = dest >>> 24;
      i += 4;
    } else {
      prevMask = ((prevMask << 1) | 1) & 0xff;
    }
  }
}

function bcjArm64(buf: Uint8Array): void {
  for (let i = 0; i + 4 <= buf.length; i += 4) {
    let instr = (buf[i]! | (buf[i + 1]! << 8) | (buf[i + 2]! << 16) | (buf[i + 3]! << 24)) >>> 0;
    if ((instr & 0xfc000000) >>> 0 === 0x94000000) {
      const addr = (instr - (i >>> 2)) >>> 0;
      instr = (0x94000000 | (addr & 0x03ffffff)) >>> 0;
    } else if ((instr & 0x9f000000) >>> 0 === 0x90000000) {
      let addr = ((instr >>> 29) & 3) | ((instr >>> 3) & 0x1ffffc);
      if ((addr + 0x020000) & 0x1c0000) continue;
      addr = (addr - (i >>> 12)) >>> 0;
      instr = (instr & 0x9000001f) >>> 0;
      instr = (instr | ((addr & 3) << 29)) >>> 0;
      instr = (instr | ((addr & 0x03fffc) << 3)) >>> 0;
      instr = (instr | ((0 - (addr & 0x020000)) & 0xe00000)) >>> 0;
    } else continue;
    buf[i] = instr & 0xff; buf[i + 1] = (instr >>> 8) & 0xff; buf[i + 2] = (instr >>> 16) & 0xff; buf[i + 3] = instr >>> 24;
  }
}

// ---------------------------------------------------------------- LZMA2

const IS_MATCH = 0, IS_REP = 192, IS_REP_G0 = 204, IS_REP_G1 = 216, IS_REP_G2 = 228, IS_REP0_LONG = 240;
const POS_SLOT = 432, SPEC_POS = 688, ALIGN = 803, LEN = 819, REP_LEN = 1333, LIT = 1847;

class Lzma2 {
  readonly #in: Uint8Array;
  readonly #inEnd: number;
  readonly #out: Uint8Array;
  readonly #dictSize: number;
  readonly #probs = new Uint16Array(LIT + (0x300 << 4));
  inPos: number;
  outPos: number;
  #dictStart: number; // output position of the last dictionary reset
  #range = 0;
  #code = 0;
  #state = 0;
  #rep0 = 0; #rep1 = 0; #rep2 = 0; #rep3 = 0;
  #lc = 0; #lpMask = 0; #pbMask = 0;

  constructor(input: Uint8Array, inPos: number, inEnd: number, out: Uint8Array, outPos: number, dictSize: number) {
    this.#in = input; this.inPos = inPos; this.#inEnd = inEnd;
    this.#out = out; this.outPos = outPos; this.#dictStart = outPos; this.#dictSize = dictSize;
  }

  run(): void {
    const inp = this.#in;
    let needDictReset = true, needProps = true;
    for (;;) {
      if (this.inPos >= this.#inEnd) throw new XzError("truncated data");
      const control = inp[this.inPos++]!;
      if (control === 0) return;
      if (control >= 0xe0 || control === 1) { needProps = true; needDictReset = false; this.#dictStart = this.outPos; }
      else if (needDictReset) throw new XzError("corrupt data (missing dictionary reset)");
      if (control < 0x80) {
        if (control > 2) throw new XzError("corrupt data (bad chunk type)");
        if (this.inPos + 2 > this.#inEnd) throw new XzError("truncated data");
        const size = ((inp[this.inPos]! << 8) | inp[this.inPos + 1]!) + 1;
        this.inPos += 2;
        if (this.inPos + size > this.#inEnd || this.outPos + size > this.#out.length) throw new XzError("corrupt data (chunk too large)");
        this.#out.set(inp.subarray(this.inPos, this.inPos + size), this.outPos);
        this.inPos += size; this.outPos += size;
        continue;
      }
      if (this.inPos + 4 > this.#inEnd) throw new XzError("truncated data");
      const unpacked = (((control & 0x1f) << 16) | (inp[this.inPos]! << 8) | inp[this.inPos + 1]!) + 1;
      const packed = ((inp[this.inPos + 2]! << 8) | inp[this.inPos + 3]!) + 1;
      this.inPos += 4;
      if (control >= 0xc0) {
        if (this.inPos >= this.#inEnd) throw new XzError("truncated data");
        let d = inp[this.inPos++]!;
        if (d > 4 * 5 * 9 + 8) throw new XzError("corrupt data (bad properties)");
        const pb = Math.floor(d / 45); d -= pb * 45;
        const lp = Math.floor(d / 9), lc = d - lp * 9;
        if (lc + lp > 4) throw new XzError("corrupt data (bad properties)");
        this.#lc = lc; this.#lpMask = (1 << lp) - 1; this.#pbMask = (1 << pb) - 1;
        needProps = false;
      } else if (needProps) throw new XzError("corrupt data (missing properties)");
      if (control >= 0xa0) {
        this.#probs.fill(1024);
        this.#state = 0; this.#rep0 = this.#rep1 = this.#rep2 = this.#rep3 = 0;
      }
      if (packed < 5 || this.inPos + packed > this.#inEnd || this.outPos + unpacked > this.#out.length) throw new XzError("corrupt data (chunk too large)");
      this.#lzma(this.inPos + packed, this.outPos + unpacked);
    }
  }

  // Decodes one LZMA chunk. Kept as a single function with local variables: this loop is the hot path.
  #lzma(inEnd: number, outEnd: number): void {
    const inp = this.#in, out = this.#out, probs = this.#probs;
    const lc = this.#lc, lpMask = this.#lpMask, pbMask = this.#pbMask;
    const dictStart = this.#dictStart, dictSize = this.#dictSize;
    let inPos = this.inPos, pos = this.outPos;
    let state = this.#state, rep0 = this.#rep0, rep1 = this.#rep1, rep2 = this.#rep2, rep3 = this.#rep3;
    if (inp[inPos] !== 0) throw new XzError("corrupt data (range coder)");
    let code = ((inp[inPos + 1]! << 24) | (inp[inPos + 2]! << 16) | (inp[inPos + 3]! << 8) | inp[inPos + 4]!) >>> 0;
    let range = 0xffffffff;
    inPos += 5;

    // bit(i): decodes one bit with the adaptive probability at probs[i]
    const bit = (i: number): number => {
      if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | inp[inPos++]!) >>> 0; }
      const p = probs[i]!;
      const bound = (range >>> 11) * p;
      if (code < bound) { range = bound; probs[i] = p + ((2048 - p) >>> 5); return 0; }
      range = (range - bound) >>> 0; code = (code - bound) >>> 0; probs[i] = p - (p >>> 5);
      return 1;
    };
    const tree = (base: number, bits: number): number => {
      let m = 1;
      for (let i = 0; i < bits; i++) m = (m << 1) | bit(base + m);
      return m - (1 << bits);
    };
    const reverse = (base: number, bits: number): number => {
      let m = 1, sym = 0;
      for (let i = 0; i < bits; i++) { const b = bit(base + m); m = (m << 1) | b; sym |= b << i; }
      return sym;
    };
    const length = (base: number, posState: number): number => {
      if (bit(base) === 0) return tree(base + 2 + (posState << 3), 3);
      if (bit(base + 1) === 0) return 8 + tree(base + 130 + (posState << 3), 3);
      return 16 + tree(base + 258, 8);
    };

    while (pos < outEnd) {
      if (inPos > inEnd) throw new XzError("corrupt data (chunk overrun)");
      const posState = (pos - dictStart) & pbMask;
      if (bit(IS_MATCH + (state << 4) + posState) === 0) {
        const prev = pos > dictStart ? out[pos - 1]! : 0;
        const base = LIT + 0x300 * ((((pos - dictStart) & lpMask) << lc) + (prev >>> (8 - lc)));
        let symbol = 1;
        if (state >= 7) {
          let matchByte = out[pos - rep0 - 1]!;
          do {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte = (matchByte << 1) & 0xff;
            const b = bit(base + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | b;
            if (matchBit !== b) break;
          } while (symbol < 0x100);
        }
        while (symbol < 0x100) symbol = (symbol << 1) | bit(base + symbol);
        out[pos++] = symbol & 0xff;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len: number;
      if (bit(IS_REP + state) !== 0) {
        if (pos === dictStart) throw new XzError("corrupt data (repeat without history)");
        if (bit(IS_REP_G0 + state) === 0) {
          if (bit(IS_REP0_LONG + (state << 4) + posState) === 0) {
            state = state < 7 ? 9 : 11;
            out[pos] = out[pos - rep0 - 1]!; pos++;
            continue;
          }
        } else {
          let dist: number;
          if (bit(IS_REP_G1 + state) === 0) dist = rep1;
          else {
            if (bit(IS_REP_G2 + state) === 0) dist = rep2;
            else { dist = rep3; rep3 = rep2; }
            rep2 = rep1;
          }
          rep1 = rep0; rep0 = dist;
        }
        len = length(REP_LEN, posState);
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2; rep2 = rep1; rep1 = rep0;
        len = length(LEN, posState);
        state = state < 7 ? 7 : 10;
        const slot = tree(POS_SLOT + ((len < 4 ? len : 3) << 6), 6);
        if (slot < 4) rep0 = slot;
        else {
          const direct = (slot >>> 1) - 1;
          rep0 = ((2 | (slot & 1)) << direct) >>> 0;
          if (slot < 14) rep0 += reverse(SPEC_POS + rep0 - slot, direct);
          else {
            let n = direct - 4, d = 0;
            while (n-- > 0) {
              if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | inp[inPos++]!) >>> 0; }
              range >>>= 1;
              if (code >= range) { code = (code - range) >>> 0; d = (d << 1) | 1; } else d <<= 1;
            }
            rep0 = (rep0 + ((d << 4) >>> 0) + reverse(ALIGN, 4)) >>> 0;
          }
        }
        if (rep0 === 0xffffffff) throw new XzError("corrupt data (unexpected end marker)");
      }
      len += 2;
      if (rep0 >= pos - dictStart || rep0 >= dictSize) throw new XzError("corrupt data (distance beyond history)");
      if (pos + len > outEnd) throw new XzError("corrupt data (match crosses chunk end)");
      const from = pos - rep0 - 1;
      if (rep0 + 1 >= len) { out.copyWithin(pos, from, from + len); pos += len; }
      else { for (let i = 0; i < len; i++) out[pos + i] = out[from + i]!; pos += len; }
    }
    if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | inp[inPos++]!) >>> 0; }
    if (inPos !== inEnd || code !== 0) throw new XzError("corrupt data (chunk size mismatch)");
    this.inPos = inPos; this.outPos = pos;
    this.#state = state; this.#rep0 = rep0; this.#rep1 = rep1; this.#rep2 = rep2; this.#rep3 = rep3;
  }
}
