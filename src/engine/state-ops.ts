// Engine side of saving and restoring: runs as root, partly inside the machine's mount namespace.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseManifest, type FileNode } from "../image/manifest.ts";
import { loadConfig, openStore, paths } from "../local/home.ts";
import { TAR_END, tarHead, tarPadding, type Entry } from "../image/tar.ts";
import { isUnsaved, scanMachine } from "../state/scan.ts";
import { ChangedDuringSave, applySnapshot, loadPacks, readHead, readSnapshot, saveSnapshot, type Head, type SavePlan, type Snapshot } from "../state/snapshot.ts";
import { loadVault, type Vault } from "../state/vault.ts";
import { fmtBytes, sha256, toHex } from "../util/bytes.ts";
import { readXattrs } from "../util/xattr.ts";
import { imageRootfs, initPid, machineDir, readMachine, startMachine, stopMachine, type EngineHome } from "./linux.ts";

/** What this computer knows about a machine's saved state (machines/<name>/save.json). */
export interface SaveStatus {
  state: "saved" | "saving" | "nothing-to-save" | "needs-confirmation" | "no-funds" | "conflict" | "error";
  message?: string;
  /** Sequence number and fingerprint of the snapshot this machine was last in sync with. */
  seq?: number;
  fingerprint?: string;
  time?: number;
  updated: number;
}

/** Automatic saves that would cost more than this wait for an explicit `chainboot save`. */
export const AUTOSAVE_MAX_LAMPORTS = 50_000_000; // 0.05 SOL

const statusFile = (dir: string) => path.join(dir, "save.json");
const fmtSol = (lamports: number) => `${(lamports / 1e9).toFixed(lamports < 1_000_000 ? 6 : 4)} SOL`;

export function readSaveStatus(dir: string): SaveStatus | null {
  try { return JSON.parse(fs.readFileSync(statusFile(dir), "utf8")) as SaveStatus; } catch { return null; }
}

