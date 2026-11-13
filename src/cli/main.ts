#!/usr/bin/env node
import fs from "node:fs";
import { Keypair } from "../solana/keys.ts";
import { UsageError, allow, has, parseArgs, type Args } from "./args.ts";
import { LIST_HELP, PUBLISH_HELP, PULL_HELP, UNLIST_HELP, cmdList, cmdPublish, cmdPull, cmdUnlist } from "./cmd-image.ts";
import { RPC_HELP, cmdNetwork, cmdRpc } from "./cmd-rpc.ts";
import { bold, dim, fail, info, ok, out } from "./term.ts";

export const VERSION = "0.1.0";

const HELP = `${bold("chainboot")} ${VERSION}: store, share and boot whole operating systems from a blockchain

${bold("Start here")}
  chainboot rpc add <url>        Add an RPC endpoint (you can add many)
  chainboot list                 Show the systems you can run
  chainboot run solbuntu         Download, verify and start Solbuntu (Ubuntu 26.04 LTS)

${bold("Images")}
  pull <image>                   Download an image without starting it
  publish <archive> ...          Put your own Linux system on chain
  unlist <image>                 Remove an image from your catalog

${bold("Settings")}
  rpc add|list|remove|test       Manage RPC endpoints
  network [name]                 Show or switch the network (devnet, testnet, mainnet-beta)
  keygen <file>                  Create a new Solana keypair file

Run "chainboot <command> --help" for details.`;

interface Command { run: (a: Args) => Promise<void> | void; help: string; options: string[]; booleans?: string[] }

const COMMANDS: Record<string, Command> = {
  rpc: { run: cmdRpc, help: RPC_HELP, options: [] },
  network: { run: cmdNetwork, help: RPC_HELP, options: [] },
  list: { run: cmdList, help: LIST_HELP, options: [] },
  pull: { run: cmdPull, help: PULL_HELP, options: ["arch"] },
  publish: { run: cmdPublish, help: PUBLISH_HELP, options: ["name", "version", "arch", "tag", "description", "source-url", "reuse", "cmd", "keypair", "dry-run", "yes"], booleans: ["dry-run", "yes"] },
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

async function main(): Promise<void> {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === "help" || name === "--help" || name === "-h") { out(HELP); return; }
  if (name === "--version" || name === "version") { out(VERSION); return; }
  const cmd = COMMANDS[name];
  if (!cmd) throw new UsageError(`unknown command "${name}". Run "chainboot help" to see what is available.`);
  const args = parseArgs(rest, cmd.booleans);
  if (has(args, "help")) { out(cmd.help); return; }
  allow(args, cmd.options);
  await cmd.run(args);
}

main().then(
  () => { process.exitCode ??= 0; },
  (e: Error) => {
    fail(e.message);
    if (e instanceof UsageError) info(dim('Run "chainboot help" for usage.'));
    else if (process.env.CHAINBOOT_DEBUG) info(e.stack ?? "");
    process.exitCode = e instanceof UsageError ? 2 : 1;
  },
);
