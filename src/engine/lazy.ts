// Lazy machines: the image is not unpacked. A small server process shows it as a file system
// (see fuse.ts) and fetches a pack from the chain the first time one of its files is read.
//
// The server runs next to the machine: in the machine's mount namespace, so that its file
// system is where the machine's overlay looks for the image, but outside the machine's process
// namespace, so that nothing inside the machine can see or stop it. It ends when the machine
// does.
import fs from "node:fs";
import path from "node:path";
import { decompress } from "../codec/index.ts";
import { verifyPack } from "../image/build.ts";
import { parseManifest, type ImageManifest } from "../image/manifest.ts";
import { loadConfig, openStore, paths } from "../local/home.ts";
import { loadVault, openEither } from "../state/vault.ts";
import type { ChainStore } from "../store/store.ts";
import { mountFuse, serveImage } from "./fuse.ts";
import { machineDir, readMachine, type EngineHome } from "./linux.ts";

/** How many of an image's first packs are fetched as soon as a lazy machine starts (about 48 MiB of files), and how many at a time. */
const START_PACKS = 12, AHEAD_AT_ONCE = 4;

/** Where a lazy machine's image appears (inside the machine's mount namespace only). */
export const lazyLower = (dir: string): string => path.join(dir, "lower");

const manifests = new Map<string, ImageManifest>();
/** The manifest of a downloaded (or, for lazy machines, merely listed) image. */
export function imageManifest(home: EngineHome, digest: string): ImageManifest {
  let m = manifests.get(digest);
  if (!m) { m = parseManifest(fs.readFileSync(path.join(home.images, digest, "manifest.json"))); manifests.set(digest, m); }
  return m;
}

/** True when the image has a file, link or directory at `file` (a path without a leading slash). */
export function imageHas(home: EngineHome, digest: string, file: string): boolean {
  try { return imageManifest(home, digest).tree.some((n) => n[0] === file && n[1] !== "d"); } catch { return false; }
}

/**
 * Makes sure the decompressed, verified content of pack `index` is in the cache and returns
 * its path. Fetches the pack from the chain if this computer does not have it yet.
 */
export async function rawPack(home: EngineHome, manifest: ImageManifest, index: number, store: () => Promise<ChainStore>): Promise<string> {
  const p = manifest.packs[index];
  if (!p) throw new Error(`the image has no pack ${index}`);
  const dir = path.join(home.cache, "raw"), file = path.join(dir, p.rawSha256);
  try { if (fs.statSync(file).size === p.rawSize) return file; } catch { /* not there yet */ }
  const objects = path.join(home.cache, "objects");
  let stored: Buffer;
  try { stored = fs.readFileSync(path.join(objects, p.sha256)); } catch {
    stored = await (await store()).get({ sig: p.sig, sha256: p.sha256, size: p.size }, { cacheDir: objects });
  }
  if (p.enc) {
    const vault = p.key ? null : loadVault(paths.vault(), loadConfig().cluster);
    if (!p.key && !vault) throw new Error(`${manifest.name} is a private image: sign in with the wallet that published it (chainboot login)`);
    stored = openEither(vault?.encKey, p.key, stored, "pack");
  }
  const raw = decompress(p.codec, stored, p.rawSize);
  verifyPack(manifest, index, raw); // the pack's hash and the hash of every file in it
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, file);
  return file;
}

/**
 * The server process of one lazy machine: mounts the image at the machine's "lower" directory
 * and serves it until the process `watch` is gone (the machine's namespaces went with it).
 */
