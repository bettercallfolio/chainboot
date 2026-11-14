// Running the engine without administrator rights, inside a user namespace.
//
// The engine needs to mount file systems, chroot and give files their owners. Normally that
// takes root. Linux can also grant those rights inside a "user namespace": there the engine is
// user 0, while to the rest of the computer it is still the person who started it. User IDs
// 1..65536 of the namespace are backed by the range the system reserved for this person in
// /etc/subuid, so every user of an image (root, _apt, www-data, ...) keeps its own files.
//
// A home directory is used in one mode only, because the two store file owners differently:
//   root      files belong to the real IDs (the engine runs through sudo)
//   rootless  files belong to the person's own ID and their subordinate range
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type EngineMode = "root" | "rootless";

/** How many IDs a machine sees: 0 (the person) plus 1..65536. */
export const SUB_IDS = 65536;

export interface IdRange { start: number; count: number }

/** The first range of at least SUB_IDS that `file` (/etc/subuid or /etc/subgid) gives to this user. */
export function subRange(file: string, user: string, id: number): IdRange | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    const [who, start, count] = line.trim().split(":");
    if (who !== user && who !== String(id)) continue;
    const range = { start: Number(start), count: Number(count) };
    if (Number.isInteger(range.start) && range.start > 0 && Number.isInteger(range.count) && range.count >= SUB_IDS) return range;
  }
  return null;
}

/** The lowest start of a free block of SUB_IDS in `file`, for a user that has none yet. */
export function freeRange(file: string): number {
  let top = 100_000;
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const [, start, count] = line.trim().split(":");
      const end = Number(start) + Number(count);
      if (Number.isFinite(end) && end > top) top = end;
    }
  } catch { /* no file yet */ }
  return top;
}

const hasTool = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;

function userName(): string {
  try { return os.userInfo().username; } catch { return process.env.USER ?? ""; }
}

/** The private copy of `unshare` that an AppArmor profile allows to create user namespaces (see setup). */
export function launcherPath(homePath: string): string { return path.join(homePath, "bin", "userns"); }

/** True where AppArmor stops ordinary programs from using user namespaces (Ubuntu 23.10 and later). */
export function appArmorRestricts(): boolean {
  try { return fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1"; } catch { return false; }
}

/** One profile per user and home directory. */
function profileName(homePath: string): string {
  return `chainboot-userns-${process.getuid!()}-${createHash("sha256").update(homePath).digest("hex").slice(0, 6)}`;
}

export function appArmorProfilePath(homePath: string): string { return `/etc/apparmor.d/${profileName(homePath)}`; }

export function appArmorProfile(homePath: string): string {
  return `# Lets chainboot (https://chainboot.dev) run machines without administrator rights for one user.
# It allows this one program, a copy of "unshare", to create user namespaces.
abi <abi/4.0>,
include <tunables/global>

profile ${profileName(homePath)} "${launcherPath(homePath)}" flags=(unconfined) {
  userns,
}
`;
}

export interface Ids { uid: number; gid: number; subuid: IdRange; subgid: IdRange }

export interface Support {
  /** Everything is in place except, possibly, what only a test run can tell (see probe). */
  ready: boolean;
  ids: Ids | null;
  /** What is missing, in plain words. */
  missing: { tools: boolean; subuid: boolean; subgid: boolean; appArmor: boolean; userns: boolean };
}

export function support(homePath: string): Support {
  const uid = process.getuid!(), gid = process.getgid!(), user = userName();
  const subuid = subRange("/etc/subuid", user, uid), subgid = subRange("/etc/subgid", user, uid);
  let disabled = false;
  for (const f of ["/proc/sys/user/max_user_namespaces", "/proc/sys/kernel/unprivileged_userns_clone"]) {
    try { if (fs.readFileSync(f, "utf8").trim() === "0") disabled = true; } catch { /* not present on this kernel */ }
  }
  const missing = {
    tools: !hasTool("newuidmap") || !hasTool("newgidmap"),
    subuid: !subuid, subgid: !subgid,
    appArmor: appArmorRestricts() && !fs.existsSync(launcherPath(homePath)),
    userns: disabled,
  };
  const ready = !Object.values(missing).some(Boolean);
  return { ready, ids: subuid && subgid ? { uid, gid, subuid, subgid } : null, missing };
}

// Runs "$@" as user 0 of a user namespace.
//   CB_JOIN set and alive: enter the user namespace of that process (a running machine), so the
//     command can reach the machine's other namespaces, which belong to it.
//   otherwise: create a new one. `unshare --user` only creates it; the IDs are filled in from
//     outside by newuidmap/newgidmap, which is what gives the namespace the subordinate range.
//     (unshare's own --map-auto does the same but is missing from util-linux before 2.38.)
const LAUNCH = String.raw`
if [ -n "$CB_JOIN" ] && [ -e "/proc/$CB_JOIN/ns/user" ] && { command exec 9< "/proc/$CB_JOIN/ns/user"; } 2>/dev/null; then
  exec nsenter --user=/proc/self/fd/9 -- "$@"
fi
pid=$$
mine=$(readlink /proc/self/ns/user)
( (
  n=0
  while [ "$(readlink "/proc/$pid/ns/user" 2>/dev/null)" = "$mine" ]; do
    n=$((n+1)); [ "$n" -gt 1000 ] && exit 1
    sleep 0.01
  done
  newuidmap "$pid" 0 "$CB_UID" 1 1 "$CB_SUBUID" @IDS@ && newgidmap "$pid" 0 "$CB_GID" 1 1 "$CB_SUBGID" @IDS@
) </dev/null >/dev/null & )
exec "$CB_LAUNCHER" --user sh -c '
  n=0
  until read _ < /proc/self/uid_map && read _ < /proc/self/gid_map; do
    n=$((n+1))
    if [ "$n" -gt 1000 ]; then echo "chainboot: the user namespace did not get its user IDs (newuidmap failed)" >&2; exit 125; fi
    sleep 0.01
  done
  exec "$@"' sh "$@"
`.replace(/@IDS@/g, String(SUB_IDS));

/** Runs `command` as user 0 of a user namespace with this terminal. `joinPid`: a process whose user namespace to enter. */
export function runInUserNs(homePath: string, ids: Ids, command: string[], joinPid: number | null = null, stdio: "inherit" | "ignore" | "pipe" = "inherit"): { status: number; output: string } {
  const own = launcherPath(homePath);
  const r = spawnSync("sh", ["-c", LAUNCH, "chainboot-userns", ...command], {
    stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : stdio,
    env: {
      ...process.env,
      CB_LAUNCHER: fs.existsSync(own) ? own : "unshare",
      CB_UID: String(ids.uid), CB_GID: String(ids.gid), CB_SUBUID: String(ids.subuid.start), CB_SUBGID: String(ids.subgid.start),
      CB_JOIN: joinPid ? String(joinPid) : "",
    },
  });
  if (r.error) throw new Error(`could not start a user namespace: ${r.error.message}`);
  return { status: r.status ?? (r.signal ? 128 : 1), output: stdio === "pipe" ? `${r.stdout ?? ""}${r.stderr ?? ""}` : "" };
}

/**
 * Does in miniature what a machine does (an overlay mount with a deleted and a re-owned file, a
 * /proc of its own) and reports why it failed, or null when it works.
 */
export function probe(homePath: string, ids: Ids): string | null {
  const base = path.join(homePath, "cache");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "probe-"));
  try {
    for (const d of ["lower", "upper", "work", "merged", "proc"]) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, "lower", "f"), "x");
    const script = `set -e; cd "$1"
mount -t overlay overlay -o lowerdir=lower,upperdir=upper,workdir=work,userxattr merged
rm merged/f; mkdir merged/d; chown 1000:1000 merged/d
mount -t proc proc proc
umount proc merged; rm -rf upper work`;
    const r = runInUserNs(homePath, ids, ["unshare", "--mount", "--pid", "--fork", "sh", "-c", script, "sh", dir], null, "pipe");
    if (r.status === 0) return null;
    return r.output.trim().split("\n").slice(-3).join("\n") || `the test run ended with status ${r.status}`;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover of a failed test run; harmless */ }
  }
}

