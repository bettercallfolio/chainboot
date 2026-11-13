// Signing in and adding funds with a browser wallet, started from the command line.
import { loadVault, type Vault } from "../state/vault.ts";
import { openStore, paths, type Config } from "../local/home.ts";
import { openBrowser, startUi, type UiServer } from "./server.ts";

const say = (t: string) => process.stderr.write(t + "\n");

async function page(intro: string): Promise<UiServer> {
  const ui = await startUi({ page: "login" });
  say(intro);
  say("");
  say(`  ${ui.url}`);
  say("");
  if (openBrowser(ui.url)) say("Your browser should open by itself. If it does not, open the link above on this computer.");
  else say("Open the link above in a browser on this computer (the one where your wallet is installed).");
  say("Waiting… (press Ctrl+C to cancel)");
  return ui;
}

const timeout = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms).unref());

export async function loginWithBrowser(c: Config): Promise<void> {
  const ui = await page("Sign in with your wallet in the browser:");
  try {
    if ((await Promise.race([ui.onLogin, timeout(10 * 60_000)])) === "timeout") {
      throw new Error("sign-in was not completed. On a computer without a browser use: chainboot login --keypair <file>");
    }
    const v = loadVault(paths.vault(), c.cluster) as Vault;
    say(`Signed in as ${v.wallet} on ${c.cluster}.`);
    say(`Vault (pays for your saves): ${v.signer.address}`);
    await new Promise((r) => setTimeout(r, 800)); // let the page show the result
  } finally { ui.close(); }
}

export async function fundWithBrowser(c: Config, v: Vault, amount: number): Promise<void> {
  const pool = (await openStore(c)).pool;
  const balance = async () => (await pool.call<{ value: number }>("getBalance", [v.signer.address, { commitment: "confirmed" }])).value;
  const before = await balance();
  const ui = await page(`Add ${amount} SOL to your vault ${v.signer.address} with the "Add to vault" button on this page:`);
  try {
    for (const started = Date.now(); Date.now() - started < 10 * 60_000;) {
      await new Promise((r) => setTimeout(r, 3000));
      const now = await balance().catch(() => before);
      if (now > before) { say(`The vault received ${((now - before) / 1e9).toFixed(4)} SOL and now holds ${(now / 1e9).toFixed(4)} SOL.`); await new Promise((r) => setTimeout(r, 1500)); return; }
    }
    throw new Error("no transfer arrived in the vault. Nothing was changed.");
  } finally { ui.close(); }
}
