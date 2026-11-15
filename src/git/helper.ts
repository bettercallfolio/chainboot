// git-remote-sol: what lets plain git use a repository on chain as a remote.
//
//   git remote add origin sol://<owner>/<name>      git clone sol://<owner>/<name>
//   git push origin main                            git fetch, git pull
//
// git starts this program (as "git-remote-sol <remote> <url>") whenever it talks to a
// sol:// remote, and speaks a small line protocol with it ("gitremote-helpers" in git's
// manual): list the branches, fetch objects, push branches. Packs are made and unpacked by
// git itself; this side only stores them and keeps the branch list (repo.ts).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { homeDir, loadConfig, openStore, paths, type Config } from "../local/home.ts";
import { addressToBytes, Keypair } from "../solana/keys.ts";
import { loadVault, type Vault } from "../state/vault.ts";
import type { ChainStore } from "../store/store.ts";
import { fmtBytes } from "../util/bytes.ts";
import { withLock } from "../util/lock.ts";
import { checkRepoName, emptyIndex, getPack, noteRepo, putPack, readRepo, repoKey, writeRepo, PrivateRepoError, type Repo, type RepoIndex } from "./repo.ts";

// ---- who and what

export interface RepoUrl { owner: string; name: string }

/** "sol://<owner>/<name>" (also with ".git" at the end). The owner is an address, a saved publisher name, or "me". */
export function parseUrl(url: string): RepoUrl {
  const m = /^sol:\/\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) throw new Error(`"${url}" is not a repository address. It looks like this: sol://<owner>/<name>`);
  checkRepoName(m[2]!);
  return { owner: m[1]!, name: m[2]! };
}

/** The address behind an owner as people write it: "me" (the signed-in wallet's vault), a saved name, or an address. */
export function ownerAddress(c: Config, owner: string, vault: Vault | null): string {
  if (owner === "me") {
    if (!vault) throw new Error('"me" is the wallet you are signed in with, and you are not signed in: chainboot login');
    return vault.signer.address;
  }
  const saved = c.publishers[owner];
  const address = saved && !saved.startsWith("list:") ? saved : owner;
  try { if (addressToBytes(address).length !== 32) throw new Error("length"); } catch { throw new Error(`"${owner}" is neither an address nor a name you saved (chainboot publisher add <name> <address>)`); }
  return address;
}

const keysFile = () => path.join(homeDir(), "git-keys.json");

/** Keys of private repositories that other wallets shared with this one. */
export function sharedKeys(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(keysFile(), "utf8")) as Record<string, string>; } catch { return {}; }
}
export function saveSharedKey(owner: string, name: string, key: string): void {
  const all = { ...sharedKeys(), [`${owner}/${name}`]: key };
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(keysFile(), JSON.stringify(all, null, 1), { mode: 0o600 });
}

/** The key that reads a private repository, if this computer has one: the owner's own, or one that was shared. */
export function readerKey(owner: string, name: string, vault: Vault | null): Buffer | undefined {
  if (vault && vault.signer.address === owner) return repoKey(vault, name);
  const shared = sharedKeys()[`${owner}/${name}`];
  return shared ? Buffer.from(shared, "base64") : undefined;
}

export interface Writer { signer: Keypair; vault: Vault | null }

/**
 * The key that may push to a repository of `owner`: a keypair file named for git
 * (git config chainboot.keypair, or CHAINBOOT_KEYPAIR), or the signed-in wallet's vault.
 */
export function writerFor(owner: string, vault: Vault | null, keypairFile?: string): Writer {
  if (keypairFile) {
    const kp = Keypair.fromFile(keypairFile);
    if (kp.address === owner) return { signer: kp, vault: null };
  }
  if (vault && vault.signer.address === owner) return { signer: vault.signer, vault };
  throw new Error(`this repository belongs to ${owner}, and neither your keypair nor the wallet you are signed in with is that key. Only its owner can push to it. To offer changes, push to a repository of your own and open a pull request: chainboot git pr new`);
}

// ---- git

function git(args: string[], opts: { input?: Uint8Array | string; allowFail?: boolean; gitDir?: string } = {}): { ok: boolean; out: Buffer; err: string } {
  const r = spawnSync("git", args, { input: opts.input, maxBuffer: 4 * 1024 ** 3, env: { ...process.env, ...(opts.gitDir && { GIT_DIR: opts.gitDir }) }, windowsHide: true });
  if (r.error) throw new Error(`git could not be started: ${r.error.message}`);
  const ok = r.status === 0;
  if (!ok && !opts.allowFail) throw new Error(`git ${args[0]} failed: ${r.stderr.toString("utf8").trim() || `exit status ${r.status}`}`);
  return { ok, out: r.stdout, err: r.stderr.toString("utf8") };
}

