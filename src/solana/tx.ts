// Building and parsing Solana transactions by hand, in both wire formats.
//
// "v1" (SIMD-0385, live on devnet, testnet and mainnet since 2026) allows 4096 bytes per
// transaction, more than three times the 1232 bytes of the legacy format. chainboot writes
// v1 by default, because every transaction then carries ~3.9 kB of data instead of ~1 kB,
// and reads both.
//
//   legacy: [signature count][signatures][header][accounts][blockhash][instructions]
//   v1:     [0x81][header][config mask][blockhash][counts][accounts][config values]
//           [instruction headers][instruction payloads][signatures]
import { b58decodeFixed, b58encode } from "../util/base58.ts";
import { concat, decodeShortU16, encodeShortU16, u32le, u64le } from "../util/bytes.ts";
import { Keypair, verifySignature } from "./keys.ts";

export const MAX_TX_SIZE_LEGACY = 1232;
export const MAX_TX_SIZE_V1 = 4096;
export const V1_PREFIX = 0x81;

export type TxVersion = "legacy" | 1;

export const SYSTEM_PROGRAM = b58decodeFixed("11111111111111111111111111111111", 32);
export const COMPUTE_BUDGET_PROGRAM = b58decodeFixed("ComputeBudget111111111111111111111111111111", 32);
/** SPL Noop: a program that accepts any data and does nothing. Deployed on devnet, testnet and mainnet. */
export const NOOP_PROGRAM = b58decodeFixed("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV", 32);

export interface AccountMeta { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean }
export interface Instruction { programId: Uint8Array; keys: AccountMeta[]; data: Uint8Array }

/** Resource and fee requests carried in the header of a v1 transaction. */
export interface TxConfig {
  /** Total priority fee in lamports (0 or absent: none). */
  priorityFeeLamports?: number | bigint;
  computeUnitLimit?: number;
  loadedAccountsDataSizeLimit?: number;
  heapSize?: number;
}

interface Ordered { keys: Uint8Array[]; index: Map<string, number>; header: [number, number, number] }

const id = (k: Uint8Array) => Buffer.from(k.buffer, k.byteOffset, k.byteLength).toString("latin1");

