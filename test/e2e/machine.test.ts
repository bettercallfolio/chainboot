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
import { enterMachine, initPid, listMachines, machineDir, missingTools, removeMachine, startMachine, stopMachine, type EngineHome, type MachineInfo } from "../../src/engine/linux.ts";

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
  for (const d of ["etc", "root", "data/keep", "data/old"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
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
    const pid = startMachine(home, "box", () => {});
    assert.ok(pid > 1 && initPid(dir) === pid);
    assert.equal(listMachines(home)[0]!.running, true);
    const sh = (script: string) => enterMachine(home, "box", initPid(dir) ?? startMachine(home, "box", () => {}), ["/bin/sh", "-c", script]);

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
