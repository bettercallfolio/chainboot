// The chainboot reader for browsers.
//
// Finds, downloads and verifies what chainboot stored on chain, using nothing but what every
// current browser has: fetch, WebCrypto and typed arrays. No server of ours is involved: the
// page talks to the RPC endpoints the visitor names, and believes none of them.
//
//   publisher's address --> catalog pointer --> catalog --> manifest --> packs --> files
//        (given)          (signature checked)  (signed)    (SHA-256)   (SHA-256)  (SHA-256)
//
// It reads public images. Private images and saves need a wallet's key, and stay out of here.
// The same file runs in Node 22 (which has the same APIs); that is how it is tested.
import { xzDecodeBytes, xzUncompressedSize } from "../codec/xz-core.ts";

// ---------------------------------------------------------------- bytes

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) { carry += digits[j]! << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}

export function b58decode(text: string, length?: number): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    let carry = B58.indexOf(text[i]!);
    if (carry < 0) throw new Error(`"${text}" is not base58`);
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j]! * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  if (length !== undefined && out.length !== length) throw new Error(`"${text}" does not have ${length} bytes`);
  return out;
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const utf8 = new TextEncoder(), text = new TextDecoder("utf-8", { fatal: false });

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// (the names of these types differ between browser and Node typings; taking them from the functions fits both)
type Bytes = Parameters<typeof crypto.subtle.digest>[1];
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as Bytes));
}

const keys = new Map<string, Promise<Key>>();
/** True when `signature` is a valid Ed25519 signature of `message` by `publicKey`. */
export async function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const id = toHex(publicKey);
  let key = keys.get(id);
  if (!key) { key = crypto.subtle.importKey("raw", publicKey as Bytes, { name: "Ed25519" }, false, ["verify"]); keys.set(id, key); }
  try { return await crypto.subtle.verify({ name: "Ed25519" }, await key, signature as Bytes, message as Bytes); } catch { return false; }
}

/** True when this browser can check Ed25519 signatures (Chrome 137, Firefox 129, Safari 17 and later). */
export async function canVerify(): Promise<boolean> {
  try { await crypto.subtle.importKey("raw", new Uint8Array(32) as Bytes, { name: "Ed25519" }, false, ["verify"]); return true; } catch { return false; }
}

/** A 32-byte tag address derived from text: SHA-256("chainboot:v1" + (0x00 + part) for each part). */
export async function tagAddress(...parts: (string | Uint8Array)[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [utf8.encode("chainboot:v1")];
  for (const p of parts) chunks.push(Uint8Array.of(0), typeof p === "string" ? utf8.encode(p) : p);
  return sha256(concat(chunks));
}

// ---------------------------------------------------------------- transactions

const NOOP_PROGRAM = b58decode("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV", 32);
const MEMO_PROGRAM = b58decode("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", 32);
/** SPL Record: the program through which a publisher may keep a pointer in an account as well. */
const RECORD_PROGRAM = b58decode("recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5", 32);
const MAGIC = 0xcb, KIND_LEAF = 0x00, KIND_BRANCH = 0x01, KIND_HEAD = 0x02, KIND_INLINE = 0x03, KIND_POINTER = 0x10, FORMAT_VERSION = 1;
/** Pointers of version 2 carry a sequence number signed by their writer; version 1 (none) is still read. */
const POINTER_VERSION = 2, POINTER_HEAD = 3 + 8, POINTER_PAGES = 12, POINTER_PAGE = 1000;
/** Limits on what an object may claim before anything is set aside for it. */
const MAX_OBJECT = 1 << 30, MIN_LEAF = 64;
const SIG = 64, HEAD_FIXED = 2 + 1 + 1 + 2 + 8 + 32 + SIG;

interface Tx {
  /** First signature and the account that paid (and signed). */
  signature: Uint8Array; payer: Uint8Array;
  /** The exact bytes the signatures cover. */
  message: Uint8Array;
  /** Instruction data of the Noop call that carries chainboot data, if any. */
  data: Uint8Array | null;
  /** Every account the transaction names. */
  keys: Uint8Array[];
}

function shortU16(buf: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const b = buf[at + i];
    if (b === undefined) throw new Error("transaction truncated");
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [value, at + i + 1];
  }
  throw new Error("malformed length");
}

