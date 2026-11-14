// Running chainboot on Windows and macOS.
//
// Machines are Linux systems, so they need a Linux kernel. On Windows and macOS chainboot keeps
// one small Linux environment (the "engine") and runs its Linux self inside it:
//
//   Windows  -> a WSL2 distribution named "chainboot"
//   macOS    -> a container in Docker / OrbStack / Podman, or a Lima virtual machine
//
// The engine is made from Canonical's official Ubuntu base archive (checksum pinned below),
// plus the official Node.js build and a copy of this program. Your systems still come from
// the chain: the engine is only the place where they run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import net from "node:net";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeTar, type Entry } from "../image/tar.ts";
import { homeDir, paths } from "../local/home.ts";

export type EngineKind = "wsl" | "docker" | "podman" | "lima";

const NAME = "chainboot";
const ENGINE_HOME = "/var/lib/chainboot";
const ENGINE_APP = "/opt/chainboot";
export const UI_PORT = 7717;
/**
 * Ports for what machines serve (a web interface, a desktop). Where machines run inside an
 * engine container, these are passed through to this computer, so a browser here reaches a
 * service that listens on one of them inside a machine.
 */
export const MACHINE_PORTS = { first: 7654, last: 7673 };

const NODE_VERSION = "v24.22.3";
const NODE_SHA: Record<string, string> = {
  x64: "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2",
  arm64: "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8",
};
const BASE_URL = "https://cdimage.ubuntu.com/ubuntu-base/releases/26.04/release";
const BASE_FILE: Record<string, { name: string; sha256: string }> = {
  x64: { name: "ubuntu-base-26.04.1-base-amd64.tar.gz", sha256: "a496a960472ce474a59590b8987d3a1135d3cbef1991f3b1abe8cacfea8bf85a" },
  arm64: { name: "ubuntu-base-26.04.1-base-arm64.tar.gz", sha256: "5a1906794ced63a71a8119c3f211ef5f0bbe0a243001b4bbd41fdf80c5b219fd" },
};

const say = (t: string) => process.stderr.write(t + "\n");

function run(bin: string, args: string[], opts: { input?: Buffer; inherit?: boolean } = {}): SpawnSyncReturns<Buffer> {
  return spawnSync(bin, args, { input: opts.input, stdio: opts.inherit ? "inherit" : [opts.input ? "pipe" : "ignore", "pipe", "pipe"], maxBuffer: 64 << 20, windowsHide: true });
}
const works = (bin: string, args: string[]) => { const r = run(bin, args); return !r.error && r.status === 0; };
/** wsl.exe prints UTF-16; everything else UTF-8. */
const text = (b: Buffer | null) => { if (!b) return ""; const s = b.toString("utf8"); return s.includes("\0") ? b.toString("utf16le") : s; };

/** Which engine this computer should use, or null when chainboot runs natively (Linux, including inside WSL). */
export function engineKind(): EngineKind | null {
  const forced = process.env.CHAINBOOT_ENGINE;
  if (forced === "native") return null;
  if (forced === "wsl" || forced === "docker" || forced === "podman" || forced === "lima") return forced;
  if (process.platform === "win32") return "wsl";
  if (process.platform !== "darwin") return null;
  // The engine that already holds this computer's machines is the one to use. If it is not
  // running, say so: quietly setting up a second, empty one would make every machine seem gone.
  const known = readState()?.kind;
  if (known === "docker" || known === "podman" || known === "lima") {
    const up = known === "lima" ? works("limactl", ["--version"]) : works(known, ["info"]);
    if (up) return known;
    const what = { docker: "Docker (OrbStack or Docker Desktop)", podman: "Podman", lima: "Lima" }[known];
    throw new Error(`Your machines on this Mac live in ${what}, which is not running or not installed any more. Start it and run chainboot again.\n(To start over with another engine instead, delete ${stateFile()}; the machines in the old engine stay there, and what you saved to chain comes back from the chain.)`);
  }
  if (works("docker", ["info"])) return "docker";
  if (works("podman", ["info"])) return "podman";
  if (works("limactl", ["--version"])) return "lima";
  throw new Error([
    "macOS needs a Linux engine to run machines, and none was found. Install one of these, then run chainboot again:",
    "  OrbStack         https://orbstack.dev            (light and fast)",
    "  Docker Desktop   https://www.docker.com/products/docker-desktop",
    "  Podman           brew install podman && podman machine init && podman machine start",
    "  Lima             brew install lima",
  ].join("\n"));
}

