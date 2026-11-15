// Issues, pull requests and comments of a repository on chain.
//
// Every repository has an address that anybody may write to (repo.ts, talkTag). What is
// written there is a small record, signed by whoever sent the transaction:
//
//   issue      a title and a text
//   pr         "please take branch B of my repository into your branch A": a title, a text,
//              where the commits are (owner, repository, branch, commit) and where they should go
//   comment    a text on an issue or a pull request
//   state      open, closed or merged. Counts only from the repository's owner or from the
//              author of the issue or pull request ("merged" only from the owner).
//
// The ledger keeps them in the order they arrived, so the first issue or pull request is #1,
// the next #2, for everybody and for ever. Nobody can take a record away, the owner included:
// what a reader shows of other people's records is the reader's business.
//
// A record that fits one transaction is that transaction. A longer one is stored as an object
// and the record names it. In a private repository records are encrypted with its key.
import { plainText } from "../registry/registry.ts";
import { addressToBytes, type Keypair } from "../solana/keys.ts";
import { open, seal } from "../state/vault.ts";
import type { ChainStore, ObjectRef } from "../store/store.ts";
import { b58encode } from "../util/base58.ts";
import { talkTag } from "./repo.ts";

export type TalkRecord =
  | { t: "issue"; title: string; body: string }
  | { t: "pr"; title: string; body: string; from: { owner: string; name: string; ref: string; id: string }; into: string }
  | { t: "comment"; on: string; body: string }
  | { t: "state"; on: string; state: "open" | "closed" | "merged"; id?: string };

export interface Comment { id: string; author: string; time: number | null; body: string }
export interface StateChange { id: string; author: string; time: number | null; state: "open" | "closed" | "merged"; commit?: string }
export interface Item {
  number: number;
  /** Signature of the transaction that opened it: its identity. */
  id: string;
  kind: "issue" | "pr";
  title: string;
  body: string;
  author: string;
  time: number | null;
  state: "open" | "closed" | "merged";
  comments: Comment[];
  changes: StateChange[];
  pr?: { from: { owner: string; name: string; ref: string; id: string }; into: string; merged?: string };
}

const TITLE = 200, BODY = 64_000;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/, ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const REF = /^refs\/[\x21-\x7e]{1,200}$/, NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Text as people wrote it: line breaks and tabs stay, other control characters do not. */
const text = (x: unknown, max: number): string => String(x ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, max);

/** A record as it may be shown, or null for anything that is not one. */
export function cleanRecord(v: unknown): TalkRecord | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.t === "issue") {
    const title = plainText(r.title, TITLE).trim();
    return title ? { t: "issue", title, body: text(r.body, BODY) } : null;
  }
  if (r.t === "pr") {
    const f = r.from as Record<string, unknown> | null;
    const title = plainText(r.title, TITLE).trim();
    if (!title || !f || typeof f.owner !== "string" || !ADDRESS.test(f.owner) || typeof f.name !== "string" || !NAME.test(f.name)
      || typeof f.ref !== "string" || !REF.test(f.ref) || typeof f.id !== "string" || !OID.test(f.id) || typeof r.into !== "string" || !REF.test(r.into)) return null;
    return { t: "pr", title, body: text(r.body, BODY), from: { owner: f.owner, name: f.name, ref: f.ref, id: f.id }, into: r.into };
  }
  if (r.t === "comment") {
    const body = text(r.body, BODY);
    return typeof r.on === "string" && SIG.test(r.on) && body.trim() ? { t: "comment", on: r.on, body } : null;
  }
  if (r.t === "state") {
    if (typeof r.on !== "string" || !SIG.test(r.on) || (r.state !== "open" && r.state !== "closed" && r.state !== "merged")) return null;
    return { t: "state", on: r.on, state: r.state, ...(typeof r.id === "string" && OID.test(r.id) && { id: r.id }) };
  }
  return null;
}

/** Writes a record to a repository's address. Returns the signature of its transaction. */
export async function postTalk(store: ChainStore, signer: Keypair, owner: string, name: string, record: TalkRecord, key?: Uint8Array): Promise<string> {
  const clean = cleanRecord(record);
  if (!clean) throw new Error("that is not a record a repository takes (an issue and a pull request need a title, a comment needs a text)");
  const tag = talkTag(addressToBytes(owner), name);
  const wrap = (plain: Buffer) => (key ? seal(key, plain, "git-talk") : plain);
  let payload = wrap(Buffer.from(JSON.stringify(clean), "utf8"));
  if (payload.length > store.pointerCapacity()) {
    // too long for one transaction: the record becomes an object, and the transaction names it
    const o = await store.put(signer, payload);
    payload = wrap(Buffer.from(JSON.stringify({ o: { sig: o.sig, size: o.size, sha256: o.sha256 } }), "utf8"));
  }
  return store.putPointer(signer, tag, payload);
}

/**
 * Everything that was said about a repository, put together: its issues and pull requests in
 * the order they were opened, each with its comments and its state.
 */
export async function readTalk(store: ChainStore, owner: string, name: string, key?: Uint8Array): Promise<Item[]> {
  const records = (await store.listAllPointers(talkTag(addressToBytes(owner), name))).reverse();   // oldest first
  const unwrap = (data: Buffer): unknown => {
    let plain = data;
    if (data[0] !== 0x7b) {   // not "{": encrypted (a private repository)
      if (!key) return null;
      try { plain = open(key, data, "git-talk"); } catch { return null; }
    }
    try { return JSON.parse(plain.toString("utf8")); } catch { return null; }
  };
  const items: Item[] = [];
  const byId = new Map<string, Item>();
  for (const p of records) {
    let value = unwrap(p.payload);
    const o = (value as { o?: ObjectRef } | null)?.o;
    if (o && typeof o.sig === "string" && SIG.test(o.sig) && Number.isSafeInteger(o.size) && o.size > 0 && o.size <= 4 * BODY && typeof o.sha256 === "string") {
      // (the object must be by the one who wrote the record: nobody can make a record say what somebody else stored)
      try { value = unwrap(await store.get({ sig: o.sig, size: o.size, sha256: o.sha256 }, { signers: [p.payer] })); } catch { continue; }
    }
    const r = cleanRecord(value);
    if (!r) continue;
    const author = b58encode(p.payer);
    if (r.t === "issue" || r.t === "pr") {
      const item: Item = {
        number: items.length + 1, id: p.signature, kind: r.t, title: r.title, body: r.body, author, time: p.blockTime, state: "open", comments: [], changes: [],
        ...(r.t === "pr" && { pr: { from: r.from, into: r.into } }),
      };
      items.push(item); byId.set(item.id, item);
      continue;
    }
    const item = byId.get(r.on);
    if (!item) continue;
    if (r.t === "comment") { item.comments.push({ id: p.signature, author, time: p.blockTime, body: r.body }); continue; }
    // a state: from the owner, or from the author (who cannot declare their own pull request merged)
    if (author !== owner && author !== item.author) continue;
    if (r.state === "merged" && (author !== owner || item.kind !== "pr")) continue;
    item.state = r.state;
    item.changes.push({ id: p.signature, author, time: p.blockTime, state: r.state, ...(r.id && { commit: r.id }) });
    if (item.pr) { if (r.state === "merged") item.pr.merged = r.id; else delete item.pr.merged; }
  }
  return items;
}
