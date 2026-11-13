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
const fmtSol = (lamports) => (lamports / 1e9).toFixed(lamports > 0 && lamports < 1e6 ? 6 : 4) + " SOL";
const when = (t) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const short = (a) => (a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : a);
/** Accepts "0.05" and "0,05" (decimal comma), returns NaN for anything that is not a plain number. */
const parseAmount = (text) => { const t = String(text).trim().replace(",", "."); return /^\d*\.?\d+$/.test(t) ? Number(t) : NaN; };

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

// ---------------------------------------------------------------- state

let state = null, catalog = null, catalogPublisher = "", balances = null, activeJob = null;
const wallets = [];
const tests = new Map();          // endpoint label+index -> { ok, detail } from "Test all"
const form = { amount: "0.05", wallet: "" };   // what the user typed; survives every redraw
let endpointsOpen = null;         // null: decide automatically

// A part of the page is rebuilt only when the data it shows has changed, so nothing the user
// is typing or hovering is ever replaced under their hands.
const drawn = {};
function draw(key, data, fn) {
  const sig = JSON.stringify(data);
  if (drawn[key] === sig) return;
  drawn[key] = sig;
  fn();
}
const toggle = (button, body, open) => { body.classList.toggle("hidden", !open); button.setAttribute("aria-expanded", String(open)); };

// ---------------------------------------------------------------- rendering

function render() {
  if (!state) return;
  draw("frame", [state.ui, state.platform, state.arch, state.clusters, state.cluster, state.login, state.canRun], () => {
    $("version").textContent = "interface v" + state.ui + " · " + state.platform + " " + state.arch;
    const net = $("network");
    if (!net.options.length) for (const c of state.clusters) net.append(el("option", { value: c, text: c }));
    net.value = state.cluster;
    const chip = $("wallet-chip");
    chip.textContent = state.login ? "wallet " + short(state.login.wallet) : "not signed in";
    chip.className = "btn" + (state.login ? " on" : "");
    $("signout").classList.toggle("hidden", !state.login);
    $("private-show").classList.toggle("hidden", !state.login);
    const notes = [];
    if (state.cluster !== "mainnet-beta") notes.push(state.cluster + " is a test network: its SOL has no value and its data can be reset.");
    if (!state.canRun) notes.push("Open machines from a terminal on this system: chainboot run <system>.");
    $("banner").textContent = notes.join(" ");
    $("banner").classList.toggle("hidden", !notes.length);
  });
  renderEndpoints();
  renderCatalog();
  renderMachines();
  renderWallet();
}

function renderEndpoints() {
  const eps = state.endpoints.map((e) => ({ ...e, ...(tests.get(e.index + e.label) || {}) }));
  draw("endpoints", [eps, state.endpointsFromEnv, endpointsOpen], () => {
    const bad = eps.filter((e) => e.ok === false).length, tested = eps.some((e) => e.ok !== undefined);
    $("endpoints-summary").textContent = !eps.length ? "none yet: add one to begin"
      : eps.length + (eps.length === 1 ? " endpoint" : " endpoints") + (tested ? (bad ? " · " + bad + " not working" : " · all working") : "") + (state.endpointsFromEnv ? " · from CHAINBOOT_RPC" : "");
    $("endpoints-summary").className = "sub" + (bad ? " warn" : "");
    toggle($("endpoints-toggle"), $("endpoints-body"), endpointsOpen === null ? eps.length === 0 : endpointsOpen);
    $("endpoints").replaceChildren(...(eps.length ? eps.map((e) => el("div", { class: "ep", title: e.detail || "" },
      el("span", { class: "dot " + (e.ok === undefined ? "" : e.ok ? "ok" : "bad") }),
      el("span", { class: "n", text: String(e.index + 1) }),
      el("span", { class: "label", text: e.label }),
      state.endpointsFromEnv ? el("span") : el("button", { class: "btn x", title: "Remove this endpoint", "aria-label": "Remove " + e.label, text: "×", onclick: guard(async () => { tests.clear(); applyState(await api("POST", "/api/rpc/remove", { index: e.index })); await loadCatalog(); }) }),
    )) : [el("div", { class: "empty", text: "No endpoint yet." })]));
  });
}

