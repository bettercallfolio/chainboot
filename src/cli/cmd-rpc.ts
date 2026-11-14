import { GENESIS, RpcPool, maskRpcUrl, type Cluster } from "../solana/rpc.ts";
import { loadConfig, rpcUrls, saveConfig, NO_RPC_HELP } from "../local/home.ts";
import { UsageError, type Args } from "./args.ts";
import { bold, dim, green, info, ok, out, red, table } from "./term.ts";

export const ACCOUNTS_HELP = `Usage:
  chainboot accounts                     Show the setting
  chainboot accounts on | off            Keep new pointers in accounts as well, or not
  chainboot accounts close [--keypair <file>]
                                         Close them again and get the deposits back

chainboot stores everything in transactions. To find the newest catalog of a publisher, or
the newest save of a machine, a reader asks an endpoint for the history of an address, which
is the slowest question an endpoint answers. With this setting on, each pointer you write is
also kept in an account: there one request reads it, on every endpoint.

  - Each pointer account holds a deposit of about 0.0033 SOL (Solana calls it rent). It comes
    back when the account is closed.
  - Readers need no setting. They look for the account first and check the signature in it;
    without one they read the transactions as before.
  - Once an account exists it is kept up to date by every later write, also with the setting
    off, so it never shows an old pointer. To stop using accounts, close them.
  - "close" without a keypair closes the accounts of the signed-in wallet's vault (machine
    list, saves, private catalog); with --keypair, the account of that publisher's catalog.

It uses the SPL Record program, which is on devnet and mainnet.`;

export async function cmdAccounts(a: Args): Promise<void> {
  const c = loadConfig();
  const want = a._[0];
  if (!want) {
    out(c.accounts ? "New pointers are kept in accounts as well (one request reads them)." : "Pointers are kept in transactions only.");
    info(dim(c.accounts ? "Turn it off with: chainboot accounts off   Get the deposits back with: chainboot accounts close" : "Turn it on with: chainboot accounts on   (a deposit of about 0.0033 SOL per pointer, returned on close)"));
    return;
  }
  if (want === "on" || want === "off") {
    if (want === "on") c.accounts = true; else delete c.accounts;
    saveConfig(c);
    ok(want === "on" ? "new pointers are kept in accounts as well" : "new pointers are no longer put into accounts");
    if (want === "off") info(dim("Accounts that exist are still kept up to date. Close them with: chainboot accounts close"));
    return;
  }
  if (want !== "close") throw new UsageError("use: chainboot accounts [on|off|close]");
  const { openStore, paths } = await import("../local/home.ts");
  const { loadKeypair } = await import("./cmd-image.ts");
  const store = await openStore(c, (t) => info(dim(t)));
  const closed: [string, number][] = [];
  if (a.flags.has("keypair") || process.env.CHAINBOOT_KEYPAIR) {
    const { catalogTagOf } = await import("../registry/registry.ts");
    const payer = loadKeypair(a);
    closed.push([`catalog of ${payer.address}`, await store.closePointerAccount(payer, catalogTagOf(payer.publicKey))]);
  } else {
    const { loadVault } = await import("../state/vault.ts");
    const { indexTagOf, readIndex, stateTagOf } = await import("../state/snapshot.ts");
    const { privateTagOf } = await import("../registry/private.ts");
    const v = loadVault(paths.vault(), c.cluster);
    if (!v) throw new Error("nobody is signed in. Sign in (chainboot login), or name a publisher's keypair: chainboot accounts close --keypair <file>");
    const index = await readIndex(store, v);
    for (const name of Object.keys(index.machines)) closed.push([`save of ${name}`, await store.closePointerAccount(v.signer, stateTagOf(v, name))]);
    closed.push(["machine list", await store.closePointerAccount(v.signer, indexTagOf(v))]);
    closed.push(["private catalog", await store.closePointerAccount(v.signer, privateTagOf(v))]);
  }
  const done = closed.filter(([, lamports]) => lamports > 0);
  if (!done.length) { info("There was no pointer account to close."); return; }
  out(table(done.map(([what, lamports]) => [what, `${(lamports / 1e9).toFixed(6)} SOL`]), ["closed", "deposit returned"]));
  ok(`${done.length} account(s) closed, ${(done.reduce((n, [, l]) => n + l, 0) / 1e9).toFixed(6)} SOL returned. The pointers stay in the ledger.`);
}

export const RPC_HELP = `Usage:
  chainboot rpc add <url> [<url> ...]   Add RPC endpoints for the current network
  chainboot rpc list                    Show the endpoints (API keys are hidden)
  chainboot rpc remove <number|url>     Remove one endpoint (number from "rpc list")
  chainboot rpc test                    Check that every endpoint answers and is on the right network

  chainboot network                     Show the current network
  chainboot network <devnet|testnet|mainnet-beta>   Switch network

More endpoints make downloads and uploads faster: chainboot spreads the work over all of
them and learns how fast each one may be used. You can also set CHAINBOOT_RPC to a list of
URLs (separated by commas) instead of saving them.`;

