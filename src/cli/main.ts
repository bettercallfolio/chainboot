#!/usr/bin/env node
import fs from "node:fs";
import { Keypair } from "../solana/keys.ts";
import { UsageError, allow, flag, has, parseArgs, type Args } from "./args.ts";
import { LIST_HELP, PUBLISH_HELP, PULL_HELP, UNLIST_HELP, cmdList, cmdPublish, cmdPull, cmdUnlist } from "./cmd-image.ts";
import { engineKind, ensureEngine, proxy, pullVault, pushVault, removeEngine } from "../engine/remote.ts";
import { loadConfig } from "../local/home.ts";
import { FEE_HELP, RPC_HELP, cmdNetwork, cmdPriorityFee, cmdRpc } from "./cmd-rpc.ts";
import { EXPORT_HELP, RUN_HELP, cmdEngine, cmdExport, cmdImages, cmdMachines, cmdRm, cmdRmi, cmdRun, cmdStart, cmdStop } from "./cmd-run.ts";
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
  stop <machine>                 Stop a running machine
  rm <machine>                   Delete a machine and its changes

${bold("Save to chain")}
  login                          Sign in with your wallet (enables saving)
  save [machine]                 Save a machine's changes on chain, encrypted
  restore [machine]              Bring a saved machine back, on any computer
  history <machine>              List the saves of a machine
  status                         Show login, vault balance and save state

${bold("Images")}
  pull <image>                   Download an image without starting it
  images                         List downloaded images
  rmi <image>                    Delete a downloaded image
  publish <archive> ...          Put your own Linux system on chain (private; --public for everyone)
  export <machine> <file.tar>    Turn a machine into an archive you can publish
  unlist <image>                 Remove an image from your catalog

${bold("Settings")}
  rpc add|list|remove|test       Manage RPC endpoints
  network [name]                 Show or switch the network (devnet, testnet, mainnet-beta)
  priority-fee [lamports|off]    Tip added to every transaction, for busy times
  keygen <file>                  Create a new Solana keypair file

Run "chainboot <command> --help" for details.`;

async function cmdEngineInfo(rest: string[]): Promise<void> {
  const kind = engineKind();
  if (!kind) { out("This is Linux: machines run directly on this computer, no separate engine is used."); return; }
  const names = { wsl: "a WSL 2 distribution named \"chainboot\"", docker: "a Docker container named \"chainboot\"", podman: "a Podman container named \"chainboot\"", lima: "a Lima virtual machine named \"chainboot\"" };
  if (rest[0] === "reset") {
    const args = parseArgs(rest.slice(1), ["yes"]);
    const { confirm } = await import("./cmd-image.ts");
    if (!(await confirm("Delete the engine and every machine inside it on this computer? Saves on chain are not affected.", args))) { info("cancelled"); return; }
    removeEngine(kind);
    ok("the engine was removed; it is created again the next time you run a machine");
    return;
  }
  out(`Machines on this computer run inside ${names[kind]}.`);
  info(dim("Remove it (and all machines in it) with: chainboot engine reset"));
}

interface Command { run: (a: Args) => Promise<void> | void; help: string; options: string[]; booleans?: string[] }

const COMMANDS: Record<string, Command> = {
  run: { run: cmdRun, help: RUN_HELP, options: ["name", "arch", "no-autosave", "fresh"], booleans: ["no-autosave", "fresh"] },
  machines: { run: cmdMachines, help: RUN_HELP, options: [] },
  start: { run: cmdStart, help: RUN_HELP, options: [] },
  stop: { run: cmdStop, help: RUN_HELP, options: [] },
  rm: { run: cmdRm, help: RUN_HELP, options: ["yes"], booleans: ["yes"] },
  images: { run: cmdImages, help: RUN_HELP, options: [] },
  export: { run: cmdExport, help: EXPORT_HELP, options: [] },
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
      if (port !== undefined && !/^\d{2,5}$/.test(port)) throw new UsageError("--port takes a number");
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
  network: { run: cmdNetwork, help: RPC_HELP, options: [] },
  "priority-fee": { run: cmdPriorityFee, help: FEE_HELP, options: [] },
  list: { run: cmdList, help: LIST_HELP, options: [] },
  pull: { run: cmdPull, help: PULL_HELP, options: ["arch"] },
  publish: { run: cmdPublish, help: PUBLISH_HELP, options: ["name", "version", "arch", "tag", "description", "source-url", "reuse", "cmd", "keypair", "dry-run", "yes", "private", "public"], booleans: ["dry-run", "yes", "private", "public"] },
  unlist: { run: cmdUnlist, help: UNLIST_HELP, options: ["arch", "keypair", "yes"], booleans: ["yes"] },
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
const HOST_COMMANDS = new Set(["rpc", "network", "priority-fee", "keygen", "publish", "unlist", "list", "engine"]);

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === "help" || name === "--help" || name === "-h") { out(HELP); return; }
  if (name === "--version" || name === "version") { out(VERSION); return; }
  if (name === "_engine") { await cmdEngine(rest); return; }
  if (name === "engine") { await cmdEngineInfo(rest); return; }
  // private images need the login, which lives in the engine: listing and unlisting run there,
  // publishing runs here (it reads a local file) with a copy of the login
  const privateHere = name === "publish" && !rest.includes("--public");
  const privateThere = (name === "list" && rest[0] === "me") || (name === "unlist" && (rest[0] ?? "").startsWith("me/"));
  if (privateHere && !rest.includes("--help")) {
    const kind = engineKind();
    if (kind) { await ensureEngine(kind); pullVault(kind, loadConfig().cluster); }
  }
  if (COMMANDS[name] && (!HOST_COMMANDS.has(name) || privateThere) && !rest.includes("--help") && !rest.includes("-h")) {
    const kind = engineKind();
    if (kind) {
      const keypairLogin = name === "login" && rest.includes("--keypair");
      if (keypairLogin) { const args = parseArgs(rest); allow(args, COMMANDS.login!.options); await COMMANDS.login!.run(args); }
      await ensureEngine(kind);
      if (keypairLogin) { pushVault(kind, loadConfig().cluster); return; }
      const { openBrowser } = await import("../ui/server.ts");
      process.exitCode = await proxy(kind, [name, ...rest], (url) => { openBrowser(url); });
      return;
    }
  }
  const cmd = COMMANDS[name];
  if (!cmd) throw new UsageError(`unknown command "${name}". Run "chainboot help" to see what is available.`);
  const args = parseArgs(rest, cmd.booleans);
  if (has(args, "help")) { out(cmd.help); return; }
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
