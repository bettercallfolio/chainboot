// An in-memory stand-in for a Solana RPC node, with switchable faults, so the tests need no network.
import { b58encode } from "../../src/util/base58.ts";
import { parseTransaction, verifyPayerSignature } from "../../src/solana/tx.ts";

export interface Faults {
  /** Probability that a request is answered with HTTP 429. */
  rateLimit?: number;
  /** Probability that a request fails with a network error. */
  network?: number;
  /** Probability that getTransaction answers null although the transaction exists. */
  missing?: number;
  /** Probability that getTransaction returns another transaction's bytes. */
  corrupt?: number;
  /** Probability that an accepted transaction is silently dropped (never lands). */
  drop?: number;
  /** Calls per second this endpoint tolerates before it answers 429. */
  rps?: number;
  /** getSignaturesForAddress leaves out this many of the newest entries (an endpoint that is behind, or hides them). */
  hideNewest?: number;
  /** getSignaturesForAddress puts a signature that does not exist at the top (an endpoint that makes things up). */
  inventNewest?: boolean;
  /** getSignaturesForAddress puts these real signatures at the top with a slot from the future (an endpoint that passes off old or unrelated records as the newest). */
  promote?: string[];
  /** Every answer takes this long (a slow or stuck endpoint). */
  delayMs?: number;
  /** The endpoint does not offer getBlock. */
  noBlocks?: boolean;
  /** getAccountInfo answers with the account as it was before its last change (an endpoint that is behind). */
  staleAccounts?: boolean;
  /** getAccountInfo answers with an account whose data somebody made up. */
  forgeAccounts?: boolean;
  /** The endpoint refuses JSON-RPC batches. */
  noBatch?: boolean;
  /** Probability that one call inside a batch is answered with a 429 error object. */
  itemLimit?: number;
}

interface Req { id: number; method: string; params: any[] }
/** An account as the Record program keeps it: [version 1][authority 32][data]. */
interface Account { owner: string; lamports: number; data: Buffer; previous: Buffer | null }
const SYSTEM = "11111111111111111111111111111111", RECORD = "recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5";
interface Stored { raw: string; slot: number; accounts: string[] }

export class FakeChain {
  readonly txs = new Map<string, Stored>();
  readonly byAccount = new Map<string, string[]>();
  /** Accounts that hold data (created through the system program, written by the Record program). */
  readonly accounts = new Map<string, Account>();
  readonly faults = new Map<string, Faults>();
  genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  /** Slots advance with time (one every `slotMs`), so transactions sent together share a block like on a real chain. */
  slotMs = 20;
  readonly #t0 = Date.now();
  get slot(): number { return 1000 + Math.floor((Date.now() - this.#t0) / this.slotMs); }
  blockCalls = 0;
  /** When set, every transaction lands but fails on chain with this error (the fee is still charged). */
  failOnChain: unknown = null;
  readonly failedTxs = new Set<string>();
  balance = 10_000_000_000;
  requests = 0;
  /** Lamports the chain charged for all transactions so far. */
  fees = 0;
  calls = 0;
  batches = 0;
  readonly perUrl = new Map<string, number>();
  readonly perUrlCalls = new Map<string, number>();
  readonly #window = new Map<string, number[]>();

  urls(n: number): string[] { return Array.from({ length: n }, (_, i) => `http://rpc${i}.test/`); }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const f = this.faults.get(url) ?? {};
    this.requests++;
    this.perUrl.set(url, (this.perUrl.get(url) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, f.delayMs ?? 1));
    const parsed = JSON.parse(String(init?.body)) as Req | Req[];
    const reqs = Array.isArray(parsed) ? parsed : [parsed];
    if (Array.isArray(parsed)) {
      this.batches++;
      if (f.noBatch) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not allowed" } }), { status: 400 });
    }
    if (f.rps) {
      const now = Date.now(), w = (this.#window.get(url) ?? []).filter((t) => now - t < 1000);
      for (const _ of reqs) w.push(now);
      this.#window.set(url, w);
      if (w.length > f.rps) return new Response("slow down", { status: 429 });
    }
    if (f.rateLimit && Math.random() < f.rateLimit) return new Response("slow down", { status: 429 });
    if (f.network && Math.random() < f.network) throw new TypeError("fetch failed");
    this.perUrlCalls.set(url, (this.perUrlCalls.get(url) ?? 0) + reqs.length);
    const answers = reqs.map((req) => {
      this.calls++;
      if (f.itemLimit && Math.random() < f.itemLimit) return { jsonrpc: "2.0", id: req.id, error: { code: 429, message: "Too many requests for a specific RPC call" } };
      const result = this.#handle(req.method, req.params ?? [], f);
      return "error" in result ? { jsonrpc: "2.0", id: req.id, error: result.error } : { jsonrpc: "2.0", id: req.id, result: result.result };
    });
    return new Response(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]), { status: 200 });
  };

  /** Priority fee carried in the header of a v1 transaction (bits 0 and 1 of the config mask). */
  #tip(raw: Buffer, version: unknown): number {
    if (version !== 1 || (raw.readUInt32LE(4) & 3) !== 3) return 0;
    const keys = raw[41]!;
    return Number(raw.readBigUInt64LE(42 + 32 * keys));
  }

