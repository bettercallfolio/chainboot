#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair } from "../solana/keys.ts";
import { UsageError, allow, flag, has, parseArgs, type Args } from "./args.ts";
import { LIST_HELP, PUBLISHER_HELP, PUBLISH_HELP, PULL_HELP, UNLIST_HELP, cmdEndorse, cmdList, cmdPublish, cmdPublisher, cmdPull, cmdUnlist } from "./cmd-image.ts";
import { ENGINE_OUT, copyOut, engineKind, engineRun, ensureEngine, knownEngine, proxy, pullVault, pushVault, removeEngine, stopEngineUi, syncConfig, type EngineKind } from "../engine/remote.ts";
import { runInUserNs, support } from "../engine/rootless.ts";
import { homeDir, loadConfig, paths } from "../local/home.ts";
import { forgetVault } from "../state/vault.ts";
import { ENGINE_HELP, cmdEngineLinux } from "./cmd-engine.ts";
import { SHARE_HELP, cmdShare, cmdShared } from "./cmd-share.ts";
import { ACCOUNTS_HELP, FEE_HELP, NETWORK_HELP, RPC_HELP, cmdAccounts, cmdNetwork, cmdPriorityFee, cmdRpc } from "./cmd-rpc.ts";
import { BOOT_HELP, DISK_HELP, EXPORT_HELP, RUN_HELP, cmdBoot, cmdDisk, cmdEngine, cmdExport, cmdImages, cmdMachines, cmdRm, cmdRmi, cmdRun, cmdStart, cmdStop } from "./cmd-run.ts";
import { LOGIN_HELP, SAVE_HELP, cmdAutosave, cmdFund, cmdHistory, cmdLogin, cmdLogout, cmdRestore, cmdSave, cmdStatus, cmdWhoami } from "./cmd-state.ts";
import { bold, dim, fail, info, ok, out } from "./term.ts";

declare const __CHAINBOOT_VERSION__: string | undefined;
/** Set at build time; "dev" when running from the sources. */
export const VERSION = typeof __CHAINBOOT_VERSION__ === "string" ? __CHAINBOOT_VERSION__ : "0.1.0-dev";

const HELP = `${bold("chainboot")} ${VERSION}: store, share and boot whole operating systems from a blockchain

${bold("Start here")}
  chainboot ui                   Open the point-and-click interface in your browser
  chainboot rpc add <url>        Add an RPC endpoint (you can add many)
  chainboot list                 Show the systems you can run
  chainboot run solinux         Download, verify and start Solinux (Ubuntu 26.04 LTS)

${bold("Machines")}
  run <image> [-- command]       Open a shell (or run a command) in a machine
  machines                       List your machines
  start <machine>                Keep a machine running in the background
  boot <machine> [on|off]        Let a machine boot its own system (systemd), like a server
  stop <machine>                 Stop a running machine
  rm <machine>                   Delete a machine and its changes

${bold("Save to chain")}
  login | logout | whoami        Sign in with your wallet (enables saving), sign out, show who is signed in
  fund <SOL>                     Add SOL to your vault, which pays for your saves
  save [machine]                 Save a machine's changes on chain, encrypted
  autosave <machine> on|off      Save by itself after each session (on by default once signed in)
  restore [machine]              Bring a saved machine back, on any computer
  history <machine>              List the saves of a machine
  status                         Show login, vault balance and save state
  share <machine|me/image> ...   Give a saved machine or a private image to another wallet
  shared [accept <number>]       See and keep what others shared with you

${bold("Images")}
  pull <image>                   Download an image without starting it
  images                         List downloaded images
  rmi <image>                    Delete a downloaded image
  publish <archive> ...          Put your own Linux system on chain (private; --public for everyone)
  export <machine> <file.tar>    Turn a machine into an archive you can publish
  disk <machine> <file.img>      Write a machine out as a bootable disk, with its own kernel
  unlist <image>                 Remove an image from your catalog
  publisher add|list|remove      Short names for publishers, and lists that several publishers keep together
  endorse <image> ...            Add an image that is already on chain to your catalog (for lists)

${bold("Settings")}
  rpc add|list|remove|test       Manage RPC endpoints
  network [name|add|list]        Show or switch the network; add other chains that speak Solana's RPC
  priority-fee [lamports|off]    Tip added to every transaction, for busy times
  accounts [on|off|close]        Keep pointers in accounts too, where one request reads them
  keygen <file>                  Create a new Solana keypair file
  engine [rootless|sudo]         How machines run: without administrator rights, or through sudo
  version                        Show the version of chainboot

Run "chainboot <command> --help" for details. A command that asks before it acts takes --yes
(or -y) to go ahead without asking.

Settings from the environment: CHAINBOOT_HOME (where chainboot keeps everything, default
~/.chainboot), CHAINBOOT_RPC (endpoints, separated by commas, instead of the saved ones),
CHAINBOOT_KEYPAIR (the keypair file for commands that take --keypair), NO_COLOR.`;

