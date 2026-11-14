// RpcPool: talk to many Solana RPC endpoints at once, as fast as each one allows.
//
// Every endpoint has its own speed limit that the pool *learns*:
//   - it starts slowly and speeds up while requests succeed (slow start, like TCP),
//   - on "429 Too Many Requests" it backs off and then climbs again gently,
//   - an endpoint that fails or times out rests for a moment and the work moves to the others.
// Requests wait in one queue and go to whichever endpoint has room, so one slow or
// rate-limited endpoint never becomes a bottleneck. Nothing here prints API keys.
import { createHash } from "node:crypto";
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
  /** Calls per second each endpoint starts with (default 40). */
  initialRate?: number;
  /** Upper bound for the learned requests per second of one endpoint (default 2000). */
  maxRate?: number;
  /** A request slower than this (and 3x slower than usual for that endpoint) is also sent elsewhere (default 1500 ms). */
  hedgeMinMs?: number;
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
  /** Allow this call to share one HTTP request with other calls (JSON-RPC batch). Best for bulk reads. */
  batch?: boolean;
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
  hedged: number;
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
  batch: number;                    // how many calls one HTTP request may carry right now
  batchOff: boolean;                // the endpoint refuses batches
  methodLatency: Map<string, number>; // usual response time per method (ms)
  hedged: number;                   // requests that were slow enough to be duplicated elsewhere
  okThisSecond: number;             // successes in the running one-second window ...
  okPrevSecond: number;             // ... and in the one before (what the endpoint provably allows)
  okSecondStart: number;
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
  settled: boolean; // answered (or given up): late copies are ignored
  queued: boolean;  // waiting in a queue right now
  flying: number;   // copies of this call currently in flight
  limited: number;  // how often this call was turned away by a rate limit
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Solana's own networks, by the hash of their first block. */
export const GENESIS: Record<string, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
};
/**
 * What identifies a network: "devnet", "testnet" or "mainnet-beta" for Solana's own, and the
 * genesis hash itself for any other chain that speaks Solana's RPC (which people then give a
 * name of their own; see the settings).
 */
export type Cluster = string;

export function clusterName(genesisHash: string): string {
  for (const [name, hash] of Object.entries(GENESIS)) if (hash === genesisHash) return name;
  return `unknown network ${genesisHash.slice(0, 8)}…`;
}

/** Remembered probe answers, keyed by a hash of the URL (so no API key is written to the cache). */
export type ProbeCache = Record<string, { genesis: string | null; error?: string; at: number }>;
export function probeKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
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

const MAX_BATCH = 64;

function retryAfter(res: Response): number | undefined {
  const ra = Number(res.headers.get("retry-after"));
  return isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
}

export class RpcPool {
  readonly #eps: Endpoint[];
  readonly #queue: Job[] = [];
  readonly #urgent: Job[] = [];
  readonly #o: Required<Omit<RpcPoolOptions, "onNote" | "fetch">>;
  readonly #note: (t: string) => void;
  readonly #fetch: typeof fetch;
  #timer: NodeJS.Timeout | null = null;
  #kicked = false;
  #id = 0;