export const gitText = (args: string[], gitDir?: string): string | null => {
  const r = git(args, { allowFail: true, gitDir });
  return r.ok ? r.out.toString("utf8").trim() : null;
};

const say = (text: string) => process.stderr.write(`chainboot: ${text}\n`);

/** How many objects a pack file holds (its header says). */
export const packObjects = (pack: Uint8Array): number => (pack.length >= 12 && Buffer.from(pack.subarray(0, 4)).toString("latin1") === "PACK" ? Buffer.from(pack).readUInt32BE(8) : 0);

// ---- what this computer already has of a repository

function stateFile(gitDir: string, owner: string, name: string): string {
  return path.join(gitDir, "chainboot", `${owner}-${name}.json`);
}
function fetched(gitDir: string, owner: string, name: string): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(stateFile(gitDir, owner, name), "utf8")) as string[]); } catch { return new Set(); }
}
function noteFetched(gitDir: string, owner: string, name: string, have: Set<string>): void {
  const file = stateFile(gitDir, owner, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...have]));
}

/** Brings every pack of the repository that this clone does not have yet into it. Returns how many were fetched. */
export async function fetchPacks(store: ChainStore, repo: Repo, key: Buffer | undefined, gitDir: string): Promise<number> {
  const have = fetched(gitDir, repo.owner, repo.index.name);
  const missing = repo.index.packs.filter((p) => !have.has(p.sha256));
  let n = 0;
  for (const p of missing) {
    n++;
    say(`fetching pack ${n} of ${missing.length} (${fmtBytes(p.size)}, ${p.objects} objects)`);
    const pack = await getPack(store, p, key);
    git(["index-pack", "--stdin", "--fix-thin"], { input: pack, gitDir });
    have.add(p.sha256);
    noteFetched(gitDir, repo.owner, repo.index.name, have);
  }
  return missing.length;
}

export interface PushSpec { force: boolean; src: string; dst: string }
export interface PushResult { dst: string; error?: string }

/**
 * Pushes branches (or deletes them, for a spec without a source): one pack of the objects the
 * chain does not have yet, then a new index. A repository that does not exist yet is created
 * with the first push when it is the signed-in wallet's (private); a public one is created
 * on purpose, with "chainboot git create --public".
 */
export async function push(store: ChainStore, c: Config, target: { owner: string; name: string }, specs: PushSpec[], gitDir: string, vault: Vault | null, keypairFile?: string): Promise<PushResult[]> {
  const { owner, name } = target;
  const writer = writerFor(owner, vault, keypairFile);
  return withLock(`git-${owner}-${name}`, async () => {
    const existing = await readRepo(store, owner, name, readerKey(owner, name, vault));
    let index: RepoIndex;
    if (existing) index = existing.index;
    else {
      if (!writer.vault) throw new Error(`${owner}/${name} does not exist yet. A repository that everybody can read is created on purpose: chainboot git create ${name} --public --keypair <file>`);
      index = emptyIndex(name, { private: true });
      say(`creating ${name} as a private repository of your wallet (for a public one, create it first: chainboot git create ${name} --public)`);
    }
    const key = index.private ? (writer.vault ? repoKey(writer.vault, name) : undefined) : undefined;
    if (index.private && !key) throw new Error("a private repository is pushed to by the wallet that owns it: chainboot login");

    const has = (id: string) => git(["cat-file", "-e", id], { allowFail: true, gitDir }).ok;
    const results: PushResult[] = [];
    const wanted: string[] = [];
    const refs = { ...index.refs };
    for (const s of specs) {
      if (!/^refs\/[\x21-\x7e]{1,200}$/.test(s.dst)) { results.push({ dst: s.dst, error: "not a branch or tag name" }); continue; }
      if (!s.src) {
        if (!(s.dst in refs)) { results.push({ dst: s.dst, error: "there is no such branch" }); continue; }
        delete refs[s.dst]; results.push({ dst: s.dst }); continue;
      }
      const id = gitText(["rev-parse", "--verify", "--quiet", s.src], gitDir);
      if (!id) { results.push({ dst: s.dst, error: `${s.src} does not name anything here` }); continue; }
      const old = refs[s.dst];
      if (old && old !== id && !s.force) {
        if (!has(old)) { results.push({ dst: s.dst, error: "fetch first" }); continue; }
        if (!git(["merge-base", "--is-ancestor", old, id], { allowFail: true, gitDir }).ok) { results.push({ dst: s.dst, error: "non-fast-forward" }); continue; }
      }
      refs[s.dst] = id; wanted.push(id); results.push({ dst: s.dst });
    }
    if (results.every((r) => r.error)) return results;

    // one pack: everything the new commits reach that the chain's branches do not
    const known = [...new Set(Object.values(index.refs))].filter(has);
    const news = [...new Set(wanted)].filter((id) => !known.includes(id));
    if (news.length) {
      const pack = git(["pack-objects", "--revs", "--stdout", "--delta-base-offset", "-q"], { input: [...news, ...known.map((id) => `^${id}`)].join("\n") + "\n", gitDir }).out;
      const objects = packObjects(pack);
      if (objects > 0) {
        say(`storing ${objects} objects (${fmtBytes(pack.length)}) on chain`);
        let last = 0;
        const entry = await putPack(store, writer.signer, pack, objects, key, {
          journalDir: paths.journals(),
          onProgress: (p) => { const now = Date.now(); if (p.total > 20 && now - last > 2000) { last = now; say(`  ${p.phase} ${p.done}/${p.total}`); } },
        });
        index.packs.push(entry);
        const have = fetched(gitDir, owner, name); have.add(entry.sha256); noteFetched(gitDir, owner, name, have);
      }
    }
    index.refs = refs;
    if (!index.refs[index.head]) {
      const heads = Object.keys(refs).filter((r) => r.startsWith("refs/heads/"));
      index.head = ["refs/heads/main", "refs/heads/master"].find((r) => refs[r]) ?? heads[0] ?? index.head;
    }
    await writeRepo(store, writer.signer, index, key, { journalDir: paths.journals() });
    if (!existing) await noteRepo(store, writer.signer, name, { private: !!index.private }, writer.vault ?? undefined).catch((e: Error) => say(`the repository was pushed, but it could not be added to your list of repositories: ${e.message}`));
    return results;
  });
}

