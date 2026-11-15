import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { Keypair } from "../src/solana/keys.ts";
import { RpcPool } from "../src/solana/rpc.ts";
import { vaultFromKeypair } from "../src/state/vault.ts";
import { ChainStore } from "../src/store/store.ts";
import { fetchPacks, parseUrl, push } from "../src/git/helper.ts";
import { Objects, asText, diffLines, inflateAt } from "../src/git/pack.ts";
import { emptyIndex, getPack, putPack, readRepo, repoKey, writeRepo, PrivateRepoError } from "../src/git/repo.ts";
import { cleanRecord, postTalk, readTalk } from "../src/git/talk.ts";
import { FakeChain } from "./helpers/fakechain.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-git-"));
const haveGit = (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" }, maxBuffer: 1 << 28 });
const fake = () => { const chain = new FakeChain(); return { chain, store: new ChainStore(new RpcPool(chain.urls(3), { fetch: chain.fetch, initialRate: 500 })) }; };

test("inflate: every kind of block, and where the stream ends", () => {
  const samples = [Buffer.alloc(0), Buffer.from("a"), Buffer.from("hello hello hello hello hello hello\n".repeat(400)), crypto.randomBytes(70_000),
    Buffer.concat([crypto.randomBytes(3000), Buffer.alloc(40_000, 7), Buffer.from("x".repeat(9000))])];
  for (const data of samples) {
    for (const opts of [{ level: 0 }, { level: 1 }, { level: 9 }, { level: 6, strategy: zlib.constants.Z_FIXED }, { level: 6, strategy: zlib.constants.Z_HUFFMAN_ONLY }]) {
      const packed = zlib.deflateSync(data, opts);
      const padded = Buffer.concat([Buffer.from([1, 2, 3]), packed, Buffer.from("trailing bytes")]);
      const got = inflateAt(padded, 3);
      assert.deepEqual(Buffer.from(got.data), data);
      assert.equal(got.end, 3 + packed.length, "the end of the stream is found");
    }
  }
  assert.throws(() => inflateAt(Buffer.from([0x78, 0x9c, 0xff, 0xff]), 0));
});

test("pack reader: the same objects, history and directories as git itself", { skip: !haveGit }, async () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main", ".");
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${crypto.randomBytes(6).toString("hex")}`);
  for (let n = 0; n < 12; n++) {
    big[n * 200] = `changed in commit ${n}`;
    fs.writeFileSync(path.join(dir, "big.txt"), big.join("\n") + "\n");
    fs.mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "deep", `f${n}.rs`), `fn f${n}() {}\n`);
    fs.writeFileSync(path.join(dir, "bin.dat"), crypto.randomBytes(5000));
    if (n === 5) fs.symlinkSync("big.txt", path.join(dir, "link"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `commit ${n}\n\nbody of ${n}`);
  }
  git(dir, "tag", "-a", "v1", "-m", "a tag with a message");
  git(dir, "repack", "-a", "-d", "-q", "--depth=50", "--window=50");
  const packDir = path.join(dir, ".git", "objects", "pack");
  const objects = new Objects();
  for (const f of fs.readdirSync(packDir).filter((x) => x.endsWith(".pack"))) await objects.addPack(fs.readFileSync(path.join(packDir, f)));

  const listed = git(dir, "rev-list", "--objects", "--all").toString().trim().split("\n").map((l) => l.split(" ")[0]!);
  assert.ok(listed.length > 60);
  for (const id of listed) {
    const o = objects.get(id);
    assert.ok(o, `object ${id} was read`);
    assert.deepEqual(Buffer.from(o.data), git(dir, "cat-file", o.type, id), `object ${id} has git's content`);
  }
  const head = git(dir, "rev-parse", "HEAD").toString().trim();
  assert.equal(objects.peel(git(dir, "rev-parse", "v1").toString().trim()), head, "an annotated tag leads to its commit");
  assert.deepEqual(objects.log(head).map((c) => c.id), git(dir, "log", "--format=%H").toString().trim().split("\n"));
  assert.equal(objects.commit(head).subject, "commit 11");
  assert.equal(objects.commit(head).message, "commit 11\n\nbody of 11\n");
  const root = objects.at(head, "");
  assert.ok(root && root.kind === "tree");
  assert.deepEqual(root.entries.map((e) => `${e.mode.padStart(6, "0")} ${e.id} ${e.name}`), git(dir, "ls-tree", "HEAD").toString().trim().split("\n").map((l) => { const m = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/.exec(l)!; return `${m[1]} ${m[2]} ${m[3]}`; }));
  const file = objects.at(head, "src/deep/f3.rs");
  assert.ok(file && file.kind === "blob");
  assert.equal(asText(objects.blob(file.id)), "fn f3() {}\n");
  assert.equal(objects.at(head, "link")?.kind, "link");
  assert.equal(objects.at(head, "nothing/here"), null);
  assert.equal(asText(objects.blob((objects.at(head, "bin.dat") as { id: string }).id)), null, "random bytes are not text");

  const c = objects.commit(head), parent = objects.commit(c.parents[0]!);
  const changes = objects.changes(parent.tree, c.tree);
  assert.deepEqual(changes.map((x) => `${x.kind} ${x.path}`).sort(), ["added src/deep/f11.rs", "changed big.txt", "changed bin.dat"]);
  const bigChange = changes.find((x) => x.path === "big.txt")!;
  const d = diffLines(asText(objects.blob(bigChange.before!))!, asText(objects.blob(bigChange.after!))!)!;
  assert.deepEqual(d.filter((l) => l.kind !== " ").map((l) => l.kind), ["-", "+"]);
  assert.equal(d.find((l) => l.kind === "+")!.text, "changed in commit 11");
  assert.equal(d.length, 8, "one line changed, three lines of context on each side");
});

