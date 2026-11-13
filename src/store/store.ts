// ChainStore: files of any size on the Solana ledger, addressed by ONE transaction signature.
//
// A file is cut into pieces of about 3.9 kB. Every piece travels in its own transaction (the
// "leaves"). Lists of leaf signatures are stored the same way ("branches"), and one final
// transaction (the "head") lists the top branches plus the file's size and SHA-256.
//
//                 head            <- the object's address is this signature
//               /   |   \
//          branch branch branch   <- each holds up to 61 signatures
//          / | \   ...
//       leaf leaf leaf            <- each holds up to 3912 bytes of the file
//
// Reading has two speeds, chosen automatically:
//   - block mode: the head also points at a small "hint" listing the slots (blocks) that hold
//     the object's transactions. One getBlock call returns hundreds of them at once, so even
//     a single rate-limited RPC endpoint downloads megabytes per second.
//   - transaction mode: every node is fetched by signature with getTransaction, batched and
//     spread over all endpoints. Used when there is no hint or a block is unavailable.
// Either way the head and branches are signature-checked and the final bytes must match the
// SHA-256 in the head, so a wrong or malicious RPC answer can never reach the caller.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { b58decodeFixed, b58encode } from "../util/base58.ts";
import { concat, equal, sha256, toHex } from "../util/bytes.ts";
import type { Keypair } from "../solana/keys.ts";
import type { RpcPool } from "../solana/rpc.ts";
import { NOOP_PROGRAM, noopCapacity, parseTransaction, verifyPayerSignature, type ParsedTx, type TxVersion } from "../solana/tx.ts";
import { TxSender, itemKey, type Commitment, type Landed, type SendItem, type SenderProgress } from "./sender.ts";

export const MAGIC = 0xcb;
export const KIND_LEAF = 0x00, KIND_BRANCH = 0x01, KIND_HEAD = 0x02, KIND_INLINE = 0x03, KIND_POINTER = 0x10;
export const FORMAT_VERSION = 1;
const SIG = 64;
const HEAD_FIXED = 2 + 1 + 1 + 2 + 8 + 32 + SIG; // magic, kind, version, depth, leaf size, size, sha256, hint signature
/** Objects with fewer nodes than this get no slot hint (they are quick to fetch anyway). */
const HINT_MIN_NODES = 16;
/** Block mode pays off only when a block holds several of the object's transactions. */
const BLOCK_MODE_MIN_DENSITY = 4;
const NO_HINT = Buffer.alloc(SIG);

export interface ObjectRef {
  /** Signature of the head transaction (base58): the address of the object. */
  sig: string;
  /** Size in bytes of the stored object. */
  size: number;
  /** SHA-256 of the stored object (hex). */
  sha256: string;
}

export interface TxOptions {
  /** Wire format (default: v1, 4096 bytes per transaction). */
  txVersion?: TxVersion;
  /** Extra fee per transaction in lamports (default 0). */
  priorityFeeLamports?: number;
}

export interface PutOptions extends TxOptions {
  commitment?: Commitment;
  /** Directory for resume journals. With it, an interrupted upload continues instead of starting over. */
  journalDir?: string;
  /** Store the slot hint that enables block mode for readers (default true). */
  hint?: boolean;
  onProgress?: (p: PutProgress) => void;
  signal?: AbortSignal;
  /** Fine tuning of the sender, mostly for tests. */
  resendAfterMs?: number;
  pollMs?: number;
}
export interface PutProgress { phase: string; total: number; done: number; pending: number; resent: number }

export interface GetOptions {
  /** Accept only transactions paid by one of these public keys (the publisher you trust). */
  signers?: Uint8Array[];
  /** Expected SHA-256 (hex) of the object, when the caller already knows it. */
  sha256?: string;
  /** Directory for finished objects and partial downloads (enables resume). */
  cacheDir?: string;
  /** "auto" (default) uses block mode when a hint exists; "transactions" never does. */
  mode?: "auto" | "transactions";
  onProgress?: (p: GetProgress) => void;
  signal?: AbortSignal;
}
export interface GetProgress { total: number; done: number; bytes: number; size: number }

export interface PointerRecord { payload: Buffer; signature: string; slot: number; blockTime: number | null; payer: Buffer }

interface TxResult {
  slot: number;
  blockTime: number | null;
  transaction: [string, string];
  meta: { err: unknown } | null;
}