function writeSaveStatus(dir: string, s: Omit<SaveStatus, "updated">): void {
  const tmp = `${statusFile(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...s, updated: Math.floor(Date.now() / 1000) }, null, 2) + "\n");
  fs.renameSync(tmp, statusFile(dir));
}

/** Runs one of the *-inner operations inside the machine's mount namespace, starting the machine if needed. */
export function insideMachine(home: EngineHome, homePath: string, name: string, args: string[], stdio: "inherit" | "ignore" = "inherit"): number {
  const dir = machineDir(home, name);
  const pid = startMachine(home, name, () => {});
  fs.writeFileSync(path.join(dir, "attached"), "");
  const self = [process.execPath, ...process.execArgv, process.argv[1]!, "_engine", homePath, process.env.TERM ?? "", ...args];
  const r = spawnSync("flock", ["-s", path.join(dir, "lock"), "nsenter", "--target", String(pid), "--mount", "--", ...self], { stdio });
  if (r.error) throw new Error(`could not enter machine "${name}": ${r.error.message}`);
  return r.status ?? 1;
}

function requireVault(): Vault {
  const c = loadConfig();
  const v = loadVault(paths.vault(), c.cluster);
  if (!v) throw new Error('you are not signed in. Sign in first: chainboot login');
  return v;
}

export interface SaveFlags { force?: boolean; auto?: boolean; yes?: boolean; note?: string }

/** Must run inside the machine's mount namespace. Returns a process exit status. */
export async function saveInner(home: EngineHome, name: string, flags: SaveFlags, say: (text: string) => void, progress: (phase: string, done: number, total: number) => void, ask: (question: string) => Promise<boolean>): Promise<number> {
  const dir = machineDir(home, name);
  const info = readMachine(home, name);
  if (!info) throw new Error(`there is no machine named "${name}"`);
  const lock = path.join(dir, "save.lock");
  for (let waited = 0; ; waited++) {
    try { fs.mkdirSync(lock); break; } catch { /* another save holds the lock */ }
    let age = Infinity;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; } // it was just released: try again
    if (age > 30 * 60_000) { try { fs.rmdirSync(lock); } catch { /* raced */ } continue; } // left behind by a save that crashed
    if (flags.auto) return 0; // an automatic save is not needed while another save is running
    if (waited === 0) say(`a save of "${name}" is already running in the background; waiting for it to finish`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const local = readSaveStatus(dir);
  const keep = { seq: local?.seq, fingerprint: local?.fingerprint, time: local?.time };
  try {
    const vault = requireVault();
    const base = parseManifest(fs.readFileSync(path.join(home.images, info.image.digest, "manifest.json")));
    for (let attempt = 0; ; attempt++) {
      const scan = scanMachine({ upper: path.join(dir, "upper"), merged: path.join(dir, "merged"), base, cacheFile: path.join(dir, "scan-cache.json") });
      if (local?.fingerprint === scan.fingerprint && local.seq) {
        writeSaveStatus(dir, { ...keep, state: "saved" });
        say(`"${name}" has no changes since save #${local.seq}`);
        return 0;
      }
      const store = await openStore(loadConfig());
      const head = await readHead(store, vault, name);
      if (head && head.seq !== (local?.seq ?? 0) && !flags.force) {
        const message = `"${name}" was saved from another computer (save #${head.seq}) after this one last synced` + (local?.seq ? ` (save #${local.seq})` : "") +
          `. Take that version with "chainboot restore ${name}", or overwrite it with "chainboot save ${name} --force".`;
        writeSaveStatus(dir, { ...keep, state: "conflict", message });
        say(message);
        return 3;
      }
      const prev: { snapshot: Snapshot; head: Head } | null = head ? { head, snapshot: await readSnapshot(store, vault, head.ref, path.join(home.cache, "objects")) } : null;
      let declined: SaveStatus["state"] | null = null, declinedMessage = "";
      writeSaveStatus(dir, { ...keep, state: "saving" });
      try {
        const result = await saveSnapshot(store, vault, info, base, scan, prev, {
          journalDir: paths.journals(), note: flags.note,
          onProgress: progress,
          approve: async (plan: SavePlan) => {
            const balance = (await store.pool.call<{ value: number }>("getBalance", [vault.signer.address, { commitment: "confirmed" }])).value;
            const cost = fmtSol(plan.lamports);
            say(`${scan.changes.length} changed entries, ${scan.deleted.length} deleted; ${fmtBytes(plan.newBytes)} new data -> ${fmtBytes(plan.storedBytes)} to upload, about ${plan.transactions} transactions (${cost})`);
            if (balance < plan.lamports + 10_000) {
              declined = "no-funds";
              declinedMessage = `the vault ${vault.signer.address} holds ${fmtSol(balance)} but this save needs about ${cost}. Add funds with: chainboot fund <amount>`;
              return false;
            }
            if (flags.auto && plan.lamports > AUTOSAVE_MAX_LAMPORTS) {
              declined = "needs-confirmation";
              declinedMessage = `saving "${name}" would cost about ${cost}, more than automatic saves may spend. Confirm it with: chainboot save ${name}`;
              return false;
            }
            if (!flags.auto && !flags.yes && plan.lamports > AUTOSAVE_MAX_LAMPORTS && !(await ask(`Save now for about ${cost}?`))) {
              declined = "needs-confirmation"; declinedMessage = "cancelled";
              return false;
            }
            return true;
          },
        });
        if (!result) {
          writeSaveStatus(dir, { ...keep, state: declined ?? "error", message: declinedMessage });
          say(declinedMessage);
          return declined === "no-funds" ? 4 : 5;
        }
        writeSaveStatus(dir, { state: "saved", seq: result.head.seq, fingerprint: scan.fingerprint, time: result.head.time });
        say(`saved "${name}" as save #${result.head.seq} (${fmtBytes(result.plan.storedBytes)} uploaded, ${fmtSol(result.plan.lamports)})`);
        for (const s of scan.skipped.slice(0, 5)) say(`not saved: ${s.path} (${s.why})`);
        return 0;
      } catch (e) {
        // a file changed between scanning and reading it (the machine is in use): scan again
        if (e instanceof ChangedDuringSave && attempt < 3) { say(`${e.message}; scanning again`); continue; }
        throw e;
      }
    }
  } catch (e) {
    writeSaveStatus(dir, { ...keep, state: "error", message: (e as Error).message });
    throw e;
  } finally {
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
}

export const CHECK_NEWER_CLEAN = 10, CHECK_NEWER_CONFLICT = 11;

/**
 * Must run inside the machine's mount namespace. Tells whether the chain holds a newer save than
 * this computer last synced with: 0 no (or unknown), 10 yes and nothing changed here, 11 yes but
 * this machine also has unsaved changes. Gives up quietly after a few seconds without network.
 */
export async function checkInner(home: EngineHome, name: string): Promise<number> {
  const dir = machineDir(home, name);
  const info = readMachine(home, name), local = readSaveStatus(dir);
  if (!info || !local?.seq) return 0;
  const work = (async () => {
    const c = loadConfig();
    const vault = loadVault(paths.vault(), c.cluster);
    if (!vault) return 0;
    const head = await readHead(await openStore(c), vault, name);
    if (!head || head.seq <= local.seq!) return 0;
    const base = parseManifest(fs.readFileSync(path.join(home.images, info.image.digest, "manifest.json")));
    const scan = scanMachine({ upper: path.join(dir, "upper"), merged: path.join(dir, "merged"), base, cacheFile: path.join(dir, "scan-cache.json") });
    return scan.fingerprint === local.fingerprint ? CHECK_NEWER_CLEAN : CHECK_NEWER_CONFLICT;
  })().catch(() => 0);
  return await Promise.race([work, new Promise<number>((r) => setTimeout(() => r(0), 5000))]);
}

