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
import { buildNoopTransaction, type Carrier, type TxVersion } from "../solana/tx.ts";

export type Commitment = "confirmed" | "finalized";

export interface SendItem {
  /** Data of the transaction's Noop instruction. */
  data: Uint8Array;
  /** Read-only accounts to reference (used for tag addresses). */
  readonlyAccounts?: Uint8Array[];
  /** Stable identity of the content, used by the journal to skip work on resume. */
  key: string;
}

/** Where a transaction ended up. */
export interface Landed { signature: string; slot: number }

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
  /** Wire format of the transactions (default: v1, 4096 bytes). */
  txVersion?: TxVersion;
  /** Extra fee per transaction in lamports, to get ahead on a busy network (default 0). */
  priorityFeeLamports?: number;
  /** The program that carries the data (default: Noop). */
  carrier?: Carrier;
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

/**
 * The resume journal: lines of "<key> <signature>" for transactions that landed, and of
 * "<key> <signature> <last valid block height>" for transactions that were sent and not yet
 * seen to land. A later line for the same key replaces an earlier one.
 */
export class Journal {
  readonly #path: string;
  readonly #known = new Map<string, { signature: string; lastValid: number | null }>();
  #fd: number | null = null;

  constructor(file: string) {
    this.#path = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const [k, s, h] = line.split(" ");
        if (!k || !s || !/^[0-9a-f]{64}$/.test(k)) continue;
        // (a line cut off by a crash must not reach the network as a signature)
        try { b58decodeFixed(s, 64, "signature"); } catch { continue; }
        if (h !== undefined && !/^\d{1,15}$/.test(h)) continue;
        this.#known.set(k, { signature: s, lastValid: h === undefined ? null : Number(h) });
      }
    }
  }
  get(key: string): { signature: string; lastValid: number | null } | undefined { return this.#known.get(key); }
  forget(key: string): void { this.#known.delete(key); }
  #write(line: string): void {
    this.#fd ??= fs.openSync(this.#path, "a");
    fs.writeSync(this.#fd, line);
  }
  /** The transaction landed. */
  set(key: string, signature: string): void {
    this.#known.set(key, { signature, lastValid: null });
    this.#write(`${key} ${signature}\n`);
  }
  /** The transaction was sent: after an interruption it is looked for before the data is sent (and paid for) again. */
  sent(key: string, signature: string, lastValid: number): void {
    this.#known.set(key, { signature, lastValid });
    this.#write(`${key} ${signature} ${lastValid}\n`);
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
   * Lands every item and returns signature and slot of each, in the same order.
   * Throws only for problems the user must fix (no funds, aborted, endpoints all dead).
   */
  async sendAll(items: SendItem[], opts: SenderOptions = {}): Promise<Landed[]> {
    const commitment = opts.commitment ?? "finalized";
    const maxPending = opts.maxPending ?? 4000;
    const resendAfter = opts.resendAfterMs ?? 5000, pollMs = opts.pollMs ?? 500;
    const journal = opts.journal ? new Journal(opts.journal) : null;
    const result: (Landed | null)[] = new Array(items.length).fill(null);
    const feePerTx = LAMPORTS_PER_SIGNATURE + Math.max(0, opts.priorityFeeLamports ?? 0);
    const todo: number[] = [];
    const recheck: Pending[] = [];
    for (let i = 0; i < items.length; i++) {
      const known = journal?.get(items[i]!.key);
      if (known) recheck.push({ item: items[i]!, index: i, signature: known.signature, raw: "", lastValidBlockHeight: known.lastValid ?? 0, sentAt: 0, lastSendAt: 0, lastCheckAt: 0, sends: 0, confirmedAt: 0 });
      else todo.push(i);
    }
    let done = 0, resent = 0, fee = 0;
    const pending = new Map<number, Pending>();
    const report = () => opts.onProgress?.({ total: items.length, done, pending: pending.size, resent, feeLamports: fee });

    // Signatures recorded by an earlier run: keep those the chain knows, keep waiting for those
    // that may still land (sending them again would pay twice), redo the rest.
    if (recheck.length) await this.#refreshHeight();
    for (let at = 0; at < recheck.length; at += 256) {
      const batch = recheck.slice(at, at + 256);
      const st = await this.#statuses(batch.map((p) => p.signature), true);
      // "unknown" from one endpoint may only mean that it keeps no history: another one is asked before data is sent again
      const unknown = batch.map((_, i) => i).filter((i) => !st[i]);
      if (unknown.length && this.#pool.size > 1) {
        const second = await this.#statuses(unknown.map((i) => batch[i]!.signature), true, true).catch(() => null);
        if (second) unknown.forEach((i, k) => { st[i] = second[k] ?? null; });
      }
      batch.forEach((p, i) => {
        const s = st[i];
        if (s && !s.err && (s.confirmationStatus === "finalized" || (commitment === "confirmed" && s.confirmationStatus === "confirmed"))) { result[p.index] = { signature: p.signature, slot: s.slot }; done++; return; }
        // sent before the interruption and not failed: it is on its way, or its blockhash has not expired yet
        const flying = journal!.get(p.item.key)?.lastValid != null && !s?.err && (!!s || this.#height <= p.lastValidBlockHeight + 8);
        if (flying) { pending.set(p.index, { ...p, sentAt: Date.now(), lastSendAt: Date.now(), lastCheckAt: 0, sends: 12, confirmedAt: s?.confirmationStatus === "confirmed" ? Date.now() : 0 }); return; }
        journal?.forget(p.item.key); todo.push(p.index);
      });
    }
    todo.sort((a, b) => a - b);
    report();
    if (!todo.length && !pending.size) { journal?.close(); return result as Landed[]; }

    const need = todo.length * feePerTx;
    const have = todo.length ? await this.balance() : need;
    if (have < need) {
      journal?.close();
      throw new Error(`not enough SOL: this needs about ${(need / 1e9).toFixed(4)} SOL in fees but ${this.#payer.address} holds ${(have / 1e9).toFixed(4)} SOL`);
    }

    await Promise.all([this.#refreshBlockhash(), this.#refreshHeight()]);
    let stop = false, fatal: Error | null = null, wake: () => void = () => {};
    // when the network last answered anything: an upload does not wait forever on endpoints that are gone
    let heard = Date.now();
    const stopped = new Promise<void>((r) => { wake = r; });
    const housekeeping = (async () => {
      let tick = 0;
      while (!stop) {
        await Promise.race([sleep(1000), stopped]);
        if (stop) break;
        tick++;
        try {
          if (tick % 4 === 0 || !this.#blockhash || Date.now() - this.#blockhash.at > 20_000) { await this.#refreshBlockhash(); heard = Date.now(); }
          if (tick % 2 === 0) { await this.#refreshHeight(); heard = Date.now(); }
        } catch { /* stale values are handled by the send loop */ }
      }
    })();

    let next = 0;
    const requeue: number[] = [];
    /** How often each item landed on chain and failed there. */
    const failed = new Map<number, number>();
    const launch = (index: number) => {
      const bh = this.#blockhash!;
      const tx = buildNoopTransaction(this.#payer, items[index]!.data, bh.hash, { version: opts.txVersion, readonlyAccounts: items[index]!.readonlyAccounts, priorityFeeLamports: opts.priorityFeeLamports, carrier: opts.carrier });
      const p: Pending = { item: items[index]!, index, signature: tx.signature, raw: tx.raw.toString("base64"), lastValidBlockHeight: bh.lastValidBlockHeight, sentAt: Date.now(), lastSendAt: Date.now(), lastCheckAt: Date.now() - pollMs / 2, sends: 1, confirmedAt: 0 };
      pending.set(index, p);
      journal?.sent(p.item.key, p.signature, p.lastValidBlockHeight);
      this.#send(p).then(() => { heard = Date.now(); }, (e: Error) => {
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
        if (now - heard > 120_000) throw new Error(`no RPC endpoint has answered for two minutes. ${done} of ${items.length} transactions are stored${journal ? "; run the command again to continue from there" : ""}.`);
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
        // (a transaction that an earlier run sent can only be waited for: it is asked about once a second, not more)
        const waiting = [...pending.values()].filter((p) => now - p.lastCheckAt >= (p.raw ? pollMs : Math.max(pollMs, 1000)));
        for (const p of waiting) p.lastCheckAt = now;
        const batches: Pending[][] = [];
        for (let at = 0; at < waiting.length; at += 256) batches.push(waiting.slice(at, at + 256));
        await Promise.all(batches.map(async (batch) => {
          let st: (SigStatus | null)[];
          try { st = await this.#statuses(batch.map((p) => p.signature), false); heard = Date.now(); } catch { return; }
          batch.forEach((p, i) => {
            if (pending.get(p.index) !== p) return;
            const s = st[i];
            if (s && s.err) {
              // It landed and failed: the fee is paid and the data is not stored. What a data
              // transaction does is the same every time, so sending it again and again would
              // only pay again and again. One more try, then stop and say why.
              pending.delete(p.index);
              const failures = (failed.get(p.index) ?? 0) + 1;
              failed.set(p.index, failures);
              if (failures >= 2) { fatal ??= new Error(`a transaction failed on chain twice and was not sent a third time: ${JSON.stringify(s.err)} (${p.signature})`); return; }
              requeue.push(p.index); resent++;
              return;
            }
            const level = s?.confirmationStatus;
            if (level === "finalized" || (level === "confirmed" && commitment === "confirmed")) {
              pending.delete(p.index); result[p.index] = { signature: p.signature, slot: s!.slot }; done++; fee += feePerTx;
              journal?.set(p.item.key, p.signature);
              return;
            }
            if (level === "confirmed") { p.confirmedAt ||= Date.now(); return; }
            if (p.confirmedAt) {
              // it was confirmed and then disappeared: the fork it was on was dropped
              if (Date.now() - p.confirmedAt > 90_000 && !s) { pending.delete(p.index); requeue.push(p.index); resent++; }
              return;
            }
            if (!s && (this.#height > p.lastValidBlockHeight + 8 || (!p.raw && Date.now() - p.sentAt > resendAfter * 24))) {
              // blockhash expired and the chain does not know the signature: it can never land
              // (one that an earlier run sent is also given up after two minutes, the time in which any blockhash expires)
              pending.delete(p.index); requeue.push(p.index); resent++;
            } else if (!s && p.raw && Date.now() - p.lastSendAt > resendAfter && p.sends < 12) {
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
    return result as Landed[];
  }

  #send(p: Pending): Promise<unknown> {
    return this.#pool.call("sendTransaction", [p.raw, { encoding: "base64", skipPreflight: true, maxRetries: 0 }], { attempts: 4, timeoutMs: 10_000 });
  }

  /** `known`: only an answer that knows every signature counts (other endpoints are asked until one does). */
  async #statuses(signatures: string[], searchHistory: boolean, known = false): Promise<(SigStatus | null)[]> {
    const accept = (answer: unknown) => { const v = (answer as { value?: unknown[] } | null)?.value; return Array.isArray(v) && v.every((x) => x !== null); };
    const r = await this.#pool.call<{ value: (SigStatus | null)[] }>(
      "getSignatureStatuses", [signatures, { searchTransactionHistory: searchHistory }], { urgent: true, timeoutMs: 15_000, ...(known && { accept, attempts: Math.min(this.#pool.size, 4) }) });
    if (!Array.isArray(r?.value) || r.value.length !== signatures.length) throw new Error("malformed getSignatureStatuses answer");
    return r.value;
  }
}

/**
 * Sends one ordinary transaction (for example a transfer) and waits until the network confirms it.
 * `build` is called with a fresh blockhash, again if the first attempt expires.
 */
export async function sendAndConfirm(pool: RpcPool, build: (blockhash: Buffer) => { signature: string; raw: Buffer }, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "the network did not confirm the transaction in time";
  while (Date.now() < deadline) {
    const bh = await pool.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }], { urgent: true });
    const tx = build(b58decodeFixed(bh.value.blockhash, 32, "blockhash"));
    try {
      await pool.call("sendTransaction", [tx.raw.toString("base64"), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }], { attempts: 4, timeoutMs: 15_000 });
    } catch (e) {
      // a simulation failure (no funds, bad account) will not get better by trying again
      if (/simulation failed|insufficient|invalid/i.test((e as Error).message)) throw new Error(`the network rejected the transaction: ${(e as Error).message}`);
      lastError = (e as Error).message;
    }
    for (let i = 0; i < 60 && Date.now() < deadline; i++) {
      await sleep(500);
      const st = (await pool.call<{ value: (SigStatus | null)[] }>("getSignatureStatuses", [[tx.signature]], { urgent: true }).catch(() => ({ value: [null] }))).value[0];
      if (st?.err) throw new Error(`the transaction failed on chain: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return tx.signature;
      if (!st && i > 10) {
        const height = await pool.call<number>("getBlockHeight", [{ commitment: "confirmed" }], { urgent: true }).catch(() => 0);
        if (height > bh.value.lastValidBlockHeight) break; // expired: sign again with a new blockhash
      }
    }
  }
  throw new Error(lastError);
}

interface SigStatus { slot: number; err: unknown; confirmationStatus?: "processed" | "confirmed" | "finalized" }
