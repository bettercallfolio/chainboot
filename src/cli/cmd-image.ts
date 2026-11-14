import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { buildImage } from "../image/build.ts";
import { decompressAuto, readTar } from "../image/tar.ts";
import { serializeManifest, type ImageManifest } from "../image/manifest.ts";
import { hostArch, loadConfig, openStore, paths, removePublisherName, resolvePublisher, resolveSource, savePublisherName, type Config, type Source, networkLabel } from "../local/home.ts";
import { isList, parseList, readList, type ListView } from "../registry/lists.ts";
import { endorseImage, parseImageName, publishImage, pullImage, pullManifest, readCatalog, unlistImage, type Catalog, type ImageRef, type PulledImage, type StoredRef } from "../registry/registry.ts";
import { publishPrivateImage, readPrivateCatalog, unlistPrivateImage } from "../registry/private.ts";
import { Keypair } from "../solana/keys.ts";
import { loadVault, type Vault } from "../state/vault.ts";
import { ChainStore } from "../store/store.ts";
import { fmtBytes, sha256, toHex } from "../util/bytes.ts";
import { UsageError, flag, flags, has, type Args } from "./args.ts";
import { ProgressLine, bold, dim, info, ok, out, table, warn } from "./term.ts";

const note = (t: string) => info(dim(t));

export function loadKeypair(a: Args): Keypair {
  const file = flag(a, "keypair") ?? process.env.CHAINBOOT_KEYPAIR ?? path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(file)) throw new Error(`no keypair found at ${file}. Pass one with --keypair <file> (create it with: chainboot keygen <file>)`);
  return Keypair.fromFile(file);
}

export async function confirm(question: string, a: Args): Promise<boolean> {
  if (has(a, "yes")) return true;
  if (!process.stdin.isTTY) throw new Error("this needs a confirmation; run it again with --yes");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

/** Finds an image in a publisher's catalog for the wanted architecture. */
export async function resolveImage(store: ChainStore, c: Config, text: string, arch: string): Promise<{ publisher: string; name: string; tag: string; ref: ImageRef; private: boolean }> {
  const n = parseImageName(text);
  // "me/<image>" names a private image of the signed-in wallet
  const mine = n.publisher === PRIVATE_PREFIX;
  const vault = mine ? requireLogin(c) : null;
  const source = vault ? null : resolveSource(c, n.publisher);
  const publisher = vault ? vault.signer.address : source!.kind === "publisher" ? source!.address : "";
  const cat = vault ? await readPrivateCatalog(store, vault) : await readSource(store, source!);
  const image = cat.images[n.name];
  if (!image) {
    const names = Object.keys(cat.images);
    if (mine) throw new Error(`you have no private image named "${n.name}".` + (names.length ? ` Yours: ${names.join(", ")}` : " Publish one with: chainboot publish <archive> --name <name> --version <version>"));
    if (source!.kind === "list") {
      const waiting = (cat as ListCatalog).view.waiting.filter((w) => w.name === n.name);
      throw new Error(`image "${n.name}" is not in the list ${source!.label}.` + (waiting.length ? ` ${waiting[0]!.agreed.length} of its ${source!.spec.members.length} publishers have it; ${source!.spec.threshold} must agree.` : names.length ? ` Available: ${names.join(", ")}` : " Its publishers agree on no image yet."));
    }
    throw new Error(`image "${n.name}" was not found in the catalog of ${publisher}.` + (names.length ? ` Available: ${names.join(", ")}` : " That publisher has no images on this network."));
  }
  const tag = image.tags[n.tag];
  if (!tag) throw new Error(`image "${n.name}" has no tag "${n.tag}". Available: ${Object.keys(image.tags).join(", ")}`);
  const ref = tag[arch];
  if (!ref) throw new Error(`image "${n.name}:${n.tag}" is not published for ${arch}. Available: ${Object.keys(tag).join(", ")}`);
  // an entry may name the account that stored the image (a shared image, an endorsed one, a list's)
  return { publisher: ref.publisher ?? publisher, name: n.name, tag: n.tag, ref, private: mine };
}

type ListCatalog = Pick<Catalog, "images"> & { view: ListView };

/** The images of a source, shaped like a catalog: a publisher's own, or what a list's publishers agree on. */
export async function readSource(store: ChainStore, source: Source): Promise<Pick<Catalog, "images"> | ListCatalog> {
  const cache = path.join(paths.cache(), "objects");
  if (source.kind === "publisher") return readCatalog(store, source.address, cache);
  const view = await readList(store, source.spec, cache);
  return { images: view.images, view };
}

/** Publisher part of the name of a private image: `chainboot run me/<image>`. */
export const PRIVATE_PREFIX = "me";

export function requireLogin(c: Config): Vault {
  const v = loadVault(paths.vault(), c.cluster);
  if (!v) throw new Error(`private images belong to a wallet, and you are not signed in on ${networkLabel(c)}. Sign in first: chainboot login`);
  return v;
}

/** Downloads an image into the local cache (or finds it there) with a progress line. */
export async function pull(store: ChainStore, publisher: string, ref: StoredRef & { digest: string; private?: boolean; publisher?: string; key?: string }, label: string): Promise<PulledImage> {
  const line = new ProgressLine();
  line.start(`Downloading ${label}`);
  const pulled = await pullImage(store, publisher, ref, {
    // an image that was shared opens with the key that came with it; the wallet's own needs its login
    cacheDir: paths.cache(), vault: ref.private && !ref.key ? requireLogin(loadConfig()) : ref.private ? loadVault(paths.vault(), loadConfig().cluster) ?? undefined : undefined,
    onProgress: (p) => { if (p.phase === "download") line.update(p.done, p.total); },
  });
  line.done(`${label} is ready (${fmtBytes(ref.size + pulled.manifest.packs.reduce((n, p) => n + p.size, 0))} verified)`);
  const dir = path.join(paths.images(), pulled.manifest.digest);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), serializeManifest(pulled.manifest));
  fs.writeFileSync(path.join(dir, "origin.json"), JSON.stringify({ publisher, ref }, null, 2));
  return pulled;
}

