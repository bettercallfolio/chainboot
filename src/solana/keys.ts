// Ed25519 keys and signatures using Node's built-in crypto (no external libraries).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import fs from "node:fs";
import { b58decodeFixed, b58encode } from "../util/base58.ts";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class Keypair {
  readonly seed: Buffer;
  readonly publicKey: Buffer;
  readonly #key: KeyObject;

  private constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
    this.seed = Buffer.from(seed);
    this.#key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, this.seed]), format: "der", type: "pkcs8" });
    this.publicKey = Buffer.from(createPublicKey(this.#key).export({ format: "der", type: "spki" }).subarray(-32));
  }

  static fromSeed(seed: Uint8Array): Keypair {
    return new Keypair(seed);
  }

  /** 64-byte Solana secret key: 32-byte seed followed by the 32-byte public key. */
  static fromSecretKey(secret: Uint8Array): Keypair {
    if (secret.length !== 64) throw new Error("secret key must be 64 bytes");
    const kp = new Keypair(secret.subarray(0, 32));
    if (!kp.publicKey.equals(Buffer.from(secret.subarray(32)))) throw new Error("secret key is corrupt: public half does not match");
    return kp;
  }

  /** Reads the JSON array format written by `solana-keygen`. */
  static fromFile(path: string): Keypair {
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) {
      throw new Error(`cannot read keypair file ${path}: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error(`${path} is not a Solana keypair file (expected a JSON array of 64 numbers)`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  }

  static generate(): Keypair {
    const { privateKey } = generateKeyPairSync("ed25519");
    return new Keypair(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32));
  }

  get address(): string {
    return b58encode(this.publicKey);
  }

  secretKey(): Buffer {
    return Buffer.concat([this.seed, this.publicKey]);
  }

  sign(message: Uint8Array): Buffer {
    return sign(null, message, this.#key);
  }
}

const spkiCache = new Map<string, KeyObject>();

export function verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const id = Buffer.from(publicKey).toString("latin1");
  let key = spkiCache.get(id);
  if (!key) {
    try { key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" }); } catch { return false; }
    if (spkiCache.size > 256) spkiCache.clear();
    spkiCache.set(id, key);
  }
  try { return verify(null, message, key, signature); } catch { return false; }
}

export function addressToBytes(address: string): Buffer {
  return b58decodeFixed(address, 32, "address");
}
