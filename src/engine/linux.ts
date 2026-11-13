// The Linux engine: turns a downloaded image into a running system.
//
//   image (read-only)  +  machine's own layer (your changes)  =  the system you see
//        lowerdir                  upperdir                         overlay mount
//
// A machine runs inside its own mount, PID, hostname and IPC namespaces, with the host's
// network. It is a convenience boundary like `chroot`, not a security sandbox: root inside a
// machine is root on this computer.
//
// Everything here needs root (mounting, chroot, file owners), so the CLI re-runs itself
// through sudo for the `_engine` commands in this file.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { decompress } from "../codec/index.ts";
import { verifyPack } from "../image/build.ts";
import { extractImage } from "../image/extract.ts";
import { parseManifest, type ImageManifest } from "../image/manifest.ts";

export interface MachineInfo {
  name: string;
  image: {
    publisher: string; name: string; tag: string; arch: string; digest: string;
    /** Where the image's manifest is on chain, so the exact same image can be fetched again later. */
    manifest: { sig: string; sha256: string; size: number; codec: "xz" | "zstd" | "raw"; rawSize: number };
  };
  created: number;
}

export interface EngineHome { images: string; machines: string; cache: string }

const MACHINE_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export function checkMachineName(name: string): void {
  if (!MACHINE_RE.test(name)) throw new Error(`invalid machine name "${name}": use lower-case letters, digits, ".", "_" or "-"`);
}

export function machineDir(home: EngineHome, name: string): string { return path.join(home.machines, name); }

export function readMachine(home: EngineHome, name: string): MachineInfo | null {
  try { return JSON.parse(fs.readFileSync(path.join(machineDir(home, name), "machine.json"), "utf8")) as MachineInfo; } catch { return null; }
}

export function listMachines(home: EngineHome): (MachineInfo & { running: boolean })[] {
  let names: string[];
  try { names = fs.readdirSync(home.machines); } catch { return []; }
  return names.map((n) => readMachine(home, n)).filter((m): m is MachineInfo => !!m)
    .map((m) => ({ ...m, running: initPid(machineDir(home, m.name)) !== null }));
}

/** Tools the engine calls. All are part of util-linux / coreutils on every mainstream distribution. */
export const REQUIRED_TOOLS = ["unshare", "nsenter", "mount", "chroot", "flock", "hostname"];

export function missingTools(): string[] {
  return REQUIRED_TOOLS.filter((t) => spawnSync("sh", ["-c", `command -v ${t}`], { stdio: "ignore" }).status !== 0);
}

// ---------------------------------------------------------------- image on disk

export function imageRootfs(home: EngineHome, digest: string): string { return path.join(home.images, digest, "rootfs"); }
export function imageReady(home: EngineHome, digest: string): boolean { return fs.existsSync(path.join(home.images, digest, "complete")); }

/** Unpacks an image from the local cache into images/<digest>/rootfs (once). */
export function ensureExtracted(home: EngineHome, digest: string, say: (text: string) => void, progress?: (done: number, total: number) => void): void {
  if (imageReady(home, digest)) return;
  const dir = path.join(home.images, digest);
  let manifest: ImageManifest;
  try { manifest = parseManifest(fs.readFileSync(path.join(dir, "manifest.json"))); } catch (e) {
    throw new Error(`image ${digest.slice(0, 12)} is not downloaded: ${(e as Error).message}`);
  }
  if (manifest.digest !== digest) throw new Error("image directory does not match its manifest");
  const tmp = path.join(dir, "rootfs.tmp");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(dir, "rootfs"), { recursive: true, force: true });
  say(`Unpacking ${manifest.name}:${manifest.version}`);
  const packs = new Map<number, Buffer>();
  const pack = (i: number): Buffer => {
    let raw = packs.get(i);
    if (!raw) {
      const p = manifest.packs[i]!;
      let stored: Buffer;
      try { stored = fs.readFileSync(path.join(home.cache, "objects", p.sha256)); } catch { throw new Error(`pack ${i + 1} of ${manifest.name} is not in the cache; run "chainboot pull" again`); }
      raw = decompress(p.codec, stored, p.rawSize);
      verifyPack(manifest, i, raw);
      packs.set(i, raw);
    }
    return raw;
  };
  const result = extractImage(manifest, pack, tmp, progress);
  for (const s of result.skipped.slice(0, 5)) say(`note: could not create ${s}`);
  fs.renameSync(tmp, path.join(dir, "rootfs"));
  fs.writeFileSync(path.join(dir, "complete"), `${new Date().toISOString()}\n`);
}

