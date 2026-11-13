import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { xzDecode, xzUncompressedSize } from "../src/codec/xz.ts";

const hasXz = spawnSync("xz", ["--version"]).status === 0;
const xz = (data: Buffer, args: string[]): Buffer => {
  const r = spawnSync("xz", ["-c", ...args], { input: data, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return r.stdout;
};

// data with long repeats, short repeats, text and noise, so every LZMA code path is used
function sample(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  let at = 0;
  while (at < size) {
    const kind = rnd() % 5, len = Math.min(size - at, 1 + (rnd() % 5000));
    if (kind === 0) for (let i = 0; i < len; i++) out[at + i] = rnd() & 0xff;
    else if (kind === 1) out.fill(rnd() & 0xff, at, at + len);
    else if (kind === 2 && at > 100) { const from = rnd() % (at - 50); for (let i = 0; i < len; i++) out[at + i] = out[from + (i % (at - from))]!; }
    else if (kind === 3) { const w = ["call ", "mov eax, ", "the ", "chain ", "boot ", "\n", "0x00ff "]; let s = ""; while (s.length < len) s += w[rnd() % w.length]; out.write(s.slice(0, len), at, "latin1"); }
    else for (let i = 0; i < len; i += 5) { out[at + i] = 0xe8; out.writeUInt32LE((rnd() % 70000) >>> 0, Math.min(at + i + 1, size - 4)); }
    at += len;
  }
  return out;
}

test("xz: decodes what the xz tool produces, with every option chainboot may use", { skip: !hasXz }, () => {
  const inputs = [Buffer.alloc(0), Buffer.from("a"), Buffer.from("hello hello hello hello"), crypto.randomBytes(70_000), sample(3_000_000, 1), sample(1_500_000, 7), Buffer.alloc(5_000_000, 0x41)];
  const variants = [["-0"], ["-6"], ["-9e"], ["-9e", "--check=crc32"], ["-6", "--check=none"], ["-6", "--check=sha256"], ["--x86", "--lzma2=preset=9e,dict=64MiB"],
    ["--arm64", "--lzma2=preset=6"], ["--lzma2=preset=6,lc=0,lp=2,pb=0"], ["--lzma2=preset=3,lc=4,lp=0,pb=4"], ["-6", "-T4", "--block-size=300KiB"]];
  for (const data of inputs) for (const args of variants) {
    const packed = xz(data, args);
    assert.equal(xzUncompressedSize(packed), data.length);
    assert.ok(xzDecode(packed).equals(data), `xz ${args.join(" ")} on ${data.length} bytes`);
  }
});

test("xz: damaged input is rejected, never returned as data", { skip: !hasXz }, () => {
  const data = sample(200_000, 3), packed = xz(data, ["-6"]);
  let rejected = 0;
  for (let i = 0; i < 200; i++) {
    const bad = Buffer.from(packed);
    const at = (i * 7919) % bad.length;
    bad[at] = bad[at]! ^ (1 << (i % 8));
    try { const out = xzDecode(bad); assert.ok(!out.equals(data) || true); if (!out.equals(data)) assert.fail("corrupt input decoded to wrong data without an error"); } catch (e) { if ((e as Error).name === "AssertionError") throw e; rejected++; }
  }
  assert.ok(rejected >= 195, `${rejected}/200 corruptions rejected`);
  assert.throws(() => xzDecode(packed.subarray(0, packed.length - 5)), /xz:/);
  assert.throws(() => xzDecode(Buffer.from("not an xz file at all, just text....")), /not an xz file/);
});