export async function lazyServe(home: EngineHome, name: string, watch: number): Promise<void> {
  const dir = machineDir(home, name);
  const log = (text: string) => { try { fs.appendFileSync(path.join(dir, "lazy.log"), `${new Date().toISOString()} ${text}\n`); } catch { /* the log is a courtesy */ } };
  const failed = (why: string) => { try { fs.writeFileSync(path.join(dir, "failed"), why); } catch { /* nobody to tell */ } log(why); process.exit(1); };
  const info = readMachine(home, name);
  if (!info) return failed(`there is no machine named "${name}"`);
  let manifest: ImageManifest;
  try { manifest = imageManifest(home, info.image.digest); } catch (e) { return failed(`the image of "${name}" is not listed on this computer: ${(e as Error).message}`); }
  if (manifest.digest !== info.image.digest) return failed("the image directory does not match its manifest");

  let opened: Promise<ChainStore> | null = null;
  const store = () => (opened ??= openStore(loadConfig()).catch((e) => { opened = null; throw e; }));
  // one fetch per pack, whoever asks first: a program reading a file, or the fetching ahead
  const inFlight = new Map<number, Promise<string>>();
  const fetching = (index: number): Promise<string> => {
    let p = inFlight.get(index);
    if (!p) {
      const t0 = Date.now();
      const had = fs.existsSync(path.join(home.cache, "raw", manifest.packs[index]!.rawSha256));
      p = rawPack(home, manifest, index, store).then((file) => {
        if (!had) log(`pack ${index + 1}/${manifest.packs.length} fetched (${manifest.packs[index]!.size} bytes on chain) in ${Date.now() - t0} ms`);
        return file;
      });
      p.catch(() => { if (inFlight.get(index) === p) inFlight.delete(index); });
      inFlight.set(index, p);
    }
    return p;
  };
  const pack = async (index: number): Promise<number> => fs.openSync(await fetching(index), "r");

  const mountpoint = lazyLower(dir);
  fs.mkdirSync(mountpoint, { recursive: true });
  let m: ReturnType<typeof mountFuse>;
  try { m = mountFuse(mountpoint, `chainboot-${manifest.name}`); } catch (e) { return failed((e as Error).message); }
  const served = serveImage(m.fd, manifest, pack, { onError: log, concurrency: 4 });
  try { await m.mounted; } catch (e) { return failed((e as Error).message); }
  fs.writeFileSync(path.join(dir, "lower.ready"), "");
  log(`serving ${manifest.name}:${manifest.version} (${manifest.tree.length} entries, ${manifest.packs.length} packs) for ${name}`);
  // A system's start reads the same files every time, and an image laid out for lazy use has
  // them in its first packs: fetch those now, side by side, instead of one after the other
  // as the first program stumbles over them.
  // (a few at a time; a pack that a program asks for meanwhile is fetched at once, whatever its place in the line)
  let next = 0;
  const ahead = async (): Promise<void> => {
    while (next < Math.min(START_PACKS, manifest.packs.length)) {
      const i = next++;
      await fetching(i).catch((e: Error) => log(`pack ${i + 1} could not be fetched ahead: ${e.message}`));
    }
  };
  for (let i = 0; i < AHEAD_AT_ONCE; i++) void ahead();

  // the machine is gone when the process that carries its namespaces is: nothing is left to serve
  // (a process that has ended but was not collected by its parent yet still has a PID: it counts as gone)
  const alive = (pid: number): boolean => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      return state !== "Z" && state !== "X";
    } catch { return false; }
  };
  const timer = setInterval(() => {
    if (!alive(watch)) {
      log(`machine ended: ${served.stats.requests} requests, ${served.stats.reads} reads, ${served.stats.bytesRead} bytes, ${served.stats.packsOpened} of ${manifest.packs.length} packs used`);
      // what was read, in order: the list a publisher gives to "publish --start-files" to put these files first
      try { fs.writeFileSync(path.join(dir, "lazy-files.txt"), served.stats.files.map((f) => `/${f}\n`).join("")); } catch { /* a courtesy */ }
      // An ordinary exit would wait for the threads that sit in read() on the FUSE device, and
      // those reads only return when the file system is unmounted, which happens when this
      // process, the last one in the mount namespace, is gone. So it goes without ceremony.
      process.kill(process.pid, "SIGKILL");
    }
  }, 500);
  await served.done;
  clearInterval(timer);
  log("unmounted");
}
