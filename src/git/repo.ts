// Git repositories on chain.
//
// A repository is what `git push` sends, kept the way chainboot keeps everything:
//
//   packs      Every push makes one git pack file of the objects that are new, and stores it
//              as an object (the same kind of object an image's files are stored in).
//   the index  A small JSON object: the branches and tags with the commits they point at,
//              and the list of packs. A push stores a new one.
//   a pointer  Under an address made from the owner's key and the repository's name. It names
//              the newest index, and only the owner's key can move it: that is what makes a
//              branch the owner's.
//
// A private repository has a key of its own, derived from the owner's vault key and the
// repository's name. Index and packs are encrypted with it. Handing that key to another
// wallet (git share) lets it read the repository, now and after later pushes.
//
// Nothing here knows git's formats: packs are made and unpacked by git itself (helper.ts).
import { hkdfSync } from "node:crypto";
import { addressToBytes, type Keypair } from "../solana/keys.ts";
import { open, seal, type Vault } from "../state/vault.ts";
import { ChainStore, tagAddress, type ObjectRef, type PutProgress } from "../store/store.ts";
import type { Commitment } from "../store/sender.ts";

export interface PackEntry extends ObjectRef {
  /** Size of the pack file itself (before encryption), and how many objects it holds. */
  bytes: number;
  objects: number;
  /** When it was pushed (seconds). */
  time: number;
}

export interface RepoIndex {
  chainboot: 1;
  kind: "git";
  name: string;
  description?: string;
  private?: boolean;
  /** The branch a clone checks out, e.g. "refs/heads/main". */
  head: string;
  /** Every branch and tag: full ref name to object id (40 or 64 hex digits). */
  refs: Record<string, string>;
  packs: PackEntry[];
  updated: number;
}

export interface RepoList { chainboot: 1; kind: "git-repos"; updated: number; repos: Record<string, { description?: string; created: number }> }

export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REF_NAME = /^refs\/[\x21-\x7e]{1,200}$/;
const OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const SHA = /^[0-9a-f]{64}$/;

export class PrivateRepoError extends Error {
  constructor(what: string) { super(`${what} is a private repository. Its owner can read it after "chainboot login"; anyone else needs it shared with them (chainboot git share).`); this.name = "PrivateRepoError"; }
}

export function checkRepoName(name: string): void {
  if (!REPO_NAME.test(name) || name.endsWith(".git") || name === "me") throw new Error(`"${name}" cannot be a repository name: use letters, digits, ".", "_" and "-", starting with a letter or a digit`);
}

const repoTag = (owner: Uint8Array, name: string) => tagAddress("git", owner, name);
/** Where a repository's issues, pull requests and comments are written: anybody may write there. */
export const talkTag = (owner: Uint8Array, name: string) => tagAddress("git-talk", owner, name);
const listTag = (owner: Uint8Array) => tagAddress("git-repos", owner);
const privateListTag = (owner: Uint8Array) => tagAddress("git-repos-private", owner);

/** The key of a private repository: from the owner's vault key and the repository's name. */
export function repoKey(v: Pick<Vault, "encKey">, name: string): Buffer {
  return Buffer.from(hkdfSync("sha256", v.encKey, Buffer.from("chainboot-git-v1"), Buffer.from(name, "utf8"), 32));
}

