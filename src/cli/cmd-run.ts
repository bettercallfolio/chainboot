import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import {
  checkMachineName, enterMachine, imageReady, initPid, listMachines, machineDir, missingTools, readMachine, removeImage, removeMachine,
  startMachine, stopMachine, type EngineHome,
} from "../engine/linux.ts";
import { CHECK_NEWER_CLEAN, CHECK_NEWER_CONFLICT, autosaveInBackground, checkInner, exportInner, insideMachine, watchInBackground, watchLoop, readSaveStatus, resetLayer, restoreInner, saveInner } from "../engine/state-ops.ts";
import { parseManifest } from "../image/manifest.ts";
import { homeDir, hostArch, loadConfig, openStore, paths } from "../local/home.ts";
import { readIndex } from "../state/snapshot.ts";
import { loadVault } from "../state/vault.ts";
import { parseImageName } from "../registry/registry.ts";
import { fmtBytes } from "../util/bytes.ts";
import { UsageError, flag, has, type Args } from "./args.ts";
import { confirm, pull, resolveImage } from "./cmd-image.ts";
import { ProgressLine, bold, dim, green, info, ok, out, table, yellow } from "./term.ts";

export function engineHome(home = homeDir()): EngineHome {
  return { images: path.join(home, "images"), machines: path.join(home, "machines"), cache: path.join(home, "cache") };
}

function requireLinux(): void {
  if (process.platform !== "linux") throw new Error(`running machines on ${process.platform} is not available in this build yet (Linux only for now)`);
}

/** Runs an engine command as root: directly when we are root, through sudo otherwise. Returns the exit status. */
export function asRoot(args: string[]): number {
  const self = [process.execPath, ...process.execArgv, process.argv[1]!, "_engine", homeDir(), process.env.TERM ?? "", ...args];
  if (process.getuid?.() === 0) return spawnSync(self[0]!, self.slice(1), { stdio: "inherit" }).status ?? 1;
  if (spawnSync("sh", ["-c", "command -v sudo"], { stdio: "ignore" }).status !== 0) {
    throw new Error("this step needs administrator rights, but `sudo` is not installed. Run chainboot as root instead.");
  }
  if (spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status !== 0) {
    info(dim("Machines are mounted by the system, which needs administrator rights. sudo may ask for your password."));
  }
  const r = spawnSync("sudo", ["--", ...self], { stdio: "inherit" });
  if (r.error) throw new Error(`could not run sudo: ${r.error.message}`);
  return r.status ?? 1;
}

export const RUN_HELP = `Usage:
  chainboot run <image> [--name <machine>] [--arch <arch>] [-- <command> ...]

Downloads the image if needed (verified against the chain), creates a machine from it the
first time, and opens a shell in it. Running it again opens the same machine with all your
changes. Several terminals can be inside one machine at once; it stops when the last one leaves.

  chainboot run solinux                      Open a shell
  chainboot run solinux -- apt-get update    Run one command and return
  chainboot run solinux --name test          A second, separate machine from the same image
  chainboot run solinux --no-autosave        Create the machine with automatic saving turned off
  chainboot run solinux --fresh              Do not bring back a saved machine of the same name

Keeping a machine up (for services such as a web server):
  chainboot start <machine>     Start it and keep it running without an open terminal
  If the machine has an executable /etc/chainboot/start, it is run every time the machine starts.

Related:
  chainboot machines            List your machines
  chainboot stop <machine>      Stop a running machine
  chainboot rm <machine>        Delete a machine and its changes
  chainboot images              List downloaded images
  chainboot rmi <image>         Delete a downloaded image`;

