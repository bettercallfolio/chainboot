// `chainboot engine` on Linux: how machines get the rights they need, and switching between the two ways.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listMachines } from "../engine/linux.ts";
import {
  SUB_IDS, appArmorProfile, appArmorProfilePath, appArmorRestricts, engineMode, freeRange, hasEngineData, launcherPath, probe,
  support, writeMode, type EngineMode,
} from "../engine/rootless.ts";
import { homeDir } from "../local/home.ts";
import { UsageError, type Args } from "./args.ts";
import { confirm } from "./cmd-image.ts";
import { asRoot, engineHome } from "./cmd-run.ts";
import { bold, dim, info, ok, out } from "./term.ts";

export const ENGINE_HELP = `Usage:
  chainboot engine              Show how machines run on this computer
  chainboot engine rootless     Run machines without administrator rights
  chainboot engine sudo         Run machines through sudo (administrator rights)

On Linux a machine needs to mount file systems and give files their owners. There are two ways
to get those rights:

  rootless   Inside a "user namespace": chainboot stays an ordinary program of yours, and no
             password is asked. Needs the newuidmap/newgidmap tools and a range of user IDs
             reserved for you (most systems have both). "chainboot engine rootless" checks
             this and sets up what is missing, which can take your administrator password once.
  sudo       Every start and stop of a machine goes through sudo.

A new installation picks "rootless" by itself when the computer allows it. Switching later
needs a home directory without machines: save them (chainboot save), remove them
(chainboot rm), switch, and run them again; they come back from the chain.

Without administrator rights, programs in a machine cannot listen on ports below 1024.

On Windows and macOS:
  chainboot engine              Show where machines run
  chainboot engine reset        Delete the engine and every machine in it`;

const have = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;

/** The command that installs newuidmap/newgidmap with this system's package manager, or null. */
function installCommand(): string[] | null {
  if (have("apt-get")) return ["apt-get", "install", "-y", "uidmap"];
  if (have("dnf")) return ["dnf", "install", "-y", "shadow-utils"];
  if (have("yum")) return ["yum", "install", "-y", "shadow-utils"];
  if (have("pacman")) return ["pacman", "-S", "--noconfirm", "shadow"];
  if (have("zypper")) return ["zypper", "--non-interactive", "install", "shadow"];
  if (have("apk")) return ["apk", "add", "shadow-uidmap"];
  return null;
}

const modeText = (m: EngineMode) => (m === "rootless" ? "without administrator rights (in a user namespace)" : "through sudo (administrator rights)");

/** Machines that have files of their own on this computer. */
function machinesWithData(home: string): string[] {
  return listMachines(engineHome(home)).map((m) => m.name).filter((n) => fs.existsSync(path.join(home, "machines", n, "upper")));
}

function refuseWithMachines(home: string, target: string): void {
  const names = machinesWithData(home);
  if (!names.length) return;
  throw new Error(`these machines keep their files in the current way: ${names.join(", ")}
Save each one you want to keep (chainboot save <machine>), remove it (chainboot rm <machine>), then run "chainboot engine ${target}" again.
Saved machines come back from the chain the next time you run them.`);
}