test("diff: additions, removals, both ends", () => {
  const lines = (d: ReturnType<typeof diffLines>) => d!.map((l) => l.kind + l.text);
  assert.deepEqual(lines(diffLines("", "a\nb\n")), ["+a", "+b"]);
  assert.deepEqual(lines(diffLines("a\nb\n", "")), ["-a", "-b"]);
  assert.deepEqual(lines(diffLines("a\nb\nc\n", "a\nc\n")), [" a", "-b", " c"]);
  assert.deepEqual(lines(diffLines("a\n", "a\n")), []);
  assert.deepEqual(lines(diffLines("1\n2\n3\n4\n5\n6\n7\n8\n9\n", "1\n2\n3\n4\nX\n6\n7\n8\n9\n", 1)), [" 4", "-5", "+X", " 6"]);
});

test("repositories: public and private, read back and refused", async () => {
  const { store } = fake();
  const owner = Keypair.generate(), vault = vaultFromKeypair(Keypair.generate(), "devnet");
  assert.equal(await readRepo(store, owner.address, "none"), null);

  const index = emptyIndex("demo", { private: false, description: "a demo" });
  const pack = crypto.randomBytes(5000);
  index.packs.push(await putPack(store, owner, pack, 7, undefined, { pollMs: 20 }));
  index.refs["refs/heads/main"] = "ab".repeat(20);
  await writeRepo(store, owner, index, undefined, { pollMs: 20 });
  const back = await readRepo(store, owner.address, "demo");
  assert.equal(back!.index.description, "a demo");
  assert.deepEqual(back!.index.refs, { "refs/heads/main": "ab".repeat(20) });
  assert.deepEqual(await getPack(store, back!.index.packs[0]!), pack);
  assert.equal(back!.index.packs[0]!.objects, 7);

  const key = repoKey(vault, "secret");
  const hidden = emptyIndex("secret", { private: true });
  hidden.packs.push(await putPack(store, vault.signer, pack, 1, key, { pollMs: 20 }));
  await writeRepo(store, vault.signer, hidden, key, { pollMs: 20 });
  await assert.rejects(readRepo(store, vault.signer.address, "secret"), PrivateRepoError);
  await assert.rejects(readRepo(store, vault.signer.address, "secret", repoKey(vault, "other")), /does not open/);
  const opened = await readRepo(store, vault.signer.address, "secret", key);
  assert.equal(opened!.index.private, true);
  assert.notDeepEqual(await getPack(store, opened!.index.packs[0]!), pack, "what is on chain is not the pack itself");
  assert.deepEqual(await getPack(store, opened!.index.packs[0]!, key), pack);
  await assert.rejects(writeRepo(store, vault.signer, hidden, undefined), /without its key/);

  assert.deepEqual(parseUrl("sol://me/notes.git"), { owner: "me", name: "notes" });
  assert.throws(() => parseUrl("https://example.com/x/y"), /not a repository address/);
  assert.throws(() => parseUrl("sol://me/..bad"), /cannot be a repository name/);
});