export async function cmdRun(a: Args): Promise<void> {
  requireLinux();
  const text = a._[0];
  if (!text) throw new UsageError("say what to run: chainboot run solinux");
  const command = a._.slice(1);
  const home = engineHome();
  const wanted = parseImageName(text);
  const name = flag(a, "name") ?? wanted.name;
  checkMachineName(name);
  const missing = missingTools();
  if (missing.length) throw new Error(`these tools are needed but not installed: ${missing.join(", ")} (they come with the util-linux and coreutils packages)`);

  let machine = readMachine(home, name);
  if (!machine) {
    const c = loadConfig();
    const store = await openStore(c, (t) => info(dim(t)));
    // signed in, and a machine with this name was saved before (on any computer): continue it instead of starting over
    const vault = has(a, "fresh") ? null : loadVault(paths.vault(), c.cluster);
    const saved = vault ? (await readIndex(store, vault).catch(() => null))?.machines[name] : undefined;
    if (saved) {
      info(`You have a saved machine named ${bold(name)} on chain. Bringing it back instead of starting from scratch.`);
      info(dim(`(To start a new, empty one, use another name: chainboot run ${text} --name <name>)`));
      if (!imageReady(home, saved.image.digest)) await pull(store, saved.image.publisher, { ...saved.image.manifest, digest: saved.image.digest }, `${saved.image.name}:${saved.image.tag}`);
      fs.mkdirSync(machineDir(home, name), { recursive: true });
      fs.writeFileSync(path.join(machineDir(home, name), "machine.json"), JSON.stringify({ name, image: saved.image, created: saved.created }, null, 2) + "\n");
      if (asRoot(["restore", name, "latest"]) !== 0) throw new Error(`could not restore "${name}". Remove the half-made machine with "chainboot rm ${name}" and try again.`);
      process.exitCode = asRoot(["enter", name, "--", ...command]);
      return;
    }
    const found = await resolveImage(store, c, text, flag(a, "arch") ?? hostArch());
    let digest = found.ref.digest;
    if (!imageReady(home, digest)) digest = (await pull(store, found.publisher, found.ref, `${found.name}:${found.tag}`)).manifest.digest;
    const r = found.ref;
    machine = {
      name, created: Math.floor(Date.now() / 1000),
      image: { publisher: found.publisher, name: found.name, tag: found.tag, arch: flag(a, "arch") ?? hostArch(), digest, manifest: { sig: r.sig, sha256: r.sha256, size: r.size, codec: r.codec, rawSize: r.rawSize } },
    };
    fs.mkdirSync(machineDir(home, name), { recursive: true });
    fs.writeFileSync(path.join(machineDir(home, name), "machine.json"), JSON.stringify(machine, null, 2) + "\n");
    ok(`created machine ${bold(name)} from ${found.name}:${found.tag}`);
    if (has(a, "no-autosave")) asRoot(["autosave", name, "off"]);
  }
  process.exitCode = asRoot(["enter", name, "--", ...command]);
}

export function cmdMachines(): void {
  const list = listMachines(engineHome());
  if (!list.length) { info("No machines yet. Create one with: chainboot run solinux"); return; }
  out(table(list.map((m) => [bold(m.name), `${m.image.name}:${m.image.tag}`, m.image.arch, m.running ? green("running") : "stopped", new Date(m.created * 1000).toISOString().slice(0, 10)]),
    ["machine", "image", "arch", "state", "created"]));
}

export function cmdStart(a: Args): void {
  requireLinux();
  const name = a._[0];
  if (!name) throw new UsageError("say which machine: chainboot start <machine>");
  if (!readMachine(engineHome(), name)) throw new Error(`there is no machine named "${name}". Create it first with: chainboot run <image> --name ${name}`);
  process.exitCode = asRoot(["start", name]);
}

export function cmdStop(a: Args): void {
  requireLinux();
  const name = a._[0];
  if (!name) throw new UsageError("say which machine: chainboot stop <machine>");
  if (!readMachine(engineHome(), name)) throw new Error(`there is no machine named "${name}"`);
  process.exitCode = asRoot(["stop", name]);
}

export async function cmdRm(a: Args): Promise<void> {
  requireLinux();
  const name = a._[0];
  if (!name) throw new UsageError("say which machine: chainboot rm <machine>");
  if (!readMachine(engineHome(), name)) throw new Error(`there is no machine named "${name}"`);
  if (!(await confirm(`Delete machine "${name}" and everything changed inside it?`, a))) { info("cancelled"); return; }
  process.exitCode = asRoot(["rm", name]);
}