  /** A lying node: keeps the signature and payer of a transaction but swaps in another transaction's body. */
  #forge(raw: string, all: Stored[]): string {
    const a = Buffer.from(raw, "base64"), b = Buffer.from(all[Math.floor(Math.random() * all.length)]!.raw, "base64");
    if (a.length !== b.length || a[0] !== 0x81 || b[0] !== 0x81) return raw;
    const out = Buffer.from(b);
    a.copy(out, out.length - 64, a.length - 64); // the original signature
    return out.toString("base64");
  }

  /**
   * Runs the instructions that change accounts: the system program's CreateAccountWithSeed and
   * the Record program's Initialize, Write and CloseAccount. Returns what went wrong, or null.
   * All of a transaction's changes happen, or none.
   */
  #execute(tx: ReturnType<typeof parseTransaction>): string | null {
    const staged = new Map<string, Account | null>();
    const get = (addr: string) => (staged.has(addr) ? staged.get(addr)! : this.accounts.get(addr) ?? null);
    const signers = new Set(tx.accountKeys.slice(0, tx.header.numSigners).map((k) => b58encode(k)));
    for (const ix of tx.instructions) {
      const program = b58encode(ix.programId), keys = ix.accounts.map((k) => b58encode(k)), d = Buffer.from(ix.data);
      if (program === SYSTEM && d.length >= 4 && d.readUInt32LE(0) === 3) {
        const seedLen = Number(d.readBigUInt64LE(36)), at = 44 + seedLen;
        const lamports = Number(d.readBigUInt64LE(at)), space = Number(d.readBigUInt64LE(at + 8)), owner = b58encode(d.subarray(at + 16, at + 48));
        if (!signers.has(b58encode(d.subarray(4, 36)))) return "the base of a derived address must sign";
        if (get(keys[1]!)) return "account already in use";
        if (lamports < (128 + space) * 6960) return "insufficient funds for rent";
        staged.set(keys[1]!, { owner, lamports, data: Buffer.alloc(space), previous: null });
      } else if (program === RECORD) {
        const a = get(keys[0]!);
        if (!a || a.owner !== RECORD) return "the account does not belong to the Record program";
        const next: Account = { ...a, data: Buffer.from(a.data), previous: a.data };
        if (d[0] === 0) {
          if (a.data[0] !== 0) return "account already initialized";
          next.data[0] = 1; Buffer.from(ix.accounts[1]!).copy(next.data, 1);
        } else {
          if (a.data[0] !== 1 || !Buffer.from(ix.accounts[1]!).equals(a.data.subarray(1, 33)) || !signers.has(keys[1]!)) return "the record's authority must sign";
          if (d[0] === 1) {
            const offset = Number(d.readBigUInt64LE(1)), len = d.readUInt32LE(9);
            if (33 + offset + len > a.data.length) return "the write goes past the end of the account";
            d.copy(next.data, 33 + offset, 13, 13 + len);
          } else if (d[0] === 3) { staged.set(keys[0]!, null); continue; }
          else return "unknown Record instruction";
        }
        staged.set(keys[0]!, next);
      }
    }
    for (const [addr, a] of staged) { if (a) this.accounts.set(addr, a); else this.accounts.delete(addr); }
    return null;
  }

  #handle(method: string, params: any[], f: Faults): { result: unknown } | { error: { code: number; message: string } } {
    switch (method) {
      case "getGenesisHash": return { result: this.genesis };
      case "getBalance": return { result: { value: this.balance } };
      case "getLatestBlockhash": return { result: { value: { blockhash: b58encode(Buffer.alloc(32, this.slot & 0xff)), lastValidBlockHeight: this.slot + 150 } } };
      case "getBlockHeight": return { result: this.slot };
      case "sendTransaction": {
        const raw = Buffer.from(params[0], "base64");
        let tx;
        try { tx = parseTransaction(raw); } catch (e) { return { error: { code: -32602, message: `invalid transaction: ${(e as Error).message}` } }; }
        if (!verifyPayerSignature(tx)) return { error: { code: -32602, message: "signature verification failed" } };
        const sig = b58encode(tx.signatures[0]!);
        if (f.drop && Math.random() < f.drop) return { result: sig };
        if (this.failOnChain && !this.failedTxs.has(sig)) { this.failedTxs.add(sig); this.fees += 5000; this.balance -= 5000; return { result: sig }; }
        if (this.failedTxs.has(sig)) return { result: sig };
        if (!this.txs.has(sig)) {
          const failure = this.#execute(tx);
          if (failure) return { error: { code: -32002, message: `Transaction simulation failed: ${failure}` } };
          this.fees += 5000 + this.#tip(raw, tx.version);
          const accounts = tx.accountKeys.map((k) => b58encode(k));
          this.txs.set(sig, { raw: params[0], slot: this.slot, accounts });
          for (const a of accounts) { const l = this.byAccount.get(a) ?? []; l.unshift(sig); this.byAccount.set(a, l); }
          this.balance -= 5000;
        }
        return { result: sig };
      }
      case "getAccountInfo": {
        const a = this.accounts.get(params[0]);
        if (!a) return { result: { context: { slot: this.slot }, value: null } };
        let data = a.data;
        if (f.staleAccounts) { if (!a.previous) return { result: { context: { slot: this.slot }, value: null } }; data = a.previous; }
        if (f.forgeAccounts) { data = Buffer.from(data); for (let i = 50; i < Math.min(data.length, 90); i++) data[i] = data[i]! ^ 0x5a; }
        return { result: { context: { slot: this.slot }, value: { owner: a.owner, lamports: a.lamports, executable: false, data: [data.toString("base64"), "base64"] } } };
      }
      case "getMinimumBalanceForRentExemption": return { result: (128 + Number(params[0])) * 6960 };
      case "getSignatureStatuses":
        return { result: { value: (params[0] as string[]).map((s) => (this.failedTxs.has(s) ? { slot: this.slot, err: this.failOnChain ?? { InstructionError: [0, "ProgramFailedToComplete"] }, confirmationStatus: "finalized" } : this.txs.has(s) ? { slot: this.txs.get(s)!.slot, err: null, confirmationStatus: "finalized" } : null)) } };
      case "getBlock": {
        this.blockCalls++;
        if (f.noBlocks) return { error: { code: -32601, message: "Method not found" } };
        const slot = params[0] as number;
        let list = [...this.txs.values()].filter((t) => t.slot === slot);
        if (f.missing && Math.random() < f.missing) list = list.slice(0, Math.floor(list.length / 2));
        const all = [...this.txs.values()];
        return { result: { blockhash: "x", transactions: list.map((t) => ({ transaction: [f.corrupt && Math.random() < f.corrupt ? this.#forge(t.raw, all) : t.raw, "base64"], meta: { err: null } })) } };
      }
      case "getTransaction": {
        let t = this.txs.get(params[0]);
        if (!t || (f.missing && Math.random() < f.missing)) return { result: null };
        let raw = t.raw;
        if (f.corrupt && Math.random() < f.corrupt) raw = Math.random() < 0.5 ? [...this.txs.values()][Math.floor(Math.random() * this.txs.size)]!.raw : this.#forge(t.raw, [...this.txs.values()]);
        return { result: { slot: t.slot, blockTime: 1_700_000_000 + t.slot, transaction: [raw, "base64"], meta: { err: null } } };
      }
      case "getSignaturesForAddress": {
        let list = (this.byAccount.get(params[0]) ?? []).slice(f.hideNewest ?? 0);
        const before = params[1]?.before as string | undefined;
        if (before) list = list.includes(before) ? list.slice(list.indexOf(before) + 1) : [];
        const entries = list.slice(0, params[1]?.limit ?? 1000).map((signature) => ({ signature, err: null, slot: this.txs.get(signature)!.slot }));
        if (f.inventNewest && !before) entries.unshift({ signature: b58encode(Buffer.alloc(64, 7)), err: null, slot: this.slot + 1000 });
        if (f.promote && !before) entries.unshift(...f.promote.map((signature, i) => ({ signature, err: null, slot: this.slot + 2000 - i })));
        return { result: entries };
      }
      default: return { error: { code: -32601, message: "Method not found" } };
    }
  }
}