test("push and fetch with git itself: fast-forward, refused, forced, deleted", { skip: !haveGit }, async () => {
  const { store } = fake();
  const home = tmp();
  process.env.CHAINBOOT_HOME = home;
  const keyFile = path.join(home, "key.json"), owner = Keypair.generate();
  fs.writeFileSync(keyFile, JSON.stringify([...owner.secretKey()]));
  const config = { cluster: "devnet", rpcs: {}, publishers: {} } as Parameters<typeof push>[1];
  const target = { owner: owner.address, name: "work" };

  const a = tmp();
  git(a, "init", "-q", "-b", "main", ".");
  fs.writeFileSync(path.join(a, "one.txt"), "one\n"); git(a, "add", "-A"); git(a, "commit", "-q", "-m", "one");
  const gitDirA = path.join(a, ".git");
  // a public repository is not made by a push
  await assert.rejects(push(store, config, target, [{ force: false, src: "refs/heads/main", dst: "refs/heads/main" }], gitDirA, null, keyFile), /does not exist yet/);
  await writeRepo(store, owner, emptyIndex("work", { private: false }), undefined, { pollMs: 20 });
  assert.deepEqual(await push(store, config, target, [{ force: false, src: "refs/heads/main", dst: "refs/heads/main" }], gitDirA, null, keyFile), [{ dst: "refs/heads/main" }]);

  // a second clone gets it, adds to it, pushes
  const b = tmp();
  git(b, "init", "-q", "-b", "main", ".");
  const gitDirB = path.join(b, ".git");
  let repo = (await readRepo(store, owner.address, "work"))!;
  assert.equal(await fetchPacks(store, repo, undefined, gitDirB), 1);
  assert.equal(await fetchPacks(store, repo, undefined, gitDirB), 0, "a pack is fetched once");
  git(b, "reset", "-q", "--hard", repo.index.refs["refs/heads/main"]!);
  assert.equal(fs.readFileSync(path.join(b, "one.txt"), "utf8"), "one\n");
  fs.writeFileSync(path.join(b, "two.txt"), "two\n"); git(b, "add", "-A"); git(b, "commit", "-q", "-m", "two");
  assert.deepEqual(await push(store, config, target, [{ force: false, src: "refs/heads/main", dst: "refs/heads/main" }], gitDirB, null, keyFile), [{ dst: "refs/heads/main" }]);

  // the first clone has diverged: refused until it has the other commit, and refused as not fast-forward after
  fs.writeFileSync(path.join(a, "three.txt"), "three\n"); git(a, "add", "-A"); git(a, "commit", "-q", "-m", "three");
  assert.deepEqual(await push(store, config, target, [{ force: false, src: "refs/heads/main", dst: "refs/heads/main" }], gitDirA, null, keyFile), [{ dst: "refs/heads/main", error: "fetch first" }]);
  repo = (await readRepo(store, owner.address, "work"))!;
  await fetchPacks(store, repo, undefined, gitDirA);
  assert.deepEqual(await push(store, config, target, [{ force: false, src: "refs/heads/main", dst: "refs/heads/main" }], gitDirA, null, keyFile), [{ dst: "refs/heads/main", error: "non-fast-forward" }]);
  assert.deepEqual(await push(store, config, target, [{ force: true, src: "refs/heads/main", dst: "refs/heads/main" }, { force: false, src: "refs/heads/main", dst: "refs/heads/copy" }], gitDirA, null, keyFile), [{ dst: "refs/heads/main" }, { dst: "refs/heads/copy" }]);
  repo = (await readRepo(store, owner.address, "work"))!;
  assert.equal(repo.index.refs["refs/heads/main"], git(a, "rev-parse", "HEAD").toString().trim());
  assert.deepEqual(await push(store, config, target, [{ force: false, src: "", dst: "refs/heads/copy" }, { force: false, src: "", dst: "refs/heads/never" }], gitDirA, null, keyFile), [{ dst: "refs/heads/copy" }, { dst: "refs/heads/never", error: "there is no such branch" }]);
  assert.deepEqual(Object.keys((await readRepo(store, owner.address, "work"))!.index.refs), ["refs/heads/main"]);

  // somebody else's key cannot push there
  const stranger = path.join(home, "stranger.json");
  fs.writeFileSync(stranger, JSON.stringify([...Keypair.generate().secretKey()]));
  await assert.rejects(push(store, config, target, [{ force: true, src: "refs/heads/main", dst: "refs/heads/main" }], gitDirA, null, stranger), /belongs to/);

  // the signed-in wallet's first push makes a private repository, which only its key reads
  const vault = vaultFromKeypair(Keypair.generate(), "devnet");
  const mine = { owner: vault.signer.address, name: "notes" };
  assert.deepEqual(await push(store, config, mine, [{ force: false, src: "refs/heads/main", dst: "refs/heads/main" }], gitDirA, vault), [{ dst: "refs/heads/main" }]);
  await assert.rejects(readRepo(store, mine.owner, "notes"), PrivateRepoError);
  const c = tmp();
  git(c, "init", "-q", "-b", "main", ".");
  const priv = (await readRepo(store, mine.owner, "notes", repoKey(vault, "notes")))!;
  await fetchPacks(store, priv, repoKey(vault, "notes"), path.join(c, ".git"));
  git(c, "reset", "-q", "--hard", priv.index.refs["refs/heads/main"]!);
  assert.equal(fs.readFileSync(path.join(c, "three.txt"), "utf8"), "three\n");
  delete process.env.CHAINBOOT_HOME;
});