async function cmdEngineInfo(rest: string[]): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) { out(ENGINE_HELP); return; }
  const kind = engineKind();
  if (!kind) {
    if (process.platform !== "linux") { out("Machines need Linux; this computer has no engine for them yet."); return; }
    const args = parseArgs(rest, ["yes"], ["yes"]);
    allow(args, ["yes"]);
    await cmdEngineLinux(args);
    return;
  }
  const names = { wsl: "a WSL 2 distribution named \"chainboot\"", docker: "a Docker container named \"chainboot\"", podman: "a Podman container named \"chainboot\"", lima: "a Lima virtual machine named \"chainboot\"" };
  if (rest[0] === "reset") {
    const args = parseArgs(rest.slice(1), ["yes"], ["yes"]);
    allow(args, ["yes"]);
    const { confirm } = await import("./cmd-image.ts");
    if (!(await confirm("Delete the engine and every machine inside it on this computer? Saves on chain are not affected.", args))) { info("cancelled"); return; }
    removeEngine(kind);
    ok("the engine was removed; it is created again the next time you run a machine");
    return;
  }
  out(`Machines on this computer run inside ${names[kind]}.`);
  info(dim("Remove it (and all machines in it) with: chainboot engine reset"));
}

/**
 * "export" and "disk" write a file. Where machines live in an engine, the file is made in
 * there and then copied to the place the user named on this computer.
 */
async function fileCommand(kind: EngineKind, name: string, rest: string[]): Promise<number> {
  const cmd = COMMANDS[name]!;
  const args = parseArgs(rest, cmd.booleans, cmd.options);
  allow(args, cmd.options);
  const [machine, file, ...more] = args._;
  if (!machine || !file || more.length) throw new UsageError(`usage: chainboot ${name} <machine> <file>`);
  const target = path.resolve(file);
  if (fs.existsSync(target)) throw new Error(`${target} already exists`);
  if (!fs.existsSync(path.dirname(target))) throw new Error(`${path.dirname(target)} does not exist`);
  const inside = `${ENGINE_OUT}/${randomBytes(8).toString("hex")}${name === "disk" ? ".img" : ".tar"}`;
  if (!engineRun(kind, ["mkdir", "-p", ENGINE_OUT])) throw new Error("could not prepare the engine for writing a file");
  try {
    const code = await proxy(kind, [name, machine, inside, ...[...args.flags].flatMap(([k, values]) => values.map((v) => `--${k}=${v}`))]);
    if (code !== 0) return code;
    info(dim(`Copying the file out of the engine to ${target}`));
    await copyOut(kind, inside, target);
    ok(`wrote ${target} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`);
    return 0;
  } finally {
    engineRun(kind, ["rm", "-f", inside]);
  }
}

interface Command { run: (a: Args) => Promise<void> | void; help: string; options: string[]; booleans?: string[] }