/** How many payload bytes fit in one data transaction. */
export function capacity(opts: { txVersion?: TxVersion; priorityFee?: boolean; readonlyAccounts?: number } = {}): number {
  return noopCapacity({ version: opts.txVersion, priorityFee: opts.priorityFee, readonlyAccounts: opts.readonlyAccounts });
}

/** A 32-byte tag address derived from text. Transactions that reference it can be listed later. */
export function tagAddress(...parts: (string | Uint8Array)[]): Buffer {
  const h = createHash("sha256");
  h.update("chainboot:v1");
  for (const p of parts) { h.update(Uint8Array.of(0)); h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p); }
  return h.digest();
}

// ---- slot hints: sorted slot numbers as a count followed by LEB128 deltas

function pushVarint(out: number[], n: number): void {
  while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
  out.push(n);
}

export function encodeSlots(slots: Iterable<number>): Buffer {
  const sorted = [...new Set(slots)].sort((a, b) => a - b);
  const out: number[] = [];
  pushVarint(out, sorted.length);
  let prev = 0;
  for (const s of sorted) { pushVarint(out, s - prev); prev = s; }
  return Buffer.from(out);
}

export function decodeSlots(buf: Uint8Array): number[] {
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
  if (at !== buf.length) throw new Error("malformed slot hint");
  return slots;
}

function sizes(opts: TxOptions): { cap: number; leafSize: number; fan: number; headFan: number } {
  const cap = capacity({ txVersion: opts.txVersion, priorityFee: (opts.priorityFeeLamports ?? 0) > 0 });
  return { cap, leafSize: cap - 2, fan: Math.floor((cap - 2) / SIG), headFan: Math.floor((cap - HEAD_FIXED) / SIG) };
}

const key = (sig: Uint8Array) => Buffer.from(sig.buffer, sig.byteOffset, sig.byteLength).toString("latin1");

export class ChainStore {
  readonly pool: RpcPool;

  constructor(pool: RpcPool) {
    this.pool = pool;
  }

  // ------------------------------------------------------------------ write

  /** Plans an upload without sending anything: how many transactions and what it costs. */
  static plan(size: number, opts: TxOptions & { hint?: boolean } = {}): { transactions: number; feeLamports: number; leafSize: number; depth: number } {
    const { cap, leafSize, fan, headFan } = sizes(opts);
    const perTx = 5000 + Math.max(0, opts.priorityFeeLamports ?? 0);
    if (size <= cap - 3) return { transactions: 1, feeLamports: perTx, leafSize: 0, depth: 0 };
    let level = Math.ceil(size / leafSize), tx = level, depth = 1;
    while (level > headFan) { level = Math.ceil(level / fan); tx += level; depth++; }
    if (opts.hint !== false && tx >= HINT_MIN_NODES) tx++;
    return { transactions: tx + 1, feeLamports: (tx + 1) * perTx, leafSize, depth };
  }

  /** Stores `data` on chain and returns its address. Safe to call again after an interruption. */
  async put(payer: Keypair, data: Uint8Array, opts: PutOptions = {}): Promise<ObjectRef> {
    const { cap, leafSize, fan, headFan } = sizes(opts);
    const digest = sha256(data);
    const sender = new TxSender(this.pool, payer);
    const journal = opts.journalDir ? path.join(opts.journalDir, `${toHex(digest)}.journal`) : undefined;
    const send = (phase: string, payloads: Uint8Array[]): Promise<Landed[]> => sender.sendAll(payloads.map((p): SendItem => ({ data: p, key: itemKey(p) })), {
      commitment: opts.commitment, journal, signal: opts.signal, resendAfterMs: opts.resendAfterMs, pollMs: opts.pollMs,
      txVersion: opts.txVersion, priorityFeeLamports: opts.priorityFeeLamports,
      onProgress: (p: SenderProgress) => opts.onProgress?.({ phase, total: p.total, done: p.done, pending: p.pending, resent: p.resent }),
    });

    let headSig: string;
    if (data.length <= cap - 3) {
      headSig = (await send("head", [concat([Uint8Array.of(MAGIC, KIND_INLINE, FORMAT_VERSION), data])]))[0]!.signature;
    } else {
      const leaves: Uint8Array[] = [];
      for (let at = 0; at < data.length; at += leafSize) leaves.push(concat([Uint8Array.of(MAGIC, KIND_LEAF), data.subarray(at, at + leafSize)]));
      let landed = await send("data", leaves);
      const slots = new Set(landed.map((l) => l.slot));
      let nodes = landed.length, depth = 1;
      while (landed.length > headFan) {
        const branches: Uint8Array[] = [];
        for (let at = 0; at < landed.length; at += fan) {
          branches.push(concat([Uint8Array.of(MAGIC, KIND_BRANCH), ...landed.slice(at, at + fan).map((l) => b58decodeFixed(l.signature, SIG, "signature"))]));
        }
        landed = await send(`index ${depth}`, branches);
        for (const l of landed) slots.add(l.slot);
        nodes += landed.length; depth++;
      }
      let hint: Buffer = NO_HINT;
      if (opts.hint !== false && nodes >= HINT_MIN_NODES) {
        const ref = await this.put(payer, encodeSlots(slots), { ...opts, hint: false, onProgress: (p) => opts.onProgress?.({ ...p, phase: "hint" }) });
        hint = b58decodeFixed(ref.sig, SIG, "signature");
      }
      const head = Buffer.alloc(HEAD_FIXED + landed.length * SIG);
      head[0] = MAGIC; head[1] = KIND_HEAD; head[2] = FORMAT_VERSION; head[3] = depth;
      head.writeUInt16LE(leafSize, 4);
      head.writeBigUInt64LE(BigInt(data.length), 6);
      digest.copy(head, 14);
      hint.copy(head, 46);
      landed.forEach((l, i) => b58decodeFixed(l.signature, SIG, "signature").copy(head, HEAD_FIXED + i * SIG));
      headSig = (await send("head", [head]))[0]!.signature;
    }
    if (journal) fs.rmSync(journal, { force: true });
    return { sig: headSig, size: data.length, sha256: toHex(digest) };
  }

