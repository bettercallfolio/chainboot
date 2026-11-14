// Snapshots: a machine's changes, encrypted and stored on chain, and the way back.
//
//   state pointer (per machine)  -->  snapshot manifest  -->  packs with the new file contents
//   all three are encrypted with the vault's key and signed by the vault's keypair
//
// A snapshot always describes the machine's whole layer (everything that differs from the
// image), but only content that is not on chain yet is uploaded: files already stored by an
// earlier snapshot, or present in the public image, are referenced instead.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compress, decompress, type Codec } from "../codec/index.ts";
import { comparePaths, type FileNode, type ImageManifest, type PackInfo, type TreeNode } from "../image/manifest.ts";
import type { MachineInfo } from "../engine/linux.ts";
import { ChainStore, tagAddress } from "../store/store.ts";
import type { Commitment } from "../store/sender.ts";
import { sha256, toHex } from "../util/bytes.ts";
import type { Change, ScanResult } from "./scan.ts";
import { writeXattrs } from "../util/xattr.ts";
import { withLock } from "../util/lock.ts";
import { open, openEither, seal, sealWithKey, type Vault } from "./vault.ts";

/** Raw bytes per pack of saved changes (smaller than image packs, so memory use stays modest). */
const SAVE_PACK_RAW = 32 << 20;

export interface SnapshotPack extends PackInfo {
  /** 1: encrypted (its own key is in `key`; packs saved by early versions open with the vault key). 0: a public pack of the image, referenced as is. */
  enc: 0 | 1;
}

export interface StoredRef { sig: string; sha256: string; size: number; codec: Codec; rawSize: number }

export interface SnapshotSummary { seq: number; time: number; ref: StoredRef; files: number; bytes: number; note?: string }

/** How many earlier saves a snapshot lists itself. Older ones are reached through the oldest of these (see snapshotBySeq). */
export const HISTORY_LISTED = 200;

export interface Snapshot {
  chainboot: 1;
  kind: "snapshot";
  machine: string;
  seq: number;
  time: number;
  image: MachineInfo["image"];
  packs: SnapshotPack[];
  tree: TreeNode[];
  deleted: string[];
  fingerprint: string;
  /** Earlier snapshots of this machine, newest first (for "history" and going back). */
  history: SnapshotSummary[];
  /** What the user wrote about this save. */
  note?: string;
}

export interface Head { seq: number; time: number; ref: StoredRef }

export interface SavePlan { newBytes: number; storedBytes: number; transactions: number; lamports: number; reusedFiles: number; newFiles: number }

export interface SaveOptions {
  journalDir?: string;
  commitment?: Commitment;
  note?: string;
  /** Called after the data is stored and just before the machine's pointer is moved to the new save. Throw to stop (for example when another computer saved meanwhile). */
  beforePointer?: () => Promise<void>;
  /** Called once the cost is known and before anything is sent. Return false to cancel. */
  approve?: (plan: SavePlan) => boolean | Promise<boolean>;
  onProgress?: (phase: string, done: number, total: number) => void;
}

const stateTag = (v: Vault, machine: string) => tagAddress("state", v.signer.publicKey, machine);
/** The tag under which a machine's newest save is named. */
export const stateTagOf = stateTag;
const indexTag = (v: Vault) => tagAddress("machines", v.signer.publicKey);
/** The tag under which a vault's list of saved machines is named. */
export const indexTagOf = indexTag;

// ---- small encrypted documents: an object on chain plus a pointer to its newest version

