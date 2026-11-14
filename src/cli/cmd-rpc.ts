import { GENESIS, RpcPool, maskRpcUrl } from "../solana/rpc.ts";
import { addNetwork, findNetwork, loadConfig, networkGenesis, networkLabel, removeNetwork, rpcUrls, saveConfig, setPriorityFee, NO_RPC_HELP } from "../local/home.ts";
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
    const good: string[] = [], here = networkGenesis(c);
    urls.forEach((u, i) => {
      const r = report[i]!;
      if (!r.ok) { info(`${red("✖")} ${r.label}: ${r.detail}`); return; }
      // the probe names Solana's own networks; anything else it reports by its genesis hash
      const serves = (GENESIS[r.detail] ?? r.genesis) === here;
      if (!serves) { info(`${red("✖")} ${r.label} is an endpoint of ${r.detail in GENESIS ? r.detail : networkLabel(c, r.genesis ?? "")}, but the current network is ${networkLabel(c)}. Switch with: chainboot network <name>`); return; }
      if (fresh.includes(u)) good.push(u);
      info(`${green("✔")} ${r.label} (${networkLabel(c)})${fresh.includes(u) ? "" : dim(" already saved")}`);
    });
    if (good.length) { c.rpcs[c.cluster] = [...list, ...good]; saveConfig(c); }
    const kept = urls.filter((u) => (c.rpcs[c.cluster] ?? []).includes(u)).length;
    (kept === urls.length ? ok : info)(`${c.rpcs[c.cluster]?.length ?? 0} endpoint(s) saved for ${networkLabel(c)}`);
    // an endpoint that was turned away is a failure of the command, also when others were added
    if (kept < urls.length) process.exitCode = 1;
    return;
  }
  if (sub === "list") {
    const env = !!process.env.CHAINBOOT_RPC;
    const urls = rpcUrls(c);
    if (!urls.length) { info(NO_RPC_HELP); return; }
    out(table(urls.map((u, i) => [String(i + 1), maskRpcUrl(u)]), ["#", `endpoint (${networkLabel(c)}${env ? ", from CHAINBOOT_RPC" : ""})`]));
    return;
  }
  if (sub === "remove") {
    const what = a._[1];
    if (!what) throw new UsageError("say which one: chainboot rpc remove <number|url>");
    // (the numbers of "rpc list" are those of CHAINBOOT_RPC while it is set, not those of the saved endpoints)
    if (process.env.CHAINBOOT_RPC && /^\d+$/.test(what)) throw new Error("the endpoints in use come from CHAINBOOT_RPC, so the numbers of \"rpc list\" are not those of the saved endpoints. Unset it to see and remove saved ones, or name the saved endpoint by its URL.");
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
    const report = await pool.probe().catch(() => [] as { label: string; ok: boolean; detail: string; genesis?: string }[]);
    let bad = 0;
    const here = networkGenesis(c);
    out(table(report.map((r) => {
      const fine = r.ok && (GENESIS[r.detail] ?? r.genesis) === here;
      if (!fine) bad++;
      return [fine ? green("✔") : red("✖"), r.label, fine ? networkLabel(c) : r.ok ? `${r.detail} (current network is ${networkLabel(c)})` : r.detail];
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
  if (want === "off" || want === "0") { setPriorityFee(c, 0); ok("priority fee is off"); return; }
  const n = /^\d+$/.test(want) ? Number(want) : NaN;
  try { setPriorityFee(c, n); } catch (e) { throw new UsageError((e as Error).message); }
  ok(`every transaction now carries a tip of ${n} lamports`);
  if (n > 100_000) info(dim("That is a large tip: storing 1 MB (261 transactions) will cost " + ((261 * (5000 + n)) / 1e9).toFixed(4) + " SOL."));
}

export const NETWORK_HELP = `Usage:
  chainboot network                        Show the current network
  chainboot network <name>                 Switch: devnet, testnet, mainnet-beta, or a chain you added
  chainboot network list                   Show all networks
  chainboot network add <name> <rpc-url>   Add another chain that speaks Solana's RPC
  chainboot network remove <name>          Forget an added chain

chainboot works on Solana's own networks out of the box. It also works on other chains that
run Solana programs and answer Solana's RPC (often called SVM chains). Adding one takes its
name and one endpoint; chainboot asks the endpoint which chain it is and remembers the chain
by its genesis hash, so every endpoint you add later is checked against it.

  chainboot network add mychain https://rpc.mychain.example
  chainboot rpc add https://another-endpoint.example      # more endpoints for it
  chainboot network devnet                                # back to Solana's devnet

On such a chain chainboot uses the transaction format every chain has (1232 bytes instead of
4096) and, where the Noop program is not deployed, the Memo program, which carries the data
as text. Both make storing data cost more transactions than on Solana. There is no official
catalog there: name a publisher (<address>/<image>) or publish your own. Each chain has its
own logins, vault and saves.`;

export async function cmdNetwork(a: Args): Promise<void> {
  const c = loadConfig();
  const [want, name, url] = a._;
  if (!want) {
    out(`${bold(networkLabel(c))} ${dim(`(${(c.rpcs[c.cluster] ?? []).length} saved endpoint(s)${c.cluster in GENESIS ? "" : `, genesis ${c.cluster}`})`)}`);
    return;
  }
  if (want === "list") {
    const rows = [...Object.keys(GENESIS).map((id) => [id, "Solana", GENESIS[id]!]), ...Object.entries(c.networks ?? {}).map(([id, n]) => [n.name, `added chain${n.carrier ? ` (data through the ${n.carrier === "memo" ? "Memo" : "Noop"} program)` : ""}`, id])];
    out(table(rows.map(([label, kind, id]) => [(c.cluster in GENESIS ? c.cluster === label : c.cluster === id) ? green("●") : " ", bold(label!), kind!, String((c.rpcs[label! in GENESIS ? label! : id!] ?? []).length), id!]), ["", "network", "kind", "endpoints", "genesis hash"]));
    return;
  }
  if (want === "add") {
    if (!name || !url) throw new UsageError("usage: chainboot network add <name> <rpc-url>");
    const { genesis, carrier } = await addNetwork(c, name, url);
    ok(`added ${bold(name)} and switched to it`);
    out(table([["genesis hash", genesis], ["data travels through", carrier === "noop" ? "the Noop program (as on Solana)" : "the Memo program, as text (this chain has no Noop program)"], ["transactions", "legacy format, 1232 bytes"]]));
    info(dim("Add more endpoints with: chainboot rpc add <url>   Go back with: chainboot network devnet"));
    return;
  }
  if (want === "remove") {
    if (!name) throw new UsageError("say which one: chainboot network remove <name>");
    removeNetwork(c, name);
    ok(`forgot ${name} and its endpoints`);
    return;
  }
  const id = findNetwork(c, want);
  if (!id) throw new UsageError(`unknown network "${want}". Choose devnet, testnet or mainnet-beta, or add a chain: chainboot network add <name> <rpc-url>`);
  c.cluster = id; saveConfig(c);
  ok(`network is now ${networkLabel(c)}`);
  if (!(c.rpcs[c.cluster] ?? []).length) info(dim(`no endpoints saved for ${networkLabel(c)} yet: chainboot rpc add <url>`));
}
