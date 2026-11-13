// Builds dist/: one self-contained program file, the SDK, and the web interface files.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dist = path.join(root, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const common = { bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "none", define: { __CHAINBOOT_VERSION__: JSON.stringify(pkg.version) } };
await build({ ...common, entryPoints: [path.join(root, "src/cli/main.ts")], outfile: path.join(dist, "chainboot.mjs") });
await build({ ...common, entryPoints: [path.join(root, "src/index.ts")], outfile: path.join(dist, "sdk.mjs") });
fs.chmodSync(path.join(dist, "chainboot.mjs"), 0o755);
fs.cpSync(path.join(root, "src/ui/web"), path.join(dist, "web"), { recursive: true });
fs.writeFileSync(path.join(dist, "VERSION"), pkg.version + "\n");

// type declarations for SDK users
execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(root, "tsconfig.build.json")], { stdio: "inherit" });

// declarations must name modules the way consumers resolve them (.js), not the source files (.ts)
const fix = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) fix(p);
    else if (f.name.endsWith(".d.ts")) fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/(from\s+"\.{1,2}\/[^"]+)\.ts"/g, '$1.js"').replace(/(import\("\.{1,2}\/[^"]+)\.ts"\)/g, '$1.js")'));
  }
};
fix(path.join(dist, "types"));

// the release archive the installers download
if (process.argv.includes("--archive")) {
  const name = "chainboot.tar.gz";
  execFileSync("tar", ["-czf", name, "--owner=0", "--group=0", "--mtime=2026-01-01", "chainboot.mjs", "web", "VERSION"], { cwd: dist });
  const hash = execFileSync("sha256sum", [name], { cwd: dist }).toString().split(" ")[0];
  fs.writeFileSync(path.join(dist, `${name}.sha256`), `${hash}  ${name}\n`);
  console.log(`dist/${name} ${hash}`);
}
console.log(`built chainboot ${pkg.version}`);
