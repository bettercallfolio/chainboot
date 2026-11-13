import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { b58decode, b58encode } from "../src/util/base58.ts";
import { decodeShortU16, encodeShortU16 } from "../src/util/bytes.ts";
import { Keypair, verifySignature } from "../src/solana/keys.ts";
import { RpcPool, maskRpcUrl } from "../src/solana/rpc.ts";
import { MAX_TX_SIZE, buildTransaction, noopInstruction, noopOverhead, parseTransaction, transferInstruction, verifyPayerSignature, computeBudgetInstructions } from "../src/solana/tx.ts";
import { ChainStore, capacity, tagAddress } from "../src/store/store.ts";
import { FakeChain } from "./helpers/fakechain.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-test-"));

test("base58 round-trips, including leading zeros", () => {
  for (let i = 0; i < 300; i++) {
    const b = crypto.randomBytes(i % 70);
    if (i % 3 === 0 && b.length > 2) { b[0] = 0; b[1] = 0; }
    assert.deepEqual(b58decode(b58encode(b)), b);
  }
  assert.equal(b58encode(Buffer.alloc(32)), "11111111111111111111111111111111");
  assert.throws(() => b58decode("0OIl"), /invalid base58/);
});

test("shortvec round-trips", () => {
  for (const n of [0, 1, 127, 128, 255, 16383, 16384, 65535]) {
    const enc = encodeShortU16(n);
    assert.deepEqual(decodeShortU16(Uint8Array.from(enc), 0), { value: n, next: enc.length });
  }
});

