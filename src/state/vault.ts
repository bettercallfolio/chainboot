// The vault: how a wallet unlocks saving and restoring machines without being asked again.
//
// The wallet signs ONE fixed message. Ed25519 signatures are deterministic, so the same wallet
// always produces the same signature, on any computer. From that signature chainboot derives:
//
//   - an encryption key   -> everything saved on chain is encrypted with it (AES-256-GCM)
//   - a "vault" keypair   -> a helper account that pays the small fees and signs the saves,
//                            so the wallet itself never has to approve individual saves
//
// Nothing is sent anywhere: the signature and the derived keys stay in ~/.chainboot/vault (mode 600).
// Anyone who obtains that signature can read the saved machines, so the message says clearly
// what it is for and must only ever be signed inside chainboot.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair, verifySignature, addressToBytes } from "../solana/keys.ts";
import type { Cluster } from "../solana/rpc.ts";

export const LOGIN_MESSAGE = [
  "chainboot: unlock my saved machines",
  "",
  "Signing this message creates the key that encrypts and restores your machines on Solana.",
  "Only sign it inside chainboot. A website that asks for this signature could read your saved machines.",
  "",
  "This is not a transaction and costs nothing.",
  "Version: 1",
].join("\n");

export interface Vault {
  /** Address of the wallet that signed in. */
  wallet: string;
  cluster: Cluster;
  /** Pays fees and signs saves; funded with a small amount from the wallet. */
  signer: Keypair;
  /** 32-byte AES key. */
  encKey: Buffer;
}

/** Derives the vault from a wallet's signature of LOGIN_MESSAGE. Throws when the signature is not valid. */
export function deriveVault(wallet: string, signature: Uint8Array, cluster: Cluster): Vault {
  if (!verifySignature(addressToBytes(wallet), Buffer.from(LOGIN_MESSAGE, "utf8"), signature)) {
    throw new Error("that is not a valid signature of the chainboot login message by this wallet");
  }
  const derive = (purpose: string) => Buffer.from(hkdfSync("sha256", signature, Buffer.from("chainboot-vault-v1"), Buffer.from(`${cluster}:${purpose}`), 32));
  return { wallet, cluster, signer: Keypair.fromSeed(derive("signer")), encKey: derive("encryption") };
}

/** Signs in with a keypair file instead of a browser wallet (servers, scripts). */
export function vaultFromKeypair(keypair: Keypair, cluster: Cluster): Vault {
  return deriveVault(keypair.address, keypair.sign(Buffer.from(LOGIN_MESSAGE, "utf8")), cluster);
}

// ---- encryption: [version 1][12-byte nonce][ciphertext][16-byte tag]; `purpose` is authenticated but not stored

export function seal(key: Uint8Array, plain: Uint8Array, purpose: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(purpose, "utf8"));
  return Buffer.concat([Uint8Array.of(1), nonce, c.update(plain), c.final(), c.getAuthTag()]);
}

export function open(key: Uint8Array, sealed: Uint8Array, purpose: string): Buffer {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (buf.length < 29 || buf[0] !== 1) throw new Error("this data was not encrypted by chainboot (or by a newer version)");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(1, 13));
  d.setAAD(Buffer.from(purpose, "utf8"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  try { return Buffer.concat([d.update(buf.subarray(13, buf.length - 16)), d.final()]); } catch {
    throw new Error("could not decrypt: wrong wallet, or the data was changed");
  }
}

// ---- local storage

interface StoredVault { wallet: string; cluster: Cluster; signer: number[]; encKey: string; created: number }

const fileFor = (dir: string, cluster: Cluster) => path.join(dir, `${cluster}.json`);

export function saveVault(dir: string, v: Vault): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data: StoredVault = { wallet: v.wallet, cluster: v.cluster, signer: [...v.signer.secretKey()], encKey: v.encKey.toString("hex"), created: Math.floor(Date.now() / 1000) };
  const file = fileFor(dir, v.cluster), tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadVault(dir: string, cluster: Cluster): Vault | null {
  let data: StoredVault;
  try { data = JSON.parse(fs.readFileSync(fileFor(dir, cluster), "utf8")) as StoredVault; } catch { return null; }
  try {
    const encKey = Buffer.from(data.encKey, "hex");
    if (encKey.length !== 32) throw new Error("bad key");
    return { wallet: data.wallet, cluster: data.cluster, signer: Keypair.fromSecretKey(Uint8Array.from(data.signer)), encKey };
  } catch { throw new Error(`the saved login in ${fileFor(dir, cluster)} is damaged; sign in again with "chainboot login"`); }
}

export function forgetVault(dir: string, cluster: Cluster): boolean {
  const file = fileFor(dir, cluster);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