  constructor(urls: string[], options: RpcPoolOptions = {}) {
    const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    for (const u of unique) {
      let ok = false;
      try { ok = /^https?:$/.test(new URL(u).protocol); } catch { /* reported below */ }
      if (!ok) throw new Error(`not a valid RPC URL (must start with http:// or https://): ${maskRpcUrl(u)}`);
    }
    if (!unique.length) throw new Error("no RPC endpoints configured. Add one with: chainboot rpc add <url>");
    this.#o = { maxInflight: options.maxInflight ?? 48, timeoutMs: options.timeoutMs ?? 20000, initialRate: options.initialRate ?? 40, maxRate: options.maxRate ?? 2000, hedgeMinMs: options.hedgeMinMs ?? 1500 };
    this.#note = options.onNote ?? (() => {});
    this.#fetch = options.fetch ?? fetch;
    const now = Date.now();
    this.#eps = unique.map((url) => ({
      url, label: maskRpcUrl(url), inflight: 0, rate: this.#o.initialRate, slowStart: true, tokens: Math.max(1, this.#o.initialRate / 4),
      refilledAt: now, coolUntil: 0, failStreak: 0, lastRateLimit: 0, usedThisWindow: 0, windowStart: now, latency: 0,
      ok: 0, rateLimited: 0, errors: 0, lastError: "", unsupported: new Map(), noData: new Set(), misses: 0, disabledUntil: 0, removed: false, batch: 8, batchOff: false, methodLatency: new Map(), hedged: 0, okThisSecond: 0, okPrevSecond: 0, okSecondStart: now,
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
  async probe(genesisHash?: string, known: ProbeCache = {}): Promise<{ label: string; ok: boolean; detail: string; /** the chain the endpoint serves, when it answered */ genesis?: string }[]> {
    const now = Date.now();
    const report = await Promise.all(this.#eps.map(async (e) => {
      // an endpoint does not change networks: a recent answer is reused, so commands start without waiting
      const seen = known[probeKey(e.url)];
      if (seen && now - seen.at < (seen.genesis ? 7 * 86_400_000 : 10 * 60_000)) {
        if (!seen.genesis) { e.removed = true; return { label: e.label, ok: false, detail: seen.error ?? "unreachable" }; }
        if (genesisHash && seen.genesis !== genesisHash) { e.removed = true; return { label: e.label, ok: false, detail: `different network (${clusterName(seen.genesis)})`, genesis: seen.genesis }; }
        return { label: e.label, ok: true, detail: clusterName(seen.genesis), genesis: seen.genesis };
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const g = await this.#single(e, "getGenesisHash", [], 8000);
          if (typeof g !== "string") throw new RpcError("server", "malformed answer");
          known[probeKey(e.url)] = { genesis: g, at: now };
          if (genesisHash && g !== genesisHash) { e.removed = true; return { label: e.label, ok: false, detail: `different network (${clusterName(g)})`, genesis: g }; }
          return { label: e.label, ok: true, detail: clusterName(g), genesis: g };
        } catch (err) {
          if (attempt < 2 && (err as RpcError).kind !== "unsupported") { await sleep(400 * (attempt + 1)); continue; }
          e.removed = true;
          known[probeKey(e.url)] = { genesis: null, error: (err as Error).message, at: now };
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
      latencyMs: Math.round(e.latency), hedged: e.hedged, lastError: e.lastError,
    }));
  }

