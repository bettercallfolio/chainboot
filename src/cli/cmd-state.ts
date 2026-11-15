import fs from "node:fs";
import path from "node:path";
import { listMachines, machineDir, readMachine, type EngineHome, type MachineInfo } from "../engine/linux.ts";
import { readSaveStatus } from "../engine/state-ops.ts";
import { loadConfig, openStore, paths, networkLabel } from "../local/home.ts";
import { buildTransaction, transferInstruction } from "../solana/tx.ts";
import { readHead, readIndex, readSnapshot } from "../state/snapshot.ts";
import { myShareAddress } from "../share/share.ts";
import { forgetVault, loadVault, saveVault, vaultFromKeypair, type Vault } from "../state/vault.ts";
import { sendAndConfirm } from "../store/sender.ts";
import { fmtBytes } from "../util/bytes.ts";
import { UsageError, flag, has, type Args } from "./args.ts";
import { confirm, loadKeypair, pull } from "./cmd-image.ts";
import { asRoot, engineHome } from "./cmd-run.ts";
import { bold, dim, green, info, ok, out, red, table, warn, yellow } from "./term.ts";

const note = (t: string) => info(dim(t));
const sol = (lamports: number) => `${(lamports / 1e9).toFixed(4)} SOL`;
const when = (t: number) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function currentVault(): Vault {
  const c = loadConfig();
  const v = loadVault(paths.vault(), c.cluster);
  if (!v) throw new Error(`you are not signed in on ${networkLabel(c)}. Sign in first: chainboot login`);
  return v;
}

export const LOGIN_HELP = `Usage:
  chainboot login                     Sign in with your browser wallet (Phantom, Solflare, Backpack, ...)
  chainboot login --keypair <file>    Sign in with a keypair file (servers, scripts)
  chainboot logout                    Forget the login on this computer
  chainboot whoami                    Show who is signed in and the vault balance
  chainboot fund <SOL>                Add SOL to your vault from your browser wallet
  chainboot fund <SOL> --keypair <file>   Add SOL to your vault from a keypair file

Signing in lets chainboot save your machines to Solana, encrypted, and restore them on any
computer. Your wallet signs one message; from it chainboot derives an encryption key and a
small helper account (the "vault") that pays the fees of your saves, so the wallet is not
asked again. Nothing leaves this computer except the encrypted saves themselves.`;

export async function cmdLogin(a: Args): Promise<void> {
  const c = loadConfig();
  if (!flag(a, "keypair")) {
    const { loginWithBrowser } = await import("../ui/login.ts");
    await loginWithBrowser(c);
    return;
  }
  const v = vaultFromKeypair(loadKeypair(a), c.cluster);
  saveVault(paths.vault(), v);
  ok(`signed in as ${bold(v.wallet)} on ${networkLabel(c)}`);
  await showVault(v);
}

async function showVault(v: Vault): Promise<void> {
  let balance: number | null = null;
  try { balance = (await (await openStore(loadConfig(), note)).pool.call<{ value: number }>("getBalance", [v.signer.address, { commitment: "confirmed" }])).value; } catch { /* offline: show what we know */ }
  out(table([
    ["wallet", v.wallet],
    ["network", networkLabel(loadConfig(), v.cluster)],
    ["vault", v.signer.address],
    ["vault balance", balance === null ? dim("unknown (no RPC answer)") : sol(balance)],
    ["share address", myShareAddress(v)],
  ]));
  info(dim("Give your share address to people who want to share a machine or a private image with you."));
  if (balance !== null && balance < 5_000_000) info(dim("The vault pays the fees of your saves. Add a little SOL to it: chainboot fund 0.05"));
}

export function cmdLogout(): void {
  const c = loadConfig();
  if (forgetVault(paths.vault(), c.cluster)) ok(`signed out on ${networkLabel(c)}. Your saves stay on chain; sign in again to reach them.`);
  else info("nobody is signed in");
}

export async function cmdWhoami(): Promise<void> {
  const c = loadConfig();
  const v = loadVault(paths.vault(), c.cluster);
  if (!v) { info(`nobody is signed in on ${networkLabel(c)}. Sign in with: chainboot login`); process.exitCode = 1; return; }
  await showVault(v);
}

