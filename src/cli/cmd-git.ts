// chainboot git: repositories on chain, their issues and pull requests.
// (git itself reaches a repository through git-remote-sol: src/git/helper.ts)
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig, openStore, paths, networkLabel, type Config } from "../local/home.ts";
import { addressToBytes, Keypair } from "../solana/keys.ts";
import { loadVault, openFrom, parseShareAddress, sealTo, shareAddress, shareKeys, type Vault } from "../state/vault.ts";
import { tagAddress, type ChainStore } from "../store/store.ts";
import { fmtBytes } from "../util/bytes.ts";
import { withLock } from "../util/lock.ts";
import { gitText, ownerAddress, parseUrl, readerKey, remoteHelper, saveSharedKey, type Writer } from "../git/helper.ts";
import { checkRepoName, emptyIndex, listRepos, noteRepo, readRepo, repoKey, writeRepo, PrivateRepoError, type Repo } from "../git/repo.ts";
import { postTalk, readTalk, type Item } from "../git/talk.ts";
import { UsageError, flag, has, type Args } from "./args.ts";
import { bold, dim, green, info, ok, out, table, yellow } from "./term.ts";

export const GIT_HELP = `Usage:
  chainboot git create <name> [--public] [--description <text>] [--keypair <file>]
  chainboot git list [<owner>]                 the repositories of an owner (yours without one)
  chainboot git info [<repository>]            branches, size, where it is

  chainboot git issue [list]                   issues and pull requests of a repository
  chainboot git issue new --title <text> [--body <text> | --body-file <file>]
  chainboot git issue show <number>
  chainboot git issue comment <number> --body <text>
  chainboot git issue close <number>           (reopen <number>)

  chainboot git pr new --title <text> [--body <text>] [--from <repository>] [--branch <name>] [--into <branch>]
  chainboot git pr show|comment|close <number>
  chainboot git pr fetch <number>              bring its commits here as the branch pr-<number>
  chainboot git pr merge <number>              merge it into its branch here, push, and mark it merged

  chainboot git share <name> --with <share address>     let another wallet read a private repository
  chainboot git shared [accept <number>]                private repositories shared with you

git itself does the rest. A repository's address is sol://<owner>/<name>:

  git remote add origin sol://me/notes         "me" is the wallet you are signed in with
  git push -u origin main                      the first push creates it, private
  git clone sol://<address>/<name>             anybody can clone a public one

A private repository is encrypted with a key of its wallet and costs what its packs take to
store. A public one is created on purpose (chainboot git create <name> --public) with a
keypair or the signed-in wallet as its owner; for a keypair, tell git which:
  git config chainboot.keypair /path/to/key.json

Commands that work on a repository take --repo <sol://owner/name>. Without it they use the
remote "upstream" of the directory you are in, or "origin".
Data on a ledger cannot be erased: a secret that was pushed stays readable in a public
repository for ever, also after the branch is deleted or pushed over.`;

interface Me { vault: Vault | null; keypair: Keypair | null }

function me(c: Config, a: Args): Me {
  const file = flag(a, "keypair") ?? process.env.CHAINBOOT_KEYPAIR ?? gitText(["config", "--get", "chainboot.keypair"]) ?? undefined;
  if (file && !fs.existsSync(file)) throw new Error(`no keypair found at ${file}`);
  return { vault: loadVault(paths.vault(), c.cluster), keypair: file ? Keypair.fromFile(file) : null };
}

/** The key that signs what this person writes: the keypair when one is named, else the signed-in wallet's vault. */
function signerOf(who: Me): Keypair {
  const s = who.keypair ?? who.vault?.signer;
  if (!s) throw new Error("writing to the chain needs a key that pays: sign in (chainboot login), or name a keypair (--keypair <file>)");
  return s;
}

function repoOf(c: Config, a: Args, who: Me): { owner: string; name: string; url: string } {
  let url = flag(a, "repo");
  if (!url) {
    for (const remote of ["upstream", "origin"]) {
      const u = gitText(["remote", "get-url", remote]);
      if (u?.startsWith("sol://")) { url = u; break; }
    }
  }
  if (!url) throw new UsageError("say which repository: --repo sol://<owner>/<name> (or run this inside a clone of it)");
  if (!url.includes("://")) url = `sol://${url}`;
  const t = parseUrl(url);
  const owner = ownerAddress(c, t.owner, who.vault);
  return { owner, name: t.name, url: `sol://${owner}/${t.name}` };
}

