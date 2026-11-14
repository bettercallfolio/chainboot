// Writing an image to disk as a real directory tree (needs root to set owners and devices).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeXattrs } from "../util/xattr.ts";
import type { ImageManifest, TreeNode } from "./manifest.ts";

export interface ExtractResult { files: number; skipped: string[] }

/**
 * Unpacks `manifest` into the empty directory `dest`.
 * The manifest must have passed validateManifest(): every parent is a directory of the image,
 * so no entry can escape `dest` through "..", absolute paths or symlinks.
 */
export function extractImage(manifest: ImageManifest, rawPack: (index: number) => Buffer, dest: string, onProgress?: (done: number, total: number) => void): ExtractResult {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} is not empty`);
  fs.mkdirSync(dest, { recursive: true });
  const at = (p: string) => path.join(dest, p);
  const skipped: string[] = [];
  const isRoot = process.getuid?.() === 0;
  const own = (p: string, uid: number, gid: number) => { if (isRoot) fs.lchownSync(p, uid, gid); };
  const dirs: TreeNode[] = [], links: TreeNode[] = [];
  let done = 0;
  const total = manifest.tree.length;

  for (const n of manifest.tree) {
    const p = at(n[0]);
    switch (n[1]) {
      case "d":
        fs.mkdirSync(p);
        dirs.push(n);
        break;
      case "f": {
        const data = n[6] === 0 ? Buffer.alloc(0) : rawPack(n[8]).subarray(n[9], n[9] + n[6]);
        fs.writeFileSync(p, data, { mode: 0o600, flag: "wx" });
        own(p, n[3], n[4]);
        fs.chmodSync(p, n[2]); // after chown, which clears set-uid bits
        fs.utimesSync(p, n[5], n[5]);
        if (n[10]) applyXattrs(p, n[10], skipped);
        break;
      }
      case "l":
        fs.symlinkSync(n[6], p);
        own(p, n[3], n[4]);
        fs.lutimesSync(p, n[5], n[5]);
        break;
      case "h":
        links.push(n);
        break;
      case "c": case "b": case "p": {
        // device nodes and fifos are rare in images (systems create /dev at boot); they need root
        const args = n[1] === "p" ? [p, "p"] : [p, n[1], String(n[6]), String(n[7])];
        const r = isRoot ? spawnSync("mknod", ["-m", (n[2] & 0o7777).toString(8), ...args]) : null;
        if (!r || r.status !== 0) { skipped.push(n[0]); break; }
        own(p, n[3], n[4]);
        fs.utimesSync(p, n[5], n[5]);
        break;
      }
    }
    if (++done % 500 === 0) onProgress?.(done, total);
  }
  for (const n of links) { if (n[1] === "h") fs.linkSync(at(n[2]), at(n[0])); }
  // directories last, deepest first: creating children changed their modification times
  for (let i = dirs.length - 1; i >= 0; i--) {
    const n = dirs[i]!;
    if (n[1] !== "d") continue;
    const p = at(n[0]);
    own(p, n[3], n[4]);
    fs.chmodSync(p, n[2]);
    if (n[6]) applyXattrs(p, n[6], skipped);
    fs.utimesSync(p, n[5], n[5]);
  }
  onProgress?.(total, total);
  return { files: total, skipped };
}

function applyXattrs(p: string, xattrs: Record<string, string>, skipped: string[]): void {
  for (const name of writeXattrs(p, xattrs)) skipped.push(`${p} (attribute ${name})`);
}
