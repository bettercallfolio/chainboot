// Accounts: a second place for the newest pointers.
//
// Everything chainboot stores lives in transactions. That is cheap and permanent, but finding
// "the newest pointer under this tag" means asking an endpoint for the history of an address,
// which is its slowest kind of question. An account is the opposite: it holds only the current
// value, every endpoint has it in memory, and one request reads it.
//
// So a pointer can be kept in an account as well. chainboot does not deploy a program for
// this: it uses the SPL Record program, which exists to let a key write bytes into an account
// it controls. The account's address is derived from the owner's key and the tag, so a reader
// can compute it without asking anybody:
//
//   seed    = "cb" + hex(first 15 bytes of the tag)
//   address = SHA-256(owner's public key + seed + Record program id)       (createAccountWithSeed)
//
// What an endpoint says about an account cannot be checked the way a transaction can (there is
// no signature on an answer). So the record carries its own:
//
//   [0xCB][0x11][version 1][flags][sequence u64][length u16][payload][Ed25519 signature, 64 bytes]
//   signed: "chainboot:account-record:v1" + tag + flags + sequence + payload, by the owner's key
//
// A reader accepts a record only with a valid signature of the key it trusts, and takes the
// highest sequence it is shown. An endpoint can therefore still show an old record, as it can
// hide a new transaction, but it cannot make one up. The pointer transaction and the account
// are written by one transaction, so they never disagree.
//
// The account holds a deposit ("rent", about 0.0033 SOL) that comes back when it is closed.
import { createHash } from "node:crypto";
import { verifySignature, type Keypair } from "../solana/keys.ts";
import { SYSTEM_PROGRAM, type Instruction } from "../solana/tx.ts";
import { b58decodeFixed } from "../util/base58.ts";
import { concat } from "../util/bytes.ts";

export const RECORD_PROGRAM = b58decodeFixed("recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5", 32);
/** The Record program's own header in front of the data: version (1) and the authority's key. */
export const RECORD_HEADER = 33;
/** Longest pointer payload that is kept in an account (longer ones stay in transactions only). */
export const ACCOUNT_PAYLOAD_MAX = 400;
const FIXED = 4 + 8 + 2 + 64;
/** Size of a pointer account: enough for the longest payload it may ever hold. */
export const ACCOUNT_SPACE = RECORD_HEADER + FIXED + ACCOUNT_PAYLOAD_MAX;
const KIND_ACCOUNT_RECORD = 0x11, FLAG_SEE_TRANSACTIONS = 1;
const DOMAIN = Buffer.from("chainboot:account-record:v1", "utf8");

export function accountSeed(tag: Uint8Array): string {
  return `cb${Buffer.from(tag.subarray(0, 15)).toString("hex")}`;
}

/** Where the pointer of `owner` under `tag` lives, if it is kept in an account. */
export function accountAddress(owner: Uint8Array, tag: Uint8Array): Buffer {
  return createHash("sha256").update(owner).update(accountSeed(tag), "utf8").update(RECORD_PROGRAM).digest();
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

function signedBytes(tag: Uint8Array, flags: number, seq: bigint, payload: Uint8Array): Buffer {
  return Buffer.from(concat([DOMAIN, tag, Uint8Array.of(flags), u64(seq), payload]));
}

/**
 * A record for the account. `payload` null writes the note "look in the transactions": used
 * when a newer pointer is too long for the account, so that the account does not keep
 * showing the old one.
 */
export function encodeRecord(signer: Keypair, tag: Uint8Array, payload: Uint8Array | null, seq: bigint): Buffer {
  const flags = payload ? 0 : FLAG_SEE_TRANSACTIONS, body = payload ?? new Uint8Array(0);
  if (body.length > ACCOUNT_PAYLOAD_MAX) throw new Error(`a pointer of ${body.length} bytes does not fit into an account (the limit is ${ACCOUNT_PAYLOAD_MAX})`);
  const len = Buffer.alloc(2); len.writeUInt16LE(body.length);
  return Buffer.from(concat([Uint8Array.of(0xcb, KIND_ACCOUNT_RECORD, 1, flags), u64(seq), len, body, signer.sign(signedBytes(tag, flags, seq, body))]));
}

export interface AccountRecord { seq: bigint; /** null: the account says the newest pointer is in the transactions only */ payload: Buffer | null }

/** Reads and verifies the record in an account's data (the bytes after the Record program's header). Null when it is not a valid record of `signer` for `tag`. */
export function decodeRecord(data: Uint8Array, tag: Uint8Array, signer: Uint8Array): AccountRecord | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < FIXED || buf[0] !== 0xcb || buf[1] !== KIND_ACCOUNT_RECORD || buf[2] !== 1) return null;
  const flags = buf[3]!, seq = buf.readBigUInt64LE(4), len = buf.readUInt16LE(12);
  if (len > ACCOUNT_PAYLOAD_MAX || buf.length < FIXED + len) return null;
  const payload = buf.subarray(14, 14 + len), signature = buf.subarray(14 + len, 14 + len + 64);
  if (!verifySignature(signer, signedBytes(tag, flags, seq, payload), signature)) return null;
  return { seq, payload: flags & FLAG_SEE_TRANSACTIONS ? null : Buffer.from(payload) };
}

/** Creates the account at its derived address and hands it to the Record program with `owner` as the one who may write. */
export function createInstructions(owner: Uint8Array, tag: Uint8Array, lamports: number): Instruction[] {
  const address = accountAddress(owner, tag), seed = Buffer.from(accountSeed(tag), "utf8");
  return [
    {
      programId: SYSTEM_PROGRAM,
      keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: address, isSigner: false, isWritable: true }],
      // CreateAccountWithSeed: base, seed, lamports, space, owning program
      data: concat([u32(3), owner, u64(seed.length), seed, u64(lamports), u64(ACCOUNT_SPACE), RECORD_PROGRAM]),
    },
    { programId: RECORD_PROGRAM, keys: [{ pubkey: address, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: false }], data: Uint8Array.of(0) },
  ];
}

export function writeInstruction(owner: Uint8Array, tag: Uint8Array, record: Uint8Array): Instruction {
  return {
    programId: RECORD_PROGRAM,
    keys: [{ pubkey: accountAddress(owner, tag), isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
    data: concat([Uint8Array.of(1), u64(0), u32(record.length), record]),
  };
}

/** Closes the account; its deposit goes back to `owner`. */
export function closeInstruction(owner: Uint8Array, tag: Uint8Array): Instruction {
  return {
    programId: RECORD_PROGRAM,
    keys: [{ pubkey: accountAddress(owner, tag), isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }, { pubkey: owner, isSigner: false, isWritable: true }],
    data: Uint8Array.of(3),
  };
}
