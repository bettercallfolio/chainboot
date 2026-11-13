// RpcPool: talk to many Solana RPC endpoints at once, as fast as each one allows.
//
// Every endpoint has its own speed limit that the pool *learns*:
//   - it starts slowly and speeds up while requests succeed (slow start, like TCP),
//   - on "429 Too Many Requests" it backs off and then climbs again gently,
//   - an endpoint that fails or times out rests for a moment and the work moves to the others.
// Requests wait in one queue and go to whichever endpoint has room, so one slow or
// rate-limited endpoint never becomes a bottleneck. Nothing here prints API keys.
import { sleep } from "../util/bytes.ts";

export type RpcErrorKind = "rate-limit" | "network" | "server" | "unsupported" | "rpc" | "invalid" | "exhausted";

export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  readonly code?: number;
  constructor(kind: RpcErrorKind, message: string, code?: number) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    this.code = code;
  }
}

export interface RpcPoolOptions {
  /** Hard cap on parallel requests per endpoint (default 48). */
  maxInflight?: number;
  /** Per-request timeout in milliseconds (default 20000). */
  timeoutMs?: number;
  /** Requests per second each endpoint starts with (default 8). */
  initialRate?: number;
  /** Upper bound for the learned requests per second of one endpoint (default 2000). */
  maxRate?: number;
  /** Called with human-readable notes (endpoint cooled down, disabled, ...). */
  onNote?: (text: string) => void;
  /** Replaceable for tests. */
  fetch?: typeof fetch;
}

export interface CallOptions {
  /** How many endpoint attempts in total before giving up (default: 4 per endpoint, at least 8). */
  attempts?: number;
  timeoutMs?: number;
  /** Return false to treat a result as "this endpoint does not have it" and ask another one. */
  accept?: (result: unknown) => boolean;
  /** Give up at this time (ms since epoch) even if attempts are left. */
  deadline?: number;
  /** Jump the queue (used for blockhash / status calls while bulk work is queued). */
  urgent?: boolean;
}

export interface EndpointStats {
  label: string;
  state: "active" | "cooling" | "disabled";
  rate: number;
  inflight: number;
  ok: number;
  rateLimited: number;
  errors: number;
  latencyMs: number;
  lastError: string;
}

interface Endpoint {
  url: string;
  label: string;
  inflight: number;
  rate: number;          // learned requests/second
  slowStart: boolean;    // true until the first 429
  tokens: number;
  refilledAt: number;
  coolUntil: number;
  failStreak: number;
  lastRateLimit: number;
  usedThisWindow: number;
  windowStart: number;
  latency: number;
  ok: number;
  rateLimited: number;
  errors: number;
  lastError: string;
  unsupported: Map<string, number>; // method -> retry-after timestamp
  noData: Set<string>;              // methods banned only because answers were empty (soft ban)
  misses: number;                   // "not found here" answers since the last hit
  disabledUntil: number;
  removed: boolean;                 // wrong network or dead at start-up: never used
}

interface Job {
  method: string;
  params: unknown;
  opts: CallOptions;
  tried: Set<Endpoint>;
  attemptsLeft: number;
  rounds: number;
  notBefore: number;
  lastError: RpcError | null;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export const GENESIS = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;
export type Cluster = keyof typeof GENESIS;

export function clusterName(genesisHash: string): string {
  for (const [name, hash] of Object.entries(GENESIS)) if (hash === genesisHash) return name;
  return `unknown network ${genesisHash.slice(0, 8)}…`;
}

/** Hides credentials: keeps the host, drops path/query secrets. */
export function maskRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^[a-z0-9-]{12,}\./i, "…."); // long random subdomains are keys too
    const hasSecret = u.search.length > 1 || u.pathname.length > 1 || u.username !== "";
    return host + (hasSecret ? "/…" : "");
  } catch { return "invalid-url"; }
}

export class RpcPool {
  readonly #eps: Endpoint[];
  readonly #queue: Job[] = [];
  readonly #urgent: Job[] = [];
  readonly #o: Required<Omit<RpcPoolOptions, "onNote" | "fetch">>;
  readonly #note: (t: string) => void;
  readonly #fetch: typeof fetch;
  #timer: NodeJS.Timeout | null = null;
  #id = 0;

