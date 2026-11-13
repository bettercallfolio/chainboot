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
  /** Requests per second this endpoint tolerates before it answers 429. */
  rps?: number;
}

interface Stored { raw: string; slot: number; accounts: string[] }

export class FakeChain {
  readonly txs = new Map<string, Stored>();
  readonly byAccount = new Map<string, string[]>();
  readonly faults = new Map<string, Faults>();
  genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  slot = 1000;
  balance = 10_000_000_000;
  requests = 0;
  readonly perUrl = new Map<string, number>();
  readonly #window = new Map<string, number[]>();

  urls(n: number): string[] { return Array.from({ length: n }, (_, i) => `http://rpc${i}.test/`); }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const f = this.faults.get(url) ?? {};
    this.requests++;
    this.perUrl.set(url, (this.perUrl.get(url) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, 1));
    if (f.rps) {
      const now = Date.now(), w = (this.#window.get(url) ?? []).filter((t) => now - t < 1000);
      w.push(now); this.#window.set(url, w);
      if (w.length > f.rps) return new Response("slow down", { status: 429 });
    }
    if (f.rateLimit && Math.random() < f.rateLimit) return new Response("slow down", { status: 429 });
    if (f.network && Math.random() < f.network) throw new TypeError("fetch failed");
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] };
    const result = this.#handle(req.method, req.params ?? [], f);
    return new Response(JSON.stringify("error" in result ? { jsonrpc: "2.0", id: req.id, error: result.error } : { jsonrpc: "2.0", id: req.id, result: result.result }), { status: 200 });
  };

  #handle(method: string, params: any[], f: Faults): { result: unknown } | { error: { code: number; message: string } } {
    this.slot++;
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
        if (!this.txs.has(sig)) {
          const accounts = tx.accountKeys.map((k) => b58encode(k));
          this.txs.set(sig, { raw: params[0], slot: this.slot, accounts });
          for (const a of accounts) { const l = this.byAccount.get(a) ?? []; l.unshift(sig); this.byAccount.set(a, l); }
          this.balance -= 5000;
        }
        return { result: sig };
      }
      case "getSignatureStatuses":
        return { result: { value: (params[0] as string[]).map((s) => (this.txs.has(s) ? { err: null, confirmationStatus: "finalized" } : null)) } };
      case "getTransaction": {
        let t = this.txs.get(params[0]);
        if (!t || (f.missing && Math.random() < f.missing)) return { result: null };
        if (f.corrupt && Math.random() < f.corrupt) t = [...this.txs.values()][Math.floor(Math.random() * this.txs.size)]!;
        return { result: { slot: t.slot, blockTime: 1_700_000_000 + t.slot, transaction: [t.raw, "base64"], meta: { err: null } } };
      }
      case "getSignaturesForAddress": {
        const list = this.byAccount.get(params[0]) ?? [];
        return { result: list.slice(0, params[1]?.limit ?? 1000).map((signature) => ({ signature, err: null, slot: this.txs.get(signature)!.slot })) };
      }
      default: return { error: { code: -32601, message: "Method not found" } };
    }
  }
}
