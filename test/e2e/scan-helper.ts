// Runs inside a machine's mount namespace (via nsenter) and prints the scan result as JSON.
import fs from "node:fs";
import { parseManifest } from "../../src/image/manifest.ts";
import { scanMachine } from "../../src/state/scan.ts";
const [dir, manifest] = process.argv.slice(2);
const r = scanMachine({ upper: `${dir}/upper`, merged: `${dir}/merged`, base: parseManifest(fs.readFileSync(manifest!)) });
process.stdout.write(JSON.stringify({ changes: r.changes.map((c) => [c.path, c.type]), deleted: r.deleted }));