async function open(store: ChainStore, target: { owner: string; name: string }, who: Me): Promise<{ repo: Repo; key: Buffer | undefined }> {
  const key = readerKey(target.owner, target.name, who.vault);
  const repo = await readRepo(store, target.owner, target.name, key);
  if (!repo) throw new Error(`${target.owner} has no repository named ${target.name} on ${networkLabel(loadConfig())}`);
  return { repo, key: repo.index.private ? key : undefined };
}

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;
const day = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") : "");
const stateText = (s: Item["state"]) => (s === "open" ? green("open") : s === "merged" ? yellow("merged") : dim("closed"));

function bodyOf(a: Args): string {
  const file = flag(a, "body-file");
  if (file) return fs.readFileSync(file, "utf8");
  return flag(a, "body") ?? "";
}

function numbered(items: Item[], text: string | undefined, kind?: "issue" | "pr"): Item {
  const n = Number((text ?? "").replace(/^#/, ""));
  const item = Number.isInteger(n) ? items.find((i) => i.number === n) : undefined;
  if (!item) throw new UsageError(text ? `there is no #${text.replace(/^#/, "")} in this repository` : "say which one, by its number");
  if (kind === "pr" && item.kind !== "pr") throw new UsageError(`#${item.number} is an issue, not a pull request`);
  return item;
}

function show(item: Item, repoOwner: string): void {
  out(`${bold(`#${item.number} ${item.title}`)}  ${stateText(item.state)}`);
  out(dim(`${item.kind === "pr" ? "pull request" : "issue"} by ${item.author}${item.author === repoOwner ? " (owner)" : ""}  ${day(item.time)}`));
  if (item.pr) out(dim(`wants ${item.pr.from.ref.replace("refs/heads/", "")} of sol://${item.pr.from.owner}/${item.pr.from.name} (${item.pr.from.id.slice(0, 10)}) in ${item.pr.into.replace("refs/heads/", "")}${item.pr.merged ? `; merged as ${item.pr.merged.slice(0, 10)}` : ""}`));
  if (item.body.trim()) out(`\n${item.body.trim()}`);
  const events = [...item.comments.map((c) => ({ ...c, what: "comment" as const })), ...item.changes.map((s) => ({ ...s, what: "state" as const, body: "" }))]
    .sort((x, y) => (x.time ?? 0) - (y.time ?? 0));
  for (const e of events) {
    if (e.what === "comment") out(`\n${dim(`${e.author}${e.author === repoOwner ? " (owner)" : ""}  ${day(e.time)}`)}\n${e.body.trim()}`);
    else out(`\n${dim(`${e.author}${e.author === repoOwner ? " (owner)" : ""} set it to ${(e as { state: string }).state}  ${day(e.time)}`)}`);
  }
}

async function cmdCreate(c: Config, a: Args): Promise<void> {
  const name = a._[1];
  if (!name) throw new UsageError("say what to call it: chainboot git create <name>");
  checkRepoName(name);
  const who = me(c, a);
  const isPublic = has(a, "public");
  const writer: Writer = who.keypair && isPublic ? { signer: who.keypair, vault: null } : who.vault ? { signer: who.vault.signer, vault: who.vault } : (() => {
    throw new Error(isPublic ? "a public repository belongs to a keypair (--keypair <file>) or to the wallet you are signed in with (chainboot login)" : "a private repository belongs to a wallet: sign in first (chainboot login). For one that everybody can read: --public --keypair <file>");
  })();
  const store = await openStore(c, info);
  const owner = writer.signer.address;
  await withLock(`git-${owner}-${name}`, async () => {
    const key = isPublic ? undefined : repoKey(writer.vault!, name);
    if (await readRepo(store, owner, name, key).catch((e: Error) => { if (e instanceof PrivateRepoError) return true; throw e; })) throw new Error(`you already have a repository named ${name}`);
    const description = flag(a, "description");
    await writeRepo(store, writer.signer, emptyIndex(name, { private: !isPublic, description }), key, { journalDir: paths.journals() });
    await noteRepo(store, writer.signer, name, { private: !isPublic, description }, writer.vault ?? undefined);
  });
  ok(`created ${bold(name)}, ${isPublic ? "PUBLIC: everyone can read it, forever" : "private: encrypted with your wallet's key"}`);
  out(`sol://${owner}/${name}`);
  info(dim(`In your project:  git remote add origin sol://${writer.vault && !isPublic ? "me" : owner}/${name}  &&  git push -u origin main`));
  if (!writer.vault && flag(a, "keypair")) info(dim(`Tell git which key pushes:  git config chainboot.keypair ${flag(a, "keypair")}`));
}

async function cmdList(c: Config, a: Args): Promise<void> {
  const who = me(c, a);
  const owner = a._[1] ? ownerAddress(c, a._[1], who.vault) : (who.keypair ?? who.vault?.signer)?.address;
  if (!owner) throw new UsageError("say whose repositories: chainboot git list <owner> (or sign in to see your own)");
  const store = await openStore(c, info);
  const repos = await listRepos(store, owner, who.vault ?? undefined);
  if (!repos.length) { info(`${owner} has no repositories on ${networkLabel(c)}.`); return; }
  out(table(repos.map((r) => [bold(r.name), r.private ? "private" : "public", `sol://${owner}/${r.name}`, r.description ?? ""]), ["repository", "", "address", "description"]));
}

async function cmdInfo(c: Config, a: Args): Promise<void> {
  const who = me(c, a);
  if (a._[1]) a.flags.set("repo", [a._[1]]);
  const target = repoOf(c, a, who);
  const store = await openStore(c, info);
  const { repo } = await open(store, target, who);
  const i = repo.index;
  out(`${bold(i.name)}  ${i.private ? "private" : "public"}  ${target.url}`);
  if (i.description) out(i.description);
  out(dim(`${i.packs.length} pack(s), ${fmtBytes(i.packs.reduce((n, p) => n + p.size, 0))} on chain, ${i.packs.reduce((n, p) => n + p.objects, 0)} objects; last push ${day(i.updated)}`));
  const rows = Object.entries(i.refs).sort().map(([ref, id]) => [ref === i.head ? `${ref.replace(/^refs\/(heads|tags)\//, "")} *` : ref.replace(/^refs\/(heads|tags)\//, ""), ref.startsWith("refs/tags/") ? "tag" : "branch", id.slice(0, 12)]);
  if (rows.length) out(table(rows, ["name", "", "commit"])); else info("It has no branches yet: push one.");
}

async function cmdTalk(c: Config, a: Args, kind: "issue" | "pr"): Promise<void> {
  const who = me(c, a);
  const action = a._[1] ?? "list";
  const target = repoOf(c, a, who);
  const store = await openStore(c, info);
  const { repo, key } = await open(store, target, who);
  const post = (record: Parameters<typeof postTalk>[4]) => postTalk(store, signerOf(who), target.owner, target.name, record, key);

  if (action === "list") {
    const items = await readTalk(store, target.owner, target.name, key);
    if (!items.length) { info("Nothing has been opened in this repository yet."); return; }
    out(table(items.map((i) => [`#${i.number}`, stateText(i.state), i.kind === "pr" ? "pull request" : "issue", i.title, short(i.author), String(i.comments.length), day(i.time)]), ["", "state", "", "title", "by", "comments", "opened"]));
    return;
  }
  if (action === "new") {
    const title = flag(a, "title");
    if (!title) throw new UsageError("give it a title: --title <text>");
    if (kind === "issue") {
      await post({ t: "issue", title, body: bodyOf(a) });
    } else {
      // where the commits are: the repository this directory pushes to, and the branch that is checked out
      const fromUrl = flag(a, "from") ?? gitText(["remote", "get-url", "origin"]);
      if (!fromUrl?.startsWith("sol://")) throw new UsageError("say where your commits are: --from sol://<owner>/<name> (the repository you pushed them to)");
      const f = parseUrl(fromUrl);
      const fromOwner = ownerAddress(c, f.owner, who.vault);
      const branch = flag(a, "branch") ?? gitText(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!branch || branch === "HEAD") throw new UsageError("say which branch: --branch <name>");
      const ref = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
      const from = await readRepo(store, fromOwner, f.name, readerKey(fromOwner, f.name, who.vault));
      const id = from?.index.refs[ref];
      if (!id) throw new Error(`sol://${fromOwner}/${f.name} has no branch ${branch}: push it first (git push origin ${branch})`);
      if (from!.index.private) throw new Error("the branch is in a private repository, which the owner of the other one could not read");
      const into = flag(a, "into") ?? repo.index.head.replace("refs/heads/", "");
      await post({ t: "pr", title, body: bodyOf(a), from: { owner: fromOwner, name: f.name, ref, id }, into: into.startsWith("refs/") ? into : `refs/heads/${into}` });
    }
    const items = await readTalk(store, target.owner, target.name, key);
    ok(`opened #${items.length} in ${target.url}`);
    return;
  }

  const items = await readTalk(store, target.owner, target.name, key);
  const item = numbered(items, a._[2], kind === "pr" ? "pr" : undefined);
  if (action === "show") { show(item, target.owner); return; }
  if (action === "comment") {
    const body = bodyOf(a);
    if (!body.trim()) throw new UsageError("say what: --body <text>");
    await post({ t: "comment", on: item.id, body });
    ok(`commented on #${item.number}`);
    return;
  }
  if (action === "close" || action === "reopen") {
    const s = signerOf(who).address;
    if (s !== target.owner && s !== item.author) throw new Error(`#${item.number} can be ${action === "close" ? "closed" : "reopened"} by the repository's owner or by its author`);
    await post({ t: "state", on: item.id, state: action === "close" ? "closed" : "open" });
    ok(`#${item.number} is ${action === "close" ? "closed" : "open again"}`);
    return;
  }
  if (kind === "pr" && (action === "fetch" || action === "merge")) {
    const pr = item.pr!;
    const from = `sol://${pr.from.owner}/${pr.from.name}`;
    const run = (args: string[]) => { const r = spawnSync("git", args, { stdio: "inherit" }); if (r.status !== 0) throw new Error(`git ${args[0]} did not succeed`); };
    if (action === "fetch") {
      run(["fetch", from, `+${pr.from.ref}:refs/heads/pr-${item.number}`]);
      ok(`#${item.number} is here as the branch pr-${item.number}`);
      return;
    }
    if (signerOf(who).address !== target.owner) throw new Error("a pull request is merged by the repository's owner");
    if (item.state !== "open") throw new Error(`#${item.number} is ${item.state}`);
    const into = pr.into.replace("refs/heads/", "");
    if (gitText(["rev-parse", "--abbrev-ref", "HEAD"]) !== into) throw new Error(`check out ${into} first (git switch ${into}): that is the branch #${item.number} goes into`);
    if (gitText(["status", "--porcelain"])) throw new Error("there are changes here that are not committed: commit or stash them first");
    const remote = ["upstream", "origin"].find((r) => { const u = gitText(["remote", "get-url", r]); return !!u && u.startsWith("sol://") && parseUrl(u).name === target.name; });
    if (!remote) throw new Error(`this directory has no remote for ${target.url}`);
    run(["fetch", from, pr.from.ref]);
    if (spawnSync("git", ["cat-file", "-e", pr.from.id]).status !== 0) throw new Error(`the commit the pull request names (${pr.from.id.slice(0, 10)}) is not in ${from} any more`);
    run(["merge", "--no-ff", "-m", `Merge pull request #${item.number}: ${item.title}`, pr.from.id]);
    run(["push", remote, into]);
    await post({ t: "state", on: item.id, state: "merged", id: gitText(["rev-parse", "HEAD"]) ?? undefined });
    ok(`#${item.number} is merged into ${into}`);
    return;
  }
  throw new UsageError(`chainboot git ${kind} knows: list, new, show, comment, close${kind === "pr" ? ", fetch, merge" : ", reopen"}`);
}

// ---- sharing a private repository: its key, sent to the other wallet's share address

interface GitShare { chainboot: 1; kind: "git-share"; owner: string; name: string; key: string; time: number; note?: string }
const inboxTag = (sharePublicKey: Uint8Array) => tagAddress("inbox", sharePublicKey);

async function cmdShare(c: Config, a: Args): Promise<void> {
  const name = a._[1], to = flag(a, "with");
  if (!name || !to) throw new UsageError("chainboot git share <name> --with <share address>   (the receiver finds theirs with: chainboot whoami)");
  const v = loadVault(paths.vault(), c.cluster);
  if (!v) throw new Error("sharing a private repository is done by the wallet that owns it: chainboot login");
  const store = await openStore(c, info);
  const repo = await readRepo(store, v.signer.address, name, repoKey(v, name));
  if (!repo) throw new Error(`you have no repository named ${name}`);
  if (!repo.index.private) throw new Error(`${name} is public: everybody can read it already (sol://${v.signer.address}/${name})`);
  const record: GitShare = { chainboot: 1, kind: "git-share", owner: v.signer.address, name, key: repoKey(v, name).toString("base64"), time: Math.floor(Date.now() / 1000), ...(flag(a, "note") && { note: flag(a, "note")!.slice(0, 300) }) };
  const receiver = parseShareAddress(to);
  await store.putPointer(v.signer, inboxTag(receiver), sealTo(receiver, shareKeys(v), Buffer.from(JSON.stringify(record), "utf8"), "git-share"));
  ok(`${to.slice(0, 14)}… can now read ${bold(name)}, also what you push later. This cannot be taken back.`);
  info(dim("They run: chainboot git shared"));
}

async function cmdShared(c: Config, a: Args): Promise<void> {
  const v = loadVault(paths.vault(), c.cluster);
  if (!v) throw new Error("shares arrive at a wallet: sign in first (chainboot login)");
  const store = await openStore(c, info);
  const mine = shareKeys(v);
  const got: { from: string; r: GitShare; arrived: number | null }[] = [];
  for (const p of await store.listPointers(inboxTag(mine.publicKey), { limit: 200 })) {
    const o = openFrom(mine, p.payload, "git-share");
    if (!o) continue;
    try {
      const r = JSON.parse(o.plain.toString("utf8")) as GitShare;
      if (r.kind !== "git-share" || typeof r.name !== "string" || typeof r.key !== "string" || Buffer.from(r.key, "base64").length !== 32) continue;
      checkRepoName(r.name); addressToBytes(r.owner);
      if (!got.some((g) => g.r.owner === r.owner && g.r.name === r.name)) got.push({ from: shareAddress(o.sender), r, arrived: p.blockTime });
    } catch { /* not a record we understand */ }
  }
  got.reverse();
  if (a._[1] === "accept") {
    const g = got[Number(a._[2]) - 1];
    if (!g) throw new UsageError("say which one, by its number in: chainboot git shared");
    // the key must open what it claims to open, before it is kept
    if (!(await readRepo(store, g.r.owner, g.r.name, Buffer.from(g.r.key, "base64")))) throw new Error("that repository is not on chain");
    saveSharedKey(g.r.owner, g.r.name, g.r.key);
    ok(`you can read ${bold(g.r.name)} now`);
    out(`git clone sol://${g.r.owner}/${g.r.name}`);
    return;
  }
  if (!got.length) { info("Nobody has shared a repository with you."); return; }
  out(table(got.map((g, i) => [String(i + 1), bold(g.r.name), short(g.r.owner), g.from.slice(0, 16) + "…", day(g.arrived), g.r.note ?? ""]), ["", "repository", "owner", "from", "arrived", "note"]));
  info(dim("Keep one with: chainboot git shared accept <number>"));
}

export async function cmdGit(a: Args): Promise<void> {
  const c = loadConfig();
  const sub = a._[0];
  if (sub === "create") return cmdCreate(c, a);
  if (sub === "list") return cmdList(c, a);
  if (sub === "info") return cmdInfo(c, a);
  if (sub === "issue" || sub === "issues") return cmdTalk(c, a, "issue");
  if (sub === "pr" || sub === "prs") return cmdTalk(c, a, "pr");
  if (sub === "share") return cmdShare(c, a);
  if (sub === "shared") return cmdShared(c, a);
  throw new UsageError(sub ? `chainboot git does not know "${sub}"` : "chainboot git needs to know what to do: create, list, info, issue, pr, share, shared");
}

/** What git starts for a sol:// remote (through the git-remote-sol command). */
export async function cmdGitRemote(a: Args): Promise<void> {
  const [remote, url] = a._;
  if (!remote || !url) throw new UsageError("this command is started by git, not by people: git clone sol://<owner>/<name>");
  await remoteHelper(remote, url);
}
