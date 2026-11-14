// The reader page: a small front for chainboot-reader.js. Everything a publisher wrote (names,
// descriptions, file names, file contents) is untrusted text and is only ever put into the page
// as text, never as markup.
import { Reader, entries, fileContent, canVerify, b58decode } from "./chainboot-reader.js";

const DEFAULT_ENDPOINT = "https://api.devnet.solana.com";
const DEFAULT_PUBLISHER = "HM4msDau4mPX9P2qinBPTGKiU1TZW5e86jTukeufr5uu";
const SHOWN = 400, TEXT_LIMIT = 256 * 1024;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};
const size = (n) => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 2 : 1)} kB` : n < 1e9 ? `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)} MB` : `${(n / 1e9).toFixed(2)} GB`);

let reader = null, stopper = null, started = 0;
let image = null; // { publisher, manifest, list, byPath, packs: Map }
let saveUrl = null;

function log(line, kind = "") {
  const box = $("log");
  if (box.dataset.empty !== "no") { box.textContent = ""; box.dataset.empty = "no"; }
  const stamp = started ? `[${((performance.now() - started) / 1000).toFixed(1).padStart(5)}s] ` : "";
  box.append(el("span", { className: kind, textContent: `${stamp}${line}\n` }));
  box.scrollTop = box.scrollHeight;
}

function busy(on, text = "") {
  $("read").disabled = on;
  $("stop").hidden = !on;
  $("status").textContent = text;
  for (const b of document.querySelectorAll("#catalog button")) b.disabled = on;
}

function fail(e) {
  const message = e && e.message ? e.message : String(e);
  if (message !== "stopped") log(`error: ${message}`, "bad");
  busy(false, message === "stopped" ? "stopped" : "that did not work; see below");
}

function settings() {
  const endpoints = $("endpoints").value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (!endpoints.length) throw new Error("name at least one RPC endpoint");
  for (const url of endpoints) {
    let u;
    try { u = new URL(url); } catch { throw new Error(`"${url}" is not a web address`); }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error(`${u.host}: an endpoint must use https`);
  }
  const publisher = $("publisher").value.trim();
  try { b58decode(publisher, 32); } catch { throw new Error("the publisher must be a Solana address (32 bytes in base58)"); }
  return { endpoints, publisher };
}

async function readCatalog() {
  let s;
  try { s = settings(); } catch (e) { $("status").textContent = e.message; return; }
  stopper = new AbortController();
  started = performance.now();
  $("log").textContent = ""; $("log").dataset.empty = "";
  $("catalog-panel").hidden = true; $("image-panel").hidden = true;
  reader = new Reader({ endpoints: s.endpoints, onStep: (line) => log(line, "ok") });
  busy(true, "reading the catalog…");
  log(`asking ${s.endpoints.length} endpoint(s) for the catalog of ${s.publisher}`);
  try {
    const cat = await reader.catalog(s.publisher, stopper.signal);
    history.replaceState(null, "", `#publisher=${encodeURIComponent(s.publisher)}`);
    showCatalog(s.publisher, cat);
    busy(false, `${Object.keys(cat.images).length} image(s), ${reader.requests} requests so far`);
  } catch (e) { fail(e); }
}

function showCatalog(publisher, cat) {
  const table = $("catalog");
  table.textContent = "";
  const names = Object.keys(cat.images).sort();
  if (!names.length) {
    table.append(el("div", { className: "tr", textContent: "This address has no public images on this network." }));
  } else {
    table.append(el("div", { className: "tr head", role: "row" }, ...["image", "what it is", "version", "download", ""].map((t) => el("span", { textContent: t, role: "columnheader" }))));
    for (const name of names) {
      const img = cat.images[name];
      const tag = img.tags.latest ?? Object.values(img.tags)[0];
      if (!tag) continue;
      const first = Object.values(tag)[0];
      const buttons = el("span", { role: "cell" });
      for (const [arch, ref] of Object.entries(tag)) {
        const b = el("button", { className: "btn small", type: "button", textContent: arch, title: `Download and verify ${name} for ${arch}` });
        b.setAttribute("aria-label", `Open ${name} for ${arch}`);
        b.addEventListener("click", () => openImage(publisher, name, arch, ref));
        buttons.append(b, " ");
      }
      table.append(el("div", { className: "tr", role: "row" },
        el("span", { role: "cell" }, el("b", { textContent: name })),
        el("span", { role: "cell", textContent: img.description ?? "" }),
        el("span", { role: "cell", textContent: first.version }),
        el("span", { role: "cell", textContent: size(first.downloadSize) }),
        buttons));
    }
  }
  $("catalog-panel").hidden = false;
}

