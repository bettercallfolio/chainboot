// Lists: one catalog that several publishers keep together.
//
// A publisher's catalog is signed by one key. Whoever holds that key decides what
// `chainboot run solinux` means for everybody who trusts it. A list spreads that over several
// keys: it names its members and how many of them must agree,
//
//   list:2:<address of A>,<address of B>,<address of C>          "two of these three"
//
// and an image belongs to the list when at least that many members have the same image (the
// same content, by its digest) under the same name, tag and architecture in their own
// catalogs. Nothing new is stored for a list: it is a way of reading catalogs that exist.
// A member agrees to an image by publishing it, or by endorsing somebody else's upload, which
// adds an entry to their catalog that points at the image already on chain.
//
// More than half of the members must agree, so two different images can never both qualify,
// and one stolen key can neither add an image nor replace one.
import { addressToBytes } from "../solana/keys.ts";
import type { ChainStore } from "../store/store.ts";
import { readCatalog, type ImageRef } from "./registry.ts";

export interface ListSpec { threshold: number; members: string[] }

const PREFIX = "list:";
export const isList = (text: string): boolean => text.startsWith(PREFIX);

/** Parses "list:<how many must agree>:<address>,<address>,...". */
export function parseList(text: string): ListSpec {
  const m = /^list:(\d+):([1-9A-HJ-NP-Za-km-z,]+)$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a list. A list looks like list:2:<address>,<address>,<address>`);
  const members = m[2]!.split(",").filter(Boolean);
  const threshold = Number(m[1]);
  for (const a of members) { try { addressToBytes(a); } catch { throw new Error(`"${a}" in the list is not a Solana address`); } }
  if (new Set(members).size !== members.length) throw new Error("a list names each member once");
  if (members.length < 2 || members.length > 16) throw new Error("a list has between 2 and 16 members");
  if (threshold > members.length) throw new Error(`a list of ${members.length} members cannot need ${threshold} of them`);
  if (threshold * 2 <= members.length) throw new Error(`more than half of the members must agree: a list of ${members.length} needs at least ${Math.floor(members.length / 2) + 1}`);
  return { threshold, members };
}

export function formatList(spec: ListSpec): string { return `${PREFIX}${spec.threshold}:${spec.members.join(",")}`; }

export interface ListEntry extends ImageRef {
  /** The account that stored the image (the manifest's transactions are signed by it). */
  publisher: string;
  /** The members that have exactly this image under this name, tag and architecture. */
  agreed: string[];
}

export interface ListView {
  spec: ListSpec;
  /** What enough members agree on, shaped like a catalog. */
  images: Record<string, { description?: string; tags: Record<string, Record<string, ListEntry>> }>;
  /** Each member's catalog: whether it could be read, and how many images it lists. */
  members: { address: string; ok: boolean; images: number; error?: string }[];
  /** Entries that some members have but not enough of them (an update that is still waiting, for example). */
  waiting: { name: string; tag: string; arch: string; version: string; digest: string; agreed: string[] }[];
}

/** Reads the members' catalogs and works out what the list contains. */
export async function readList(store: ChainStore, spec: ListSpec, cacheDir?: string): Promise<ListView> {
  const results = await Promise.allSettled(spec.members.map((m) => readCatalog(store, m, cacheDir)));
  const members = results.map((r, i) => (r.status === "fulfilled"
    ? { address: spec.members[i]!, ok: true, images: Object.keys(r.value.images).length }
    : { address: spec.members[i]!, ok: false, images: 0, error: (r.reason as Error).message }));
  const readable = members.filter((m) => m.ok).length;
  if (readable < spec.threshold) {
    throw new Error(`only ${readable} of the list's ${spec.members.length} catalogs could be read, and ${spec.threshold} must agree: ${members.filter((m) => !m.ok).map((m) => `${m.address.slice(0, 8)}… (${m.error})`).join("; ")}`);
  }
  // votes[name][tag][arch][digest] = the entries of the members that have it
  type Vote = { ref: ImageRef; by: string; description?: string };
  const votes = new Map<string, Vote[]>();
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    for (const [name, image] of Object.entries(r.value.images)) {
      for (const [tag, arches] of Object.entries(image.tags ?? {})) {
        for (const [arch, ref] of Object.entries(arches ?? {})) {
          if (!ref || typeof ref.digest !== "string" || ref.private) continue;
          const key = JSON.stringify([name, tag, arch, ref.digest]);
          let list = votes.get(key);
          if (!list) votes.set(key, list = []);
          list.push({ ref, by: spec.members[i]!, description: image.description });
        }
      }
    }
  });
  const view: ListView = { spec, images: {}, members, waiting: [] };
  for (const [key, list] of votes) {
    const [name, tag, arch, digest] = JSON.parse(key) as [string, string, string, string];
    const agreed = list.map((v) => v.by);
    // prefer the entry of the member that stored the image itself; any of them names the same content
    const pick = list.find((v) => !v.ref.publisher || v.ref.publisher === v.by) ?? list[0]!;
    if (agreed.length < spec.threshold) { view.waiting.push({ name, tag, arch, version: pick.ref.version, digest, agreed }); continue; }
    const image = (view.images[name] ??= { tags: {} });
    image.description ??= list.find((v) => v.description)?.description;
    (image.tags[tag] ??= {})[arch] = { ...pick.ref, publisher: pick.ref.publisher ?? pick.by, agreed };
  }
  view.waiting.sort((a, b) => (a.name + a.tag + a.arch < b.name + b.tag + b.arch ? -1 : 1));
  return view;
}
