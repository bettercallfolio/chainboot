// Git repositories on chain, for browsers: read a repository (branches, files, history),
// read its issues and pull requests, and write a record with the visitor's own wallet.
// Builds on the reader (reader.ts), which fetches and verifies; private repositories are
// not read here (their key lives with chainboot on the owner's computer).
import { Reader, b58decode, b58encode, tagAddress } from "./reader.ts";
import { checkRepoName, cleanIndex, parsePointer, type PackEntry, type RepoIndex } from "../git/format.ts";
import { Objects } from "../git/pack.ts";
import { cleanRecord, recordObject, thread, type Found, type Item, type TalkRecord } from "../git/talk-core.ts";

export { Reader, b58decode, b58encode } from "./reader.ts";
export { Objects, asText, diffLines, type Change, type Commit, type DiffLine, type TreeEntry } from "../git/pack.ts";
export type { Item, TalkRecord } from "../git/talk-core.ts";
export type { RepoIndex } from "../git/format.ts";

const text = new TextDecoder();

/** "owner/name", "sol://owner/name": the owner's address and the repository's name. */
export function parseRepo(input: string): { owner: string; name: string } {
  const m = /^(?:sol:\/\/)?([1-9A-HJ-NP-Za-km-z]{32,44})\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m) throw new Error("a repository is named <owner's address>/<name>");
  checkRepoName(m[2]!);
  b58decode(m[1]!, 32);
  return { owner: m[1]!, name: m[2]! };
}

/** A repository's index: its branches and tags, and the list of its packs. Null when the owner has none of that name. */
export async function readRepo(reader: Reader, owner: string, name: string, signal?: AbortSignal): Promise<RepoIndex | null> {
  const key = b58decode(owner, 32);
  const record = await reader.pointer(await tagAddress("git", key, name), [key], { signal });
  if (!record) return null;
  const pointer = parsePointer(record.payload);
  if (pointer.p) throw new Error("this is a private repository: it is encrypted, and only chainboot on its owner's computer (or on one it was shared with) reads it");
  const stored = await reader.object(pointer.i, { signers: [key], signal });
  let value: unknown;
  try { value = JSON.parse(text.decode(stored)); } catch { throw new Error("the repository's index cannot be read"); }
  return cleanIndex(value, name);
}

/** Fetches every pack of a repository and unpacks it. `onProgress` hears how far it is. */
export async function readObjects(reader: Reader, owner: string, index: RepoIndex, onProgress?: (done: number, total: number, pack: PackEntry) => void, signal?: AbortSignal): Promise<Objects> {
  const key = b58decode(owner, 32);
  const objects = new Objects();
  // oldest first: a pack never needs an object of a later one
  let done = 0;
  for (const p of index.packs) {
    onProgress?.(done, index.packs.length, p);
    await objects.addPack(await reader.object({ sig: p.sig, size: p.size, sha256: p.sha256 }, { signers: [key], signal }));
    done++;
  }
  onProgress?.(done, index.packs.length, index.packs[index.packs.length - 1]!);
  return objects;
}

/** The issues and pull requests of a (public) repository, with their comments and states. */
export async function readTalk(reader: Reader, owner: string, name: string, signal?: AbortSignal): Promise<Item[]> {
  const key = b58decode(owner, 32);
  const records = (await reader.pointers(await tagAddress("git-talk", key, name), { signal })).reverse();   // oldest first
  const found: Found[] = [];
  for (const p of records) {
    if (!p.payer || p.payload[0] !== 0x7b) continue;   // (not "{": encrypted, or not a record)
    let value: unknown;
    try {
      value = JSON.parse(text.decode(p.payload));
      const o = recordObject(value);
      // (the object must be by the one who wrote the record)
      if (o) value = JSON.parse(text.decode(await reader.object(o, { signers: [p.payer], signal })));
    } catch { continue; }
    const record = cleanRecord(value);
    if (record) found.push({ id: p.signature, author: b58encode(p.payer), time: p.blockTime, record });
  }
  return thread(owner, found);
}

// ---- writing a record with a wallet
//
// A record is one small transaction: a call of the Noop program that carries the record and
// names the repository's address, paid and signed by the visitor's wallet. The wallet only
// signs; the page sends the signed transaction through the endpoints it reads from, so it
// lands on the network the page shows, whatever network the wallet is set to.

const NOOP_PROGRAM = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
const MAGIC = 0xcb, KIND_POINTER = 0x10, POINTER_VERSION = 2;
/** The longest record (as JSON text) that fits one transaction a wallet signs. */
export const RECORD_LIMIT = 1000;

function shortU16(n: number): number[] {
  const out: number[] = [];
  for (;;) { const b = n & 0x7f; n >>= 7; if (n) out.push(b | 0x80); else { out.push(b); return out; } }
}

