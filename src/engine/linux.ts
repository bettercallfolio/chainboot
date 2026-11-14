// The Linux engine: turns a downloaded image into a running system.
//
//   image (read-only)  +  machine's own layer (your changes)  =  the system you see
//        lowerdir                  upperdir                         overlay mount
//
// A machine runs inside its own mount, PID, hostname and IPC namespaces, with the host's
// network. It is a convenience boundary like `chroot`, not a security sandbox: root inside a
// machine is root on this computer.
//
// Everything here needs the rights of user 0 (mounting, chroot, file owners), so the CLI re-runs
// itself for the `_engine` commands in this file: through sudo, or, without administrator
// rights, inside a user namespace (see rootless.ts).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { decompress } from "../codec/index.ts";
import { verifyPack } from "../image/build.ts";
import { extractImage } from "../image/extract.ts";
import { parseManifest, type ImageManifest } from "../image/manifest.ts";
import { loadConfig, paths } from "../local/home.ts";
import { loadVault, openEither } from "../state/vault.ts";
import { imageHas, lazyLower } from "./lazy.ts";
import { inUserNs } from "./rootless.ts";

export interface MachineInfo {
  name: string;
  image: {
    publisher: string; name: string; tag: string; arch: string; digest: string;
    /** True for a private image: only the wallet that published it can fetch and unpack it. */
    private?: boolean;
    /** Where the image's manifest is on chain, so the exact same image can be fetched again later. */
    manifest: { sig: string; sha256: string; size: number; codec: "xz" | "zstd" | "raw"; rawSize: number; /** key of the manifest of an image that was shared with this wallet (base64) */ key?: string };
  };
  created: number;
  /**
   * True for a machine that boots: its image's own init (systemd) runs as the first process and
   * starts the system's services, like on a server. It stays up until it is stopped.
   */
  boot?: boolean;
  /**
   * True for a lazy machine: its image is not unpacked. A file's content is fetched from the
   * chain when a program first opens it.
   */
  lazy?: boolean;
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
      if (p.enc) {
        // a private image: its packs open with their own keys from the manifest (an image that was
        // shared, or published by a current version), or with the login of the wallet that published it
        const vault = p.key ? null : loadVault(paths.vault(), loadConfig().cluster);
        if (!p.key && !vault) throw new Error(`${manifest.name} is a private image: sign in with the wallet that published it (chainboot login)`);
        stored = openEither(vault?.encKey, p.key, stored, "pack");
      }
      raw = decompress(p.codec, stored, p.rawSize);
      verifyPack(manifest, i, raw);
      packs.set(i, raw);
    }
    return raw;
  };
  const result = extractImage(manifest, pack, tmp, progress);
  for (const s of result.skipped.slice(0, 5)) say(`note: could not set up ${s}`);
  fs.renameSync(tmp, path.join(dir, "rootfs"));
  fs.writeFileSync(path.join(dir, "complete"), `${new Date().toISOString()}\n`);
}

// ---------------------------------------------------------------- running machines

/** Start time of a live process in clock ticks since boot (field 22 of /proc/<pid>/stat); readable by any user. */
function startTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // the fields after "(comm)" start at field 3, the state
    if (fields[0] === "Z" || fields[0] === "X") return null; // ended, only not collected by its parent yet
    return fields[19] ?? null;
  } catch { return null; }
}

/** Host PID of a running machine's init process, or null. */
export function initPid(dir: string): number | null {
  return readPid(path.join(dir, "pid"));
}

// Runs as PID 1 of the machine's namespaces: builds the file system view, then waits until the last session leaves.
const INIT_SCRIPT = String.raw`
set -eu
fail() { echo "$1" > "$CB_DIR/failed"; exit 1; }
trap 'fail "machine setup failed (see above)"' EXIT
mount --make-rprivate /
M="$CB_DIR/merged"
mount -t overlay overlay -o "lowerdir=$CB_LOWER,upperdir=$CB_DIR/upper,workdir=$CB_DIR/work$CB_OVERLAY" "$M"
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

// For a lazy machine: starts the process that shows the image as a file system at $CB_LOWER and
// waits until it is there. "$CB_DIR/lazy.sh" runs chainboot's own program; it is given the PID
// of this shell, which is the process the machine's namespaces hang on, and ends when that does.
const LAZY_START = String.raw`
if [ -n "$CB_LAZY" ]; then
  rm -f "$CB_DIR/lower.ready"
  sh "$CB_DIR/lazy.sh" $$ </dev/null >>"$CB_DIR/lazy.log" 2>&1 &
  n=0
  while [ ! -e "$CB_DIR/lower.ready" ]; do
    [ ! -e "$CB_DIR/failed" ] || exit 1
    n=$((n+1)); [ "$n" -le 600 ] || { echo "the image could not be shown as a file system in time (see lazy.log)" > "$CB_DIR/failed"; exit 1; }
    sleep 0.05
  done