/** Must run inside the mount namespace of a machine whose own layer is empty. */
export async function restoreInner(home: EngineHome, name: string, seq: number | null, say: (text: string) => void, progress: (phase: string, done: number, total: number) => void): Promise<number> {
  const dir = machineDir(home, name);
  const info = readMachine(home, name);
  if (!info) throw new Error(`there is no machine named "${name}"`);
  const vault = requireVault();
  const store = await openStore(loadConfig());
  const head = await readHead(store, vault, name);
  if (!head) throw new Error(`no saved state was found on chain for "${name}" with this login`);
  const objects = path.join(home.cache, "objects");
  let snap = await readSnapshot(store, vault, head.ref, objects), picked = head.seq;
  if (seq !== null && seq !== head.seq) {
    const old = snap.history.find((h) => h.seq === seq);
    if (!old) throw new Error(`"${name}" has no save #${seq}. See: chainboot history ${name}`);
    snap = await readSnapshot(store, vault, old.ref, objects); picked = seq;
  }
  if (snap.image.digest !== info.image.digest) throw new Error(`save #${picked} belongs to image ${snap.image.name}:${snap.image.tag} (${snap.image.digest.slice(0, 12)}), but this machine uses ${info.image.digest.slice(0, 12)}`);
  const base = parseManifest(fs.readFileSync(path.join(home.images, info.image.digest, "manifest.json")));
  // content that the image already has is copied from the unpacked image instead of being downloaded again
  const lower = imageRootfs(home, info.image.digest);
  const inImage = new Map<string, string>();
  for (const n of base.tree) if (n[1] === "f" && n[6] > 0 && !inImage.has(n[7])) inImage.set(n[7], n[0]);
  const local = (n: FileNode) => inImage.has(n[7]);
  const pack = await loadPacks(store, vault, snap, home.cache, (d, t) => progress("downloading", d, t), local);
  progress("applying", 0, 1);
  applySnapshot(snap, path.join(dir, "merged"), (n) => {
    if (local(n)) {
      const data = fs.readFileSync(path.join(lower, inImage.get(n[7])!));
      if (toHex(sha256(data)) === n[7]) return data;
    }
    return pack(n[8]).subarray(n[9], n[9] + n[6]);
  });
  const scan = scanMachine({ upper: path.join(dir, "upper"), merged: path.join(dir, "merged"), base, cacheFile: path.join(dir, "scan-cache.json") });
  // going back to an older save keeps the newest sequence number: the next save continues the same history
  writeSaveStatus(dir, { state: "saved", seq: head.seq, fingerprint: picked === head.seq ? scan.fingerprint : "", time: snap.time });
  progress("applying", 1, 1);
  say(`restored "${name}" from save #${picked} (${new Date(snap.time * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC): ${snap.tree.length} entries, ${snap.deleted.length} deletions`);
  return 0;
}

/** Empties a machine's own layer so that it shows the plain image again. */
export function resetLayer(home: EngineHome, name: string): void {
  const dir = machineDir(home, name);
  stopMachine(home, name);
  for (let i = 0; i < 40 && initPid(dir); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  for (const d of ["upper", "work"]) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  for (const f of ["save.json", "scan-cache.json"]) fs.rmSync(path.join(dir, f), { force: true });
}

/** Minutes between automatic saves while a machine keeps running. */
export const AUTOSAVE_MINUTES = Math.max(1, Number(process.env.CHAINBOOT_AUTOSAVE_MINUTES) || 10);

/**
 * Starts one background watcher per running machine. While the machine is up, it saves every
 * AUTOSAVE_MINUTES (a save with nothing new costs nothing and sends nothing).
 */
export function watchInBackground(home: EngineHome, homePath: string, name: string): void {
  const c = (() => { try { return loadConfig(); } catch { return null; } })();
  if (!c || !loadVault(paths.vault(), c.cluster)) return;
  const dir = machineDir(home, name);
  if (fs.existsSync(path.join(dir, "autosave-off"))) return;
  try {
    const pid = Number(fs.readFileSync(path.join(dir, "watch.pid"), "utf8"));
    if (pid > 1) { process.kill(pid, 0); return; } // a watcher is already running
  } catch { /* none */ }
  const log = fs.openSync(path.join(dir, "save.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "_engine", homePath, "", "watch", name], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  fs.closeSync(log);
  if (child.pid) fs.writeFileSync(path.join(dir, "watch.pid"), String(child.pid));
}

/** Body of the watcher process: runs until the machine stops. */
export async function watchLoop(home: EngineHome, homePath: string, name: string): Promise<void> {
  const dir = machineDir(home, name);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    for (;;) {
      for (let waited = 0; waited < AUTOSAVE_MINUTES * 60; waited += 5) {
        await sleep(5000);
        if (!initPid(dir)) return;
      }
      if (fs.existsSync(path.join(dir, "autosave-off"))) continue;
      spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, "_engine", homePath, "", "save", name, "--auto"], { stdio: "ignore" });
    }
  } finally {
    fs.rmSync(path.join(dir, "watch.pid"), { force: true });
  }
}

