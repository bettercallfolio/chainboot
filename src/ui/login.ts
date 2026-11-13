// Browser wallet sign-in (filled in with the local web interface).
import type { Config } from "../local/home.ts";
import type { Vault } from "../state/vault.ts";

export async function loginWithBrowser(_c: Config): Promise<void> {
  throw new Error("browser wallet sign-in is not available in this build yet. Use: chainboot login --keypair <file>");
}

export async function fundWithBrowser(_c: Config, _v: Vault, _amount: number): Promise<void> {
  throw new Error("funding from a browser wallet is not available in this build yet. Use: chainboot fund <SOL> --keypair <file>");
}
