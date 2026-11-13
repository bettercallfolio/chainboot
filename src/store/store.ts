// ChainStore: files of any size on the Solana ledger, addressed by ONE transaction signature.
//
// A file is cut into pieces of about 1 kB. Every piece travels in its own transaction (the
// "leaves"). Lists of leaf signatures are stored the same way ("branches"), and one final
// transaction (the "head") lists the top branches plus the file's size and SHA-256.
//
//                 head            <- the object's address is this signature
//               /   |   \
//          branch branch branch   <- each holds up to 16 signatures
//          / | \   ...
//       leaf leaf leaf            <- each holds up to 1060 bytes of the file
//
// Reading walks the tree top-down. Every level can be fetched in parallel from many RPC
// endpoints, every transaction's signature is checked, and the final bytes must match the
// SHA-256 in the head, so a wrong or malicious RPC answer can never reach the caller.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { b58decodeFixed, b58encode } from "../util/base58.ts";
import { concat, equal, sha256, toHex } from "../util/bytes.ts";
import type { Keypair } from "../solana/keys.ts";
import type { RpcPool } from "../solana/rpc.ts";
import {
  MAX_TX_SIZE, NOOP_PROGRAM, computeBudgetInstructions, noopInstruction, noopOverhead, parseTransaction, verifyPayerSignature,
  type Instruction, type ParsedTx,
} from "../solana/tx.ts";
import { TxSender, itemKey, type Commitment, type SendItem, type SenderProgress } from "./sender.ts";

export const MAGIC = 0xcb;
export const KIND_LEAF = 0x00, KIND_BRANCH = 0x01, KIND_HEAD = 0x02, KIND_INLINE = 0x03, KIND_POINTER = 0x10;
export const FORMAT_VERSION = 1;
const HEAD_FIXED = 2 + 1 + 1 + 2 + 8 + 32; // magic, kind, version, depth, leaf size, size, sha256
const SIG = 64;

export interface ObjectRef {
  /** Signature of the head transaction (base58): the address of the object. */
  sig: string;
  /** Size in bytes of the stored object. */
  size: number;
  /** SHA-256 of the stored object (hex). */
  sha256: string;
}

export interface PriorityFee { unitLimit: number; microLamportsPerUnit: number }

export interface PutOptions {
  commitment?: Commitment;
  /** Directory for resume journals. With it, an interrupted upload continues instead of starting over. */
  journalDir?: string;
  priorityFee?: PriorityFee;
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

/** How many payload bytes fit in one Noop transaction. */
export function capacity(opts: { priorityFee?: boolean; readonlyAccounts?: number } = {}): number {
  // the data length prefix takes 2 bytes for anything from 128 to 16383 bytes
  return MAX_TX_SIZE - noopOverhead({ ...opts, dataLen: 1000 });
}

/** A 32-byte tag address derived from text. Transactions that reference it can be listed later. */
export function tagAddress(...parts: (string | Uint8Array)[]): Buffer {
  const h = createHash("sha256");
  h.update("chainboot:v1");
  for (const p of parts) { h.update(Uint8Array.of(0)); h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p); }
  return h.digest();
}

export class ChainStore {
  readonly pool: RpcPool;

  constructor(pool: RpcPool) {
    this.pool = pool;
  }

  // ------------------------------------------------------------------ write

  /** Plans an upload without sending anything: how many transactions and what it costs. */
  static plan(size: number, priorityFee = false): { transactions: number; feeLamports: number; leafSize: number; depth: number } {
    const cap = capacity({ priorityFee });
    if (size <= cap - 3) return { transactions: 1, feeLamports: 5000, leafSize: 0, depth: 0 };
    const leafSize = cap - 2, fan = Math.floor((cap - 2) / SIG), headFan = Math.floor((cap - HEAD_FIXED) / SIG);
    let level = Math.ceil(size / leafSize), tx = level, depth = 1;
    while (level > headFan) { level = Math.ceil(level / fan); tx += level; depth++; }
    return { transactions: tx + 1, feeLamports: (tx + 1) * 5000, leafSize, depth };
  }

