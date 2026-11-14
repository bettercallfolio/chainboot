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
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair, verifySignature, addressToBytes } from "../solana/keys.ts";
import { b58decode, b58encode } from "../util/base58.ts";
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

// ---- encryption
//
// Every stored object is encrypted with a key of its own, derived from the vault key and a
// random number kept in the object's header:
//
//   [2][key id, 16 bytes][nonce, 12 bytes][ciphertext][tag, 16 bytes]
//   object key = HKDF-SHA256(vault key, salt = key id, info = "chainboot-object-v2:" + purpose)
//
// The owner needs only the vault key to open everything. To share one object with somebody
// else, its object key is handed over: it opens that object and nothing else.
// `purpose` says what the object is; it is authenticated but not stored.
// (Version 1, written by earlier releases, used the vault key directly: [1][nonce][ciphertext][tag].)

const OBJECT_KEY_INFO = "chainboot-object-v2:";

function objectKeyFor(master: Uint8Array, id: Uint8Array, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, id, Buffer.from(OBJECT_KEY_INFO + purpose, "utf8"), 32));
}

function gcmOpen(key: Uint8Array, nonce: Uint8Array, body: Buffer, purpose: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(purpose, "utf8"));
  d.setAuthTag(body.subarray(body.length - 16));
  try { return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]); } catch {
    throw new Error("could not decrypt: wrong wallet or key, or the data was changed");
  }
}

function gcmSeal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, purpose: string): Buffer[] {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(purpose, "utf8"));
  return [c.update(plain), c.final(), c.getAuthTag()];
}

const view = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

export function seal(key: Uint8Array, plain: Uint8Array, purpose: string): Buffer {
  return sealWithKey(key, plain, purpose).sealed;
}

/** Like seal(), and also returns the object's own key (base64), to be noted where the object is listed. */
export function sealWithKey(key: Uint8Array, plain: Uint8Array, purpose: string): { sealed: Buffer; key: string } {
  const id = randomBytes(16), nonce = randomBytes(12);
  const objKey = objectKeyFor(key, id, purpose);
  return { sealed: Buffer.concat([Uint8Array.of(2), id, nonce, ...gcmSeal(objKey, nonce, plain, purpose)]), key: objKey.toString("base64") };
}

/** Opens an object with the vault key it was sealed under. */
export function open(key: Uint8Array, sealed: Uint8Array, purpose: string): Buffer {
  const buf = view(sealed);
  if (buf[0] === 2 && buf.length >= 45) return gcmOpen(objectKeyFor(key, buf.subarray(1, 17), purpose), buf.subarray(17, 29), buf.subarray(29), purpose);
  if (buf[0] === 1 && buf.length >= 29) return gcmOpen(key, buf.subarray(1, 13), buf.subarray(13), purpose);
  throw new Error("this data was not encrypted by chainboot (or by a newer version)");
}

/** The key of one sealed object, to hand to somebody else. Null for objects of the old kind, which have none of their own. */
export function objectKey(key: Uint8Array, sealed: Uint8Array, purpose: string): Buffer | null {
  const buf = view(sealed);
  return buf[0] === 2 && buf.length >= 45 ? objectKeyFor(key, buf.subarray(1, 17), purpose) : null;
}

/** Opens an object with its own key (received from its owner). */
export function openWithKey(objKey: Uint8Array, sealed: Uint8Array, purpose: string): Buffer {
  const buf = view(sealed);
  if (buf[0] !== 2 || buf.length < 45) throw new Error("this object cannot be opened with a key of its own");
  if (objKey.length !== 32) throw new Error("an object key has 32 bytes");
  return gcmOpen(objKey, buf.subarray(17, 29), buf.subarray(29), purpose);
}

/** Opens an object with its own key when one is given (base64), with the vault key otherwise. */
export function openEither(vaultKey: Uint8Array | undefined, objKey: string | undefined, sealed: Uint8Array, purpose: string): Buffer {
  if (objKey) return openWithKey(Buffer.from(objKey, "base64"), sealed, purpose);
  if (!vaultKey) throw new Error("this is encrypted: sign in with the wallet it belongs to (chainboot login)");
  return open(vaultKey, sealed, purpose);
}

// ---- sharing: sending something to another login
//
// A wallet can sign, but it cannot decrypt. So what a sender encrypts to is not the wallet's
// address but a "share address": the public half of an X25519 key that the receiver's login
// derives from its vault key. The receiver gives that address to the people who should be
// able to send them something; it reveals nothing else.
//
//   message = [1][one-time public key, 32][sender's public key, 32][nonce, 12][ciphertext][tag, 16]
//   key     = HKDF-SHA256(ECDH(one-time, receiver) + ECDH(sender, receiver), salt = the three public keys, info = purpose)
//
// The one-time key hides who talks to whom from everybody else; the sender's own key in the
// mix proves to the receiver which share address the message came from.

