// The local web interface: a small HTTP server on 127.0.0.1 that only this computer can reach.
//
// Safety rules of this server:
//   - it listens on the loopback address only;
//   - every /api request must carry the random token that was printed (and opened) at start,
//     in a custom header, so other web pages cannot call it;
//   - the Host header must be the loopback address (blocks DNS-rebinding tricks);
//   - RPC URLs with their API keys are never sent to the page, only masked labels.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { listMachines, machineDir, type EngineHome } from "../engine/linux.ts";
import { engineMode } from "../engine/rootless.ts";
import { readSaveStatus } from "../engine/state-ops.ts";
import { parseManifest } from "../image/manifest.ts";
import { homeDir, hostArch, loadConfig, maskRpcUrl, openStore, paths, resolvePublisher, rpcUrls, saveConfig, OFFICIAL_PUBLISHER } from "../local/home.ts";
import { readPrivateCatalog } from "../registry/private.ts";
import { readCatalog } from "../registry/registry.ts";
import { addressToBytes } from "../solana/keys.ts";
import { GENESIS, RpcPool, type Cluster } from "../solana/rpc.ts";
import { compileMessage, parseTransaction, transferInstruction, verifyPayerSignature } from "../solana/tx.ts";
import { b58decodeFixed, b58encode } from "../util/base58.ts";
import { LOGIN_MESSAGE, deriveVault, forgetVault, loadVault, saveVault } from "../state/vault.ts";
import type { ChainStore } from "../store/store.ts";

export const UI_VERSION = 1;

interface Job { id: string; title: string; command: string[]; lines: string[]; status: "running" | "done" | "failed"; code: number | null; started: number; needsTerminal?: boolean }

export interface UiServer { url: string; port: number; token: string; close: () => void; onLogin: Promise<void> }

function engineHome(): EngineHome {
  const h = homeDir();
  return { images: path.join(h, "images"), machines: path.join(h, "machines"), cache: path.join(h, "cache") };
}

/** The command line that starts this same program (works for the bundled file and for the sources). */
function self(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1]!];
}

