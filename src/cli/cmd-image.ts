import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { buildImage } from "../image/build.ts";
import { decompressAuto, readTar } from "../image/tar.ts";
import { serializeManifest, type ImageManifest } from "../image/manifest.ts";
import { hostArch, loadConfig, openStore, paths, resolvePublisher, type Config } from "../local/home.ts";
import { parseImageName, publishImage, pullImage, readCatalog, unlistImage, type ImageRef, type PulledImage, type StoredRef } from "../registry/registry.ts";
import { Keypair } from "../solana/keys.ts";
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
export async function resolveImage(store: ChainStore, c: Config, text: string, arch: string): Promise<{ publisher: string; name: string; tag: string; ref: ImageRef }> {
  const n = parseImageName(text);
  const publisher = resolvePublisher(c, n.publisher);
  const cat = await readCatalog(store, publisher, path.join(paths.cache(), "objects"));
  const image = cat.images[n.name];
  if (!image) {
    const names = Object.keys(cat.images);
    throw new Error(`image "${n.name}" was not found in the catalog of ${publisher}.` + (names.length ? ` Available: ${names.join(", ")}` : " That publisher has no images on this network."));
  }
  const tag = image.tags[n.tag];
  if (!tag) throw new Error(`image "${n.name}" has no tag "${n.tag}". Available: ${Object.keys(image.tags).join(", ")}`);
  const ref = tag[arch];
  if (!ref) throw new Error(`image "${n.name}:${n.tag}" is not published for ${arch}. Available: ${Object.keys(tag).join(", ")}`);
  return { publisher, name: n.name, tag: n.tag, ref };
}

/** Downloads an image into the local cache (or finds it there) with a progress line. */
export async function pull(store: ChainStore, publisher: string, ref: StoredRef & { digest: string }, label: string): Promise<PulledImage> {
  const line = new ProgressLine();
  line.start(`Downloading ${label}`);
  const pulled = await pullImage(store, publisher, ref, {
    cacheDir: paths.cache(),
    onProgress: (p) => { if (p.phase === "download") line.update(p.done, p.total); },
  });
  line.done(`${label} is ready (${fmtBytes(ref.size + pulled.manifest.packs.reduce((n, p) => n + p.size, 0))} verified)`);
  const dir = path.join(paths.images(), pulled.manifest.digest);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), serializeManifest(pulled.manifest));
  fs.writeFileSync(path.join(dir, "origin.json"), JSON.stringify({ publisher, ref }, null, 2));
  return pulled;
}

export const PUBLISH_HELP = `Usage:
  chainboot publish <rootfs.tar[.gz|.xz|.zst]> --name <name> --version <version> [options]

Puts a root file system on chain and lists it in your catalog.

Options:
  --arch <arch>          Architecture of the system (default: this computer's, ${hostArch()})
  --tag <tag>            Tag to publish under; repeatable (default: the version and "latest")
  --description <text>   One line shown in "chainboot list"
  --source-url <url>     Where the archive came from (recorded so others can verify it)
  --reuse <image>        Do not store files again that <image> already has on chain; repeatable
  --cmd <command>        Command started by "chainboot run" (default: a root login shell)
  --keypair <file>       Solana keypair that pays and becomes the publisher
  --dry-run              Build and show the cost, but send nothing
  --yes                  Do not ask for confirmation`;