/** Command prefix that runs a program inside the engine as root. */
function prefix(kind: EngineKind, tty: boolean, env: Record<string, string> = {}): string[] {
  const vars = Object.entries({ CHAINBOOT_HOME: ENGINE_HOME, CHAINBOOT_ENGINE: "native", ...env });
  // (--exec starts the program itself; with "--" the rest would be handed to a shell in the engine, which would read ; | $ * in the user's arguments its own way)
  if (kind === "wsl") return ["wsl.exe", "-d", NAME, "-u", "root", "--cd", "/", "--exec", "env", ...vars.map(([k, v]) => `${k}=${v}`)];
  if (kind === "lima") return ["limactl", "shell", "--workdir", "/", NAME, "sudo", "env", ...vars.map(([k, v]) => `${k}=${v}`)];
  return [kind, "exec", "-i", ...(tty ? ["-t"] : []), ...vars.flatMap(([k, v]) => ["-e", `${k}=${v}`]), NAME];
}

function inEngine(kind: EngineKind, cmd: string[], input?: Buffer): SpawnSyncReturns<Buffer> {
  const p = prefix(kind, false);
  return run(p[0]!, [...p.slice(1), ...cmd], { input });
}

function must(r: SpawnSyncReturns<Buffer>, what: string): void {
  if (r.error || r.status !== 0) throw new Error(`${what} failed: ${(r.error?.message ?? (text(r.stderr).trim() || text(r.stdout).trim())).split("\n").slice(-3).join(" ") || "no details"}`);
}

async function download(url: string, sha256: string, what: string): Promise<Buffer> {
  const cache = path.join(paths.cache(), "engine");
  const file = path.join(cache, sha256);
  if (fs.existsSync(file)) { const b = fs.readFileSync(file); if (createHash("sha256").update(b).digest("hex") === sha256) return b; }
  say(`Downloading ${what}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`could not download ${what}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== sha256) throw new Error(`${what} does not match its expected SHA-256; nothing was installed`);
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(file, data);
  return data;
}

function engineArch(kind: EngineKind): "x64" | "arm64" {
  if (kind === "docker" || kind === "podman") {
    const a = text(run(kind, ["info", "--format", kind === "docker" ? "{{.Architecture}}" : "{{.Host.Arch}}"]).stdout).trim();
    if (/aarch64|arm64/.test(a)) return "arm64";
    if (/x86_64|amd64/.test(a)) return "x64";
  }
  return os.arch() === "arm64" ? "arm64" : "x64";
}

/** The program files next to this bundle, as a tar archive, and a fingerprint of them. */
function ownApp(): { tar: Buffer; id: string } {
  const dir = path.dirname(process.argv[1] ?? "");
  const main = path.join(dir, "chainboot.mjs");
  if (!fs.existsSync(main) || !fs.existsSync(path.join(dir, "web", "index.html"))) {
    throw new Error("on this system chainboot must run from its installed program files (use the installer, or `npm run build` and run dist/chainboot.mjs)");
  }
  const entries: Entry[] = [{ path: "web", type: "d", mode: 0o755, uid: 0, gid: 0, mtime: 0 }];
  const add = (rel: string, mode: number) => entries.push({ path: rel, type: "f", mode, uid: 0, gid: 0, mtime: 0, data: fs.readFileSync(path.join(dir, rel)) });
  add("chainboot.mjs", 0o755);
  for (const f of fs.readdirSync(path.join(dir, "web")).sort()) add(`web/${f}`, 0o644);
  const tar = Buffer.concat(writeTar(entries));
  return { tar, id: createHash("sha256").update(tar).digest("hex").slice(0, 16) };
}