fi`;

// Wrapper around INIT_SCRIPT for a lazy machine that does not boot: the image's file system has
// to be served from outside the machine's process namespace, so the mount namespace is made
// first, the server started in it, and only then the other namespaces with the init in them.
const LAZY_PLAIN_SCRIPT = String.raw`
set -eu
mount --make-rprivate /
${LAZY_START}
exec unshare --uts --ipc --pid --fork --kill-child sh "$CB_DIR/init.sh"
`;

// ---------------------------------------------------------------- machines that boot
//
// Two processes, because two views of the file system are needed:
//   the holder   keeps a mount namespace in which the machine's files are at their path on this
//                computer (saving and restoring work there), and waits for the machine to end;
//   the init     PID 1 of the machine's own namespaces: sets up /proc, /dev and so on, then
//                becomes the image's /sbin/init.

const BOOT_HOLDER_SCRIPT = String.raw`
set -eu
fail() { echo "$1" > "$CB_DIR/failed"; exit 1; }
trap 'fail "machine setup failed (see above)"' EXIT
mount --make-rprivate /
${LAZY_START}
mount -t overlay overlay -o "lowerdir=$CB_LOWER,upperdir=$CB_DIR/upper,workdir=$CB_DIR/work$CB_OVERLAY" "$CB_DIR/merged"
# a control group of its own, which the machine's init manages from here on
[ -e /sys/fs/cgroup/cgroup.controllers ] || fail "a machine that boots needs cgroup v2, which this computer does not use"
OWN="/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)"
case "$OWN" in */run-*.scope) CG="$OWN/machine" ;; *) CG="/sys/fs/cgroup/chainboot-$CB_NAME" ;; esac
mkdir -p "$CG" 2>/dev/null || fail "could not create a control group for the machine ($CG)"
( echo 0 > "$CG/cgroup.procs" && exec unshare --cgroup --mount --uts --ipc --pid $CB_NETFLAG --fork --kill-child sh "$CB_DIR/init.sh" ) &
U=$!
n=0
while [ ! -e "$CB_DIR/booted" ]; do
  [ ! -e "$CB_DIR/failed" ] || exit 1
  kill -0 "$U" 2>/dev/null || fail "the machine's first process stopped during setup (see above)"
  n=$((n+1)); [ "$n" -le 600 ] || fail "the machine's setup did not finish in time"
  sleep 0.05
done
I=$(tr -d ' \n' < "/proc/$U/task/$U/children")
[ -n "$I" ] || fail "the machine's first process was not found"
if [ -n "$CB_NETFLAG" ]; then
  # the machine's own network: pasta carries its traffic through ordinary sockets of this computer.
  # Ports a program opens in the machine are opened on this computer too (where it is allowed to).
  pasta --quiet --config-net --netns "/proc/$I/ns/net" --netns-only -t auto -u auto -T none -U none \
    || fail "could not connect the machine's network (pasta failed, see above)"
fi
echo "$I" > "$CB_DIR/init.pid"
: > "$CB_DIR/go"
trap - EXIT
: > "$CB_DIR/ready"
wait "$U" || true
find "$CG" -depth -type d -exec rmdir {} \; 2>/dev/null || true
`;

const BOOT_INIT_SCRIPT = String.raw`
set -eu
fail() { echo "$1" > "$CB_DIR/failed"; exit 1; }
trap 'fail "machine setup failed (see above)"' EXIT
mount --make-rprivate /
M="$CB_DIR/merged"
[ -x "$M/sbin/init" ] || [ -L "$M/sbin/init" ] || fail "this image has no /sbin/init, so it cannot boot. Run it without --boot."
mkdir -p "$M/proc" "$M/sys" "$M/dev" "$M/run" "$M/tmp" "$M/etc"
mount -t proc -o nosuid,nodev,noexec proc "$M/proc"
# read-only /sys tells the system that hardware is not its to manage
mount -t sysfs -o ro,nosuid,nodev,noexec sysfs "$M/sys" 2>/dev/null || { mount --rbind /sys "$M/sys"; mount -o remount,ro,bind "$M/sys"; }
mount -t cgroup2 -o nosuid,nodev,noexec cgroup2 "$M/sys/fs/cgroup"
mount -t tmpfs -o mode=755,nosuid,size=4m tmpfs "$M/dev"
for d in null zero full random urandom tty; do
  [ -e "/dev/$d" ] || continue
  : > "$M/dev/$d"; mount --bind "/dev/$d" "$M/dev/$d"