/** The message of the transaction that writes `record` to a repository, for `payer` to sign. */
export async function recordMessage(payer: string, owner: string, name: string, record: TalkRecord, recentBlockhash: string): Promise<Uint8Array> {
  const clean = cleanRecord(record);
  if (!clean) throw new Error("an issue and a pull request need a title, a comment needs a text");
  const payload = new TextEncoder().encode(JSON.stringify(clean));
  if (payload.length > RECORD_LIMIT) throw new Error(`that is ${payload.length} bytes, and one transaction holds ${RECORD_LIMIT}. Longer texts are written with chainboot itself: chainboot git issue new --body-file <file>`);
  const tag = await tagAddress("git-talk", b58decode(owner, 32), name);
  const data = new Uint8Array(11 + payload.length);
  data[0] = MAGIC; data[1] = KIND_POINTER; data[2] = POINTER_VERSION;
  new DataView(data.buffer).setBigUint64(3, BigInt(Date.now()), true);
  data.set(payload, 11);
  const keys = [b58decode(payer, 32), tag, b58decode(NOOP_PROGRAM, 32)];
  const parts: number[] = [1, 0, 2, ...shortU16(keys.length)];   // one signer; the tag and the program are read-only
  for (const k of keys) parts.push(...k);
  parts.push(...b58decode(recentBlockhash, 32));
  parts.push(...shortU16(1), 2, ...shortU16(1), 1, ...shortU16(data.length), ...data);
  return Uint8Array.from(parts);
}

/** A transaction as it travels: one signature, then the message. */
export function signedTransaction(message: Uint8Array, signature: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 64 + message.length);
  out[0] = 1; out.set(signature, 1); out.set(message, 65);
  return out;
}

export interface WalletHandle {
  name: string;
  address: string;
  /** Signs a transaction message and returns the signature (64 bytes). */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

interface StandardAccount { address: string; publicKey: Uint8Array; features: readonly string[] }
interface StandardWallet {
  name: string; accounts: readonly StandardAccount[]; features: Record<string, unknown>;
}
interface InjectedProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  request(args: { method: string; params: unknown }): Promise<{ signature: string }>;
}

/** The page, as far as this file uses it (the project is not compiled with the browser's own types). */
interface Page {
  addEventListener(type: string, listener: (e: { detail: unknown }) => void): void;
  dispatchEvent(e: unknown): boolean;
  CustomEvent: new (type: string, init: { detail: unknown }) => unknown;
  solana?: InjectedProvider;
  phantom?: { solana?: InjectedProvider };
}
const page = globalThis as unknown as Page;

/** The wallets of this browser that follow the Wallet Standard (Phantom, Solflare, Backpack and others). */
export function standardWallets(): StandardWallet[] {
  const found: StandardWallet[] = [];
  const register = (...wallets: StandardWallet[]) => { for (const w of wallets) if (!found.includes(w) && w.features["solana:signTransaction"]) found.push(w); return () => {}; };
  try {
    page.addEventListener("wallet-standard:register-wallet", (e) => { (e.detail as (api: { register: typeof register }) => void)({ register }); });
    page.dispatchEvent(new page.CustomEvent("wallet-standard:app-ready", { detail: { register } }));
  } catch { /* an old browser: no wallets */ }
  return found;
}

/** Connects a wallet: one that follows the Wallet Standard, or else the provider older wallets put on the page. */
export async function connectWallet(chain = "solana:devnet"): Promise<WalletHandle> {
  for (const w of standardWallets()) {
    const connect = w.features["standard:connect"] as { connect(): Promise<{ accounts: readonly StandardAccount[] }> } | undefined;
    const sign = w.features["solana:signTransaction"] as { signTransaction(...inputs: { account: StandardAccount; transaction: Uint8Array; chain?: string }[]): Promise<{ signedTransaction: Uint8Array }[]> } | undefined;
    if (!connect || !sign) continue;
    const account = (await connect.connect()).accounts[0] ?? w.accounts[0];
    if (!account) continue;
    return {
      name: w.name, address: account.address,
      sign: async (message) => {
        const [out] = await sign.signTransaction({ account, transaction: signedTransaction(message, new Uint8Array(64)), chain });
        if (!out || out.signedTransaction.length < 65) throw new Error("the wallet did not return a signed transaction");
        return out.signedTransaction.slice(1, 65);
      },
    };
  }
  const provider = page.phantom?.solana ?? page.solana;
  if (!provider) throw new Error("no Solana wallet was found in this browser (Phantom, Solflare and Backpack work)");
  const address = (await provider.connect()).publicKey.toString();
  return {
    name: provider.isPhantom ? "Phantom" : "wallet", address,
    sign: async (message) => b58decode((await provider.request({ method: "signTransaction", params: { message: b58encode(message) } })).signature, 64),
  };
}

/**
 * Writes a record to a repository with the wallet: asks for a recent blockhash, lets the
 * wallet sign, sends, and waits until the network confirms. Returns the signature.
 */
export async function postRecord(reader: Reader, wallet: WalletHandle, owner: string, name: string, record: TalkRecord): Promise<string> {
  const latest = await reader.rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }], (r) => typeof r?.value?.blockhash === "string");
  const message = await recordMessage(wallet.address, owner, name, record, latest.value.blockhash);
  const signature = await wallet.sign(message);
  const raw = signedTransaction(message, signature);
  let b64 = "";
  for (const b of raw) b64 += String.fromCharCode(b);
  const sent = await reader.rpc<string>("sendTransaction", [btoa(b64), { encoding: "base64", preflightCommitment: "confirmed" }], (r) => typeof r === "string");
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await reader.rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[sent]], (r) => Array.isArray(r?.value)).catch(() => null);
    const s = st?.value[0];
    if (s?.err) throw new Error("the network refused the transaction (is there SOL in the wallet on this network?)");
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return sent;
  }
  throw new Error("the transaction was sent, but the network did not confirm it in a minute");
}