function renderCatalog() {
  draw("catalog", [catalog, state.endpoints.length, state.machines.map((m) => m.name), state.cluster, state.officialPublisher], () => {
    const box = $("catalog");
    const say = (text, cls = "") => box.replaceChildren(el("div", { class: "empty " + cls, text }));
    if (!state.endpoints.length) return say("Add an endpoint to see what is available.");
    if (!catalog) return say("Reading the catalog from the chain…");
    if (catalog.error) return say(catalog.error, "bad");
    if (!catalog.images.length) return say(catalog.private ? "You have no private systems yet. Publish one with: chainboot publish <archive> --private --name <name> --version <version>" : "This publisher has no systems on " + state.cluster + ".");
    $("catalog-summary").textContent = catalog.private ? "your private systems: encrypted, readable by your wallet only" : "stored on Solana, verified on download";
    const prefix = catalog.publisher === state.officialPublisher ? "" : catalog.publisher + "/";
    // the full system first, then the rest by size
    const order = (a, b) => Number(/-minimal$/.test(a.name)) - Number(/-minimal$/.test(b.name)) || (b.tags[0]?.unpacked || 0) - (a.tags[0]?.unpacked || 0) || a.name.localeCompare(b.name);
    box.replaceChildren(...[...catalog.images].sort(order).map((img) => {
      const tag = img.tags.find((t) => t.tag === "latest") || img.tags[0];
      const here = tag.arches.includes(catalog.arch);
      const have = state.machines.some((m) => m.name === img.name);
      return el("div", { class: "card" },
        el("div", { class: "title" }, el("span", { class: "name", text: img.name }), el("span", { class: "ver", text: tag.version || tag.tag })),
        el("div", { class: "desc", text: img.description || "No description." }),
        el("div", { class: "meta", text: here ? fmtBytes(tag.size) + " download · " + fmtBytes(tag.unpacked) + " disk" : "not published for " + catalog.arch + " (" + tag.arches.join(", ") + ")" }),
        here && el("div", { class: "actions" + (have ? " one" : "") },
          el("button", { class: "btn primary", text: have ? "Open" : "Get and open", onclick: guard(() => openMachine(prefix + img.name, img.name)) }),
          !have && el("button", { class: "btn", text: "Download", onclick: guard(() => runJob(["pull", prefix + img.name])) })),
      );
    }));
  });
}

function saveCell(m) {
  const s = m.save;
  if (!state.login) return ["dim", "not saved to chain"];
  if (!s) return ["dim", "not saved yet"];
  const map = { saved: ["ok", "saved #" + s.seq + (s.time ? " · " + when(s.time) : "")], "nothing-to-save": ["ok", "saved"], saving: ["warn", "saving…"], conflict: ["bad", "conflict with another computer"], "no-funds": ["bad", "vault needs SOL"], "needs-confirmation": ["warn", "waiting for you to confirm"], error: ["bad", "save failed"] };
  return map[s.state] || ["dim", s.state];
}

function renderMachines() {
  draw("machines", [state.machines, !!state.login], () => {
    const box = $("machines");
    if (!state.machines.length) { box.replaceChildren(el("div", { class: "empty", text: "No machines yet. Get a system above." })); return; }
    box.replaceChildren(...state.machines.map((m) => {
      const [cls, text] = saveCell(m);
      return el("div", { class: "machine" },
        el("span", { class: "dot " + (m.running ? "ok" : ""), title: m.running ? "running" : "stopped" }),
        el("div", { class: "info" },
          el("div", { class: "name" }, m.name, el("span", { class: "from", text: m.image.name + ":" + m.image.tag + " · " + m.image.arch })),
          el("div", { class: "cell", title: (m.save && m.save.message) || "" }, (m.running ? "running" : "stopped") + " · ", el("span", { class: cls, text }))),
        el("div", { class: "actions" },
          el("button", { class: "btn primary w-s", text: "Open", onclick: guard(() => openMachine(m.name, m.name)) }),
          m.running ? el("button", { class: "btn w-run", text: "Stop", onclick: guard(() => runJob(["stop", m.name])) })
            : el("button", { class: "btn w-run", text: "Keep running", title: "Start the machine and keep it up without a terminal", onclick: guard(() => runJob(["start", m.name])) }),
          state.login && el("button", { class: "btn w-s", text: "Save", onclick: guard(() => runJob(["save", m.name, "--yes"])) }),
          state.login && el("button", { class: "btn w-auto" + (m.autosave ? " on" : ""), title: "Save automatically after each session", text: "Autosave " + (m.autosave ? "on" : "off"), onclick: guard(() => runJob(["autosave", m.name, m.autosave ? "off" : "on"])) }),
          el("button", { class: "btn danger w-s", text: "Delete", onclick: guard(async () => { if (confirm('Delete machine "' + m.name + '" and everything changed inside it on this computer?')) await runJob(["rm", m.name, "--yes"]); }) }),
        ));
    }));
  });
}