done
mkdir -p "$M/dev/pts" "$M/dev/shm"
if [ -n "$CB_SYSTEMD" ]; then
  # terminals of its own: sessions get theirs from the machine's systemd, and so does its SSH server
  mount -t devpts -o newinstance,ptmxmode=0666,mode=620,gid=5 devpts "$M/dev/pts"
  ln -s pts/ptmx "$M/dev/ptmx"
else
  : > "$M/dev/ptmx"; mount --bind /dev/ptmx "$M/dev/ptmx"
  mount --bind /dev/pts "$M/dev/pts"
fi
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$M/dev/shm"
ln -s /proc/self/fd "$M/dev/fd"
ln -s /proc/self/fd/0 "$M/dev/stdin"; ln -s /proc/self/fd/1 "$M/dev/stdout"; ln -s /proc/self/fd/2 "$M/dev/stderr"
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$M/run"
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$M/tmp"
# the system log lives in memory: a log that grows on disk would be uploaded again with every save
mkdir -p "$M/run/systemd/journald.conf.d"
printf '[Journal]\nStorage=volatile\n' > "$M/run/systemd/journald.conf.d/chainboot.conf"
for f in resolv.conf hosts hostname; do
  if [ -L "$M/etc/$f" ] || [ ! -e "$M/etc/$f" ]; then rm -f "$M/etc/$f"; : > "$M/etc/$f"; fi
  mount --bind "$CB_DIR/etc/$f" "$M/etc/$f"
done
# this computer's kernel settings are not the machine's to change (those of its own network are)
mount --bind "$M/proc/sys" "$M/proc/sys"; mount -o remount,ro,bind "$M/proc/sys"
[ -z "$CB_NETFLAG" ] || mount --bind /proc/sys/net "$M/proc/sys/net"
if [ -e "$M/proc/sysrq-trigger" ]; then mount --bind "$M/proc/sysrq-trigger" "$M/proc/sysrq-trigger"; mount -o remount,ro,bind "$M/proc/sysrq-trigger"; fi
hostname "$CB_NAME"
if [ -e "$M/etc/machine-id" ] && [ ! -s "$M/etc/machine-id" ]; then
  (cat /proc/sys/kernel/random/uuid | tr -d - > "$M/etc/machine-id") 2>/dev/null || true
fi
if [ -x "$M/usr/bin/ssh-keygen" ] && [ -d "$M/etc/ssh" ] && ! ls "$M"/etc/ssh/ssh_host_*_key >/dev/null 2>&1; then
  chroot "$M" /usr/bin/ssh-keygen -A >/dev/null 2>&1 || true
fi
: > "$CB_DIR/booted"
# the holder connects the network, then lets the system start
n=0
while [ ! -e "$CB_DIR/go" ] && [ "$n" -lt 600 ]; do sleep 0.05; n=$((n+1)); done
trap - EXIT
# what a system inside a machine has no business doing to this computer: its clock, its kernel
# modules, its raw hardware; and its network settings when the machine shares its network
DROP="-sys_module,-sys_time,-sys_rawio,-syslog,-wake_alarm,-mac_admin,-mac_override,-sys_pacct"
[ -n "$CB_NETFLAG" ] || DROP="$DROP,-net_admin"
if command -v setpriv >/dev/null 2>&1; then
  exec env -i container=chainboot PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin setpriv --bounding-set "$DROP" chroot "$M" /sbin/init