/** Orders accounts the way the runtime requires: signers first, writable before read-only, payer first. */
function orderAccounts(payer: Uint8Array, instructions: Instruction[]): Ordered {
  const metas = new Map<string, AccountMeta>();
  const add = (m: AccountMeta) => {
    const old = metas.get(id(m.pubkey));
    if (old) { old.isSigner ||= m.isSigner; old.isWritable ||= m.isWritable; }
    else metas.set(id(m.pubkey), { pubkey: m.pubkey, isSigner: m.isSigner, isWritable: m.isWritable });
  };
  add({ pubkey: payer, isSigner: true, isWritable: true });
  for (const ix of instructions) {
    for (const k of ix.keys) add(k);
    add({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  const rank = (m: AccountMeta) => (m.isSigner ? 0 : 2) + (m.isWritable ? 0 : 1);
  // stable sort keeps the payer first: it was inserted first and has rank 0
  const ordered = [...metas.values()].map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
  if (ordered.length > 64) throw new Error("a transaction can reference at most 64 accounts");
  return {
    keys: ordered.map((m) => m.pubkey),
    index: new Map(ordered.map((m, i) => [id(m.pubkey), i])),
    header: [ordered.filter((m) => m.isSigner).length, ordered.filter((m) => m.isSigner && !m.isWritable).length, ordered.filter((m) => !m.isSigner && !m.isWritable).length],
  };
}

/** Unsigned legacy message bytes. */
export function compileMessage(payer: Uint8Array, instructions: Instruction[], recentBlockhash: Uint8Array): Buffer {
  if (recentBlockhash.length !== 32) throw new Error("blockhash must be 32 bytes");
  const o = orderAccounts(payer, instructions);
  const parts: Uint8Array[] = [Uint8Array.from(o.header), Uint8Array.from(encodeShortU16(o.keys.length)), ...o.keys, recentBlockhash, Uint8Array.from(encodeShortU16(instructions.length))];
  for (const ix of instructions) {
    parts.push(
      Uint8Array.of(o.index.get(id(ix.programId))!),
      Uint8Array.from(encodeShortU16(ix.keys.length)),
      Uint8Array.from(ix.keys.map((k) => o.index.get(id(k.pubkey))!)),
      Uint8Array.from(encodeShortU16(ix.data.length)),
      ix.data,
    );
  }
  return concat(parts);
}

/** Unsigned v1 message bytes (everything before the signatures, including the 0x81 version byte). */
export function compileMessageV1(payer: Uint8Array, instructions: Instruction[], recentBlockhash: Uint8Array, config: TxConfig = {}): Buffer {
  if (recentBlockhash.length !== 32) throw new Error("blockhash must be 32 bytes");
  if (instructions.length > 64) throw new Error("a transaction can hold at most 64 instructions");
  const o = orderAccounts(payer, instructions);
  let mask = 0;
  const values: Uint8Array[] = [];
  if (config.priorityFeeLamports !== undefined && BigInt(config.priorityFeeLamports) > 0n) { mask |= 0b11; values.push(u64le(config.priorityFeeLamports)); }
  if (config.computeUnitLimit !== undefined) { mask |= 1 << 2; values.push(u32le(config.computeUnitLimit)); }
  if (config.loadedAccountsDataSizeLimit !== undefined) { mask |= 1 << 3; values.push(u32le(config.loadedAccountsDataSizeLimit)); }
  if (config.heapSize !== undefined) { mask |= 1 << 4; values.push(u32le(config.heapSize)); }
  const headers: Uint8Array[] = [], payloads: Uint8Array[] = [];
  for (const ix of instructions) {
    if (ix.keys.length > 255 || ix.data.length > 0xffff) throw new Error("instruction too large");
    const h = Buffer.alloc(4);
    h[0] = o.index.get(id(ix.programId))!; h[1] = ix.keys.length; h.writeUInt16LE(ix.data.length, 2);
    headers.push(h);
    payloads.push(Uint8Array.from(ix.keys.map((k) => o.index.get(id(k.pubkey))!)), ix.data);
  }
  return concat([Uint8Array.of(V1_PREFIX, ...o.header), u32le(mask), recentBlockhash, Uint8Array.of(instructions.length, o.keys.length), ...o.keys, ...values, ...headers, ...payloads]);
}

export interface SignedTx { signature: string; signatureBytes: Buffer; raw: Buffer }

export interface BuildOptions { version?: TxVersion; config?: TxConfig; extraSigners?: Keypair[] }

/** Compiles, signs (in account order) and serialises a transaction. */
export function buildTransaction(payer: Keypair, instructions: Instruction[], recentBlockhash: Uint8Array, opts: BuildOptions = {}): SignedTx {
  const version = opts.version ?? 1;
  const message = version === 1 ? compileMessageV1(payer.publicKey, instructions, recentBlockhash, opts.config) : compileMessage(payer.publicKey, instructions, recentBlockhash);
  const parsed = version === 1 ? parseMessageV1(message) : parseMessage(message);
  const byKey = new Map([payer, ...(opts.extraSigners ?? [])].map((k) => [k.address, k]));
  const sigs: Buffer[] = [];
  for (let i = 0; i < parsed.header.numSigners; i++) {
    const signer = byKey.get(b58encode(parsed.accountKeys[i]!));
    if (!signer) throw new Error(`missing signer for ${b58encode(parsed.accountKeys[i]!)}`);
    sigs.push(signer.sign(message));
  }
  const raw = version === 1 ? concat([message, ...sigs]) : concat([Uint8Array.from(encodeShortU16(sigs.length)), ...sigs, message]);
  const limit = version === 1 ? MAX_TX_SIZE_V1 : MAX_TX_SIZE_LEGACY;
  if (raw.length > limit) throw new Error(`transaction is ${raw.length} bytes, the limit is ${limit}`);
  return { signature: b58encode(sigs[0]!), signatureBytes: sigs[0]!, raw };
}

export interface ParsedInstruction { programId: Buffer; accounts: Buffer[]; data: Buffer }
export interface ParsedMessage {
  version: TxVersion;
  header: { numSigners: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  accountKeys: Buffer[];
  recentBlockhash: Buffer;
  instructions: ParsedInstruction[];
  /** v1 only: the raw config mask. */
  configMask?: number;
}
export interface ParsedTx extends ParsedMessage {
  signatures: Buffer[];
  /** The exact bytes the signatures cover. */
  message: Buffer;
}

function view(b: Uint8Array): Buffer {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}

export function parseMessage(message: Uint8Array): ParsedMessage {
  const buf = view(message);
  if (buf.length < 3) throw new Error("message truncated");
  if (buf[0]! & 0x80) throw new Error("v0 transactions are not supported here");
  const header = { numSigners: buf[0]!, numReadonlySigned: buf[1]!, numReadonlyUnsigned: buf[2]! };
  let at = 3;
  const need = (n: number) => { if (at + n > buf.length) throw new Error("message truncated"); };
  const short = () => { const r = decodeShortU16(buf, at); at = r.next; return r.value; };
  const nKeys = short();
  const accountKeys: Buffer[] = [];
  for (let i = 0; i < nKeys; i++) { need(32); accountKeys.push(buf.subarray(at, at + 32)); at += 32; }
  need(32);
  const recentBlockhash = buf.subarray(at, at + 32); at += 32;
  const nIx = short();
  const instructions: ParsedInstruction[] = [];
  for (let i = 0; i < nIx; i++) {
    need(1);
    const programIndex = buf[at++]!;
    const nAcc = short();
    need(nAcc);
    const accIdx = [...buf.subarray(at, at + nAcc)]; at += nAcc;
    const dataLen = short();
    need(dataLen);
    const data = buf.subarray(at, at + dataLen); at += dataLen;
    const programId = accountKeys[programIndex];
    if (!programId || accIdx.some((x) => x >= nKeys)) throw new Error("instruction references a missing account");
    instructions.push({ programId, accounts: accIdx.map((x) => accountKeys[x]!), data });
  }
  if (at !== buf.length) throw new Error("trailing bytes after message");
  if (header.numSigners > nKeys || header.numSigners < 1) throw new Error("bad signer count");
  return { version: "legacy", header, accountKeys, recentBlockhash, instructions };
}

/** Parses a v1 message; `total` may include trailing signatures, the returned `end` is where the message stops. */
function parseV1(buf: Buffer): { msg: ParsedMessage; end: number } {
  if (buf.length < 42 || buf[0] !== V1_PREFIX) throw new Error("not a v1 transaction");
  const header = { numSigners: buf[1]!, numReadonlySigned: buf[2]!, numReadonlyUnsigned: buf[3]! };
  const configMask = buf.readUInt32LE(4);
  const recentBlockhash = buf.subarray(8, 40);
  const nIx = buf[40]!, nKeys = buf[41]!;
  let at = 42;
  const need = (n: number) => { if (at + n > buf.length) throw new Error("transaction truncated"); };
  if (nIx > 64 || nKeys > 64 || header.numSigners < 1 || header.numSigners > 12) throw new Error("transaction breaks the v1 limits");
  if (header.numReadonlySigned >= header.numSigners || nKeys < header.numSigners + header.numReadonlyUnsigned) throw new Error("bad v1 header");
  const accountKeys: Buffer[] = [];
  for (let i = 0; i < nKeys; i++) { need(32); accountKeys.push(buf.subarray(at, at + 32)); at += 32; }
  let bits = 0;
  for (let m = configMask; m; m >>>= 1) bits += m & 1;
  need(bits * 4); at += bits * 4;
  const heads: [number, number, number][] = [];
  for (let i = 0; i < nIx; i++) { need(4); heads.push([buf[at]!, buf[at + 1]!, buf.readUInt16LE(at + 2)]); at += 4; }
  const instructions: ParsedInstruction[] = [];
  for (const [program, nAcc, dataLen] of heads) {
    need(nAcc + dataLen);
    const accIdx = [...buf.subarray(at, at + nAcc)]; at += nAcc;
    const data = buf.subarray(at, at + dataLen); at += dataLen;
    const programId = accountKeys[program];
    if (!programId || accIdx.some((x) => x >= nKeys)) throw new Error("instruction references a missing account");
    instructions.push({ programId, accounts: accIdx.map((x) => accountKeys[x]!), data });
  }
  return { msg: { version: 1, header, accountKeys, recentBlockhash, instructions, configMask }, end: at };
}

export function parseMessageV1(message: Uint8Array): ParsedMessage {
  const buf = view(message);
  const { msg, end } = parseV1(buf);
  if (end !== buf.length) throw new Error("trailing bytes after message");
  return msg;
}

/** Parses a serialised transaction of either format. */
export function parseTransaction(raw: Uint8Array): ParsedTx {
  const buf = view(raw);
  if (buf[0] === V1_PREFIX) {
    if (buf.length > MAX_TX_SIZE_V1) throw new Error("transaction too large");
    const { msg, end } = parseV1(buf);
    const n = msg.header.numSigners;
    if (buf.length !== end + 64 * n) throw new Error("signature count does not match message header");
    const signatures: Buffer[] = [];
    for (let i = 0; i < n; i++) signatures.push(buf.subarray(end + 64 * i, end + 64 * i + 64));
    return { ...msg, signatures, message: buf.subarray(0, end) };
  }
  const n = decodeShortU16(buf, 0);
  let at = n.next;
  const signatures: Buffer[] = [];
  for (let i = 0; i < n.value; i++) {
    if (at + 64 > buf.length) throw new Error("transaction truncated");
    signatures.push(buf.subarray(at, at + 64)); at += 64;
  }
  const message = buf.subarray(at);
  const parsed = parseMessage(message);
  if (signatures.length !== parsed.header.numSigners) throw new Error("signature count does not match message header");
  return { ...parsed, signatures, message };
}

/** True when the first signature is a valid signature of the message by the fee payer. */
export function verifyPayerSignature(tx: ParsedTx): boolean {
  const payer = tx.accountKeys[0], sig = tx.signatures[0];
  return !!payer && !!sig && verifySignature(payer, tx.message, sig);
}

// ---- instructions used by chainboot ----

export function noopInstruction(data: Uint8Array, readonlyAccounts: Uint8Array[] = []): Instruction {
  return { programId: NOOP_PROGRAM, keys: readonlyAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data };
}

export function transferInstruction(from: Uint8Array, to: Uint8Array, lamports: number | bigint): Instruction {
  return {
    programId: SYSTEM_PROGRAM,
    keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }],
    data: concat([u32le(2), u64le(lamports)]),
  };
}

/** Legacy-format priority fee and compute limit instructions (v1 carries these in its header instead). */
export function computeBudgetInstructions(unitLimit: number, microLamportsPerUnit: number | bigint): Instruction[] {
  return [
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat([Uint8Array.of(2), u32le(unitLimit)]) },
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat([Uint8Array.of(3), u64le(microLamportsPerUnit)]) },
  ];
}

