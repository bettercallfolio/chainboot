import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { b58decode, b58encode } from "../src/util/base58.ts";
import { decodeShortU16, encodeShortU16 } from "../src/util/bytes.ts";
import { Keypair, verifySignature } from "../src/solana/keys.ts";
import { SUB_IDS, freeRange, subRange } from "../src/engine/rootless.ts";
import { RpcPool, maskRpcUrl } from "../src/solana/rpc.ts";
import { MAX_TX_SIZE_LEGACY, MAX_TX_SIZE_V1, buildNoopTransaction, buildTransaction, noopCapacity, noopInstruction, parseTransaction, transferInstruction, verifyPayerSignature } from "../src/solana/tx.ts";
import { ChainStore, capacity, decodeSlots, encodeSlots, tagAddress } from "../src/store/store.ts";
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

test("transactions: both wire formats build, parse, verify and fill the size limit exactly", () => {
  const payer = Keypair.generate(), other = Keypair.generate();
  const bh = crypto.randomBytes(32);
  for (const version of [1, "legacy"] as const) for (const fee of [0, 700]) for (const ro of [0, 1]) {
    const limit = version === 1 ? MAX_TX_SIZE_V1 : MAX_TX_SIZE_LEGACY;
    const cap = noopCapacity({ version, priorityFee: fee > 0, readonlyAccounts: ro });
    const data = crypto.randomBytes(cap);
    const o = { version, priorityFeeLamports: fee, readonlyAccounts: ro ? [other.publicKey] : [] };
    const tx = buildNoopTransaction(payer, data, bh, o);
    assert.equal(tx.raw.length, limit, `version=${version} fee=${fee} ro=${ro} must fill the transaction exactly`);
    const parsed = parseTransaction(tx.raw);
    assert.equal(parsed.version, version);
    assert.ok(verifyPayerSignature(parsed));
    assert.deepEqual(parsed.accountKeys[0], payer.publicKey);
    assert.deepEqual(parsed.recentBlockhash, bh);
    assert.deepEqual(parsed.instructions.at(-1)!.data, data);
    if (ro) assert.deepEqual(parsed.instructions.at(-1)!.accounts, [other.publicKey]);
    assert.throws(() => buildNoopTransaction(payer, crypto.randomBytes(cap + 1), bh, o), /the limit is/);
    const bad = Buffer.from(tx.raw); bad[bad.length - 70] = bad[bad.length - 70]! ^ 1;
    try { assert.ok(!verifyPayerSignature(parseTransaction(bad))); } catch (e) { if ((e as Error).name === "AssertionError") throw e; }
  }
  assert.equal(noopCapacity(), 3914);
  assert.equal(noopCapacity({ version: "legacy" }), 1062);
  for (const version of [1, "legacy"] as const) {
    const t = parseTransaction(buildTransaction(payer, [transferInstruction(payer.publicKey, other.publicKey, 12345n)], bh, { version }).raw);
    assert.equal(t.header.numSigners, 1);
    assert.equal(t.instructions[0]!.data.readBigUInt64LE(4), 12345n);
    assert.deepEqual(t.instructions[0]!.accounts, [payer.publicKey, other.publicKey]);
    const raw = buildTransaction(payer, [noopInstruction(Buffer.from("x"))], bh, { version }).raw;
    assert.throws(() => parseTransaction(Buffer.concat([raw, Buffer.from([0])])), /trailing|signature count/);
    assert.throws(() => parseTransaction(raw.subarray(0, raw.length - 3)), /truncated|signature count|trailing/);
  }
  // two signers: both signatures present and in account order
  const two = parseTransaction(buildTransaction(payer, [transferInstruction(other.publicKey, payer.publicKey, 1)], bh, { extraSigners: [other] }).raw);
  assert.equal(two.signatures.length, 2);
  assert.throws(() => buildTransaction(payer, [transferInstruction(other.publicKey, payer.publicKey, 1)], bh), /missing signer/);
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

test("pool: a stuck endpoint does not hold up the others (hedging)", async () => {
  const chain = new FakeChain(), urls = chain.urls(3);
  const pool = new RpcPool(urls, { fetch: chain.fetch, initialRate: 200, hedgeMinMs: 60 });
  await Promise.all(Array.from({ length: 30 }, () => pool.call("getGenesisHash"))); // learn the usual speed
  chain.faults.set(urls[1]!, { delayMs: 5000 });
  const t = Date.now();
  const results = await Promise.all(Array.from({ length: 200 }, () => pool.call<string>("getGenesisHash")));
  assert.ok(results.every((r) => r === chain.genesis));
  assert.ok(Date.now() - t < 2500, `200 calls took ${Date.now() - t} ms although one endpoint needs 5 s per answer`);
  assert.ok(pool.stats()[1]!.hedged > 0);
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

test("store: objects of every size round-trip and are verified, in both transaction formats", async () => {
  const chain = new FakeChain();
  const pool = new RpcPool(chain.urls(3), { fetch: chain.fetch, initialRate: 500 });
  const store = new ChainStore(pool), payer = Keypair.generate();
  for (const txVersion of [1, "legacy"] as const) {
    const cap = capacity({ txVersion }), leaf = cap - 2, headFan = Math.floor((cap - 110) / 64), fan = Math.floor(leaf / 64);
    for (const size of [0, 1, cap - 3, cap - 2, leaf, leaf + 1, leaf * headFan, leaf * headFan + 1, leaf * fan * 2 + 7, 300_000]) {
      const data = crypto.randomBytes(size);
      const plan = ChainStore.plan(size, { txVersion });
      const before = chain.txs.size;
      const ref = await store.put(payer, data, { pollMs: 20, txVersion });
      assert.equal(chain.txs.size - before, plan.transactions, `plan for ${size} bytes (${txVersion})`);
      assert.deepEqual(await store.get(ref, { signers: [payer.publicKey] }), data);
      assert.deepEqual(await store.get(ref.sig, { mode: "transactions" }), data);
      await assert.rejects(store.get(ref, { signers: [Keypair.generate().publicKey] }), /not published by a trusted key/);
      if (size > 0) await assert.rejects(store.get({ ...ref, sha256: "00".repeat(32) }), /sha256 differs/);
    }
  }
});

test("slot hints round-trip", () => {
  for (const slots of [[], [5], [1, 2, 3], [521943562, 521943482, 521943522, 521943522], [0, 2 ** 40, 2 ** 45]]) {
    assert.deepEqual(decodeSlots(encodeSlots(slots)), [...new Set(slots)].sort((a, b) => a - b));
  }
  assert.throws(() => decodeSlots(Buffer.from([2, 1])), /malformed/);
  assert.throws(() => decodeSlots(Buffer.from([1, 1, 1])), /malformed/);
});

test("store: block mode needs few requests, and falls back when blocks are missing or unavailable", async () => {
  const chain = new FakeChain(), urls = chain.urls(3);
  const pool = new RpcPool(urls, { fetch: chain.fetch, initialRate: 500 });
  const store = new ChainStore(pool), payer = Keypair.generate();
  const data = crypto.randomBytes(1_500_000);
  const ref = await store.put(payer, data, { pollMs: 20 });
  const plan = ChainStore.plan(data.length).transactions;

  let calls = chain.calls;
  assert.deepEqual(await store.get(ref, { signers: [payer.publicKey] }), data);
  const blockModeCalls = chain.calls - calls;
  assert.ok(chain.blockCalls > 0 && blockModeCalls < plan / 3, `block mode used ${blockModeCalls} calls for ${plan} transactions`);

  calls = chain.calls;
  assert.deepEqual(await store.get(ref, { mode: "transactions" }), data);
  assert.ok(chain.calls - calls >= plan - 5, "transaction mode fetches every node");

  // blocks that return only half of their transactions, an endpoint without getBlock, a lying endpoint
  chain.faults.set(urls[0]!, { missing: 0.5 });
  chain.faults.set(urls[1]!, { noBlocks: true });
  chain.faults.set(urls[2]!, { corrupt: 0.2 });
  for (let round = 0; round < 3; round++) assert.deepEqual(await store.get(ref, { signers: [payer.publicKey] }), data);

  // no endpoint offers getBlock at all
  for (const u of urls) chain.faults.set(u, { noBlocks: true });
  assert.deepEqual(await store.get(ref, { signers: [payer.publicKey] }), data);
});

test("store: download survives missing, corrupt and rate-limited answers, and resumes from cache", async () => {
  const chain = new FakeChain(), urls = chain.urls(4);
  const pool = new RpcPool(urls, { fetch: chain.fetch, initialRate: 500 });
  const store = new ChainStore(pool), payer = Keypair.generate();
  const data = crypto.randomBytes(200_000);
  const ref = await store.put(payer, data, { pollMs: 20, txVersion: "legacy" });
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
  await assert.rejects(store.get(ref, { cacheDir: dir2, signal: ac.signal, mode: "transactions", onProgress: (p) => { seen = p.done; if (p.done >= 64) ac.abort(); } }), /aborted/);
  await pool.idle();
  assert.ok(seen >= 64);
  for (const u of urls) chain.faults.delete(u);
  const callsMark = chain.calls;
  let resumedFrom = -1;
  assert.deepEqual(await store.get(ref, { cacheDir: dir2, mode: "transactions", onProgress: (p) => { if (resumedFrom < 0) resumedFrom = p.done; } }), data);
  assert.ok(resumedFrom >= 64, `resumed with ${resumedFrom} leaves already present`);
  assert.ok(chain.calls - callsMark < ChainStore.plan(data.length, { txVersion: "legacy" }).transactions - 50, "resume fetched fewer transactions than a full download");
});

test("store: upload survives dropped transactions and resumes from its journal without paying twice", async () => {
  const chain = new FakeChain(), urls = chain.urls(3);
  for (const u of urls) chain.faults.set(u, { drop: 0.2, rateLimit: 0.05 });
  const pool = new RpcPool(urls, { fetch: chain.fetch, initialRate: 500 });
  const store = new ChainStore(pool), payer = Keypair.generate();
  const data = crypto.randomBytes(60_000), dir = tmp();
  const ac = new AbortController();
  await assert.rejects(store.put(payer, data, { journalDir: dir, signal: ac.signal, pollMs: 20, resendAfterMs: 150, txVersion: "legacy", onProgress: (p) => { if (p.phase === "data" && p.done >= 20) ac.abort(); } }), /aborted/);
  await pool.idle();
  const landedBefore = chain.txs.size;
  assert.ok(landedBefore >= 20);
  const ref = await store.put(payer, data, { journalDir: dir, pollMs: 20, resendAfterMs: 150, txVersion: "legacy" });
  assert.deepEqual(await store.get(ref), data);
  const plan = ChainStore.plan(data.length, { txVersion: "legacy" }).transactions;
  assert.ok(chain.txs.size <= plan + 40, `at most a few duplicates: ${chain.txs.size} transactions for a plan of ${plan}`);
  assert.equal(fs.readdirSync(dir).length, 0, "journal is removed after success");
});

test("pool: batches calls where the endpoint allows it and falls back where it does not", async () => {
  const chain = new FakeChain(), urls = chain.urls(3);
  chain.faults.set(urls[0]!, { noBatch: true });
  chain.faults.set(urls[1]!, { itemLimit: 0.1 });
  const pool = new RpcPool(urls, { fetch: chain.fetch, initialRate: 400 });
  const store = new ChainStore(pool), payer = Keypair.generate();
  const data = crypto.randomBytes(400_000);
  const ref = await store.put(payer, data, { pollMs: 20, txVersion: "legacy" });
  chain.perUrl.clear(); chain.perUrlCalls.clear();
  assert.deepEqual(await store.get(ref, { signers: [payer.publicKey], mode: "transactions" }), data);
  assert.ok(chain.batches > 5, "batches were used");
  const perRequest = (u: string) => chain.perUrlCalls.get(u)! / chain.perUrl.get(u)!;
  assert.ok(perRequest(urls[2]!) >= 3, `the batching endpoint carried ${perRequest(urls[2]!).toFixed(1)} calls per request`);
  if (chain.perUrl.get(urls[1]!)) assert.ok(perRequest(urls[1]!) >= 1.5, `the endpoint with per-call limits still batched (${perRequest(urls[1]!).toFixed(1)} calls per request)`);
  // which endpoint gets how much work depends on timing; what must hold is how each one is used
  if (chain.perUrl.get(urls[0]!)) assert.ok(perRequest(urls[0]!) < 1.5, "the endpoint without batch support got single calls");

  // an endpoint that refuses batches works alone too: chainboot notices once and sends single calls
  const alone = new FakeChain(), only = alone.urls(1);
  alone.faults.set(only[0]!, { noBatch: true });
  const notes: string[] = [];
  const soloStore = new ChainStore(new RpcPool(only, { fetch: alone.fetch, initialRate: 400, onNote: (t) => notes.push(t) }));
  const soloRef = await soloStore.put(payer, data.subarray(0, 60_000), { pollMs: 20, txVersion: "legacy" });
  assert.deepEqual(await soloStore.get(soloRef, { mode: "transactions" }), data.subarray(0, 60_000));
  assert.equal(notes.filter((t) => t.includes("does not accept batched requests")).length, 1);
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

test("pointers: one honest endpoint is enough to see the newest record; invented entries are ignored", async () => {
  const chain = new FakeChain(), urls = chain.urls(3);
  const store = new ChainStore(new RpcPool(urls, { fetch: chain.fetch, initialRate: 200 }));
  const me = Keypair.generate(), tag = tagAddress("catalog", me.publicKey);
  await store.putPointer(me, tag, Buffer.from("old"));
  await store.putPointer(me, tag, Buffer.from("new"));

  // two endpoints are behind (or hide the newest record), one is honest
  chain.faults.set(urls[0]!, { hideNewest: 1 });
  chain.faults.set(urls[1]!, { hideNewest: 1 });
  for (let i = 0; i < 5; i++) assert.equal((await store.getPointer(tag, [me.publicKey]))!.payload.toString(), "new");

  // an endpoint that puts a made-up signature on top cannot break or redirect the lookup
  chain.faults.set(urls[0]!, { inventNewest: true });
  chain.faults.set(urls[1]!, {});
  for (let i = 0; i < 5; i++) assert.equal((await store.getPointer(tag, [me.publicKey]))!.payload.toString(), "new");

  // with a single endpoint there is nobody to compare with: a record it lists but cannot produce is an error, not silence
  const solo = new ChainStore(new RpcPool([urls[0]!], { fetch: chain.fetch, initialRate: 200 }));
  await assert.rejects(solo.getPointer(tag, [me.publicKey]), /could not get a valid copy/);
  // asking one endpoint only is the old behaviour and can be chosen explicitly
  chain.faults.set(urls[0]!, { hideNewest: 1 });
  assert.equal((await solo.getPointer(tag, [me.publicKey]))!.payload.toString(), "old");
});

test("pointers: an old record passed off as new, a record from elsewhere, and a flood by strangers do not change the answer", async () => {
  const chain = new FakeChain(), urls = chain.urls(3);
  const pool = () => new RpcPool(urls, { fetch: chain.fetch, initialRate: 400 });
  const store = new ChainStore(pool());
  const me = Keypair.generate(), tag = tagAddress("state", me.publicKey, "a"), elsewhere = tagAddress("state", me.publicKey, "b");
  const opts = { commitment: "confirmed" as const };
  const first = await store.putPointer(me, tag, Buffer.from("v1"), opts);
  await store.putPointer(me, tag, Buffer.from("v2"), opts);
  const other = await store.putPointer(me, elsewhere, Buffer.from("of another machine"), opts);
  const newest = async (s = store) => (await s.getPointer(tag, [me.publicKey]))?.payload.toString();
  const v2 = (await store.getPointer(tag, [me.publicKey]))!;
  assert.ok(v2.seq > 0n, "the writer's sequence number comes back with the record");

  // one endpoint lists the old record on top, with a slot from the future: the sequence number its writer signed decides
  chain.faults.set(urls[0]!, { promote: [first] });
  for (let i = 0; i < 4; i++) assert.equal(await newest(new ChainStore(pool())), "v2");
  // one endpoint lists a genuine record of the same writer that belongs to another tag
  chain.faults.set(urls[0]!, { promote: [other] });
  for (let i = 0; i < 4; i++) assert.equal(await newest(new ChainStore(pool())), "v2");
  // also when that endpoint is the only one: the record does not name this tag, so it is none
  assert.equal(await newest(new ChainStore(new RpcPool([urls[0]!], { fetch: chain.fetch, initialRate: 400 }))), "v2");
  chain.faults.clear();

  // pointers written before there were sequence numbers are still read, and any newer write wins over them
  const { TxSender, itemKey } = await import("../src/store/sender.ts");
  const legacyTag = tagAddress("legacy", me.publicKey), legacy = Buffer.concat([Buffer.from([0xcb, 0x10, 1]), Buffer.from("from an earlier release")]);
  await new TxSender(pool(), me).sendAll([{ data: legacy, readonlyAccounts: [legacyTag], key: itemKey(legacy) }], { commitment: "confirmed" });
  const old = (await store.getPointer(legacyTag, [me.publicKey]))!;
  assert.deepEqual([old.payload.toString(), old.seq], ["from an earlier release", 0n]);
  await store.putPointer(me, legacyTag, Buffer.from("today"), opts);
  assert.equal((await store.getPointer(legacyTag, [me.publicKey]))!.payload.toString(), "today");

  // strangers bury the address under their own transactions: the owner's record is still found, further back
  const strangers = Array.from({ length: 6 }, () => Keypair.generate());
  for (let round = 0; round < 11; round++) await Promise.all(strangers.map((k) => new TxSender(pool(), k).sendAll([{ data: Buffer.concat([legacy, Buffer.from(String(round))]), readonlyAccounts: [tag], key: itemKey(Buffer.from(`${k.address}${round}`)) }], { commitment: "confirmed" })));
  assert.ok((chain.byAccount.get(b58encode(tag)) ?? []).length > 60, "more foreign transactions than one page holds");
  assert.equal(await newest(new ChainStore(pool())), "v2");
  // and a key that never wrote there has no record: that is found out, not guessed
  assert.equal(await store.getPointer(tag, [Keypair.generate().publicKey]), null);
  // the owner's next write is newer than everything, whatever was read before
  await store.putPointer(me, tag, Buffer.from("v3"), opts);
  assert.equal(await newest(new ChainStore(pool())), "v3");
});

test("store: what an object or a reference claims is checked before anything is fetched or set aside for it", async () => {
  const chain = new FakeChain();
  const store = new ChainStore(new RpcPool(chain.urls(2), { fetch: chain.fetch, initialRate: 400 }));
  const payer = Keypair.generate(), data = crypto.randomBytes(120_000), dir = tmp();
  const ref = await store.put(payer, data, { commitment: "confirmed", pollMs: 20, txVersion: "legacy" });

  // a hash becomes a file name in the cache: nothing but a hash may pass (the file it names would be read, and deleted)
  const victim = path.join(dir, "victim");
  fs.writeFileSync(victim, "keep me");
  await assert.rejects(store.get({ sig: ref.sig, size: ref.size, sha256: "../victim" }, { cacheDir: path.join(dir, "cache") }), /is not a SHA-256/);
  await assert.rejects(store.get(ref.sig, { sha256: "../victim", cacheDir: path.join(dir, "cache") }), /is not a SHA-256/);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me");

  // the size in the head is compared with what the reference says, or with a limit, before memory is set aside
  await assert.rejects(store.get({ ...ref, size: ref.size - 1 }), /expected 119999/);
  await assert.rejects(store.get(ref.sig, { maxSize: 50_000 }), /more than the 50000 accepted/);
  assert.ok((await store.get(ref.sig, { maxSize: 200_000 })).equals(data));

  // the same content stored twice: an interrupted download of one does not get in the way of the other
  const again = await store.put(Keypair.generate(), data, { commitment: "confirmed", pollMs: 20 });
  const cache = path.join(dir, "cache2"), ac = new AbortController();
  await assert.rejects(store.get(ref, { cacheDir: cache, signal: ac.signal, mode: "transactions", onProgress: (p) => { if (p.done > 5) ac.abort(); } }), /aborted/);
  assert.ok(fs.readdirSync(cache).some((f) => f.endsWith(".part.sigs")), "the interrupted download left its partial files");
  assert.ok((await store.get(again, { cacheDir: cache })).equals(data));
});

test("priority fee: the store's default tip is on every transaction it sends", async () => {
  const chain = new FakeChain();
  const pool = new RpcPool(chain.urls(2), { fetch: chain.fetch, initialRate: 400 });
  const payer = Keypair.generate(), data = crypto.randomBytes(40_000);
  const plain = new ChainStore(pool), tipped = new ChainStore(pool, { priorityFeeLamports: 1500 });

  let before = chain.fees, count = chain.txs.size;
  await plain.put(payer, data, { pollMs: 20 });
  const n = chain.txs.size - count;
  assert.equal(chain.fees - before, n * 5000);

  before = chain.fees; count = chain.txs.size;
  const ref = await tipped.put(payer, data, { pollMs: 20 });
  await tipped.putPointer(payer, tagAddress("t"), Buffer.from("x"));
  const m = chain.txs.size - count;
  assert.equal(chain.fees - before, m * (5000 + 1500), "every transaction carried the tip");
  assert.equal(ChainStore.plan(data.length, { priorityFeeLamports: 1500 }).feeLamports, (m - 1) * 6500, "and the plan predicted the cost");
  assert.deepEqual(await plain.get(ref), data, "a tipped object reads like any other");
  // a call can still override the default
  before = chain.fees; count = chain.txs.size;
  await tipped.put(payer, crypto.randomBytes(100), { pollMs: 20, priorityFeeLamports: 0 });
  assert.equal(chain.fees - before, 5000);
});

test("rootless: the reserved ID range of a user is found by name or number, and a free one is proposed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-subid-"));
  const file = path.join(dir, "subuid");
  fs.writeFileSync(file, "alice:100000:65536\n# comment\nbob:165536:1000\n1002:231072:65536\ncarol:296608:131072\n\n");
  assert.deepEqual(subRange(file, "alice", 1000), { start: 100000, count: 65536 });
  assert.equal(subRange(file, "bob", 1001), null, "a range that is too small does not count");
  assert.deepEqual(subRange(file, "dave", 1002), { start: 231072, count: 65536 }, "an entry may name the user by number");
  assert.deepEqual(subRange(file, "carol", 1003), { start: 296608, count: 131072 });
  assert.equal(subRange(file, "erin", 1004), null);
  assert.equal(subRange(path.join(dir, "missing"), "alice", 1000), null);
  assert.equal(freeRange(file), 296608 + 131072, "a new range starts after every existing one");
  assert.equal(freeRange(path.join(dir, "missing")), 100000);
  assert.equal(SUB_IDS, 65536);
});

test("browser reader: finds, downloads and verifies an image with web APIs only, also when endpoints misbehave", async () => {
  const { Reader, entries, fileContent, canVerify, tagAddress: webTag, b58encode: webEncode, b58decode: webDecode } = await import("../src/browser/reader.ts");
  const { publishImage } = await import("../src/registry/registry.ts");
  const { buildImage } = await import("../src/image/build.ts");
  assert.equal(await canVerify(), true);
  // the reader's own helpers agree with the SDK's
  const sample = crypto.randomBytes(32);
  assert.equal(webEncode(sample), b58encode(sample));
  assert.deepEqual(Buffer.from(webDecode(b58encode(sample), 32)), sample);
  assert.deepEqual(Buffer.from(await webTag("catalog", sample)), tagAddress("catalog", sample));

  const chain = new FakeChain();
  const store = new ChainStore(new RpcPool(chain.urls(3), { fetch: chain.fetch, initialRate: 500 }));
  const publisher = Keypair.generate();
  const T = 1_700_000_000, own = { uid: 0, gid: 0, mtime: T };
  const big = crypto.randomBytes(180_000), lib = Buffer.alloc(120_000, "abc");
  const built = buildImage([
    { path: "etc", type: "d", mode: 0o755, ...own }, { path: "etc/os-release", type: "f", mode: 0o644, ...own, data: Buffer.from("NAME=demo\n") },
    { path: "usr", type: "d", mode: 0o755, ...own }, { path: "usr/big.bin", type: "f", mode: 0o755, ...own, data: big }, { path: "usr/lib.so", type: "f", mode: 0o644, ...own, data: lib },
    { path: "usr/link", type: "l", mode: 0o777, ...own, link: "lib.so" }, { path: "etc/empty", type: "f", mode: 0o600, ...own, data: Buffer.alloc(0) },
  ], { name: "demo", version: "1.0", arch: "amd64", description: "for the browser" });
  await publishImage(store, publisher, built, { commitment: "confirmed" });

  const steps: string[] = [];
  const read = async (reader: InstanceType<typeof Reader>) => {
    const cat = await reader.catalog(publisher.address);
    assert.deepEqual(Object.keys(cat.images), ["demo"]);
    assert.equal(cat.images.demo!.description, "for the browser");
    const ref = cat.images.demo!.tags.latest!.amd64!;
    const manifest = await reader.manifest(publisher.address, ref);
    assert.equal(manifest.digest, built.manifest.digest);
    const list = entries(manifest);
    assert.deepEqual(list.map((e) => `${e.path} ${e.type}`).sort(), ["etc d", "etc/empty f", "etc/os-release f", "usr d", "usr/big.bin f", "usr/lib.so f", "usr/link l"]);
    assert.equal(list.find((e) => e.path === "usr/link")!.target, "lib.so");
    const packs = await Promise.all(manifest.packs.map((_, i) => reader.pack(manifest, i)));
    const content = async (p: string) => { const e = list.find((x) => x.path === p)!; return Buffer.from(await fileContent(e, e.size ? packs[e.pack!]! : new Uint8Array(0))); };
    assert.ok((await content("usr/big.bin")).equals(big));
    assert.ok((await content("usr/lib.so")).equals(lib));
    assert.equal((await content("etc/os-release")).toString(), "NAME=demo\n");
    assert.equal((await content("etc/empty")).length, 0);
    // a file cut from the wrong place is noticed
    const e = list.find((x) => x.path === "usr/lib.so")!;
    await assert.rejects(fileContent({ ...e, offset: e.offset! + 1 }, packs[e.pack!]!), /does not match its hash/);
    return manifest;
  };

  // healthy endpoints: block mode keeps the number of requests far below the number of transactions
  const good = new Reader({ endpoints: chain.urls(2), fetch: chain.fetch, onStep: (l) => steps.push(l) });
  await read(good);
  assert.ok(steps.some((l) => l.startsWith("catalog pointer: signed by")) && steps.some((l) => l.startsWith("pack 1/")));
  assert.ok(good.requests < chain.txs.size / 2, `${good.requests} requests for ${chain.txs.size} transactions`);

  // one endpoint returns other or altered transactions, hides the newest catalog and is sometimes busy: the result is the same
  chain.faults.set(chain.urls(2)[0]!, { corrupt: 0.4, hideNewest: 1, rateLimit: 0.15, missing: 0.1 });
  await read(new Reader({ endpoints: chain.urls(2), fetch: chain.fetch }));
  chain.faults.clear();
  // endpoints without getBlock: transaction by transaction
  for (const u of chain.urls(2)) chain.faults.set(u, { noBlocks: true });
  await read(new Reader({ endpoints: chain.urls(2), fetch: chain.fetch }));
  chain.faults.clear();

  // somebody else's key: their catalog is empty, and the real manifest is not accepted as theirs
  const stranger = Keypair.generate();
  const reader = new Reader({ endpoints: chain.urls(2), fetch: chain.fetch });
  assert.deepEqual((await reader.catalog(stranger.address)).images, {});
  const ref = (await reader.catalog(publisher.address)).images.demo!.tags.latest!.amd64!;
  await assert.rejects(reader.manifest(stranger.address, ref), /not published by a trusted key/);
  await assert.rejects(reader.object({ sig: ref.sig, sha256: "0".repeat(64) }), /SHA-256 differs/);
});

test("lists: an image counts when enough publishers have the same content; one key alone changes nothing", async () => {
  const { publishImage, pullImage, readCatalog, endorseImage } = await import("../src/registry/registry.ts");
  const { parseList, formatList, readList } = await import("../src/registry/lists.ts");
  const { buildImage } = await import("../src/image/build.ts");
  const { Reader } = await import("../src/browser/reader.ts");
  const chain = new FakeChain();
  const store = new ChainStore(new RpcPool(chain.urls(3), { fetch: chain.fetch, initialRate: 500 }));
  const [a, b, c, outsider] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const spec = parseList(`list:2:${a.address},${b.address},${c.address}`);
  assert.equal(formatList(spec), `list:2:${a.address},${b.address},${c.address}`);
  assert.throws(() => parseList(`list:1:${a.address},${b.address}`), /more than half/);
  assert.throws(() => parseList(`list:2:${a.address},${b.address},${c.address},${outsider.address}`), /more than half/);
  assert.throws(() => parseList(`list:3:${a.address},${b.address}`), /cannot need 3/);
  assert.throws(() => parseList(`list:2:${a.address},${a.address},${b.address}`), /each member once/);
  assert.throws(() => parseList(`list:2:${a.address},nonsense`), /not a list|not a Solana address/);
  assert.throws(() => parseList(a.address), /not a list/);

  const own = { uid: 0, gid: 0, mtime: 1_700_000_000 };
  const image = (text: string, version: string) => buildImage([{ path: "etc", type: "d", mode: 0o755, ...own }, { path: "etc/os-release", type: "f", mode: 0o644, ...own, data: Buffer.from(text) }, { path: "etc/blob", type: "f", mode: 0o644, ...own, data: crypto.randomBytes(9000) }], { name: "demo", version, arch: "amd64", description: "kept by three" });
  const opts = { commitment: "confirmed" as const };

  // one publisher alone: nothing is in the list
  const v1 = image("VERSION=1\n", "1.0");
  await publishImage(store, a, v1, opts);
  let view = await readList(store, spec);
  assert.deepEqual(view.images, {});
  assert.deepEqual(view.waiting.map((w) => `${w.name}:${w.tag} ${w.agreed.length}`), ["demo:1.0 1", "demo:latest 1"]);
  assert.deepEqual(view.members.map((m) => [m.ok, m.images]), [[true, 1], [true, 0], [true, 0]]);

  // a second one endorses it: no upload, one catalog entry that points at what is on chain
  const entry = (await readCatalog(store, a.address)).images.demo!.tags.latest!.amd64!;
  const txBefore = chain.txs.size;
  await endorseImage(store, b, { name: "demo", tags: ["1.0", "latest"], arch: "amd64", ref: entry, publisher: a.address }, "confirmed");
  assert.ok(chain.txs.size - txBefore <= 3, "endorsing stores a catalog and a pointer, not the image");
  assert.equal((await readCatalog(store, b.address)).images.demo!.tags.latest!.amd64!.publisher, a.address);
  view = await readList(store, spec);
  const listed = view.images.demo!.tags.latest!.amd64!;
  assert.deepEqual(listed.agreed, [a.address, b.address]);
  assert.equal(listed.publisher, a.address);
  assert.equal(view.images.demo!.description, "kept by three");
  const pulled = await pullImage(store, listed.publisher, listed, { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-list-")) });
  assert.equal(pulled.manifest.digest, v1.manifest.digest);
  // an endorsed entry also works on its own, from the endorser's catalog
  const viaB = (await readCatalog(store, b.address)).images.demo!.tags.latest!.amd64!;
  assert.equal((await pullImage(store, b.address, viaB, { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-list-")) })).manifest.digest, v1.manifest.digest);

  // the third member (a stolen key, say) puts a different system under the same name: it does not get in
  await publishImage(store, c, image("VERSION=evil\n", "1.0"), opts);
  view = await readList(store, spec);
  assert.equal(view.images.demo!.tags.latest!.amd64!.digest, v1.manifest.digest);
  assert.ok(view.waiting.some((w) => w.tag === "latest" && w.agreed.length === 1 && w.agreed[0] === c.address));
  // somebody who is not a member has no say at all
  await endorseImage(store, outsider, { name: "demo", tags: ["latest"], arch: "amd64", ref: (await readCatalog(store, c.address)).images.demo!.tags.latest!.amd64!, publisher: c.address }, "confirmed");
  assert.equal((await readList(store, spec)).images.demo!.tags.latest!.amd64!.digest, v1.manifest.digest);

  // an update: "latest" moves only when a second member follows; version tags stay
  const v2 = image("VERSION=2\n", "2.0");
  await publishImage(store, a, v2, opts);
  const between = await readList(store, spec);
  assert.equal(between.images.demo!.tags["1.0"]!.amd64!.digest, v1.manifest.digest, "1.0 is still agreed by two");
  assert.ok(!("latest" in between.images.demo!.tags), "a and b now disagree about latest: nobody gets either until one follows");
  const e2 = (await readCatalog(store, a.address)).images.demo!.tags.latest!.amd64!;
  await endorseImage(store, b, { name: "demo", tags: ["2.0", "latest"], arch: "amd64", ref: e2, publisher: a.address }, "confirmed");
  const moved = await readList(store, spec);
  assert.equal(moved.images.demo!.tags.latest!.amd64!.digest, v2.manifest.digest);
  assert.equal(moved.images.demo!.tags.latest!.amd64!.version, "2.0");

  // a member whose catalog cannot be read does not stop the list, as long as enough others can
  await store.putPointer(c, tagAddress("catalog", c.publicKey), Buffer.from("not a catalog"), { commitment: "confirmed" });
  const partial = await readList(store, spec);
  assert.equal(partial.members[2]!.ok, false);
  assert.equal(partial.images.demo!.tags.latest!.amd64!.digest, v2.manifest.digest);

  // the browser reader sees the same list
  const web = new Reader({ endpoints: chain.urls(2), fetch: chain.fetch });
  const seen = await web.list(spec.members, spec.threshold);
  assert.deepEqual(seen.unreadable, [c.address]);
  assert.deepEqual(seen.agreed["demo:latest:amd64"], [a.address, b.address]);
  const viaWeb = seen.images.demo!.tags.latest!.amd64!;
  assert.equal((await web.manifest(viaWeb.publisher!, viaWeb)).digest, v2.manifest.digest);
  await assert.rejects(web.list([a.address, b.address], 1), /more than half/);

  // with too few readable catalogs there is no list at all, rather than a smaller one
  await store.putPointer(b, tagAddress("catalog", b.publicKey), Buffer.from("not a catalog either"), { commitment: "confirmed" });
  await assert.rejects(readList(store, spec), /only 1 of the list's 3 catalogs could be read/);
  await assert.rejects(web.list(spec.members, spec.threshold), /only 1 of the list's 3 catalogs could be read/);
});

test("accounts: a pointer kept in an account is read with one request, cannot be made up, and is never left behind", async () => {
  const { accountAddress, decodeRecord, encodeRecord, ACCOUNT_PAYLOAD_MAX } = await import("../src/store/accounts.ts");
  const { Reader, tagAddress: webTag } = await import("../src/browser/reader.ts");
  const chain = new FakeChain();
  const pool = () => new RpcPool(chain.urls(2), { fetch: chain.fetch, initialRate: 500 });
  const fast = new ChainStore(pool(), { accounts: true }), plain = new ChainStore(pool());
  const owner = Keypair.generate(), stranger = Keypair.generate();
  const tag = tagAddress("demo", owner.publicKey);
  const address = b58encode(accountAddress(owner.publicKey, tag));
  const opts = { commitment: "confirmed" as const };

  // the record itself: only the owner's signature for this tag makes it valid
  const rec = encodeRecord(owner, tag, Buffer.from("hello"), 5n);
  assert.deepEqual(decodeRecord(rec, tag, owner.publicKey), { seq: 5n, payload: Buffer.from("hello") });
  assert.equal(decodeRecord(rec, tag, stranger.publicKey), null);
  assert.equal(decodeRecord(rec, tagAddress("other", owner.publicKey), owner.publicKey), null, "a record cannot be moved to another tag");
  assert.equal(decodeRecord(encodeRecord(stranger, tag, Buffer.from("hello"), 9n), tag, owner.publicKey), null);
  assert.deepEqual(decodeRecord(encodeRecord(owner, tag, null, 6n), tag, owner.publicKey), { seq: 6n, payload: null });
  assert.throws(() => encodeRecord(owner, tag, Buffer.alloc(ACCOUNT_PAYLOAD_MAX + 1), 1n), /does not fit/);

  // without the setting nothing changes: no account, the pointer is found through the transactions
  await plain.putPointer(owner, tag, Buffer.from("v0"), opts);
  assert.equal(chain.accounts.size, 0);
  assert.equal((await plain.getPointer(tag, [owner.publicKey]))!.account, undefined);

  // with it: the account is created, and one transaction carries the pointer and the account's new content
  const before = chain.txs.size;
  const sig1 = await fast.putPointer(owner, tag, Buffer.from("v1"), opts);
  assert.equal(chain.txs.size - before, 2, "one transaction to create the account, one for pointer and record together");
  assert.ok(chain.accounts.has(address));
  let got = (await plain.getPointer(tag, [owner.publicKey]))!;
  assert.equal(got.payload.toString(), "v1");
  assert.equal(got.account, address, "readers find the account by themselves");
  const viaTx = (await plain.getPointer(tag, [owner.publicKey], { accounts: false }))!;
  assert.equal(viaTx.payload.toString(), "v1");
  assert.equal(viaTx.signature, sig1, "the same transaction is the pointer in the ledger");

  // every later write keeps it current, also from a writer that has the setting off
  await plain.putPointer(owner, tag, Buffer.from("v2"), opts);
  got = (await plain.getPointer(tag, [owner.publicKey]))!;
  assert.deepEqual([got.payload.toString(), got.account], ["v2", address]);

  // a pointer too long for the account: the account sends readers to the transactions instead of showing the old one
  const long = crypto.randomBytes(ACCOUNT_PAYLOAD_MAX + 100);
  await plain.putPointer(owner, tag, long, opts);
  got = (await plain.getPointer(tag, [owner.publicKey]))!;
  assert.ok(got.payload.equals(long));
  assert.equal(got.account, undefined);
  await plain.putPointer(owner, tag, Buffer.from("v4"), opts);
  got = (await plain.getPointer(tag, [owner.publicKey]))!;
  assert.deepEqual([got.payload.toString(), got.account], ["v4", address]);

  // endpoints that make account data up are not believed: the reader falls back to the transactions
  for (const u of chain.urls(2)) chain.faults.set(u, { forgeAccounts: true });
  got = (await new ChainStore(pool()).getPointer(tag, [owner.publicKey]))!;
  assert.deepEqual([got.payload.toString(), got.account], ["v4", undefined]);
  // one endpoint that is behind (shows the account as it was) loses against one that is not
  chain.faults.clear();
  chain.faults.set(chain.urls(2)[0]!, { staleAccounts: true });
  got = (await new ChainStore(pool()).getPointer(tag, [owner.publicKey]))!;
  assert.equal(got.payload.toString(), "v4");
  chain.faults.clear();

  // nobody else can write into the owner's account, and a stranger's own account is at another address
  await fast.putPointer(stranger, tag, Buffer.from("evil"), opts);
  assert.notEqual(b58encode(accountAddress(stranger.publicKey, tag)), address);
  assert.equal((await plain.getPointer(tag, [owner.publicKey]))!.payload.toString(), "v4");

  // the browser reader takes the same quick way
  const web = new Reader({ endpoints: chain.urls(2), fetch: chain.fetch });
  const seen = (await web.pointer(await webTag("demo", owner.publicKey), [owner.publicKey]))!;
  assert.deepEqual([Buffer.from(seen.payload).toString(), seen.account], ["v4", address]);
  assert.equal(Buffer.from((await web.pointer(await webTag("demo", owner.publicKey), [owner.publicKey], { accounts: false }))!.payload).toString(), "v4");

  // closing gives the deposit back; the pointer is still in the ledger
  const back = await plain.closePointerAccount(owner, tag);
  assert.ok(back > 3_000_000 && back < 6_000_000, `deposit returned: ${back}`);
  assert.ok(!chain.accounts.has(address));
  assert.equal(await plain.closePointerAccount(owner, tag), 0);
  got = (await plain.getPointer(tag, [owner.publicKey]))!;
  assert.deepEqual([got.payload.toString(), got.account], ["v4", undefined]);
});

test("disk: the script that builds a bootable disk is valid shell", { skip: process.platform === "win32" && "needs a POSIX shell" }, async () => {
  const { DISK_SCRIPT, DISK_FILE, DISK_WORK } = await import("../src/engine/disk.ts");
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("sh", ["-n", "-c", DISK_SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!DISK_SCRIPT.includes('"$"') && DISK_SCRIPT.includes("${K#/boot/vmlinuz-}"), "shell variables arrive in the script as the shell wants them");
  assert.ok(DISK_SCRIPT.includes(`--exclude=./${DISK_WORK}`) && DISK_FILE.startsWith(DISK_WORK), "the work directory is not copied into the disk");
  // the directory it works in is one that saves leave out
  const { isUnsaved } = await import("../src/state/scan.ts");
  assert.ok(isUnsaved(DISK_FILE));
});

test("other chains: without the Noop program the data travels as a memo, and every reader understands both", async () => {
  const { publishImage, pullImage, readCatalog } = await import("../src/registry/registry.ts");
  const { buildImage } = await import("../src/image/build.ts");
  const { Reader } = await import("../src/browser/reader.ts");
  const { MEMO_PROGRAM, NOOP_PROGRAM, dataInstructions, carriedData, noopCapacity } = await import("../src/solana/tx.ts");
  const chain = new FakeChain();
  const pool = () => new RpcPool(chain.urls(2), { fetch: chain.fetch, initialRate: 500 });
  const memo = new ChainStore(pool(), { carrier: "memo", txVersion: "legacy" }), plain = new ChainStore(pool());
  const payer = Keypair.generate();

  // the carrier itself
  const bytes = Buffer.concat([Buffer.from([0xcb, 0x00]), crypto.randomBytes(300)]);
  const [ix, ...rest] = dataInstructions("memo", payer.publicKey, bytes, [tagAddress("t")]);
  assert.ok(Buffer.from(ix!.programId).equals(MEMO_PROGRAM) && ix!.keys.length === 0, "the memo gets no accounts (it would demand their signatures)");
  assert.match(Buffer.from(ix!.data).toString("ascii"), /^[A-Za-z0-9+/]+=*$/, "the memo is text");
  assert.equal(rest.length, 1, "a tag is named by a transfer of nothing to it");
  assert.deepEqual(Buffer.from(carriedData(MEMO_PROGRAM, ix!.data, 0xcb)!), bytes);
  assert.equal(carriedData(MEMO_PROGRAM, Buffer.from("just a memo somebody wrote"), 0xcb), null);
  assert.equal(carriedData(MEMO_PROGRAM, Buffer.from(Buffer.from("not ours").toString("base64")), 0xcb), null);
  assert.deepEqual(Buffer.from(carriedData(NOOP_PROGRAM, bytes, 0xcb)!), bytes);
  const room = noopCapacity({ carrier: "memo" }), roomTagged = noopCapacity({ carrier: "memo", readonlyAccounts: 1 });
  assert.ok(room > 700 && room < noopCapacity({ version: "legacy" }) && roomTagged < room, `a memo carries less: ${room} bytes, ${roomTagged} with a tag`);

  // objects and pointers written as memos fit their transactions and come back intact
  const data = crypto.randomBytes(40_000);
  const ref = await memo.put(payer, data, { commitment: "confirmed" });
  for (const t of chain.txs.values()) assert.ok(Buffer.from(t.raw, "base64").length <= 1232, "every transaction keeps the legacy size limit");
  assert.ok(chain.txs.size > 50, "40 kB take more transactions this way");
  assert.ok((await plain.get(ref)).equals(data), "a reader needs no setting to read them");
  const tag = tagAddress("demo", payer.publicKey);
  await memo.putPointer(payer, tag, Buffer.from("first"), { commitment: "confirmed" });
  // (a pointer has 11 bytes of its own in front of the payload: magic, kind, version and its sequence number)
  await memo.putPointer(payer, tag, Buffer.alloc(roomTagged - 11, 7), { commitment: "confirmed" });
  await assert.rejects(memo.putPointer(payer, tag, Buffer.alloc(roomTagged - 10), { commitment: "confirmed" }), /the limit is/);
  assert.ok((await plain.getPointer(tag, [payer.publicKey]))!.payload.equals(Buffer.alloc(roomTagged - 11, 7)));
  assert.equal(await plain.getPointer(tag, [Keypair.generate().publicKey]), null);

  // a whole image, published and read on such a chain; also by the browser reader
  const own = { uid: 0, gid: 0, mtime: 1_700_000_000 };
  const built = buildImage([{ path: "etc", type: "d", mode: 0o755, ...own }, { path: "etc/os-release", type: "f", mode: 0o644, ...own, data: Buffer.from("NAME=elsewhere\n") }, { path: "etc/blob", type: "f", mode: 0o644, ...own, data: crypto.randomBytes(30_000) }], { name: "demo", version: "1", arch: "amd64" });
  await publishImage(memo, payer, built, { commitment: "confirmed" });
  const entry = (await readCatalog(plain, payer.address)).images.demo!.tags.latest!.amd64!;
  assert.equal((await pullImage(plain, payer.address, entry, { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "cb-memo-")) })).manifest.digest, built.manifest.digest);
  const web = new Reader({ endpoints: chain.urls(2), fetch: chain.fetch });
  const seen = (await web.catalog(payer.address)).images.demo!.tags.latest!.amd64!;
  assert.equal((await web.manifest(payer.address, seen)).digest, built.manifest.digest);
});

test("sender: a transaction that fails on chain is not paid for again and again", async () => {
  const chain = new FakeChain();
  const store = new ChainStore(new RpcPool(chain.urls(2), { fetch: chain.fetch, initialRate: 500 }));
  const payer = Keypair.generate();
  chain.failOnChain = { InstructionError: [0, "ProgramFailedToComplete"] };
  // one small object: one transaction
  await assert.rejects(store.put(payer, crypto.randomBytes(500), { commitment: "confirmed", pollMs: 50, resendAfterMs: 200 }), /failed on chain twice and was not sent a third time.*ProgramFailedToComplete/);
  // (the second try is the same transaction when the blockhash has not changed, and the chain charges that only once)
  assert.ok(chain.failedTxs.size >= 1 && chain.failedTxs.size <= 2, "it was tried once more, then given up");
  assert.ok(chain.fees <= 10_000);
  // a larger one: the upload stops instead of grinding through every part twice
  const before = chain.failedTxs.size;
  await assert.rejects(store.put(payer, crypto.randomBytes(400_000), { commitment: "confirmed", pollMs: 50, resendAfterMs: 200 }), /failed on chain twice/);
  assert.ok(chain.failedTxs.size - before < 2 * 110, `${chain.failedTxs.size - before} failed transactions for 104 parts`);
  // and nothing is wrong with the sender afterwards
  chain.failOnChain = null;
  const data = crypto.randomBytes(20_000);
  assert.ok((await store.get(await store.put(payer, data, { commitment: "confirmed" }))).equals(data));
});

test("lazy layout: the same image in small packs, with the files a start reads first", async () => {
  const { buildImage, LAZY_PACK_RAW } = await import("../src/image/build.ts");
  const { buildInodes } = await import("../src/engine/fuse.ts");
  const own = { uid: 0, gid: 0, mtime: 1_700_000_000 };
  const file = (p: string, size: number, mode = 0o644) => ({ path: p, type: "f" as const, mode, ...own, data: crypto.randomBytes(size) });
  const dir = (p: string) => ({ path: p, type: "d" as const, mode: 0o755, ...own });
  const entries = [dir("bin"), file("bin/sh", 900_000, 0o755), file("bin/big", 3_000_000, 0o755), dir("etc"), file("etc/passwd", 2_000), file("etc/hosts", 300), dir("usr"), dir("usr/lib"),
    ...Array.from({ length: 12 }, (_, i) => file(`usr/lib/lib${String(i).padStart(2, "0")}.so`, 1_000_000)), file("usr/lib/libc.so", 2_000_000),
    { path: "bin/link", type: "l" as const, mode: 0o777, ...own, link: "sh" }, { path: "bin/hard", type: "h" as const, mode: 0o755, ...own, link: "bin/sh" }];
  const meta = { name: "demo", version: "1", arch: "amd64" };
  const small = buildImage(entries, meta), lazy = buildImage(entries, meta, { layout: "lazy" });
  const guided = buildImage(entries, meta, { layout: "lazy", startFiles: ["/usr/lib/libc.so", "bin/sh", "etc/passwd", "not/in/the/image"] });
  assert.equal(small.manifest.packs.length, 1);
  assert.equal(lazy.manifest.digest, small.manifest.digest, "the packing does not change what the image is");
  assert.equal(guided.manifest.digest, small.manifest.digest);
  assert.ok(lazy.manifest.packs.length >= 5 && lazy.manifest.packs.every((p) => p.rawSize <= LAZY_PACK_RAW), `packs of a few megabytes: ${lazy.manifest.packs.map((p) => p.rawSize)}`);
  const packOf = (b: typeof lazy, p: string) => (b.manifest.tree.find((n) => n[0] === p) as unknown as unknown[])[8] as number;
  // by path: neighbours in a directory share a pack
  assert.equal(packOf(lazy, "etc/passwd"), packOf(lazy, "etc/hosts"));
  // with a list of start files: exactly those come first, in a pack of their own, in the order given
  assert.deepEqual(["usr/lib/libc.so", "bin/sh", "etc/passwd"].map((p) => packOf(guided, p)), [0, 0, 0]);
  assert.equal(guided.manifest.packs[0]!.rawSize, 2_000_000 + 900_000 + 2_000, "nothing else is in the start pack");
  const offsets = ["usr/lib/libc.so", "bin/sh", "etc/passwd"].map((p) => (guided.manifest.tree.find((n) => n[0] === p) as unknown as unknown[])[9] as number);
  assert.deepEqual(offsets, [0, 2_000_000, 2_900_000]);
  assert.ok(packOf(guided, "etc/hosts") > 0 && packOf(guided, "bin/big") > 0);

  // the tree as the lazy file system sees it
  const inodes = buildInodes(guided.manifest);
  const root = inodes[0]!;
  assert.deepEqual([...root.children!.keys()].sort(), ["bin", "etc", "usr"]);
  const bin = root.children!.get("bin")!;
  assert.equal(bin.children!.get("hard"), bin.children!.get("sh"), "a hard link is the same inode under a second name");
  assert.equal(bin.children!.get("sh")!.nlink, 2);
  assert.equal(bin.children!.get("link")!.target, "sh");
  assert.equal(root.nlink, 2 + 3, "a directory counts its sub-directories");
  assert.equal(new Set(inodes.map((i) => i.ino)).size, inodes.length);
});