fi
exec env -i container=chainboot PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin chroot "$M" /sbin/init
`;

/** SIGRTMIN+4: asks systemd to shut the system down in an orderly way. */
const SIG_POWEROFF = 38;

function readPid(file: string): number | null {
  let pid: number, started: string | undefined;
  try { [pid, started] = fs.readFileSync(file, "utf8").trim().split(" ").map((x, i) => (i === 0 ? Number(x) : x)) as [number, string | undefined]; } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 1 || !started) return null;
  // a PID can be reused by an unrelated process after the machine stopped; its start time cannot
  return startTime(pid) === started ? pid : null;
}

/**
 * The process in whose mount namespace the machine's files are at their path on this computer:
 * the holder of a machine that boots, the init process of any other.
 */
export function holderPid(dir: string): number | null {
  return readPid(path.join(dir, "holder")) ?? initPid(dir);
}

/** How a running machine was started: "systemd" or "init" for one that booted, null otherwise. */
export function bootKind(dir: string): "systemd" | "init" | null {
  try {
    const k = fs.readFileSync(path.join(dir, "boot"), "utf8").trim();
    return k === "systemd" || k === "init" ? k : null;
  } catch { return null; }
}

const hasTool = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;

/** Name servers a machine with its own network can reach (this computer's local resolver is not one of them). */
function upstreamResolvConf(): string {
  for (const file of ["/etc/resolv.conf", "/run/systemd/resolve/resolv.conf"]) {
    try {
      const servers = [...fs.readFileSync(file, "utf8").matchAll(/^\s*nameserver\s+(\S+)/gm)].map((m) => m[1]!).filter((a) => !a.startsWith("127.") && a !== "::1");
      if (servers.length) return [...new Set(servers)].map((a) => `nameserver ${a}\n`).join("");
    } catch { /* next */ }
  }
  return "nameserver 1.1.1.1\nnameserver 8.8.8.8\n";
}

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

export interface StartOptions {
  /** Keep the machine up after the last session leaves (machines that boot always stay up). */
  keep?: boolean;
  say?: (text: string) => void;
  progress?: (done: number, total: number) => void;
}

/** Takes the lock that lets one process at a time start a machine or mount its files. */
function lockStart(dir: string, name: string): () => void {
  const lock = path.join(dir, "start.lock"), owner = path.join(lock, "owner");
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; } catch {
      // left behind by a process that is gone: its owner is no longer alive (or it never wrote one)
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(owner, "utf8"));
        try { process.kill(pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === "ESRCH"; }
      } catch {
        try { stale = Date.now() - fs.statSync(lock).mtimeMs > 10_000; } catch { /* raced with its owner */ }
      }
      if (stale) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (i > 2400) throw new Error(`machine "${name}" is busy in another process (starting, saving or restoring)`);
      sleepMs(250);
    }
  }
  try { fs.writeFileSync(owner, String(process.pid)); } catch { /* the lock still holds for a moment */ }
  return () => { fs.rmSync(lock, { recursive: true, force: true }); };
}

/** Unpacks the image if needed, creates the machine's directories and returns what a mount needs. */
function prepare(home: EngineHome, info: MachineInfo, opts: StartOptions): { dir: string; lower: string; overlay: string; lazy: string } {
  const dir = machineDir(home, info.name);
  // a lazy machine's image is not unpacked: a server process shows it at <machine>/lower (see lazy.ts)
  if (!info.lazy) ensureExtracted(home, info.image.digest, opts.say ?? (() => {}), opts.progress);
  const lower = machineLower(home, info);
  if (/[,:\\]/.test(lower + dir)) throw new Error(`the chainboot directory path may not contain "," ":" or "\\" (${home.machines})`);
  for (const d of ["upper", "work", "merged", "etc", ...(info.lazy ? ["lower"] : [])]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  if (info.lazy) {
    for (const f of ["lower.ready", "failed"]) fs.rmSync(path.join(dir, f), { force: true });
    // chainboot's own program, as it runs now, started again as the image server
    const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
    // (CHAINBOOT_SELF names the program when the engine is used as a library, as the tests do)
    const self = [process.execPath, ...process.execArgv.filter((x) => !x.startsWith("--test")), process.env.CHAINBOOT_SELF ?? process.argv[1]!, "_engine", path.dirname(home.images), "", "lazy-serve", info.name].map(quote).join(" ");
    fs.writeFileSync(path.join(dir, "lazy.sh"), `exec env UV_THREADPOOL_SIZE=12 ${self} "$1"\n`);
  }
  // inside a user namespace the overlay keeps its own notes in "user." attributes, the only kind allowed there
  return { dir, lower, overlay: inUserNs() ? ",userxattr" : "", lazy: info.lazy ? "1" : "" };
}

/** Where a machine's image is found as a directory tree: the unpacked copy, or, for a lazy machine, the place its server shows it. */
export function machineLower(home: EngineHome, info: MachineInfo): string {
  return info.lazy ? lazyLower(machineDir(home, info.name)) : imageRootfs(home, info.image.digest);
}

/** True when a file exists in the machine (in its own layer or in its image). */
function machineHas(home: EngineHome, info: MachineInfo, file: string): boolean {
  const inLayer = (layer: string) => { try { const st = fs.lstatSync(path.join(layer, file)); return st.isFile() || st.isSymbolicLink(); } catch { return false; } };
  if (inLayer(path.join(machineDir(home, info.name), "upper"))) return true;
  // a lazy machine's image is not on disk as files; its manifest says what it contains
  return info.lazy ? imageHas(home, info.image.digest, file) : inLayer(imageRootfs(home, info.image.digest));
}

function waitReady(dir: string, name: string, pid: number, timeoutMs: number): void {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (fs.existsSync(path.join(dir, "ready"))) return;
    let dead = false;
    try { process.kill(pid, 0); } catch { dead = true; }
    if (fs.existsSync(path.join(dir, "failed")) || dead) {
      const log = fs.readFileSync(path.join(dir, "init.log"), "utf8").trim().split("\n").slice(-4).join("\n");
      let why = "";
      try { why = fs.readFileSync(path.join(dir, "failed"), "utf8").trim(); } catch { /* no reason was written */ }
      throw new Error(`could not start machine "${name}":\n${[log, why].filter(Boolean).join("\n") || "the setup process stopped without a message"}`);
    }
    sleepMs(50);
  }
  throw new Error(`machine "${name}" did not come up in time`);
}

/** Starts the machine's namespaces if they are not up yet and returns the init PID. */
export function startMachine(home: EngineHome, name: string, opts: StartOptions = {}): number {
  const dir = machineDir(home, name);
  const info = readMachine(home, name);
  if (!info) throw new Error(`there is no machine named "${name}"`);
  const missing = missingTools();
  if (missing.length) throw new Error(`these tools are needed but not installed: ${missing.join(", ")} (package util-linux / coreutils)`);
  const keep = !!opts.keep;

  const unlock = lockStart(dir, name);
  try {
    const running = initPid(dir);
    if (running) { if (keep) fs.writeFileSync(path.join(dir, "keep"), ""); return running; }
    const { lower, overlay, lazy } = prepare(home, info, opts);
    for (const f of ["ready", "failed", "attached", "pid", "holder", "boot", "netns", "booted", "go", "init.pid"]) fs.rmSync(path.join(dir, f), { force: true });
    if (keep) fs.writeFileSync(path.join(dir, "keep"), ""); else fs.rmSync(path.join(dir, "keep"), { force: true });
    fs.writeFileSync(path.join(dir, "lock"), "");
    fs.writeFileSync(path.join(dir, "etc", "hostname"), `${name}\n`);
    fs.writeFileSync(path.join(dir, "etc", "hosts"), `127.0.0.1 localhost ${name}\n::1 localhost ip6-localhost ip6-loopback\n`);
    const env: Record<string, string> = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", CB_DIR: dir, CB_LOWER: lower, CB_NAME: name, CB_OVERLAY: overlay, CB_LAZY: lazy };
    const log = fs.openSync(path.join(dir, "init.log"), "w");
    let pid: number;
    try {
      if (info.boot) {
        // without administrator rights a machine gets a network of its own when pasta is installed:
        // there its services may use every port. As root it shares this computer's network.
        const ownNet = inUserNs() && hasTool("pasta");
        const systemd = machineHas(home, info, "usr/bin/systemd-run");
        if (!inUserNs() && !hasTool("setpriv")) throw new Error("a machine that boots needs the `setpriv` tool (package util-linux or setpriv)");
        fs.writeFileSync(path.join(dir, "etc", "resolv.conf"), ownNet ? upstreamResolvConf() : hostResolvConf());
        fs.writeFileSync(path.join(dir, "holder.sh"), BOOT_HOLDER_SCRIPT);
        fs.writeFileSync(path.join(dir, "init.sh"), BOOT_INIT_SCRIPT);
        const child = spawn("unshare", ["--mount", "sh", path.join(dir, "holder.sh")], {
          detached: true, stdio: ["ignore", log, log],
          env: { ...env, CB_NETFLAG: ownNet ? "--net" : "", CB_SYSTEMD: systemd ? "1" : "" },
        });
        child.unref();
        const holder = child.pid;
        if (!holder) throw new Error("could not start the machine (unshare did not run)");
        waitReady(dir, name, holder, 60_000);
        pid = Number(fs.readFileSync(path.join(dir, "init.pid"), "utf8"));
        if (!Number.isInteger(pid) || pid <= 1) throw new Error(`machine "${name}" started but its init process was not found`);
        fs.writeFileSync(path.join(dir, "holder"), `${holder} ${startTime(holder)}\n`);
        fs.writeFileSync(path.join(dir, "boot"), systemd ? "systemd\n" : "init\n");
        if (ownNet) fs.writeFileSync(path.join(dir, "netns"), "");
      } else {
        fs.writeFileSync(path.join(dir, "etc", "resolv.conf"), hostResolvConf());
        // from a file, so that the process list inside the machine shows a short line for PID 1
        fs.writeFileSync(path.join(dir, "init.sh"), INIT_SCRIPT);
        // a lazy machine gets its mount namespace first, with the image server in it; see LAZY_PLAIN_SCRIPT
        if (lazy) fs.writeFileSync(path.join(dir, "lazy-start.sh"), LAZY_PLAIN_SCRIPT);
        const child = spawn("unshare", lazy ? ["--mount", "sh", path.join(dir, "lazy-start.sh")] : ["--mount", "--uts", "--ipc", "--pid", "--fork", "--kill-child", "sh", path.join(dir, "init.sh")], {
          detached: true, stdio: ["ignore", log, log], env,
        });
        child.unref();
        const unsharePid = child.pid;
        if (!unsharePid) throw new Error("could not start the machine (unshare did not run)");
        waitReady(dir, name, unsharePid, lazy ? 40_000 : 10_000);
        // PID 1 of the new namespace is the child of `unshare` (for a lazy machine the image server
        // is a child too: the init is the one that lives in another process namespace than we do)
        const kids = fs.readFileSync(`/proc/${unsharePid}/task/${unsharePid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
        const pidNs = (p: string) => { try { return fs.readlinkSync(`/proc/${p}/ns/pid`); } catch { return ""; } };
        pid = Number(kids.find((k) => pidNs(k) && pidNs(k) !== pidNs("self")) ?? kids[0]);
        if (!Number.isInteger(pid) || pid <= 1) throw new Error(`machine "${name}" started but its init process was not found`);
      }
    } finally {
      fs.closeSync(log);
    }
    fs.writeFileSync(path.join(dir, "pid"), `${pid} ${startTime(pid)}\n`);
    return pid;
  } finally {
    unlock();
  }
}