const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const xSecret = (raw: Uint8Array) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: "der", type: "pkcs8" });
const xPublic = (raw: Uint8Array) => createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: "der", type: "spki" });
const xPublicOf = (secret: Uint8Array) => Buffer.from(createPublicKey(xSecret(secret)).export({ format: "der", type: "spki" }).subarray(-32));

export interface ShareKeys { secret: Buffer; publicKey: Buffer }

/** The key pair a login receives shares with. The same wallet gets the same pair on every computer. */
export function shareKeys(v: Pick<Vault, "encKey" | "cluster">): ShareKeys {
  const secret = Buffer.from(hkdfSync("sha256", v.encKey, Buffer.from("chainboot-share-v1"), Buffer.from(`${v.cluster}:x25519`), 32));
  return { secret, publicKey: xPublicOf(secret) };
}

const SHARE_PREFIX = "share_";
const shareChecksum = (publicKey: Uint8Array) => createHash("sha256").update("chainboot-share-address").update(publicKey).digest().subarray(0, 4);

/** A share address as people pass it around: "share_" and the public key with a checksum. */
export function shareAddress(publicKey: Uint8Array): string {
  return SHARE_PREFIX + b58encode(Buffer.concat([publicKey, shareChecksum(publicKey)]));
}

export function parseShareAddress(text: string): Buffer {
  const fail = (why: string) => new Error(`"${text}" is not a share address (${why}). The receiver finds theirs with: chainboot whoami`);
  if (!text.startsWith(SHARE_PREFIX)) throw fail('it starts with "share_"; a wallet address cannot receive shares');
  let raw: Uint8Array;
  try { raw = b58decode(text.slice(SHARE_PREFIX.length)); } catch { throw fail("it has characters that do not belong there"); }
  if (raw.length !== 36) throw fail("it has the wrong length");
  const publicKey = Buffer.from(raw.subarray(0, 32));
  if (!shareChecksum(publicKey).equals(Buffer.from(raw.subarray(32)))) throw fail("it was mistyped: its checksum does not match");
  return publicKey;
}

function shareSecret(oneTimeShared: Buffer, staticShared: Buffer, oneTimePub: Uint8Array, senderPub: Uint8Array, receiverPub: Uint8Array, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.concat([oneTimeShared, staticShared]), Buffer.concat([oneTimePub, senderPub, receiverPub]), Buffer.from(`chainboot-share-v1:${purpose}`, "utf8"), 32));
}

/** Encrypts `plain` so that only the owner of `receiver` (a share public key) can read it, and can tell it came from `sender`. */
export function sealTo(receiver: Uint8Array, sender: ShareKeys, plain: Uint8Array, purpose: string): Buffer {
  if (receiver.length !== 32) throw new Error("a share public key has 32 bytes");
  const oneTime = generateKeyPairSync("x25519");
  const oneTimePub = Buffer.from(oneTime.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const to = xPublic(receiver);
  const key = shareSecret(diffieHellman({ privateKey: oneTime.privateKey, publicKey: to }), diffieHellman({ privateKey: xSecret(sender.secret), publicKey: to }), oneTimePub, sender.publicKey, receiver, purpose);
  const nonce = randomBytes(12);
  return Buffer.concat([Uint8Array.of(1), oneTimePub, sender.publicKey, nonce, ...gcmSeal(key, nonce, plain, purpose)]);
}

/** Opens a message sealed to these keys. Returns the content and the sender's share public key, or null when it is not for us. */
export function openFrom(mine: ShareKeys, sealed: Uint8Array, purpose: string): { plain: Buffer; sender: Buffer } | null {
  const buf = view(sealed);
  if (buf[0] !== 1 || buf.length < 1 + 32 + 32 + 12 + 16) return null;
  const oneTimePub = buf.subarray(1, 33), sender = Buffer.from(buf.subarray(33, 65));
  try {
    const me = xSecret(mine.secret);
    const key = shareSecret(diffieHellman({ privateKey: me, publicKey: xPublic(oneTimePub) }), diffieHellman({ privateKey: me, publicKey: xPublic(sender) }), oneTimePub, sender, mine.publicKey, purpose);
    return { plain: gcmOpen(key, buf.subarray(65, 77), buf.subarray(77), purpose), sender };
  } catch { return null; }
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