export async function cmdFund(a: Args): Promise<void> {
  // (a plain decimal number of SOL, with at most the nine places a lamport has: not 1e9, not 0x10)
  const text = (a._[0] ?? "").replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,9})?$/.test(text) || a._.length > 1 || Math.round(Number(text) * 1e9) < 1) throw new UsageError("say how much, in SOL: chainboot fund 0.05   (from a keypair file instead of a browser wallet: --keypair <file>)");
  const amount = Number(text);
  const v = currentVault();
  if (!flag(a, "keypair") && !process.env.CHAINBOOT_KEYPAIR) {
    const { fundWithBrowser } = await import("../ui/login.ts");
    await fundWithBrowser(loadConfig(), v, amount);
    return;
  }
  const from = loadKeypair(a);
  const lamports = Math.round(amount * 1e9);
  const store = await openStore(loadConfig(), note);
  if (!(await confirm(`Send ${sol(lamports)} from ${from.address} to your vault ${v.signer.address}?`, a))) { info("cancelled"); return; }
  const sig = await sendAndConfirm(store.pool, (bh) => buildTransaction(from, [transferInstruction(from.publicKey, v.signer.publicKey, lamports)], bh, { version: "legacy" }));
  ok(`sent ${sol(lamports)} to the vault`);
  info(dim(sig));
}

export const SAVE_HELP = `Usage:
  chainboot save [machine] [--note <text>] [--force] [--yes]
  chainboot restore [machine] [--snapshot <number>] [--yes]
  chainboot history <machine>
  chainboot status
  chainboot autosave <machine> on|off

save      Stores everything that differs from the image (installed packages, files, settings)
          on chain, encrypted with your key. Only data that is not on chain yet is uploaded.
restore   Brings a machine back from chain, on this or any other computer. Without a machine
          name it lists what you have saved. --snapshot goes back to an earlier save.
history   Lists the saves of a machine.
status    Shows your login and the save state of every machine.
autosave  After a session ends, chainboot saves by itself in the background (on by default
          once you are signed in). Saves that would cost more than 0.05 SOL wait for you.

Not saved: /tmp, /run, package download caches and other data the system rebuilds by itself.
Data written to the ledger cannot be erased; removing a save only removes the pointer to it.`;

function pickMachine(a: Args): string {
  const home = engineHome();
  if (a._[0]) return a._[0];
  const all = listMachines(home);
  if (all.length === 1) return all[0]!.name;
  if (!all.length) throw new Error("there are no machines yet. Create one with: chainboot run ubuntu");
  throw new UsageError(`say which machine: ${all.map((m) => m.name).join(", ")}`);
}

export function cmdSave(a: Args): void {
  const name = pickMachine(a);
  if (!readMachine(engineHome(), name)) throw new Error(`there is no machine named "${name}"`);
  currentVault();
  const extra = [...(has(a, "force") ? ["--force"] : []), ...(has(a, "yes") ? ["--yes"] : []), ...(flag(a, "note") ? ["--note", flag(a, "note")!] : [])];
  process.exitCode = asRoot(["save", name, ...extra]);
}