export async function putDoc(store: ChainStore, v: Vault, tag: Buffer, purpose: string, doc: unknown, extra: Record<string, unknown>, opts: { journalDir?: string; commitment?: Commitment; onProgress?: (done: number, total: number) => void } = {}): Promise<StoredRef> {
  const raw = Buffer.from(JSON.stringify(doc), "utf8");
  const packed = compress(raw);
  const sealed = seal(v.encKey, packed.data, purpose);
  const o = await store.put(v.signer, sealed, { journalDir: opts.journalDir, commitment: opts.commitment, onProgress: (p) => opts.onProgress?.(p.done, p.total) });
  const ref: StoredRef = { sig: o.sig, sha256: o.sha256, size: o.size, codec: packed.codec, rawSize: raw.length };
  await store.putPointer(v.signer, tag, seal(v.encKey, Buffer.from(JSON.stringify({ ref, ...extra })), `${purpose}-pointer`), { commitment: opts.commitment });
  return ref;
}

export async function getDocByRef<T>(store: ChainStore, v: Vault, purpose: string, ref: StoredRef, cacheDir?: string): Promise<T> {
  const sealed = await store.get({ sig: ref.sig, sha256: ref.sha256, size: ref.size }, { signers: [v.signer.publicKey], cacheDir });
  return JSON.parse(decompress(ref.codec, open(v.encKey, sealed, purpose), ref.rawSize).toString("utf8")) as T;
}

export async function getPointer<T>(store: ChainStore, v: Vault, tag: Buffer, purpose: string): Promise<(T & { ref: StoredRef }) | null> {
  const p = await store.getPointer(tag, [v.signer.publicKey]);
  if (!p) return null;
  return JSON.parse(open(v.encKey, p.payload, `${purpose}-pointer`).toString("utf8")) as T & { ref: StoredRef };
}

// ---- the list of saved machines of a vault

export interface MachineIndex { machines: Record<string, { image: MachineInfo["image"]; created: number; boot?: boolean; lazy?: boolean }> }

export async function readIndex(store: ChainStore, v: Vault): Promise<MachineIndex> {
  const p = await getPointer<object>(store, v, indexTag(v), "index");
  if (!p) return { machines: {} };
  const index = await getDocByRef<MachineIndex>(store, v, "index", p.ref);
  if (!index || typeof index.machines !== "object" || index.machines === null || Array.isArray(index.machines)) throw new Error("the list of saved machines is malformed");
  return index;
}

export async function writeIndex(store: ChainStore, v: Vault, index: MachineIndex, commitment?: Commitment): Promise<void> {
  await putDoc(store, v, indexTag(v), "index", index, {}, { commitment });
}

export async function forgetMachine(store: ChainStore, v: Vault, name: string): Promise<boolean> {
  return withLock(`index-${v.signer.address}`, async () => {
    const index = await readIndex(store, v);
    if (!index.machines[name]) return false;
    delete index.machines[name];
    await writeIndex(store, v, index);
    return true;
  });
}

// ---- reading

/** Newest saved state of a machine, or null when it was never saved. */
export async function readHead(store: ChainStore, v: Vault, machine: string): Promise<Head | null> {
  const p = await getPointer<{ seq: number; time: number }>(store, v, stateTag(v, machine), "snapshot");
  return p ? { seq: p.seq, time: p.time, ref: p.ref } : null;
}

export async function readSnapshot(store: ChainStore, v: Vault, ref: StoredRef, cacheDir?: string): Promise<Snapshot> {
  const s = await getDocByRef<Snapshot>(store, v, "snapshot", ref, cacheDir);
  checkSnapshot(s);
  return s;
}

const isCount = (x: unknown, max = Number.MAX_SAFE_INTEGER): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= max;
const isHash = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const safePath = (p: unknown): p is string => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.includes("\0") && !p.split("/").some((part) => part === "" || part === "." || part === "..");
const isRef = (r: unknown): r is StoredRef => { const x = r as StoredRef | null; return !!x && typeof x.sig === "string" && isHash(x.sha256) && isCount(x.size) && isCount(x.rawSize) && ["xz", "zstd", "raw"].includes(x.codec); };

