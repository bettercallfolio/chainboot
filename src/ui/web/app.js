// chainboot local interface. Plain JavaScript, no framework, no build step.
// Everything shown here comes from the chainboot program on this computer; text from the chain
// (image names, descriptions) is always inserted as text, never as HTML.
"use strict";

const token = new URLSearchParams(location.hash.slice(1)).get("token") || sessionStorage.getItem("cb-token") || "";
if (token) { try { sessionStorage.setItem("cb-token", token); } catch { /* private mode */ } history.replaceState(null, "", location.pathname); }

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v; else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v); else if (v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
};
const fmtBytes = (n) => { if (n == null) return "?"; if (n < 1000) return n + " B"; const u = ["kB", "MB", "GB"]; let i = -1; do { n /= 1000; i++; } while (n >= 1000 && i < 2); return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + " " + u[i]; };
const fmtSol = (lamports) => (lamports / 1e9).toFixed(lamports < 1e6 ? 6 : 4) + " SOL";
const when = (t) => new Date(t * 1000).toLocaleString();
const short = (a) => (a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : a);

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { "x-chainboot-token": token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* empty answer */ }
  if (!res.ok) throw new Error(data.error || "request failed (" + res.status + ")");
  return data;
}

let toastTimer = 0;
function toast(text, error = false) {
  const t = $("toast");
  t.textContent = text; t.className = "toast" + (error ? " error" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), error ? 9000 : 4000);
}
const guard = (fn) => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message, true); } };

let state = null, catalog = null, catalogPublisher = "", balances = null, activeJob = null, wallets = [];

// ---------------------------------------------------------------- rendering

function render() {
  if (!state) return;
  $("version").textContent = "Interface v" + state.ui + " · " + state.platform + " " + state.arch;
  const net = $("network");
  if (!net.options.length) for (const c of state.clusters) net.append(el("option", { value: c, text: c }));
  net.value = state.cluster;
  const chip = $("wallet-chip");
  chip.textContent = state.login ? "wallet " + short(state.login.wallet) : "not signed in";
  chip.className = "chip" + (state.login ? " on" : "");

  const banner = $("banner");
  const notes = [];
  if (!state.canRun) notes.push("Starting machines from this page works on Linux for now. On this system use the terminal: chainboot run <system>.");
  if (state.cluster !== "mainnet-beta") notes.push("You are on " + state.cluster + ": a test network. Its SOL has no value and its data can be reset.");
  banner.textContent = notes.join("  ");
  banner.classList.toggle("hidden", !notes.length);

  // endpoints
  const eps = $("endpoints");
  eps.replaceChildren(...(state.endpoints.length ? state.endpoints.map((e) => el("div", { class: "item" },
    el("span", { class: "dot " + (e.ok === undefined ? "" : e.ok ? "ok" : "bad") }), el("span", { class: "dim", text: String(e.index + 1) }), el("span", { class: "name", text: e.label }),
    el("span", { class: "meta", text: e.detail || (state.endpointsFromEnv ? "from CHAINBOOT_RPC" : "") }),
    !state.endpointsFromEnv && el("div", { class: "actions" }, el("button", { class: "danger", text: "Remove", onclick: guard(async () => { applyState(await api("POST", "/api/rpc/remove", { index: e.index })); }) })),
  )) : [el("div", { class: "empty", text: "No endpoint yet. Add one below to begin." })]));

  renderCatalog();
  renderMachines();
  renderWallet();
}