function exists(kind: EngineKind): boolean {
  if (kind === "wsl") return text(run("wsl.exe", ["-l", "-q"]).stdout).split(/\r?\n/).map((s) => s.trim()).includes(NAME);
  if (kind === "lima") return text(run("limactl", ["list", "-q"]).stdout).split(/\r?\n/).includes(NAME);
  return works(kind, ["container", "inspect", NAME]);
}

function wake(kind: EngineKind): void {
  if (kind === "lima") { if (!/Running/.test(text(run("limactl", ["list", NAME]).stdout))) must(run("limactl", ["start", NAME], { inherit: true }), "starting the Lima machine"); return; }
  if (kind === "docker" || kind === "podman") {
    if (text(run(kind, ["container", "inspect", "-f", "{{.State.Running}}", NAME]).stdout).trim() !== "true") must(run(kind, ["start", NAME]), "starting the engine container");
  }
}

const PORTS_LABEL = "chainboot.machine-ports";

/**
 * The machine ports the engine container passes through, as "7654 7655 ...": "" when it passes
 * none, null when the container was made by an earlier version that did not know about them.
 */
function passedPorts(kind: EngineKind): string | null {
  const r = run(kind, ["container", "inspect", "-f", `{{index .Config.Labels "${PORTS_LABEL}"}}`, NAME]);
  if (r.error || r.status !== 0) return "";
  const v = text(r.stdout).trim();
  return v === "" || v === "<no value>" ? null : v === "none" ? "" : v;
}

/** The machine ports that nothing on this computer is using right now. */
async function freeMachinePorts(): Promise<number[]> {
  const free: number[] = [];
  for (let p = MACHINE_PORTS.first; p <= MACHINE_PORTS.last; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (ok) free.push(p);
  }
  return free;
}

async function create(kind: EngineKind, again = false): Promise<void> {
  if (!again) say("Setting up the Linux engine for chainboot (first run only).");
  const arch = engineArch(kind);
  if (kind === "lima") {
    must(run("limactl", ["start", `--name=${NAME}`, "--tty=false", "template://default"], { inherit: true }), "creating the Lima machine");
    return;
  }
  const base = BASE_FILE[arch]!;
  const rootfs = await download(`${BASE_URL}/${base.name}`, base.sha256, "the Ubuntu base system for the engine (35 MB, from cdimage.ubuntu.com)");
  const file = path.join(paths.cache(), "engine", base.sha256);
  if (kind === "wsl") {
    const status = run("wsl.exe", ["--status"]);
    if (status.error || status.status !== 0) {
      throw new Error("chainboot needs WSL 2 on Windows. Open PowerShell as administrator, run:\n\n    wsl --install --no-distribution\n\nrestart the computer, then run chainboot again.");
    }
    const target = path.join(process.env.LOCALAPPDATA ?? homeDir(), "chainboot", "engine");
    fs.mkdirSync(target, { recursive: true });
    const tarGz = `${file}.tar.gz`;
    if (!fs.existsSync(tarGz)) fs.copyFileSync(file, tarGz);
    must(run("wsl.exe", ["--import", NAME, target, tarGz, "--version", "2"]), "creating the WSL distribution");
    return;
  }
  const image = `${NAME}-engine:${base.sha256.slice(0, 12)}`;
  if (!works(kind, ["image", "inspect", image])) must(run(kind, ["import", "-", image], { input: rootfs }), "importing the engine image");
  // The machine ports are passed through one by one, and only those that are free here: a port
  // that another program holds must not keep the engine from being made.
  const container = (ports: number[]) => run(kind, ["run", "-d", "--name", NAME, "--hostname", NAME, "--privileged", "--restart", "unless-stopped",
    "-v", `${NAME}-data:${ENGINE_HOME}`, "-p", `127.0.0.1:${UI_PORT}:${UI_PORT}`,
    ...ports.flatMap((p) => ["-p", `127.0.0.1:${p}:${p}`]), "--label", `${PORTS_LABEL}=${ports.join(" ") || "none"}`, image, "sleep", "infinity"]);
  const ports = await freeMachinePorts();
  let made = container(ports);
  if (ports.length && (made.error || made.status !== 0)) {
    // (a port was taken in the meantime) without them the engine still does everything but serve pages
    run(kind, ["rm", "-f", NAME]);
    made = container([]);
  }
  must(made, "creating the engine container");
}