interface LocalImage { digest: string; name: string; version: string; arch: string; size: number; ready: boolean; usedBy: string[] }

function localImages(home: EngineHome): LocalImage[] {
  let dirs: string[];
  try { dirs = fs.readdirSync(home.images); } catch { return []; }
  const machines = listMachines(home);
  const list: LocalImage[] = [];
  for (const digest of dirs) {
    try {
      const m = parseManifest(fs.readFileSync(path.join(home.images, digest, "manifest.json")));
      list.push({ digest, name: m.name, version: m.version, arch: m.arch, size: m.rawSize, ready: imageReady(home, digest), usedBy: machines.filter((x) => x.image.digest === digest).map((x) => x.name) });
    } catch { /* not an image directory */ }
  }
  return list;
}

export const EXPORT_HELP = `Usage:
  chainboot export <machine> <file.tar>

Writes a machine's whole file system (image plus your changes) as a tar archive. Use it to
publish a system you built by hand:

  chainboot run solinux-minimal --name mybox       # install and configure what you need
  chainboot export mybox mybox.tar
  chainboot publish mybox.tar --name mybox --version 1.0 --reuse solinux-minimal --keypair me.json`;

export function cmdExport(a: Args): void {
  requireLinux();
  const [name, file] = a._;
  if (!name || !file) throw new UsageError("usage: chainboot export <machine> <file.tar>");
  if (!readMachine(engineHome(), name)) throw new Error(`there is no machine named "${name}"`);
  const target = path.resolve(file);
  if (fs.existsSync(target)) throw new Error(`${target} already exists`);
  const status = asRoot(["export", name, target]);
  // the engine runs as root: hand the archive to the user who asked for it
  if (status === 0 && process.getuid?.() !== 0) spawnSync("sudo", ["chown", `${process.getuid!()}:${process.getgid!()}`, target], { stdio: "ignore" });
  process.exitCode = status;
}

export function cmdImages(): void {
  const list = localImages(engineHome());
  if (!list.length) { info("No images downloaded yet. Try: chainboot pull solinux"); return; }
  out(table(list.map((i) => [bold(i.name), i.version, i.arch, fmtBytes(i.size), i.digest.slice(0, 12), i.usedBy.join(", ") || dim("-")]), ["image", "version", "arch", "on disk", "digest", "machines"]));
}

export async function cmdRmi(a: Args): Promise<void> {
  requireLinux();
  const what = a._[0];
  if (!what) throw new UsageError("say which image: chainboot rmi <name or digest>");
  const matches = localImages(engineHome()).filter((i) => i.name === what || i.digest.startsWith(what) || `${i.name}:${i.version}` === what);
  if (!matches.length) throw new Error(`no downloaded image matches "${what}"`);
  if (matches.length > 1) throw new Error(`"${what}" matches several images; use the digest: ${matches.map((m) => m.digest.slice(0, 12)).join(", ")}`);
  const img = matches[0]!;
  if (img.usedBy.length) throw new Error(`image is used by machine(s): ${img.usedBy.join(", ")}. Remove them first (chainboot rm <machine>).`);
  process.exitCode = asRoot(["rmi", img.digest]);
}

