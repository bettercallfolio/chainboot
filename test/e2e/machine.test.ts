// End-to-end test of the Linux engine. Needs root and util-linux; uses no network and no chain:
// a tiny system is assembled from this computer's own shell and tools.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { buildImage } from "../../src/image/build.ts";
import { serializeManifest } from "../../src/image/manifest.ts";
import { readTar } from "../../src/image/tar.ts";
import { MACHINE_CLOSING, bootKind, enterMachine, holderPid, inMachineFiles, initPid, listMachines, machineDir, missingTools, removeMachine, startMachine, stopMachine, type EngineHome, type MachineInfo } from "../../src/engine/linux.ts";
import { inUserNs } from "../../src/engine/rootless.ts";

const usable = process.platform === "linux" && process.getuid?.() === 0 && missingTools().length === 0;

function tinyRootfs(dir: string): void {
  const tools = ["sh", "cat", "ls", "rm", "mkdir", "mv", "touch", "hostname", "id", "sleep"];
  const copy = (src: string) => {
    const real = fs.realpathSync(src), dest = path.join(dir, src);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) { fs.copyFileSync(real, dest); fs.chmodSync(dest, 0o755); }
  };
  for (const t of tools) {
    const bin = execFileSync("sh", ["-c", `command -v ${t}`]).toString().trim();
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.copyFileSync(fs.realpathSync(bin), path.join(dir, "bin", t)); fs.chmodSync(path.join(dir, "bin", t), 0o755);
    for (const line of spawnSync("ldd", [bin]).stdout.toString().split("\n")) {
      const m = /(\/[^\s]+) \(0x/.exec(line);
      if (m) copy(m[1]!);
    }
  }
  for (const d of ["etc", "root", "sbin", "data/keep", "data/old"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  // a first process for machines that boot: it does nothing but stay
  fs.writeFileSync(path.join(dir, "sbin/init"), "#!/bin/sh\necho up > /run/init-was-here\nwhile :; do sleep 1; done\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "etc/os-release"), "NAME=tiny\n");
  fs.writeFileSync(path.join(dir, "data/keep/a.txt"), "a\n");
  fs.writeFileSync(path.join(dir, "data/old/b.txt"), "b\n");
  fs.writeFileSync(path.join(dir, "data/old/c.txt"), "c\n");
}

test("a machine starts, keeps its changes, reports them correctly and leaves nothing behind", { skip: !usable && "needs Linux, root and util-linux" }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-"));
  const home: EngineHome = { images: path.join(work, "images"), machines: path.join(work, "machines"), cache: path.join(work, "cache") };
  const rootfs = path.join(work, "rootfs");
  tinyRootfs(rootfs);
  execFileSync("tar", ["-cf", path.join(work, "rootfs.tar"), "-C", rootfs, "."]);
  const built = buildImage(readTar(fs.readFileSync(path.join(work, "rootfs.tar"))), { name: "tiny", version: "1", arch: "amd64" });
  const m = built.manifest;
  for (const [i, data] of built.newPacks) { m.packs[i]!.sig = "local"; fs.mkdirSync(path.join(home.cache, "objects"), { recursive: true }); fs.writeFileSync(path.join(home.cache, "objects", m.packs[i]!.sha256), data); }
  fs.mkdirSync(path.join(home.images, m.digest), { recursive: true });
  const manifestFile = path.join(home.images, m.digest, "manifest.json");
  fs.writeFileSync(manifestFile, serializeManifest(m));
  const info: MachineInfo = { name: "box", created: 1, image: { publisher: "local", name: "tiny", tag: "1", arch: "amd64", digest: m.digest, manifest: { sig: "local", sha256: "0".repeat(64), size: 1, codec: "raw", rawSize: 1 } } };
  const dir = machineDir(home, "box");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "machine.json"), JSON.stringify(info));

  try {
    const pid = startMachine(home, "box");
    assert.ok(pid > 1 && initPid(dir) === pid);
    assert.equal(listMachines(home)[0]!.running, true);
    const sh = (script: string) => enterMachine(home, "box", initPid(dir) ?? startMachine(home, "box"), ["/bin/sh", "-c", script]);

    assert.equal(sh("exit 7"), 7, "exit status comes through");
    assert.equal(sh('[ "$(hostname)" = box ] && [ "$(id -u)" = 0 ] && [ "$$" != 1 ] && cat /etc/os-release > /root/seen && [ -e /proc/self/status ] && [ -c /dev/null ] && [ -s /etc/resolv.conf ]'), 0, "the machine has its own hostname, /proc, /dev and name resolution");
    assert.equal(sh("echo new > /root/new.txt && rm /etc/os-release && rm -r /data/old && mkdir /data/old && echo d > /data/old/d.txt && mv /data/keep/a.txt /data/keep/renamed.txt && echo tmp > /tmp/scratch"), 0);

    // the changes live in the machine's own layer, the image is untouched
    assert.equal(fs.readFileSync(path.join(dir, "upper/root/new.txt"), "utf8"), "new\n");
    assert.equal(fs.readFileSync(path.join(home.images, m.digest, "rootfs/etc/os-release"), "utf8"), "NAME=tiny\n");

    // extended attributes set on a changed file: a user note and a file capability
    const tools = spawnSync("sh", ["-c", "command -v setfattr && command -v setcap"]).status === 0;
    if (tools) {
      execFileSync("setfattr", ["-n", "user.note", "-v", "hello", path.join(dir, "upper/root/new.txt")]);
      execFileSync("setcap", ["cap_net_bind_service+ep", path.join(dir, "upper/root/new.txt")]);
    }

    const scan = JSON.parse(execFileSync("nsenter", ["--target", String(initPid(dir)), "--mount", "--", process.execPath, ...process.execArgv.filter((a) => !a.startsWith("--test")), path.join(import.meta.dirname, "scan-helper.ts"), dir, manifestFile]).toString()) as { changes: [string, string][]; deleted: string[]; xattrs: Record<string, string[]> };
    if (tools) assert.deepEqual(scan.xattrs["root/new.txt"], ["security.capability", "user.note"], "extended attributes are part of a save, overlay bookkeeping is not");
    assert.ok(!Object.values(scan.xattrs).flat().some((n) => n.includes("overlay")));
    assert.deepEqual(scan.deleted.sort(), ["data/keep/a.txt", "data/old/b.txt", "data/old/c.txt", "etc/os-release"], "deletions, including inside a directory that was removed and made again");
    const changed = new Map(scan.changes);
    assert.equal(changed.get("root/new.txt"), "f");
    assert.equal(changed.get("data/old/d.txt"), "f");
    assert.equal(changed.get("data/keep/renamed.txt"), "f");
    assert.ok(!scan.changes.some(([p]) => p.startsWith("tmp/") || p === "etc/resolv.conf" || p === "etc/hosts"), "runtime files are not part of a save");

    // a second session sees the same machine; after stopping, the state is still there
    assert.equal(sh("cat /root/new.txt /data/old/d.txt > /dev/null && [ ! -e /etc/os-release ]"), 0);
    assert.ok(stopMachine(home, "box"));
    assert.equal(initPid(dir), null);
    assert.equal(sh("[ -e /root/new.txt ] && [ ! -e /tmp/scratch ]"), 0, "changes survive a restart, /tmp does not");
    stopMachine(home, "box");
    assert.ok(!fs.readFileSync("/proc/mounts", "utf8").includes(work), "no mount is left on the host");
  } finally {
    try { removeMachine(home, "box"); } catch { /* best effort */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// A machine that boots needs a control group it may manage: root makes one; inside a user
// namespace that takes a delegated scope (systemd-run --user --scope), which a test run may lack.
const ownCgroup = (() => { try { return /^0::(.*)$/m.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1] ?? ""; } catch { return ""; } })();
const canBoot = usable && fs.existsSync("/sys/fs/cgroup/cgroup.controllers") && (!inUserNs() || /\/run-[^/]*\.scope$/.test(ownCgroup));

test("a machine that boots runs the image's init as PID 1, stays up, and its files are reachable while stopped", { skip: !canBoot && "needs Linux, root, cgroup v2 (and a delegated scope inside a user namespace)" }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-boot-"));
  const home: EngineHome = { images: path.join(work, "images"), machines: path.join(work, "machines"), cache: path.join(work, "cache") };
  const rootfs = path.join(work, "rootfs");
  tinyRootfs(rootfs);
  execFileSync("tar", ["-cf", path.join(work, "rootfs.tar"), "-C", rootfs, "."]);
  const built = buildImage(readTar(fs.readFileSync(path.join(work, "rootfs.tar"))), { name: "tiny", version: "1", arch: "amd64" });
  const m = built.manifest;
  for (const [i, data] of built.newPacks) { m.packs[i]!.sig = "local"; fs.mkdirSync(path.join(home.cache, "objects"), { recursive: true }); fs.writeFileSync(path.join(home.cache, "objects", m.packs[i]!.sha256), data); }
  fs.mkdirSync(path.join(home.images, m.digest), { recursive: true });
  fs.writeFileSync(path.join(home.images, m.digest, "manifest.json"), serializeManifest(m));
  const name = `boot${process.pid}`;
  const info: MachineInfo = { name, created: 1, boot: true, image: { publisher: "local", name: "tiny", tag: "1", arch: "amd64", digest: m.digest, manifest: { sig: "local", sha256: "0".repeat(64), size: 1, codec: "raw", rawSize: 1 } } };
  const dir = machineDir(home, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "machine.json"), JSON.stringify(info));
  const merged = path.join(dir, "merged");

  try {
    // stopped: its files can be reached without starting it (this is how a restore works)
    assert.equal(inMachineFiles(home, name, ["sh", "-c", `[ -e "${merged}/etc/os-release" ] && echo before > "${merged}/root/before.txt"`]), 0);
    assert.equal(initPid(dir), null, "reaching the files did not start the machine");
    assert.ok(!fs.existsSync(path.join(merged, "etc")), "and left no mount behind");

    const pid = startMachine(home, name);
    assert.ok(pid > 1 && initPid(dir) === pid);
    assert.equal(bootKind(dir), "init", "an init that is not systemd");
    const holder = holderPid(dir);
    assert.ok(holder && holder !== pid, "a holder process keeps the outside view of the files");
    const sh = (script: string) => enterMachine(home, name, pid, ["/bin/sh", "-c", script]);
    assert.equal(sh("exit 5"), 5);
    // (the image's init starts a moment after the machine is reported up: give it that moment)
    assert.equal(sh('n=0; while [ ! -e /run/init-was-here ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n+1)); done; read first < /proc/1/cmdline; case "$first" in *init*) ;; *) exit 1 ;; esac; [ "$(hostname)" = ' + name + ' ] && cat /run/init-was-here > /dev/null && cat /root/before.txt > /dev/null && [ -e /sys/fs/cgroup/cgroup.procs ] && echo in > /root/in.txt'), 0,
      "PID 1 is the image's init, it ran, and the machine has its own control group tree");
    assert.equal(sh("echo x > /proc/sys/kernel/hostname 2>/dev/null"), 2, "this computer's kernel settings are read-only inside");

    // running: the files are reached through the holder, where they are at their path on this computer
    assert.equal(inMachineFiles(home, name, ["sh", "-c", `[ "$(cat "${merged}/root/in.txt")" = in ] && [ ! -e "${merged}/proc/self" ]`]), 0);

    // it does not stop by itself when sessions end
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);
    assert.equal(initPid(dir), pid, "a machine that boots stays up after its sessions end");

    assert.ok(stopMachine(home, name));
    assert.equal(initPid(dir), null);
    assert.equal(holderPid(dir), null);
    assert.ok(!fs.readFileSync("/proc/mounts", "utf8").includes(work), "no mount is left on the host");
    if (!inUserNs()) assert.ok(!fs.existsSync(`/sys/fs/cgroup/chainboot-${name}`), "its control group is removed");
    assert.equal(fs.readFileSync(path.join(dir, "upper/root/in.txt"), "utf8"), "in\n");
  } finally {
    try { removeMachine(home, name); } catch { /* best effort */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
});

const canLazy = usable && fs.existsSync("/dev/fuse");

test("a lazy machine runs from an image that is not unpacked, and its image server comes and goes with it", { skip: !canLazy && "needs Linux, root and /dev/fuse" }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-lazy-"));
  const home: EngineHome = { images: path.join(work, "images"), machines: path.join(work, "machines"), cache: path.join(work, "cache") };
  const rootfs = path.join(work, "rootfs");
  tinyRootfs(rootfs);
  fs.symlinkSync("os-release", path.join(rootfs, "etc/release-link"));
  fs.linkSync(path.join(rootfs, "data/keep/a.txt"), path.join(rootfs, "data/keep/hard.txt"));
  execFileSync("tar", ["-cf", path.join(work, "rootfs.tar"), "-C", rootfs, "."]);
  const built = buildImage(readTar(fs.readFileSync(path.join(work, "rootfs.tar"))), { name: "tiny", version: "1", arch: "amd64" }, { layout: "lazy", startFiles: ["bin/sh", "etc/os-release"] });
  const m = built.manifest;
  for (const [i, data] of built.newPacks) { m.packs[i]!.sig = "local"; fs.mkdirSync(path.join(home.cache, "objects"), { recursive: true }); fs.writeFileSync(path.join(home.cache, "objects", m.packs[i]!.sha256), data); }
  fs.mkdirSync(path.join(home.images, m.digest), { recursive: true });
  fs.writeFileSync(path.join(home.images, m.digest, "manifest.json"), serializeManifest(m));
  const name = `lazy${process.pid}`;
  const info: MachineInfo = { name, created: 1, lazy: true, image: { publisher: "local", name: "tiny", tag: "1", arch: "amd64", digest: m.digest, manifest: { sig: "local", sha256: "0".repeat(64), size: 1, codec: "raw", rawSize: 1 } } };
  const dir = machineDir(home, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "machine.json"), JSON.stringify(info));
  // the image server is chainboot's own program, started again
  process.env.CHAINBOOT_SELF = path.join(import.meta.dirname, "../../src/cli/main.ts");
  const servers = () => spawnSync("pgrep", ["-f", `[l]azy-serve ${name}`]).stdout.toString().trim().split("\n").filter(Boolean).length;

  try {
    const pid = startMachine(home, name);
    assert.ok(pid > 1 && initPid(dir) === pid);
    assert.ok(!fs.existsSync(path.join(home.images, m.digest, "rootfs")), "the image was not unpacked");
    assert.equal(servers(), 1, "one image server runs beside the machine");
    const sh = (script: string) => enterMachine(home, name, initPid(dir) ?? startMachine(home, name), ["/bin/sh", "-c", script]);
    assert.equal(sh('[ "$(cat /etc/os-release)" = NAME=tiny ] && [ "$(cat /etc/release-link)" = NAME=tiny ] && [ "$(cat /data/keep/hard.txt)" = a ] && [ "$(cat /data/old/b.txt)" = b ] && [ "$$" != 1 ]'), 0, "files, a symbolic link and a hard link read as in the image");
    // (the pattern is written in two pieces so that this very command line does not match it)
    assert.equal(sh('for p in /proc/[0-9]*; do read c < $p/cmdline 2>/dev/null || true; case "$c" in *lazy-ser""ve*) exit 1 ;; esac; done; exit 0'), 0, "the server is not among the machine's processes");
    assert.equal(sh("echo new > /root/new.txt && rm /etc/os-release && echo changed > /data/keep/a.txt && cat /data/keep/a.txt > /dev/null"), 0, "the machine's own layer takes the changes");
    assert.equal(fs.readFileSync(path.join(dir, "upper/root/new.txt"), "utf8"), "new\n");
    assert.ok(fs.existsSync(path.join(home.cache, "raw", m.packs[0]!.rawSha256)), "the packs that were read are in the cache, verified and decompressed");

    // files of a stopped lazy machine can be reached too (as a save does), with a server of its own for that moment
    assert.ok(stopMachine(home, name));
    for (let i = 0; i < 60 && servers(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert.equal(servers(), 0, "the server ended with the machine");
    assert.equal(sh("[ -e /root/new.txt ] && [ ! -e /etc/os-release ] && [ \"$(cat /data/keep/a.txt)\" = changed ]"), 0, "changes survive a restart");
    stopMachine(home, name);
    for (let i = 0; i < 60 && servers(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert.equal(servers(), 0);
    assert.ok(!fs.readFileSync("/proc/mounts", "utf8").includes(work), "no mount is left on the host");
    assert.match(fs.readFileSync(path.join(dir, "lazy-files.txt"), "utf8"), /^\/bin\/sh$/m, "what was read is written down for a publisher");
  } finally {
    delete process.env.CHAINBOOT_SELF;
    try { removeMachine(home, name); } catch { /* best effort */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
});

/** Puts an image made from `rootfs` into a home, with `count` machines of it, and returns their directories. */
function installImage(work: string, rootfs: string, names: string[], more: Partial<MachineInfo> = {}): { home: EngineHome; digest: string; dirs: string[] } {
  const home: EngineHome = { images: path.join(work, "images"), machines: path.join(work, "machines"), cache: path.join(work, "cache") };
  execFileSync("tar", ["-cf", path.join(work, "rootfs.tar"), "-C", rootfs, "."]);
  const built = buildImage(readTar(fs.readFileSync(path.join(work, "rootfs.tar"))), { name: "tiny", version: "1", arch: "amd64" });
  const m = built.manifest;
  fs.mkdirSync(path.join(home.cache, "objects"), { recursive: true });
  for (const [i, data] of built.newPacks) { m.packs[i]!.sig = "local"; fs.writeFileSync(path.join(home.cache, "objects", m.packs[i]!.sha256), data); }
  fs.mkdirSync(path.join(home.images, m.digest), { recursive: true });
  fs.writeFileSync(path.join(home.images, m.digest, "manifest.json"), serializeManifest(m));
  const dirs = names.map((name) => {
    const info: MachineInfo = { name, created: 1, image: { publisher: "local", name: "tiny", tag: "1", arch: "amd64", digest: m.digest, manifest: { sig: "local", sha256: "0".repeat(64), size: 1, codec: "raw", rawSize: 1 } }, ...more };
    const dir = machineDir(home, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "machine.json"), JSON.stringify(info));
    return dir;
  });
  return { home, digest: m.digest, dirs };
}

test("an image cannot lead the setup out of the machine, and a start that fails says why", { skip: !usable && "needs Linux, root and util-linux" }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-"));
  const outside = path.join(work, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "resolv.conf"), "the computer's own\n");
  // an image whose /etc is a symbolic link to a directory of this computer
  const rootfs = path.join(work, "rootfs");
  tinyRootfs(rootfs);
  fs.rmSync(path.join(rootfs, "etc"), { recursive: true });
  fs.symlinkSync(outside, path.join(rootfs, "etc"));
  const { home } = installImage(work, rootfs, ["trap"]);
  try {
    assert.throws(() => startMachine(home, "trap"), /has \/etc as a symbolic link/);
    assert.equal(fs.readFileSync(path.join(outside, "resolv.conf"), "utf8"), "the computer's own\n");
    assert.deepEqual(fs.readdirSync(outside), ["resolv.conf"], "nothing was created where the link points");
    assert.equal(initPid(machineDir(home, "trap")), null, "nothing was left running");
  } finally {
    removeMachine(home, "trap");
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("two machines of one image can start at the same moment, and a session never enters a machine that is going away", { skip: !usable && "needs Linux, root and util-linux" }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cb-e2e-"));
  const rootfs = path.join(work, "rootfs");
  tinyRootfs(rootfs);
  // enough entries that unpacking takes a moment
  for (let i = 0; i < 40; i++) { fs.mkdirSync(path.join(rootfs, "data", `d${i}`)); for (let k = 0; k < 20; k++) fs.writeFileSync(path.join(rootfs, "data", `d${i}`, `f${k}`), `${i}-${k}\n`); }
  const { home, digest, dirs } = installImage(work, rootfs, ["a", "b"]);
  try {
    // two processes, as two terminals would be: each starts one machine of the not yet unpacked image
    const script = `import { startMachine, enterMachine } from ${JSON.stringify(path.resolve("src/engine/linux.ts"))}; const home = ${JSON.stringify(home)}; const name = process.argv[2]; const pid = startMachine(home, name); process.exit(enterMachine(home, name, pid, ["/bin/sh", "-c", "cat /data/d39/f19"]));`;
    fs.writeFileSync(path.join(work, "start.ts"), script);
    const { spawn } = await import("node:child_process");
    const run = (name: string) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(work, "start.ts"), name], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => { out += d; }); child.stderr.on("data", (d: Buffer) => { out += d; });
      child.on("close", (code) => resolve({ code, out }));
    });
    const results = await Promise.all([run("a"), run("b")]);
    for (const r of results) assert.deepEqual([r.code, r.out.trim()], [0, "39-19"], r.out);
    assert.ok(fs.existsSync(path.join(home.images, digest, "complete")));
    assert.deepEqual(fs.readdirSync(path.join(home.images, digest)).filter((n) => n.startsWith("rootfs")), ["rootfs"], "one finished copy, nothing half done beside it");
    assert.equal(fs.readdirSync(path.join(home.images, digest, "rootfs", "data")).length, 42);

    // a machine that is on its way out leaves a note under its lock; a session that finds it says so instead of entering
    const dir = dirs[0]!;
    const pid = initPid(dir) ?? startMachine(home, "a");
    fs.writeFileSync(path.join(dir, "closed"), "");
    assert.equal(enterMachine(home, "a", pid, ["/bin/sh", "-c", "exit 0"]), MACHINE_CLOSING);
    fs.rmSync(path.join(dir, "closed"));
    assert.equal(enterMachine(home, "a", pid, ["/bin/sh", "-c", "exit 0"]), 0);
    // left alone, it goes away by itself, and the note is there when it is gone
    for (let i = 0; i < 100 && initPid(dir); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(initPid(dir), null);
    assert.ok(fs.existsSync(path.join(dir, "closed")));
    // the next start clears it
    assert.equal(enterMachine(home, "a", startMachine(home, "a"), ["/bin/sh", "-c", "exit 3"]), 3);

    // A start that was interrupted: the machine's first process exists, but the command that
    // started it ended before it could note the machine as running. (Made here from a running
    // machine by taking that note away, which leaves exactly what such a command leaves.)
    const first = initPid(dir)!;
    const parent = Number(/^PPid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${first}/status`, "utf8"))![1]);
    const startOf = (p: number) => { const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; };
    const state = (p: number) => { try { const st = fs.readFileSync(`/proc/${p}/stat`, "utf8"); return st.slice(0, st.lastIndexOf(")") + 1) + st.slice(st.lastIndexOf(")") + 1).split(" ").slice(0, 5).join(" "); } catch { return "gone"; } };
    const gone = (p: number) => state(p) === "gone" || /\) [ZX] /.test(state(p));
    fs.writeFileSync(path.join(dir, "starting"), `${parent} ${startOf(parent)}\n`);
    fs.rmSync(path.join(dir, "pid"));
    assert.equal(initPid(dir), null, "no command knows this machine as running");
    // the next start ends what was left and starts the machine once
    const second = startMachine(home, "a");
    assert.notEqual(second, first);
    assert.ok(gone(first) && gone(parent), `the processes of the interrupted start are gone (first: ${state(first)}; its parent: ${state(parent)})`);
    assert.ok(!fs.existsSync(path.join(dir, "starting")));
    assert.equal(enterMachine(home, "a", second, ["/bin/sh", "-c", "cat /data/d0/f0"]), 0);
    // and "stop" ends such a leftover too, although nothing says that the machine runs
    const parent2 = Number(/^PPid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${second}/status`, "utf8"))![1]);
    fs.writeFileSync(path.join(dir, "starting"), `${parent2} ${startOf(parent2)}\n`);
    fs.rmSync(path.join(dir, "pid"));
    assert.equal(stopMachine(home, "a"), true);
    assert.ok(gone(second) && gone(parent2), `stop ended the leftover (first: ${state(second)}; its parent: ${state(parent2)})`);
    assert.equal(stopMachine(home, "a"), false);
  } finally {
    for (const n of ["a", "b"]) removeMachine(home, n);
    fs.rmSync(work, { recursive: true, force: true });
  }
});