/** Fetches only the list of an image's files (for a lazy machine, which gets the contents when they are read). */
export async function pullList(store: ChainStore, publisher: string, ref: StoredRef & { digest: string; private?: boolean; publisher?: string; key?: string }, label: string): Promise<ImageManifest> {
  const manifest = await pullManifest(store, publisher, ref, { cacheDir: paths.cache(), vault: ref.private ? loadVault(paths.vault(), loadConfig().cluster) ?? undefined : undefined });
  const dir = path.join(paths.images(), manifest.digest);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), serializeManifest(manifest));
  fs.writeFileSync(path.join(dir, "origin.json"), JSON.stringify({ publisher, ref }, null, 2));
  info(dim(`${label}: ${manifest.tree.length} entries listed; their contents are fetched as they are read`));
  return manifest;
}

export const PUBLISH_HELP = `Usage:
  chainboot publish <rootfs.tar[.gz|.xz|.zst]> --name <name> --version <version> [options]

Puts a root file system on chain.

By default the image is PRIVATE: encrypted with your wallet's key, listed only in your private
catalog and paid by your vault (sign in first with "chainboot login"). Run it with
"chainboot run me/<name>". Data on a ledger can never be erased, so making a system readable
by everyone is a choice you state explicitly with --public.

Options:
  --arch <arch>          Architecture of the system (default: this computer's, ${hostArch()})
  --tag <tag>            Tag to publish under; repeatable (default: the version and "latest")
  --description <text>   One line shown in "chainboot list"
  --source-url <url>     Where the archive came from (recorded so others can verify it)
  --reuse <image>        Do not store files again that <image> already has on chain; repeatable
  --lazy                 Store the files in many small packs, by directory, so that a lazy machine
                         (chainboot run <image> --lazy) fetches only what it opens. The image
                         gets somewhat larger; everybody can still run it the ordinary way.
  --start-files <file>   With --lazy: a list of the files a start of the system reads (one path per
                         line). They are stored first and fetched ahead, so a lazy machine starts
                         without waiting. A lazy machine writes such a list when it stops:
                         ~/.chainboot/machines/<name>/lazy-files.txt
  --cmd <command>        Command started by "chainboot run" (default: a root login shell)
  --public               Publish for everyone, unencrypted, in the public catalog of --keypair.
                         Others run it with: chainboot run <your-address>/<name>
  --keypair <file>       With --public: the Solana keypair that pays and becomes the publisher
  --private              The default, accepted for clarity
  --dry-run              Build and show the cost, but send nothing
  --yes                  Do not ask for confirmation`;