test("issues and pull requests: numbers, comments, who may close and merge", async () => {
  const { store } = fake();
  const owner = Keypair.generate(), ann = Keypair.generate(), bob = Keypair.generate();
  const o = owner.address;
  const issue = await postTalk(store, ann, o, "demo", { t: "issue", title: "It does not start", body: "line one\nline two" });
  const long = "long text ".repeat(900);
  const pr = await postTalk(store, bob, o, "demo", { t: "pr", title: "Fix the start", body: long, from: { owner: bob.address, name: "demo", ref: "refs/heads/fix", id: "cd".repeat(20) }, into: "refs/heads/main" });
  await postTalk(store, owner, o, "demo", { t: "comment", on: issue, body: "Thank you." });
  await postTalk(store, bob, o, "demo", { t: "state", on: issue, state: "closed" });                 // not his issue, not his repository
  await postTalk(store, bob, o, "demo", { t: "state", on: pr, state: "merged", id: "ef".repeat(20) });   // an author cannot merge
  await postTalk(store, ann, o, "other", { t: "issue", title: "In another repository", body: "" });
  let items = await readTalk(store, o, "demo");
  assert.deepEqual(items.map((i) => [i.number, i.kind, i.title, i.state, i.comments.length]), [[1, "issue", "It does not start", "open", 1], [2, "pr", "Fix the start", "open", 0]]);
  assert.equal(items[0]!.body, "line one\nline two");
  assert.equal(items[0]!.author, ann.address);
  assert.equal(items[1]!.body, long, "a text too long for one transaction comes back whole");
  assert.equal(items[1]!.pr!.from.owner, bob.address);

  await postTalk(store, ann, o, "demo", { t: "state", on: issue, state: "closed" });                  // her own issue
  await postTalk(store, owner, o, "demo", { t: "state", on: pr, state: "merged", id: "ef".repeat(20) });
  items = await readTalk(store, o, "demo");
  assert.deepEqual(items.map((i) => i.state), ["closed", "merged"]);
  assert.equal(items[1]!.pr!.merged, "ef".repeat(20));
  await postTalk(store, owner, o, "demo", { t: "state", on: issue, state: "open" });
  assert.equal((await readTalk(store, o, "demo"))[0]!.state, "open");

  // a private repository's records are unreadable without its key
  const key = crypto.randomBytes(32);
  await postTalk(store, ann, o, "hidden", { t: "issue", title: "secret", body: "" }, key);
  assert.equal((await readTalk(store, o, "hidden")).length, 0);
  assert.equal((await readTalk(store, o, "hidden", key))[0]!.title, "secret");

  assert.equal(cleanRecord({ t: "issue", title: "  ", body: "x" }), null);
  assert.equal(cleanRecord({ t: "comment", on: "not a signature", body: "x" }), null);
  assert.equal((cleanRecord({ t: "issue", title: "a\u0007b\nc", body: "x\u0000y\r\nz" }) as { title: string; body: string }).title, "a b c");
  await assert.rejects(postTalk(store, ann, o, "demo", { t: "issue", title: "", body: "" }), /need a title/);
});
