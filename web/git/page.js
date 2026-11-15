// The git page: a small front for chainboot-git.js. Everything a repository holds (names,
// messages, file contents, issues, comments) is untrusted text and is only ever put into the
// page as text, never as markup.
import { Reader, parseRepo, readRepo, readObjects, readTalk, connectWallet, postRecord, asText, diffLines, RECORD_LIMIT } from "./chainboot-git.js";

const DEFAULT_ENDPOINT = "https://api.devnet.solana.com";
const TEXT_LIMIT = 512 * 1024, DIFF_FILES = 40;
const IMAGES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon" };

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
const size = (n) => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} kB` : `${(n / 1e6).toFixed(1)} MB`);
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const when = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") : "");
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } } };

let reader = null, repo = null, objects = null, talk = null, wallet = null;
// where the page is: #r=<owner>/<name>&v=files|blob|commits|commit|talk|item&ref=<ref>&p=<path>&id=<commit or number>
const place = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
const link = (changes) => {
  const p = new URLSearchParams({ r: `${repo.owner}/${repo.name}`, ...changes });
  for (const [k, v] of [...p]) if (!v) p.delete(k);
  return `#${p}`;
};
const status = (text, bad = false) => { $("status").textContent = text; $("status").className = bad ? "bad" : "dim"; };

// ---- opening a repository