interface EngineState { kind: EngineKind; app: string; node: string; config: string }
const stateFile = () => path.join(homeDir(), "engine.json");
function readState(): EngineState | null { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as EngineState; } catch { return null; } }
function writeState(s: EngineState): void { fs.mkdirSync(homeDir(), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s)); }

/** Makes sure the engine exists, runs, and has this version of the program and the current settings. */
export async function ensureEngine(kind: EngineKind): Promise<void> {
  let fresh = !exists(kind), again = false;
  if (!fresh && (kind === "docker" || kind === "podman") && passedPorts(kind) === null) {
    // The container is only the engine's program: machines, images and settings are in its volume and stay.
    say("Updating the Linux engine so that machines can serve pages to your browser (one time; machines that are running stop).");
    must(run(kind, ["rm", "-f", NAME]), "replacing the engine container");
    fresh = true; again = true;
  }
  if (fresh) await create(kind, again);
  wake(kind);
  const state: EngineState = (!fresh && readState()?.kind === kind ? readState()! : { kind, app: "", node: "", config: "" });

  if (state.node !== NODE_VERSION || !works(prefix(kind, false)[0]!, [...prefix(kind, false).slice(1), `${ENGINE_APP}/node`, "--version"])) {
    const arch = engineArch(kind);
    const node = await download(`https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${arch}.tar.gz`, NODE_SHA[arch]!, `Node.js ${NODE_VERSION} for the engine (from nodejs.org)`);
    must(inEngine(kind, ["sh", "-c", `mkdir -p ${ENGINE_APP}/app ${ENGINE_HOME} && tar -xz -C ${ENGINE_APP} --strip-components=2 node-${NODE_VERSION}-linux-${arch}/bin/node`], node), "installing Node.js in the engine");
    // optional speed-up for unpacking large systems; the built-in decoder is used when this fails
    inEngine(kind, ["sh", "-c", "{ command -v xz && command -v getfattr; } >/dev/null 2>&1 || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xz-utils attr) >/dev/null 2>&1 || true"]);
    state.node = NODE_VERSION;
  }
  const app = ownApp();
  if (state.app !== app.id) {
    must(inEngine(kind, ["sh", "-c", `mkdir -p ${ENGINE_APP}/app.new && tar -x -C ${ENGINE_APP}/app.new && rm -rf ${ENGINE_APP}/app && mv ${ENGINE_APP}/app.new ${ENGINE_APP}/app`], app.tar), "copying chainboot into the engine");
    state.app = app.id;
  }
  writeState(state);
  syncConfig(kind);
  if (fresh) say("The engine is ready.");
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Keeps the settings (network, endpoints, saved names, ...) the same on both sides. They are
 * changed on this side by commands such as "chainboot rpc add", and inside the engine by the
 * web interface, which runs there. Whichever side changed since the two last agreed is copied
 * to the other; if both did, this side wins.
 */
export function syncConfig(kind: EngineKind): void {
  const state = readState();
  if (!state || state.kind !== kind) return;
  let here = "";
  try { here = fs.readFileSync(paths.config(), "utf8"); } catch { /* no settings on this side yet */ }
  const r = inEngine(kind, ["sh", "-c", `if [ -f ${ENGINE_HOME}/config.json ]; then cat ${ENGINE_HOME}/config.json; fi`]);
  if (r.error || r.status !== 0) return; // the engine cannot be asked now: next time
  const there = r.stdout.toString("utf8");
  const agreed = state.config || hashOf("");
  if (hashOf(here) === hashOf(there)) { if (state.config !== hashOf(here)) writeState({ ...state, config: hashOf(here) }); return; }
  const thereChanged = hashOf(there) !== agreed, hereChanged = hashOf(here) !== agreed;
  if (there && thereChanged && (!hereChanged || !here)) {
    try { JSON.parse(there); } catch { return; } // half-written: take it next time
    fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
    const tmp = `${paths.config()}.tmp${process.pid}`;
    fs.writeFileSync(tmp, there, { mode: 0o600 });
    fs.renameSync(tmp, paths.config());
    writeState({ ...state, config: hashOf(there) });
    return;
  }
  if (!here) return;
  must(inEngine(kind, ["sh", "-c", `mkdir -p ${ENGINE_HOME} && cat > ${ENGINE_HOME}/config.json.tmp && chmod 600 ${ENGINE_HOME}/config.json.tmp && mv ${ENGINE_HOME}/config.json.tmp ${ENGINE_HOME}/config.json`], Buffer.from(here)), "copying settings into the engine");
  writeState({ ...state, config: hashOf(here) });
}

/** The engine this computer already has, without looking for one (which can take a moment): for commands that only want to keep in step with it. */
export function knownEngine(): EngineKind | null {
  if (process.env.CHAINBOOT_ENGINE === "native") return null;
  if (process.platform === "linux" && !process.env.CHAINBOOT_ENGINE) return null;
  return readState()?.kind ?? null;
}

/** Where commands that produce a file write it inside the engine, before it is copied to this side. */
export const ENGINE_OUT = `${ENGINE_HOME}/out`;

/** Copies a file out of the engine to this computer. Never overwrites. */
export function copyOut(kind: EngineKind, inside: string, target: string): Promise<void> {
  const p = [...prefix(kind, false), "cat", inside];
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target, { flags: "wx" });
    const child = spawn(p[0]!, p.slice(1), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const failed = (why: string) => { out.destroy(); fs.rmSync(target, { force: true }); reject(new Error(`could not copy the file out of the engine: ${why}`)); };
    out.on("error", (e) => { child.kill(); reject(new Error(`could not write ${target}: ${e.message}`)); });
    child.on("error", (e) => failed(e.message));
    child.stdout!.pipe(out);
    child.on("close", (code) => { if (code !== 0) failed(`exit status ${code}`); else if (out.writableFinished) resolve(); else out.on("finish", () => resolve()); });
  });
}