/** Parses a serialised transaction (legacy or v1 wire format) as far as a reader needs. */
function parseTx(raw: Uint8Array): Tx {
  const need = (end: number) => { if (end > raw.length) throw new Error("transaction truncated"); };
  // the data travels through the Noop program, or, on chains without it, as base64 text in a memo
  const payload = (program: Uint8Array | undefined, data: Uint8Array): Uint8Array | null => {
    if (!program) return null;
    if (equal(program, NOOP_PROGRAM)) return data.length >= 2 && data[0] === MAGIC ? data : null;
    if (!equal(program, MEMO_PROGRAM) || data.length < 4) return null;
    try {
      const raw = fromBase64(String.fromCharCode(...data.subarray(0, 4096)));
      return raw.length >= 2 && raw[0] === MAGIC ? raw : null;
    } catch { return null; }
  };
  let found: Uint8Array | null = null;
  if (raw[0] === 0x81) {
    // v1: [0x81][3 header bytes][config mask u32][blockhash 32][instructions u8][accounts u8][accounts][config values][instruction heads][payloads][signatures]
    need(42);
    const signers = raw[1]!, mask = (raw[4]! | (raw[5]! << 8) | (raw[6]! << 16) | (raw[7]! << 24)) >>> 0;
    const nIx = raw[40]!, nKeys = raw[41]!;
    let at = 42;
    need(at + 32 * nKeys);
    const key = (i: number) => (i < nKeys ? raw.subarray(42 + 32 * i, 74 + 32 * i) : undefined);
    at += 32 * nKeys;
    for (let m = mask; m; m >>>= 1) at += (m & 1) * 4;
    need(at + 4 * nIx);
    const heads: [number, number, number][] = [];
    for (let i = 0; i < nIx; i++) { heads.push([raw[at]!, raw[at + 1]!, raw[at + 2]! | (raw[at + 3]! << 8)]); at += 4; }
    for (const [program, nAcc, len] of heads) {
      need(at + nAcc + len);
      found ??= payload(key(program), raw.subarray(at + nAcc, at + nAcc + len));
      at += nAcc + len;
    }
    if (signers < 1 || raw.length !== at + SIG * signers || nKeys < 1) throw new Error("malformed v1 transaction");
    return { signature: raw.subarray(at, at + SIG), payer: key(0)!, message: raw.subarray(0, at), data: found, keys: Array.from({ length: nKeys }, (_, i) => key(i)!) };
  }
  let [nSig, at] = shortU16(raw, 0);
  need(at + SIG * nSig);
  if (nSig < 1) throw new Error("transaction without a signature");
  const signature = raw.subarray(at, at + SIG);
  at += SIG * nSig;
  const message = raw.subarray(at);
  if (raw[at]! & 0x80) throw new Error("v0 transactions do not carry chainboot data");
  at += 3;
  let nKeys: number;
  [nKeys, at] = shortU16(raw, at);
  const keysAt = at;
  need(at + 32 * nKeys + 32);
  const key = (i: number) => (i < nKeys ? raw.subarray(keysAt + 32 * i, keysAt + 32 * i + 32) : undefined);
  at += 32 * nKeys + 32;
  let nIx: number;
  [nIx, at] = shortU16(raw, at);
  for (let i = 0; i < nIx; i++) {
    need(at + 1);
    const program = raw[at++]!;
    let nAcc: number, len: number;
    [nAcc, at] = shortU16(raw, at);
    at += nAcc;
    [len, at] = shortU16(raw, at);
    need(at + len);
    found ??= payload(key(program), raw.subarray(at, at + len));
    at += len;
  }
  if (at !== raw.length || nKeys < 1) throw new Error("malformed transaction");
  return { signature, payer: key(0)!, message, data: found, keys: Array.from({ length: nKeys }, (_, i) => key(i)!) };
}

function decodeSlots(buf: Uint8Array): number[] {
  let at = 0;
  const read = () => {
    let n = 0, mul = 1;
    for (;;) {
      const b = buf[at++];
      if (b === undefined || mul > 2 ** 49) throw new Error("malformed slot hint");
      n += (b & 0x7f) * mul;
      if (!(b & 0x80)) return n;
      mul *= 0x80;
    }
  };
  const count = read();
  if (count > 1_000_000) throw new Error("malformed slot hint");
  const slots: number[] = [];
  let prev = 0;
  for (let i = 0; i < count; i++) { prev += read(); slots.push(prev); }
  return slots;
}

// ---------------------------------------------------------------- what is stored

export type Codec = "xz" | "zstd" | "raw";
export interface ObjectRef { sig: string; sha256?: string; size?: number }
export interface StoredRef { sig: string; sha256: string; size: number; codec: Codec; rawSize: number }
export interface ImageRef extends StoredRef { digest: string; version: string; created: number; downloadSize: number; unpackedSize: number; /** the account that stored the image, when it is not the catalog's owner */ publisher?: string }
export interface Catalog { chainboot: 1; kind: "catalog"; publisher: string; updated: number; images: Record<string, { description?: string; tags: Record<string, Record<string, ImageRef>> }> }
export interface PackInfo { sig: string; sha256: string; size: number; codec: Codec; rawSha256: string; rawSize: number; enc?: 0 | 1 }
/** [path, type, ...]: "d" directory, "f" file, "l" symbolic link, "h" hard link, "c"/"b" device, "p" pipe. */
export type TreeNode = [string, string, ...unknown[]];
export interface Manifest { chainboot: 1; name: string; version: string; arch: string; digest: string; rawSize: number; description?: string; created?: number; packs: PackInfo[]; tree: TreeNode[]; [more: string]: unknown }
export interface FileEntry { path: string; type: "d" | "f" | "l" | "h" | "c" | "b" | "p"; mode?: number; size?: number; target?: string; sha256?: string; pack?: number; offset?: number }
export interface Progress { done: number; total: number; bytes: number; size: number }

/** A pointer record: what its writer put there, and the sequence number they signed with it (0 for records written before there was one). */
export interface PointerRecord { payload: Uint8Array; signature: string; slot: number; blockTime: number | null; seq: bigint; account?: string }
interface Candidate { signature: string; slot: number; votes: number; mentions: number; order: number }

export class TrustError extends Error {
  constructor(message: string) { super(message); this.name = "TrustError"; }
}

function unpack(codec: Codec, data: Uint8Array, rawSize: number): Uint8Array {
  let out: Uint8Array;
  if (codec === "raw") out = data;
  else if (codec === "xz") {
    // what the file says about its own size is read first: a small file can claim gigabytes
    if (xzUncompressedSize(data) !== rawSize) throw new Error("an object does not have the size its reference states");
    out = xzDecodeBytes(data);
  }
  else throw new Error(`this object is compressed with "${codec}", which the browser reader does not decode (it reads xz)`);
  if (out.length !== rawSize) throw new Error("an object does not have the size its reference states");
  return out;
}