const modeFile = (homePath: string) => path.join(homePath, "engine-mode");

/** True when the home directory already holds unpacked images or machines with files in them. */
export function hasEngineData(homePath: string): boolean {
  const any = (dir: string, child: string) => {
    try { return fs.readdirSync(dir).some((n) => fs.existsSync(path.join(dir, n, child))); } catch { return false; }
  };
  return any(path.join(homePath, "images"), "rootfs") || any(path.join(homePath, "images"), "rootfs.tmp") || any(path.join(homePath, "machines"), "upper");
}

export function writeMode(homePath: string, mode: EngineMode): void {
  fs.mkdirSync(homePath, { recursive: true });
  fs.writeFileSync(modeFile(homePath), `${mode}\n`);
}

/** The mode recorded for this home directory, or null when nothing was recorded. */
export function readMode(homePath: string): EngineMode | null {
  try {
    const m = fs.readFileSync(modeFile(homePath), "utf8").trim();
    return m === "root" || m === "rootless" ? m : null;
  } catch { return null; }
}

/**
 * How the engine runs for this home directory. Decided once: a home that already has data stays
 * as it is; a new one runs without administrator rights whenever this computer allows it.
 */
export function engineMode(homePath: string): EngineMode {
  if (process.getuid?.() === 0) return "root";
  const recorded = readMode(homePath);
  if (recorded) return recorded;
  if (hasEngineData(homePath)) return "root"; // made by an earlier version, through sudo
  const forced = process.env.CHAINBOOT_ENGINE_MODE;
  if (forced === "root") return "root";
  const s = support(homePath);
  if (!s.ready || !s.ids || probe(homePath, s.ids) !== null) return "root";
  writeMode(homePath, "rootless");
  return "rootless";
}

/** True inside a user namespace (where user 0 is not the computer's real root). */
export function inUserNs(): boolean {
  try {
    const map = fs.readFileSync("/proc/self/uid_map", "utf8").trim().split(/\s+/);
    return !(map.length === 3 && map[0] === "0" && map[1] === "0" && map[2] === "4294967295");
  } catch { return false; }
}