/** A shell command the user can paste; uses the plain name when chainboot is on the PATH. */
function printable(args: string[]): string {
  return ["chainboot", ...args].map((a) => (/^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** Opens a terminal window that runs a command and stays open. Returns false when no terminal program was found. */
export function openTerminal(args: string[]): boolean {
  const cmd = [...self(), ...args];
  const quoted = cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const hold = `${quoted}; echo; echo "[chainboot] finished. Press Enter to close this window."; read _`;
  const tryRun = (bin: string, a: string[]) => {
    if (spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status !== 0) return false;
    spawn(bin, a, { detached: true, stdio: "ignore" }).unref();
    return true;
  };
  if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script ${JSON.stringify(quoted)}\ntell application "Terminal" to activate`;
    return spawnSync("osascript", ["-e", script], { stdio: "ignore" }).status === 0;
  }
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "chainboot", "cmd.exe", "/k", ...cmd], { detached: true, stdio: "ignore" }).unref();
    return true;
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return tryRun("x-terminal-emulator", ["-e", "sh", "-c", hold]) || tryRun("gnome-terminal", ["--", "sh", "-c", hold]) || tryRun("konsole", ["-e", "sh", "-c", hold])
    || tryRun("xfce4-terminal", ["-e", `sh -c ${JSON.stringify(hold)}`]) || tryRun("kitty", ["sh", "-c", hold]) || tryRun("alacritty", ["-e", "sh", "-c", hold]) || tryRun("xterm", ["-e", "sh", "-c", hold]);
}

export function openBrowser(url: string): boolean {
  const run = (bin: string, a: string[]) => { try { spawn(bin, a, { detached: true, stdio: "ignore" }).on("error", () => {}).unref(); return true; } catch { return false; } };
  if (process.platform === "darwin") return run("open", [url]);
  if (process.platform === "win32") return run("cmd.exe", ["/c", "start", "", url]);
  if (/microsoft/i.test(fs.existsSync("/proc/version") ? fs.readFileSync("/proc/version", "utf8") : "")) return run("cmd.exe", ["/c", "start", "", url]);
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return run("xdg-open", [url]);
}

function webRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.join(here, "web"), path.join(here, "..", "ui", "web"), path.join(here, "ui", "web")]) if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  throw new Error("the web interface files are missing from this installation");
}

export async function startUi(opts: { port?: number; page?: string } = {}): Promise<UiServer> {
  const token = randomBytes(24).toString("hex");
  const root = webRoot();
  const jobs = new Map<string, Job>();
  let storeCache: { cluster: Cluster; urls: string; store: Promise<ChainStore> } | null = null;
  let loginDone: () => void = () => {};
  const onLogin = new Promise<void>((r) => { loginDone = r; });

  const store = (): Promise<ChainStore> => {
    const c = loadConfig(), urls = rpcUrls(c).join(" ");
    if (!storeCache || storeCache.cluster !== c.cluster || storeCache.urls !== urls) storeCache = { cluster: c.cluster, urls, store: openStore(c) };
    storeCache.store.catch(() => { storeCache = null; });
    return storeCache.store;
  };

  /** Runs a chainboot command in the background and keeps its output for the page. */
  const startJob = (title: string, args: string[], needsRoot = false): Job => {
    const id = randomBytes(6).toString("hex");
    const job: Job = { id, title, command: args, lines: [], status: "running", code: null, started: Date.now() };
    jobs.set(id, job);
    let cmd = [...self(), ...args];
    if (needsRoot && process.getuid?.() !== 0 && engineMode(homeDir()) === "root") {
      // without a terminal sudo cannot ask for a password: use it only when it does not need one
      if (spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0) cmd = [...self(), ...args];
      else {
        job.needsTerminal = true;
        const opened = openTerminal(args);
        job.lines.push(opened ? "This step needs your administrator password. A terminal window was opened for it." : `This step needs your administrator password. Run it in a terminal:\n  ${printable(args)}`);
        job.status = opened ? "done" : "failed"; job.code = opened ? 0 : 1;
        return job;
      }
    }
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    const take = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n|\r/)) { if (line.trim()) job.lines.push(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")); }
      if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400);
    };
    child.stdout.on("data", take); child.stderr.on("data", take);
    child.on("error", (e) => { job.lines.push(e.message); job.status = "failed"; job.code = 1; });
    child.on("close", (code) => { job.code = code; job.status = code === 0 ? "done" : "failed"; });
    return job;
  };

  const state = async () => {
    const c = loadConfig();
    const vault = loadVault(paths.vault(), c.cluster);
    const home = engineHome();
    let images: { digest: string; name: string; version: string; arch: string; size: number }[] = [];
    try {
      images = fs.readdirSync(home.images).flatMap((digest) => {
        try { const m = parseManifest(fs.readFileSync(path.join(home.images, digest, "manifest.json"))); return [{ digest, name: m.name, version: m.version, arch: m.arch, size: m.rawSize }]; } catch { return []; }
      });
    } catch { /* none yet */ }
    return {
      ui: UI_VERSION, platform: process.platform, arch: hostArch(), canRun: process.platform === "linux",
      cluster: c.cluster, clusters: Object.keys(GENESIS), officialPublisher: OFFICIAL_PUBLISHER[c.cluster],
      endpoints: rpcUrls(c).map((u, i) => ({ index: i, label: maskRpcUrl(u) })), endpointsFromEnv: !!process.env.CHAINBOOT_RPC,
      login: vault ? { wallet: vault.wallet, vault: vault.signer.address } : null,
      machines: listMachines(home).map((m) => ({ ...m, save: readSaveStatus(machineDir(home, m.name)), autosave: !fs.existsSync(path.join(machineDir(home, m.name), "autosave-off")) })),
      images,
      jobs: [...jobs.values()].slice(-12).map((j) => ({ id: j.id, title: j.title, status: j.status, last: j.lines.at(-1) ?? "" })),
    };
  };

  const api: Record<string, (body: any) => Promise<unknown> | unknown> = {
    "GET /api/state": () => state(),
    "GET /api/balance": async () => {
      const c = loadConfig(), v = loadVault(paths.vault(), c.cluster);
      if (!v) return { vault: null, wallet: null };
      const pool = (await store()).pool;
      const get = async (a: string) => (await pool.call<{ value: number }>("getBalance", [a, { commitment: "confirmed" }])).value;
      const [vault, wallet] = await Promise.all([get(v.signer.address), get(v.wallet)]);
      return { vault, wallet };
    },
    "POST /api/network": (b) => {
      if (!(b.cluster in GENESIS)) throw new Error("unknown network");
      const c = loadConfig(); c.cluster = b.cluster; saveConfig(c); return state();
    },
    "POST /api/rpc/add": async (b) => {
      const url = String(b.url ?? "").trim();
      const c = loadConfig();
      const report = await new RpcPool([url]).probe().catch((e: Error) => { throw new Error(e.message.split("\n").slice(1).join(" ").trim() || e.message); });
      if (report[0]!.detail !== c.cluster) throw new Error(`that endpoint serves ${report[0]!.detail}, but the current network is ${c.cluster}`);
      const list = c.rpcs[c.cluster] ?? [];
      if (!list.includes(url)) { c.rpcs[c.cluster] = [...list, url]; saveConfig(c); }
      return state();
    },
    "POST /api/rpc/remove": (b) => {
      const c = loadConfig(), list = c.rpcs[c.cluster] ?? [];
      if (!Number.isInteger(b.index) || b.index < 0 || b.index >= list.length) throw new Error("no such endpoint");
      list.splice(b.index, 1); c.rpcs[c.cluster] = list; saveConfig(c); return state();
    },
    "POST /api/rpc/test": async () => {
      const c = loadConfig(), urls = rpcUrls(c);
      if (!urls.length) return [];
      return await new RpcPool(urls).probe().then((r) => r.map((x) => ({ ...x, ok: x.ok && x.detail === c.cluster }))).catch(() => urls.map((u) => ({ label: maskRpcUrl(u), ok: false, detail: "no answer" })));
    },
    "POST /api/catalog": async (b) => {
      const c = loadConfig();
      const mine = b.publisher === "me";
      const vault = mine ? loadVault(paths.vault(), c.cluster) : null;
      if (mine && !vault) throw new Error("sign in to see your private images");
      const publisher = mine ? "me" : resolvePublisher(c, b.publisher || undefined);
      const cat = vault ? await readPrivateCatalog(await store(), vault) : await readCatalog(await store(), publisher, path.join(paths.cache(), "objects"));
      const arch = hostArch();
      return {
        publisher, arch, private: mine,
        images: Object.entries(cat.images).map(([name, img]) => ({
          name, description: img.description ?? "",
          tags: Object.entries(img.tags).map(([tag, arches]) => ({ tag, arches: Object.keys(arches), size: arches[arch]?.downloadSize ?? null, unpacked: arches[arch]?.unpackedSize ?? null, version: arches[arch]?.version ?? Object.values(arches)[0]?.version })),
        })),
      };
    },
    "POST /api/job": (b) => {
      const allowed: Record<string, { root: boolean; title: string }> = {
        pull: { root: false, title: "Download" }, save: { root: true, title: "Save" }, restore: { root: true, title: "Restore" }, start: { root: true, title: "Start" },
        stop: { root: true, title: "Stop" }, rm: { root: true, title: "Delete" }, autosave: { root: true, title: "Autosave" }, rmi: { root: true, title: "Delete image" },
      };
      const args = Array.isArray(b.args) ? b.args.map(String) : [];
      const spec = allowed[args[0] ?? ""];
      if (!spec || args.some((a: string) => a.length > 300)) throw new Error("that action is not available from the interface");
      const j = startJob(`${spec.title} ${args.slice(1).filter((a: string) => !a.startsWith("--")).join(" ")}`.trim(), args, spec.root);
      return { id: j.id };
    },
    "POST /api/job/get": (b) => {
      const j = jobs.get(String(b.id));
      if (!j) throw new Error("no such job");
      return { id: j.id, title: j.title, status: j.status, code: j.code, lines: j.lines.slice(-60), command: printable(j.command), needsTerminal: !!j.needsTerminal };
    },
    "POST /api/terminal": (b) => {
      const args = Array.isArray(b.args) ? b.args.map(String) : [];
      if (!["run", "save", "restore", "login", "status"].includes(args[0] ?? "")) throw new Error("that action is not available from the interface");
      return { opened: openTerminal(args), command: printable(args) };
    },
    // ---- wallet
    "GET /api/login/message": () => ({ message: LOGIN_MESSAGE, cluster: loadConfig().cluster }),
    "POST /api/login": (b) => {
      const c = loadConfig();
      const v = deriveVault(String(b.wallet), Buffer.from(String(b.signature), "base64"), c.cluster);
      saveVault(paths.vault(), v);
      loginDone();
      return { wallet: v.wallet, vault: v.signer.address };
    },
    "POST /api/logout": () => { forgetVault(paths.vault(), loadConfig().cluster); return state(); },
    "POST /api/fund/prepare": async (b) => {
      const c = loadConfig(), v = loadVault(paths.vault(), c.cluster);
      if (!v) throw new Error("sign in first");
      const lamports = Math.round(Number(b.sol) * 1e9);
      if (!Number.isFinite(lamports) || lamports <= 0 || lamports > 100e9) throw new Error("enter an amount between 0 and 100 SOL");
      const wallet = addressToBytes(v.wallet);
      const bh = await (await store()).pool.call<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const message = compileMessage(wallet, [transferInstruction(wallet, v.signer.publicKey, lamports)], b58decodeFixed(bh.value.blockhash, 32, "blockhash"));
      // an unsigned transaction: one empty signature slot followed by the message
      return { transaction: Buffer.concat([Uint8Array.of(1), Buffer.alloc(64), message]).toString("base64"), lamports, from: v.wallet, to: v.signer.address, chain: `solana:${c.cluster === "mainnet-beta" ? "mainnet" : c.cluster}` };
    },
    "POST /api/fund/submit": async (b) => {
      const c = loadConfig(), v = loadVault(paths.vault(), c.cluster);
      if (!v) throw new Error("sign in first");
      const raw = Buffer.from(String(b.transaction), "base64");
      const tx = parseTransaction(raw);
      // only the transfer this page prepared may pass: wallet -> vault, nothing else
      const ix = tx.instructions;
      const transfers = ix.filter((i) => i.programId.equals(Buffer.alloc(32)) && i.data.length === 12 && i.data.readUInt32LE(0) === 2);
      const others = ix.filter((i) => !transfers.includes(i) && b58encode(i.programId) !== "ComputeBudget111111111111111111111111111111");
      if (transfers.length !== 1 || others.length || b58encode(tx.accountKeys[0]!) !== v.wallet || !transfers[0]!.accounts[1]!.equals(v.signer.publicKey) || !verifyPayerSignature(tx)) {
        throw new Error("the wallet returned a different transaction than the one that was prepared");
      }
      const pool = (await store()).pool;
      const sig = b58encode(tx.signatures[0]!);
      await pool.call("sendTransaction", [raw.toString("base64"), { encoding: "base64", skipPreflight: false, maxRetries: 5 }], { attempts: 4 });
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const st = (await pool.call<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig]]).catch(() => ({ value: [null] }))).value[0];
        if (st?.err) throw new Error(`the transfer failed on chain: ${JSON.stringify(st.err)}`);
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return { signature: sig };
      }
      throw new Error("the network did not confirm the transfer in time; check your wallet before trying again");
    },
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      res.end(data);
    };
    try {
      const host = String(req.headers.host ?? "");
      if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return send(403, { error: "forbidden host" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const file = url.pathname === "/" || url.pathname === "/login" ? "index.html" : url.pathname.slice(1);
        if (!/^[a-z0-9.-]+$/i.test(file) || file.includes("..")) return send(404, "not found", "text/plain");
        const full = path.join(root, file);
        if (!fs.existsSync(full)) return send(404, "not found", "text/plain");
        const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
        return send(200, fs.readFileSync(full), types[path.extname(full)] ?? "application/octet-stream");
      }
      if (req.headers["x-chainboot-token"] !== token) return send(401, { error: "This page is not connected to chainboot any more. Run \"chainboot ui\" again and use the new link." });
      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) return send(404, { error: "unknown request" });
      let body: unknown = {};
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) { size += (c as Buffer).length; if (size > 1 << 20) return send(413, { error: "request too large" }); chunks.push(c as Buffer); }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { return send(400, { error: "malformed request" }); }
        if (!body || typeof body !== "object") return send(400, { error: "malformed request" });
      }
      send(200, (await handler(body)) ?? {});
    } catch (e) {
      send(400, { error: (e as Error).message });
    }
  });

  // Inside the engine container (macOS) only one port is published to the computer, so the
  // interface must use exactly that port. An interface left over from an earlier run is stopped first.
  const fixedPort = process.env.CHAINBOOT_UI_BIND === "0.0.0.0";
  const pidFile = path.join(homeDir(), "ui.pid");
  const wanted = opts.port ?? 7717;
  if (fixedPort) {
    try {
      const old = Number(fs.readFileSync(pidFile, "utf8"));
      if (old > 1 && old !== process.pid && fs.readFileSync(`/proc/${old}/cmdline`, "utf8").includes("chainboot")) {
        process.kill(old, "SIGTERM");
        for (let i = 0; i < 40 && fs.existsSync(`/proc/${old}`); i++) await new Promise((r) => setTimeout(r, 50));
        if (fs.existsSync(`/proc/${old}`)) process.kill(old, "SIGKILL");
      }
    } catch { /* nothing to take over */ }
  }
  const port = await new Promise<number>((resolve, reject) => {
    let tries = 0;
    const tryListen = (p: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code !== "EADDRINUSE") return reject(e);
        if (!fixedPort) return p !== 0 ? tryListen(0) : reject(e);
        if (++tries < 20) return void setTimeout(() => tryListen(p), 150); // the old interface is still letting go of the port
        reject(new Error(`port ${p} inside the chainboot engine is used by another program. Restart the engine (for Docker: docker restart chainboot) and try again.`));
      });
      server.listen(p, fixedPort ? "0.0.0.0" : "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    };
    tryListen(wanted);
  });
  const close = () => { server.close(); server.closeAllConnections(); if (fixedPort) { try { if (Number(fs.readFileSync(pidFile, "utf8")) === process.pid) fs.rmSync(pidFile); } catch { /* already gone */ } } };
  if (fixedPort) {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));
    // the command on the computer ended (window closed, Ctrl+C): stop serving instead of lingering in the engine.
    // Only when it was started from a terminal; without one, the input is closed from the start.
    if (process.env.CHAINBOOT_UI_TERMINAL === "1") {
      process.stdin.on("end", () => { close(); process.exit(0); });
      process.stdin.on("close", () => { close(); process.exit(0); });
      process.stdin.resume();
    }
    process.on("SIGTERM", () => { close(); process.exit(0); });
  }
  return { url: `http://127.0.0.1:${port}/${opts.page ?? ""}#token=${token}`, port, token, close, onLogin };
}
