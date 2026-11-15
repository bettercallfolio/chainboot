// What a repository on chain looks like: its index and the pointer that names it.
// Nothing here uses Node: the page for browsers reads repositories with the same code.

export interface ObjectRef { sig: string; size: number; sha256: string }

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


export function checkRepoName(name: string): void {
  if (!REPO_NAME.test(name) || name.endsWith(".git") || name === "me") throw new Error(`"${name}" cannot be a repository name: use letters, digits, ".", "_" and "-", starting with a letter or a digit`);
}

export function cleanIndex(value: unknown, name: string): RepoIndex {
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

export interface Pointer { v: 1; i: ObjectRef; p?: 1 }

export function parsePointer(payload: Uint8Array): Pointer {
  let v: Pointer;
  try { v = JSON.parse(new TextDecoder().decode(payload)) as Pointer; } catch { throw new Error("the repository's pointer cannot be read"); }
  if (!v || v.v !== 1 || !v.i || typeof v.i.sig !== "string" || !SIG.test(v.i.sig) || typeof v.i.sha256 !== "string" || !SHA.test(v.i.sha256) || !Number.isSafeInteger(v.i.size)) throw new Error("the repository's pointer cannot be read");
  return v;
}