/** Compute units and loaded-account bytes a chainboot data transaction asks for (a Noop call needs very little). */
export const NOOP_COMPUTE_UNITS = 20_000;
export const NOOP_LOADED_BYTES = 256 * 1024;

/** How many bytes of instruction data fit into one Noop transaction. */
export function noopCapacity(opts: { version?: TxVersion; readonlyAccounts?: number; priorityFee?: boolean } = {}): number {
  const ro = opts.readonlyAccounts ?? 0;
  if ((opts.version ?? 1) === 1) {
    const config = 8 + (opts.priorityFee ? 8 : 0); // compute limit + loaded size (+ priority fee)
    return MAX_TX_SIZE_V1 - (1 + 3 + 4 + 32 + 1 + 1 + 32 * (2 + ro) + config + 4 + ro + 64);
  }
  const accounts = 2 + ro + (opts.priorityFee ? 1 : 0);
  const budget = opts.priorityFee ? (1 + 1 + 1 + 5) + (1 + 1 + 1 + 9) : 0;
  // the data length prefix takes 2 bytes for anything from 128 to 16383 bytes
  return MAX_TX_SIZE_LEGACY - (1 + 64 + 3 + 1 + 32 * accounts + 32 + 1 + budget + 1 + 1 + ro + 2);
}

/**
 * A complete data transaction: one Noop instruction carrying `data`, with the fee and
 * resource settings in the place each format expects them.
 */
export function buildNoopTransaction(payer: Keypair, data: Uint8Array, recentBlockhash: Uint8Array, opts: { version?: TxVersion; readonlyAccounts?: Uint8Array[]; priorityFeeLamports?: number } = {}): SignedTx {
  const version = opts.version ?? 1;
  const fee = opts.priorityFeeLamports ?? 0;
  if (version === 1) {
    return buildTransaction(payer, [noopInstruction(data, opts.readonlyAccounts)], recentBlockhash, {
      version: 1,
      config: { computeUnitLimit: NOOP_COMPUTE_UNITS, loadedAccountsDataSizeLimit: NOOP_LOADED_BYTES, ...(fee > 0 && { priorityFeeLamports: fee }) },
    });
  }
  const budget = fee > 0 ? computeBudgetInstructions(NOOP_COMPUTE_UNITS, Math.ceil((fee * 1_000_000) / NOOP_COMPUTE_UNITS)) : [];
  return buildTransaction(payer, [...budget, noopInstruction(data, opts.readonlyAccounts)], recentBlockhash, { version: "legacy" });
}