function renderCatalog() {
  const box = $("catalog");
  if (!state.endpoints.length) { box.replaceChildren(el("div", { class: "empty", text: "Add an endpoint to see what is available." })); return; }
  if (!catalog) { box.replaceChildren(el("div", { class: "empty", text: "Reading the catalog from the chain…" })); return; }
  if (catalog.error) { box.replaceChildren(el("div", { class: "empty bad", text: catalog.error })); return; }
  if (!catalog.images.length) { box.replaceChildren(el("div", { class: "empty", text: "This publisher has no systems on " + state.cluster + "." })); return; }
  const prefix = catalog.publisher === state.officialPublisher ? "" : catalog.publisher + "/";
  // the full system first, then the rest by name
  const order = (a, b) => Number(/-minimal$/.test(a.name)) - Number(/-minimal$/.test(b.name)) || (b.tags[0]?.unpacked || 0) - (a.tags[0]?.unpacked || 0) || a.name.localeCompare(b.name);
  box.replaceChildren(...[...catalog.images].sort(order).map((img) => {
    const tag = img.tags.find((t) => t.tag === "latest") || img.tags[0];
    const here = tag.arches.includes(catalog.arch);
    const have = state.machines.find((m) => m.name === img.name);
    return el("div", { class: "card" },
      el("div", { class: "name", text: img.name }),
      el("div", { class: "desc", text: img.description || "No description." }),
      el("div", { class: "meta", text: "version " + (tag.version || tag.tag) + " · " + tag.arches.join(", ") + (here ? " · " + fmtBytes(tag.size) + " download, " + fmtBytes(tag.unpacked) + " on disk" : "") }),
      el("div", { class: "actions" },
        here ? el("button", { text: have ? "Open" : "Get and open", onclick: guard(() => openMachine(prefix + img.name, img.name)) }) : el("span", { class: "warn", text: "not published for " + catalog.arch }),
        here && !have && el("button", { class: "ghost", text: "Download only", onclick: guard(() => runJob(["pull", prefix + img.name])) }),
      ));
  }));
}

function saveLabel(m) {
  const s = m.save;
  if (!state.login) return el("span", { class: "dim", text: "not saved to chain (sign in to enable)" });
  if (!s) return el("span", { class: "dim", text: "not saved yet" });
  const map = { saved: ["ok", "saved, #" + s.seq], "nothing-to-save": ["ok", "saved"], saving: ["warn", "saving…"], conflict: ["bad", "conflict with another computer"], "no-funds": ["bad", "vault needs SOL"], "needs-confirmation": ["warn", "waiting for you to confirm"], error: ["bad", "save failed"] };
  const [cls, text] = map[s.state] || ["dim", s.state];
  return el("span", { class: cls, title: s.message || "", text: text + (s.time && s.state === "saved" ? " · " + when(s.time) : "") });
}

function renderMachines() {
  const box = $("machines");
  if (!state.machines.length) { box.replaceChildren(el("div", { class: "empty", text: "No machines yet. Get a system above." })); return; }
  box.replaceChildren(...state.machines.map((m) => el("div", { class: "item" },
    el("span", { class: "dot " + (m.running ? "ok" : "") }), el("span", { class: "name", text: m.name }),
    el("span", { class: "meta" }, m.image.name + ":" + m.image.tag + " · " + m.image.arch + " · " + (m.running ? "running" : "stopped") + " · ", saveLabel(m)),
    el("div", { class: "actions" },
      el("button", { text: "Open", onclick: guard(() => openMachine(m.name, m.name)) }),
      m.running ? el("button", { class: "ghost", text: "Stop", onclick: guard(() => runJob(["stop", m.name])) }) : el("button", { class: "ghost", text: "Keep running", title: "Start the machine and keep it up without a terminal", onclick: guard(() => runJob(["start", m.name])) }),
      state.login && el("button", { class: "ghost", text: "Save now", onclick: guard(() => runJob(["save", m.name, "--yes"])) }),
      state.login && el("button", { class: "ghost", text: m.autosave ? "Autosave: on" : "Autosave: off", onclick: guard(() => runJob(["autosave", m.name, m.autosave ? "off" : "on"])) }),
      el("button", { class: "danger", text: "Delete", onclick: guard(async () => { if (confirm('Delete machine "' + m.name + '" and everything changed inside it on this computer?')) await runJob(["rm", m.name, "--yes"]); }) }),
    ),
  )));
}