  constructor(urls: string[], options: RpcPoolOptions = {}) {
    const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    for (const u of unique) {
      let ok = false;
      try { ok = /^https?:$/.test(new URL(u).protocol); } catch { /* reported below */ }
      if (!ok) throw new Error(`not a valid RPC URL (must start with http:// or https://): ${maskRpcUrl(u)}`);
    }
    if (!unique.length) throw new Error("no RPC endpoints configured. Add one with: chainboot rpc add <url>");
    this.#o = { maxInflight: options.maxInflight ?? 48, timeoutMs: options.timeoutMs ?? 20000, initialRate: options.initialRate ?? 8, maxRate: options.maxRate ?? 2000 };
    this.#note = options.onNote ?? (() => {});
    this.#fetch = options.fetch ?? fetch;
    const now = Date.now();
    this.#eps = unique.map((url) => ({
      url, label: maskRpcUrl(url), inflight: 0, rate: this.#o.initialRate, slowStart: true, tokens: Math.min(4, this.#o.initialRate),
      refilledAt: now, coolUntil: 0, failStreak: 0, lastRateLimit: 0, usedThisWindow: 0, windowStart: now, latency: 0,
      ok: 0, rateLimited: 0, errors: 0, lastError: "", unsupported: new Map(), noData: new Set(), misses: 0, disabledUntil: 0, removed: false,
    }));
    // distinguish endpoints that share a host (several keys of one provider)
    const seen = new Map<string, number>();
    for (const e of this.#eps) { const n = (seen.get(e.label) ?? 0) + 1; seen.set(e.label, n); if (n > 1) e.label += ` #${n}`; }
  }

  get size(): number { return this.#eps.filter((e) => !e.removed).length; }

  /**
   * Asks every endpoint which network it serves and drops the ones that are unreachable or on
   * a different network than `genesisHash`. Mixing networks would silently break uploads, so
   * call this once before real work. Returns one line per endpoint for display.
   */
  async probe(genesisHash?: string): Promise<{ label: string; ok: boolean; detail: string }[]> {
    const report = await Promise.all(this.#eps.map(async (e) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const g = await this.#request(e, "getGenesisHash", [], 8000);
          if (typeof g !== "string") throw new RpcError("server", "malformed answer");
          if (genesisHash && g !== genesisHash) { e.removed = true; return { label: e.label, ok: false, detail: `different network (${clusterName(g)})` }; }
          return { label: e.label, ok: true, detail: clusterName(g) };
        } catch (err) {
          if (attempt < 2 && (err as RpcError).kind !== "unsupported") { await sleep(400 * (attempt + 1)); continue; }
          e.removed = true;
          return { label: e.label, ok: false, detail: (err as Error).message };
        }
      }
    }));
    if (!this.size) throw new Error("none of the configured RPC endpoints is usable:\n" + report.map((r) => `  ${r.label}: ${r.detail}`).join("\n"));
    return report;
  }

  stats(): EndpointStats[] {
    const now = Date.now();
    return this.#eps.filter((e) => !e.removed).map((e) => ({
      label: e.label, state: e.disabledUntil > now ? "disabled" : e.coolUntil > now ? "cooling" : "active",
      rate: Math.round(e.rate * 10) / 10, inflight: e.inflight, ok: e.ok, rateLimited: e.rateLimited, errors: e.errors,
      latencyMs: Math.round(e.latency), lastError: e.lastError,
    }));
  }

  /** One JSON-RPC call, retried across endpoints until it succeeds or attempts run out. */
  call<T = unknown>(method: string, params: unknown = [], opts: CallOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        method, params, opts, tried: new Set(), rounds: 0, notBefore: 0, lastError: null,
        attemptsLeft: opts.attempts ?? Math.max(8, this.#eps.length * 4),
        resolve: resolve as (v: unknown) => void, reject,
      };
      (opts.urgent ? this.#urgent : this.#queue).push(job);
      this.#pump();
    });
  }

  /** Sends the same request to up to `fanout` endpoints at once; resolves with the first success. */
  async broadcast<T = unknown>(method: string, params: unknown, fanout = 2, timeoutMs = 10000): Promise<T> {
    const now = Date.now();
    const usable = this.#eps.filter((e) => !e.removed && e.disabledUntil <= now && e.coolUntil <= now && !this.#isUnsupported(e, method, now));
    const pool = (usable.length ? usable : this.#eps.filter((e) => !e.removed)).slice().sort((a, b) => a.inflight / this.#o.maxInflight - b.inflight / this.#o.maxInflight || a.latency - b.latency);
    const targets = pool.slice(0, Math.max(1, fanout));
    let lastErr: Error | null = null;
    return new Promise<T>((resolve, reject) => {
      let left = targets.length, done = false;
      for (const ep of targets) {
        this.#takeToken(ep, Date.now(), true);
        this.#request(ep, method, params, timeoutMs).then(
          (r) => { this.#onSuccess(ep); if (!done) { done = true; resolve(r as T); } },
          (e: RpcError) => { this.#onFailure(ep, method, e); lastErr = e; },
        ).finally(() => { if (--left === 0 && !done) reject(lastErr ?? new RpcError("exhausted", "broadcast failed")); this.#pump(); });
      }
    });
  }

  // ---- scheduling ----

  #isUnsupported(e: Endpoint, method: string, now: number): boolean {
    const until = e.unsupported.get(method);
    if (until === undefined) return false;
    if (until <= now) { e.unsupported.delete(method); e.noData.delete(method); return false; }
    return true;
  }

  #refill(e: Endpoint, now: number): void {
    const dt = (now - e.refilledAt) / 1000;
    if (dt <= 0) return;
    e.refilledAt = now;
    // burst allowance: at most ~1/4 second of traffic, never less than one request
    e.tokens = Math.min(e.tokens + dt * e.rate, Math.max(1, e.rate / 4));
    if (now - e.windowStart >= 1000) {
      // grow only when the limit was actually in use, otherwise an idle endpoint would look infinitely fast
      const busy = e.usedThisWindow >= e.rate * 0.7 * ((now - e.windowStart) / 1000);
      if (busy && now - e.lastRateLimit > 2000 && e.failStreak === 0) {
        e.rate = Math.min(this.#o.maxRate, e.slowStart ? e.rate * 1.5 : e.rate + Math.max(0.5, e.rate * 0.03));
      }
      e.usedThisWindow = 0; e.windowStart = now;
    }
  }

  #takeToken(e: Endpoint, now: number, force = false): boolean {
    this.#refill(e, now);
    if (!force && e.tokens < 1) return false;
    e.tokens -= 1; e.usedThisWindow++;
    return true;
  }

  #pick(job: Job, now: number): Endpoint | "wait" | null {
    let best: Endpoint | null = null, anyAllowed = false, bestLoad = Infinity;
    for (const e of this.#eps) {
      if (e.removed || e.disabledUntil > now || this.#isUnsupported(e, job.method, now)) continue;
      if (job.tried.has(e)) continue;
      anyAllowed = true;
      if (e.coolUntil > now || e.inflight >= this.#o.maxInflight) continue;
      this.#refill(e, now);
      if (e.tokens < 1) continue;
      const load = e.inflight / Math.max(1, e.rate) + e.latency / 1e6;
      if (load < bestLoad) { bestLoad = load; best = e; }
    }
    if (best) return best;
    return anyAllowed ? "wait" : null;
  }

  #pump(): void {
    const now = Date.now();
    for (const queue of [this.#urgent, this.#queue]) {
      let scanned = 0;
      for (let i = 0; i < queue.length && scanned < 64; i++) {
        const job = queue[i]!;
        if (job.opts.deadline !== undefined && now > job.opts.deadline) {
          queue.splice(i--, 1);
          job.reject(job.lastError ?? new RpcError("exhausted", `${job.method}: timed out waiting for an RPC endpoint`));
          continue;
        }
        if (job.notBefore > now) { scanned++; continue; }
        let pick = this.#pick(job, now);
        if (pick === null) {
          const usable = this.#eps.filter((e) => !e.removed);
          const hard = (e: Endpoint) => (e.unsupported.get(job.method) ?? 0) > now && !e.noData.has(job.method);
          if (usable.some(hard) && usable.every((e) => hard(e) || e.failStreak >= 3)) {
            // no endpoint offers this method at all: waiting will not help
            queue.splice(i--, 1);
            job.reject(new RpcError("exhausted", `${job.method} failed on every RPC endpoint (last error: ${job.lastError?.message ?? "method not supported"})`));
            continue;
          }
          // every endpoint was tried (or is resting) in this round: start a new round after a short pause
          job.tried.clear(); job.rounds++;
          if (!usable.some((e) => e.disabledUntil <= now && !this.#isUnsupported(e, job.method, now))) {
            // only soft bans are left: lift them rather than fail a job that may still succeed
            for (const e of usable) { e.disabledUntil = 0; if (e.noData.delete(job.method)) e.unsupported.delete(job.method); }
          }
          job.notBefore = now + Math.min(4000, 150 * 2 ** Math.min(job.rounds, 5));
          scanned++;
          continue;
        }
        if (pick === "wait") { scanned++; continue; }
        queue.splice(i--, 1);
        this.#run(pick, job);
      }
    }
    this.#arm();
  }

  #arm(): void {
    if (this.#timer || (!this.#queue.length && !this.#urgent.length)) return;
    this.#timer = setTimeout(() => { this.#timer = null; this.#pump(); }, 15);
  }

  #run(ep: Endpoint, job: Job): void {
    this.#takeToken(ep, Date.now(), true);
    job.tried.add(ep);
    job.attemptsLeft--;
    this.#request(ep, job.method, job.params, job.opts.timeoutMs ?? this.#o.timeoutMs).then(
      (result) => {
        if (job.opts.accept && !job.opts.accept(result)) {
          // a well-formed "I don't have it": not a fault, but remember endpoints that never have it
          ep.ok++;
          if (++ep.misses >= 200 && this.#eps.length > 1) {
            ep.misses = 0;
            ep.unsupported.set(job.method, Date.now() + 10 * 60_000); ep.noData.add(job.method);
            this.#note(`${ep.label}: no data for ${job.method} (no ledger history?), skipping it for 10 minutes`);
          }
          this.#retry(job, new RpcError("exhausted", `${job.method}: not found on any RPC endpoint`));
          return;
        }
        ep.misses = 0;
        this.#onSuccess(ep);
        job.resolve(result);
      },
      (err: RpcError) => {
        this.#onFailure(ep, job.method, err);
        if (err.kind === "invalid") { job.reject(err); return; }
        this.#retry(job, err);
      },
    ).finally(() => this.#pump());
  }

  #retry(job: Job, err: RpcError): void {
    job.lastError = err;
    if (job.attemptsLeft <= 0) {
      job.reject(new RpcError("exhausted", `${job.method} failed on every RPC endpoint (last error: ${err.message})`, err.code));
      return;
    }
    (job.opts.urgent ? this.#urgent : this.#queue).unshift(job);
  }

  #onSuccess(ep: Endpoint): void {
    ep.ok++; ep.failStreak = 0;
  }

  #onFailure(ep: Endpoint, method: string, err: RpcError): void {
    const now = Date.now();
    ep.lastError = err.message.slice(0, 160);
    if (err.kind === "rate-limit") {
      ep.rateLimited++;
      // several in-flight requests usually fail together: react once per burst
      if (now - ep.lastRateLimit > 400) {
        ep.slowStart = false;
        ep.rate = Math.max(1, ep.rate * 0.7);
        ep.tokens = Math.min(ep.tokens, 0);
        ep.coolUntil = Math.max(ep.coolUntil, now + (err.code && err.code > 0 ? Math.min(err.code, 15000) : 400 + Math.random() * 400));
      }
      ep.lastRateLimit = now;
      return;
    }
    if (err.kind === "unsupported") {
      ep.unsupported.set(method, now + 30 * 60_000); ep.noData.delete(method);
      this.#note(`${ep.label}: does not support ${method}, using other endpoints for it`);
      return;
    }
    if (err.kind === "invalid") return;
    ep.errors++;
    if (err.kind === "rpc") return; // the node answered; it just could not serve this request right now
    ep.failStreak++;
    ep.rate = Math.max(1, ep.rate * 0.8);
    ep.coolUntil = Math.max(ep.coolUntil, now + Math.min(30_000, 250 * 2 ** Math.min(ep.failStreak, 7)));
    if (ep.failStreak === 6) this.#note(`${ep.label}: keeps failing (${ep.lastError}), resting`);
  }

  async #request(ep: Endpoint, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    ep.inflight++;
    const started = performance.now();
    try {
      let res: Response, text: string;
      try {
        res = await this.#fetch(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        const name = (e as Error).name;
        throw new RpcError("network", name === "TimeoutError" || name === "AbortError" ? `timeout after ${timeoutMs} ms` : `network error: ${(e as Error).message}`);
      }
      const ms = performance.now() - started;
      ep.latency = ep.latency ? ep.latency * 0.9 + ms * 0.1 : ms;
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        throw new RpcError("rate-limit", "rate limited (HTTP 429)", isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
      }
      let body: { result?: unknown; error?: { code?: number; message?: string } };
      try { body = JSON.parse(text); } catch {
        if (res.status === 401 || res.status === 403) throw new RpcError("server", `HTTP ${res.status}: the endpoint rejected the request (check the API key)`);
        throw new RpcError("server", `HTTP ${res.status}: not a JSON-RPC answer`);
      }
      if (body && typeof body === "object" && body.error) {
        const code = body.error.code, msg = String(body.error.message ?? "rpc error").slice(0, 200);
        if (code === 429 || code === -32429 || /rate.?limit|too many requests|exceeded.*(limit|quota)|credits/i.test(msg)) throw new RpcError("rate-limit", msg);
        if (code === -32601 || /method not found|not (supported|available|allowed)|is disabled|upgrade/i.test(msg)) throw new RpcError("unsupported", msg, code);
        if (code === -32602 || code === -32600 || code === -32700) throw new RpcError("invalid", `${method}: ${msg}`, code);
        throw new RpcError("rpc", msg, code);
      }
      if (!res.ok) throw new RpcError("server", `HTTP ${res.status}`);
      if (!body || typeof body !== "object" || !("result" in body)) throw new RpcError("server", "malformed JSON-RPC answer");
      return body.result;
    } finally {
      ep.inflight--;
    }
  }

  /** Resolves when nothing is queued or in flight (useful in tests and before exit). */
  async idle(): Promise<void> {
    while (this.#queue.length || this.#urgent.length || this.#eps.some((e) => e.inflight > 0)) await sleep(10);
  }
}