/** Checks the description of the image a saved or shared machine was made from. It is used to fetch that image, and its digest names a directory. */
export function checkImageRef(image: unknown): asserts image is MachineInfo["image"] {
  const i = image as MachineInfo["image"] | null;
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (!i || typeof i !== "object" || typeof i.publisher !== "string" || i.publisher.length > 64 || !name.test(String(i.name)) || !name.test(String(i.tag)) || !name.test(String(i.arch)) || !isHash(i.digest) || !isRef(i.manifest)
    || (i.private !== undefined && typeof i.private !== "boolean") || (i.manifest.key !== undefined && (typeof i.manifest.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(i.manifest.key)))) throw new Error("the description of the machine's image is malformed");
}

/**
 * Checks everything a snapshot promises before any of it is used: it may have been written by
 * somebody else (a shared machine), and it is applied to a machine's files with full rights.
 */
export function checkSnapshot(s: unknown): asserts s is Snapshot {
  const fail = (why: string): never => { throw new Error(`the saved snapshot is malformed: ${why}`); };
  const o = s as Snapshot | null;
  if (!o || o.chainboot !== 1 || o.kind !== "snapshot" || !Array.isArray(o.tree) || !Array.isArray(o.packs) || !Array.isArray(o.deleted) || !Array.isArray(o.history)) fail("not a snapshot");
  if (typeof o!.machine !== "string" || !isCount(o!.seq) || !isCount(o!.time) || typeof o!.fingerprint !== "string") fail("missing fields");
  try { checkImageRef(o!.image); } catch (e) { fail((e as Error).message); }
  for (const p of o!.packs) {
    if (!p || typeof p.sig !== "string" || !isHash(p.sha256) || !isHash(p.rawSha256) || !isCount(p.size) || !isCount(p.rawSize) || !["xz", "zstd", "raw"].includes(p.codec) || (p.enc !== 0 && p.enc !== 1) || (p.key !== undefined && (typeof p.key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(p.key)))) fail("malformed pack entry");
  }
  for (const p of o!.deleted) if (!safePath(p)) fail(`unsafe path ${JSON.stringify(p)}`);
  for (const h of o!.history) if (!h || !isCount(h.seq) || !isCount(h.time) || !isRef(h.ref)) fail("malformed history");
  const kinds = new Map<string, string>();
  for (const n of o!.tree as unknown[][]) {
    if (!Array.isArray(n) || !safePath(n[0]) || typeof n[1] !== "string") fail("malformed entry");
    const path = n[0] as string, type = n[1] as string;
    // every path once: a second entry for it could swap what the first one made for something else
    if (kinds.has(path)) fail(`${path} is there twice`);
    const attrs = () => { if (!isCount(n[2], 0o7777) || !isCount(n[3], 0xffff_ffff) || !isCount(n[4], 0xffff_ffff) || !isCount(n[5])) fail(`bad attributes for ${path}`); };
    const xattrs = (x: unknown) => { if (x !== undefined && (!x || typeof x !== "object" || Array.isArray(x) || Object.values(x as object).some((v) => typeof v !== "string"))) fail(`bad extended attributes for ${path}`); };
    switch (type) {
      case "f": {
        attrs();
        if (n.length < 10 || n.length > 11 || !isCount(n[6]) || !isHash(n[7]) || !Number.isInteger(n[8]) || !isCount(n[9])) fail(`bad file entry ${path}`);
        const size = n[6] as number, pack = n[8] as number;
        if (size > 0 && (pack < 0 || pack >= o!.packs.length || (n[9] as number) + size > o!.packs[pack]!.rawSize)) fail(`file ${path} points outside its pack`);
        xattrs(n[10]);
        break;
      }
      case "d": attrs(); if (n.length > 7) fail(`bad directory entry ${path}`); xattrs(n[6]); break;
      case "l": attrs(); if (n.length !== 7 || typeof n[6] !== "string" || !n[6] || n[6].includes("\0")) fail(`bad symlink ${path}`); break;
      case "h": if (n.length !== 3 || !safePath(n[2])) fail(`bad hard link ${path}`); break;
      case "c": case "b": attrs(); if (n.length !== 8 || !isCount(n[6]) || !isCount(n[7])) fail(`bad device entry ${path}`); break;
      case "p": attrs(); if (n.length !== 6) fail(`bad fifo ${path}`); break;
      default: fail(`unknown entry type ${type} for ${path}`);
    }
    kinds.set(path, type);
  }
}