/**
 * Stops an interface that is still serving inside the engine. Ending the command on this side
 * (Ctrl+C, a closed window) does not always reach the program in there.
 */
export function stopEngineUi(kind: EngineKind): void {
  inEngine(kind, ["sh", "-c", `if [ -f ${ENGINE_HOME}/ui.pid ]; then kill "$(cat ${ENGINE_HOME}/ui.pid)" 2>/dev/null; fi; true`]);
}

/** Runs a small command inside the engine; true when it succeeded. */
export function engineRun(kind: EngineKind, cmd: string[]): boolean {
  const r = inEngine(kind, cmd);
  return !r.error && r.status === 0;
}

/** A network's name or genesis hash becomes part of a file name inside the engine: nothing else may be in it. */
function checkNetworkId(id: string): void {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error(`"${id}" is not a network name`);
}

/** Copies a login made on this side (with a keypair file) into the engine. */
export function pushVault(kind: EngineKind, cluster: string): void {
  checkNetworkId(cluster);
  const file = path.join(paths.vault(), `${cluster}.json`);
  must(inEngine(kind, ["sh", "-c", `mkdir -p ${ENGINE_HOME}/vault && chmod 700 ${ENGINE_HOME}/vault && cat > ${ENGINE_HOME}/vault/${cluster}.json && chmod 600 ${ENGINE_HOME}/vault/${cluster}.json`], fs.readFileSync(file)), "copying the login into the engine");
}

