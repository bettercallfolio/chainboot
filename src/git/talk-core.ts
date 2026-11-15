// Issues, pull requests and comments: what a record is, and how records become threads.
// Nothing here uses Node: the page for browsers reads them with the same code. (talk.ts says
// what the records mean and where they are written.)

/** One line of text as it may be shown: no control characters. */
const plainText = (x: unknown, max: number): string => String(x ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, max);

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

/** A record as it was found: who wrote it, when, and what it says. */
export interface Found { id: string; author: string; time: number | null; record: TalkRecord }

/**
 * Records in the order they arrived (oldest first), put together: issues and pull requests,
 * numbered, each with its comments and its state. `owner` is the repository's owner.
 */
export function thread(owner: string, found: Found[]): Item[] {
  const items: Item[] = [];
  const byId = new Map<string, Item>();
  for (const f of found) {
    const r = f.record;
    if (r.t === "issue" || r.t === "pr") {
      const item: Item = {
        number: items.length + 1, id: f.id, kind: r.t, title: r.title, body: r.body, author: f.author, time: f.time, state: "open", comments: [], changes: [],
        ...(r.t === "pr" && { pr: { from: r.from, into: r.into } }),
      };
      items.push(item); byId.set(item.id, item);
      continue;
    }
    const item = byId.get(r.on);
    if (!item) continue;
    if (r.t === "comment") { item.comments.push({ id: f.id, author: f.author, time: f.time, body: r.body }); continue; }
    // a state: from the owner, or from the author (who cannot declare their own pull request merged)
    if (f.author !== owner && f.author !== item.author) continue;
    if (r.state === "merged" && (f.author !== owner || item.kind !== "pr")) continue;
    item.state = r.state;
    item.changes.push({ id: f.id, author: f.author, time: f.time, state: r.state, ...(r.id && { commit: r.id }) });
    if (item.pr) { if (r.state === "merged") item.pr.merged = r.id; else delete item.pr.merged; }
  }
  return items;
}

/** Whether a record's payload names an object that holds the record itself (a text too long for one transaction). */
export function recordObject(value: unknown): { sig: string; size: number; sha256: string } | null {
  const o = (value as { o?: { sig?: unknown; size?: unknown; sha256?: unknown } } | null)?.o;
  if (!o || typeof o.sig !== "string" || !SIG.test(o.sig) || !Number.isSafeInteger(o.size) || (o.size as number) <= 0 || (o.size as number) > 4 * BODY || typeof o.sha256 !== "string") return null;
  return { sig: o.sig, size: o.size as number, sha256: o.sha256 };
}