const COMMANDS: Record<string, Command> = {
  run: { run: cmdRun, help: RUN_HELP, options: ["name", "arch", "no-autosave", "fresh", "boot", "lazy"], booleans: ["no-autosave", "fresh", "boot", "lazy"] },
  boot: { run: cmdBoot, help: BOOT_HELP, options: [] },
  share: { run: cmdShare, help: SHARE_HELP, options: ["with", "note", "arch", "yes"], booleans: ["yes"] },
  shared: { run: cmdShared, help: SHARE_HELP, options: ["name", "yes"], booleans: ["yes"] },
  machines: { run: cmdMachines, help: RUN_HELP, options: [] },
  start: { run: cmdStart, help: RUN_HELP, options: [] },
  stop: { run: cmdStop, help: RUN_HELP, options: [] },
  rm: { run: cmdRm, help: RUN_HELP, options: ["yes"], booleans: ["yes"] },
  images: { run: cmdImages, help: RUN_HELP, options: [] },
  export: { run: cmdExport, help: EXPORT_HELP, options: [] },
  disk: { run: cmdDisk, help: DISK_HELP, options: ["size"] },
  rmi: { run: cmdRmi, help: RUN_HELP, options: [] },
  login: { run: cmdLogin, help: LOGIN_HELP, options: ["keypair"] },
  logout: { run: cmdLogout, help: LOGIN_HELP, options: [] },
  whoami: { run: cmdWhoami, help: LOGIN_HELP, options: [] },
  fund: { run: cmdFund, help: LOGIN_HELP, options: ["keypair", "yes"], booleans: ["yes"] },
  save: { run: cmdSave, help: SAVE_HELP, options: ["force", "yes", "note"], booleans: ["force", "yes"] },
  restore: { run: cmdRestore, help: SAVE_HELP, options: ["snapshot", "yes"], booleans: ["yes"] },
  history: { run: cmdHistory, help: SAVE_HELP, options: [] },
  status: { run: cmdStatus, help: SAVE_HELP, options: [] },
  autosave: { run: cmdAutosave, help: SAVE_HELP, options: [] },
  ui: {
    help: "Usage:\n  chainboot ui [--port <number>] [--no-open]\n\nOpens the chainboot interface in your browser: pick a system, manage machines, connect your\nwallet. The page is served by this program on your own computer and is reachable only from it.",
    options: ["port", "no-open"], booleans: ["no-open"],
    run: async (a) => {
      const { startUi, openBrowser } = await import("../ui/server.ts");
      const port = flag(a, "port");
      if (port !== undefined && (!/^\d{2,5}$/.test(port) || Number(port) > 65535)) throw new UsageError("--port takes a number from 10 to 65535");
      const ui = await startUi({ port: port ? Number(port) : undefined });
      info(`${bold("chainboot interface")} is running. Open it here:`);
      out(ui.url);
      if (!has(a, "no-open") && !openBrowser(ui.url)) info(dim("No browser could be opened automatically; open the link above on this computer."));
      info(dim("Press Ctrl+C to stop."));
      await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
      ui.close();
    },
  },
  rpc: { run: cmdRpc, help: RPC_HELP, options: [] },
  network: { run: cmdNetwork, help: NETWORK_HELP, options: [] },
  "priority-fee": { run: cmdPriorityFee, help: FEE_HELP, options: [] },
  accounts: { run: cmdAccounts, help: ACCOUNTS_HELP, options: ["keypair"] },
  list: { run: cmdList, help: LIST_HELP, options: [] },
  pull: { run: cmdPull, help: PULL_HELP, options: ["arch"] },
  publish: { run: cmdPublish, help: PUBLISH_HELP, options: ["name", "version", "arch", "tag", "description", "source-url", "reuse", "cmd", "keypair", "dry-run", "yes", "private", "public", "lazy", "start-files"], booleans: ["dry-run", "yes", "private", "public", "lazy"] },
  unlist: { run: cmdUnlist, help: UNLIST_HELP, options: ["arch", "keypair", "yes"], booleans: ["yes"] },
  publisher: { run: cmdPublisher, help: PUBLISHER_HELP, options: [] },
  endorse: { run: cmdEndorse, help: PUBLISHER_HELP, options: ["keypair", "as", "arch", "yes"], booleans: ["yes"] },
  keygen: {
    help: "Usage:\n  chainboot keygen <file>    Create a new Solana keypair file (never overwrites)",
    options: [],
    run: (a) => {
      const file = a._[0];
      if (!file) throw new UsageError("say where to write it: chainboot keygen my-key.json");
      if (fs.existsSync(file)) throw new Error(`${file} already exists; refusing to overwrite a key`);
      const kp = Keypair.generate();
      fs.writeFileSync(file, JSON.stringify([...kp.secretKey()]), { mode: 0o600, flag: "wx" });
      ok(`wrote ${file}`);
      out(kp.address);
      info(dim("Keep this file private. Anyone who has it can spend its SOL and publish as you."));
    },
  },
};

