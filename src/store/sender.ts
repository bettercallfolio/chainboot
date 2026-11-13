// TxSender: lands many small transactions quickly and reliably.
//
// For every item it builds a transaction, sends it through the RPC pool, and then watches
// the signature until the network confirms it. A transaction that does not land before its
// blockhash expires is rebuilt with a fresh blockhash and sent again. Progress is written to
// an append-only journal, so an interrupted upload continues where it stopped and never
// pays twice for the same data.
import fs from "node:fs";
import path from "node:path";
import { b58decodeFixed } from "../util/base58.ts";
import { sha256, sleep, toHex } from "../util/bytes.ts";
import type { Keypair } from "../solana/keys.ts";
import { RpcError, type RpcPool } from "../solana/rpc.ts";
import { buildTransaction, type Instruction } from "../solana/tx.ts";

export type Commitment = "confirmed" | "finalized";

export interface SendItem {
  /** Instructions of the transaction (the payer is added automatically). */
  instructions: Instruction[];
  /** Stable identity of the content, used by the journal to skip work on resume. */
  key: string;
}

export interface SenderProgress { total: number; done: number; pending: number; resent: number; feeLamports: number }

export interface SenderOptions {
  commitment?: Commitment;
  /** Path of the resume journal (lines of "<key> <signature>"). */
  journal?: string;
  /** Most transactions in flight at once (default 4000). */
  maxPending?: number;
  onProgress?: (p: SenderProgress) => void;
  signal?: AbortSignal;
  /** Send an unconfirmed transaction again after this long (default 5000 ms). */
  resendAfterMs?: number;
  /** How often to ask the network about transactions in flight (default 500 ms). */
  pollMs?: number;
}

interface Pending {
  item: SendItem;
  index: number;
  signature: string;
  raw: string;
  lastValidBlockHeight: number;
  sentAt: number;
  lastSendAt: number;
  lastCheckAt: number;
  sends: number;
  confirmedAt: number; // >0 once "confirmed" was seen (while waiting for "finalized")
}

const LAMPORTS_PER_SIGNATURE = 5000;

export function itemKey(data: Uint8Array): string {
  return toHex(sha256(data));
}

export class Journal {
  readonly #path: string;
  readonly #known = new Map<string, string>();
  #fd: number | null = null;