export interface ReaderOptions {
  /** RPC endpoints (URLs). Several make the reader faster and harder to mislead. */
  endpoints: string[];
  /** How many requests may be on their way at once, per endpoint (default 3: public endpoints answer "too many requests" quickly). */
  concurrency?: number;
  fetch?: typeof fetch;
  /** Called with a short line whenever something was checked, for showing what happens. */
  onStep?: (line: string) => void;
}

interface TxAnswer { slot: number; blockTime: number | null; transaction: [string, string]; meta: { err: unknown } | null }

export class Reader {
  readonly #endpoints: string[];
  readonly #fetch: typeof fetch;
  readonly #limit: number;
  readonly #say: (line: string) => void;
  #running = 0;
  #waiting: (() => void)[] = [];
  /** After a "too many requests" answer, nobody asks again before this time. */
  #quietUntil = 0;
  #next = 0;
  #id = 0;
  /** Requests sent so far, for display. */
  requests = 0;

  constructor(opts: ReaderOptions) {
    if (!opts.endpoints.length) throw new Error("name at least one RPC endpoint");
    this.#endpoints = opts.endpoints;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#limit = Math.max(1, (opts.concurrency ?? 3) * opts.endpoints.length);
    this.#say = opts.onStep ?? (() => {});
  }

  // ---- RPC: every endpoint in turn; an endpoint that is busy is given a pause, a wrong answer moves on to the next

  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#limit) await new Promise<void>((go) => this.#waiting.push(go));
    this.#running++;
    try { return await work(); } finally { this.#running--; this.#waiting.shift()?.(); }
  }