function renderWallet() {
  const box = $("wallet-panel");
  if (state.login) {
    const kv = el("dl", { class: "kv" },
      el("dt", { text: "wallet" }), el("dd", { text: state.login.wallet + (balances ? "  (" + fmtSol(balances.wallet) + ")" : "") }),
      el("dt", { text: "vault" }), el("dd", { text: state.login.vault }),
      el("dt", { text: "vault balance" }), el("dd", { class: balances && balances.vault < 5e6 ? "warn" : "", text: balances ? fmtSol(balances.vault) + (balances.vault < 5e6 ? "  — add a little SOL so saves can be paid" : "") : "…" }));
    const amount = el("input", { type: "number", min: "0.001", step: "0.001", value: "0.05", style: "flex:0 1 130px" });
    const usable = wallets.filter((w) => w.features["solana:signTransaction"]);
    box.replaceChildren(kv,
      el("div", { class: "row" }, amount, el("span", { class: "dim", text: "SOL" }),
        ...(usable.length ? usable.map((w) => el("button", { text: "Add to vault with " + w.name, onclick: guard(() => fund(w, Number(amount.value))) })) : [el("span", { class: "dim", text: "Open this page in a browser with your wallet to add SOL, or use: chainboot fund 0.05 --keypair <file>" })]),
        el("button", { class: "ghost", text: "Saved machines…", onclick: guard(() => runJob(["restore"], true)) }),
        el("button", { class: "danger", text: "Sign out", onclick: guard(async () => { applyState(await api("POST", "/api/logout")); balances = null; render(); }) })),
      el("p", { class: "hint", text: "To continue a saved machine on this computer: chainboot restore <machine>. Machines you open here are saved automatically after each session; saves that would cost more than 0.05 SOL wait for you." }));
    return;
  }
  const usable = wallets.filter((w) => w.features["standard:connect"] && w.features["solana:signMessage"]);
  box.replaceChildren(
    usable.length
      ? el("div", { class: "wallets" }, ...usable.map((w) => el("button", { onclick: guard(() => login(w)) }, w.icon && /^data:image\//.test(w.icon) ? el("img", { src: w.icon, alt: "" }) : null, "Sign in with " + w.name)))
      : el("div", { class: "empty" }, "No wallet was found in this browser. Install Phantom, Solflare or Backpack and reload, or sign in from the terminal with a keypair file: ", el("code", { text: "chainboot login --keypair <file>" })),
    el("p", { class: "hint", text: "The wallet shows the message before you sign. It is not a transaction and costs nothing." }));
}

// ---------------------------------------------------------------- actions

function applyState(s) { const tested = state ? new Map(state.endpoints.map((e) => [e.label, e])) : new Map(); state = s; for (const e of state.endpoints) { const t = tested.get(e.label); if (t && t.ok !== undefined) { e.ok = t.ok; e.detail = t.detail; } } render(); }

async function refresh() {
  applyState(await api("GET", "/api/state"));
  if (state.login && !balances) api("GET", "/api/balance").then((b) => { balances = b; renderWallet(); }).catch(() => {});
}

async function loadCatalog(publisher = catalogPublisher) {
  catalogPublisher = publisher; catalog = null; renderCatalog();
  try { catalog = await api("POST", "/api/catalog", { publisher }); } catch (e) { catalog = { error: e.message }; }
  renderCatalog();
}

async function runJob(args, quietTitle) {
  const { id } = await api("POST", "/api/job", { args });
  activeJob = id;
  $("sec-activity").classList.remove("hidden");
  if (!quietTitle) $("sec-activity").scrollIntoView({ behavior: "smooth", block: "nearest" });
  return await followJob(id);
}

async function followJob(id) {
  for (;;) {
    const j = await api("POST", "/api/job/get", { id });
    if (activeJob === id) {
      $("job-title").textContent = j.title + (j.status === "running" ? " …" : j.status === "done" ? "  ✔" : "  ✖");
      $("job-title").className = "job-title " + (j.status === "failed" ? "bad" : j.status === "done" ? "ok" : "");
      $("job-log").textContent = j.lines.join("\n"); $("job-log").scrollTop = 1e9;
      const pct = [...j.lines].reverse().map((l) => /(\d{1,3})%/.exec(l)).find(Boolean);
      $("job-bar").style.width = (j.status === "done" ? 100 : pct ? Math.min(100, Number(pct[1])) : 4) + "%";
      $("job-command").textContent = "Same thing in a terminal: " + j.command;
    }
    if (j.status !== "running") { await refresh(); balances = null; return j; }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function openMachine(image, name) {
  if (!state.machines.some((m) => m.name === name) && !state.images.some((i) => i.name === name)) {
    const j = await runJob(["pull", image]);
    if (j.status !== "done") return;
  }
  const r = await api("POST", "/api/terminal", { args: ["run", image] });
  if (r.opened) toast("A terminal window was opened for " + name + ".");
  else {
    $("sec-activity").classList.remove("hidden");
    $("job-title").textContent = "Open " + name; $("job-title").className = "job-title";
    $("job-log").textContent = "This computer has no terminal program chainboot can open by itself.\nOpen a terminal and type:\n\n  " + r.command;
    $("job-command").textContent = ""; $("job-bar").style.width = "100%";
    try { await navigator.clipboard.writeText(r.command); toast("The command was copied. Paste it into a terminal."); } catch { toast("Type this in a terminal: " + r.command); }
  }
  setTimeout(() => refresh().catch(() => {}), 2500);
}

// ---------------------------------------------------------------- wallet (Wallet Standard)

function registerWallet(w) { if (w && w.features && !wallets.includes(w)) { wallets.push(w); if (state) renderWallet(); } }
const walletApi = { register: (...ws) => { ws.forEach(registerWallet); return () => {}; } };
window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(walletApi); } catch { /* a broken wallet must not break the page */ } });
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: walletApi }));