// ---------------------------------------------------------------- running machines

/** Start time of a process in clock ticks since boot (field 22 of /proc/<pid>/stat); readable by any user. */
function startTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null; // fields after "(comm)" start at field 3
  } catch { return null; }
}

/** Host PID of a running machine's init process, or null. */
export function initPid(dir: string): number | null {
  let pid: number, started: string | undefined;
  try { [pid, started] = fs.readFileSync(path.join(dir, "pid"), "utf8").trim().split(" ").map((x, i) => (i === 0 ? Number(x) : x)) as [number, string | undefined]; } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 1 || !started) return null;
  // a PID can be reused by an unrelated process after the machine stopped; its start time cannot
  return startTime(pid) === started ? pid : null;
}

// Runs as PID 1 of the machine's namespaces: builds the file system view, then waits until the last session leaves.
const INIT_SCRIPT = String.raw`
set -eu
fail() { echo "$1" > "$CB_DIR/failed"; exit 1; }
trap 'fail "machine setup failed (see above)"' EXIT
mount --make-rprivate /
M="$CB_DIR/merged"
mount -t overlay overlay -o "lowerdir=$CB_LOWER,upperdir=$CB_DIR/upper,workdir=$CB_DIR/work" "$M"
mkdir -p "$M/proc" "$M/sys" "$M/dev" "$M/run" "$M/tmp" "$M/etc"
mount -t proc -o nosuid,nodev,noexec proc "$M/proc"
mount -t sysfs -o ro,nosuid,nodev,noexec sysfs "$M/sys" 2>/dev/null || mount --rbind /sys "$M/sys"
mount -t tmpfs -o mode=755,nosuid,size=4m tmpfs "$M/dev"
for d in null zero full random urandom tty ptmx; do
  [ -e "/dev/$d" ] || continue
  : > "$M/dev/$d"; mount --bind "/dev/$d" "$M/dev/$d"
done
mkdir -p "$M/dev/pts" "$M/dev/shm"
mount --bind /dev/pts "$M/dev/pts"
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$M/dev/shm"
ln -s /proc/self/fd "$M/dev/fd"
ln -s /proc/self/fd/0 "$M/dev/stdin"; ln -s /proc/self/fd/1 "$M/dev/stdout"; ln -s /proc/self/fd/2 "$M/dev/stderr"
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$M/run"
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$M/tmp"
for f in resolv.conf hosts hostname; do
  if [ -L "$M/etc/$f" ] || [ ! -e "$M/etc/$f" ]; then rm -f "$M/etc/$f"; : > "$M/etc/$f"; fi
  mount --bind "$CB_DIR/etc/$f" "$M/etc/$f"
done
hostname "$CB_NAME"
# things every machine needs for itself and images therefore do not carry
if [ -e "$M/etc/machine-id" ] && [ ! -s "$M/etc/machine-id" ]; then
  (cat /proc/sys/kernel/random/uuid | tr -d - > "$M/etc/machine-id") 2>/dev/null || true
fi
if [ -x "$M/usr/bin/ssh-keygen" ] && [ -d "$M/etc/ssh" ] && ! ls "$M"/etc/ssh/ssh_host_*_key >/dev/null 2>&1; then
  chroot "$M" /usr/bin/ssh-keygen -A >/dev/null 2>&1 || true
fi
trap - EXIT
: > "$CB_DIR/ready"
# an optional start-up script inside the machine, for services that should come up with it
if [ -x "$M/etc/chainboot/start" ]; then
  (chroot "$M" /bin/sh -c 'cd /; exec /etc/chainboot/start' > "$CB_DIR/start.log" 2>&1 &)
fi
# wait for the first session, then stay for as long as any session holds the lock.
# The machine lingers a moment after the last session, so commands that follow each other reuse it.
n=0
while [ ! -e "$CB_DIR/attached" ] && [ ! -e "$CB_DIR/keep" ] && [ "$n" -lt 120 ]; do sleep 0.25; n=$((n+1)); done
free=0
while [ "$free" -lt 4 ] || [ -e "$CB_DIR/keep" ]; do
  if flock -n -x "$CB_DIR/lock" true 2>/dev/null; then free=$((free+1)); else free=0; fi
  sleep 0.5
done
`;

