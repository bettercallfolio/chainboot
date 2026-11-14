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
import { bootKind, enterMachine, holderPid, inMachineFiles, initPid, listMachines, machineDir, missingTools, removeMachine, startMachine, stopMachine, type EngineHome, type MachineInfo } from "../../src/engine/linux.ts";
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