export async function cmdPublish(a: Args): Promise<void> {
  const file = a._[0], name = flag(a, "name"), version = flag(a, "version");
  if (!file || !name || !version) throw new UsageError("publish needs an archive, --name and --version");
  const arch = flag(a, "arch") ?? hostArch();
  const c = loadConfig();
  const isPublic = has(a, "public");
  if (isPublic && has(a, "private")) throw new UsageError("choose one of --public and --private");
  if (!isPublic && flag(a, "keypair")) {
    throw new UsageError("images are private by default and are paid by your vault, not by a keypair. To publish for everyone, say so: add --public. For a private image, leave out --keypair.");
  }
  // a private dry run works without a login; a real private upload needs one
  const vault = isPublic ? null : has(a, "dry-run") ? loadVault(paths.vault(), c.cluster) : requireLogin(c);
  const payer = vault ? vault.signer : has(a, "dry-run") && !flag(a, "keypair") && !process.env.CHAINBOOT_KEYPAIR ? null : loadKeypair(a);
  info(`Reading ${file}`);
  const packed = fs.readFileSync(file);
  const entries = readTar(decompressAuto(packed));
  const store = has(a, "dry-run") && !flags(a, "reuse").length ? null : await openStore(c, note);
  const reuse: ImageManifest[] = [];
  for (const r of flags(a, "reuse")) {
    const found = await resolveImage(store!, c, r, arch);
    const pulled = await pull(store!, found.publisher, { ...found.ref, private: found.private }, r);
    // what the other image says it holds is checked before any file is left out because "it is already there"
    for (let i = 0; i < pulled.manifest.packs.length; i++) pulled.pack(i);
    reuse.push(pulled.manifest);
  }
  const cmd = flag(a, "cmd");
  let startFiles: string[] | undefined;
  if (flag(a, "start-files")) {
    try { startFiles = fs.readFileSync(flag(a, "start-files")!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean); } catch (e) { throw new Error(`could not read the list of start files: ${(e as Error).message}`); }
  }
  const built = buildImage(entries, {
    name, version, arch, description: flag(a, "description"),
    source: { ...(flag(a, "source-url") && { url: flag(a, "source-url") }), sha256: toHex(sha256(packed)) },
    ...(cmd && { config: { cmd: ["/bin/sh", "-c", cmd] } }),
  }, { reuse, onProgress: note, ...((has(a, "lazy") || startFiles) && { layout: "lazy" as const }), ...(startFiles && { startFiles }) });
  const m = built.manifest;
  const manifestBytes = serializeManifest(m).length;
  const newBytes = [...built.newPacks.values()].reduce((n, b) => n + b.length, 0);
  const perTx = 5000 + (c.priorityFeeLamports ?? 0);
  let tx = ChainStore.plan(Math.ceil(manifestBytes / 4), store?.defaults).transactions + 3; // manifest compresses about 4x; catalog + pointer
  for (const b of built.newPacks.values()) tx += ChainStore.plan(b.length, store?.defaults).transactions;
  out(table([
    ["image", `${bold(m.name)}:${m.version} (${m.arch})`],
    ["visibility", isPublic ? "PUBLIC: everyone can read it, forever" : "private: encrypted, only your wallet can read it"],
    ["digest", m.digest],
    ["contents", `${m.fileCount} entries, ${fmtBytes(m.rawSize)} unpacked`],
    ["to upload", `${fmtBytes(newBytes)} in ${built.newPacks.size} pack(s)` + (reuse.length ? dim(` (${m.packs.length - built.newPacks.size} pack(s) reused)`) : "")],
    ["transactions", `about ${tx}`],
    ["cost", `about ${((tx * perTx) / 1e9).toFixed(tx * perTx < 1e6 ? 6 : 4)} SOL on ${networkLabel(c)}` + (c.priorityFeeLamports ? dim(` (includes a tip of ${c.priorityFeeLamports} lamports per transaction)`) : "")],
  ]));
  if (has(a, "dry-run")) { info(dim("dry run: nothing was sent")); return; }
  const balance = (await store!.pool.call<{ value: number }>("getBalance", [payer!.address])).value;
  info(`${vault ? "Your vault" : "Publisher"} ${payer!.address} holds ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < tx * perTx) throw new Error(`not enough SOL for this upload (about ${((tx * perTx) / 1e9).toFixed(4)} SOL needed)` + (vault ? ". Add SOL to your vault with: chainboot fund <amount>" : ""));
  if (!(await confirm(isPublic ? "Publish for everyone? It can never be erased from the ledger." : "Publish privately now?", a))) { info("cancelled"); return; }
  const line = new ProgressLine();
  const options = {
    tags: flags(a, "tag").length ? flags(a, "tag") : undefined,
    journalDir: paths.journals(),
    onProgress: (p: { phase: string; done: number; total: number; detail?: string }) => line.update(p.done, p.total, "count", `Uploading ${p.phase}${p.detail && p.detail !== "data" ? ` (${p.detail})` : ""}`),
  };
  if (vault) {
    await publishPrivateImage(store!, vault, built, options);
    line.done(`published ${m.name}:${m.version} (${m.arch}) privately`);
    out(table([["readable by", `wallet ${vault.wallet} only`], ["run it with", `chainboot run ${PRIVATE_PREFIX}/${m.name}`]]));
    return;
  }
  const ref = await publishImage(store!, payer!, built, options);
  line.done(`published ${m.name}:${m.version} (${m.arch})`);
  out(table([["manifest", ref.sig], ["publisher", payer!.address], ["run it with", `chainboot run ${payer!.address === resolvePublisherSafe(c) ? "" : payer!.address + "/"}${m.name}`]]));
}

function resolvePublisherSafe(c: Config): string | null {
  try { return resolvePublisher(c, undefined); } catch { return null; }
}

export const LIST_HELP = `Usage:
  chainboot list [publisher]     Show the images a publisher offers (default: the official catalog)
  chainboot list me              Show your private images (needs "chainboot login")`;

export async function cmdList(a: Args): Promise<void> {
  const c = loadConfig();
  const mine = a._[0] === PRIVATE_PREFIX;
  const vault = mine ? requireLogin(c) : null;
  const source = vault ? null : resolveSource(c, a._[0]);
  const publisher = vault ? `wallet ${vault.wallet} (private)` : source!.label;
  const store = await openStore(c, note);
  const cat = vault ? await readPrivateCatalog(store, vault) : await readSource(store, source!);
  const view: ListView | null = "view" in cat ? (cat as ListCatalog).view : null;
  const rows: string[][] = [];
  for (const [name, image] of Object.entries(cat.images).sort()) {
    for (const [tag, arches] of Object.entries(image.tags).sort()) {
      for (const [arch, ref] of Object.entries(arches).sort()) {
        rows.push([bold(name), tag, arch, fmtBytes(ref.downloadSize), fmtBytes(ref.unpackedSize), ...(view ? [`${(ref as ListView["images"][string]["tags"][string][string]).agreed.length} of ${view.spec.members.length}`] : []), image.description ?? ""]);
      }
    }
  }
  if (view) {
    info(`List ${bold(publisher)} on ${networkLabel(c)}: an image counts when ${view.spec.threshold} of these ${view.spec.members.length} publishers have it.`);
    out(table(view.members.map((m) => [m.address, m.ok ? `${m.images} image(s)` : `could not be read: ${m.error}`]), ["publisher", "catalog"]));
  }
  if (!rows.length) { info(mine ? `You have no private images on ${networkLabel(c)}. Publish one with: chainboot publish <archive> --name <name> --version <version>` : view ? "Its publishers agree on no image yet." : `${publisher} has not published any images on ${networkLabel(c)}.`); }
  else out(table(rows, ["image", "tag", "arch", "download", "on disk", ...(view ? ["agreed"] : []), "description"]));
  if (view?.waiting.length) {
    info(dim("Waiting for more publishers to agree:"));
    out(table(view.waiting.slice(0, 12).map((w) => [w.name, w.tag, w.arch, w.version, `${w.agreed.length} of ${view.spec.members.length}`, w.digest.slice(0, 12)]), ["image", "tag", "arch", "version", "agreed", "digest"]));
    if (view.waiting.length > 12) info(dim(`and ${view.waiting.length - 12} more`));
  }
  if (!view && rows.length) info(dim(`publisher ${publisher} on ${networkLabel(c)}`));
}

export const PUBLISHER_HELP = `Usage:
  chainboot publisher list                        Show the saved names
  chainboot publisher add <name> <address>        Save a publisher under a short name
  chainboot publisher add <name> <list>           Save a list of publishers under a short name
  chainboot publisher remove <name>

  chainboot endorse <image> --keypair <file> [--as <name>[:<tag>]] [--arch <arch>]

A saved name stands for a publisher in every command: "chainboot run alice/alpine".

A list is a catalog that several publishers keep together:

  list:2:<address>,<address>,<address>            two of these three must agree

An image belongs to a list when that many of its publishers have the same image (the same
content) under the same name, tag and architecture in their own catalogs. More than half
must agree, so no single key can add an image or replace one.

  chainboot publisher add team list:2:9xQe...,4Zb7...,Hk3P...
  chainboot list team                             what the list contains, and who agreed
  chainboot run team/solinux

A publisher agrees to an image by publishing it, or by endorsing one that is already on
chain. Endorsing stores nothing again; it adds one entry to the endorser's catalog:

  chainboot endorse 9xQe.../solinux:26.04 --keypair me.json
  chainboot endorse team/solinux --keypair me.json           (an image the list already has)`;

export function cmdPublisher(a: Args): void {
  const c = loadConfig();
  const [sub = "list", name, value] = a._;
  if (sub === "list") {
    const rows = Object.entries(c.publishers).sort().map(([n, v]) => [bold(n), isList(v) ? `list: ${parseList(v).threshold} of ${parseList(v).members.length} publishers` : "publisher", v]);
    if (!rows.length) { info("No publisher names saved. Save one with: chainboot publisher add <name> <address or list>"); return; }
    out(table(rows, ["name", "kind", "address or list"]));
    return;
  }
  if (sub === "add") {
    if (!name || !value) throw new UsageError("usage: chainboot publisher add <name> <address | list:2:<address>,<address>,...>");
    const stored = savePublisherName(c, name, value);
    ok(isList(stored) ? `saved list ${bold(name)}: ${parseList(stored).threshold} of ${parseList(stored).members.length} publishers must agree` : `saved publisher ${bold(name)}`);
    info(dim(`Use it like this: chainboot list ${name}   chainboot run ${name}/<image>`));
    return;
  }
  if (sub === "remove") {
    if (!name) throw new UsageError("say which name: chainboot publisher remove <name>");
    removePublisherName(c, name);
    ok(`removed ${name}`);
    return;
  }
  throw new UsageError('use: chainboot publisher list | add <name> <address or list> | remove <name>');
}

export async function cmdEndorse(a: Args): Promise<void> {
  const what = a._[0];
  if (!what) throw new UsageError("say which image: chainboot endorse <publisher>/<image>[:tag] --keypair <file>");
  const c = loadConfig();
  const payer = loadKeypair(a);
  const store = await openStore(c, note);
  const arch = flag(a, "arch") ?? hostArch();
  const found = await resolveImage(store, c, what, arch);
  if (found.private) throw new Error("a private image cannot be endorsed: endorsing makes an image part of your public catalog");
  const as = parseImageName(flag(a, "as") ?? `${found.name}:${found.tag}`);
  if (as.publisher) throw new UsageError("--as takes a name and a tag, without a publisher: --as solinux:26.04");
  if (!(await confirm(`Add ${found.name}:${found.tag} (${arch}, version ${found.ref.version}, digest ${found.ref.digest.slice(0, 12)}…) to the catalog of ${payer.address} as ${as.name}:${as.tag}?`, a))) { info("cancelled"); return; }
  await endorseImage(store, payer, { name: as.name, tags: [as.tag], arch, ref: found.ref, publisher: found.publisher });
  ok(`${payer.address} now lists ${bold(as.name)}:${as.tag} (${arch}) with digest ${found.ref.digest.slice(0, 12)}…`);
  info(dim("Nothing was stored again: your catalog points at the image that is on chain."));
}

export const PULL_HELP = `Usage:
  chainboot pull <image> [--arch <arch>]    Download an image and verify it (resumes if interrupted)`;

export async function cmdPull(a: Args): Promise<void> {
  if (!a._[0]) throw new UsageError("say which image: chainboot pull solinux");
  const c = loadConfig();
  const store = await openStore(c, note);
  const found = await resolveImage(store, c, a._[0], flag(a, "arch") ?? hostArch());
  const pulled = await pull(store, found.publisher, { ...found.ref, private: found.private }, `${found.name}:${found.tag}`);
  for (let i = 0; i < pulled.manifest.packs.length; i++) pulled.pack(i); // decode + verify every file now
  ok(`every file verified (digest ${pulled.manifest.digest.slice(0, 16)}…)`);
}

export const UNLIST_HELP = `Usage:
  chainboot unlist <name>[:tag] [--arch <arch>] --keypair <file>
  chainboot unlist me/<name>[:tag] [--arch <arch>]          (a private image)
Removes an image from your catalog. Data already on the ledger cannot be erased.`;

export async function cmdUnlist(a: Args): Promise<void> {
  if (!a._[0]) throw new UsageError("say which image: chainboot unlist <name>[:tag]");
  const mine = a._[0].startsWith(`${PRIVATE_PREFIX}/`);
  const [name, tag] = (mine ? a._[0].slice(PRIVATE_PREFIX.length + 1) : a._[0]).split(":");
  const c = loadConfig();
  const vault = mine ? requireLogin(c) : null;
  const store = await openStore(c, note);
  if (!(await confirm(`Remove ${a._[0]} from your ${mine ? "private " : ""}catalog?`, a))) { info("cancelled"); return; }
  if (vault ? await unlistPrivateImage(store, vault, name!, tag, flag(a, "arch")) : await unlistImage(store, loadKeypair(a), name!, tag, flag(a, "arch"))) ok(`${a._[0]} is no longer listed`);
  else warn(`${a._[0]} was not in your catalog`);
}