export async function cmdRpc(a: Args): Promise<void> {
  const c = loadConfig();
  const sub = a._[0] ?? "list";
  const list = c.rpcs[c.cluster] ?? [];
  if (sub === "add") {
    const urls = [...new Set(a._.slice(1).map((u) => u.trim()))];
    if (!urls.length) throw new UsageError("give at least one URL: chainboot rpc add https://...");
    const fresh = urls.filter((u) => !list.includes(u));
    const report = await new RpcPool(urls).probe().catch((e: Error) => { throw new Error(e.message); });
    const good: string[] = [];
    urls.forEach((u, i) => {
      const r = report[i]!;
      if (!r.ok) { info(`${red("✖")} ${r.label}: ${r.detail}`); return; }
      if (r.detail !== c.cluster) { info(`${red("✖")} ${r.label} is a ${r.detail} endpoint, but the current network is ${c.cluster}. Switch with: chainboot network ${r.detail}`); return; }
      if (fresh.includes(u)) good.push(u);
      info(`${green("✔")} ${r.label} (${r.detail})${fresh.includes(u) ? "" : dim(" already saved")}`);
    });
    if (good.length) { c.rpcs[c.cluster] = [...list, ...good]; saveConfig(c); }
    ok(`${c.rpcs[c.cluster]?.length ?? 0} endpoint(s) saved for ${c.cluster}`);
    return;
  }
  if (sub === "list") {
    const env = !!process.env.CHAINBOOT_RPC;
    const urls = rpcUrls(c);
    if (!urls.length) { info(NO_RPC_HELP); return; }
    out(table(urls.map((u, i) => [String(i + 1), maskRpcUrl(u)]), ["#", `endpoint (${c.cluster}${env ? ", from CHAINBOOT_RPC" : ""})`]));
    return;
  }
  if (sub === "remove") {
    const what = a._[1];
    if (!what) throw new UsageError("say which one: chainboot rpc remove <number|url>");
    const idx = /^\d+$/.test(what) ? Number(what) - 1 : list.indexOf(what);
    if (idx < 0 || idx >= list.length) throw new Error(`no such endpoint: ${what}`);
    const [gone] = list.splice(idx, 1);
    c.rpcs[c.cluster] = list; saveConfig(c);
    ok(`removed ${maskRpcUrl(gone!)}`);
    return;
  }
  if (sub === "test") {
    const urls = rpcUrls(c);
    if (!urls.length) { info(NO_RPC_HELP); process.exitCode = 1; return; }
    const pool = new RpcPool(urls);
    const report = await pool.probe().catch(() => [] as { label: string; ok: boolean; detail: string }[]);
    let bad = 0;
    out(table(report.map((r) => {
      const fine = r.ok && r.detail === c.cluster;
      if (!fine) bad++;
      return [fine ? green("✔") : red("✖"), r.label, r.ok && !fine ? `${r.detail} (current network is ${c.cluster})` : r.detail];
    }), ["", "endpoint", "result"]));
    if (!report.length) throw new Error("none of the endpoints answered");
    if (bad) process.exitCode = 1;
    return;
  }
  throw new UsageError(`unknown rpc command "${sub}"`);
}

export const FEE_HELP = `Usage:
  chainboot priority-fee                 Show the current setting
  chainboot priority-fee <lamports>      Add this tip to every transaction chainboot sends
  chainboot priority-fee off             Send without a tip (the default)

When the network is busy, transactions that pay a small extra "priority fee" are included
first. The normal fee of a transaction is 5,000 lamports (0.000005 SOL); a tip of 1,000 to
10,000 lamports is usually plenty. The tip applies to publishing and to saving, and is
included in every cost estimate chainboot shows. Uploads complete without a tip too: chainboot
sends again whatever did not land.`;

export function cmdPriorityFee(a: Args): void {
  const c = loadConfig();
  const want = a._[0];
  if (want === undefined) {
    out(c.priorityFeeLamports ? `${bold(String(c.priorityFeeLamports))} lamports per transaction ${dim(`(${(c.priorityFeeLamports / 1e9).toFixed(9)} SOL on top of the 0.000005 SOL fee)`)}` : `${bold("off")} ${dim("(transactions pay only the normal fee)")}`);
    return;
  }
  if (want === "off" || want === "0") { delete c.priorityFeeLamports; saveConfig(c); ok("priority fee is off"); return; }
  const n = Number(want);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new UsageError("give the tip in lamports, a whole number up to 10,000,000 (0.01 SOL), or \"off\"");
  c.priorityFeeLamports = n; saveConfig(c);
  ok(`every transaction now carries a tip of ${n} lamports`);
  if (n > 100_000) info(dim("That is a large tip: storing 1 MB (261 transactions) will cost " + ((261 * (5000 + n)) / 1e9).toFixed(4) + " SOL."));
}

export function cmdNetwork(a: Args): void {
  const c = loadConfig();
  const want = a._[0];
  if (!want) { out(`${bold(c.cluster)} ${dim(`(${(c.rpcs[c.cluster] ?? []).length} saved endpoint(s))`)}`); return; }
  const name = want === "mainnet" ? "mainnet-beta" : want;
  if (!(name in GENESIS)) throw new UsageError(`unknown network "${want}". Choose devnet, testnet or mainnet-beta.`);
  c.cluster = name as Cluster; saveConfig(c);
  ok(`network is now ${name}`);
  if (!(c.rpcs[c.cluster] ?? []).length) info(dim(`no endpoints saved for ${name} yet: chainboot rpc add <url>`));
}