function hostResolvConf(): string {
  try {
    const text = fs.readFileSync("/etc/resolv.conf", "utf8");
    if (/^\s*nameserver\s+\S+/m.test(text)) return text; // the machine shares the host's network, so even a local stub resolver works
  } catch { /* fall through */ }
  return "nameserver 1.1.1.1\nnameserver 8.8.8.8\n";
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Starts the machine's namespaces if they are not up yet and returns the init PID. */
export function startMachine(home: EngineHome, name: string, say: (text: string) => void, progress?: (done: number, total: number) => void, keep = false): number {
  const dir = machineDir(home, name);
  const info = readMachine(home, name);
  if (!info) throw new Error(`there is no machine named "${name}"`);
  const missing = missingTools();
  if (missing.length) throw new Error(`these tools are needed but not installed: ${missing.join(", ")} (package util-linux / coreutils)`);

  // only one process may decide to start the machine
  const lock = path.join(dir, "start.lock");
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmdirSync(lock); } catch { /* raced with its owner */ }
      if (i > 240) throw new Error(`machine "${name}" is being started by another process`);
      sleepMs(250);
    }
  }
  try {
    const running = initPid(dir);
    if (running) { if (keep) fs.writeFileSync(path.join(dir, "keep"), ""); return running; }
    ensureExtracted(home, info.image.digest, say, progress);
    const lower = imageRootfs(home, info.image.digest);
    if (/[,:\\]/.test(lower + dir)) throw new Error(`the chainboot directory path may not contain "," ":" or "\\" (${home.machines})`);
    for (const d of ["upper", "work", "merged", "etc"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
    for (const f of ["ready", "failed", "attached", "pid"]) fs.rmSync(path.join(dir, f), { force: true });
    if (keep) fs.writeFileSync(path.join(dir, "keep"), ""); else fs.rmSync(path.join(dir, "keep"), { force: true });
    fs.writeFileSync(path.join(dir, "lock"), "");
    fs.writeFileSync(path.join(dir, "etc", "resolv.conf"), hostResolvConf());
    fs.writeFileSync(path.join(dir, "etc", "hostname"), `${name}\n`);
    fs.writeFileSync(path.join(dir, "etc", "hosts"), `127.0.0.1 localhost ${name}\n::1 localhost ip6-localhost ip6-loopback\n`);

    const log = fs.openSync(path.join(dir, "init.log"), "w");
    const child = spawn("unshare", ["--mount", "--uts", "--ipc", "--pid", "--fork", "--kill-child", "sh", "-c", INIT_SCRIPT], {
      detached: true, stdio: ["ignore", log, log],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", CB_DIR: dir, CB_LOWER: lower, CB_NAME: name },
    });
    child.unref();
    fs.closeSync(log);
    const unsharePid = child.pid;
    if (!unsharePid) throw new Error("could not start the machine (unshare did not run)");
    for (let i = 0; i < 200; i++) {
      if (fs.existsSync(path.join(dir, "ready"))) break;
      let dead = false;
      try { process.kill(unsharePid, 0); } catch { dead = true; }
      if (fs.existsSync(path.join(dir, "failed")) || dead) {
        const why = fs.readFileSync(path.join(dir, "init.log"), "utf8").trim().split("\n").slice(-4).join("\n");
        throw new Error(`could not start machine "${name}":\n${why || "the setup process stopped without a message"}`);
      }
      sleepMs(50);
    }
    if (!fs.existsSync(path.join(dir, "ready"))) throw new Error(`machine "${name}" did not come up in time`);
    // PID 1 of the new namespace is the child of `unshare`
    const kids = fs.readFileSync(`/proc/${unsharePid}/task/${unsharePid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    const pid = Number(kids[0]);
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`machine "${name}" started but its init process was not found`);
    fs.writeFileSync(path.join(dir, "pid"), `${pid} ${startTime(pid)}\n`);
    return pid;
  } finally {
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
}

/** Runs a command inside a (started) machine with the caller's terminal. Returns its exit status. */
export function enterMachine(home: EngineHome, name: string, pid: number, command: string[], extraEnv: Record<string, string> = {}): number {
  const dir = machineDir(home, name), merged = path.join(dir, "merged");
  let cmd = command;
  if (!cmd.length) {
    const info = readMachine(home, name);
    let manifest: ImageManifest | null = null;
    try { manifest = info ? parseManifest(fs.readFileSync(path.join(home.images, info.image.digest, "manifest.json"))) : null; } catch { /* default shell */ }
    // the merged view exists only inside the machine's namespaces, so look in its two layers instead
    const has = (p: string) => !!info && [path.join(dir, "upper"), imageRootfs(home, info.image.digest)].some((layer) => { try { return fs.statSync(path.join(layer, p)).isFile(); } catch { return false; } });
    const shell = has("usr/bin/bash") || has("bin/bash") ? "/bin/bash" : "/bin/sh";
    // a login shell that starts in the home directory, like a fresh SSH session
    cmd = manifest?.config?.cmd ?? ["/bin/sh", "-c", `cd "$HOME" 2>/dev/null; exec ${shell} -l`];
  }
  fs.writeFileSync(path.join(dir, "attached"), "");
  const env: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/root", USER: "root", LOGNAME: "root", LANG: "C.UTF-8", container: "chainboot",
    TERM: process.env.TERM || "xterm-256color",
    ...extraEnv,
  };
  // the shared lock tells the machine's init that a session is alive; it is released even if we are killed
  const r = spawnSync("flock", ["-s", path.join(dir, "lock"), "nsenter", "--target", String(pid), "--mount", "--uts", "--ipc", "--pid", "--", "chroot", merged, ...cmd], { stdio: "inherit", env });
  if (r.error) throw new Error(`could not enter machine "${name}": ${r.error.message}`);
  return r.status ?? (r.signal ? 128 : 1);
}

export function stopMachine(home: EngineHome, name: string): boolean {
  const dir = machineDir(home, name);
  const pid = initPid(dir);
  fs.rmSync(path.join(dir, "keep"), { force: true });
  if (!pid) return false;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  for (let i = 0; i < 100 && initPid(dir); i++) sleepMs(50);
  fs.rmSync(path.join(dir, "pid"), { force: true });
  return true;
}

export function removeMachine(home: EngineHome, name: string): void {
  const dir = machineDir(home, name);
  if (!fs.existsSync(dir)) throw new Error(`there is no machine named "${name}"`);
  stopMachine(home, name);
  sleepMs(200); // let the kernel drop the machine's mounts
  fs.rmSync(dir, { recursive: true, force: true });
}

export function removeImage(home: EngineHome, digest: string): void {
  const used = listMachines(home).filter((m) => m.image.digest === digest).map((m) => m.name);
  if (used.length) throw new Error(`image is used by machine(s): ${used.join(", ")}. Remove them first.`);
  fs.rmSync(path.join(home.images, digest), { recursive: true, force: true });
}