/**
 * Runs `command` (a program of this computer) where the machine's files are at their path:
 * in the running machine's mount namespace, or, for a machine that boots and is stopped, in a
 * mount namespace made for this one command (so that saving or restoring does not boot it).
 */
export function inMachineFiles(home: EngineHome, name: string, command: string[], stdio: "inherit" | "ignore" = "inherit"): number {
  const dir = machineDir(home, name);
  const info = readMachine(home, name);
  if (!info) throw new Error(`there is no machine named "${name}"`);
  const withLock = (pid: number) => {
    fs.writeFileSync(path.join(dir, "attached"), "");
    const r = spawnSync("flock", ["-s", path.join(dir, "lock"), "nsenter", "--target", String(pid), "--mount", "--", ...command], { stdio });
    if (r.error) throw new Error(`could not enter machine "${name}": ${r.error.message}`);
    return r.status ?? 1;
  };
  if (!info.boot) return withLock(startMachine(home, name));
  const running = holderPid(dir);
  if (running && initPid(dir)) return withLock(running);
  const unlock = lockStart(dir, name);
  try {
    const { lower, overlay, lazy } = prepare(home, info, {});
    const script = `set -e; mount --make-rprivate /; ${LAZY_START}\nmount -t overlay overlay -o "lowerdir=$CB_LOWER,upperdir=$CB_DIR/upper,workdir=$CB_DIR/work$CB_OVERLAY" "$CB_DIR/merged"; shift; exec "$@"`;
    const r = spawnSync("unshare", ["--mount", "sh", "-c", script, "sh", "--", ...command], { stdio, env: { ...process.env, CB_DIR: dir, CB_LOWER: lower, CB_OVERLAY: overlay, CB_LAZY: lazy } });
    if (r.error) throw new Error(`could not mount the files of machine "${name}": ${r.error.message}`);
    return r.status ?? 1;
  } finally {
    unlock();
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
    const shell = info && (machineHas(home, info, "usr/bin/bash") || machineHas(home, info, "bin/bash")) ? "/bin/bash" : "/bin/sh";
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
  const kind = bootKind(dir);
  const spaces = ["--mount", "--uts", "--ipc", "--pid", ...(kind ? ["--cgroup"] : []), ...(fs.existsSync(path.join(dir, "netns")) ? ["--net"] : [])];
  let inside = cmd;
  if (kind === "systemd") {
    // the machine's own systemd runs the command as one of its services and lends it a terminal.
    // It waits for the system to be up far enough first.
    // (until systemd answers, and then until the message bus that carries the request is there)
    const wait = 'n=0; until systemctl show --property=Version >/dev/null 2>&1 || [ "$n" -ge 300 ]; do sleep 0.1; n=$((n+1)); done; '
      + 'n=0; until [ -S /run/dbus/system_bus_socket ] || [ "$n" -ge 100 ]; do sleep 0.1; n=$((n+1)); done; exec systemd-run "$@"';
    inside = ["/bin/sh", "-c", wait, "sh", "--quiet", "--wait", "--collect", "--pty", "--pipe", "--service-type=exec",
      ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), "--", ...cmd];
    // newer versions colour the terminal and set its title for such sessions; a machine is entered too often for that
    Object.assign(env, { SYSTEMD_TINT_BACKGROUND: "0", SYSTEMD_ADJUST_TERMINAL_TITLE: "0" });
  }
  // the shared lock tells the machine's init that a session is alive; it is released even if we are killed
  const r = spawnSync("flock", ["-s", path.join(dir, "lock"), "nsenter", "--target", String(pid), ...spaces, "--", "chroot", merged, ...inside], { stdio: "inherit", env });
  if (r.error) throw new Error(`could not enter machine "${name}": ${r.error.message}`);
  return r.status ?? (r.signal ? 128 : 1);
}