async function openImage(publisher, name, arch, ref) {
  stopper = new AbortController();
  $("image-panel").hidden = false;
  $("browser").hidden = true; $("viewer").hidden = true;
  $("image-title").textContent = `${name} ${ref.version} (${arch})`;
  $("bar").style.width = "0";
  busy(true, `downloading ${name}…`);
  $("image-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  log(`downloading ${name} ${ref.version} for ${arch}: ${size(ref.downloadSize)} on chain, ${size(ref.unpackedSize)} unpacked`);
  try {
    const manifest = await reader.manifest(publisher, ref, { signal: stopper.signal });
    const total = manifest.packs.reduce((n, p) => n + p.size, 0);
    const got = new Array(manifest.packs.length).fill(0);
    const packs = new Map();
    for (let i = 0; i < manifest.packs.length; i++) {
      packs.set(i, await reader.pack(manifest, i, {
        signal: stopper.signal,
        onProgress: (p) => {
          got[i] = p.bytes;
          const done = got.reduce((a, b) => a + b, 0);
          $("bar").style.width = `${Math.min(100, (done / Math.max(1, total)) * 100).toFixed(1)}%`;
          $("progress-text").textContent = `pack ${i + 1} of ${manifest.packs.length}: ${size(done)} of ${size(total)}, ${reader.requests} requests`;
        },
      }));
    }
    $("bar").style.width = "100%";
    const list = entries(manifest);
    image = { publisher, manifest, list, byPath: new Map(list.map((e) => [e.path, e])), packs };
    const files = list.filter((e) => e.type === "f").length;
    $("progress-text").textContent = `verified: ${list.length} entries, ${files} files, ${size(manifest.rawSize)} unpacked. ${reader.requests} requests in ${((performance.now() - started) / 1000).toFixed(0)} s.`;
    log(`${name} is complete and matches what ${publisher.slice(0, 8)}… published`, "ok");
    $("filter").value = "";
    showFiles();
    $("browser").hidden = false;
    busy(false, "done");
    const start = image.byPath.get("etc/os-release");
    if (start) openEntry(start);
  } catch (e) { fail(e); }
}

function showFiles() {
  const box = $("files");
  const q = $("filter").value.trim().toLowerCase();
  const matches = q ? image.list.filter((e) => e.path.toLowerCase().includes(q)) : image.list;
  box.textContent = "";
  for (const e of matches.slice(0, SHOWN)) {
    const meta = e.type === "f" ? size(e.size) : e.type === "d" ? "directory" : e.type === "l" ? `-> ${e.target}` : e.type === "h" ? `= ${e.target}` : "special";
    const row = el("button", { type: "button", className: `file${e.type === "d" ? " dir" : ""}` },
      el("span", { className: "name", textContent: `/${e.path}${e.type === "d" ? "/" : ""}` }), el("span", { className: "meta", textContent: meta }));
    row.setAttribute("role", "listitem");
    if (e.type === "d") row.disabled = true; else row.addEventListener("click", () => openEntry(e, row));
    box.append(row);
  }
  $("count").textContent = matches.length > SHOWN ? `${matches.length} entries, the first ${SHOWN} shown` : `${matches.length} entries`;
}

/** Follows symbolic and hard links to the file they name, inside the image. */
function resolve(e, depth = 0) {
  if (!e || depth > 16) return null;
  if (e.type === "f") return e;
  if (e.type === "h") return resolve(image.byPath.get(e.target), depth + 1);
  if (e.type !== "l") return null;
  const parts = e.target.startsWith("/") ? [] : e.path.split("/").slice(0, -1);
  for (const p of e.target.split("/")) { if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(p); }
  return resolve(image.byPath.get(parts.join("/")), depth + 1);
}

async function openEntry(e, row) {
  for (const r of document.querySelectorAll('.file[aria-current="true"]')) r.removeAttribute("aria-current");
  row?.setAttribute("aria-current", "true");
  const file = resolve(e);
  $("viewer").hidden = false;
  $("viewer-name").textContent = `/${e.path}${file && file !== e ? `  ->  /${file.path}` : ""}`;
  const out = $("viewer-text");
  if (!file) { $("viewer-info").textContent = ""; $("viewer-save").hidden = true; out.textContent = e.type === "l" ? `A link to ${e.target}, which is not a file in this image.` : "Not a regular file."; return; }
  try {
    const data = await fileContent(file, file.size ? image.packs.get(file.pack) : new Uint8Array(0));
    if (saveUrl) URL.revokeObjectURL(saveUrl);
    saveUrl = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    const save = $("viewer-save");
    save.hidden = false; save.href = saveUrl; save.download = file.path.split("/").pop() || "file";
    $("viewer-info").textContent = `${size(data.length)}, SHA-256 ${file.sha256.slice(0, 16)}… verified`;
    const head = data.subarray(0, 4096);
    const binary = head.includes(0) || data.length > TEXT_LIMIT;
    if (!data.length) out.textContent = "(an empty file)";
    else if (binary) out.textContent = data.length > TEXT_LIMIT && !head.includes(0) ? `A text file of ${size(data.length)}: too long to show here. Save it to read it.` : `A binary file of ${size(data.length)}. Save it to look inside.`;
    else out.textContent = new TextDecoder("utf-8", { fatal: false }).decode(data);
    out.scrollTop = 0;
  } catch (err) { $("viewer-info").textContent = ""; $("viewer-save").hidden = true; out.textContent = `This file could not be shown: ${err.message}`; }
}

async function start() {
  const hash = new URLSearchParams(location.hash.slice(1));
  $("endpoints").value = DEFAULT_ENDPOINT;
  $("publisher").value = hash.get("publisher") || DEFAULT_PUBLISHER;
  $("read").addEventListener("click", readCatalog);
  $("stop").addEventListener("click", () => stopper?.abort());
  $("filter").addEventListener("input", () => { if (image) showFiles(); });
  // (Enter does what the button does, and like the button, nothing while something is being read)
  $("publisher").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("read").disabled) readCatalog(); });
  if (!(await canVerify())) {
    $("read").disabled = true;
    $("status").textContent = "This browser cannot check Ed25519 signatures, so the reader will not run here. Current versions of Chrome, Edge, Firefox and Safari can.";
  }
}
start();