/**
 * The snapshot with number `seq` of a machine. The newest snapshot lists the 200 before it;
 * an older one is reached through the oldest of those, which lists the 200 before itself.
 */
export async function snapshotBySeq(store: ChainStore, v: Vault, head: Head, seq: number, cacheDir?: string): Promise<{ snapshot: Snapshot; ref: StoredRef } | null> {
  let ref = head.ref, snapshot = await readSnapshot(store, v, ref, cacheDir);
  for (let hops = 0; hops < 10_000; hops++) {
    if (snapshot.seq === seq) return { snapshot, ref };
    const listed = snapshot.history.find((h) => h.seq === seq);
    const oldest = snapshot.history[snapshot.history.length - 1];
    const next = listed ?? oldest;
    if (!next || next.seq >= snapshot.seq || next.seq < seq) return null;
    ref = next.ref; snapshot = await readSnapshot(store, v, ref, cacheDir);
  }
  return null;
}

// ---- saving

function order(files: Change[]): Change[] {
  const ext = (p: string) => { const m = /\.([A-Za-z0-9_]+)$/.exec(p.slice(p.lastIndexOf("/") + 1)); return m ? m[1]!.toLowerCase() : ""; };
  return [...files].sort((a, b) => (ext(a.path) < ext(b.path) ? -1 : ext(a.path) > ext(b.path) ? 1 : 0) || (b.size ?? 0) - (a.size ?? 0) || comparePaths(a.path, b.path));
}

/**
 * Stores the scanned changes as a new snapshot and moves the machine's state pointer to it.
 * Returns null when `approve` declined. `prev` is the snapshot the pointer currently names.
 */