  /** Stores `data` on chain and returns its address. Safe to call again after an interruption. */
  async put(payer: Keypair, data: Uint8Array, opts: PutOptions = {}): Promise<ObjectRef> {
    const fee = !!opts.priorityFee;
    const cap = capacity({ priorityFee: fee });
    const digest = sha256(data);
    const sender = new TxSender(this.pool, payer);
    const wrap = (payload: Uint8Array): SendItem => {
      const ix: Instruction[] = opts.priorityFee ? computeBudgetInstructions(opts.priorityFee.unitLimit, opts.priorityFee.microLamportsPerUnit) : [];
      ix.push(noopInstruction(payload));
      return { instructions: ix, key: itemKey(payload) };
    };
    const journal = opts.journalDir ? path.join(opts.journalDir, `${toHex(digest)}.journal`) : undefined;
    const send = (phase: string, payloads: Uint8Array[]) => sender.sendAll(payloads.map(wrap), {
      commitment: opts.commitment, journal, signal: opts.signal, resendAfterMs: opts.resendAfterMs, pollMs: opts.pollMs,
      onProgress: (p: SenderProgress) => opts.onProgress?.({ phase, total: p.total, done: p.done, pending: p.pending, resent: p.resent }),
    });

    let headSig: string;
    if (data.length <= cap - 3) {
      [headSig] = await send("head", [concat([Uint8Array.of(MAGIC, KIND_INLINE, FORMAT_VERSION), data])]) as [string];
    } else {
      const leafSize = cap - 2, fan = Math.floor((cap - 2) / SIG), headFan = Math.floor((cap - HEAD_FIXED) / SIG);
      const leaves: Uint8Array[] = [];
      for (let at = 0; at < data.length; at += leafSize) leaves.push(concat([Uint8Array.of(MAGIC, KIND_LEAF), data.subarray(at, at + leafSize)]));
      let sigs = await send("data", leaves);
      let depth = 1;
      while (sigs.length > headFan) {
        const branches: Uint8Array[] = [];
        for (let at = 0; at < sigs.length; at += fan) {
          branches.push(concat([Uint8Array.of(MAGIC, KIND_BRANCH), ...sigs.slice(at, at + fan).map((s) => b58decodeFixed(s, SIG, "signature"))]));
        }
        sigs = await send(`index ${depth}`, branches);
        depth++;
      }
      const head = Buffer.alloc(HEAD_FIXED + sigs.length * SIG);
      head[0] = MAGIC; head[1] = KIND_HEAD; head[2] = FORMAT_VERSION; head[3] = depth;
      head.writeUInt16LE(leafSize, 4);
      head.writeBigUInt64LE(BigInt(data.length), 6);
      digest.copy(head, 14);
      sigs.forEach((s, i) => b58decodeFixed(s, SIG, "signature").copy(head, HEAD_FIXED + i * SIG));
      [headSig] = await send("head", [head]) as [string];
    }
    if (journal) fs.rmSync(journal, { force: true });
    return { sig: headSig, size: data.length, sha256: toHex(digest) };
  }

  /** Publishes a small record that can be found again through `tag` (see tagAddress). */
  async putPointer(payer: Keypair, tag: Uint8Array, payload: Uint8Array, opts: { commitment?: Commitment; priorityFee?: PriorityFee } = {}): Promise<string> {
    const cap = capacity({ priorityFee: !!opts.priorityFee, readonlyAccounts: 1 }) - 3;
    if (payload.length > cap) throw new Error(`pointer payload is ${payload.length} bytes, the limit is ${cap}`);
    const data = concat([Uint8Array.of(MAGIC, KIND_POINTER, FORMAT_VERSION), payload]);
    const ix: Instruction[] = opts.priorityFee ? computeBudgetInstructions(opts.priorityFee.unitLimit, opts.priorityFee.microLamportsPerUnit) : [];
    ix.push(noopInstruction(data, [tag]));
    // the key includes the time so that publishing the same pointer twice still creates a new, newer transaction
    const [sig] = await new TxSender(this.pool, payer).sendAll([{ instructions: ix, key: itemKey(concat([data, Buffer.from(String(Date.now()))])) }], { commitment: opts.commitment });
    return sig!;
  }