/** Internal: `chainboot _engine <home> <term> <operation> ...`, always run as root. */
export function cmdEngine(argv: string[]): void | Promise<void> {
  const [homePath, term, op, name, ...rest] = argv;
  if (!homePath || !op || !name) throw new Error("internal engine command used incorrectly");
  if (process.getuid?.() !== 0) throw new Error("the engine must run as root");
  if (term) process.env.TERM = term;
  const home = engineHome(homePath);
  process.env.CHAINBOOT_HOME = homePath;
  const line = new ProgressLine();
  const say = (t: string) => info(t);
  const progress = (phase: string, done: number, total: number) => line.update(done, total, phase === "uploading" || phase === "downloading" ? "bytes" : "count", phase[0]!.toUpperCase() + phase.slice(1));
  const ask = async (q: string) => {
    if (!process.stdin.isTTY) return false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try { return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim()); } finally { rl.close(); }
  };
  if (op === "check-inner") return checkInner(home, name).then((code) => { process.exit(code); });
  if (op === "enter") {
    line.start("Unpacking");
    let unpacked = false;
    const wasRunning = initPid(machineDir(home, name)) !== null;
    let pid = startMachine(home, name, () => {}, (done, total) => { unpacked = true; line.update(done, total, "count"); });
    line.done(unpacked ? "image unpacked" : undefined);
    // signed in and this machine was saved before: continue from the newest save if another computer made one
    if (!wasRunning && !process.env.CHAINBOOT_OFFLINE && readSaveStatus(machineDir(home, name))?.seq) {
      const code = insideMachine(home, homePath, name, ["check-inner", name], "ignore");
      if (code === CHECK_NEWER_CLEAN) {
        info("A newer save of this machine is on chain (made on another computer). Updating to it.");
        resetLayer(home, name);
        if (insideMachine(home, homePath, name, ["restore-inner", name, "latest"]) !== 0) info(dim("The update did not complete; starting the machine as it is."));
        pid = startMachine(home, name, () => {});
      } else if (code === CHECK_NEWER_CONFLICT) {
        info(`${yellow("!")} A newer save of this machine is on chain, but this copy also has changes that were not saved.`);
        info(dim(`  Take the newer one with "chainboot restore ${name}", or keep this copy with "chainboot save ${name} --force".`));
      }
    }
    watchInBackground(home, homePath, name);
    process.exitCode = enterMachine(home, name, pid, rest[0] === "--" ? rest.slice(1) : rest);
    if (autosaveInBackground(home, homePath, name)) info(dim("Changes are saved to Solana in the background. Check with: chainboot status"));
    return;
  }
  if (op === "save") { process.exitCode = insideMachine(home, homePath, name, ["save-inner", name, ...rest], rest.includes("--auto") ? "ignore" : "inherit"); return; }
  if (op === "save-inner") {
    const noteAt = rest.indexOf("--note");
    return saveInner(home, name, { force: rest.includes("--force"), auto: rest.includes("--auto"), yes: rest.includes("--yes"), note: noteAt >= 0 ? rest[noteAt + 1] : undefined }, say, progress, ask)
      .then((status) => { line.done(); process.exitCode = status; });
  }
  if (op === "restore") { resetLayer(home, name); process.exitCode = insideMachine(home, homePath, name, ["restore-inner", name, ...rest]); return; }
  if (op === "restore-inner") {
    return restoreInner(home, name, rest[0] && rest[0] !== "latest" ? Number(rest[0]) : null, say, progress).then((status) => { line.done(); process.exitCode = status; });
  }
  if (op === "export") { process.exitCode = insideMachine(home, homePath, name, ["export-inner", name, ...rest]); return; }
  if (op === "export-inner") {
    const r = exportInner(home, name, rest[0]!, progress);
    line.done();
    ok(`exported ${name}: ${r.entries} entries, ${fmtBytes(r.bytes)}`);
    return;
  }
  if (op === "autosave") {
    const off = path.join(machineDir(home, name), "autosave-off");
    if (rest[0] === "off") { fs.writeFileSync(off, ""); ok(`automatic saving is off for ${name}`); } else { fs.rmSync(off, { force: true }); ok(`automatic saving is on for ${name}`); }
    return;
  }
  if (op === "watch") return watchLoop(home, homePath, name);
  if (op === "start") {
    startMachine(home, name, () => {}, (done, total) => line.update(done, total, "count", "Unpacking"), true);
    watchInBackground(home, homePath, name);
    line.done();
    ok(`${name} is running and stays up until: chainboot stop ${name}`);
    return;
  }
  if (op === "stop") { if (stopMachine(home, name)) ok(`stopped ${name}`); else info(`${name} is not running`); return; }
  if (op === "rm") { removeMachine(home, name); ok(`deleted machine ${name}`); return; }
  if (op === "rmi") { removeImage(home, name); ok(`deleted image ${name.slice(0, 12)}`); return; }
  throw new Error(`unknown engine operation "${op}"`);
}
