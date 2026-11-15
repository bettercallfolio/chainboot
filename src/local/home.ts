// Where chainboot keeps its files on this computer, and the user's settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GENESIS, RpcPool, clusterName, maskRpcUrl, type Cluster, type ProbeCache } from "../solana/rpc.ts";
import { formatList, isList, parseList, type ListSpec } from "../registry/lists.ts";
import { addressToBytes } from "../solana/keys.ts";
import { MEMO_PROGRAM, NOOP_PROGRAM, type Carrier } from "../solana/tx.ts";
import { b58encode } from "../util/base58.ts";
import { ChainStore } from "../store/store.ts";

/** Publisher of the official images (Solinux, Ubuntu, Arch Linux, Alpine). Unprefixed image names resolve to this key. */
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

/**
 * Inside a machine: the endpoints of the person who runs it, written there by the chainboot
 * that started the machine (see machineEndpoints in engine/linux.ts). Kept in memory only.
 */
export const MACHINE_CONFIG = "/run/chainboot/config.json";

/**
 * Endpoints that come with a system: a distribution may name some (public ones), so that
 * chainboot works there before its user has added their own. They are used last.
 */
export const SYSTEM_CONFIG = "/etc/chainboot/config.json";

/**
 * RPC URLs for the active network: CHAINBOOT_RPC (comma or space separated) wins over the
 * config file; where that names none, the endpoints a machine was started with, and last
 * the ones the system brings.
 */
export function rpcUrls(c: Config): string[] {
  const env = process.env.CHAINBOOT_RPC?.split(/[\s,]+/).filter(Boolean);
  if (env?.length) return env;
  const own = c.rpcs[c.cluster] ?? [];
  if (own.length) return own;
  for (const file of [MACHINE_CONFIG, SYSTEM_CONFIG]) {
    try {
      const given = (JSON.parse(fs.readFileSync(file, "utf8")) as { rpcs?: Record<string, unknown> }).rpcs?.[c.cluster];
      const urls = Array.isArray(given) ? given.filter((u): u is string => typeof u === "string") : [];
      if (urls.length) return urls;
    } catch { /* no such file */ }
  }
  return [];
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

/** Words that are commands of "chainboot network", so no chain can be named like them. */
const RESERVED_NETWORK_NAMES = ["mainnet", "list", "add", "remove"];

/**
 * Adds another chain that speaks Solana's RPC and switches to it: asks the endpoint which chain
 * it is (its genesis hash), finds out which program can carry data there, and saves both.
 */
export async function addNetwork(c: Config, name: string, url: string): Promise<{ genesis: string; carrier: Carrier }> {
  if (!/^[a-z0-9][a-z0-9._-]{0,30}$/.test(name) || name in GENESIS || RESERVED_NETWORK_NAMES.includes(name)) {
    throw new Error(`"${name}" cannot be used as a network name: use lower-case letters, digits, ".", "_" or "-", and not the name of a Solana network`);
  }
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error("an endpoint is a web address that starts with http:// or https://");
  const pool = new RpcPool([url]);
  const report = await pool.probe();
  const genesis = report[0]?.genesis;
  if (!report[0]?.ok || !genesis) throw new Error(`${maskRpcUrl(url)} did not answer like a Solana RPC endpoint: ${report[0]?.detail ?? "no answer"}`);
  if (Object.values(GENESIS).includes(genesis)) throw new Error(`that endpoint serves Solana ${clusterName(genesis)}, which chainboot knows already. Switch to ${clusterName(genesis)} and add the endpoint there.`);
  const taken = Object.entries(c.networks ?? {}).find(([id, n]) => n.name === name && id !== genesis);
  if (taken) throw new Error(`the name "${name}" is already used for another chain (genesis ${taken[0]})`);
  const carrier = await detectCarrier(pool);
  c.networks = { ...c.networks, [genesis]: { name, carrier } };
  if (!(c.rpcs[genesis] ?? []).includes(url)) c.rpcs[genesis] = [...(c.rpcs[genesis] ?? []), url];
  c.cluster = genesis;
  saveConfig(c);
  return { genesis, carrier };
}

/** Forgets an added chain and its endpoints. `name`: its name or its genesis hash. */
export function removeNetwork(c: Config, name: string): void {
  const id = findNetwork(c, name);
  if (!id || id in GENESIS) throw new Error(`there is no added chain named "${name}"`);
  if (c.cluster === id) throw new Error(`${networkLabel(c, id)} is the current network. Switch to another one first.`);
  delete c.networks![id]; delete c.rpcs[id];
  saveConfig(c);
}

/** Saves a short name for a publisher address or for a list of publishers. Returns what was stored. */
export function savePublisherName(c: Config, name: string, value: string): string {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name) || name === "official" || name === "me") throw new Error(`"${name}" cannot be used as a name: use letters, digits, ".", "_" or "-" (not "official" or "me")`);
  let isAddress = true;
  try { addressToBytes(name); } catch { isAddress = false; }
  if (isAddress) throw new Error("a name that is itself a Solana address would hide that publisher: choose another name");
  const stored = isList(value.trim()) ? formatList(parseList(value.trim())) : resolvePublisher({ ...c, publishers: {} }, value.trim());
  c.publishers[name] = stored;
  saveConfig(c);
  return stored;
}

export function removePublisherName(c: Config, name: string): void {
  if (!(name in c.publishers)) throw new Error(`there is no saved name "${name}"`);
  delete c.publishers[name];
  saveConfig(c);
}

/** Checks a priority fee (lamports per transaction) and saves it; 0 turns it off. */
export function setPriorityFee(c: Config, lamports: number): void {
  if (!Number.isInteger(lamports) || lamports < 0 || lamports > 10_000_000) throw new Error('give the tip in lamports, a whole number up to 10,000,000 (0.01 SOL), or "off"');
  if (lamports === 0) delete c.priorityFeeLamports; else c.priorityFeeLamports = lamports;
  saveConfig(c);
}

export function hostArch(): string {
  const map: Record<string, string> = { x64: "amd64", arm64: "arm64", arm: "armhf", riscv64: "riscv64", ppc64: "ppc64el", s390x: "s390x", ia32: "i386" };
  return map[process.arch] ?? process.arch;
}

export { maskRpcUrl };