export async function saveSnapshot(store: ChainStore, v: Vault, machine: MachineInfo, base: ImageManifest, scan: ScanResult, prev: { snapshot: Snapshot; head: Head } | null, opts: SaveOptions = {}): Promise<{ head: Head; plan: SavePlan } | null> {
  // where each content already lives: in an earlier snapshot's packs, or in the image's public packs
  const packs: SnapshotPack[] = [];
  const packIndex = new Map<string, number>();
  const usePack = (p: SnapshotPack): number => {
    let i = packIndex.get(p.sig);
    if (i === undefined) { i = packs.length; packs.push(p); packIndex.set(p.sig, i); }
    return i;
  };
  const known = new Map<string, { pack: SnapshotPack; offset: number }>();
  for (const n of base.tree) if (n[1] === "f" && n[6] > 0) known.set(n[7], { pack: { ...base.packs[n[8]]!, enc: base.packs[n[8]]!.enc ?? 0 }, offset: n[9] });
  if (prev) for (const n of prev.snapshot.tree) if (n[1] === "f" && n[6] > 0) known.set(n[7], { pack: prev.snapshot.packs[n[8]]!, offset: n[9] });

  const files = scan.changes.filter((c) => c.type === "f" && (c.size ?? 0) > 0);
  const fresh = new Map<string, Change>();
  for (const f of files) if (!known.has(f.sha256!) && !fresh.has(f.sha256!)) fresh.set(f.sha256!, f);

  // build, compress and encrypt the new packs before sending anything, so the cost is known up front
  const groups: Change[][] = [];
  let group: Change[] = [], size = 0;
  for (const f of order([...fresh.values()])) {
    if (size && size + f.size! > SAVE_PACK_RAW) { groups.push(group); group = []; size = 0; }
    group.push(f); size += f.size!;
  }
  if (group.length) groups.push(group);
  const sealedPacks: { info: SnapshotPack; data: Buffer; members: { sha256: string; offset: number }[] }[] = [];
  groups.forEach((g, gi) => {
    opts.onProgress?.("compressing", gi, groups.length);
    const members: { sha256: string; offset: number }[] = [];
    const parts: Buffer[] = [];
    let offset = 0;
    for (const f of g) {
      const data = fs.readFileSync(f.src!);
      if (data.length !== f.size || toHex(sha256(data)) !== f.sha256) throw new ChangedDuringSave(f.path);
      members.push({ sha256: f.sha256!, offset }); parts.push(data); offset += data.length;
    }
    const raw = Buffer.concat(parts);
    const packed = compress(raw, { arch: machine.image.arch });
    const { sealed: data, key } = sealWithKey(v.encKey, packed.data, "pack");
    sealedPacks.push({ members, data, info: { sig: "", sha256: toHex(sha256(data)), size: data.length, codec: packed.codec, rawSha256: toHex(sha256(raw)), rawSize: raw.length, enc: 1, key } });
  });

  const newBytes = [...fresh.values()].reduce((n, f) => n + f.size!, 0);
  const storedBytes = sealedPacks.reduce((n, p) => n + p.data.length, 0);
  // packs + manifest (estimated from the tree size) + state pointer + possibly the machine list
  const manifestEstimate = 400 + scan.changes.length * 60 + scan.deleted.length * 30;
  const transactions = sealedPacks.reduce((n, p) => n + ChainStore.plan(p.data.length, store.defaults).transactions, 0) + ChainStore.plan(manifestEstimate, store.defaults).transactions + 4;
  const plan: SavePlan = { newBytes, storedBytes, transactions, lamports: transactions * (5000 + Math.max(0, store.defaults.priorityFeeLamports ?? 0)), reusedFiles: files.length - fresh.size, newFiles: fresh.size };
  if (opts.approve && !(await opts.approve(plan))) return null;

  let sent = 0;
  const total = Math.max(1, storedBytes);
  for (const p of sealedPacks) {
    const base0 = sent;
    const ref = await store.put(v.signer, p.data, { journalDir: opts.journalDir, commitment: opts.commitment, onProgress: (g) => { if (g.phase === "data") opts.onProgress?.("uploading", base0 + Math.round((g.done / Math.max(1, g.total)) * p.data.length), total); } });
    p.info.sig = ref.sig;
    sent += p.data.length;
    for (const m of p.members) known.set(m.sha256, { pack: p.info, offset: m.offset });
  }

  const tree: TreeNode[] = scan.changes.map((c): TreeNode => {
    switch (c.type) {
      case "f": {
        const w = c.size ? known.get(c.sha256!)! : null;
        const n: FileNode = w ? [c.path, "f", c.mode, c.uid, c.gid, c.mtime, c.size!, c.sha256!, usePack(w.pack), w.offset] : [c.path, "f", c.mode, c.uid, c.gid, c.mtime, 0, c.sha256!, -1, 0];
        if (c.xattrs) n.push(c.xattrs);
        return n;
      }
      case "d": return c.xattrs ? [c.path, "d", c.mode, c.uid, c.gid, c.mtime, c.xattrs] : [c.path, "d", c.mode, c.uid, c.gid, c.mtime];
      case "l": return [c.path, "l", c.mode, c.uid, c.gid, c.mtime, c.link ?? ""];
      case "h": return [c.path, "h", c.link ?? ""];
      case "c": case "b": return [c.path, c.type, c.mode, c.uid, c.gid, c.mtime, c.major ?? 0, c.minor ?? 0];
      case "p": return [c.path, "p", c.mode, c.uid, c.gid, c.mtime];
    }
  });
  const seq = (prev?.head.seq ?? 0) + 1, time = Math.floor(Date.now() / 1000);
  const history: SnapshotSummary[] = prev
    ? [{ seq: prev.head.seq, time: prev.head.time, ref: prev.head.ref, files: prev.snapshot.tree.length, bytes: prev.snapshot.tree.reduce((n, t) => n + (t[1] === "f" ? t[6] : 0), 0), ...(prev.snapshot.note && { note: prev.snapshot.note }) }, ...prev.snapshot.history].slice(0, HISTORY_LISTED)
    : [];
  const snapshot: Snapshot = { chainboot: 1, kind: "snapshot", machine: machine.name, seq, time, image: machine.image, packs, tree, deleted: scan.deleted, fingerprint: scan.fingerprint, history, ...(opts.note && { note: opts.note.slice(0, 500) }) };
  opts.onProgress?.("finishing", 0, 1);
  await opts.beforePointer?.();
  const ref = await putDoc(store, v, stateTag(v, machine.name), "snapshot", snapshot, { seq, time }, { journalDir: opts.journalDir, commitment: opts.commitment });
  // The machine must be in the list of saved machines, or no other computer finds it. This is
  // looked at on every save, not only the first: a first save that was cut short after the
  // snapshot, or two machines saved for the first time at once, would otherwise never be listed.
  await withLock(`index-${v.signer.address}`, async () => {
    const index = await readIndex(store, v);
    const entry = index.machines[machine.name];
    if (entry && !!entry.boot === !!machine.boot && !!entry.lazy === !!machine.lazy) return;
    index.machines[machine.name] = { image: entry?.image ?? machine.image, created: entry?.created ?? machine.created, ...(machine.boot && { boot: true }), ...(machine.lazy && { lazy: true }) };
    await writeIndex(store, v, index, opts.commitment);
  });
  opts.onProgress?.("finishing", 1, 1);
  return { head: { seq, time, ref }, plan };
}