async function openRepo(text) {
  const { owner, name } = parseRepo(text);
  const endpoints = $("endpoints").value.split(/\s+/).filter(Boolean);
  if (!endpoints.length) throw new Error("name at least one RPC endpoint");
  for (const u of endpoints) if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u)) throw new Error(`${u} is not an https address`);
  store.set("chainboot.git.endpoints", endpoints.join("\n"));
  reader = new Reader({ endpoints });
  status(`looking for ${name} of ${short(owner)}…`);
  const index = await readRepo(reader, owner, name);
  if (!index) throw new Error(`${owner} has no repository named ${name} on this network`);
  status(index.packs.length ? "fetching its packs…" : "");
  const objs = await readObjects(reader, owner, index, (done, total, p) => status(done < total ? `fetching pack ${done + 1} of ${total} (${size(p.size)})…` : ""));
  repo = { owner, name, index }; objects = objs; talk = null;
  $("open-panel").hidden = true; $("repo-view").hidden = false;
  $("repo-name").textContent = name;
  $("repo-description").textContent = index.description ?? "";
  $("clone").textContent = `git clone sol://${owner}/${name}`;
  document.title = `${name} · chainboot git`;
  const refs = Object.keys(index.refs).sort((a, b) => (a === index.head ? -1 : b === index.head ? 1 : a.localeCompare(b)));
  $("ref").replaceChildren(...refs.map((r) => el("option", { value: r, textContent: r.replace(/^refs\/(heads|tags)\//, "") + (r.startsWith("refs/tags/") ? " (tag)" : "") })));
  status("");
  readTalk(reader, owner, name).then((items) => { talk = items; paintTabs(); if (["talk", "item"].includes(place().v)) show(); }).catch(() => { talk = []; });
}

function currentRef() {
  const want = place().ref;
  return want && repo.index.refs[want] ? want : repo.index.refs[repo.index.head] ? repo.index.head : Object.keys(repo.index.refs)[0];
}
const tip = () => { const ref = currentRef(); return ref ? objects.peel(repo.index.refs[ref]) : null; };

function paintTabs() {
  const v = place().v ?? "files", ref = place().ref;
  const tabs = { files: ["tab-files", ["files", "blob"]], commits: ["tab-commits", ["commits", "commit"]], talk: ["tab-talk", ["talk", "item", "new"]] };
  for (const [name, [id, views]] of Object.entries(tabs)) {
    $(id).href = link({ v: name, ref: name === "talk" ? "" : ref });
    if (views.includes(v)) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
  }
  const open = talk ? talk.filter((i) => i.state === "open").length : null;
  $("tab-talk").textContent = `Issues and pull requests${open === null ? "" : ` (${open})`}`;
  if (currentRef()) $("ref").value = currentRef();
}

// ---- views

function crumbs(path, ref) {
  const parts = path.split("/").filter(Boolean);
  const out = [el("a", { href: link({ v: "files", ref }), textContent: repo.name })];
  parts.forEach((p, i) => out.push(" / ", el("a", { href: link({ v: i === parts.length - 1 && place().v === "blob" ? "blob" : "files", ref, p: parts.slice(0, i + 1).join("/") }), textContent: p })));
  return el("span", { className: "crumbs" }, out);
}

function codeBlock(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  return el("div", { className: "code" }, lines.map((l, i) => el("div", {}, el("span", { className: "n", textContent: String(i + 1) }), el("span", { className: "t", textContent: l || " " }))));
}

function viewFiles() {
  const ref = currentRef(), commit = tip(), path = place().p ?? "";
  if (!commit) return el("div", { className: "box" }, el("div", { className: "empty", textContent: "This repository has no branches yet. Push one: git push -u origin main" }));
  const here = objects.at(commit, path);
  if (!here) return el("div", { className: "box" }, el("div", { className: "empty", textContent: `There is no ${path} on this branch.` }));
  if (here.kind !== "tree") return viewBlob(here, path, ref);
  const entries = [...here.entries].sort((a, b) => (a.kind === "tree") === (b.kind === "tree") ? a.name.localeCompare(b.name) : a.kind === "tree" ? -1 : 1);
  const last = objects.commit(commit);
  const box = el("div", { className: "box" },
    el("div", { className: "box-head" }, crumbs(path, ref), el("a", { href: link({ v: "commit", id: commit }), className: "dim", textContent: `${commit.slice(0, 8)} ${last.subject.slice(0, 60)}` })),
    entries.map((e) => {
      const p = path ? `${path}/${e.name}` : e.name;
      const meta = e.kind === "blob" ? size(objects.blob(e.id).length) : e.kind === "link" ? "link" : e.kind === "submodule" ? "submodule" : "";
      const props = { className: `entry${e.kind === "tree" ? " dir" : ""}` };
      if (e.kind !== "submodule") props.href = link({ v: e.kind === "tree" ? "files" : "blob", ref, p });
      return el(e.kind === "submodule" ? "div" : "a", props, el("span", { className: "kind", textContent: e.kind === "tree" ? "▸" : "·" }), el("span", { className: "name", textContent: e.name }), el("span", { className: "meta", textContent: meta }));
    }));
  const readme = here.entries.find((e) => e.kind === "blob" && /^readme(\.md|\.txt)?$/i.test(e.name));
  const out = [box];
  if (readme) {
    const text = asText(objects.blob(readme.id));
    if (text !== null) out.push(el("div", { className: "box" }, el("div", { className: "box-head" }, el("span", { textContent: readme.name })), /\.md$/i.test(readme.name) ? markdown(text) : el("pre", { className: "message", textContent: text })));
  }
  return out;
}

function viewBlob(here, path, ref) {
  const data = objects.blob(here.id), name = path.split("/").pop();
  const save = el("a", { className: "btn small", textContent: "Save file", download: name, href: URL.createObjectURL(new Blob([data])) });
  const head = el("div", { className: "box-head" }, crumbs(path, ref), el("span", {}, el("span", { className: "dim", textContent: `${size(data.length)}  ` }), save));
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  let body;
  if (here.kind === "link") body = el("pre", { className: "message", textContent: `a link to ${asText(data) ?? "…"}` });
  else if (IMAGES[ext]) body = el("img", { className: "picture", alt: name, src: URL.createObjectURL(new Blob([data], { type: IMAGES[ext] })) });
  else {
    const text = data.length <= TEXT_LIMIT ? asText(data) : null;
    body = text === null ? el("div", { className: "empty", textContent: data.length > TEXT_LIMIT ? "This file is too long to show here. Save it to read it." : "This file is not text." })
      : /\.md$/i.test(name) && place().raw !== "1" ? markdown(text) : codeBlock(text);
  }
  return el("div", { className: "box" }, head, body);
}

function viewCommits() {
  const commit = tip();
  if (!commit) return el("div", { className: "box" }, el("div", { className: "empty", textContent: "No commits yet." }));
  const log = objects.log(commit, 300);
  return el("div", { className: "box" }, log.map((c) => el("div", { className: "commit" },
    el("a", { className: "subject", href: link({ v: "commit", id: c.id }), textContent: c.subject || "(no message)" }),
    el("a", { className: "id", href: link({ v: "commit", id: c.id }), textContent: c.id.slice(0, 8) }),
    el("span", { className: "meta", textContent: `${c.author.name}  ${when(c.author.time)}` }))));
}

function viewCommit() {
  const id = place().id;
  if (!id || !objects.has(id)) return el("div", { className: "box" }, el("div", { className: "empty", textContent: "That commit is not in this repository." }));
  const c = objects.commit(id);
  const parent = c.parents[0] && objects.has(c.parents[0]) ? objects.commit(c.parents[0]) : null;
  const changes = objects.changes(parent ? parent.tree : null, c.tree);
  const out = [el("div", { className: "box" },
    el("div", { className: "box-head" }, el("span", { textContent: `commit ${c.id}` }), el("a", { href: link({ v: "files", ref: "", p: "" }), textContent: "files" })),
    el("pre", { className: "message", textContent: c.message.trimEnd() }),
    el("div", { className: "change dim" }, `${c.author.name} <${c.author.email}>  ${when(c.author.time)}`,
      c.parents.map((p, i) => el("span", {}, i ? ", " : "   parent ", objects.has(p) ? el("a", { href: link({ v: "commit", id: p }), textContent: p.slice(0, 8) }) : p.slice(0, 8)))))];
  out.push(el("p", { className: "dim", textContent: `${changes.length} file${changes.length === 1 ? "" : "s"} changed${c.parents.length > 1 ? " (compared with the first parent)" : ""}` }));
  for (const ch of changes.slice(0, DIFF_FILES)) {
    const before = ch.before ? objects.blob(ch.before) : new Uint8Array(0), after = ch.after ? objects.blob(ch.after) : new Uint8Array(0);
    const a = before.length <= TEXT_LIMIT ? asText(before) : null, b = after.length <= TEXT_LIMIT ? asText(after) : null;
    const lines = a !== null && b !== null ? diffLines(a, b) : null;
    let body;
    if (!lines) body = el("div", { className: "empty", textContent: "not shown (not text, or too long)" });
    else {
      const rows = [];
      let prevA = 0, prevB = 0;
      for (const l of lines) {
        if ((l.a ?? prevA + 1) > prevA + 1 && (l.b ?? prevB + 1) > prevB + 1 && rows.length) rows.push(el("div", { className: "gap" }, el("span", { className: "n", textContent: "…" }), el("span", { className: "t", textContent: " " })));
        if (l.a) prevA = l.a; if (l.b) prevB = l.b;
        rows.push(el("div", { className: l.kind === "+" ? "add" : l.kind === "-" ? "del" : "" }, el("span", { className: "n", textContent: String(l.b ?? l.a ?? "") }), el("span", { className: "t", textContent: `${l.kind} ${l.text}` })));
      }
      body = el("div", { className: "code" }, rows);
    }
    out.push(el("div", { className: "box" }, el("div", { className: "box-head" }, el("span", { textContent: ch.path }), el("span", { className: `tag ${ch.kind}`, textContent: ch.kind })), body));
  }
  if (changes.length > DIFF_FILES) out.push(el("p", { className: "dim", textContent: `${changes.length - DIFF_FILES} more files are not shown.` }));
  return out;
}

const who = (address) => `${address}${address === repo.owner ? " (owner)" : ""}`;

function viewTalk() {
  if (!talk) return el("div", { className: "box" }, el("div", { className: "empty", textContent: "Reading issues and pull requests from the chain…" }));
  const all = place().all === "1";
  const shown = [...talk].reverse().filter((i) => all || i.state === "open");
  return [
    el("div", { className: "row", style: "margin:0 0 14px" },
      el("a", { className: "btn small", href: link({ v: "talk", all: all ? "" : "1" }), textContent: all ? "Show open only" : `Show all (${talk.length})` }),
      el("span", { className: "grow" }),
      el("a", { className: "btn small primary", href: link({ v: "new" }), textContent: "New issue" })),
    el("div", { className: "box" }, shown.length ? shown.map((i) => el("a", { className: "item", href: link({ v: "item", id: String(i.number) }) },
      el("span", { className: "num", textContent: `#${i.number}` }), el("span", { textContent: i.title }), el("span", { className: `tag ${i.state}`, textContent: i.state }),
      el("span", { className: "sub", textContent: `${i.kind === "pr" ? "pull request" : "issue"} by ${short(i.author)} · ${when(i.time)} · ${i.comments.length} comment${i.comments.length === 1 ? "" : "s"}` })))
      : el("div", { className: "empty", textContent: talk.length ? "Nothing is open." : "Nobody has opened an issue or a pull request here yet." })),
    el("p", { className: "hint", textContent: "A pull request is opened with chainboot, from the directory that has your commits: chainboot git pr new --title …" }),
  ];
}

function form(title, fields, send) {
  const inputs = fields.map((f) => (f.area ? el("textarea", { placeholder: f.placeholder, maxLength: RECORD_LIMIT }) : el("input", { type: "text", placeholder: f.placeholder, maxLength: 200 })));
  const note = el("span", { className: "dim" });
  const button = el("button", { className: "btn primary", type: "button", textContent: title });
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (!wallet) await connect();
      note.className = "dim"; note.textContent = "waiting for your wallet, then for the network…";
      await send(...inputs.map((i) => i.value));
      note.textContent = "written to the chain";
    } catch (e) { note.className = "bad"; note.textContent = e.message || String(e); }
    button.disabled = false;
  };
  return el("div", { className: "form" }, inputs, el("div", { className: "row", style: "margin:0" }, button, note));
}

async function refreshTalk() {
  talk = await readTalk(reader, repo.owner, repo.name);
  paintTabs();
}

function viewNew() {
  return [el("h2", { textContent: "New issue" }), form("Open the issue", [{ placeholder: "Title" }, { placeholder: "What is it about? (plain text)", area: true }], async (title, body) => {
    await postRecord(reader, wallet, repo.owner, repo.name, { t: "issue", title, body });
    await refreshTalk();
    location.hash = link({ v: "item", id: String(talk.length) });
  }), el("p", { className: "hint", textContent: `It is written with your wallet, as one transaction, and stays on the chain for ever. One transaction holds about ${RECORD_LIMIT} characters; longer texts are written with chainboot itself.` })];
}

function viewItem() {
  if (!talk) return el("div", { className: "box" }, el("div", { className: "empty", textContent: "Reading from the chain…" }));
  const item = talk.find((i) => String(i.number) === place().id);
  if (!item) return el("div", { className: "box" }, el("div", { className: "empty", textContent: "There is no such issue or pull request." }));
  const out = [el("h2", {}, `#${item.number} ${item.title}  `, el("span", { className: `tag ${item.state}`, textContent: item.state }))];
  if (item.pr) out.push(el("p", { className: "dim" }, `wants ${item.pr.from.ref.replace("refs/heads/", "")} of `, el("a", { href: `#r=${item.pr.from.owner}/${item.pr.from.name}`, textContent: `${short(item.pr.from.owner)}/${item.pr.from.name}` }),
    ` (${item.pr.from.id.slice(0, 8)}) in ${item.pr.into.replace("refs/heads/", "")}`, item.pr.merged ? [" · merged as ", objects.has(item.pr.merged) ? el("a", { href: link({ v: "commit", id: item.pr.merged }), textContent: item.pr.merged.slice(0, 8) }) : item.pr.merged.slice(0, 8)] : null));
  const post = (author, time, body) => el("div", { className: "post" }, el("div", { className: "who", textContent: `${who(author)} · ${when(time)}` }), el("div", { className: "body", textContent: body.trim() || "(no text)" }));
  out.push(post(item.author, item.time, item.body));
  const events = [...item.comments.map((c) => ({ ...c, what: "comment" })), ...item.changes.map((s) => ({ ...s, what: "state" }))].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  for (const e of events) out.push(e.what === "comment" ? post(e.author, e.time, e.body) : el("p", { className: "event", textContent: `${who(e.author)} set it to ${e.state} · ${when(e.time)}` }));
  out.push(form("Comment", [{ placeholder: "Write a comment (plain text)", area: true }], async (body) => {
    await postRecord(reader, wallet, repo.owner, repo.name, { t: "comment", on: item.id, body });
    await refreshTalk(); show();
  }));
  if (wallet && (wallet.address === repo.owner || wallet.address === item.author) && item.state !== "merged") {
    const to = item.state === "open" ? "closed" : "open";
    const b = el("button", { className: "btn small", type: "button", textContent: to === "closed" ? "Close it" : "Open it again" });
    b.onclick = async () => { b.disabled = true; try { await postRecord(reader, wallet, repo.owner, repo.name, { t: "state", on: item.id, state: to }); await refreshTalk(); show(); } catch (e) { b.disabled = false; alert(e.message); } };
    out.push(el("div", { className: "row" }, b));
  }
  return out;
}

// ---- Markdown, as far as a README needs it; built as elements, never as markup

function inline(text) {
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|!?\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1] !== undefined) out.push(el("code", { textContent: m[1] }));
    else if (m[2] !== undefined) out.push(el("b", { textContent: m[2] }));
    else if (m[3] !== undefined) out.push(el("i", { textContent: m[3] }));
    else if (/^https?:\/\//i.test(m[5])) out.push(el("a", { href: m[5], textContent: m[4], rel: "noopener noreferrer nofollow", target: "_blank" }));
    else out.push(m[4]);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function markdown(text) {
  const root = el("div", { className: "md" });
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para = [], list = null;
  const flush = () => { if (para.length) { root.append(el("p", {}, inline(para.join(" ")))); para = []; } list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      root.append(el("pre", {}, el("code", { textContent: code.join("\n") })));
      continue;
    }
    if (/^ {4}\S/.test(line) && !para.length && !list) {
      const code = [];
      for (; i < lines.length && (/^ {4}/.test(lines[i]) || lines[i] === ""); i++) code.push(lines[i].slice(4));
      i--;
      root.append(el("pre", {}, el("code", { textContent: code.join("\n").trimEnd() })));
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h) { flush(); root.append(el(`h${Math.min(3, h[1].length)}`, {}, inline(h[2]))); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); root.append(el("hr")); continue; }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      if (para.length) { root.append(el("p", {}, inline(para.join(" ")))); para = []; }
      const kind = item[1] ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== kind) { list = el(kind); root.append(list); }
      list.append(el("li", {}, inline(item[3])));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { flush(); root.append(el("blockquote", {}, inline(quote[1]))); continue; }
    if (line.trim() === "") { flush(); continue; }
    if (/^\|.*\|\s*$/.test(line)) { flush(); root.append(el("pre", {}, el("code", { textContent: line }))); continue; }
    list = null;
    para.push(line.trim());
  }
  flush();
  return root;
}