function cleanIndex(value: unknown, name: string): RepoIndex {
  const v = value as Partial<RepoIndex> | null;
  if (!v || typeof v !== "object" || v.chainboot !== 1 || v.kind !== "git" || v.name !== name) throw new Error("this is not the index of that repository");
  const refs: Record<string, string> = {};
  for (const [ref, id] of Object.entries(v.refs ?? {})) {
    if (!REF_NAME.test(ref) || typeof id !== "string" || !OID.test(id)) throw new Error("the repository's index names a branch or a commit that cannot be one");
    refs[ref] = id;
  }
  const packs = (Array.isArray(v.packs) ? v.packs : []).map((p) => {
    if (!p || typeof p.sig !== "string" || !SIG.test(p.sig) || typeof p.sha256 !== "string" || !SHA.test(p.sha256) || !Number.isSafeInteger(p.size) || p.size < 0) throw new Error("the repository's index lists a pack that cannot be one");
    return { sig: p.sig, size: p.size, sha256: p.sha256, bytes: Number.isSafeInteger(p.bytes) ? p.bytes : p.size, objects: Number.isSafeInteger(p.objects) ? p.objects : 0, time: Number.isSafeInteger(p.time) ? p.time : 0 };
  });
  const head = typeof v.head === "string" && REF_NAME.test(v.head) ? v.head : "refs/heads/main";
  return {
    chainboot: 1, kind: "git", name, ...(typeof v.description === "string" && { description: v.description.slice(0, 300) }), ...(v.private === true && { private: true }),
    head, refs, packs, updated: Number.isSafeInteger(v.updated) ? v.updated! : 0,
  };
}

interface Pointer { v: 1; i: ObjectRef; p?: 1 }

function parsePointer(payload: Uint8Array): Pointer {
  let v: Pointer;
  try { v = JSON.parse(Buffer.from(payload).toString("utf8")) as Pointer; } catch { throw new Error("the repository's pointer cannot be read"); }
  if (!v || v.v !== 1 || !v.i || typeof v.i.sig !== "string" || !SIG.test(v.i.sig) || typeof v.i.sha256 !== "string" || !SHA.test(v.i.sha256) || !Number.isSafeInteger(v.i.size)) throw new Error("the repository's pointer cannot be read");
  return v;
}

export interface Repo { owner: string; index: RepoIndex; /** the sequence number of the pointer this index was named by */ seq: bigint }

/**
 * Reads a repository. Returns null when the owner has none of that name. A private one needs
 * its key (`key`): without it, PrivateRepoError.
 */
export async function readRepo(store: ChainStore, owner: string, name: string, key?: Uint8Array): Promise<Repo | null> {
  checkRepoName(name);
  const ownerKey = addressToBytes(owner);
  const record = await store.getPointer(repoTag(ownerKey, name), [ownerKey]);
  if (!record) return null;
  const pointer = parsePointer(record.payload);
  const stored = await store.get(pointer.i);
  let plain: Buffer = stored;
  if (pointer.p) {
    if (!key) throw new PrivateRepoError(`${owner}/${name}`);
    try { plain = open(key, stored, "git-index"); } catch { throw new Error(`the key for ${owner}/${name} does not open it`); }
  }
  let value: unknown;
  try { value = JSON.parse(plain.toString("utf8")); } catch { throw new Error("the repository's index cannot be read"); }
  const index = cleanIndex(value, name);
  if (!!index.private !== !!pointer.p) throw new Error("the repository's index and its pointer disagree about whether it is private");
  return { owner, index, seq: record.seq };
}

export interface WriteOptions { journalDir?: string; commitment?: Commitment; onProgress?: (p: PutProgress) => void }

/** Stores an index and moves the repository's pointer to it. `key` for a private repository. */
export async function writeRepo(store: ChainStore, signer: Keypair, index: RepoIndex, key?: Uint8Array, opts: WriteOptions = {}): Promise<void> {
  checkRepoName(index.name);
  if (index.private && !key) throw new Error("a private repository cannot be written without its key");
  const plain = Buffer.from(JSON.stringify({ ...index, updated: Math.floor(Date.now() / 1000) }), "utf8");
  const data = index.private ? seal(key!, plain, "git-index") : plain;
  const ref = await store.put(signer, data, { journalDir: opts.journalDir, commitment: opts.commitment });
  const pointer: Pointer = { v: 1, i: { sig: ref.sig, size: ref.size, sha256: ref.sha256 }, ...(index.private && { p: 1 as const }) };
  await store.putPointer(signer, repoTag(signer.publicKey, index.name), Buffer.from(JSON.stringify(pointer), "utf8"), { commitment: opts.commitment });
}