  /**
   * One JSON-RPC call. `accept` judges the answer; an endpoint whose answer is not accepted is
   * skipped and the next one is asked, so one endpoint that is behind or lies does not decide.
   */
  async rpc<T>(method: string, params: unknown[], accept: (result: T) => boolean | Promise<boolean> = () => true, signal?: AbortSignal): Promise<T> {
    return this.#slot(async () => {
      let problem = "no endpoint answered";
      const rounds = Math.max(8, this.#endpoints.length * 4);
      let pause = 400;
      for (let attempt = 0; attempt < rounds; attempt++) {
        if (signal?.aborted) throw new Error("stopped");
        const quiet = this.#quietUntil - Date.now();
        if (quiet > 0) await new Promise((r) => setTimeout(r, quiet));
        const url = this.#endpoints[this.#next++ % this.#endpoints.length]!;
        try {
          this.requests++;
          const res = await this.#fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params }), signal });
          if (res.status === 429 || res.status >= 500) {
            problem = `the endpoint is busy (HTTP ${res.status})`;
            const after = Number(res.headers.get("retry-after"));
            const wait = Math.min(8000, after > 0 ? after * 1000 : pause);
            // with a single endpoint everybody waits; with several, the others carry on
            if (this.#endpoints.length === 1) this.#quietUntil = Math.max(this.#quietUntil, Date.now() + wait);
            await new Promise((r) => setTimeout(r, wait));
            pause = Math.min(8000, pause * 1.7);
            continue;
          }
          if (!res.ok) { problem = `HTTP ${res.status}`; continue; }
          const body = await res.json() as { result?: T; error?: { message?: string; code?: number } };
          if (body.error) {
            problem = body.error.message ?? "the endpoint returned an error";
            if (body.error.code === 429 || /rate|limit|too many/i.test(problem)) { await new Promise((r) => setTimeout(r, pause)); pause = Math.min(8000, pause * 1.7); }
            continue;
          }
          if (await accept(body.result as T)) return body.result as T;
          problem = "the answer did not pass its checks";
        } catch (e) {
          if (signal?.aborted) throw new Error("stopped");
          problem = (e as Error).message;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      throw new Error(`${method} failed: ${problem}`);
    });
  }

  /** Fetches one transaction and checks that it is the one asked for, signed, and (when `signers` is given) paid by a trusted key. */
  async #tx(signature: Uint8Array, signers: Uint8Array[] | undefined, verify: boolean, signal?: AbortSignal): Promise<{ tx: Tx; slot: number; blockTime: number | null }> {
    let good: { tx: Tx; slot: number; blockTime: number | null } | null = null, untrusted: TrustError | null = null;
    const name = b58encode(signature);
    await this.rpc<TxAnswer | null>("getTransaction", [name, { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], async (answer) => {
      try {
        if (!answer || !Array.isArray(answer.transaction) || typeof answer.transaction[0] !== "string" || !answer.meta || answer.meta.err !== null) return false;
        const tx = parseTx(fromBase64(answer.transaction[0]));
        if (!equal(tx.signature, signature)) return false;
        if (verify && !(await verifyEd25519(tx.payer, tx.message, tx.signature))) return false;
        if (signers && !signers.some((s) => equal(s, tx.payer))) { untrusted = new TrustError(`transaction ${name} was not published by a trusted key (it was paid by ${b58encode(tx.payer)})`); return true; }
        good ??= { tx, slot: answer.slot, blockTime: answer.blockTime ?? null };
        return true;
      } catch { return false; }
    }, signal);
    if (untrusted) throw untrusted;
    return good!;
  }

  // ---- objects

  /** Downloads and verifies one stored object. With `signers`, only data published by those keys is accepted. */
  async object(ref: ObjectRef | string, opts: { signers?: Uint8Array[]; onProgress?: (p: Progress) => void; signal?: AbortSignal; blocks?: boolean } = {}): Promise<Uint8Array> {
    const sig = typeof ref === "string" ? ref : ref.sig;
    const want = typeof ref === "string" ? undefined : ref.sha256?.toLowerCase();
    const { tx } = await this.#tx(b58decode(sig, SIG), opts.signers, true, opts.signal);
    const head = tx.data;
    if (!head) throw new Error(`${sig} does not carry chainboot data`);
    if (head[2] !== FORMAT_VERSION) throw new Error(`object ${sig} uses format version ${head[2]}; this reader understands version ${FORMAT_VERSION}`);
    let out: Uint8Array;
    if (head[1] === KIND_INLINE) { out = head.slice(3); opts.onProgress?.({ done: 1, total: 1, bytes: out.length, size: out.length }); }
    else if (head[1] === KIND_HEAD) out = await this.#tree(sig, head, want, { ...opts, ...(typeof ref !== "string" && ref.size !== undefined && { size: ref.size }) });
    else throw new Error(`${sig} is not the head of an object`);
    if (want && toHex(await sha256(out)) !== want) throw new Error(`object ${sig} is not the expected content (its SHA-256 differs)`);
    if (typeof ref !== "string" && ref.size !== undefined && ref.size !== out.length) throw new Error(`object ${sig} has ${out.length} bytes, expected ${ref.size}`);
    return out;
  }

  async #tree(sig: string, head: Uint8Array, want: string | undefined, opts: { signers?: Uint8Array[]; onProgress?: (p: Progress) => void; signal?: AbortSignal; blocks?: boolean; size?: number }): Promise<Uint8Array> {
    if (head.length < HEAD_FIXED + SIG || (head.length - HEAD_FIXED) % SIG) throw new Error(`malformed head ${sig}`);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const depth = head[3]!, leafSize = view.getUint16(4, true), size = Number(view.getBigUint64(6, true));
    const digest = head.subarray(14, 46), hint = head.subarray(46, 46 + SIG);
    if (want && toHex(digest) !== want) throw new Error(`object ${sig} is not the expected content (its SHA-256 differs)`);
    if (depth < 1 || depth > 8 || leafSize < MIN_LEAF || size < 1) throw new Error(`malformed head ${sig}`);
    if (opts.size !== undefined ? size !== opts.size : size > MAX_OBJECT) throw new Error(`object ${sig} claims ${size} bytes, which is not what was expected`);
    const leafCount = Math.ceil(size / leafSize);
    const split = (b: Uint8Array) => { const r: Uint8Array[] = []; for (let at = 0; at < b.length; at += SIG) r.push(b.subarray(at, at + SIG)); return r; };
    const out = new Uint8Array(size);
    let done = 0, bytes = 0;
    const report = () => opts.onProgress?.({ done, total: leafCount, bytes, size });
    report();

    // block mode: the head may name a list of the blocks that hold the object's transactions.
    // One request then brings hundreds of them.
    const blocks = new Map<string, Tx>();
    if (opts.blocks !== false && hint.some((b) => b !== 0)) {
      try {
        const slots = decodeSlots(await this.object(b58encode(hint), { signers: opts.signers, signal: opts.signal, blocks: false }));
        if (slots.length && leafCount / slots.length >= 4) {
          let seen = 0, seenBytes = 0;
          await Promise.all(slots.map(async (slot) => {
            type Block = { transactions?: { transaction?: [string, string]; meta?: { err: unknown } | null }[] } | null;
            let block: Block;
            try { block = await this.rpc<Block>("getBlock", [slot, { encoding: "base64", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 1, commitment: "confirmed" }], (b) => !!b && Array.isArray(b.transactions), opts.signal); } catch { return; }
            for (const item of block?.transactions ?? []) {
              if (!item?.meta || item.meta.err !== null || typeof item.transaction?.[0] !== "string") continue;
              let tx: Tx;
              try { tx = parseTx(fromBase64(item.transaction[0])); } catch { continue; }
              if (!tx.data || (opts.signers && !opts.signers.some((s) => equal(s, tx.payer)))) continue;
              blocks.set(toHex(tx.signature), tx);
              if (tx.data[1] === KIND_LEAF) { seen++; seenBytes += tx.data.length - 2; if (seen % 32 === 0) opts.onProgress?.({ done: Math.min(leafCount, seen), total: leafCount, bytes: Math.min(size, seenBytes), size }); }
            }
          }));
        }
      } catch (e) {
        if (e instanceof TrustError) throw e;
        // a hint that cannot be used only costs speed
      }
    }

    const node = async (s: Uint8Array, kind: number, verify: boolean): Promise<{ data: Uint8Array; tx: Tx }> => {
      let tx = blocks.get(toHex(s));
      if (tx && verify && !(await verifyEd25519(tx.payer, tx.message, tx.signature))) tx = undefined;
      tx ??= (await this.#tx(s, opts.signers, verify, opts.signal)).tx;
      if (!tx.data) throw new Error(`transaction ${b58encode(s)} does not carry chainboot data`);
      if (tx.data[1] !== kind) throw new Error(`unexpected node in object ${sig}`);
      return { data: tx.data.subarray(2), tx };
    };

    // branches decide which leaves belong to the object: their signatures are always checked
    let level = split(head.subarray(HEAD_FIXED));
    for (let d = depth; d > 1; d--) {
      const nodes = await Promise.all(level.map((s) => node(s, KIND_BRANCH, true)));
      level = [];
      for (const n of nodes) {
        if (!n.data.length || n.data.length % SIG) throw new Error(`malformed branch in object ${sig}`);
        level.push(...split(n.data));
      }
    }
    if (level.length !== leafCount) throw new Error(`object ${sig} is inconsistent`);

    // leaves are taken as they come; the object's SHA-256 judges them all at once
    const leafTx: (Tx | undefined)[] = new Array(leafCount);
    const have = new Uint8Array(leafCount);
    const fetchLeaves = async (indexes: number[], verify: boolean) => {
      await Promise.all(indexes.map(async (i) => {
        const n = await node(level[i]!, KIND_LEAF, verify);
        const from = i * leafSize, len = Math.min(leafSize, size - from);
        if (n.data.length !== len) throw new Error(`a part of object ${sig} has the wrong size`);
        out.set(n.data, from);
        leafTx[i] = n.tx;
        if (!have[i]) { have[i] = 1; done++; bytes += len; }
        if (done % 64 === 0 || done === leafCount) report();
      }));
    };
    await fetchLeaves(Array.from({ length: leafCount }, (_, i) => i), false);
    report();
    if (!equal(await sha256(out), digest)) {
      // something lied. Signatures tell which parts; those are fetched again with full checking.
      const bad: number[] = [];
      for (let i = 0; i < leafCount; i++) { const t = leafTx[i]; if (!t || !(await verifyEd25519(t.payer, t.message, t.signature))) bad.push(i); }
      for (const i of bad) blocks.delete(toHex(level[i]!));
      if (bad.length) await fetchLeaves(bad, true);
      if (!equal(await sha256(out), digest)) throw new Error(`object ${sig} failed verification: the downloaded bytes do not match its SHA-256`);
    }
    return out;
  }

  // ---- pointers

  /**
   * The pointer of `owner` under `tag` as kept in an account, if the owner keeps one: read with
   * one request per endpoint and accepted only with the owner's signature inside it. Null when
   * there is no account, no valid record, or the record says to look in the transactions.
   */
  async #accountPointer(tag: Uint8Array, owner: Uint8Array, signal?: AbortSignal): Promise<{ payload: Uint8Array; seq: bigint; address: string; agreed: boolean } | null> {
    const seed = utf8.encode(`cb${toHex(tag.subarray(0, 15))}`);
    const address = b58encode(await sha256(concat([owner, seed, RECORD_PROGRAM])));
    type Info = { value: { owner: string; data: [string, string] } | null };
    const answers = await this.#each<Info>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }], 2, (a) => !!a && typeof a === "object" && "value" in a, signal);
    let best: { payload: Uint8Array | null; seq: bigint } | null = null, shown = 0;
    for (const a of answers) {
      const v = a?.value;
      if (!v || v.owner !== b58encode(RECORD_PROGRAM) || !Array.isArray(v.data) || typeof v.data[0] !== "string") continue;
      shown++;
      const d = fromBase64(v.data[0]).subarray(33);
      if (d.length < 78 || d[0] !== MAGIC || d[1] !== 0x11 || d[2] !== 1) continue;
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const flags = d[3]!, seq = view.getBigUint64(4, true), len = view.getUint16(12, true);
      if (len > 400 || d.length < 78 + len) continue;
      const payload = d.subarray(14, 14 + len);
      const signed = concat([utf8.encode("chainboot:account-record:v1"), tag, Uint8Array.of(flags), d.subarray(4, 12), payload]);
      if (!(await verifyEd25519(owner, signed, d.subarray(14 + len, 78 + len)))) continue;
      if (!best || seq > best.seq) best = { payload: flags & 1 ? null : payload.slice(), seq };
    }
    // `agreed`: every endpoint that answered showed the account (none said "there is none")
    return best?.payload ? { payload: best.payload, seq: best.seq, address, agreed: shown === answers.length } : null;
  }

  /**
   * Asks each of the first `count` endpoints the same question, once, and returns the answers
   * that arrived and passed `ok`. For questions where one endpoint could be behind or lie.
   */
  async #each<T>(method: string, params: unknown[], count: number, ok: (result: unknown) => boolean, signal?: AbortSignal): Promise<T[]> {
    const one = async (url: string): Promise<T | undefined> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw new Error("stopped");
        try {
          this.requests++;
          const res = await this.#fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params }), signal });
          if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); continue; }
          if (!res.ok) return undefined;
          const body = await res.json() as { result?: unknown; error?: { message?: string; code?: number } };
          if (body.error) {
            if (body.error.code === 429 || /rate|limit|too many/i.test(body.error.message ?? "")) { await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); continue; }
            return undefined;
          }
          return ok(body.result) ? body.result as T : undefined;
        } catch { if (signal?.aborted) throw new Error("stopped"); }
      }
      return undefined;
    };
    const answers = await Promise.all(this.#endpoints.slice(0, Math.max(1, count)).map((url) => this.#slot(() => one(url))));
    return answers.filter((a): a is Awaited<T> => a !== undefined) as T[];
  }

  /**
   * The newest pointer record under `tag` that was published by one of `signers`, or null when
   * there is none. Several endpoints are asked and their lists merged; every candidate is
   * verified by signature and must name the tag; between candidates, the sequence number their
   * writer signed decides. (The same rules as chainboot's own reader: see docs/07-format.md.)
   */
  async pointer(tag: Uint8Array, signers: Uint8Array[], opts: { limit?: number; signal?: AbortSignal; accounts?: boolean } = {}): Promise<PointerRecord | null> {
    let inAccount: PointerRecord | null = null;
    if (opts.accounts !== false && signers.length === 1) {
      const a = await this.#accountPointer(tag, signers[0]!, opts.signal).catch(() => null);
      if (a) {
        inAccount = { payload: a.payload, signature: "", slot: 0, blockTime: Number(a.seq / 1000n), seq: a.seq, account: a.address };
        if (a.agreed) return inAccount;
      }
    }
    const inTransactions = await this.#newest(tag, signers, opts);
    if (inAccount && (!inTransactions || inAccount.seq > inTransactions.seq)) return inAccount;
    return inTransactions;
  }

  /** One page of the history of `tag`, merged from up to three endpoints: candidates for pointer records, newest first. */
  async #page(tag: Uint8Array, limit: number, before: string | undefined, signal?: AbortSignal): Promise<{ candidates: Candidate[]; lists: number; next: string | undefined }> {
    type Listed = { signature: string; err: unknown; slot?: number };
    const params = [b58encode(tag), { limit, commitment: "confirmed", ...(before && { before }) }];
    let lists = await this.#each<Listed[]>("getSignaturesForAddress", params, 3, Array.isArray, signal);
    // nobody answered at once: the patient path, which goes round the endpoints until one does
    if (!lists.length) lists = [await this.rpc<Listed[]>("getSignaturesForAddress", params, Array.isArray, signal)];
    lists = lists.map((l) => l.slice(0, limit));
    const seen = new Map<string, Candidate & { claims: number[]; ok: number }>();
    for (const list of lists) {
      list.forEach((e, order) => {
        if (!e || typeof e.signature !== "string" || e.signature.length > 90) return;
        let c = seen.get(e.signature);
        if (!c) { c = { signature: e.signature, slot: 0, votes: 0, mentions: 0, order, claims: [], ok: 0 }; seen.set(e.signature, c); }
        c.mentions++;
        if (!e.err) { c.ok++; c.claims.push(typeof e.slot === "number" ? e.slot : 0); }
      });
    }
    // Where a candidate lies in the chain: a slot that two endpoints name is taken as true;
    // without that it is unconfirmed and placed as early as any endpoint claimed, so that it
    // is looked at before anything is settled and its writer's sequence number decides.
    for (const c of seen.values()) {
      const count = new Map<number, number>();
      for (const slot of c.claims) count.set(slot, (count.get(slot) ?? 0) + 1);
      let slot = 0, n = 0;
      for (const [x, k] of count) if (k > n || (k === n && x > slot)) { slot = x; n = k; }
      c.votes = n >= 2 ? n : 1;
      c.slot = n >= 2 ? slot : Math.max(0, ...c.claims);
    }
    const candidates = [...seen.values()].filter((c) => c.ok > 0).sort((a, b) => b.slot - a.slot || a.order - b.order);
    let next: Candidate | undefined;
    for (const l of lists.filter((x) => x.length >= limit)) {
      const last = l[l.length - 1], c = last && typeof last.signature === "string" ? seen.get(last.signature) : undefined;
      if (c && (!next || c.mentions > next.mentions || (c.mentions === next.mentions && c.slot > next.slot))) next = c;
    }
    return { candidates, lists: lists.length, next: next?.signature };
  }

  /** The pointer record a listed transaction holds, or null when it is none. */
  async #record(c: Candidate, tag: Uint8Array, signers: Uint8Array[], several: boolean, signal?: AbortSignal): Promise<PointerRecord | null> {
    try {
      const { tx, slot, blockTime } = await this.#tx(b58decode(c.signature, SIG), signers, true, signal);
      // the transaction must name the tag itself: an endpoint could list a pointer from somewhere else under it
      if (!tx.keys.some((k) => equal(k, tag))) return null;
      const data = tx.data;
      if (!data || data[1] !== KIND_POINTER) return null;
      if (data[2] === 1) return { payload: data.slice(3), signature: c.signature, slot, blockTime, seq: 0n };
      if (data[2] !== POINTER_VERSION || data.length < POINTER_HEAD) return null;
      return { payload: data.slice(POINTER_HEAD), signature: c.signature, slot, blockTime, seq: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(3, true) };
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof TrustError) return null; // somebody else wrote under this tag
      // a signature that only one of several endpoints mentioned and nobody can produce is not a record
      if (several && c.votes === 1) return null;
      throw e;
    }
  }

  async #newest(tag: Uint8Array, signers: Uint8Array[], opts: { limit?: number; signal?: AbortSignal }): Promise<PointerRecord | null> {
    let best: { record: PointerRecord; confirmed: boolean } | null = null;
    let before: string | undefined;
    for (let n = 0; n < POINTER_PAGES; n++) {
      const page = await this.#page(tag, n === 0 ? Math.min(opts.limit ?? 50, POINTER_PAGE) : POINTER_PAGE, before, opts.signal);
      const several = page.lists > 1;
      // A record that several endpoints listed ends the search. One that a single endpoint
      // listed (the very latest, or an old one passed off as new) stays a candidate, and the
      // sequence numbers decide between it and the first that is confirmed.
      let size = 1;
      while (several && size < page.candidates.length && page.candidates[size - 1]!.votes === 1) size++;
      for (let at = 0; at < page.candidates.length; at += size, size = Math.min(16, size * 4)) {
        const window = page.candidates.slice(at, at + size);
        const records = await Promise.all(window.map((c) => this.#record(c, tag, signers, several, opts.signal)));
        for (let k = 0; k < window.length; k++) {
          const record = records[k];
          if (!record) continue;
          const confirmed = !several || window[k]!.votes > 1;
          if (!best || record.seq > best.record.seq || (record.seq === best.record.seq && confirmed && !best.confirmed)) best = { record, confirmed };
          if (confirmed) return best.record;
        }
      }
      if (!page.next) return best?.record ?? null;
      before = page.next;
    }
    if (best) return best.record;
    throw new Error(`the newest ${POINTER_PAGES * POINTER_PAGE} transactions under ${b58encode(tag)} are all by other keys, so the pointer kept there cannot be found`);
  }

  // ---- images

  /** A publisher's catalog: every image, tag and architecture they list. Signed by the publisher. */
  async catalog(publisher: string, signal?: AbortSignal): Promise<Catalog> {
    const key = b58decode(publisher, 32);
    const p = await this.pointer(await tagAddress("catalog", key), [key], { signal });
    if (!p) return { chainboot: 1, kind: "catalog", publisher, updated: 0, images: {} };
    this.#say(p.account ? `catalog pointer: signed by ${publisher} (read from account ${p.account.slice(0, 12)}…)` : `catalog pointer: signed by ${publisher} (transaction ${p.signature.slice(0, 12)}…)`);
    const ref = JSON.parse(text.decode(p.payload)) as StoredRef;
    const raw = unpack(ref.codec, await this.object(ref, { signers: [key], signal }), ref.rawSize);
    const cat = JSON.parse(text.decode(raw)) as Catalog;
    if (cat?.chainboot !== 1 || cat.kind !== "catalog" || cat.publisher !== publisher || typeof cat.images !== "object") throw new Error(`the catalog of ${publisher} is malformed`);
    this.#say(`catalog: ${Object.keys(cat.images).length} image(s), SHA-256 ${ref.sha256.slice(0, 12)}… matches its pointer`);
    return cat;
  }

  /**
   * What a list contains: the images that at least `threshold` of its `members` have, with the
   * same content, under the same name, tag and architecture in their own catalogs. More than
   * half must agree. Each entry names the account that stored the image in `publisher`.
   */
  async list(members: string[], threshold: number, signal?: AbortSignal): Promise<{ images: Catalog["images"]; agreed: Record<string, string[]>; unreadable: string[] }> {
    if (new Set(members).size !== members.length || members.length < 2 || threshold > members.length || threshold * 2 <= members.length) throw new Error("a list needs distinct members, and more than half of them must agree");
    const results = await Promise.allSettled(members.map((m) => this.catalog(m, signal)));
    const unreadable = members.filter((_, i) => results[i]!.status === "rejected");
    if (members.length - unreadable.length < threshold) throw new Error(`only ${members.length - unreadable.length} of the list's ${members.length} catalogs could be read, and ${threshold} must agree`);
    const votes = new Map<string, { ref: ImageRef & { publisher?: string }; by: string; description?: string }[]>();
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      for (const [name, image] of Object.entries(r.value.images)) for (const [tag, arches] of Object.entries(image.tags ?? {})) for (const [arch, ref] of Object.entries(arches ?? {})) {
        if (!ref || typeof ref.digest !== "string") continue;
        const key = JSON.stringify([name, tag, arch, ref.digest]);
        if (!votes.has(key)) votes.set(key, []);
        votes.get(key)!.push({ ref, by: members[i]!, description: image.description });
      }
    });
    const images: Catalog["images"] = {}, agreed: Record<string, string[]> = {};
    for (const [key, list] of votes) {
      if (list.length < threshold) continue;
      const [name, tag, arch] = JSON.parse(key) as [string, string, string];
      const pick = list.find((v) => !v.ref.publisher || v.ref.publisher === v.by) ?? list[0]!;
      const image = (images[name] ??= { tags: {} });
      image.description ??= list.find((v) => v.description)?.description;
      (image.tags[tag] ??= {})[arch] = { ...pick.ref, publisher: pick.ref.publisher ?? pick.by } as ImageRef;
      agreed[`${name}:${tag}:${arch}`] = list.map((v) => v.by);
    }
    this.#say(`list: ${Object.keys(images).length} image(s) that ${threshold} of ${members.length} publishers agree on`);
    return { images, agreed, unreadable };
  }

  /** An image's manifest: the list of all its files, with the hash of each. */
  async manifest(publisher: string, ref: ImageRef, opts: { onProgress?: (p: Progress) => void; signal?: AbortSignal } = {}): Promise<Manifest> {
    const raw = unpack(ref.codec, await this.object(ref, { signers: [b58decode(ref.publisher ?? publisher, 32)], ...opts }), ref.rawSize);
    const m = JSON.parse(text.decode(raw)) as Manifest;
    if (m?.chainboot !== 1 || !Array.isArray(m.packs) || !Array.isArray(m.tree) || typeof m.name !== "string") throw new Error("the manifest is malformed");
    if (m.digest !== ref.digest) throw new Error(`the manifest of ${m.name} does not match its catalog entry`);
    // the digest is worked out again from the list of files itself: what the manifest says about itself proves nothing
    await checkManifest(m);
    if (m.packs.some((p) => p.enc)) throw new Error("this is a private image; the browser reader reads public images only");
    this.#say(`manifest of ${m.name}:${m.version} (${m.arch}): ${m.tree.length} entries, SHA-256 ${ref.sha256.slice(0, 12)}… matches the catalog`);
    return m;
  }

  /** One pack of an image, downloaded, verified and decompressed. */
  async pack(manifest: Manifest, index: number, opts: { onProgress?: (p: Progress) => void; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const p = manifest.packs[index];
    if (!p) throw new Error(`the image has no pack ${index}`);
    const raw = unpack(p.codec, await this.object({ sig: p.sig, sha256: p.sha256, size: p.size }, opts), p.rawSize);
    if (toHex(await sha256(raw)) !== p.rawSha256) throw new Error(`pack ${index + 1} is damaged`);
    this.#say(`pack ${index + 1}/${manifest.packs.length}: ${p.size} bytes on chain, ${p.rawSize} unpacked, both SHA-256 values match the manifest`);
    return raw;
  }
}

