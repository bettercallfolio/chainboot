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
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeTar, type Entry } from "../image/tar.ts";
import { homeDir, paths } from "../local/home.ts";

export type EngineKind = "wsl" | "docker" | "podman" | "lima";

const NAME = "chainboot";
const ENGINE_HOME = "/var/lib/chainboot";
const ENGINE_APP = "/opt/chainboot";
export const UI_PORT = 7717;

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
  if (kind === "wsl") return ["wsl.exe", "-d", NAME, "-u", "root", "--cd", "/", "--", "env", ...vars.map(([k, v]) => `${k}=${v}`)];
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

async function create(kind: EngineKind): Promise<void> {
  say("Setting up the Linux engine for chainboot (first run only).");
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
  must(run(kind, ["run", "-d", "--name", NAME, "--hostname", NAME, "--privileged", "--restart", "unless-stopped",
    "-v", `${NAME}-data:${ENGINE_HOME}`, "-p", `127.0.0.1:${UI_PORT}:${UI_PORT}`, image, "sleep", "infinity"]), "creating the engine container");
}

interface EngineState { kind: EngineKind; app: string; node: string; config: string }
const stateFile = () => path.join(homeDir(), "engine.json");
function readState(): EngineState | null { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as EngineState; } catch { return null; } }
function writeState(s: EngineState): void { fs.mkdirSync(homeDir(), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s)); }

/** Makes sure the engine exists, runs, and has this version of the program and the current settings. */
export async function ensureEngine(kind: EngineKind): Promise<void> {
  const fresh = !exists(kind);
  if (fresh) await create(kind);
  wake(kind);
  const state: EngineState = (!fresh && readState()?.kind === kind ? readState()! : { kind, app: "", node: "", config: "" });

  if (state.node !== NODE_VERSION || !works(prefix(kind, false)[0]!, [...prefix(kind, false).slice(1), `${ENGINE_APP}/node`, "--version"])) {
    const arch = engineArch(kind);
    const node = await download(`https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${arch}.tar.gz`, NODE_SHA[arch]!, `Node.js ${NODE_VERSION} for the engine (from nodejs.org)`);
    must(inEngine(kind, ["sh", "-c", `mkdir -p ${ENGINE_APP}/app ${ENGINE_HOME} && tar -xz -C ${ENGINE_APP} --strip-components=2 node-${NODE_VERSION}-linux-${arch}/bin/node`], node), "installing Node.js in the engine");
    // optional speed-up for unpacking large systems; the built-in decoder is used when this fails
    inEngine(kind, ["sh", "-c", "command -v xz >/dev/null 2>&1 || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xz-utils) >/dev/null 2>&1 || true"]);
    state.node = NODE_VERSION;
  }
  const app = ownApp();
  if (state.app !== app.id) {
    must(inEngine(kind, ["sh", "-c", `mkdir -p ${ENGINE_APP}/app.new && tar -x -C ${ENGINE_APP}/app.new && rm -rf ${ENGINE_APP}/app && mv ${ENGINE_APP}/app.new ${ENGINE_APP}/app`], app.tar), "copying chainboot into the engine");
    state.app = app.id;
  }
  // settings (network, RPC endpoints) are edited on this side and mirrored into the engine
  let config = "";
  try { config = fs.readFileSync(paths.config(), "utf8"); } catch { /* no settings yet */ }
  const configId = createHash("sha256").update(config).digest("hex");
  if (state.config !== configId && config) {
    must(inEngine(kind, ["sh", "-c", `mkdir -p ${ENGINE_HOME} && cat > ${ENGINE_HOME}/config.json && chmod 600 ${ENGINE_HOME}/config.json`], Buffer.from(config)), "copying settings into the engine");
    state.config = configId;
  }
  writeState(state);
  if (fresh) say("The engine is ready.");
}

/** Copies a login made on this side (with a keypair file) into the engine. */
export function pushVault(kind: EngineKind, cluster: string): void {
  const file = path.join(paths.vault(), `${cluster}.json`);
  must(inEngine(kind, ["sh", "-c", `mkdir -p ${ENGINE_HOME}/vault && chmod 700 ${ENGINE_HOME}/vault && cat > ${ENGINE_HOME}/vault/${cluster}.json && chmod 600 ${ENGINE_HOME}/vault/${cluster}.json`], fs.readFileSync(file)), "copying the login into the engine");
}

/** Copies a login made inside the engine (with a browser wallet) to this side, for commands that run here. */
export function pullVault(kind: EngineKind, cluster: string): boolean {
  const r = inEngine(kind, ["sh", "-c", `cat ${ENGINE_HOME}/vault/${cluster}.json 2>/dev/null`]);
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
  const env: Record<string, string> = { TERM: process.env.TERM || "xterm-256color", CHAINBOOT_UI_BIND: kind === "docker" || kind === "podman" ? "0.0.0.0" : "127.0.0.1" };
  if (process.env.NO_COLOR) env.NO_COLOR = "1";
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
    for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { try { child.kill(s); } catch { /* already gone */ } });
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