/** Stores one pack file. */
export async function putPack(store: ChainStore, signer: Keypair, pack: Uint8Array, objects: number, key?: Uint8Array, opts: WriteOptions = {}): Promise<PackEntry> {
  const data = key ? seal(key, pack, "git-pack") : Buffer.from(pack);
  const ref = await store.put(signer, data, { journalDir: opts.journalDir, commitment: opts.commitment, onProgress: opts.onProgress });
  return { sig: ref.sig, size: ref.size, sha256: ref.sha256, bytes: pack.length, objects, time: Math.floor(Date.now() / 1000) };
}

/** Fetches one pack file, checked against the hash the index gives (and decrypted for a private repository). */
export async function getPack(store: ChainStore, entry: PackEntry, key?: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<Buffer> {
  const stored = await store.get({ sig: entry.sig, size: entry.size, sha256: entry.sha256 }, { onProgress: onProgress ? (p) => onProgress(p.bytes, p.size) : undefined });
  return key ? open(key, stored, "git-pack") : stored;
}

// ---- the list of an owner's repositories

async function readList(store: ChainStore, owner: Uint8Array, tag: Buffer, key?: Uint8Array): Promise<RepoList> {
  const empty: RepoList = { chainboot: 1, kind: "git-repos", updated: 0, repos: {} };
  const record = await store.getPointer(tag, [owner]);
  if (!record) return empty;
  const pointer = parsePointer(record.payload);
  const stored = await store.get(pointer.i);
  const plain = key ? open(key, stored, "git-repos") : stored;
  const v = JSON.parse(plain.toString("utf8")) as RepoList;
  if (!v || v.kind !== "git-repos" || typeof v.repos !== "object") return empty;
  const repos: RepoList["repos"] = {};
  for (const [name, r] of Object.entries(v.repos)) if (REPO_NAME.test(name)) repos[name] = { ...(typeof r?.description === "string" && { description: r.description.slice(0, 300) }), created: Number.isSafeInteger(r?.created) ? r.created : 0 };
  return { ...empty, updated: v.updated ?? 0, repos };
}

async function writeList(store: ChainStore, signer: Keypair, tag: Buffer, list: RepoList, key?: Uint8Array): Promise<void> {
  const plain = Buffer.from(JSON.stringify({ ...list, updated: Math.floor(Date.now() / 1000) }), "utf8");
  const ref = await store.put(signer, key ? seal(key, plain, "git-repos") : plain);
  await store.putPointer(signer, tag, Buffer.from(JSON.stringify({ v: 1, i: { sig: ref.sig, size: ref.size, sha256: ref.sha256 } }), "utf8"));
}

/** The public repositories of an owner, and (with the owner's vault) the private ones. */
export async function listRepos(store: ChainStore, owner: string, vault?: Vault): Promise<{ name: string; description?: string; created: number; private: boolean }[]> {
  const key = addressToBytes(owner);
  const out = Object.entries((await readList(store, key, listTag(key))).repos).map(([name, r]) => ({ name, ...r, private: false }));
  if (vault && vault.signer.address === owner) {
    for (const [name, r] of Object.entries((await readList(store, key, privateListTag(key), vault.encKey)).repos)) out.push({ name, ...r, private: true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Notes a repository in its owner's list (the private ones in a list only the owner can read). */
export async function noteRepo(store: ChainStore, signer: Keypair, name: string, entry: { description?: string; private: boolean }, vault?: Vault): Promise<void> {
  if (entry.private && !vault) throw new Error("a private repository belongs to a signed-in wallet");
  const tag = entry.private ? privateListTag(signer.publicKey) : listTag(signer.publicKey);
  const key = entry.private ? vault!.encKey : undefined;
  const list = await readList(store, signer.publicKey, tag, key);
  if (list.repos[name] && list.repos[name]!.description === entry.description) return;
  list.repos[name] = { ...(entry.description && { description: entry.description }), created: list.repos[name]?.created ?? Math.floor(Date.now() / 1000) };
  await writeList(store, signer, tag, list, key);
}

export const emptyIndex = (name: string, opts: { private: boolean; description?: string }): RepoIndex => ({
  chainboot: 1, kind: "git", name, ...(opts.description && { description: opts.description }), ...(opts.private && { private: true as const }),
  head: "refs/heads/main", refs: {}, packs: [], updated: 0,
});
