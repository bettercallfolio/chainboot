import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkMachineName, enterMachine, imageReady, listMachines, machineDir, missingTools, readMachine, removeImage, removeMachine,
  startMachine, stopMachine, type EngineHome,
} from "../engine/linux.ts";
import { parseManifest } from "../image/manifest.ts";
import { homeDir, hostArch, loadConfig, openStore } from "../local/home.ts";
import { parseImageName } from "../registry/registry.ts";
import { fmtBytes } from "../util/bytes.ts";
import { UsageError, flag, type Args } from "./args.ts";
import { confirm, pull, resolveImage } from "./cmd-image.ts";
import { ProgressLine, bold, dim, green, info, ok, out, table } from "./term.ts";

function engineHome(home = homeDir()): EngineHome {
  return { images: path.join(home, "images"), machines: path.join(home, "machines"), cache: path.join(home, "cache") };
}

function requireLinux(): void {
  if (process.platform !== "linux") throw new Error(`running machines on ${process.platform} is not available in this build yet (Linux only for now)`);
}

/** Runs an engine command as root: directly when we are root, through sudo otherwise. Returns the exit status. */
function asRoot(args: string[]): number {
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

  chainboot run solbuntu                      Open a shell
  chainboot run solbuntu -- apt-get update    Run one command and return
  chainboot run solbuntu --name test          A second, separate machine from the same image

Related:
  chainboot machines            List your machines
  chainboot stop <machine>      Stop a running machine
  chainboot rm <machine>        Delete a machine and its changes
  chainboot images              List downloaded images
  chainboot rmi <image>         Delete a downloaded image`;

export async function cmdRun(a: Args): Promise<void> {
  requireLinux();
  const text = a._[0];
  if (!text) throw new UsageError("say what to run: chainboot run solbuntu");
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
    const found = await resolveImage(store, c, text, flag(a, "arch") ?? hostArch());
    let digest = found.ref.digest;
    if (!imageReady(home, digest)) digest = (await pull(store, found.publisher, found.ref, `${found.name}:${found.tag}`)).manifest.digest;
    machine = { name, image: { publisher: found.publisher, name: found.name, tag: found.tag, arch: flag(a, "arch") ?? hostArch(), digest }, created: Math.floor(Date.now() / 1000) };
    fs.mkdirSync(machineDir(home, name), { recursive: true });
    fs.writeFileSync(path.join(machineDir(home, name), "machine.json"), JSON.stringify(machine, null, 2) + "\n");
    ok(`created machine ${bold(name)} from ${found.name}:${found.tag}`);
  } else if (wanted.name !== machine.image.name && !flag(a, "name")) {
    throw new Error(`machine "${name}" already exists and was made from ${machine.image.name}; pick another name with --name`);
  }
  process.exitCode = asRoot(["enter", name, "--", ...command]);
}

export function cmdMachines(): void {
  const list = listMachines(engineHome());
  if (!list.length) { info("No machines yet. Create one with: chainboot run solbuntu"); return; }
  out(table(list.map((m) => [bold(m.name), `${m.image.name}:${m.image.tag}`, m.image.arch, m.running ? green("running") : "stopped", new Date(m.created * 1000).toISOString().slice(0, 10)]),
    ["machine", "image", "arch", "state", "created"]));
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

export function cmdImages(): void {
  const list = localImages(engineHome());
  if (!list.length) { info("No images downloaded yet. Try: chainboot pull solbuntu"); return; }
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
export function cmdEngine(argv: string[]): void {
  const [homePath, term, op, name, ...rest] = argv;
  if (!homePath || !op || !name) throw new Error("internal engine command used incorrectly");
  if (process.getuid?.() !== 0) throw new Error("the engine must run as root");
  if (term) process.env.TERM = term;
  const home = engineHome(homePath);
  if (op === "enter") {
    const line = new ProgressLine();
    line.start("Unpacking");
    let unpacked = false;
    const pid = startMachine(home, name, () => {}, (done, total) => { unpacked = true; line.update(done, total, "count"); });
    line.done(unpacked ? "image unpacked" : undefined);
    process.exitCode = enterMachine(home, name, pid, rest[0] === "--" ? rest.slice(1) : rest);
    return;
  }
  if (op === "stop") { if (stopMachine(home, name)) ok(`stopped ${name}`); else info(`${name} is not running`); return; }
  if (op === "rm") { removeMachine(home, name); ok(`deleted machine ${name}`); return; }
  if (op === "rmi") { removeImage(home, name); ok(`deleted image ${name.slice(0, 12)}`); return; }
  throw new Error(`unknown engine operation "${op}"`);
}