  // ------------------------------------------------------------------ read

  async #fetchTx(signature: string, opts: GetOptions): Promise<{ tx: ParsedTx; result: TxResult }> {
    const expected = b58decodeFixed(signature, SIG, "signature");
    let lastProblem = "";
    // a wrong answer from one endpoint must not end the download: ask again (the pool rotates endpoints)
    for (let attempt = 0; attempt < 5; attempt++) {
      if (opts.signal?.aborted) throw new Error("download aborted");
      const result = await this.pool.call<TxResult>("getTransaction", [signature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], { accept: (r) => r !== null });
      try {
        if (!result || !Array.isArray(result.transaction) || typeof result.transaction[0] !== "string") throw new Error("malformed answer");
        if (!result.meta || result.meta.err !== null) throw new Error("transaction failed on chain");
        const tx = parseTransaction(Buffer.from(result.transaction[0], "base64"));
        if (!tx.signatures[0] || !equal(tx.signatures[0], expected)) throw new Error("answer is a different transaction");
        if (!verifyPayerSignature(tx)) throw new Error("invalid signature");
        if (opts.signers && !opts.signers.some((s) => equal(s, tx.accountKeys[0]!))) {
          throw new TrustError(`transaction ${signature} was not published by a trusted key (it was paid by ${b58encode(tx.accountKeys[0]!)})`);
        }
        return { tx, result };
      } catch (e) {
        if (e instanceof TrustError) throw e;
        lastProblem = (e as Error).message;
      }
    }
    throw new Error(`could not get a valid copy of transaction ${signature}: ${lastProblem}`);
  }

  static #payload(tx: ParsedTx): Buffer {
    for (const ix of tx.instructions) {
      if (equal(ix.programId, NOOP_PROGRAM) && ix.data.length >= 2 && ix.data[0] === MAGIC) return ix.data;
    }
    throw new Error("transaction does not carry chainboot data");
  }

  async #node(signature: string, kind: number, opts: GetOptions): Promise<Buffer> {
    const { tx } = await this.#fetchTx(signature, opts);
    const data = ChainStore.#payload(tx);
    if (data[1] !== kind) throw new Error(`unexpected node kind ${data[1]} in ${signature} (wanted ${kind})`);
    return data.subarray(2);
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
    if (head[2] !== FORMAT_VERSION) throw new Error(`object ${sig} uses format version ${head[2]}, this program understands version ${FORMAT_VERSION}`);
    let out: Buffer;
    if (head[1] === KIND_INLINE) {
      out = Buffer.from(head.subarray(3));
      opts.onProgress?.({ total: 1, done: 1, bytes: out.length, size: out.length });
    } else if (head[1] === KIND_HEAD) {
      if (head.length < HEAD_FIXED + SIG || (head.length - HEAD_FIXED) % SIG) throw new Error(`malformed head ${sig}`);
      const depth = head[3]!, leafSize = head.readUInt16LE(4), size = Number(head.readBigUInt64LE(6));
      const digest = head.subarray(14, 46);
      if (wantSha && toHex(digest) !== wantSha) throw new Error(`object ${sig} is not the expected content (sha256 differs)`);
      if (depth < 1 || depth > 8 || leafSize < 1 || size < 1) throw new Error(`malformed head ${sig}`);
      const leafCount = Math.ceil(size / leafSize);
      const split = (b: Buffer) => { const r: Buffer[] = []; for (let at = 0; at < b.length; at += SIG) r.push(b.subarray(at, at + SIG)); return r; };

      // resume support: partial data + the list of leaves already written
      const partBase = opts.cacheDir ? path.join(opts.cacheDir, `${toHex(digest)}.part`) : null;
      if (opts.cacheDir) fs.mkdirSync(opts.cacheDir, { recursive: true });
      let leafSigs: Buffer[] | null = null;
      if (partBase && fs.existsSync(`${partBase}.sigs`)) {
        const s = fs.readFileSync(`${partBase}.sigs`);
        if (s.length === leafCount * SIG) leafSigs = split(s);
      }
      if (!leafSigs) {
        let level = split(head.subarray(HEAD_FIXED));
        for (let d = depth; d > 1; d--) {
          const nodes = await Promise.all(level.map((s) => this.#node(b58encode(s), KIND_BRANCH, opts)));
          level = [];
          for (const n of nodes) {
            if (!n.length || n.length % SIG) throw new Error(`malformed branch in object ${sig}`);
            level.push(...split(n));
          }
        }
        if (level.length !== leafCount) throw new Error(`object ${sig} is inconsistent: ${level.length} leaves for ${size} bytes`);
        leafSigs = level;
        if (partBase) fs.writeFileSync(`${partBase}.sigs`, concat(leafSigs));
      }

      out = Buffer.alloc(size);
      const have = new Uint8Array(leafCount);
      let fd: number | null = null, doneFd: number | null = null, done = 0, bytes = 0;
      if (partBase) {
        if (fs.existsSync(`${partBase}.data`) && fs.existsSync(`${partBase}.done`) && fs.statSync(`${partBase}.data`).size === size) {
          const d = fs.readFileSync(`${partBase}.done`);
          const prev = fs.readFileSync(`${partBase}.data`);
          for (let i = 0; i + 4 <= d.length; i += 4) {
            const idx = d.readUInt32LE(i);
            if (idx < leafCount && !have[idx]) {
              have[idx] = 1; done++;
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
      opts.onProgress?.({ total: leafCount, done, bytes, size });
      try {
        const missing: number[] = [];
        for (let i = 0; i < leafCount; i++) if (!have[i]) missing.push(i);
        let failed: Error | null = null;
        await Promise.all(missing.map(async (i) => {
          if (failed) return;
          try {
            const leaf = await this.#node(b58encode(leafSigs![i]!), KIND_LEAF, opts);
            const from = i * leafSize, len = Math.min(leafSize, size - from);
            if (leaf.length !== len) throw new Error(`leaf ${i} of object ${sig} has ${leaf.length} bytes, expected ${len}`);
            leaf.copy(out, from);
            if (fd !== null && doneFd !== null) {
              fs.writeSync(fd, leaf, 0, len, from);
              const rec = Buffer.alloc(4); rec.writeUInt32LE(i);
              fs.writeSync(doneFd, rec);
            }
            done++; bytes += len;
            if (done % 64 === 0 || done === leafCount) opts.onProgress?.({ total: leafCount, done, bytes, size });
          } catch (e) { failed ??= e as Error; }
        }));
        if (failed) throw failed;
      } finally {
        if (fd !== null) fs.closeSync(fd);
        if (doneFd !== null) fs.closeSync(doneFd);
      }
      if (!equal(sha256(out), digest)) {
        if (partBase) for (const ext of [".data", ".done", ".sigs"]) fs.rmSync(partBase + ext, { force: true });
        throw new Error(`object ${sig} failed verification: the downloaded bytes do not match its SHA-256`);
      }
      if (partBase) for (const ext of [".data", ".done", ".sigs"]) fs.rmSync(partBase + ext, { force: true });
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
        if (data[1] !== KIND_POINTER || data[2] !== FORMAT_VERSION) continue;
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