export class ChangedDuringSave extends Error {
  constructor(file: string) { super(`${file} changed while it was being saved`); this.name = "ChangedDuringSave"; }
}

// ---- restoring

/** Loads the decoded packs a snapshot needs. Image packs come from the local cache when present. */
export async function loadPacks(store: ChainStore, v: Vault, snap: Snapshot, cacheDir: string, onProgress?: (done: number, total: number) => void, have?: (n: FileNode) => boolean): Promise<(index: number) => Buffer> {
  const objects = path.join(cacheDir, "objects");
  // `have` names files whose content is available locally (in the unpacked image), so their pack is not needed
  const used = new Set(snap.tree.filter((n): n is FileNode => n[1] === "f" && n[6] > 0 && !have?.(n)).map((n) => n[8]));
  const total = [...used].reduce((n, i) => n + snap.packs[i]!.size, 0);
  const got = new Map<number, number>();
  const raw = new Map<number, Buffer>();
  await Promise.all([...used].map(async (i) => {
    const p = snap.packs[i]!;
    const stored = await store.get({ sig: p.sig, sha256: p.sha256, size: p.size }, {
      signers: p.enc && !p.key ? [v.signer.publicKey] : undefined, cacheDir: objects,
      onProgress: (g) => { got.set(i, g.bytes); onProgress?.([...got.values()].reduce((a, b) => a + b, 0), total); },
    });
    const data = decompress(p.codec, p.enc ? openEither(v.encKey, p.key, stored, "pack") : stored, p.rawSize);
    if (toHex(sha256(data)) !== p.rawSha256) throw new Error(`saved pack ${i + 1} is damaged`);
    raw.set(i, data);
  }));
  return (i) => { const r = raw.get(i); if (!r) throw new Error(`snapshot pack ${i} was not loaded`); return r; };
}

/**
 * Applies a snapshot on top of a freshly started machine (its merged view shows the plain image).
 * Works through ordinary file operations, so the result is exactly what the user had.
 */