  constructor(file: string) {
    this.#path = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const [k, s] = line.split(" ");
        if (k && s && /^[0-9a-f]{64}$/.test(k) && s.length >= 64) this.#known.set(k, s);
      }
    }
  }
  get(key: string): string | undefined { return this.#known.get(key); }
  forget(key: string): void { this.#known.delete(key); }
  set(key: string, signature: string): void {
    this.#known.set(key, signature);
    this.#fd ??= fs.openSync(this.#path, "a");
    fs.writeSync(this.#fd, `${key} ${signature}\n`);
  }
  close(): void { if (this.#fd !== null) { fs.closeSync(this.#fd); this.#fd = null; } }
}

export class TxSender {
  readonly #pool: RpcPool;
  readonly #payer: Keypair;
  #blockhash: { hash: Buffer; lastValidBlockHeight: number; at: number } | null = null;
  #height = 0;

  constructor(pool: RpcPool, payer: Keypair) {
    this.#pool = pool;
    this.#payer = payer;
  }

  async balance(): Promise<number> {
    const r = await this.#pool.call<{ value: number }>("getBalance", [this.#payer.address, { commitment: "confirmed" }], { urgent: true });
    return r.value;
  }

  async #refreshBlockhash(): Promise<void> {
    const r = await this.#pool.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
      "getLatestBlockhash", [{ commitment: "confirmed" }], { urgent: true, timeoutMs: 8000 });
    this.#blockhash = { hash: b58decodeFixed(r.value.blockhash, 32, "blockhash"), lastValidBlockHeight: r.value.lastValidBlockHeight, at: Date.now() };
  }

  async #refreshHeight(): Promise<void> {
    this.#height = await this.#pool.call<number>("getBlockHeight", [{ commitment: "confirmed" }], { urgent: true, timeoutMs: 8000 });
  }

  /**
   * Lands every item and returns the signatures in the same order.
   * Throws only for problems the user must fix (no funds, aborted, endpoints all dead).
   */
  async sendAll(items: SendItem[], opts: SenderOptions = {}): Promise<string[]> {
    const commitment = opts.commitment ?? "finalized";
    const maxPending = opts.maxPending ?? 4000;
    const resendAfter = opts.resendAfterMs ?? 5000, pollMs = opts.pollMs ?? 500;
    const journal = opts.journal ? new Journal(opts.journal) : null;
    const result: (string | null)[] = new Array(items.length).fill(null);
    const todo: number[] = [];
    const recheck: Pending[] = [];
    for (let i = 0; i < items.length; i++) {
      const known = journal?.get(items[i]!.key);
      if (known) recheck.push({ item: items[i]!, index: i, signature: known, raw: "", lastValidBlockHeight: 0, sentAt: 0, lastSendAt: 0, lastCheckAt: 0, sends: 0, confirmedAt: 0 });
      else todo.push(i);
    }
    let done = 0, resent = 0, fee = 0;
    const report = () => opts.onProgress?.({ total: items.length, done, pending: pending.size, resent, feeLamports: fee });

    // signatures recorded by an earlier run: keep those the chain still knows, redo the rest
    for (let at = 0; at < recheck.length; at += 256) {
      const batch = recheck.slice(at, at + 256);
      const st = await this.#statuses(batch.map((p) => p.signature), true);
      batch.forEach((p, i) => {
        const s = st[i];
        if (s && !s.err && (s.confirmationStatus === "finalized" || (commitment === "confirmed" && s.confirmationStatus === "confirmed"))) { result[p.index] = p.signature; done++; }
        else { journal?.forget(p.item.key); todo.push(p.index); }
      });
    }
    todo.sort((a, b) => a - b);
    const pending = new Map<number, Pending>();
    report();
    if (!todo.length) { journal?.close(); return result as string[]; }

    const need = todo.length * LAMPORTS_PER_SIGNATURE;
    const have = await this.balance();
    if (have < need) {
      journal?.close();
      throw new Error(`not enough SOL: this needs about ${(need / 1e9).toFixed(4)} SOL in fees but ${this.#payer.address} holds ${(have / 1e9).toFixed(4)} SOL`);
    }

    await Promise.all([this.#refreshBlockhash(), this.#refreshHeight()]);
    let stop = false, fatal: Error | null = null, wake: () => void = () => {};
    const stopped = new Promise<void>((r) => { wake = r; });
    const housekeeping = (async () => {
      let tick = 0;
      while (!stop) {
        await Promise.race([sleep(1000), stopped]);
        if (stop) break;
        tick++;
        try {
          if (tick % 4 === 0 || !this.#blockhash || Date.now() - this.#blockhash.at > 20_000) await this.#refreshBlockhash();
          if (tick % 2 === 0) await this.#refreshHeight();
        } catch { /* stale values are handled by the send loop */ }
      }
    })();

    let next = 0;
    const requeue: number[] = [];
    const launch = (index: number) => {
      const bh = this.#blockhash!;
      const tx = buildTransaction(this.#payer, items[index]!.instructions, bh.hash);
      const p: Pending = { item: items[index]!, index, signature: tx.signature, raw: tx.raw.toString("base64"), lastValidBlockHeight: bh.lastValidBlockHeight, sentAt: Date.now(), lastSendAt: Date.now(), lastCheckAt: Date.now() - pollMs / 2, sends: 1, confirmedAt: 0 };
      pending.set(index, p);
      this.#send(p).catch((e: Error) => {
        // not accepted by any endpoint: nothing was paid, simply try again
        if (pending.get(index) === p && !p.confirmedAt) { pending.delete(index); requeue.push(index); }
        if (e instanceof RpcError && e.kind === "invalid") fatal ??= new Error(`the network rejected a transaction: ${e.message}`);
      });
    };

    try {
      while (done < items.length) {
        if (opts.signal?.aborted) throw new Error("upload aborted");
        if (fatal) throw fatal;
        const now = Date.now();
        // 1. start new transactions while there is room and the blockhash is fresh
        const fresh = this.#blockhash && now - this.#blockhash.at < 45_000;
        let started = 0;
        while (fresh && pending.size < maxPending && started < 400) {
          const index = requeue.length ? requeue.shift()! : next < todo.length ? todo[next++]! : undefined;
          if (index === undefined) break;
          if (result[index] !== null || pending.has(index)) continue;
          launch(index); started++;
        }
        // 2. look at what happened to the ones in flight
        const waiting = [...pending.values()].filter((p) => now - p.lastCheckAt >= pollMs);
        for (const p of waiting) p.lastCheckAt = now;
        const batches: Pending[][] = [];
        for (let at = 0; at < waiting.length; at += 256) batches.push(waiting.slice(at, at + 256));
        await Promise.all(batches.map(async (batch) => {
          let st: (SigStatus | null)[];
          try { st = await this.#statuses(batch.map((p) => p.signature), false); } catch { return; }
          batch.forEach((p, i) => {
            if (pending.get(p.index) !== p) return;
            const s = st[i];
            if (s && s.err) { pending.delete(p.index); requeue.push(p.index); resent++; return; }
            const level = s?.confirmationStatus;
            if (level === "finalized" || (level === "confirmed" && commitment === "confirmed")) {
              pending.delete(p.index); result[p.index] = p.signature; done++; fee += LAMPORTS_PER_SIGNATURE;
              journal?.set(p.item.key, p.signature);
              return;
            }
            if (level === "confirmed") { p.confirmedAt ||= Date.now(); return; }
            if (p.confirmedAt) {
              // it was confirmed and then disappeared: the fork it was on was dropped
              if (Date.now() - p.confirmedAt > 90_000 && !s) { pending.delete(p.index); requeue.push(p.index); resent++; }
              return;
            }
            if (!s && this.#height > p.lastValidBlockHeight + 8) {
              // blockhash expired and the chain does not know the signature: it can never land
              pending.delete(p.index); requeue.push(p.index); resent++;
            } else if (!s && Date.now() - p.lastSendAt > resendAfter && p.sends < 12) {
              p.lastSendAt = Date.now(); p.sends++;
              this.#send(p).catch(() => {});
            }
          });
        }));
        report();
        await sleep(pending.size ? Math.min(200, pollMs) : 20);
      }
    } finally {
      stop = true; wake();
      await housekeeping;
      journal?.close();
    }
    report();
    return result as string[];
  }

  #send(p: Pending): Promise<unknown> {
    return this.#pool.call("sendTransaction", [p.raw, { encoding: "base64", skipPreflight: true, maxRetries: 0 }], { attempts: 4, timeoutMs: 10_000 });
  }

  async #statuses(signatures: string[], searchHistory: boolean): Promise<(SigStatus | null)[]> {
    const r = await this.#pool.call<{ value: (SigStatus | null)[] }>(
      "getSignatureStatuses", [signatures, { searchTransactionHistory: searchHistory }], { urgent: true, timeoutMs: 15_000 });
    if (!Array.isArray(r?.value) || r.value.length !== signatures.length) throw new Error("malformed getSignatureStatuses answer");
    return r.value;
  }
}

interface SigStatus { err: unknown; confirmationStatus?: "processed" | "confirmed" | "finalized" }