function renderWallet() {
  const names = wallets.map((w) => [w.name, !!w.features["solana:signMessage"], !!w.features["solana:signTransaction"]]);
  draw("wallet", [state.login, balances, names], () => {
    const box = $("wallet-panel");
    if (!state.login) {
      const usable = wallets.filter((w) => w.features["standard:connect"] && w.features["solana:signMessage"]);
      box.replaceChildren(
        el("p", { class: "hint", text: "Sign in and your machines are saved to Solana after every session. Your wallet signs one message (not a transaction, no cost). A small helper account, the vault, then pays the fees of your saves, so you are not asked again. On another computer, sign in and continue where you stopped." }),
        usable.length
          ? el("div", { class: "wallets" }, ...usable.map((w) => el("button", { class: "btn", onclick: guard(() => login(w)) }, w.icon && /^data:image\//.test(w.icon) ? el("img", { src: w.icon, alt: "" }) : null, "Sign in with " + w.name)))
          : el("div", { class: "empty" }, "No wallet was found in this browser. Install Phantom, Solflare or Backpack and reload, or sign in from a terminal: ", el("code", { text: "chainboot login --keypair <file>" })));
      return;
    }
    const low = balances && balances.vault < 5e6;
    const usable = wallets.filter((w) => w.features["standard:connect"] && w.features["solana:signTransaction"]);
    if (!usable.some((w) => w.name === form.wallet)) form.wallet = usable[0] ? usable[0].name : "";
    const amount = el("input", { type: "text", inputmode: "decimal", autocomplete: "off", "aria-label": "Amount in SOL", value: form.amount, oninput: (e) => { form.amount = e.target.value; } });
    const pick = el("select", { "aria-label": "Wallet to pay from", onchange: (e) => { form.wallet = e.target.value; } }, ...usable.map((w) => el("option", { value: w.name, text: "from " + w.name, selected: w.name === form.wallet })));
    box.replaceChildren(
      el("dl", { class: "kv" },
        el("dt", { text: "wallet" }), el("dd", { text: state.login.wallet + (balances ? " · " + fmtSol(balances.wallet) : "") }),
        el("dt", { text: "vault" }), el("dd", { text: state.login.vault }),
        el("dt", { text: "vault balance" }), el("dd", { class: low ? "warn" : "", text: balances ? fmtSol(balances.vault) + (low ? " · add a little SOL so saves can be paid" : "") : "…" })),
      usable.length
        ? el("div", { class: "fund" }, amount, el("span", { class: "unit", text: "SOL" }), pick,
            el("button", { class: "btn primary", text: "Add to vault", onclick: guard(() => fund(usable.find((w) => w.name === form.wallet), parseAmount(form.amount))) }),
            el("button", { class: "btn", text: "Saved machines", onclick: guard(() => runJob(["restore"])) }))
        : el("div", { class: "row" }, el("span", { class: "dim", text: "To add SOL, open this page in the browser that has your wallet, or run: chainboot fund 0.05 --keypair <file>" }),
            el("button", { class: "btn", text: "Saved machines", onclick: guard(() => runJob(["restore"])) })),
      el("p", { class: "hint", style: "margin:12px 0 0", text: "Machines are saved automatically after each session. A save that would cost more than 0.05 SOL waits for you. Bring a saved machine to this computer with: chainboot restore <machine>" }));
  });
}

// ---------------------------------------------------------------- actions

function applyState(s) { state = s; render(); }

async function refresh() {
  applyState(await api("GET", "/api/state"));
  if (state.login && !balances) api("GET", "/api/balance").then((b) => { balances = b; renderWallet(); }).catch(() => {});
}

async function loadCatalog(publisher = catalogPublisher) {
  catalogPublisher = publisher; catalog = null; renderCatalog();
  const mine = publisher === "me";
  $("private-show").textContent = mine ? "Public systems" : "My private systems";
  $("private-show").classList.toggle("on", mine);
  $("catalog-summary").textContent = mine ? "your private systems: encrypted, readable by your wallet only" : "stored on Solana, verified on download";
  if (!state.endpoints.length) return;
  try { catalog = await api("POST", "/api/catalog", { publisher }); } catch (e) { catalog = { error: e.message }; }
  renderCatalog();
}

async function runJob(args) {
  const { id } = await api("POST", "/api/job", { args });
  activeJob = id;
  $("sec-activity").classList.remove("hidden");
  $("sec-activity").scrollIntoView({ behavior: "smooth", block: "nearest" });
  return await followJob(id);
}

async function followJob(id) {
  for (;;) {
    const j = await api("POST", "/api/job/get", { id });
    if (activeJob === id) {
      $("job-title").textContent = j.title + (j.status === "running" ? " …" : j.status === "done" ? "  ✓" : "  ✕");
      $("job-title").className = j.status === "failed" ? "bad" : j.status === "done" ? "ok" : "";
      $("job-log").textContent = j.lines.join("\n"); $("job-log").scrollTop = 1e9;
      const pct = [...j.lines].reverse().map((l) => /(\d{1,3})%/.exec(l)).find(Boolean);
      $("job-bar").style.width = (j.status === "done" ? 100 : pct ? Math.min(100, Number(pct[1])) : 4) + "%";
      $("job-command").textContent = "In a terminal: " + j.command;
    }
    if (j.status !== "running") { balances = null; await refresh(); return j; }
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
    $("job-title").textContent = "Open " + name; $("job-title").className = "";
    $("job-log").textContent = "Open a terminal and type:\n\n  " + r.command;
    $("job-command").textContent = ""; $("job-bar").style.width = "100%";
    $("sec-activity").scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  form.wallet = w.name;
  balances = null;
  await refresh();
  toast("Signed in. Your machines are now saved to chain after each session.");
}

async function fund(w, sol) {
  if (!w) throw new Error("choose a wallet to pay from");
  if (!(sol > 0)) throw new Error("enter an amount in SOL, for example 0.05");
  const account = await connect(w);
  if (account.address !== state.login.wallet) throw new Error(w.name + " is on a different account than the one you signed in with (" + short(state.login.wallet) + ")");
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
$("endpoint-test").addEventListener("click", guard(async (e) => {
  e.target.disabled = true;
  try {
    const report = await api("POST", "/api/rpc/test");
    tests.clear();
    report.forEach((r, i) => { const ep = state.endpoints[i]; if (ep) tests.set(ep.index + ep.label, { ok: r.ok, detail: r.ok ? "working" : r.detail }); });
    renderEndpoints();
  } finally { e.target.disabled = false; }
}));
$("endpoints-toggle").addEventListener("click", () => { endpointsOpen = $("endpoints-body").classList.contains("hidden"); renderEndpoints(); });
$("publisher-toggle").addEventListener("click", () => { const f = $("publisher-form"); toggle($("publisher-toggle"), f, f.classList.contains("hidden")); if (!f.classList.contains("hidden")) $("publisher").focus(); });
$("publish-toggle").addEventListener("click", () => { const b = $("publish-body"); toggle($("publish-toggle"), b, b.classList.contains("hidden")); });
$("network").addEventListener("change", guard(async (e) => { tests.clear(); balances = null; applyState(await api("POST", "/api/network", { cluster: e.target.value })); await loadCatalog(""); }));
$("publisher-form").addEventListener("submit", guard(async (e) => { e.preventDefault(); await loadCatalog($("publisher").value.trim()); }));
// one button switches between the public catalog and the signed-in wallet's private systems
$("private-show").addEventListener("click", guard(() => loadCatalog(catalogPublisher === "me" ? "" : "me")));
$("wallet-chip").addEventListener("click", () => $("sec-wallet").scrollIntoView({ behavior: "smooth" }));
$("signout").addEventListener("click", guard(async () => { balances = null; applyState(await api("POST", "/api/logout")); if (catalogPublisher === "me") await loadCatalog(""); }));
$("activity-close").addEventListener("click", () => $("sec-activity").classList.add("hidden"));

(async () => {
  try {
    await refresh();
    await loadCatalog();
    if (location.pathname === "/login") $("sec-wallet").scrollIntoView();
    setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 4000);
  } catch (e) {
    $("banner").textContent = e.message; $("banner").classList.remove("hidden");
  }
})();
