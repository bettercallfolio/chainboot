// A lock between processes on this computer, for work that reads something, changes it and
// writes it back: a list on chain that two saves or two publishes update at the same time
// would otherwise lose the entry of one of them.
//
// The lock is a directory (making one either succeeds or fails, on every system). It names
// its owner, so a lock left behind by a process that is gone does not hold anybody up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STALE_MS = 15 * 60_000;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Runs `work` while holding the lock `name`. Waits for another holder; a holder that is gone, or older than 15 minutes, is passed over. */
export async function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const dir = path.join(os.tmpdir(), `chainboot-lock-${name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120)}`);
  const owner = path.join(dir, "owner");
  for (let waited = 0; ; waited += 100) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(owner, String(process.pid));
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // where no lock can be made at all (a read-only temporary directory) the work goes ahead without one
      if (code !== "EEXIST") return work();
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(owner, "utf8"));
        stale = !(pid > 0 && alive(pid)) || Date.now() - fs.statSync(dir).mtimeMs > STALE_MS;
      } catch {
        // made a moment ago and not signed yet, or half removed: stale only when it stays like that
        try { stale = Date.now() - fs.statSync(dir).mtimeMs > 5000; } catch { stale = false; }
      }
      if (stale) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* somebody else did */ } continue; }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await work(); } finally {
    try { if (Number(fs.readFileSync(owner, "utf8")) === process.pid) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}
