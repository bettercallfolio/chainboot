// Building and parsing legacy Solana transactions by hand.
//
// A transaction is: [signature count][signatures...][message]
// A message is:     [3-byte header][account keys][recent blockhash][instructions]
// Every length prefix is a "compact-u16". The whole transaction must fit in 1232 bytes.
import { b58decodeFixed, b58encode } from "../util/base58.ts";
import { concat, decodeShortU16, encodeShortU16, u32le, u64le } from "../util/bytes.ts";
import { Keypair, verifySignature } from "./keys.ts";

export const MAX_TX_SIZE = 1232;

export const SYSTEM_PROGRAM = b58decodeFixed("11111111111111111111111111111111", 32);
export const COMPUTE_BUDGET_PROGRAM = b58decodeFixed("ComputeBudget111111111111111111111111111111", 32);
/** SPL Noop: a program that accepts any data and does nothing. Deployed on devnet, testnet and mainnet. */
export const NOOP_PROGRAM = b58decodeFixed("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV", 32);

export interface AccountMeta { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean }
export interface Instruction { programId: Uint8Array; keys: AccountMeta[]; data: Uint8Array }

/** Orders accounts the way the runtime requires and returns the unsigned message bytes. */
export function compileMessage(payer: Uint8Array, instructions: Instruction[], recentBlockhash: Uint8Array): Buffer {
  if (recentBlockhash.length !== 32) throw new Error("blockhash must be 32 bytes");
  const metas = new Map<string, AccountMeta>();
  const add = (m: AccountMeta) => {
    const id = Buffer.from(m.pubkey).toString("latin1");
    const old = metas.get(id);
    if (old) { old.isSigner ||= m.isSigner; old.isWritable ||= m.isWritable; }
    else metas.set(id, { pubkey: m.pubkey, isSigner: m.isSigner, isWritable: m.isWritable });
  };
  add({ pubkey: payer, isSigner: true, isWritable: true });
  for (const ix of instructions) {
    for (const k of ix.keys) add(k);
    add({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  const all = [...metas.values()];
  const rank = (m: AccountMeta) => (m.isSigner ? 0 : 2) + (m.isWritable ? 0 : 1);
  // stable sort keeps the payer first: it was inserted first and has rank 0
  const ordered = all.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
  if (ordered.length > 255) throw new Error("too many accounts");
  const index = new Map(ordered.map((m, i) => [Buffer.from(m.pubkey).toString("latin1"), i]));
  const signers = ordered.filter((m) => m.isSigner).length;
  const roSigned = ordered.filter((m) => m.isSigner && !m.isWritable).length;
  const roUnsigned = ordered.filter((m) => !m.isSigner && !m.isWritable).length;

  const parts: Uint8Array[] = [Uint8Array.of(signers, roSigned, roUnsigned), Uint8Array.from(encodeShortU16(ordered.length))];
  for (const m of ordered) parts.push(m.pubkey);
  parts.push(recentBlockhash, Uint8Array.from(encodeShortU16(instructions.length)));
  for (const ix of instructions) {
    parts.push(
      Uint8Array.of(index.get(Buffer.from(ix.programId).toString("latin1"))!),
      Uint8Array.from(encodeShortU16(ix.keys.length)),
      Uint8Array.from(ix.keys.map((k) => index.get(Buffer.from(k.pubkey).toString("latin1"))!)),
      Uint8Array.from(encodeShortU16(ix.data.length)),
      ix.data,
    );
  }
  return concat(parts);
}

export interface SignedTx { signature: string; signatureBytes: Buffer; raw: Buffer }

/** Compiles, signs (payer first, then extra signers in message order) and serialises a transaction. */
export function buildTransaction(payer: Keypair, instructions: Instruction[], recentBlockhash: Uint8Array, extraSigners: Keypair[] = []): SignedTx {
  const message = compileMessage(payer.publicKey, instructions, recentBlockhash);
  const parsed = parseMessage(message);
  const byKey = new Map([payer, ...extraSigners].map((k) => [k.address, k]));
  const sigs: Buffer[] = [];
  for (let i = 0; i < parsed.header.numSigners; i++) {
    const signer = byKey.get(b58encode(parsed.accountKeys[i]!));
    if (!signer) throw new Error(`missing signer for ${b58encode(parsed.accountKeys[i]!)}`);
    sigs.push(signer.sign(message));
  }
  const raw = concat([Uint8Array.from(encodeShortU16(sigs.length)), ...sigs, message]);
  if (raw.length > MAX_TX_SIZE) throw new Error(`transaction is ${raw.length} bytes, the limit is ${MAX_TX_SIZE}`);
  return { signature: b58encode(sigs[0]!), signatureBytes: sigs[0]!, raw };
}

export interface ParsedInstruction { programId: Buffer; accounts: Buffer[]; data: Buffer }
export interface ParsedMessage {
  header: { numSigners: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  accountKeys: Buffer[];
  recentBlockhash: Buffer;
  instructions: ParsedInstruction[];
}
export interface ParsedTx extends ParsedMessage { signatures: Buffer[]; message: Buffer }

export function parseMessage(message: Uint8Array): ParsedMessage {
  const buf = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  if (buf.length < 3) throw new Error("message truncated");
  if (buf[0]! & 0x80) throw new Error("versioned transactions are not supported here");
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
  if (header.numSigners > nKeys) throw new Error("more signers than accounts");
  return { header, accountKeys, recentBlockhash, instructions };
}

export function parseTransaction(raw: Uint8Array): ParsedTx {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
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

/** Optional priority fee (micro-lamports per compute unit) and compute limit; useful on a busy mainnet. */
export function computeBudgetInstructions(unitLimit: number, microLamportsPerUnit: number | bigint): Instruction[] {
  return [
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat([Uint8Array.of(2), u32le(unitLimit)]) },
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: concat([Uint8Array.of(3), u64le(microLamportsPerUnit)]) },
  ];
}

/** Bytes a transaction needs besides the data of its single Noop instruction. */
export function noopOverhead(opts: { readonlyAccounts?: number; priorityFee?: boolean; dataLen: number }): number {
  const accounts = 2 + (opts.readonlyAccounts ?? 0) + (opts.priorityFee ? 1 : 0);
  const budget = opts.priorityFee ? (1 + 1 + 1 + 5) + (1 + 1 + 1 + 9) : 0;
  return 1 + 64 + 3 + 1 + 32 * accounts + 32 + 1 + budget + 1 + 1 + (opts.readonlyAccounts ?? 0) + encodeShortU16(opts.dataLen).length;
}