// ---- the page

function show() {
  if (!repo) return;
  const v = place().v ?? "files";
  let nodes;
  try {
    nodes = v === "commits" ? viewCommits() : v === "commit" ? viewCommit() : v === "talk" ? viewTalk() : v === "item" ? viewItem() : v === "new" ? viewNew() : viewFiles();
  } catch (e) { nodes = el("div", { className: "box" }, el("div", { className: "empty bad", textContent: e.message || String(e) })); }
  $("view").replaceChildren(...[nodes].flat());
  paintTabs();
}

async function route() {
  const want = place().r;
  if (!want) { $("open-panel").hidden = false; $("repo-view").hidden = true; repo = null; return; }
  if (!repo || `${repo.owner}/${repo.name}` !== want) {
    $("open-panel").hidden = false; $("repo-view").hidden = true;
    $("repo").value = want;
    try { await openRepo(want); } catch (e) { status(e.message || String(e), true); return; }
  }
  show();
}

async function connect() {
  wallet = await connectWallet();
  $("wallet").textContent = `${wallet.name}: ${short(wallet.address)}`;
  if (repo) show();
}

$("endpoints").value = store.get("chainboot.git.endpoints") || DEFAULT_ENDPOINT;
$("open").onclick = () => { try { const r = parseRepo($("repo").value); location.hash = `#r=${r.owner}/${r.name}`; } catch (e) { status(e.message, true); } };
$("repo").onkeydown = (e) => { if (e.key === "Enter") $("open").click(); };
$("ref").onchange = () => { const p = place(); location.hash = link({ v: ["commits", "commit"].includes(p.v) ? "commits" : "files", ref: $("ref").value }); };
$("copy").onclick = () => navigator.clipboard?.writeText($("clone").textContent).then(() => { $("copy").textContent = "Copied"; setTimeout(() => { $("copy").textContent = "Copy"; }, 1200); });
$("wallet").onclick = () => connect().catch((e) => alert(e.message || String(e)));
addEventListener("hashchange", route);
route();