// Commands that never need Linux: they run on this computer even where machines live in an engine.
const HOST_COMMANDS = new Set(["rpc", "network", "priority-fee", "keygen", "publish", "unlist", "list", "engine", "endorse", "publisher"]);
// (the "accounts" setting is read where pointers are written, so it is not one of these: on
// Windows and macOS it is set inside the engine, where saves are made)

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === "help" || name === "--help" || name === "-h") { out(HELP); return; }
  if (name === "--version" || name === "version") { out(VERSION); return; }
  if (name === "_engine") { await cmdEngine(rest); return; }
  if (name === "engine") { await cmdEngineInfo(rest); return; }
  if (name === "_userns") {
    // internal (used by the tests): runs a command the way the engine runs without administrator rights
    const s = support(homeDir());
    if (!s.ready || !s.ids || !rest.length) throw new Error("running without administrator rights is not set up: chainboot engine rootless");
    process.exitCode = runInUserNs(homeDir(), s.ids, rest).status;
    return;
  }
  // (what follows "--" belongs to the command that runs inside a machine, not to chainboot)
  const own = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  const help = own.includes("--help") || own.includes("-h");
  // private images need the login, which lives in the engine: listing and unlisting run there,
  // publishing runs here (it reads a local file) with a copy of the login
  const privateHere = name === "publish" && !own.includes("--public");
  const privateThere = (name === "list" && rest[0] === "me") || (name === "unlist" && (rest[0] ?? "").startsWith("me/"));
  // a keypair is a file on this computer, which the engine cannot see: what uses one runs here
  const withKeypair = own.some((a) => a === "--keypair" || a.startsWith("--keypair=")) || !!process.env.CHAINBOOT_KEYPAIR;
  const keypairHere = withKeypair && (name === "fund" || (name === "accounts" && rest[0] === "close"));
  if ((privateHere || (keypairHere && name === "fund")) && !help) {
    const kind = engineKind();
    if (kind) { await ensureEngine(kind); pullVault(kind, loadConfig().cluster); }
  }
  if (COMMANDS[name] && (!HOST_COMMANDS.has(name) || privateThere) && !keypairHere && !help) {
    const kind = engineKind();
    if (kind) {
      const keypairLogin = name === "login" && withKeypair;
      if (keypairLogin) { const args = parseArgs(rest, [], COMMANDS.login!.options); allow(args, COMMANDS.login!.options); await COMMANDS.login!.run(args); }
      await ensureEngine(kind);
      if (keypairLogin) { pushVault(kind, loadConfig().cluster); return; }
      if (name === "export" || name === "disk") { process.exitCode = await fileCommand(kind, name, rest); return; }
      const { openBrowser } = await import("../ui/server.ts");
      process.exitCode = await proxy(kind, [name, ...rest], (url) => { openBrowser(url); });
      // what was changed inside the engine comes back to this side: settings (the interface and
      // "accounts" change them there), and a login that ended
      if (name === "ui" || name === "login" || name === "fund") stopEngineUi(kind);
      try { syncConfig(kind); } catch { /* next time */ }
      if (name === "logout") forgetVault(paths.vault(), loadConfig().cluster);
      return;
    }
  } else if (COMMANDS[name] && !help) {
    // a command that runs on this side, on a computer whose machines live in an engine: take over
    // the settings that were changed in there (by the interface) before reading them
    const kind = knownEngine();
    if (kind) { try { syncConfig(kind); } catch { /* the engine is not running: nothing new in it */ } }
  }
  const cmd = COMMANDS[name];
  if (!cmd) throw new UsageError(`unknown command "${name}". Run "chainboot help" to see what is available.`);
  if (help) { out(cmd.help); return; }
  const args = parseArgs(rest, cmd.booleans, cmd.options);
  allow(args, cmd.options);
  await cmd.run(args);
}

// Leave as soon as the work is done: a request that is still waiting on a slow endpoint must not keep the program open.
function leave(code: number): void {
  process.exitCode = code;
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

main().then(
  () => leave(Number(process.exitCode ?? 0)),
  (e: Error) => {
    fail(e.message);
    if (e instanceof UsageError) info(dim('Run "chainboot help" for usage.'));
    else if (process.env.CHAINBOOT_DEBUG) info(e.stack ?? "");
    leave(e instanceof UsageError ? 2 : 1);
  },
);