const b64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function connect(w) {
  const r = await w.features["standard:connect"].connect();
  const account = (r && r.accounts && r.accounts[0]) || w.accounts[0];
  if (!account) throw new Error("the wallet did not share an account");
  return account;
}

async function login(w) {
  const account = await connect(w);
  const { message } = await api("GET", "/api/login/message");
  const out = await w.features["solana:signMessage"].signMessage({ account, message: new TextEncoder().encode(message) });
  const signature = out && out[0] && out[0].signature;
  if (!signature) throw new Error("the wallet did not return a signature");
  await api("POST", "/api/login", { wallet: account.address, signature: b64(signature) });
  balances = null;
  await refresh();
  toast("Signed in. Your machines are now saved to chain after each session.");
}

async function fund(w, sol) {
  if (!(sol > 0)) throw new Error("enter an amount");
  const account = await connect(w);
  if (account.address !== state.login.wallet) throw new Error("the wallet is on a different account than the one you signed in with (" + short(state.login.wallet) + ")");
  const prep = await api("POST", "/api/fund/prepare", { sol });
  const out = await w.features["solana:signTransaction"].signTransaction({ account, transaction: unb64(prep.transaction), chain: prep.chain });
  const signed = out && out[0] && out[0].signedTransaction;
  if (!signed) throw new Error("the wallet did not sign the transfer");
  toast("Sending " + fmtSol(prep.lamports) + " to your vault…");
  await api("POST", "/api/fund/submit", { transaction: b64(signed) });
  balances = null;
  await refresh();
  toast(fmtSol(prep.lamports) + " added to your vault.");
}

// ---------------------------------------------------------------- wiring

$("endpoint-form").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  const input = $("endpoint-url"), button = e.submitter;
  if (button) button.disabled = true;
  try { applyState(await api("POST", "/api/rpc/add", { url: input.value })); input.value = ""; toast("Endpoint added."); await loadCatalog(); } finally { if (button) button.disabled = false; }
}));
$("endpoint-test").addEventListener("click", guard(async () => {
  const report = await api("POST", "/api/rpc/test");
  report.forEach((r, i) => { if (state.endpoints[i]) { state.endpoints[i].ok = r.ok; state.endpoints[i].detail = r.ok ? "working" : r.detail; } });
  render();
}));
$("network").addEventListener("change", guard(async (e) => { applyState(await api("POST", "/api/network", { cluster: e.target.value })); balances = null; await loadCatalog(""); }));
$("publisher-form").addEventListener("submit", guard(async (e) => { e.preventDefault(); await loadCatalog($("publisher").value.trim()); }));
$("wallet-chip").addEventListener("click", () => $("sec-wallet").scrollIntoView({ behavior: "smooth" }));
$("activity-close").addEventListener("click", () => $("sec-activity").classList.add("hidden"));

(async () => {
  try {
    await refresh();
    if (state.endpoints.length) await loadCatalog();
    if (location.pathname === "/login") $("sec-wallet").scrollIntoView();
    setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 4000);
  } catch (e) {
    $("banner").textContent = e.message; $("banner").classList.remove("hidden");
  }
})();