export async function cmdPublish(a: Args): Promise<void> {
  const file = a._[0], name = flag(a, "name"), version = flag(a, "version");
  if (!file || !name || !version) throw new UsageError("publish needs an archive, --name and --version");
  const arch = flag(a, "arch") ?? hostArch();
  const c = loadConfig();
  const payer = has(a, "dry-run") && !flag(a, "keypair") && !process.env.CHAINBOOT_KEYPAIR ? null : loadKeypair(a);
  info(`Reading ${file}`);
  const packed = fs.readFileSync(file);
  const entries = readTar(decompressAuto(packed));
  const store = has(a, "dry-run") && !flags(a, "reuse").length ? null : await openStore(c, note);
  const reuse: ImageManifest[] = [];
  for (const r of flags(a, "reuse")) {
    const found = await resolveImage(store!, c, r, arch);
    reuse.push((await pull(store!, found.publisher, found.ref, r)).manifest);
  }
  const cmd = flag(a, "cmd");
  const built = buildImage(entries, {
    name, version, arch, description: flag(a, "description"),
    source: { ...(flag(a, "source-url") && { url: flag(a, "source-url") }), sha256: toHex(sha256(packed)) },
    ...(cmd && { config: { cmd: ["/bin/sh", "-c", cmd] } }),
  }, { reuse, onProgress: note });
  const m = built.manifest;
  const manifestBytes = serializeManifest(m).length;
  const newBytes = [...built.newPacks.values()].reduce((n, b) => n + b.length, 0);
  let tx = ChainStore.plan(Math.ceil(manifestBytes / 4)).transactions + 3; // manifest compresses about 4x; catalog + pointer
  for (const b of built.newPacks.values()) tx += ChainStore.plan(b.length).transactions;
  out(table([
    ["image", `${bold(m.name)}:${m.version} (${m.arch})`],
    ["digest", m.digest],
    ["contents", `${m.fileCount} entries, ${fmtBytes(m.rawSize)} unpacked`],
    ["to upload", `${fmtBytes(newBytes)} in ${built.newPacks.size} pack(s)` + (reuse.length ? dim(` (${m.packs.length - built.newPacks.size} pack(s) reused)`) : "")],
    ["transactions", `about ${tx}`],
    ["cost", `about ${((tx * 5000) / 1e9).toFixed(4)} SOL on ${c.cluster}`],
  ]));
  if (has(a, "dry-run")) { info(dim("dry run: nothing was sent")); return; }
  const balance = (await store!.pool.call<{ value: number }>("getBalance", [payer!.address])).value;
  info(`Publisher ${payer!.address} holds ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < tx * 5000) throw new Error(`not enough SOL for this upload (about ${((tx * 5000) / 1e9).toFixed(4)} SOL needed)`);
  if (!(await confirm("Publish now?", a))) { info("cancelled"); return; }
  const line = new ProgressLine();
  const ref = await publishImage(store!, payer!, built, {
    tags: flags(a, "tag").length ? flags(a, "tag") : undefined,
    journalDir: paths.journals(),
    onProgress: (p) => line.update(p.done, p.total, "count", `Uploading ${p.phase}${p.detail && p.detail !== "data" ? ` (${p.detail})` : ""}`),
  });
  line.done(`published ${m.name}:${m.version} (${m.arch})`);
  out(table([["manifest", ref.sig], ["publisher", payer!.address], ["run it with", `chainboot run ${payer!.address === resolvePublisherSafe(c) ? "" : payer!.address + "/"}${m.name}`]]));
}

function resolvePublisherSafe(c: Config): string | null {
  try { return resolvePublisher(c, undefined); } catch { return null; }
}

export const LIST_HELP = `Usage:
  chainboot list [publisher]     Show the images a publisher offers (default: the official catalog)`;

export async function cmdList(a: Args): Promise<void> {
  const c = loadConfig();
  const publisher = resolvePublisher(c, a._[0]);
  const store = await openStore(c, note);
  const cat = await readCatalog(store, publisher, path.join(paths.cache(), "objects"));
  const rows: string[][] = [];
  for (const [name, image] of Object.entries(cat.images).sort()) {
    for (const [tag, arches] of Object.entries(image.tags).sort()) {
      for (const [arch, ref] of Object.entries(arches).sort()) {
        rows.push([bold(name), tag, arch, fmtBytes(ref.downloadSize), fmtBytes(ref.unpackedSize), image.description ?? ""]);
      }
    }
  }
  if (!rows.length) { info(`${publisher} has not published any images on ${c.cluster}.`); return; }
  out(table(rows, ["image", "tag", "arch", "download", "on disk", "description"]));
  info(dim(`publisher ${publisher} on ${c.cluster}`));
}

export const PULL_HELP = `Usage:
  chainboot pull <image> [--arch <arch>]    Download an image and verify it (resumes if interrupted)`;

export async function cmdPull(a: Args): Promise<void> {
  if (!a._[0]) throw new UsageError("say which image: chainboot pull solbuntu");
  const c = loadConfig();
  const store = await openStore(c, note);
  const found = await resolveImage(store, c, a._[0], flag(a, "arch") ?? hostArch());
  const pulled = await pull(store, found.publisher, found.ref, `${found.name}:${found.tag}`);
  for (let i = 0; i < pulled.manifest.packs.length; i++) pulled.pack(i); // decode + verify every file now
  ok(`every file verified (digest ${pulled.manifest.digest.slice(0, 16)}…)`);
}

export const UNLIST_HELP = `Usage:
  chainboot unlist <name>[:tag] [--arch <arch>] --keypair <file>
Removes an image from your catalog. Data already on the ledger cannot be erased.`;

export async function cmdUnlist(a: Args): Promise<void> {
  if (!a._[0]) throw new UsageError("say which image: chainboot unlist <name>[:tag]");
  const [name, tag] = a._[0].split(":");
  const store = await openStore(loadConfig(), note);
  if (!(await confirm(`Remove ${a._[0]} from your catalog?`, a))) { info("cancelled"); return; }
  if (await unlistImage(store, loadKeypair(a), name!, tag, flag(a, "arch"))) ok(`${a._[0]} is no longer listed`);
  else warn(`${a._[0]} was not in your catalog`);
}