/** Copies a login made inside the engine (with a browser wallet) to this side, for commands that run here. */
export function pullVault(kind: EngineKind, cluster: string): boolean {
  checkNetworkId(cluster);
  const mine = path.join(paths.vault(), `${cluster}.json`);
  const r = inEngine(kind, ["sh", "-c", `if [ -f ${ENGINE_HOME}/vault/${cluster}.json ]; then cat ${ENGINE_HOME}/vault/${cluster}.json; else exit 44; fi`]);
  // nobody is signed in inside the engine: a copy left on this side from an earlier login must not be used
  if (r.status === 44) { fs.rmSync(mine, { force: true }); return false; }
  if (r.status !== 0 || !r.stdout?.length) return false;
  try { JSON.parse(r.stdout.toString("utf8")); } catch { return false; }
  fs.mkdirSync(paths.vault(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.vault(), `${cluster}.json`), r.stdout, { mode: 0o600 });
  return true;
}

/**
 * Runs this same command line inside the engine and returns its exit status.
 * `watchForLinks` opens the first http://127.0.0.1 link the command prints in the browser of this computer.
 */
export function proxy(kind: EngineKind, argv: string[], watchForLinks: (url: string) => void = () => {}): Promise<number> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  // a mark on this command's processes in the engine, by which they are found again if the command here is ended
  const mark = createHash("sha256").update(`${process.pid} ${Date.now()} ${Math.random()}`).digest("hex").slice(0, 24);
  const env: Record<string, string> = { TERM: process.env.TERM || "xterm-256color", CHAINBOOT_UI_BIND: kind === "docker" || kind === "podman" ? "0.0.0.0" : "127.0.0.1", CHAINBOOT_PROXY: mark };
  // which ports a service in a machine can use to be reached from this computer's browser
  if (kind === "docker" || kind === "podman") env.CHAINBOOT_MACHINE_PORTS = passedPorts(kind) ?? "";
  if (process.env.NO_COLOR) env.NO_COLOR = "1";
  // settings that chainboot takes from the environment must arrive in the engine as well
  for (const k of ["CHAINBOOT_RPC", "CHAINBOOT_OFFLINE", "CHAINBOOT_AUTOSAVE_MINUTES", "CHAINBOOT_CARRIER", "CHAINBOOT_DEBUG"]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  if (process.stdin.isTTY) env.CHAINBOOT_UI_TERMINAL = "1";
  const p = [...prefix(kind, interactive, env), `${ENGINE_APP}/node`, `${ENGINE_APP}/app/chainboot.mjs`, ...argv];
  const wantsLink = ["ui", "login", "fund"].includes(argv[0] ?? "");
  return new Promise((resolve, reject) => {
    const child = spawn(p[0]!, p.slice(1), { stdio: wantsLink ? ["inherit", "pipe", "pipe"] : "inherit", windowsHide: true });
    if (wantsLink) {
      let opened = false;
      const tap = (out: NodeJS.WriteStream) => (chunk: Buffer) => {
        out.write(chunk);
        const m = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(chunk.toString("utf8"));
        if (m && !opened) { opened = true; watchForLinks(m[0]); }
      };
      child.stdout!.on("data", tap(process.stdout));
      child.stderr!.on("data", tap(process.stderr));
    }
    child.on("error", (e) => reject(new Error(`could not reach the engine: ${e.message}`)));
    child.on("close", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
    for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => {
      try { child.kill(s); } catch { /* already gone */ }
      // Without a terminal in between, ending the command here does not end the program in the
      // engine (a save would go on sending, and paying). It is told directly. (With a terminal,
      // Ctrl+C reaches it through that terminal, and may be meant for a program in a machine.)
      if (!interactive) inEngine(kind, ["sh", "-c", `for p in /proc/[0-9]*; do if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx "CHAINBOOT_PROXY=${mark}"; then kill -TERM "\${p#/proc/}" 2>/dev/null; fi; done; true`]);
    });
  });
}

/** Deletes the engine and everything inside it (machines included). */
export function removeEngine(kind: EngineKind): void {
  if (!exists(kind)) return;
  if (kind === "wsl") must(run("wsl.exe", ["--unregister", NAME]), "removing the WSL distribution");
  else if (kind === "lima") must(run("limactl", ["delete", "-f", NAME]), "removing the Lima machine");
  else { must(run(kind, ["rm", "-f", NAME]), "removing the engine container"); run(kind, ["volume", "rm", `${NAME}-data`]); }
  fs.rmSync(stateFile(), { force: true });
}
