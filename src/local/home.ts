// Where chainboot keeps its files on this computer, and the user's settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GENESIS, RpcPool, maskRpcUrl, type Cluster, type ProbeCache } from "../solana/rpc.ts";
import { addressToBytes } from "../solana/keys.ts";
import { ChainStore } from "../store/store.ts";

/** Publisher of the example images (Solbuntu). Unprefixed image names resolve to this key. */
export const OFFICIAL_PUBLISHER: Record<Cluster, string | null> = {
  devnet: "HM4msDau4mPX9P2qinBPTGKiU1TZW5e86jTukeufr5uu",
  testnet: null,
  "mainnet-beta": null,
};

export interface Config {
  cluster: Cluster;
  /** RPC endpoint URLs per network. They can contain API keys, so the file is private (mode 600). */
  rpcs: Partial<Record<Cluster, string[]>>;
  /** Short names for publisher addresses: `alice/alpine` instead of the full address. */
  publishers: Record<string, string>;
}

export function homeDir(): string {
  return process.env.CHAINBOOT_HOME || path.join(os.homedir(), ".chainboot");
}

export const paths = {
  config: () => path.join(homeDir(), "config.json"),
  cache: () => path.join(homeDir(), "cache"),
  journals: () => path.join(homeDir(), "journals"),
  images: () => path.join(homeDir(), "images"),
  machines: () => path.join(homeDir(), "machines"),
  vault: () => path.join(homeDir(), "vault"),
};

export function loadConfig(): Config {
  const base: Config = { cluster: "devnet", rpcs: {}, publishers: {} };
  let text: string;
  try { text = fs.readFileSync(paths.config(), "utf8"); } catch { return base; }
  let c: Partial<Config>;
  try { c = JSON.parse(text) as Partial<Config>; } catch { throw new Error(`${paths.config()} is not valid JSON. Fix it or delete it to start fresh.`); }
  if (c.cluster && !(c.cluster in GENESIS)) throw new Error(`unknown network "${String(c.cluster)}" in ${paths.config()} (use devnet, testnet or mainnet-beta)`);
  return { cluster: c.cluster ?? base.cluster, rpcs: c.rpcs ?? {}, publishers: c.publishers ?? {} };
}

export function saveConfig(c: Config): void {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const tmp = `${paths.config()}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, paths.config());
}

/** RPC URLs for the active network: CHAINBOOT_RPC (comma or space separated) wins over the config file. */
export function rpcUrls(c: Config): string[] {
  const env = process.env.CHAINBOOT_RPC?.split(/[\s,]+/).filter(Boolean);
  return env?.length ? env : c.rpcs[c.cluster] ?? [];
}

export const NO_RPC_HELP = `No RPC endpoint is configured yet.

chainboot reads the blockchain through RPC endpoints, and you bring your own.
Free ones take a minute to get, for example from Helius, QuickNode, Alchemy, Triton or Ankr.
Add as many as you like; more endpoints mean faster downloads:

  chainboot rpc add https://your-endpoint.example/your-key
`;

/** Connects to the active network and drops endpoints that are dead or belong to another network. */
export async function openStore(c: Config, onNote?: (text: string) => void): Promise<ChainStore> {
  const urls = rpcUrls(c);
  if (!urls.length) throw new Error(NO_RPC_HELP);
  const cacheFile = path.join(paths.cache(), "endpoints.json");
  let known: ProbeCache = {};
  try { known = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as ProbeCache; } catch { /* first run */ }
  const before = JSON.stringify(known);
  let pool = new RpcPool(urls, { onNote });
  let report: { label: string; ok: boolean; detail: string }[];
  try { report = await pool.probe(GENESIS[c.cluster], known); } catch (e) {
    // every endpoint was written off from memory: ask them all again before giving up
    if (!Object.keys(known).length) throw e;
    known = {};
    pool = new RpcPool(urls, { onNote });
    report = await pool.probe(GENESIS[c.cluster], known);
  }
  if (JSON.stringify(known) !== before) {
    try { fs.mkdirSync(paths.cache(), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(known)); } catch { /* the cache is optional */ }
  }
  for (const r of report) if (!r.ok) onNote?.(`skipping ${r.label}: ${r.detail}`);
  return new ChainStore(pool);
}

/** Turns "official", an alias or an address into a publisher address. */
export function resolvePublisher(c: Config, who: string | undefined): string {
  if (!who || who === "official") {
    const p = OFFICIAL_PUBLISHER[c.cluster];
    if (!p) throw new Error(`there is no official publisher on ${c.cluster} yet; name one explicitly: <publisher-address>/<image>`);
    return p;
  }
  const address = c.publishers[who] ?? who;
  try { addressToBytes(address); } catch { throw new Error(`"${who}" is neither a known publisher alias nor a Solana address`); }
  return address;
}

export function hostArch(): string {
  const map: Record<string, string> = { x64: "amd64", arm64: "arm64", arm: "armhf", riscv64: "riscv64", ppc64: "ppc64el", s390x: "s390x", ia32: "i386" };
  return map[process.arch] ?? process.arch;
}

export { maskRpcUrl };
