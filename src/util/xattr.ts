// Extended attributes (file capabilities, ACLs, user.* notes) through the system's own tools.
//
// Node has no API for extended attributes. chainboot uses `getfattr`/`setfattr` (package "attr")
// when they are installed and Python 3 otherwise. With neither, extended attributes are left
// out; everything else works the same.
import { spawnSync } from "node:child_process";
import path from "node:path";

// What is worth carrying: capabilities, POSIX ACLs and user attributes. Never overlayfs's own bookkeeping.
const WANTED = /^(security\.capability|system\.posix_acl_(access|default)|user\.(?!overlay\.).+)$/;

const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
let tools: { getfattr: boolean; setfattr: boolean; python: boolean } | null = null;
function available(): { getfattr: boolean; setfattr: boolean; python: boolean } {
  tools ??= { getfattr: has("getfattr"), setfattr: has("setfattr"), python: has("python3") };
  return tools;
}

/** True when extended attributes can be read on this computer. */
export function canReadXattrs(): boolean { const t = available(); return t.getfattr || t.python; }

const PY_READ = `
import os, sys, json
root = sys.argv[1]
def emit(p):
    try: names = os.listxattr(p, follow_symlinks=False)
    except OSError: return
    out = {}
    for n in names:
        try: out[n] = os.getxattr(p, n, follow_symlinks=False).hex()
        except OSError: pass
    if out: sys.stdout.write(json.dumps({"p": os.path.relpath(p, root), "x": out}) + "\\n")
for d, dirs, files in os.walk(root):
    for n in dirs + files: emit(os.path.join(d, n))
`;

/**
 * Extended attributes of everything below `root`: relative path -> { name: base64 value }.
 * Returns null when no tool is available. Only entries that have wanted attributes are listed.
 */
export function readXattrs(root: string): Map<string, Record<string, string>> | null {
  const t = available();
  const found = new Map<string, Record<string, string>>();
  const put = (rel: string, name: string, hex: string) => {
    if (!WANTED.test(name) || rel === "." || rel.startsWith("..")) return;
    (found.get(rel) ?? found.set(rel, {}).get(rel)!)[name] = Buffer.from(hex, "hex").toString("base64");
  };
  if (t.getfattr) {
    const r = spawnSync("getfattr", ["-R", "-h", "-d", "-e", "hex", "--absolute-names", "-m", "-", root], { maxBuffer: 256 << 20 });
    if (r.error || !r.stdout) return found;
    let rel = "";
    for (const line of r.stdout.toString("latin1").split("\n")) {
      if (line.startsWith("# file: ")) {
        // getfattr writes unusual bytes as \ooo
        const raw = Buffer.from(line.slice(8).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))), "latin1").toString("utf8");
        rel = path.relative(root, raw).split(path.sep).join("/");
      } else {
        const eq = line.indexOf("=0x");
        if (eq > 0) put(rel, line.slice(0, eq), line.slice(eq + 3));
      }
    }
    return found;
  }
  if (t.python) {
    const r = spawnSync("python3", ["-c", PY_READ, root], { maxBuffer: 256 << 20 });
    if (r.error || !r.stdout) return found;
    for (const line of r.stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      try { const j = JSON.parse(line) as { p: string; x: Record<string, string> }; for (const [n, v] of Object.entries(j.x)) put(j.p, n, v); } catch { /* skip a damaged line */ }
    }
    return found;
  }
  return null;
}

/** Sets extended attributes on one file (not following a symlink). Returns the names that could not be set. */
export function writeXattrs(file: string, attrs: Record<string, string>): string[] {
  const t = available();
  const failed: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    const hex = Buffer.from(value, "base64").toString("hex");
    let ok = false;
    if (t.setfattr) ok = spawnSync("setfattr", ["-h", "-n", name, "-v", `0x${hex}`, file], { stdio: "ignore" }).status === 0;
    else if (t.python) ok = spawnSync("python3", ["-c", "import os,sys; os.setxattr(sys.argv[1], sys.argv[2], bytes.fromhex(sys.argv[3]), follow_symlinks=False)", file, name, hex], { stdio: "ignore" }).status === 0;
    if (!ok) failed.push(name);
  }
  return failed;
}
