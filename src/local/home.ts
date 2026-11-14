// Where chainboot keeps its files on this computer, and the user's settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GENESIS, RpcPool, maskRpcUrl, type Cluster, type ProbeCache } from "../solana/rpc.ts";
import { isList, parseList, type ListSpec } from "../registry/lists.ts";
import { addressToBytes } from "../solana/keys.ts";
import { MEMO_PROGRAM, NOOP_PROGRAM, type Carrier } from "../solana/tx.ts";
import { b58encode } from "../util/base58.ts";
import { ChainStore } from "../store/store.ts";

/** Publisher of the example images (Solinux). Unprefixed image names resolve to this key. */
export const OFFICIAL_PUBLISHER: Record<string, string | null | undefined> = {
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
  /** Extra fee per transaction in lamports, to get ahead when the network is busy (0 or absent: none). */
  priorityFeeLamports?: number;
  /** Also keep new pointers in accounts (one request reads them; a refundable deposit per pointer). */
  accounts?: boolean;
  /**
   * Other chains that speak Solana's RPC, by genesis hash: the name the user gave them and the
   * program that carries data there (found out when the network is added).
   */
  networks?: Record<string, { name: string; carrier?: Carrier }>;
}

/** The name people use for a network: Solana's own names, or the one given to another chain. */
export function networkLabel(c: Config, id: string = c.cluster): string {
  return id in GENESIS ? id : c.networks?.[id]?.name ?? `network ${id.slice(0, 8)}…`;
}

/** The genesis hash that endpoints of a network must report. */
export function networkGenesis(c: Config, id: string = c.cluster): string {
  const g = GENESIS[id] ?? (c.networks?.[id] ? id : null);
  if (!g) throw new Error(`unknown network "${id}". See the networks with: chainboot network list`);
  return g;
}

/** Finds a network by what a person typed: a Solana network name, "mainnet", the name of an added chain, or its genesis hash. */
export function findNetwork(c: Config, text: string): string | null {
  const name = text === "mainnet" ? "mainnet-beta" : text;
  if (name in GENESIS) return name;
  for (const [id, n] of Object.entries(c.networks ?? {})) if (n.name === text || id === text) return id;
  return null;
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
  if (c.cluster && !(c.cluster in GENESIS) && !c.networks?.[c.cluster]) throw new Error(`unknown network "${String(c.cluster)}" in ${paths.config()} (use devnet, testnet, mainnet-beta, or add the chain with "chainboot network add")`);
  const fee = Number(c.priorityFeeLamports);
  return { cluster: c.cluster ?? base.cluster, rpcs: c.rpcs ?? {}, publishers: c.publishers ?? {}, ...(Number.isInteger(fee) && fee > 0 && { priorityFeeLamports: fee }), ...(c.accounts === true && { accounts: true }), ...(c.networks && Object.keys(c.networks).length && { networks: c.networks }) };
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
  const genesis = networkGenesis(c);
  try { report = await pool.probe(genesis, known); } catch (e) {
    // every endpoint was written off from memory: ask them all again before giving up
    if (!Object.keys(known).length) throw e;
    known = {};
    pool = new RpcPool(urls, { onNote });
    report = await pool.probe(genesis, known);
  }
  if (JSON.stringify(known) !== before) {
    try { fs.mkdirSync(paths.cache(), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(known)); } catch { /* the cache is optional */ }
  }
  for (const r of report) if (!r.ok) onNote?.(`skipping ${r.label}: ${r.detail}`);
  const fee = c.priorityFeeLamports ? { priorityFeeLamports: c.priorityFeeLamports } : {};
  // (CHAINBOOT_CARRIER=memo makes a Solana network be written to the way a chain without Noop is: for trying that path out)
  if (c.cluster in GENESIS && process.env.CHAINBOOT_CARRIER === "memo") return new ChainStore(pool, { ...fee, txVersion: "legacy", carrier: "memo" });
  if (c.cluster in GENESIS) return new ChainStore(pool, { ...fee, ...(c.accounts && { accounts: true }) });
  // another chain: the long transaction format and the programs chainboot uses on Solana may not
  // exist there, so it writes in the format every such chain has and asks which program can carry data
  const network = c.networks![c.cluster]!;
  if (!network.carrier) {
    network.carrier = await detectCarrier(pool);
    try { const fresh = loadConfig(); if (fresh.networks?.[c.cluster]) { fresh.networks[c.cluster]!.carrier = network.carrier; saveConfig(fresh); } } catch { /* asked again next time */ }
  }
  return new ChainStore(pool, { ...fee, txVersion: "legacy", carrier: network.carrier });
}

/** Finds out which program can carry chainboot's data on a chain: Noop where it is deployed, Memo otherwise. */
export async function detectCarrier(pool: RpcPool): Promise<Carrier> {
  const deployed = async (program: Uint8Array) => {
    const r = await pool.call<{ value: { executable: boolean } | null }>("getAccountInfo", [b58encode(program), { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]);
    return !!r?.value?.executable;
  };
  if (await deployed(NOOP_PROGRAM)) return "noop";
  if (await deployed(MEMO_PROGRAM)) return "memo";
  throw new Error("this chain has neither the Noop nor the Memo program, so chainboot has no way to put data into its transactions");
}

/** Where images come from: one publisher's catalog, or a list that several publishers keep together. */
export type Source = { kind: "publisher"; address: string; label: string } | { kind: "list"; spec: ListSpec; label: string };

/** Turns "official", a saved name, an address or a list into a source of images. */
export function resolveSource(c: Config, who: string | undefined): Source {
  let value: string, label: string;
  if (!who || who === "official") {
    const p = OFFICIAL_PUBLISHER[c.cluster];
    if (!p) throw new Error(`there is no official publisher on ${networkLabel(c)} yet; name one explicitly: <publisher-address>/<image>`);
    value = p; label = "official";
  } else { value = c.publishers[who] ?? who; label = c.publishers[who] ? who : value; }
  if (isList(value)) return { kind: "list", spec: parseList(value), label };
  try { addressToBytes(value); } catch { throw new Error(`"${who}" is neither a saved publisher name, a Solana address nor a list`); }
  return { kind: "publisher", address: value, label: label === value ? value : `${label} (${value})` };
}

/** Turns "official", a saved name or an address into a publisher address. (A list has no single address.) */
export function resolvePublisher(c: Config, who: string | undefined): string {
  const s = resolveSource(c, who);
  if (s.kind === "list") throw new Error(`"${who ?? "official"}" is a list of ${s.spec.members.length} publishers, not one publisher`);
  return s.address;
}

export function hostArch(): string {
  const map: Record<string, string> = { x64: "amd64", arm64: "arm64", arm: "armhf", riscv64: "riscv64", ppc64: "ppc64el", s390x: "s390x", ia32: "i386" };
  return map[process.arch] ?? process.arch;
}

export { maskRpcUrl };
