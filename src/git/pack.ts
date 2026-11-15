// Reads git pack files without git: for the page that shows a repository in a browser.
//
// A pack is a list of objects (commits, trees, files, tags), each compressed with zlib, some
// stored as a difference to another object of the same pack. This file unpacks all of them,
// works out each one's name (the SHA-1 git gives it), and reads commits and trees.
//
// Nothing here uses Node or the DOM: it runs in a browser and in the tests alike.

// ---- inflate (RFC 1951), which also says how many bytes of input one stream took: a pack
// does not say where a compressed object ends, only the decompressor finds out.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman { count: Uint16Array; symbol: Uint16Array }

function huffman(lengths: ArrayLike<number>, n: number): Huffman {
  const count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]!]!++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + count[i - 1]!;
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]!]!++] = i;
  return { count, symbol };
}

let fixedLit: Huffman | null = null, fixedDist: Huffman | null = null;

/** Inflates one zlib stream that starts at `at`. Returns the data and where the stream ended. */
export function inflateAt(src: Uint8Array, at: number, sizeHint = 0): { data: Uint8Array; end: number } {
  let pos = at + 2;   // the two bytes of the zlib header
  if ((src[at]! & 0x0f) !== 8 || ((src[at]! << 8) | src[at + 1]!) % 31 !== 0) throw new Error("not a zlib stream");
  if (src[at + 1]! & 0x20) throw new Error("zlib streams with a preset dictionary are not used by git");
  let out = new Uint8Array(Math.max(sizeHint, 256)), n = 0, bitBuf = 0, bitCnt = 0;
  const need = (extra: number) => {
    if (n + extra <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, n + extra));
    bigger.set(out.subarray(0, n)); out = bigger;
  };
  const bits = (count: number): number => {
    while (bitCnt < count) {
      if (pos >= src.length) throw new Error("compressed data ends too early");
      bitBuf |= src[pos++]! << bitCnt; bitCnt += 8;
    }
    const v = bitBuf & ((1 << count) - 1);
    bitBuf >>>= count; bitCnt -= count;
    return v;
  };
  const decode = (h: Huffman): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.count[len]!;
      if (code - count < first) return h.symbol[index + (code - first)]!;
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new Error("compressed data is damaged");
  };
  for (let last = 0; !last;) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      const len = src[pos]! | (src[pos + 1]! << 8);
      pos += 4;
      if (pos + len > src.length) throw new Error("compressed data ends too early");
      need(len); out.set(src.subarray(pos, pos + len), n); n += len; pos += len;
      continue;
    }
    let lit: Huffman, dist: Huffman;
    if (type === 1) {
      if (!fixedLit) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
        fixedLit = huffman(l, 288); fixedDist = huffman(new Uint8Array(30).fill(5), 30);
      }
      lit = fixedLit; dist = fixedDist!;
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[CODE_ORDER[i]!] = bits(3);
      const codes = huffman(lengths.subarray(0, 19), 19);
      lengths.fill(0);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(codes);
        if (sym < 16) { lengths[i++] = sym; continue; }
        let prev = 0, repeat: number;
        if (sym === 16) { if (!i) throw new Error("compressed data is damaged"); prev = lengths[i - 1]!; repeat = 3 + bits(2); }
        else if (sym === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (i + repeat > nlen + ndist) throw new Error("compressed data is damaged");
        while (repeat--) lengths[i++] = prev;
      }
      lit = huffman(lengths.subarray(0, nlen), nlen); dist = huffman(lengths.subarray(nlen, nlen + ndist), ndist);
    } else throw new Error("compressed data is damaged");
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) { need(1); out[n++] = sym; continue; }
      if (sym === 256) break;
      sym -= 257;
      if (sym >= 29) throw new Error("compressed data is damaged");
      const len = LENGTH_BASE[sym]! + bits(LENGTH_EXTRA[sym]!);
      const d = decode(dist);
      if (d >= 30) throw new Error("compressed data is damaged");
      const back = DIST_BASE[d]! + bits(DIST_EXTRA[d]!);
      if (back > n) throw new Error("compressed data is damaged");
      need(len);
      for (let i = 0; i < len; i++, n++) out[n] = out[n - back]!;
    }
  }
  return { data: out.subarray(0, n), end: pos + 4 };   // (four bytes of checksum follow the data)
}