export function applySnapshot(snap: Snapshot, merged: string, content: (n: FileNode) => Buffer): { unmappedOwners: string[]; lostAttributes: string[] } {
  checkSnapshot(snap);
  const lostAttrs = new Set<string>();
  // without administrator rights a machine has user IDs 0..65536; a file of an owner beyond that stays root's
  const unmapped = new Set<string>();
  const own = (p: string, uid: number, gid: number) => {
    try { fs.lchownSync(p, uid, gid); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EINVAL") throw e;
      unmapped.add(`${uid}:${gid}`);
    }
  };
  const at = (p: string) => {
    if (!p || p.startsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`unsafe path in snapshot: ${p}`);
    // every parent must be a real directory inside the machine: a symlink could lead outside of it
    const parts = p.split("/");
    let cur = merged;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = path.join(cur, parts[i]!);
      const st = fs.lstatSync(cur, { throwIfNoEntry: false });
      if (!st) fs.mkdirSync(cur, { mode: 0o755 });
      else if (!st.isDirectory()) throw new Error(`cannot restore ${p}: ${parts.slice(0, i + 1).join("/")} is not a directory`);
    }
    return path.join(merged, p);
  };
  const clear = (p: string) => fs.rmSync(p, { recursive: true, force: true });
  for (const p of snap.deleted) clear(at(p));
  const dirs: TreeNode[] = [], links: TreeNode[] = [];
  for (const n of [...snap.tree].sort((a, b) => comparePaths(a[0], b[0]))) {
    const p = at(n[0]);
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    switch (n[1]) {
      case "d":
        if (st && !st.isDirectory()) clear(p);
        if (!st || !st.isDirectory()) fs.mkdirSync(p);
        dirs.push(n);
        break;
      case "f": {
        if (st) clear(p);
        const data = n[6] === 0 ? Buffer.alloc(0) : content(n);
        if (data.length !== n[6] || (n[6] > 0 && toHex(sha256(data)) !== n[7])) throw new Error(`the saved content of ${n[0]} is damaged (it does not match its hash)`);
        fs.writeFileSync(p, data, { mode: 0o600 });
        own(p, n[3], n[4]); fs.chmodSync(p, n[2]);
        if (n[10] && writeXattrs(p, n[10]).length) lostAttrs.add(n[0]); // after chown, which clears file capabilities
        fs.utimesSync(p, n[5], n[5]);
        break;
      }
      case "l":
        if (st) clear(p);
        fs.symlinkSync(n[6], p); own(p, n[3], n[4]); fs.lutimesSync(p, n[5], n[5]);
        break;
      case "h": links.push(n); break;
      case "c": case "b": case "p": {
        if (st) clear(p);
        const r = spawnSync("mknod", ["-m", (n[2] & 0o7777).toString(8), p, n[1], ...(n[1] === "p" ? [] : [String(n[6]), String(n[7])])]);
        if (r.status === 0) { own(p, n[3], n[4]); fs.utimesSync(p, n[5], n[5]); }
        break;
      }
    }
  }
  for (const n of links) {
    if (n[1] !== "h") continue;
    const p = at(n[0]), target = at(n[2]);
    // a hard link is made to a regular file only: through a symlink it would reach a file outside the machine
    if (!fs.lstatSync(target, { throwIfNoEntry: false })?.isFile()) throw new Error(`cannot restore ${n[0]}: ${n[2]} is not a regular file`);
    clear(p); fs.linkSync(target, p);
  }
  for (let i = dirs.length - 1; i >= 0; i--) {
    const n = dirs[i]!;
    if (n[1] !== "d") continue;
    const p = at(n[0]);
    // still the directory that was made above: chmod and utimes follow a symlink, which would lead out of the machine
    if (!fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`cannot restore ${n[0]}: it is not a directory any more`);
    own(p, n[3], n[4]); fs.chmodSync(p, n[2]);
    if (n[6] && writeXattrs(p, n[6]).length) lostAttrs.add(n[0]);
    fs.utimesSync(p, n[5], n[5]);
  }
  return { unmappedOwners: [...unmapped], lostAttributes: [...lostAttrs] };
}
