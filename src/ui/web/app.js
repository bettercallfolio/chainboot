// chainboot local interface. Plain JavaScript, no framework, no build step.
// Everything shown here comes from the chainboot program on this computer; text from the chain
// (image names, descriptions, notes of shares) is always inserted as text, never as HTML.
"use strict";

const token = new URLSearchParams(location.hash.slice(1)).get("token") || sessionStorage.getItem("cb-token") || "";
if (token) { try { sessionStorage.setItem("cb-token", token); } catch { /* private mode */ } history.replaceState(null, "", location.pathname); }

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v; else if (k === "text") node.textContent = v;
    else if (k === "value") node.value = v; else if (k === "checked") node.checked = !!v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v); else if (v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
};
const fmtBytes = (n) => { if (n == null) return "?"; if (n < 1000) return n + " B"; const u = ["kB", "MB", "GB"]; let i = -1; do { n /= 1000; i++; } while (n >= 1000 && i < 2); return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + " " + u[i]; };
const fmtSol = (lamports) => (lamports / 1e9).toFixed(lamports > 0 && lamports < 1e6 ? 6 : 4) + " SOL";
const when = (t) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const short = (a) => (a.length > 16 ? a.slice(0, a.startsWith("share_") ? 10 : 4) + "…" + a.slice(-4) : a);
/** Accepts "0.05" and "0,05" (decimal comma), returns NaN for anything that is not a plain number. */
const parseAmount = (text) => { const t = String(text).trim().replace(",", "."); return /^\d*\.?\d+$/.test(t) ? Number(t) : NaN; };
const netName = (id) => (state.clusterNames || {})[id] || id;

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
/** For a button: runs the action with the button switched off, so a second click cannot start it twice. */
const once = (fn) => guard(async (e) => {
  const b = e && e.currentTarget && "disabled" in e.currentTarget ? e.currentTarget : null;
  if (b) b.disabled = true;
  try { await fn(e); } finally { if (b) b.disabled = false; }
});
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(what + " copied."); } catch { toast(text); }
}

// ---------------------------------------------------------------- state

let state = null, catalog = null, catalogPublisher = "", balances = null, activeJob = null, shares = null;
const wallets = [];
const tests = new Map();          // endpoint label+index -> { ok, detail } from "Test all"
// what the user typed or opened; survives every redraw
const form = { amount: "0.05", wallet: "", fee: null, netName: "", netUrl: "", pubName: "", pubValue: "" };
const cards = {};                 // catalog card -> { open, tag, name, boot, lazy, shareWith }
const rows = {};                  // machine -> { open, shareWith, note, disk, size, archive }
const keep = {};                  // share id -> name to keep it under
let endpointsOpen = null;         // null: decide automatically
let settingsOpen = false;

// A part of the page is rebuilt only when the data it shows has changed, and never while the
// user is typing in it, so nothing is ever replaced under their hands.
const drawn = {}, forced = new Set();
let pressing = false;             // a mouse button or a finger is down: a click is on its way
function draw(key, data, fn, box) {
  const sig = JSON.stringify(data);
  if (drawn[key] === sig && !forced.has(key)) return;
  if (!forced.has(key) && box) {
    // not while they type in it, and not between the press and the release of a click (the button would be gone)
    const at = document.activeElement;
    if (pressing || (at && box.contains(at) && (at.tagName === "INPUT" || at.tagName === "SELECT"))) return;
  }
  forced.delete(key);
  drawn[key] = sig;
  fn();
}
/** Rebuilds one part now, because the user changed something that it shows. */
const redraw = (key) => { forced.add(key); render(); };
/** Puts children into a box, leaving out what a condition switched off. */
const fill = (box, ...children) => box.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
// what was held back is drawn as soon as the field is left or the click is over
const later = () => setTimeout(() => { if (state) render(); }, 0);
document.addEventListener("pointerdown", () => { pressing = true; }, true);
for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, () => { pressing = false; later(); }, true);
document.addEventListener("focusout", later);
const toggle = (button, body, open) => { body.classList.toggle("hidden", !open); button.setAttribute("aria-expanded", String(open)); };
/** A text field whose content lives in `store[key]`, so that a redraw brings it back. */
const field = (store, key, props, changed) => el("input", { type: "text", autocomplete: "off", spellcheck: "false", ...props, value: store[key] || "", oninput: (e) => { store[key] = e.target.value; if (changed) changed(); } });
const check = (store, key, label, title, changed) => el("label", { class: "check", title },
  el("input", { type: "checkbox", checked: store[key], onchange: (e) => { store[key] = e.target.checked; if (changed) changed(); } }), label);