export async function cmdRestore(a: Args): Promise<void> {
  const c = loadConfig();
  const v = currentVault();
  const store = await openStore(c, note);
  const index = await readIndex(store, v);
  const saved = Object.entries(index.machines);
  const name = a._[0];
  if (!name) {
    if (!saved.length) { info("You have no saved machines yet. Save one with: chainboot save <machine>"); return; }
    const rows: string[][] = [];
    for (const [n, m] of saved.sort()) {
      const head = await readHead(store, v, n).catch(() => null);
      rows.push([bold(n), `${m.image.name}:${m.image.tag}`, m.image.arch, head ? `#${head.seq}` : dim("-"), head ? when(head.time) : dim("-")]);
    }
    out(table(rows, ["machine", "image", "arch", "last save", "saved at"]));
    info(dim("Restore one with: chainboot restore <machine>"));
    return;
  }
  const entry = index.machines[name];
  if (!entry) throw new Error(`no saved machine named "${name}" was found for this login. Saved: ${saved.map(([n]) => n).join(", ") || "none"}`);
  const home = engineHome();
  const local = readMachine(home, name);
  if (local && local.image.digest !== entry.image.digest) throw new Error(`a different machine named "${name}" exists on this computer (made from ${local.image.name}:${local.image.tag}). Remove it first: chainboot rm ${name}`);
  if (local && fs.existsSync(path.join(machineDir(home, name), "upper")) && !(await confirm(`Replace the local state of "${name}" with the saved one? Local changes that were not saved are lost.`, a))) { info("cancelled"); return; }
  const snapshot = flag(a, "snapshot");
  if (snapshot !== undefined && !/^\d+$/.test(snapshot)) throw new UsageError("--snapshot takes a save number, see: chainboot history <machine>");
  await pull(store, entry.image.publisher, { ...entry.image.manifest, digest: entry.image.digest, private: entry.image.private }, `${entry.image.name}:${entry.image.tag}`);
  if (!local) {
    const machine: MachineInfo = { name, image: entry.image, created: entry.created, ...(entry.boot && { boot: true }), ...(entry.lazy && { lazy: true }) };
    fs.mkdirSync(machineDir(home, name), { recursive: true });
    fs.writeFileSync(path.join(machineDir(home, name), "machine.json"), JSON.stringify(machine, null, 2) + "\n");
  }
  process.exitCode = asRoot(["restore", name, snapshot ?? "latest"]);
}

export async function cmdHistory(a: Args): Promise<void> {
  const name = pickMachine(a);
  const v = currentVault();
  const store = await openStore(loadConfig(), note);
  const head = await readHead(store, v, name);
  if (!head) { info(`"${name}" has never been saved with this login.`); return; }
  const snap = await readSnapshot(store, v, head.ref, path.join(paths.cache(), "objects"));
  const bytes = snap.tree.reduce((n, t) => n + (t[1] === "f" ? t[6] : 0), 0);
  const rows = [[bold(`#${head.seq}`), when(head.time), String(snap.tree.length), fmtBytes(bytes), green("current"), snap.note ?? ""],
    ...snap.history.map((h) => [`#${h.seq}`, when(h.time), String(h.files), fmtBytes(h.bytes), "", h.note ?? ""])];
  out(table(rows, ["save", "time", "entries", "size of changes", "", "note"]));
  const oldest = snap.history[snap.history.length - 1];
  if (oldest && oldest.seq > 1) info(dim(`Saves before #${oldest.seq} are kept too; they are not listed here, but "restore --snapshot" reaches them.`));
  info(dim(`Go back to an earlier save with: chainboot restore ${name} --snapshot <number>`));
}

export async function cmdStatus(): Promise<void> {
  const c = loadConfig();
  const v = loadVault(paths.vault(), c.cluster);
  if (v) await showVault(v); else info(`Not signed in on ${networkLabel(c)} (machines are not saved to chain). Sign in with: chainboot login`);
  const home: EngineHome = engineHome();
  const machines = listMachines(home);
  if (!machines.length) return;
  out("");
  out(table(machines.map((m) => {
    const dir = machineDir(home, m.name);
    const s = readSaveStatus(dir);
    const auto = fs.existsSync(path.join(dir, "autosave-off")) ? "off" : v ? "on" : dim("-");
    let state = dim("never saved");
    if (s) {
      state = s.state === "saved" ? green(`saved (#${s.seq})`) : s.state === "saving" ? yellow("saving…") : s.state === "nothing-to-save" ? green("saved")
        : s.state === "conflict" ? red("conflict") : s.state === "no-funds" ? red("vault needs SOL") : s.state === "needs-confirmation" ? yellow("waiting for you") : red("failed");
    }
    return [bold(m.name), m.running ? green("running") : "stopped", state, auto, s?.time ? when(s.time) : dim("-")];
  }), ["machine", "state", "saved to chain", "autosave", "last save"]));
  for (const m of machines) {
    const s = readSaveStatus(machineDir(home, m.name));
    if (s?.message && s.state !== "saved") warn(`${m.name}: ${s.message}`);
  }
}

export function cmdAutosave(a: Args): void {
  const [name, value] = a._;
  if (!name || (value !== "on" && value !== "off")) throw new UsageError("usage: chainboot autosave <machine> on|off");
  if (!readMachine(engineHome(), name)) throw new Error(`there is no machine named "${name}"`);
  process.exitCode = asRoot(["autosave", name, value]);
}