  /** One JSON-RPC call, retried across endpoints until it succeeds or attempts run out. */
  call<T = unknown>(method: string, params: unknown = [], opts: CallOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        method, params, opts, tried: new Set(), rounds: 0, notBefore: 0, lastError: null,
        attemptsLeft: opts.attempts ?? Math.max(8, this.#eps.length * 4),
        settled: false, queued: true, flying: 0, limited: 0,
        resolve: resolve as (v: unknown) => void, reject,
      };
      (opts.urgent ? this.#urgent : this.#queue).push(job);
      this.#kick();
    });
  }

  /** Runs the scheduler once after the current burst of call()s, so calls made together can share a request. */
  #kick(): void {
    if (this.#kicked) return;
    this.#kicked = true;
    queueMicrotask(() => { this.#kicked = false; this.#pump(); });
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
        this.#takeTokens(ep, Date.now(), 1);
        this.#single(ep, method, params, timeoutMs).then(
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
    const span = now - e.windowStart;
    if (span >= 500) {
      // grow only when the limit was actually in use, otherwise an idle endpoint would look infinitely fast
      const busy = e.usedThisWindow >= e.rate * 0.6 * (span / 1000);
      if (busy && now - e.lastRateLimit > 2000 && e.failStreak === 0) {
        e.rate = Math.min(this.#o.maxRate, e.slowStart ? e.rate * 2 : e.rate + Math.max(0.5, e.rate * 0.03));
      }
      e.usedThisWindow = 0; e.windowStart = now;
    }
  }

  #takeTokens(e: Endpoint, now: number, n: number): void {
    this.#refill(e, now);
    e.tokens -= n; e.usedThisWindow += n;
  }

  #pick(job: Job, now: number, backlog: number): Endpoint | "wait" | null {
    let best: Endpoint | null = null, anyAllowed = false, bestLoad = Infinity;
    for (const e of this.#eps) {
      if (e.removed || e.disabledUntil > now || this.#isUnsupported(e, job.method, now)) continue;
      if (job.tried.has(e)) continue;
      anyAllowed = true;
      if (e.coolUntil > now || e.inflight >= this.#o.maxInflight) continue;
      this.#refill(e, now);
      // a batchable call waits until a decent batch can go out, instead of dribbling one call per request
      const need = job.opts.batch && !e.batchOff ? Math.max(1, Math.min(e.batch, backlog, Math.floor(e.rate / 4))) : 1;
      if (e.tokens < need) continue;
      // spare capacity first (an endpoint that had to be slowed down counts as busier), then latency
      const load = (e.inflight + 1) / Math.max(1, e.rate) + (e.latency || 400) / 1e6; // an endpoint not measured yet counts as average
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
        if (job.settled) { queue.splice(i--, 1); job.queued = false; continue; } // a slower copy already answered
        if (job.opts.deadline !== undefined && now > job.opts.deadline) {
          queue.splice(i--, 1); job.queued = false; job.settled = true;
          job.reject(job.lastError ?? new RpcError("exhausted", `${job.method}: timed out waiting for an RPC endpoint`));
          continue;
        }
        if (job.notBefore > now) { scanned++; continue; }
        const pick = this.#pick(job, now, queue.length - i);
        if (pick === null) {
          const usable = this.#eps.filter((e) => !e.removed);
          const hard = (e: Endpoint) => (e.unsupported.get(job.method) ?? 0) > now && !e.noData.has(job.method);
          if (usable.some(hard) && usable.every((e) => hard(e) || e.failStreak >= 3)) {
            // no endpoint offers this method at all: waiting will not help
            queue.splice(i--, 1); job.queued = false; job.settled = true;
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
        // one HTTP request can carry several calls: take more jobs that may go to the same endpoint
        const want = job.opts.batch && !pick.batchOff ? Math.min(pick.batch, Math.floor(pick.tokens)) : 1;
        const jobs = [job];
        queue.splice(i, 1);
        for (let j = i, looked = 0; jobs.length < want && j < queue.length && looked < want * 4; looked++) {
          const other = queue[j]!;
          if (other.opts.batch && !other.settled && other.notBefore <= now && !other.tried.has(pick) && !this.#isUnsupported(pick, other.method, now)) { jobs.push(other); queue.splice(j, 1); }
          else j++;
        }
        i--;
        this.#run(pick, jobs);
      }
    }
    this.#arm();
  }

  #arm(): void {
    if (this.#timer || (!this.#queue.length && !this.#urgent.length)) return;
    this.#timer = setTimeout(() => { this.#timer = null; this.#pump(); }, 10);
  }

  #run(ep: Endpoint, jobs: Job[]): void {
    this.#takeTokens(ep, Date.now(), jobs.length);
    for (const job of jobs) { job.queued = false; job.flying++; job.tried.add(ep); job.attemptsLeft--; }
    const method = jobs[0]!.method;
    const timeout = Math.max(...jobs.map((j) => j.opts.timeoutMs ?? this.#o.timeoutMs)) + 40 * (jobs.length - 1);
    const started = performance.now();
    // Hedging: when this endpoint is much slower than usual, ask another one as well and take
    // whichever answers first. One stuck endpoint must never hold up the whole download.
    const usual = ep.methodLatency.get(method) ?? ep.latency;
    const hedge = setTimeout(() => {
      const now = Date.now();
      let any = false;
      for (const job of jobs) {
        if (job.settled || job.queued) continue;
        const other = this.#eps.some((e) => e !== ep && !e.removed && !job.tried.has(e) && e.disabledUntil <= now && e.coolUntil <= now && !this.#isUnsupported(e, job.method, now));
        if (!other) continue;
        job.queued = true; job.attemptsLeft++;
        (job.opts.urgent ? this.#urgent : this.#queue).unshift(job);
        any = true;
      }
      // an endpoint that stalls gets no new work for a while (its pending answer is still welcome)
      ep.hedged++;
      ep.coolUntil = Math.max(ep.coolUntil, now + 10_000);
      if (any) this.#kick();
    }, Math.min(timeout / 2, Math.max(this.#o.hedgeMinMs, usual * 3)));
    const work = jobs.length === 1
      ? this.#single(ep, method, jobs[0]!.params, timeout).then((r) => [r] as (unknown | RpcError)[])
      : this.#batch(ep, jobs, timeout);
    work.then(
      (results) => {
        const ms = performance.now() - started;
        ep.methodLatency.set(method, ep.methodLatency.has(method) ? ep.methodLatency.get(method)! * 0.8 + ms * 0.2 : ms);
        let limited = false, clean = true;
        results.forEach((r, k) => {
          const job = jobs[k]!;
          job.flying--;
          if (r instanceof RpcError) {
            clean = false;
            if (r.kind === "rate-limit") { if (!limited) this.#onFailure(ep, job.method, r); limited = true; this.#forgive(ep, job); }
            else this.#onFailure(ep, job.method, r);
            if (r.kind === "invalid") this.#settle(job, r); else this.#retry(job, r);
            return;
          }
          if (job.opts.accept && !job.opts.accept(r)) {
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
          this.#settle(job, null, r);
        });
        // rate limits are handled by the learned call rate; the batch size only grows while answers are clean
        if (jobs.length > 1 && clean && jobs.length >= ep.batch) ep.batch = Math.min(MAX_BATCH, ep.batch * 2);
      },
      (err: RpcError) => {
        for (const job of jobs) job.flying--;
        // the whole HTTP request failed
        if (jobs.length > 1 && (err.kind === "invalid" || err.kind === "unsupported" || /HTTP (400|404|405|413|415)/.test(err.message))) {
          ep.batchOff = true;
          this.#note(`${ep.label}: does not accept batched requests, sending one call per request`);
          for (const job of jobs) { job.tried.delete(ep); job.attemptsLeft++; this.#retry(job, err); }
          return;
        }
        // a big request that timed out or broke the connection: try smaller ones
        if (jobs.length > 1 && err.kind === "network") ep.batch = Math.max(1, ep.batch >> 1);
        this.#onFailure(ep, method, err);
        for (const job of jobs) {
          if (err.kind === "rate-limit") this.#forgive(ep, job);
          if (err.kind === "invalid") this.#settle(job, err); else this.#retry(job, err);
        }
      },
    ).finally(() => { clearTimeout(hedge); this.#pump(); });
  }

  /**
   * "Too many requests" means "come back later", not "this failed": the call keeps its attempt
   * and may return to the same endpoint once that endpoint's learned rate allows it.
   */
  #forgive(ep: Endpoint, job: Job): void {
    if (++job.limited > 100) return; // an endpoint that only ever says 429 must not keep a call alive forever
    job.tried.delete(ep);
    job.attemptsLeft++;
  }

  /** Delivers the final outcome of a call exactly once. */
  #settle(job: Job, err: Error | null, result?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    if (err) job.reject(err); else job.resolve(result);
  }

  #retry(job: Job, err: RpcError): void {
    // another copy of this call is already answered, waiting, or still on its way: let that one decide
    if (job.settled || job.queued || job.flying > 0) return;
    job.lastError = err;
    if (job.attemptsLeft <= 0) {
      this.#settle(job, new RpcError("exhausted", `${job.method} failed on every RPC endpoint (last error: ${err.message})`, err.code));
      return;
    }
    job.queued = true;
    (job.opts.urgent ? this.#urgent : this.#queue).unshift(job);
  }

  #onSuccess(ep: Endpoint): void {
    ep.ok++; ep.failStreak = 0;
    const now = Date.now();
    if (now - ep.okSecondStart >= 1000) {
      ep.okPrevSecond = now - ep.okSecondStart < 2000 ? ep.okThisSecond : 0;
      ep.okThisSecond = 0; ep.okSecondStart = now;
    }
    ep.okThisSecond++;
  }

  #onFailure(ep: Endpoint, method: string, err: RpcError): void {
    const now = Date.now();
    ep.lastError = err.message.slice(0, 160);
    if (err.kind === "rate-limit") {
      ep.rateLimited++;
      // several in-flight requests usually fail together: react once per burst
      if (now - ep.lastRateLimit > 400) {
        ep.slowStart = false;
        // aim just below what actually got through lately; an endpoint that let nothing through gets a hard cut
        const proven = ep.okPrevSecond > 0 ? ep.okPrevSecond * 0.8 : ep.rate * 0.3;
        ep.rate = Math.max(1, Math.min(ep.rate * 0.7, proven));
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

  /** Turns a JSON-RPC error object into the kind of failure the scheduler understands. */
  static #classify(method: string, error: { code?: number; message?: string }): RpcError {
    const code = error.code, msg = String(error.message ?? "rpc error").slice(0, 200);
    if (code === 429 || code === -32429 || /rate.?limit|too many requests|exceeded.*(limit|quota)|credits|max usage/i.test(msg)) return new RpcError("rate-limit", msg);
    if (code === -32601 || /method not found|method .*not (supported|available|allowed)|is disabled|upgrade your plan/i.test(msg)) return new RpcError("unsupported", msg, code);
    if (code === -32602 || code === -32600 || code === -32700) return new RpcError("invalid", `${method}: ${msg}`, code);
    return new RpcError("rpc", msg, code);
  }

  /** One HTTP POST. Returns the parsed JSON body; throws for transport-level failures. */
  async #http(ep: Endpoint, payload: unknown, timeoutMs: number): Promise<unknown> {
    ep.inflight++;
    const started = performance.now();
    try {
      let res: Response, text: string;
      try {
        res = await this.#fetch(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        const name = (e as Error).name;
        throw new RpcError("network", name === "TimeoutError" || name === "AbortError" ? `timeout after ${timeoutMs} ms` : `network error: ${(e as Error).message}`);
      }
      const ms = performance.now() - started;
      ep.latency = ep.latency ? ep.latency * 0.9 + ms * 0.1 : ms;
      let body: unknown;
      try { body = JSON.parse(text); } catch {
        if (res.status === 429 || /max usage|rate.?limit|too many/i.test(text.slice(0, 200))) throw new RpcError("rate-limit", `rate limited (HTTP ${res.status})`, retryAfter(res));
        if (res.status === 401 || res.status === 403) throw new RpcError("server", `HTTP ${res.status}: the endpoint rejected the request (check the API key)`);
        throw new RpcError("server", `HTTP ${res.status}: not a JSON-RPC answer`);
      }
      if (res.status === 429 && !Array.isArray(body)) throw new RpcError("rate-limit", "rate limited (HTTP 429)", retryAfter(res));
      if (!res.ok && res.status !== 429 && (!body || typeof body !== "object" || (!Array.isArray(body) && !("error" in body)))) throw new RpcError("server", `HTTP ${res.status}`);
      return body;
    } finally {
      ep.inflight--;
    }
  }

  async #single(ep: Endpoint, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const body = await this.#http(ep, { jsonrpc: "2.0", id: ++this.#id, method, params }, timeoutMs) as { result?: unknown; error?: { code?: number; message?: string } } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RpcError("server", "malformed JSON-RPC answer");
    if (body.error) throw RpcPool.#classify(method, body.error);
    if (!("result" in body)) throw new RpcError("server", "malformed JSON-RPC answer");
    return body.result;
  }

  /** Several calls in one HTTP request. Resolves with one result or RpcError per job. */
  async #batch(ep: Endpoint, jobs: Job[], timeoutMs: number): Promise<(unknown | RpcError)[]> {
    const body = await this.#http(ep, jobs.map((j, id) => ({ jsonrpc: "2.0", id, method: j.method, params: j.params })), timeoutMs);
    if (!Array.isArray(body)) {
      const error = (body as { error?: { code?: number; message?: string } } | null)?.error;
      if (error) {
        const e = RpcPool.#classify("batch", error);
        throw e.kind === "rpc" ? new RpcError("invalid", e.message, e.code) : e;
      }
      throw new RpcError("invalid", "the endpoint did not answer the batch with a list");
    }
    const out: (unknown | RpcError)[] = jobs.map(() => new RpcError("server", "missing answer in batch"));
    for (const item of body as { id?: unknown; result?: unknown; error?: { code?: number; message?: string } }[]) {
      const id = typeof item?.id === "number" ? item.id : -1;
      if (id < 0 || id >= jobs.length) continue;
      out[id] = item.error ? RpcPool.#classify(jobs[id]!.method, item.error) : "result" in item ? item.result : new RpcError("server", "malformed JSON-RPC answer");
    }
    return out;
  }

  /**
   * Asks up to `count` different endpoints the same question and returns every answer that arrived
   * within `timeoutMs`. For questions where one endpoint could be behind or lie about what is newest.
   */
  async callEach<T = unknown>(method: string, params: unknown, count = 3, timeoutMs = 6000): Promise<T[]> {
    const now = Date.now();
    const usable = this.#eps.filter((e) => !e.removed && !this.#isUnsupported(e, method, now));
    const fit = usable.filter((e) => e.disabledUntil <= now && e.coolUntil <= now);
    const targets = (fit.length ? fit : usable).slice().sort((a, b) => (a.latency || 400) - (b.latency || 400)).slice(0, Math.max(1, count));
    const answers: T[] = [];
    await Promise.all(targets.map(async (ep) => {
      this.#takeTokens(ep, Date.now(), 1);
      try { answers.push(await this.#single(ep, method, params, timeoutMs) as T); this.#onSuccess(ep); }
      catch (e) { this.#onFailure(ep, method, e as RpcError); }
    }));
    this.#kick();
    return answers;
  }

  /** Resolves when nothing is queued or in flight (useful in tests and before exit). */
  async idle(): Promise<void> {
    while (this.#queue.length || this.#urgent.length || this.#eps.some((e) => e.inflight > 0)) await sleep(10);
  }
}