/** Starts a save in the background (after a session ends). Output goes to machines/<name>/save.log. */
export function autosaveInBackground(home: EngineHome, homePath: string, name: string): boolean {
  const c = (() => { try { return loadConfig(); } catch { return null; } })();
  if (!c || !loadVault(paths.vault(), c.cluster)) return false;
  const dir = machineDir(home, name);
  if (fs.existsSync(path.join(dir, "autosave-off"))) return false;
  const log = fs.openSync(path.join(dir, "save.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "_engine", homePath, "", "save", name, "--auto"], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  fs.closeSync(log);
  return true;
}

/**
 * Must run inside the machine's mount namespace. Writes the machine's complete file system
 * (image + changes) as a tar archive, ready for `chainboot publish`. Runtime mounts and caches
 * are left out, exactly like in saves.
 */
// Left out of exported images: secrets and identity that every machine must have for itself, and history.
const PRIVATE_FILES = [/^etc\/ssh\/ssh_host_[^/]*$/, /^root\/\.bash_history$/, /^home\/[^/]+\/\.bash_history$/, /^var\/lib\/systemd\/random-seed$/, /^var\/lib\/dbus\/machine-id$/, /^var\/log\/.*\.(log|gz|[0-9])$/, /^var\/log\/(wtmp|btmp|lastlog|faillog)$/, /^root\/\.ssh\//, /^home\/[^/]+\/\.ssh\//];
// Written as empty files: must exist, but their content belongs to one machine only.
const EMPTIED_FILES = new Set(["etc/machine-id"]);

export function exportInner(home: EngineHome, name: string, file: string, progress: (phase: string, done: number, total: number) => void): { entries: number; bytes: number } {
  const merged = path.join(machineDir(home, name), "merged");
  const fd = fs.openSync(file, "w", 0o644);
  const inodes = new Map<string, string>();
  let entries = 0, bytes = 0;
  const buf = Buffer.allocUnsafe(1 << 20);
  const attrs = readXattrs(merged);
  const emit = (e: Entry, size: number) => {
    const x = attrs?.get(e.path);
    if (x && (e.type === "f" || e.type === "d")) e.xattrs = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Buffer.from(v, "base64")]));
    for (const b of tarHead(e, size)) fs.writeSync(fd, b); entries++; if (entries % 1000 === 0) progress("exporting", entries, entries + 1000); };
  const walk = (rel: string) => {
    for (const nm of fs.readdirSync(rel ? path.join(merged, rel) : merged).sort()) {
      const p = rel ? `${rel}/${nm}` : nm;
      if (isUnsaved(p) || PRIVATE_FILES.some((re) => re.test(p))) continue;
      const abs = path.join(merged, p);
      const st = fs.lstatSync(abs);
      const common = { path: p, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, mtime: Math.floor(st.mtimeMs / 1000) };
      if (st.isFile() && EMPTIED_FILES.has(p)) { emit({ ...common, type: "f" }, 0); continue; }
      if (st.isDirectory()) { emit({ ...common, type: "d" }, 0); walk(p); }
      else if (st.isSymbolicLink()) emit({ ...common, type: "l", link: fs.readlinkSync(abs) }, 0);
      else if (st.isFIFO()) emit({ ...common, type: "p" }, 0);
      else if (st.isFile()) {
        const id = `${st.dev}:${st.ino}`, first = st.nlink > 1 ? inodes.get(id) : undefined;
        if (first) { emit({ ...common, type: "h", link: first }, 0); continue; }
        if (st.nlink > 1) inodes.set(id, p);
        emit({ ...common, type: "f" }, st.size);
        const src = fs.openSync(abs, "r");
        let left = st.size;
        try {
          while (left > 0) {
            const n = fs.readSync(src, buf, 0, Math.min(buf.length, left), null);
            if (n <= 0) throw new Error(`${p} shrank while it was being exported`);
            fs.writeSync(fd, buf, 0, n); left -= n;
          }
        } finally { fs.closeSync(src); }
        fs.writeSync(fd, tarPadding(st.size));
        bytes += st.size;
      }
      // sockets and device nodes are runtime objects: images do not carry them
    }
  };
  try { walk(""); fs.writeSync(fd, TAR_END); } finally { fs.closeSync(fd); }
  return { entries, bytes };
}