// ---- pack files

export type ObjectType = "commit" | "tree" | "blob" | "tag";
export interface GitObject { type: ObjectType; data: Uint8Array }

const TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const latin1 = new TextDecoder("latin1"), utf8 = new TextDecoder("utf-8");

/** One object from its base and the difference a pack stores for it. */
function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let p = 0;
  const size = () => { let v = 0, shift = 0, b: number; do { b = delta[p++]!; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return v; };
  if (size() !== base.length) throw new Error("a pack's difference does not fit its base");
  const out = new Uint8Array(size());
  let n = 0;
  while (p < delta.length) {
    const op = delta[p++]!;
    if (op & 0x80) {
      let from = 0, len = 0;
      if (op & 0x01) from = delta[p++]!;
      if (op & 0x02) from |= delta[p++]! << 8;
      if (op & 0x04) from |= delta[p++]! << 16;
      if (op & 0x08) from += delta[p++]! * 2 ** 24;
      if (op & 0x10) len = delta[p++]!;
      if (op & 0x20) len |= delta[p++]! << 8;
      if (op & 0x40) len |= delta[p++]! << 16;
      if (!len) len = 0x10000;
      if (from + len > base.length || n + len > out.length) throw new Error("a pack's difference reaches outside its base");
      out.set(base.subarray(from, from + len), n); n += len;
    } else if (op) {
      if (n + op > out.length) throw new Error("a pack's difference is too long");
      out.set(delta.subarray(p, p + op), n); n += op; p += op;
    } else throw new Error("a pack's difference is damaged");
  }
  if (n !== out.length) throw new Error("a pack's difference is too short");
  return out;
}

