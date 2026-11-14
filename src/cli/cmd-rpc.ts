import { GENESIS, RpcPool, maskRpcUrl, type Cluster } from "../solana/rpc.ts";
import { loadConfig, rpcUrls, saveConfig, NO_RPC_HELP } from "../local/home.ts";
import { UsageError, type Args } from "./args.ts";
import { bold, dim, green, info, ok, out, red, table } from "./term.ts";

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