test("keys: known test vector and signature checks", () => {
  // RFC 8032 test 1
  const kp = Keypair.fromSeed(Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"));
  assert.equal(kp.publicKey.toString("hex"), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const sig = kp.sign(new Uint8Array(0));
  assert.equal(sig.toString("hex"), "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  assert.ok(verifySignature(kp.publicKey, new Uint8Array(0), sig));
  assert.ok(!verifySignature(kp.publicKey, Uint8Array.of(1), sig));
  assert.deepEqual(Keypair.fromSecretKey(kp.secretKey()).publicKey, kp.publicKey);
});

test("transactions: build, parse, verify, size accounting", () => {
  const payer = Keypair.generate(), other = Keypair.generate();
  const bh = crypto.randomBytes(32);
  for (const [fee, ro] of [[false, 0], [true, 0], [false, 1], [true, 1]] as const) {
    const cap = capacity({ priorityFee: fee, readonlyAccounts: ro });
    const data = crypto.randomBytes(cap);
    const ix = [...(fee ? computeBudgetInstructions(1000, 5) : []), noopInstruction(data, ro ? [other.publicKey] : [])];
    const tx = buildTransaction(payer, ix, bh);
    assert.equal(tx.raw.length, MAX_TX_SIZE, `fee=${fee} ro=${ro} must fill the transaction exactly`);
    assert.equal(noopOverhead({ priorityFee: fee, readonlyAccounts: ro, dataLen: cap }) + cap, MAX_TX_SIZE);
    const parsed = parseTransaction(tx.raw);
    assert.ok(verifyPayerSignature(parsed));
    assert.deepEqual(parsed.accountKeys[0], payer.publicKey);
    assert.deepEqual(parsed.instructions.at(-1)!.data, data);
    assert.throws(() => buildTransaction(payer, [noopInstruction(crypto.randomBytes(cap + 1), ro ? [other.publicKey] : [])].concat(fee ? computeBudgetInstructions(1, 1) : []), bh), /limit is 1232/);
  }
  const t = parseTransaction(buildTransaction(payer, [transferInstruction(payer.publicKey, other.publicKey, 12345n)], bh).raw);
  assert.equal(t.header.numSigners, 1);
  assert.equal(t.instructions[0]!.data.readBigUInt64LE(4), 12345n);
  assert.throws(() => parseTransaction(Buffer.concat([buildTransaction(payer, [noopInstruction(Buffer.from("x"))], bh).raw, Buffer.from([0])])), /trailing/);
});

test("rpc urls are masked", () => {
  assert.equal(maskRpcUrl("https://devnet.helius-rpc.com/?api-key=SECRET"), "devnet.helius-rpc.com/…");
  assert.ok(!maskRpcUrl("https://abcdef1234567890abcd.solana-devnet.quiknode.pro/SECRETTOKEN/").includes("SECRET"));
  assert.ok(!maskRpcUrl("https://abcdef1234567890abcd.solana-devnet.quiknode.pro/SECRETTOKEN/").includes("abcdef1234567890abcd"));
  assert.equal(maskRpcUrl("https://api.devnet.solana.com"), "api.devnet.solana.com");
  assert.throws(() => new RpcPool(["ftp://x"]), /not a valid RPC URL/);
  assert.throws(() => new RpcPool([]), /no RPC endpoints/);
});

test("pool: spreads load, survives rate limits and dead endpoints", async () => {
  const chain = new FakeChain(), urls = chain.urls(4);
  chain.faults.set(urls[0]!, { rps: 20 });
  chain.faults.set(urls[1]!, { network: 1 });
  chain.faults.set(urls[2]!, { rateLimit: 0.2 });
  const pool = new RpcPool(urls, { fetch: chain.fetch, initialRate: 50 });
  const results = await Promise.all(Array.from({ length: 600 }, () => pool.call<string>("getGenesisHash")));
  assert.ok(results.every((r) => r === chain.genesis));
  const stats = pool.stats();
  assert.ok(stats[3]!.ok > stats[1]!.ok, "healthy endpoint did more work than the dead one");
  assert.equal(stats[1]!.ok, 0);
  const healthy = new RpcPool(chain.urls(6).slice(4), { fetch: chain.fetch });
  await assert.rejects(healthy.call("noSuchMethod"), /failed on every RPC endpoint/);
  await assert.rejects(healthy.call("sendTransaction", ["AAAA"]), /invalid transaction/);
});

test("pool: probe drops endpoints of another network", async () => {
  const chain = new FakeChain(), other = new FakeChain();
  other.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const route: typeof fetch = (u, i) => (String(u).includes("rpc1") ? other.fetch(u, i) : chain.fetch(u, i));
  const pool = new RpcPool(chain.urls(3), { fetch: route });
  const rep = await pool.probe(chain.genesis);
  assert.deepEqual(rep.map((r) => r.ok), [true, false, true]);
  assert.match(rep[1]!.detail, /mainnet-beta/);
  assert.equal(pool.size, 2);
  await Promise.all(Array.from({ length: 50 }, () => pool.call("getGenesisHash")));
  assert.equal(other.requests, 1, "the foreign endpoint is never used again");
});

test("store: objects of every size round-trip and are verified", async () => {
  const chain = new FakeChain();
  const pool = new RpcPool(chain.urls(3), { fetch: chain.fetch, initialRate: 500 });
  const store = new ChainStore(pool), payer = Keypair.generate();
  const cap = capacity();
  for (const size of [0, 1, cap - 3, cap - 2, 1060, 1061, 1060 * 15, 1060 * 15 + 1, 1060 * 16 * 15 + 7, 300_000]) {
    const data = crypto.randomBytes(size);
    const plan = ChainStore.plan(size);
    const before = chain.txs.size;
    const ref = await store.put(payer, data, { pollMs: 20 });
    assert.equal(chain.txs.size - before, plan.transactions, `plan for ${size} bytes`);
    assert.deepEqual(await store.get(ref, { signers: [payer.publicKey] }), data);
    assert.deepEqual(await store.get(ref.sig), data);
    await assert.rejects(store.get(ref, { signers: [Keypair.generate().publicKey] }), /not published by a trusted key/);
    if (size > 0) await assert.rejects(store.get({ ...ref, sha256: "00".repeat(32) }), /sha256 differs/);
  }
});

test("store: download survives missing, corrupt and rate-limited answers, and resumes from cache", async () => {
  const chain = new FakeChain(), urls = chain.urls(4);
  const pool = new RpcPool(urls, { fetch: chain.fetch, initialRate: 500 });
  const store = new ChainStore(pool), payer = Keypair.generate();
  const data = crypto.randomBytes(200_000);
  const ref = await store.put(payer, data, { pollMs: 20 });
  chain.faults.set(urls[0]!, { missing: 0.5 });
  chain.faults.set(urls[1]!, { corrupt: 0.3 });
  chain.faults.set(urls[2]!, { rateLimit: 0.3, network: 0.1 });
  const dir = tmp();
  assert.deepEqual(await store.get(ref, { signers: [payer.publicKey], cacheDir: dir }), data);
  // cached now: no network needed at all
  const n = chain.requests;
  assert.deepEqual(await store.get(ref, { cacheDir: dir }), data);
  assert.equal(chain.requests, n);

  // interrupted download: abort part-way, then finish with far fewer requests
  const dir2 = tmp(), ac = new AbortController();
  let seen = 0;
  await assert.rejects(store.get(ref, { cacheDir: dir2, signal: ac.signal, onProgress: (p) => { seen = p.done; if (p.done >= 64) ac.abort(); } }), /aborted/);
  await pool.idle();
  assert.ok(seen >= 64);
  for (const u of urls) chain.faults.delete(u);
  const before = chain.requests;
  let resumedFrom = -1;
  assert.deepEqual(await store.get(ref, { cacheDir: dir2, onProgress: (p) => { if (resumedFrom < 0) resumedFrom = p.done; } }), data);
  assert.ok(resumedFrom >= 64, `resumed with ${resumedFrom} leaves already present`);
  assert.ok(chain.requests - before < ChainStore.plan(data.length).transactions, "resume fetched fewer transactions than a full download");
});

test("store: upload survives dropped transactions and resumes from its journal without paying twice", async () => {
  const chain = new FakeChain(), urls = chain.urls(3);
  for (const u of urls) chain.faults.set(u, { drop: 0.2, rateLimit: 0.05 });
  const pool = new RpcPool(urls, { fetch: chain.fetch, initialRate: 500 });
  const store = new ChainStore(pool), payer = Keypair.generate();
  const data = crypto.randomBytes(60_000), dir = tmp();
  const ac = new AbortController();
  await assert.rejects(store.put(payer, data, { journalDir: dir, signal: ac.signal, pollMs: 20, resendAfterMs: 150, onProgress: (p) => { if (p.phase === "data" && p.done >= 20) ac.abort(); } }), /aborted/);
  await pool.idle();
  const landedBefore = chain.txs.size;
  assert.ok(landedBefore >= 20);
  const ref = await store.put(payer, data, { journalDir: dir, pollMs: 20, resendAfterMs: 150 });
  assert.deepEqual(await store.get(ref), data);
  const plan = ChainStore.plan(data.length).transactions;
  assert.ok(chain.txs.size <= plan + 40, `at most a few duplicates: ${chain.txs.size} transactions for a plan of ${plan}`);
  assert.equal(fs.readdirSync(dir).length, 0, "journal is removed after success");
});

test("store: not enough funds is reported clearly", async () => {
  const chain = new FakeChain(); chain.balance = 1000;
  const store = new ChainStore(new RpcPool(chain.urls(1), { fetch: chain.fetch }));
  await assert.rejects(store.put(Keypair.generate(), crypto.randomBytes(5000)), /not enough SOL/);
});

test("pointers: newest record by a trusted key wins, others are ignored", async () => {
  const chain = new FakeChain();
  const store = new ChainStore(new RpcPool(chain.urls(2), { fetch: chain.fetch, initialRate: 200 }));
  const me = Keypair.generate(), stranger = Keypair.generate();
  const tag = tagAddress("catalog", me.publicKey, "demo");
  assert.equal(await store.getPointer(tag, [me.publicKey]), null);
  await store.putPointer(me, tag, Buffer.from("one"));
  await store.putPointer(me, tag, Buffer.from("two"));
  await store.putPointer(stranger, tag, Buffer.from("evil"));
  const p = await store.getPointer(tag, [me.publicKey]);
  assert.equal(p!.payload.toString(), "two");
  assert.deepEqual(p!.payer, me.publicKey);
  assert.notDeepEqual(tagAddress("a", "bc"), tagAddress("ab", "c"));
});
