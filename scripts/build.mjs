// Builds dist/: one self-contained program file, the SDK, and the web interface files.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { writeTar } from "../src/image/tar.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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

// the reader for browsers: one script without dependencies, and the page that uses it
await build({ bundle: true, platform: "browser", format: "esm", target: "es2022", legalComments: "none", minify: true, entryPoints: [path.join(root, "src/browser/reader.ts")], outfile: path.join(dist, "reader/chainboot-reader.js") });
for (const f of fs.readdirSync(path.join(root, "web/reader"))) fs.copyFileSync(path.join(root, "web/reader", f), path.join(dist, "reader", f));
// the same for git repositories: browse one, read and write its issues
await build({ bundle: true, platform: "browser", format: "esm", target: "es2022", legalComments: "none", minify: true, entryPoints: [path.join(root, "src/browser/git.ts")], outfile: path.join(dist, "git/chainboot-git.js") });
for (const f of fs.readdirSync(path.join(root, "web/git"))) fs.copyFileSync(path.join(root, "web/git", f), path.join(dist, "git", f));

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
  // written with chainboot's own tar writer, so the archive is identical on every platform
  const name = "chainboot.tar.gz";
  const file = (rel, mode) => ({ path: rel, type: "f", mode, uid: 0, gid: 0, mtime: 1767225600, data: fs.readFileSync(path.join(dist, rel)) });
  const entries = [file("chainboot.mjs", 0o755), { path: "web", type: "d", mode: 0o755, uid: 0, gid: 0, mtime: 1767225600 },
    ...fs.readdirSync(path.join(dist, "web")).sort().map((f) => file(`web/${f}`, 0o644)), file("VERSION", 0o644),
    { ...file("VERSION", 0o644), path: "LICENSE", data: fs.readFileSync(path.join(root, "LICENSE")) }];
  const archive = zlib.gzipSync(Buffer.concat(writeTar(entries)), { level: 9 });
  archive[9] = 3; // the header names the system that made the file: always the same one, so that the archive is the same wherever it is built
  fs.writeFileSync(path.join(dist, name), archive);
  const hash = createHash("sha256").update(archive).digest("hex");
  fs.writeFileSync(path.join(dist, `${name}.sha256`), `${hash}  ${name}\n`);
  console.log(`dist/${name} ${hash}`);
}
console.log(`built chainboot ${pkg.version}`);