// ---------------------------------------------------------------- rendering

function render() {
  if (!state) return;
  draw("frame", [state.ui, state.platform, state.arch, state.clusters, state.clusterNames, state.cluster, state.login, state.canRun], () => {
    $("version").textContent = "interface v" + state.ui + " · " + state.platform + " " + state.arch;
    const net = $("network");
    net.replaceChildren(...state.clusters.map((c) => el("option", { value: c, text: netName(c) })));
    net.value = state.cluster;
    const chip = $("wallet-chip");
    chip.textContent = state.login ? "wallet " + short(state.login.wallet) : "not signed in";
    chip.className = "btn" + (state.login ? " on" : "");
    $("signout").classList.toggle("hidden", !state.login);
    $("private-show").classList.toggle("hidden", !state.login);
    const notes = [];
    if (state.cluster === "devnet" || state.cluster === "testnet") notes.push(state.cluster + " is a test network: its SOL has no value and its data can be reset.");
    else if (state.cluster !== "mainnet-beta") notes.push(netName(state.cluster) + " is a chain you added: it has no official catalog, so name a publisher or publish your own.");
    if (!state.canRun) notes.push("Open machines from a terminal on this system: chainboot run <system>.");
    $("banner").textContent = notes.join(" ");
    $("banner").classList.toggle("hidden", !notes.length);
  }, $("network").parentNode);
  renderEndpoints();
  renderCatalog();
  renderMachines();
  renderWallet();
  renderSettings();
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

/** The options of one catalog card: which version, what to call the machine, how it starts. */
function cardOf(img) {
  const key = catalog.publisher + "/" + img.name;
  const c = cards[key] || (cards[key] = { open: false, tag: "", name: "", boot: false, lazy: false, shareWith: "" });
  if (!img.tags.some((t) => t.tag === c.tag)) c.tag = (img.tags.find((t) => t.tag === "latest") || img.tags[0]).tag;
  return c;
}

function renderCatalog() {
  const box = $("catalog");
  draw("catalog", [catalog, state.endpoints.length, state.machines.map((m) => m.name), state.cluster, state.officialPublisher], () => {
    const note = $("catalog-note");
    note.classList.add("hidden");
    const say = (text, cls = "") => box.replaceChildren(el("div", { class: "empty " + cls, text }));
    if (!state.endpoints.length) return say("Add an endpoint to see what is available.");
    if (!catalog) return say("Reading the catalog from the chain…");
    if (catalog.error) return say(catalog.error, "bad");
    if (catalog.list) {
      note.replaceChildren("A list kept by " + catalog.list.members.length + " publishers: a system is shown when " + catalog.list.threshold + " of them have the same one. ",
        ...catalog.list.members.map((m) => el("span", { class: "member " + (m.ok ? "" : "bad"), title: m.address + (m.ok ? "" : ": " + m.error), text: short(m.address) + (m.ok ? " (" + m.images + ")" : " (not readable)") })),
        catalog.list.waiting ? " " + catalog.list.waiting + " more waiting for enough of them to agree." : "");
      note.classList.remove("hidden");
    }
    if (!catalog.images.length) return say(catalog.private ? "You have no private systems yet. Publish one with: chainboot publish <archive> --name <name> --version <version>" : catalog.list ? "Its publishers agree on no system yet." : "This publisher has no systems on " + netName(state.cluster) + ".");
    // the full system first, then the rest by size
    const order = (a, b) => Number(/-minimal$/.test(a.name)) - Number(/-minimal$/.test(b.name)) || (b.tags[0]?.unpacked || 0) - (a.tags[0]?.unpacked || 0) || a.name.localeCompare(b.name);
    box.replaceChildren(...[...catalog.images].sort(order).map((img) => {
      const c = cardOf(img);
      const tag = img.tags.find((t) => t.tag === c.tag);
      const here = tag.arches.includes(catalog.arch);
      const ref = (catalog.prefix || "") + img.name + (tag.tag === "latest" ? "" : ":" + tag.tag);
      const machine = () => c.name.trim() || img.name;
      const primary = el("button", { class: "btn primary", onclick: once(() => openMachine(ref, machine(), { named: machine() !== img.name, boot: c.boot, lazy: c.lazy, image: img.name, version: tag.version })) });
      const download = el("button", { class: "btn", text: "Download", onclick: once(() => runJob(["pull", ref])) });
      const actions = el("div", { class: "actions" }, primary, download);
      // the buttons follow the machine name as it is typed, without the card being rebuilt
      const sync = () => { const have = state.machines.some((m) => m.name === machine()); primary.textContent = have ? "Open" : "Get and open"; download.classList.toggle("hidden", have); actions.classList.toggle("one", have); };
      sync();
      return el("div", { class: "card" },
        el("div", { class: "title" }, el("span", { class: "name", text: img.name }), el("span", { class: "ver", text: tag.version || tag.tag })),
        el("div", { class: "desc", text: img.description || "No description." }),
        el("div", { class: "meta", text: (here ? fmtBytes(tag.size) + " download · " + fmtBytes(tag.unpacked) + " disk" : "not published for " + catalog.arch + " (" + tag.arches.join(", ") + ")") + (tag.agreed ? " · " + tag.agreed + " of " + catalog.list.members.length + " agree" : "") }),
        c.open && el("div", { class: "opts" },
          img.tags.length > 1 && el("label", { class: "opt" }, "version", el("select", { onchange: (e) => { c.tag = e.target.value; c.lazy = c.tag === "lazy"; redraw("catalog"); } },
            ...img.tags.map((t) => el("option", { value: t.tag, text: t.tag + (t.version && t.version !== t.tag ? " (" + t.version + ")" : ""), selected: t.tag === c.tag })))),
          el("label", { class: "opt" }, "machine name", field(c, "name", { placeholder: img.name, "aria-label": "Machine name" }, sync)),
          check(c, "boot", "Boot like a server", "The system's own init (systemd) starts its services, and the machine stays up until you stop it. For systems that have one, such as solinux."),
          check(c, "lazy", "Start at once (lazy)", "Nothing is downloaded first: each file is fetched from the chain when it is first read. Best with a version published for it (often the tag \"lazy\")."),
          catalog.private && el("div", { class: "opt" }, "share with", el("div", { class: "pair" },
            field(c, "shareWith", { placeholder: "share_… address of the receiver", "aria-label": "Share address of the receiver" }),
            el("button", { class: "btn", text: "Share", onclick: once(() => shareThing("me/" + img.name + (tag.tag === "latest" ? "" : ":" + tag.tag), "your private system " + img.name, c.shareWith, "")) }))),
          catalog.private && el("button", { class: "btn danger", text: "Remove from my catalog", title: "The system disappears from your private catalog. What is on the ledger cannot be erased.",
            onclick: once(async () => { if (confirm('Remove "' + img.name + (tag.tag === "latest" ? "" : ":" + tag.tag) + '" from your private catalog?')) { await runJob(["unlist", "me/" + img.name + ":" + tag.tag, "--yes"]); await loadCatalog(); } }) })),
        catalog.prefix === null
          ? el("div", { class: "meta", text: "To run a system of this list, save the list under a name first: Settings, Publisher names." })
          : here && actions,
        el("button", { class: "btn quiet more", "aria-expanded": String(c.open), text: c.open ? "Fewer options" : "Options", onclick: () => { c.open = !c.open; redraw("catalog"); } }),
      );
    }));
  }, box);
}

function saveCell(m) {
  const s = m.save;
  if (!state.login) return ["dim", "not saved to chain"];
  if (!s) return ["dim", "not saved yet"];
  const map = { saved: ["ok", "saved #" + s.seq + (s.time ? " · " + when(s.time) : "")], "nothing-to-save": ["ok", "saved"], saving: ["warn", "saving…"], conflict: ["bad", "conflict with another computer"], "no-funds": ["bad", "vault needs SOL"], "needs-confirmation": ["warn", "waiting for you to confirm"], error: ["bad", "save failed"] };
  return map[s.state] || ["dim", s.state];
}

/** A line of a machine's "More" panel: a name, what it is, and what can be done. */
const line = (name, ...content) => el("div", { class: "line" }, el("span", { class: "k", text: name }), ...content);
/** Where the interface cannot write files or open terminals (Windows and macOS): the command to type. */
const command = (text) => el("div", { class: "pair" }, el("code", { class: "cmd", text }), el("button", { class: "btn", text: "Copy", onclick: () => copy(text, "The command was") }));

function renderMachines() {
  const box = $("machines");
  draw("machines", [state.machines, !!state.login, state.files], () => {
    if (!state.machines.length) { box.replaceChildren(el("div", { class: "empty", text: "No machines yet. Get a system above." })); return; }
    for (const name of Object.keys(rows)) if (!state.machines.some((m) => m.name === name)) delete rows[name];
    box.replaceChildren(...state.machines.map((m) => {
      const [cls, text] = saveCell(m);
      const r = rows[m.name] || (rows[m.name] = { open: false, shareWith: "", note: "", disk: "", size: "", archive: "" });
      return el("div", { class: "machine" },
        el("span", { class: "dot " + (m.running ? "ok" : ""), title: m.running ? "running" : "stopped" }),
        el("div", { class: "info" },
          el("div", { class: "name" }, m.name, m.boot && el("span", { class: "badge", title: "Boots its own system (systemd) and stays up until stopped", text: "boots" }), m.lazy && el("span", { class: "badge", title: "Files are fetched from the chain when they are first read", text: "lazy" }),
            el("span", { class: "from", text: m.image.name + ":" + m.image.tag + " · " + m.image.arch })),
          el("div", { class: "cell", title: (m.save && m.save.message) || "" }, (m.running ? "running" : "stopped") + " · ", el("span", { class: cls, text }))),
        el("div", { class: "actions" },
          el("button", { class: "btn primary w-s", text: "Open", onclick: once(() => openMachine(m.name, m.name)) }),
          m.running ? el("button", { class: "btn w-run", text: "Stop", onclick: once(() => runJob(["stop", m.name])) })
            : el("button", { class: "btn w-run", text: "Keep running", title: "Start the machine and keep it up without a terminal", onclick: once(() => runJob(["start", m.name])) }),
          state.login && el("button", { class: "btn w-s", text: "Save", onclick: once(() => runJob(["save", m.name, "--yes"])) }),
          state.login && el("button", { class: "btn w-auto" + (m.autosave ? " on" : ""), title: "Save automatically after each session", text: "Autosave " + (m.autosave ? "on" : "off"), onclick: once(() => runJob(["autosave", m.name, m.autosave ? "off" : "on"])) }),
          el("button", { class: "btn w-s" + (r.open ? " on" : ""), "aria-expanded": String(r.open), text: "More", onclick: () => { r.open = !r.open; redraw("machines"); } }),
          el("button", { class: "btn danger w-s", text: "Delete", onclick: once(async () => { if (confirm('Delete machine "' + m.name + '" and everything changed inside it on this computer?')) await runJob(["rm", m.name, "--yes"]); }) }),
        ),
        r.open && el("div", { class: "more-panel" },
          line("Boot", el("span", { class: "v", text: m.boot ? "Boots its own system (systemd), like a server, and stays up until stopped." : "Starts with a shell only. A machine that boots runs its system's services." }),
            el("button", { class: "btn", text: m.boot ? "Turn off" : "Turn on", title: "Takes effect at the next start; stop the machine first", onclick: once(() => runJob(["boot", m.name, m.boot ? "off" : "on"])) })),
          state.login && line("History", el("span", { class: "v", text: "The saves of this machine on chain. Go back to one with: chainboot restore " + m.name + " --snapshot <number>" }),
            el("button", { class: "btn", text: "Show", onclick: once(() => runJob(["history", m.name])) })),
          state.login && line("Share", field(r, "shareWith", { placeholder: "share_… address of the receiver", "aria-label": "Share address of the receiver" }),
            field(r, "note", { placeholder: "note (optional)", "aria-label": "Note for the receiver", maxlength: "120" }),
            el("button", { class: "btn", text: "Share", title: "Gives the newest save of this machine to another wallet", onclick: once(() => shareThing(m.name, "the newest save of " + m.name, r.shareWith, r.note)) })),
          state.files
            ? line("Disk", field(r, "disk", { placeholder: "~/" + m.name + ".img", "aria-label": "File to write the disk to" }), field(r, "size", { placeholder: "size, e.g. 8G (optional)", "aria-label": "Size of the disk" }),
                el("button", { class: "btn", text: "Build", title: "Writes the machine out as a bootable disk (UEFI), with its own kernel", onclick: once(() => runJob(["disk", m.name, r.disk.trim() || "~/" + m.name + ".img", ...(r.size.trim() ? ["--size=" + r.size.trim()] : [])])) }))
            : line("Disk", command("chainboot disk " + m.name + " " + m.name + ".img")),
          state.files
            ? line("Archive", field(r, "archive", { placeholder: "~/" + m.name + ".tar", "aria-label": "File to write the archive to" }),
                el("button", { class: "btn", text: "Export", title: "Writes the whole file system as a tar archive, ready for chainboot publish", onclick: once(() => runJob(["export", m.name, r.archive.trim() || "~/" + m.name + ".tar"])) }))
            : line("Archive", command("chainboot export " + m.name + " " + m.name + ".tar")),
        ));
    }));
  }, box);
}

function renderWallet() {
  const box = $("wallet-panel");
  const names = wallets.map((w) => [w.name, !!w.features["solana:signMessage"], !!w.features["solana:signTransaction"]]);
  draw("wallet", [state.login, balances, names, shares], () => {
    if (!state.login) {
      const usable = wallets.filter((w) => w.features["standard:connect"] && w.features["solana:signMessage"]);
      box.replaceChildren(
        el("p", { class: "hint", text: "Sign in and your machines are saved to Solana after every session. Your wallet signs one message (not a transaction, no cost). A small helper account, the vault, then pays the fees of your saves, so you are not asked again. On another computer, sign in and continue where you stopped." }),
        usable.length
          ? el("div", { class: "wallets" }, ...usable.map((w) => el("button", { class: "btn", onclick: once(() => login(w)) }, w.icon && /^data:image\//.test(w.icon) ? el("img", { src: w.icon, alt: "" }) : null, "Sign in with " + w.name)))
          : el("div", { class: "empty" }, "No wallet was found in this browser. Install Phantom, Solflare or Backpack and reload, or sign in from a terminal: ", el("code", { text: "chainboot login --keypair <file>" })));
      return;
    }
    const low = balances && balances.vault < 5e6;
    const usable = wallets.filter((w) => w.features["standard:connect"] && w.features["solana:signTransaction"]);
    if (!usable.some((w) => w.name === form.wallet)) form.wallet = usable[0] ? usable[0].name : "";
    const amount = field(form, "amount", { inputmode: "decimal", "aria-label": "Amount in SOL" });
    const pick = el("select", { "aria-label": "Wallet to pay from", onchange: (e) => { form.wallet = e.target.value; } }, ...usable.map((w) => el("option", { value: w.name, text: "from " + w.name, selected: w.name === form.wallet })));
    fill(box,
      el("dl", { class: "kv" },
        el("dt", { text: "wallet" }), el("dd", { text: state.login.wallet + (balances ? " · " + fmtSol(balances.wallet) : "") }),
        el("dt", { text: "vault" }), el("dd", { text: state.login.vault }),
        el("dt", { text: "vault balance" }), el("dd", { class: low ? "warn" : "", text: balances ? fmtSol(balances.vault) + (low ? " · add a little SOL so saves can be paid" : "") : "…" }),
        el("dt", { text: "share address", title: "Give this to people who want to share a machine or a private system with you" }),
        el("dd", { class: "copyable" }, el("span", { text: state.login.share }), el("button", { class: "btn quiet", text: "Copy", onclick: () => copy(state.login.share, "Your share address was") }))),
      usable.length
        ? el("div", { class: "fund" }, amount, el("span", { class: "unit", text: "SOL" }), pick,
            el("button", { class: "btn primary", text: "Add to vault", onclick: once(() => fund(usable.find((w) => w.name === form.wallet), parseAmount(form.amount))) }))
        : el("p", { class: "hint", text: "To add SOL, open this page in the browser that has your wallet, or run: chainboot fund 0.05 --keypair <file>" }),
      el("div", { class: "row" },
        el("button", { class: "btn", text: "Saved machines", title: "Lists the machines you saved to chain", onclick: once(() => runJob(["restore"])) }),
        el("button", { class: "btn" + (shares ? " on" : ""), text: "Shared with me", title: "Machines and private systems that other wallets shared with you", onclick: once(() => (shares ? (shares = null, renderWallet()) : loadShares())) })),
      shares && el("div", { class: "rows shares" }, ...(shares === "loading" ? [el("div", { class: "empty", text: "Looking for shares on chain…" })]
        : shares.error ? [el("div", { class: "empty bad", text: shares.error })]
        : !shares.length ? [el("div", { class: "empty", text: "Nothing was shared with you yet. Give people your share address, and they can." })]
        : shares.map((s) => el("div", { class: "share" },
            el("div", { class: "info" },
              el("div", { class: "name" }, s.what + " " + s.name, el("span", { class: "from", text: s.detail })),
              el("div", { class: "cell", title: s.from }, "from " + short(s.from) + (s.arrived ? " · " + when(s.arrived) : ""), s.note ? " · " : "", s.note ? el("span", { class: "note", text: s.note }) : null)),
            field(keep, s.id, { placeholder: s.name, "aria-label": "Name to keep it under" }),
            el("button", { class: "btn", text: "Keep", title: "Check the sender's share address with them if you did not expect this", onclick: once(() => keepShare(s)) }))))),
      el("p", { class: "hint", style: "margin:12px 0 0", text: "Machines are saved automatically after each session. A save that would cost more than 0.05 SOL waits for you. Bring a saved machine to this computer with: chainboot restore <machine>" }));
  }, box);
}

/** One group of the settings: a name on the left, the setting on the right. */
const group = (name, ...content) => el("div", { class: "set" }, el("div", { class: "k", text: name }), el("div", { class: "v" }, ...content));

function renderSettings() {
  const box = $("settings-body");
  const s = state.settings, e = state.engine;
  draw("settings", [s, e, !!state.login, settingsOpen, state.cluster], () => {
    const how = !e ? "" : e.where === "here" ? (e.mode === "rootless" ? "machines without administrator rights" : "machines through sudo") : "";
    $("settings-summary").textContent = [how, s.accountsAvailable ? "pointer accounts " + (s.accounts ? "on" : "off") : "", s.priorityFee ? "tip " + s.priorityFee + " lamports" : "no tip"].filter(Boolean).join(" · ");
    toggle($("settings-toggle"), box, settingsOpen);
    $("settings-toggle").textContent = settingsOpen ? "Hide" : "Show";
    if (!settingsOpen) return;
    if (form.fee === null) form.fee = String(s.priorityFee);
    const rootless = e && e.where === "here" && e.mode === "rootless";
    fill(box,
      e && group("Machines",
        el("p", { class: "hint", text: e.where === "engine" ? "Machines run inside the chainboot engine, a small Linux environment on this computer. Remove it and every machine in it with: chainboot engine reset"
          : e.where === "root" ? "chainboot runs as root here: machines start directly, with no extra step."
          : rootless ? "Machines run without administrator rights (in a user namespace): no password is asked."
          : "Machines run through sudo: starting and stopping one can ask for your password." }),
        e.where === "here" && el("div", { class: "row" },
          el("button", { class: "btn", text: rootless ? "Run through sudo instead" : "Run without administrator rights", title: "Switching needs a home without machines: save them, delete them, switch, and run them again", onclick: once(() => inTerminal(["engine", rootless ? "sudo" : "rootless"], "Switch how machines run")) }))),
      s.accountsAvailable && group("Pointer accounts",
        el("p", { class: "hint", text: "Keeps every pointer you write (your catalog, your saves) in an account as well, where one request reads it, so the newest save or catalog is found faster. Each account holds a deposit of about 0.0033 SOL, which comes back when it is closed." }),
        el("div", { class: "row" },
          el("button", { class: "btn" + (s.accounts ? " on" : ""), text: s.accounts ? "On" : "Off", "aria-pressed": String(s.accounts), title: s.accounts ? "Turn off" : "Turn on", onclick: once(async () => applyState(await api("POST", "/api/settings/accounts", { on: !s.accounts }))) }),
          state.login && el("button", { class: "btn", text: "Close accounts and refund", title: "Closes the pointer accounts of your vault and returns the deposits. The pointers stay in the ledger.", onclick: once(async () => { if (confirm("Close the pointer accounts of your vault and get the deposits back?")) await runJob(["accounts", "close"]); }) }))),
      group("Priority fee",
        el("p", { class: "hint", text: "A tip added to every transaction chainboot sends, for busy times. 1,000 to 10,000 lamports is usually plenty; 0 sends without a tip." }),
        el("form", { class: "row", onsubmit: guard(async (ev) => { ev.preventDefault(); const n = /^\d+$/.test(form.fee.trim()) ? Number(form.fee.trim()) : NaN; applyState(await api("POST", "/api/settings/fee", { lamports: n })); form.fee = null; redraw("settings"); toast(n ? "Every transaction now carries a tip of " + n + " lamports." : "Priority fee is off."); }) },
          field(form, "fee", { inputmode: "numeric", class: "narrow", "aria-label": "Priority fee in lamports" }), el("span", { class: "unit", text: "lamports per transaction" }), el("button", { class: "btn", type: "submit", text: "Set" }))),
      group("Other chains",
        el("p", { class: "hint", text: "chainboot also works on chains that run Solana programs and answer Solana's RPC. Give the chain a name and one endpoint; it is remembered by its genesis hash. Storing data there costs more transactions than on Solana." }),
        ...s.networks.map((n) => el("div", { class: "item" },
          el("span", { class: "name", text: n.name }), el("span", { class: "dim", title: n.id, text: (n.carrier === "memo" ? "Memo program" : n.carrier === "noop" ? "Noop program" : "not asked yet") + " · " + n.endpoints + (n.endpoints === 1 ? " endpoint" : " endpoints") }),
          el("button", { class: "btn", text: "Forget", disabled: n.id === state.cluster, title: n.id === state.cluster ? "Switch to another network first" : "Forget this chain and its endpoints", onclick: once(async () => { if (confirm('Forget "' + n.name + '" and its endpoints?')) applyState(await api("POST", "/api/network/remove", { id: n.id })); }) }))),
        el("form", { class: "row", onsubmit: guard(async (ev) => {
          ev.preventDefault(); const b = ev.submitter; if (b) b.disabled = true;
          try { tests.clear(); balances = null; shares = null; applyState(await api("POST", "/api/network/add", { name: form.netName, url: form.netUrl })); form.netName = form.netUrl = ""; redraw("settings"); toast("Chain added. You are on it now."); await loadCatalog(""); } finally { if (b) b.disabled = false; }
        }) },
          field(form, "netName", { placeholder: "name", class: "narrow", "aria-label": "Name of the chain", required: true }), field(form, "netUrl", { type: "url", placeholder: "https://rpc.the-chain.example", "aria-label": "RPC endpoint of the chain", required: true }), el("button", { class: "btn", type: "submit", text: "Add chain" }))),
      group("Publisher names",
        el("p", { class: "hint", text: "A short name for a publisher's address, or for a list that several publishers keep together (list:2:<address>,<address>,<address>: a system counts when two of the three have the same one). Use the name wherever a publisher is asked for." }),
        ...s.publishers.map((p) => el("div", { class: "item" },
          el("span", { class: "name", text: p.name }), el("span", { class: "dim", title: p.value, text: p.kind + " · " + short(p.value.replace(/^list:\d+:/, "")) }),
          el("button", { class: "btn", text: "Show", title: "Show its systems above", onclick: once(async () => { $("publisher").value = p.name; $("sec-systems").scrollIntoView({ behavior: "smooth" }); await loadCatalog(p.name); }) }),
          el("button", { class: "btn", text: "Remove", onclick: once(async () => applyState(await api("POST", "/api/publisher/remove", { name: p.name }))) }))),
        el("form", { class: "row", onsubmit: guard(async (ev) => { ev.preventDefault(); applyState(await api("POST", "/api/publisher/add", { name: form.pubName, value: form.pubValue })); form.pubName = form.pubValue = ""; redraw("settings"); toast("Name saved."); }) },
          field(form, "pubName", { placeholder: "name", class: "narrow", "aria-label": "Short name", required: true }), field(form, "pubValue", { placeholder: "address, or list:2:<address>,<address>,<address>", "aria-label": "Publisher address or list", required: true }), el("button", { class: "btn", type: "submit", text: "Save name" }))),
    );
  }, box);
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
  let answer;
  try { answer = await api("POST", "/api/catalog", { publisher }); } catch (e) { answer = { error: e.message }; }
  if (catalogPublisher !== publisher) return; // another catalog was asked for meanwhile
  catalog = answer;
  renderCatalog();
}

async function loadShares() {
  shares = "loading"; renderWallet();
  try { shares = await api("POST", "/api/shares"); } catch (e) { shares = { error: e.message }; }
  renderWallet();
}

async function runJob(args, title) {
  const { id } = await api("POST", "/api/job", { args, title });
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

/** Runs a command in a terminal window; where none can be opened, shows the command to type. */
async function inTerminal(args, title, opened) {
  const r = await api("POST", "/api/terminal", { args });
  if (r.opened) toast(opened || "A terminal window was opened.");
  else {
    activeJob = null;
    $("sec-activity").classList.remove("hidden");
    $("job-title").textContent = title; $("job-title").className = "";
    $("job-log").textContent = "Open a terminal and type:\n\n  " + r.command;
    $("job-command").textContent = ""; $("job-bar").style.width = "100%";
    $("sec-activity").scrollIntoView({ behavior: "smooth", block: "nearest" });
    try { await navigator.clipboard.writeText(r.command); toast("The command was copied. Paste it into a terminal."); } catch { toast("Type this in a terminal: " + r.command); }
  }
  setTimeout(() => refresh().catch(() => {}), 2500);
}

/**
 * Opens a machine in a terminal. `image`: what "chainboot run" is given. For a machine that
 * does not exist yet, `o` says how to make it: under another name, booting, lazy.
 */
async function openMachine(image, name, o = {}) {
  const args = ["run", image];
  if (!state.machines.some((m) => m.name === name)) {
    if (o.named) args.push("--name=" + name);
    if (o.boot) args.push("--boot");
    if (o.lazy) args.push("--lazy");
    // downloading shows its progress here; a lazy machine downloads nothing first
    if (!o.lazy && !state.images.some((i) => i.name === (o.image || name) && (!o.version || i.version === o.version))) {
      const j = await runJob(["pull", image]);
      if (j.status !== "done") return;
    }
  }
  await inTerminal(args, "Open " + name, "A terminal window was opened for " + name + ".");
}

async function shareThing(what, words, to, note) {
  to = (to || "").trim();
  if (!/^share_[1-9A-HJ-NP-Za-km-z]{20,}$/.test(to)) throw new Error("enter the receiver's share address: it starts with share_ and they find it under \"Save to chain\" or with: chainboot whoami");
  if (!confirm("Share " + words + " with " + short(to) + "?\n\nIt is a copy as of now, and it cannot be taken back: the receiver keeps the keys.")) return;
  await runJob(["share", what, "--with=" + to, ...(note && note.trim() ? ["--note=" + note.trim()] : []), "--yes"], "Share " + what);
}

async function keepShare(s) {
  const name = (keep[s.id] || "").trim() || s.name;
  if (!confirm("Keep " + s.what + " \"" + s.name + "\" from " + s.from + (name !== s.name ? " as \"" + name + "\"" : "") + "?")) return;
  const j = await runJob(["shared", "accept", s.id, "--name=" + name, "--yes"], "Keep " + s.what + " " + name);
  if (j.status === "done") { toast(s.what === "image" ? name + " is now one of your private systems." : name + " is now one of your saved machines: open it with chainboot run " + name); if (catalogPublisher === "me") await loadCatalog(); }
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
  balances = null; shares = null;
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
$("endpoint-test").addEventListener("click", once(async () => {
  const report = await api("POST", "/api/rpc/test");
  tests.clear();
  report.forEach((r, i) => { const ep = state.endpoints[i]; if (ep) tests.set(ep.index + ep.label, { ok: r.ok, detail: r.detail }); });
  renderEndpoints();
}));
$("endpoints-toggle").addEventListener("click", () => { endpointsOpen = $("endpoints-body").classList.contains("hidden"); renderEndpoints(); });
$("settings-toggle").addEventListener("click", () => { settingsOpen = !settingsOpen; redraw("settings"); });
$("publisher-toggle").addEventListener("click", () => { const f = $("publisher-form"); toggle($("publisher-toggle"), f, f.classList.contains("hidden")); if (!f.classList.contains("hidden")) $("publisher").focus(); });
$("publish-toggle").addEventListener("click", () => { const b = $("publish-body"); toggle($("publish-toggle"), b, b.classList.contains("hidden")); });
$("network").addEventListener("change", guard(async (e) => { tests.clear(); balances = null; shares = null; applyState(await api("POST", "/api/network", { cluster: e.target.value })); await loadCatalog(""); }));
$("publisher-form").addEventListener("submit", guard(async (e) => { e.preventDefault(); await loadCatalog($("publisher").value.trim()); }));
// one button switches between the public catalog and the signed-in wallet's private systems
$("private-show").addEventListener("click", guard(() => loadCatalog(catalogPublisher === "me" ? "" : "me")));
$("wallet-chip").addEventListener("click", () => $("sec-wallet").scrollIntoView({ behavior: "smooth" }));
$("signout").addEventListener("click", guard(async () => { balances = null; shares = null; applyState(await api("POST", "/api/logout")); if (catalogPublisher === "me") await loadCatalog(""); }));
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