export async function cmdEngineLinux(a: Args): Promise<void> {
  const home = homeDir();
  const want = a._[0];
  if (process.getuid?.() === 0) { out("You are root: machines run directly, with no extra step."); return; }
  const mode = engineMode(home);

  if (!want) {
    out(`Machines run directly on this computer, ${bold(modeText(mode))}.`);
    if (mode === "rootless") { info(dim("Go back to sudo with: chainboot engine sudo")); return; }
    const s = support(home);
    const reason = s.ready && s.ids ? probe(home, s.ids) : null;
    if (s.ready && !reason) info(dim("This computer can also run them without administrator rights: chainboot engine rootless"));
    else {
      info("Running them without administrator rights is not set up on this computer:");
      for (const line of missingText(s.missing, reason)) info(`  - ${line}`);
      info(dim("Set it up with: chainboot engine rootless"));
    }
    return;
  }

  if (want === "sudo") {
    if (mode === "root") { ok("machines already run through sudo"); return; }
    refuseWithMachines(home, "sudo");
    if (hasEngineData(home) && asRoot(["drop-unpacked", "all"]) !== 0) throw new Error("could not remove the unpacked images");
    writeMode(home, "root");
    ok("machines now run through sudo");
    return;
  }

  if (want !== "rootless") throw new UsageError(`unknown engine setting "${want}". Use: chainboot engine rootless | sudo`);
  if (mode === "rootless") {
    const s = support(home);
    const reason = s.ready && s.ids ? probe(home, s.ids) : "something it needs is missing";
    if (!reason) { ok("machines already run without administrator rights"); return; }
    // the home is in this mode, but the computer changed (a tool was removed, a setting turned off): repair below
  } else refuseWithMachines(home, "rootless");

  // what is missing, and the one-time steps that add it
  let s = support(home);
  if (s.missing.userns) {
    throw new Error(`user namespaces are turned off on this computer (sysctl user.max_user_namespaces or kernel.unprivileged_userns_clone is 0).
An administrator can turn them on; until then machines run through sudo.`);
  }
  const user = os.userInfo().username;
  const steps: { text: string; run: () => boolean }[] = [];
  const sudo = (cmd: string[], input?: string) => spawnSync("sudo", ["--", ...cmd], { stdio: input === undefined ? "inherit" : ["pipe", "ignore", "inherit"], input }).status === 0;
  if (s.missing.tools) {
    const cmd = installCommand();
    if (!cmd) throw new Error("the tools newuidmap and newgidmap are missing. Install them with your package manager (the package is usually named uidmap or shadow), then run this again.");
    steps.push({ text: `install the newuidmap and newgidmap tools:  sudo ${cmd.join(" ")}`, run: () => sudo(cmd) });
  }
  if (s.missing.subuid || s.missing.subgid) {
    const start = Math.max(freeRange("/etc/subuid"), freeRange("/etc/subgid"));
    const range = `${start}-${start + SUB_IDS - 1}`;
    const cmd = ["usermod", ...(s.missing.subuid ? ["--add-subuids", range] : []), ...(s.missing.subgid ? ["--add-subgids", range] : []), user];
    steps.push({ text: `reserve ${SUB_IDS} user IDs for the users inside your machines:  sudo ${cmd.join(" ")}`, run: () => sudo(cmd) });
  }
  if (s.missing.appArmor) {
    const profile = appArmorProfilePath(home);
    steps.push({
      text: `allow chainboot's copy of "unshare" (${launcherPath(home)}) to create user namespaces, which AppArmor restricts on this system:  ${profile}`,
      run: () => {
        const src = spawnSync("sh", ["-c", "command -v unshare"], { encoding: "utf8" }).stdout.trim();
        if (!src) return false;
        fs.mkdirSync(path.dirname(launcherPath(home)), { recursive: true });
        fs.copyFileSync(fs.realpathSync(src), launcherPath(home));
        fs.chmodSync(launcherPath(home), 0o755);
        const done = sudo(["tee", profile], appArmorProfile(home)) && sudo(["apparmor_parser", "-r", profile]);
        if (!done) fs.rmSync(launcherPath(home), { force: true });
        return done;
      },
    });
  }
  if (steps.length) {
    info("To run machines without administrator rights, this is needed once:");
    for (const step of steps) info(`  - ${step.text}`);
    if (!have("sudo")) throw new Error("these steps need an administrator (sudo is not installed here). Ask one to do them, then run this again.");
    if (!(await confirm("Do this now? sudo may ask for your password.", a))) { info("cancelled"); return; }
    for (const step of steps) { if (!step.run()) throw new Error(`this step did not complete: ${step.text}`); }
    s = support(home);
  }
  const reason = !s.ready || !s.ids ? missingText(s.missing, null).join("; ") : probe(home, s.ids);
  if (reason) {
    throw new Error(`this computer does not run machines without administrator rights:\n${reason}\nMachines keep running through sudo.`);
  }
  if (mode === "root" && hasEngineData(home) && asRoot(["drop-unpacked", "all"]) !== 0) throw new Error("could not remove the unpacked images");
  writeMode(home, "rootless");
  ok("machines now run without administrator rights");
  if (appArmorRestricts()) info(dim(`AppArmor profile: ${appArmorProfilePath(home)} (remove it together with ${launcherPath(home)} to undo)`));
}

function missingText(m: ReturnType<typeof support>["missing"], probeReason: string | null): string[] {
  const lines: string[] = [];
  if (m.userns) lines.push("user namespaces are turned off (sysctl)");
  if (m.tools) lines.push("the newuidmap and newgidmap tools are not installed");
  if (m.subuid || m.subgid) lines.push(`no range of ${SUB_IDS} user IDs is reserved for you in /etc/subuid and /etc/subgid`);
  if (m.appArmor) lines.push("AppArmor does not let ordinary programs use user namespaces on this system");
  if (probeReason) lines.push(`a test run failed: ${probeReason}`);
  return lines;
}