export function stopMachine(home: EngineHome, name: string): boolean {
  const dir = machineDir(home, name);
  const pid = initPid(dir), holder = readPid(path.join(dir, "holder"));
  fs.rmSync(path.join(dir, "keep"), { force: true });
  if (!pid) return false;
  if (bootKind(dir) === "systemd") {
    // an orderly shutdown first: services stop and write what they hold in memory
    try { process.kill(pid, SIG_POWEROFF); } catch { /* already gone */ }
    for (let i = 0; i < 400 && initPid(dir); i++) sleepMs(50);
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  for (let i = 0; i < 100 && initPid(dir); i++) sleepMs(50);
  // the holder tidies up (control groups) once the machine's processes are gone
  for (let i = 0; i < 100 && holder && readPid(path.join(dir, "holder")); i++) sleepMs(50);
  for (const f of ["pid", "holder", "boot", "netns"]) fs.rmSync(path.join(dir, f), { force: true });
  return true;
}

export function removeMachine(home: EngineHome, name: string): void {
  const dir = machineDir(home, name);
  if (!fs.existsSync(dir)) throw new Error(`there is no machine named "${name}"`);
  stopMachine(home, name);
  sleepMs(200); // let the kernel drop the machine's mounts
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Deletes the unpacked copy of every image (not the downloads): the next start unpacks them again.
 * Used when the home directory changes between running with and without administrator rights,
 * which store file owners differently.
 */
export function dropUnpacked(home: EngineHome): void {
  let dirs: string[];
  try { dirs = fs.readdirSync(home.images); } catch { return; }
  for (const d of dirs) {
    fs.rmSync(path.join(home.images, d, "complete"), { force: true });
    for (const sub of ["rootfs", "rootfs.tmp"]) fs.rmSync(path.join(home.images, d, sub), { recursive: true, force: true });
  }
  // the decompressed packs that lazy machines read from belong to whoever ran the engine: made again when needed
  fs.rmSync(path.join(home.cache, "raw"), { recursive: true, force: true });
}

export function removeImage(home: EngineHome, digest: string): void {
  const used = listMachines(home).filter((m) => m.image.digest === digest).map((m) => m.name);
  if (used.length) throw new Error(`image is used by machine(s): ${used.join(", ")}. Remove them first.`);
  fs.rmSync(path.join(home.images, digest), { recursive: true, force: true });
}