/** Speaks git's remote-helper protocol on standard input and output until git closes it. */
export async function remoteHelper(_remote: string, url: string): Promise<void> {
  const gitDir = path.resolve(process.env.GIT_DIR ?? gitText(["rev-parse", "--git-dir"]) ?? ".git");
  const c = loadConfig();
  const vault = loadVault(paths.vault(), c.cluster);
  const target = parseUrl(url);
  const owner = ownerAddress(c, target.owner, vault);
  const name = target.name;
  let store: ChainStore | null = null;
  const chain = async () => (store ??= await openStore(c, say));
  let repo: Repo | null | undefined;
  const load = async () => {
    if (repo === undefined) {
      try { repo = await readRepo(await chain(), owner, name, readerKey(owner, name, vault)); }
      catch (e) { if (e instanceof PrivateRepoError) throw e; throw new Error(`could not read ${owner}/${name} from the chain: ${(e as Error).message}`); }
    }
    return repo;
  };
  const out = (line = "") => process.stdout.write(line + "\n");

  const lines = readline.createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const next = async (): Promise<string | null> => { const r = await lines.next(); return r.done ? null : r.value; };

  for (let line = await next(); line !== null; line = await next()) {
    if (line === "") continue;
    if (line === "capabilities") { out("fetch"); out("push"); out("option"); out(); continue; }
    if (line.startsWith("option ")) { out("unsupported"); continue; }
    if (line === "list" || line === "list for-push") {
      const r = await load();
      if (r) {
        for (const [ref, id] of Object.entries(r.index.refs)) out(`${id} ${ref}`);
        if (r.index.refs[r.index.head]) out(`@${r.index.head} HEAD`);
      }
      out();
      continue;
    }
    if (line.startsWith("fetch ")) {
      // (git names what it wants, one line each; what it gets is every pack it does not have)
      for (let l = await next(); l !== null && l !== ""; l = await next()) { /* the rest of the batch */ }
      const r = await load();
      if (r) await fetchPacks(await chain(), r, r.index.private ? readerKey(owner, name, vault) : undefined, gitDir);
      out();
      continue;
    }
    if (line.startsWith("push ")) {
      const specs: PushSpec[] = [];
      for (let l: string | null = line; l !== null && l !== ""; l = await next()) {
        const spec = l.slice("push ".length);
        const force = spec.startsWith("+");
        const [src, dst] = (force ? spec.slice(1) : spec).split(":");
        specs.push({ force, src: src ?? "", dst: dst ?? "" });
      }
      let results: PushResult[];
      try {
        results = await push(await chain(), c, { owner, name }, specs, gitDir, vault, gitText(["config", "--get", "chainboot.keypair"], gitDir) ?? process.env.CHAINBOOT_KEYPAIR);
        repo = undefined;
      } catch (e) {
        say((e as Error).message);
        results = specs.map((s) => ({ dst: s.dst, error: "rejected (see above)" }));
      }
      for (const r of results) out(r.error ? `error ${r.dst} ${r.error}` : `ok ${r.dst}`);
      out();
      continue;
    }
    throw new Error(`git asked for something this helper does not know: ${line}`);
  }
}
