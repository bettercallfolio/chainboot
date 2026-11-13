// Signing in and adding funds with a browser wallet, started from the command line.
import { loadVault, type Vault } from "../state/vault.ts";
import { paths, type Config } from "../local/home.ts";
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

export async function fundWithBrowser(_c: Config, v: Vault, amount: number): Promise<void> {
  const ui = await page(`Add ${amount} SOL to your vault ${v.signer.address} with the "Add to vault" button on this page:`);
  try {
    await timeout(10 * 60_000);
  } finally { ui.close(); }
}