const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Checks what a manifest promises, the way chainboot does before it unpacks an image: packs
 * and nodes are well formed, paths are safe, sorted and unique, every file lies inside its
 * pack, and the digest is the one that these files (and the start command, if any) give.
 */
export async function checkManifest(m: Manifest): Promise<void> {
  const fail = (why: string): never => { throw new Error(`the manifest of ${String(m.name)} is not valid: ${why}`); };
  for (const p of m.packs) if (!p || typeof p.sig !== "string" || !isHash(p.sha256) || !isHash(p.rawSha256) || !isCount(p.size) || !isCount(p.rawSize) || !["xz", "zstd", "raw"].includes(p.codec)) fail("malformed pack entry");
  const sortedAttrs = (x: unknown): Record<string, unknown> | undefined => {
    if (!x || typeof x !== "object" || !Object.keys(x).length) return undefined;
    return Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]));
  };
  const lines: string[] = ["chainboot-tree-v1"];
  let prev: Uint8Array | null = null;
  for (const n of m.tree as unknown[][]) {
    if (!Array.isArray(n) || typeof n[0] !== "string" || typeof n[1] !== "string") fail("malformed entry");
    const path = n[0] as string, type = n[1] as string;
    if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) fail(`unsafe path ${JSON.stringify(path)}`);
    const bytes = utf8.encode(path);
    if (prev) {
      // paths are in the order of their UTF-8 bytes, each once
      let order = 0;
      for (let i = 0; i < Math.min(prev.length, bytes.length) && !order; i++) order = prev[i]! - bytes[i]!;
      if ((order || prev.length - bytes.length) >= 0) fail(`entries are not sorted, or one is there twice, at ${path}`);
    }
    prev = bytes;
    if (type === "f") {
      const size = n[6], pack = n[8], offset = n[9];
      if (!isCount(size) || !isHash(n[7]) || !isCount(offset) || !Number.isInteger(pack)) fail(`malformed file entry ${path}`);
      if (size as number > 0 && (pack as number < 0 || pack as number >= m.packs.length || (offset as number) + (size as number) > m.packs[pack as number]!.rawSize)) fail(`file ${path} points outside its pack`);
      const x = sortedAttrs(n[10]);
      lines.push(JSON.stringify(x ? [...n.slice(0, 8), x] : n.slice(0, 8)));
    } else if (type === "d") {
      const x = sortedAttrs(n[6]);
      lines.push(JSON.stringify(x ? [...n.slice(0, 6), x] : n.slice(0, 6)));
    } else if (["l", "h", "c", "b", "p"].includes(type)) lines.push(JSON.stringify(n));
    else fail(`unknown entry type ${type} for ${path}`);
  }
  const config = m.config as { cmd?: string[]; env?: Record<string, string> } | undefined;
  const cmd = Array.isArray(config?.cmd) && config.cmd.length ? config.cmd : undefined;
  const names = Object.keys(config?.env ?? {}).sort();
  const env = names.length ? Object.fromEntries(names.map((k) => [k, config!.env![k]])) : undefined;
  if (cmd || env) lines.push(`config ${JSON.stringify({ ...(cmd && { cmd }), ...(env && { env }) })}`);
  if (toHex(await sha256(utf8.encode(lines.join("\n") + "\n"))) !== m.digest) fail("its digest is not the digest of its content");
}

/** The entries of an image, as objects. */
export function entries(manifest: Manifest): FileEntry[] {
  return manifest.tree.map((n): FileEntry => {
    const [path, type] = n as [string, FileEntry["type"]];
    if (type === "f") return { path, type, mode: n[2] as number, size: n[6] as number, sha256: n[7] as string, pack: n[8] as number, offset: n[9] as number };
    if (type === "l") return { path, type, mode: n[2] as number, target: n[6] as string };
    if (type === "h") return { path, type, target: n[2] as string };
    return { path, type, mode: n[2] as number };
  });
}

/** The content of one file, cut out of its pack and checked against the manifest. */
export async function fileContent(entry: FileEntry, pack: Uint8Array): Promise<Uint8Array> {
  if (entry.type !== "f") throw new Error(`${entry.path} is not a regular file`);
  if (!entry.size) return new Uint8Array(0);
  const data = pack.subarray(entry.offset!, entry.offset! + entry.size);
  if (data.length !== entry.size || toHex(await sha256(data)) !== entry.sha256) throw new Error(`${entry.path} does not match its hash in the manifest`);
  return data;
}