  /** Publishes a small record that can be found again through `tag` (see tagAddress). */
  async putPointer(payer: Keypair, tag: Uint8Array, payload: Uint8Array, opts: TxOptions & { commitment?: Commitment } = {}): Promise<string> {
    const cap = capacity({ txVersion: opts.txVersion, priorityFee: (opts.priorityFeeLamports ?? 0) > 0, readonlyAccounts: 1 }) - 3;
    if (payload.length > cap) throw new Error(`pointer payload is ${payload.length} bytes, the limit is ${cap}`);
    const data = concat([Uint8Array.of(MAGIC, KIND_POINTER, FORMAT_VERSION), payload]);
    // the key includes the time so that publishing the same pointer twice still creates a new, newer transaction
    const [landed] = await new TxSender(this.pool, payer).sendAll(
      [{ data, readonlyAccounts: [tag], key: itemKey(concat([data, Buffer.from(String(Date.now()))])) }],
      { commitment: opts.commitment, txVersion: opts.txVersion, priorityFeeLamports: opts.priorityFeeLamports });
    return landed!.signature;
  }

  // ------------------------------------------------------------------ read

  /** Checks that a transaction is what was asked for and came from a trusted payer. */
  static #check(tx: ParsedTx, expected: Uint8Array | null, signers: Uint8Array[] | undefined, verify: boolean): void {
    if (expected && (!tx.signatures[0] || !equal(tx.signatures[0], expected))) throw new Error("answer is a different transaction");
    if (verify && !verifyPayerSignature(tx)) throw new Error("invalid signature");
    if (signers && !signers.some((s) => equal(s, tx.accountKeys[0]!))) {
      throw new TrustError(`transaction ${b58encode(tx.signatures[0]!)} was not published by a trusted key (it was paid by ${b58encode(tx.accountKeys[0]!)})`);
    }
  }

  async #fetchTx(signature: string, opts: GetOptions, verify = true): Promise<{ tx: ParsedTx; result: TxResult }> {
    const expected = b58decodeFixed(signature, SIG, "signature");
    let lastProblem = "";
    // a wrong answer from one endpoint must not end the download: ask again (the pool rotates endpoints)
    for (let attempt = 0; attempt < 5; attempt++) {
      if (opts.signal?.aborted) throw new Error("download aborted");
      const result = await this.pool.call<TxResult>("getTransaction", [signature, { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" }], { accept: (r) => r !== null, batch: true });
      try {
        if (!result || !Array.isArray(result.transaction) || typeof result.transaction[0] !== "string") throw new Error("malformed answer");
        if (!result.meta || result.meta.err !== null) throw new Error("transaction failed on chain");
        const tx = parseTransaction(Buffer.from(result.transaction[0], "base64"));
        ChainStore.#check(tx, expected, opts.signers, verify);
        return { tx, result };
      } catch (e) {
        if (e instanceof TrustError) throw e;
        lastProblem = (e as Error).message;
      }
    }
    throw new Error(`could not get a valid copy of transaction ${signature}: ${lastProblem}`);
  }

  static #payload(tx: ParsedTx): Buffer | null {
    for (const ix of tx.instructions) {
      if (equal(ix.programId, NOOP_PROGRAM) && ix.data.length >= 2 && ix.data[0] === MAGIC) return ix.data;
    }
    return null;
  }

  /** Downloads whole blocks and collects every chainboot transaction found in them, keyed by signature. */
  async #fetchBlocks(slots: number[], opts: GetOptions, onLeaf: (bytes: number) => void): Promise<Map<string, ParsedTx>> {
    const found = new Map<string, ParsedTx>();
    await Promise.all(slots.map(async (slot) => {
      if (opts.signal?.aborted) return;
      let block: { transactions?: { transaction?: [string, string]; meta?: { err: unknown } | null }[] } | null;
      try {
        block = await this.pool.call("getBlock", [slot, { encoding: "base64", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
          { attempts: Math.max(3, Math.min(6, this.pool.size)), timeoutMs: 45_000 });
      } catch { return; } // this block could not be had: its transactions are fetched one by one later
      for (const item of block?.transactions ?? []) {
        if (!item?.meta || item.meta.err !== null || typeof item.transaction?.[0] !== "string") continue;
        let tx: ParsedTx;
        try { tx = parseTransaction(Buffer.from(item.transaction[0], "base64")); } catch { continue; } // someone else's v0 transaction
        const data = ChainStore.#payload(tx);
        if (!data || (opts.signers && !opts.signers.some((s) => equal(s, tx.accountKeys[0]!)))) continue;
        found.set(key(tx.signatures[0]!), tx);
        if (data[1] === KIND_LEAF) onLeaf(data.length - 2);
      }
    }));
    return found;
  }

  /** Fetches and verifies an object. `ref` is a head signature or a full ObjectRef. */
  async get(ref: string | ObjectRef, opts: GetOptions = {}): Promise<Buffer> {
    const sig = typeof ref === "string" ? ref : ref.sig;
    const wantSha = (typeof ref === "string" ? opts.sha256 : ref.sha256)?.toLowerCase();
    const cacheFile = opts.cacheDir && wantSha ? path.join(opts.cacheDir, wantSha) : null;
    if (cacheFile && fs.existsSync(cacheFile)) {
      const cached = fs.readFileSync(cacheFile);
      if (toHex(sha256(cached)) === wantSha) return cached;
      fs.rmSync(cacheFile, { force: true }); // damaged cache entry: fetch again
    }

    const { tx } = await this.#fetchTx(sig, opts);
    const head = ChainStore.#payload(tx);
    if (!head) throw new Error(`${sig} does not carry chainboot data`);
    if (head[2] !== FORMAT_VERSION) throw new Error(`object ${sig} uses format version ${head[2]}, this program understands version ${FORMAT_VERSION}`);
    let out: Buffer;
    if (head[1] === KIND_INLINE) {
      out = Buffer.from(head.subarray(3));
      opts.onProgress?.({ total: 1, done: 1, bytes: out.length, size: out.length });
    } else if (head[1] === KIND_HEAD) {
      out = await this.#getTree(sig, head, wantSha, opts, false);
    } else {
      throw new Error(`${sig} is not the head of an object`);
    }
    const got = toHex(sha256(out));
    if (wantSha && got !== wantSha) throw new Error(`object ${sig} is not the expected content (sha256 differs)`);
    if (typeof ref !== "string" && ref.size !== out.length) throw new Error(`object ${sig} has ${out.length} bytes, expected ${ref.size}`);
    if (opts.cacheDir) {
      fs.mkdirSync(opts.cacheDir, { recursive: true });
      const final = path.join(opts.cacheDir, got), tmp = `${final}.tmp${process.pid}`;
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, final);
    }
    return out;
  }

  async #getTree(sig: string, head: Buffer, wantSha: string | undefined, opts: GetOptions, secondTry: boolean): Promise<Buffer> {
    if (head.length < HEAD_FIXED + SIG || (head.length - HEAD_FIXED) % SIG) throw new Error(`malformed head ${sig}`);
    const depth = head[3]!, leafSize = head.readUInt16LE(4), size = Number(head.readBigUInt64LE(6));
    const digest = head.subarray(14, 46), hint = head.subarray(46, 46 + SIG);
    if (wantSha && toHex(digest) !== wantSha) throw new Error(`object ${sig} is not the expected content (sha256 differs)`);
    if (depth < 1 || depth > 8 || leafSize < 1 || size < 1) throw new Error(`malformed head ${sig}`);
    const leafCount = Math.ceil(size / leafSize);
    const split = (b: Buffer) => { const r: Buffer[] = []; for (let at = 0; at < b.length; at += SIG) r.push(b.subarray(at, at + SIG)); return r; };

    // resume support: partial data + the list of leaves already written
    const partBase = opts.cacheDir ? path.join(opts.cacheDir, `${toHex(digest)}.part`) : null;
    const wipe = () => { if (partBase) for (const ext of [".data", ".done", ".sigs"]) fs.rmSync(partBase + ext, { force: true }); };
    if (opts.cacheDir) fs.mkdirSync(opts.cacheDir, { recursive: true });
    const out = Buffer.alloc(size);
    const have = new Uint8Array(leafCount);
    let done = 0, bytes = 0, fromDisk = 0;
    let fd: number | null = null, doneFd: number | null = null;
    if (partBase) {
      if (fs.existsSync(`${partBase}.data`) && fs.existsSync(`${partBase}.done`) && fs.statSync(`${partBase}.data`).size === size) {
        const d = fs.readFileSync(`${partBase}.done`), prev = fs.readFileSync(`${partBase}.data`);
        for (let i = 0; i + 4 <= d.length; i += 4) {
          const idx = d.readUInt32LE(i);
          if (idx < leafCount && !have[idx]) {
            have[idx] = 1; done++; fromDisk++;
            const from = idx * leafSize, to = Math.min(size, from + leafSize);
            prev.copy(out, from, from, to); bytes += to - from;
          }
        }
        fd = fs.openSync(`${partBase}.data`, "r+");
      } else {
        fd = fs.openSync(`${partBase}.data`, "w+");
        fs.ftruncateSync(fd, size);
        fs.writeFileSync(`${partBase}.done`, "");
      }
      doneFd = fs.openSync(`${partBase}.done`, "a");
    }
    const report = () => opts.onProgress?.({ total: leafCount, done, bytes, size });
    report();

    try {
      // ---- block mode: pull whole blocks that are known to hold this object's transactions
      let blocks = new Map<string, ParsedTx>();
      if (done < leafCount && opts.mode !== "transactions" && !equal(hint, NO_HINT)) {
        try {
          const slots = decodeSlots(await this.get(b58encode(hint), { signers: opts.signers, signal: opts.signal, mode: "transactions" }));
          const nodes = (leafCount - done) * (1 + 1 / Math.max(2, Math.floor(leafSize / SIG)));
          if (slots.length && nodes / slots.length >= BLOCK_MODE_MIN_DENSITY) {
            let seen = 0, seenBytes = 0;
            blocks = await this.#fetchBlocks(slots, opts, (n) => {
              seen++; seenBytes += n;
              if (seen % 32 === 0) opts.onProgress?.({ total: leafCount, done: Math.min(leafCount, done + seen), bytes: Math.min(size, bytes + seenBytes), size });
            });
          }
        } catch (e) {
          if (e instanceof TrustError) throw e;
          // a broken hint only costs speed: continue in transaction mode
        }
      }
      if (opts.signal?.aborted) throw new Error("download aborted");

      /** Payload of a tree node: from the block cache when present, otherwise fetched by signature. */
      const node = async (s: Buffer, kind: number, verify: boolean): Promise<{ data: Buffer; tx: ParsedTx }> => {
        let tx = blocks.get(key(s));
        if (tx && verify && !verifyPayerSignature(tx)) tx = undefined;
        tx ??= (await this.#fetchTx(b58encode(s), opts, verify)).tx;
        const data = ChainStore.#payload(tx);
        if (!data) throw new Error(`transaction ${b58encode(s)} does not carry chainboot data`);
        if (data[1] !== kind) throw new Error(`unexpected node kind ${data[1]} in ${b58encode(s)} (wanted ${kind})`);
        return { data: data.subarray(2), tx };
      };

      // ---- branches (always signature-checked: they decide which leaves belong to the object)
      let leafSigs: Buffer[] | null = null;
      if (partBase && fs.existsSync(`${partBase}.sigs`)) {
        const s = fs.readFileSync(`${partBase}.sigs`);
        if (s.length === leafCount * SIG) leafSigs = split(s);
      }
      if (!leafSigs) {
        let level = split(head.subarray(HEAD_FIXED));
        for (let d = depth; d > 1; d--) {
          const nodes = await Promise.all(level.map((s) => node(s, KIND_BRANCH, true)));
          level = [];
          for (const n of nodes) {
            if (!n.data.length || n.data.length % SIG) throw new Error(`malformed branch in object ${sig}`);
            level.push(...split(n.data));
          }
        }
        if (level.length !== leafCount) throw new Error(`object ${sig} is inconsistent: ${level.length} leaves for ${size} bytes`);
        leafSigs = level;
        if (partBase) fs.writeFileSync(`${partBase}.sigs`, concat(leafSigs));
      }

      // ---- leaves: accepted without a signature check first; the object's SHA-256 judges them all at once
      const leafTx: (ParsedTx | undefined)[] = new Array(leafCount);
      const place = (i: number, leaf: Buffer) => {
        const from = i * leafSize, len = Math.min(leafSize, size - from);
        if (leaf.length !== len) throw new Error(`leaf ${i} of object ${sig} has ${leaf.length} bytes, expected ${len}`);
        leaf.copy(out, from);
        if (fd !== null && doneFd !== null && !have[i]) {
          fs.writeSync(fd, leaf, 0, len, from);
          const rec = Buffer.alloc(4); rec.writeUInt32LE(i);
          fs.writeSync(doneFd, rec);
        }
        if (!have[i]) { have[i] = 1; done++; bytes += len; }
      };
      const fetchLeaves = async (indexes: number[], verify: boolean) => {
        let failed: Error | null = null;
        await Promise.all(indexes.map(async (i) => {
          if (failed) return;
          try {
            const n = await node(leafSigs![i]!, KIND_LEAF, verify);
            leafTx[i] = n.tx;
            place(i, n.data);
            if (done % 64 === 0 || done === leafCount) report();
          } catch (e) { failed ??= e as Error; }
        }));
        if (failed) throw failed;
      };
      const missing: number[] = [];
      for (let i = 0; i < leafCount; i++) if (!have[i]) missing.push(i);
      await fetchLeaves(missing, false);
      report();

      if (!equal(sha256(out), digest)) {
        // something lied. Signatures tell which leaves; those are fetched again with full checking.
        const bad: number[] = [];
        for (let i = 0; i < leafCount; i++) { const t = leafTx[i]; if (t && !verifyPayerSignature(t)) bad.push(i); }
        for (const i of bad) blocks.delete(key(leafSigs[i]!));
        if (bad.length) await fetchLeaves(bad, true);
        if (!equal(sha256(out), digest)) {
          wipe();
          // leaves restored from an earlier partial download cannot be re-checked: start clean once
          if (fromDisk > 0 && !secondTry) {
            if (fd !== null) { fs.closeSync(fd); fd = null; }
            if (doneFd !== null) { fs.closeSync(doneFd); doneFd = null; }
            return await this.#getTree(sig, head, wantSha, opts, true);
          }
          throw new Error(`object ${sig} failed verification: the downloaded bytes do not match its SHA-256`);
        }
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
      if (doneFd !== null) fs.closeSync(doneFd);
    }
    wipe();
    return out;
  }

  /**
   * Newest pointer record under `tag` that was published by one of `signers`.
   * Records by anyone else are ignored, so nobody can redirect your pointer.
   */
  async getPointer(tag: Uint8Array, signers: Uint8Array[], opts: { limit?: number } = {}): Promise<PointerRecord | null> {
    const list = await this.pool.call<{ signature: string; err: unknown }[]>(
      "getSignaturesForAddress", [b58encode(tag), { limit: opts.limit ?? 50, commitment: "confirmed" }]);
    if (!Array.isArray(list)) throw new Error("malformed getSignaturesForAddress answer");
    for (const entry of list) {
      if (entry.err) continue;
      try {
        const { tx, result } = await this.#fetchTx(entry.signature, { signers });
        const data = ChainStore.#payload(tx);
        if (!data || data[1] !== KIND_POINTER || data[2] !== FORMAT_VERSION) continue;
        return { payload: Buffer.from(data.subarray(3)), signature: entry.signature, slot: result.slot, blockTime: result.blockTime ?? null, payer: Buffer.from(tx.accountKeys[0]!) };
      } catch (e) {
        if (e instanceof TrustError) continue; // somebody else wrote under this tag: skip it
        throw e;
      }
    }
    return null;
  }
}

export class TrustError extends Error {
  constructor(message: string) { super(message); this.name = "TrustError"; }
}