async function nameOf(type: ObjectType, data: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`${type} ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head); all.set(data, head.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", all)));
}

/** The objects of a repository, by name: filled from its packs. */
export class Objects {
  readonly #byId = new Map<string, GitObject>();
  get size(): number { return this.#byId.size; }
  get(id: string): GitObject | undefined { return this.#byId.get(id); }
  has(id: string): boolean { return this.#byId.has(id); }

  /** Unpacks one pack file and adds its objects. Returns how many it held. */
  async addPack(pack: Uint8Array): Promise<number> {
    if (pack.length < 32 || latin1.decode(pack.subarray(0, 4)) !== "PACK") throw new Error("this is not a git pack file");
    const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    if (view.getUint32(4) !== 2 && view.getUint32(4) !== 3) throw new Error("this pack file is of a version this reader does not know");
    const count = view.getUint32(8);
    interface Entry { type: number; data: Uint8Array; baseOffset?: number; baseId?: string }
    const entries = new Map<number, Entry>();
    const order: number[] = [];
    let p = 12;
    for (let i = 0; i < count; i++) {
      const start = p;
      let b = pack[p++]!;
      const type = (b >> 4) & 7;
      let size = b & 15, shift = 4;
      while (b & 0x80) { b = pack[p++]!; size += (b & 0x7f) * 2 ** shift; shift += 7; }
      const e: Entry = { type, data: new Uint8Array(0) };
      if (type === 6) {
        b = pack[p++]!;
        let back = b & 0x7f;
        while (b & 0x80) { b = pack[p++]!; back = (back + 1) * 128 + (b & 0x7f); }
        e.baseOffset = start - back;
      } else if (type === 7) { e.baseId = hex(pack.subarray(p, p + 20)); p += 20; }
      else if (!TYPES[type]) throw new Error("this pack file holds an object of an unknown kind");
      const got = inflateAt(pack, p, size);
      if (got.data.length !== size) throw new Error("an object in this pack file has the wrong size");
      e.data = got.data; p = got.end;
      entries.set(start, e); order.push(start);
    }
    // objects stored whole first, then those stored as a difference, each after its base
    const done = new Map<number, GitObject>();
    const resolve = (offset: number): GitObject => {
      const have = done.get(offset);
      if (have) return have;
      // (a chain of differences is followed with a loop, not by calling itself: chains can be long)
      const chain: number[] = [];
      let at = offset, base: GitObject | undefined;
      for (;;) {
        const got = done.get(at);
        if (got) { base = got; break; }
        const e = entries.get(at);
        if (!e) throw new Error("a pack's difference names a base that is not there");
        if (e.type === 6) { chain.push(at); at = e.baseOffset!; continue; }
        if (e.type === 7) {
          base = this.#byId.get(e.baseId!);
          if (!base) throw new Error("a pack's difference names an object from another pack that was not read yet");
          chain.push(at);
          break;
        }
        base = { type: TYPES[e.type]!, data: e.data };
        done.set(at, base);
        break;
      }
      for (let i = chain.length - 1; i >= 0; i--) {
        const o: GitObject = { type: base!.type, data: applyDelta(base!.data, entries.get(chain[i]!)!.data) };
        done.set(chain[i]!, o); base = o;
      }
      return base!;
    };
    for (const offset of order) {
      const o = resolve(offset);
      this.#byId.set(await nameOf(o.type, o.data), o);
    }
    return count;
  }

  commit(id: string): Commit {
    const o = this.#byId.get(id);
    if (!o || o.type !== "commit") throw new Error(`${id.slice(0, 10)} is not a commit of this repository`);
    return parseCommit(id, o.data);
  }

  /** The commit a branch or tag points at (a tag object is followed to what it tags). */
  peel(id: string): string {
    for (let i = 0; i < 8; i++) {
      const o = this.#byId.get(id);
      if (!o) throw new Error(`object ${id.slice(0, 10)} is not in this repository`);
      if (o.type !== "tag") return id;
      const m = /^object ([0-9a-f]{40})/m.exec(latin1.decode(o.data.subarray(0, 200)));
      if (!m) throw new Error("a tag does not say what it tags");
      id = m[1]!;
    }
    return id;
  }

  tree(id: string): TreeEntry[] {
    const o = this.#byId.get(id);
    if (!o || o.type !== "tree") throw new Error(`${id.slice(0, 10)} is not a directory of this repository`);
    const out: TreeEntry[] = [];
    for (let p = 0; p < o.data.length;) {
      const space = o.data.indexOf(0x20, p), nul = o.data.indexOf(0, space);
      if (space < 0 || nul < 0 || nul + 21 > o.data.length) throw new Error("a directory of this repository is damaged");
      const mode = latin1.decode(o.data.subarray(p, space));
      out.push({ mode, name: utf8.decode(o.data.subarray(space + 1, nul)), id: hex(o.data.subarray(nul + 1, nul + 21)), kind: mode === "40000" ? "tree" : mode === "160000" ? "submodule" : mode === "120000" ? "link" : "blob" });
      p = nul + 21;
    }
    return out;
  }

  blob(id: string): Uint8Array {
    const o = this.#byId.get(id);
    if (!o || o.type !== "blob") throw new Error(`${id.slice(0, 10)} is not a file of this repository`);
    return o.data;
  }

  /** What a path names in the tree of a commit: a directory's entries, or a file. */
  at(commitId: string, path: string): { kind: "tree"; id: string; entries: TreeEntry[] } | { kind: "blob" | "link" | "submodule"; id: string; mode: string } | null {
    let id = this.commit(commitId).tree;
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const e = this.tree(id).find((x) => x.name === parts[i]);
      if (!e) return null;
      if (e.kind !== "tree") return i === parts.length - 1 ? { kind: e.kind, id: e.id, mode: e.mode } : null;
      id = e.id;
    }
    return { kind: "tree", id, entries: this.tree(id) };
  }

  /** The history that leads to a commit, newest first (by the committers' dates). */
  log(from: string, max = 200): Commit[] {
    const out: Commit[] = [], seen = new Set<string>();
    let queue: Commit[] = this.has(from) ? [this.commit(from)] : [];
    seen.add(from);
    while (queue.length && out.length < max) {
      queue.sort((a, b) => b.committer.time - a.committer.time);
      const c = queue.shift()!;
      out.push(c);
      for (const p of c.parents) if (!seen.has(p) && this.has(p)) { seen.add(p); queue.push(this.commit(p)); }
    }
    return out;
  }

  /** The files that differ between two trees (either may be missing: everything is new, or gone). */
  changes(oldTree: string | null, newTree: string | null, prefix = ""): Change[] {
    const olds = new Map((oldTree ? this.tree(oldTree) : []).map((e) => [e.name, e]));
    const news = new Map((newTree ? this.tree(newTree) : []).map((e) => [e.name, e]));
    const out: Change[] = [];
    for (const name of [...new Set([...olds.keys(), ...news.keys()])].sort()) {
      const a = olds.get(name), b = news.get(name), path = prefix + name;
      if (a && b && a.id === b.id && a.mode === b.mode) continue;
      const aTree = a?.kind === "tree", bTree = b?.kind === "tree";
      if (aTree || bTree) out.push(...this.changes(aTree ? a!.id : null, bTree ? b!.id : null, `${path}/`));
      if (a && !aTree && b && !bTree) out.push({ path, kind: "changed", before: a.id, after: b.id });
      else {
        if (a && !aTree) out.push({ path, kind: "removed", before: a.id });
        if (b && !bTree) out.push({ path, kind: "added", after: b.id });
      }
    }
    return out;
  }
}

export interface TreeEntry { mode: string; name: string; id: string; kind: "tree" | "blob" | "link" | "submodule" }
export interface Person { name: string; email: string; time: number; zone: string }
export interface Commit { id: string; tree: string; parents: string[]; author: Person; committer: Person; message: string; subject: string }
export interface Change { path: string; kind: "added" | "removed" | "changed"; before?: string; after?: string }

function person(line: string): Person {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  return m ? { name: m[1]!, email: m[2]!, time: Number(m[3]), zone: m[4]! } : { name: line, email: "", time: 0, zone: "+0000" };
}

function parseCommit(id: string, data: Uint8Array): Commit {
  const text = utf8.decode(data);
  const split = text.indexOf("\n\n");
  const head = (split < 0 ? text : text.slice(0, split)).split("\n");
  const message = split < 0 ? "" : text.slice(split + 2);
  const c: Commit = { id, tree: "", parents: [], author: person(""), committer: person(""), message, subject: message.split("\n")[0] ?? "" };
  for (const line of head) {
    if (line.startsWith("tree ")) c.tree = line.slice(5);
    else if (line.startsWith("parent ")) c.parents.push(line.slice(7));
    else if (line.startsWith("author ")) c.author = person(line.slice(7));
    else if (line.startsWith("committer ")) c.committer = person(line.slice(10));
  }
  return c;
}

/** Whether a file's content is text that can be shown (no zero byte in its first part, valid UTF-8). */
export function asText(data: Uint8Array): string | null {
  if (data.subarray(0, 8000).includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return null; }
}

// ---- differences between two texts, line by line

export interface DiffLine { kind: " " | "+" | "-"; text: string; a?: number; b?: number }

/**
 * The lines that were removed and added between two texts, with a few unchanged lines around
 * them. Texts too long to compare line by line give null.
 */
export function diffLines(before: string, after: string, context = 3): DiffLine[] | null {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n"), b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (n * m > 4_000_000) return null;
  // the longest run of lines both have, from the back, so that the walk forward reads it off
  const width = m + 1, table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  }
  const all: DiffLine[] = [];
  for (let i = 0; i < start; i++) all.push({ kind: " ", text: a[i]!, a: i + 1, b: i + 1 });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { all.push({ kind: " ", text: a[start + i]!, a: start + i + 1, b: start + j + 1 }); i++; j++; }
    // (where both ways are as good, the removed line comes first, as people expect to read it)
    else if (i < n && (j >= m || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { all.push({ kind: "-", text: a[start + i]!, a: start + i + 1 }); i++; }
    else { all.push({ kind: "+", text: b[start + j]!, b: start + j + 1 }); j++; }
  }
  for (let k = 0; endA + k < a.length; k++) all.push({ kind: " ", text: a[endA + k]!, a: endA + k + 1, b: endB + k + 1 });
  // keep the changed lines and `context` lines around them
  const keep = new Uint8Array(all.length);
  all.forEach((l, k) => { if (l.kind !== " ") for (let x = Math.max(0, k - context); x <= Math.min(all.length - 1, k + context); x++) keep[x] = 1; });
  return all.filter((_, k) => keep[k]);
}
