// chainboot website. No framework, no tracking, no outside requests.
"use strict";

// ---- the terminal in the hero types a real session
const SESSION = [
  { cmd: "chainboot run ubuntu" },
  { out: "Downloading ubuntu:latest  ████████████████  114 MB", cls: "o", wait: 500 },
  { out: "✔ ubuntu:latest is ready (114 MB verified)", cls: "ok", wait: 350 },
  { out: "✔ created machine ubuntu from ubuntu:latest", cls: "ok", wait: 350 },
  { root: "apt install -y nginx", wait: 500 },
  { out: "Setting up nginx ...", cls: "o", wait: 600 },
  { root: "exit", wait: 500 },
  { out: "Changes are saved to Solana in the background.", cls: "o", wait: 900 },
  { cmd: "chainboot status" },
  { out: "ubuntu   stopped   saved (#1)   autosave on", cls: "o", wait: 300 },
];

const demo = document.getElementById("demo");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const span = (cls, text) => { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = text; return s; };

async function play() {
  demo.textContent = "";
  const cursor = span("cursor inline", "");
  for (const step of SESSION) {
    if (step.out !== undefined) {
      demo.append(span(step.cls, step.out), "\n");
      if (!still) await sleep(step.wait || 300);
      continue;
    }
    const text = step.cmd ?? step.root;
    demo.append(span(step.cmd !== undefined ? "p" : "r", step.cmd !== undefined ? "$" : "root@ubuntu:~#"), " ");
    const typed = span("", "");
    demo.append(typed, cursor);
    if (still) typed.textContent = text;
    else { await sleep(450); for (const ch of text) { typed.textContent += ch; await sleep(28 + Math.random() * 40); } await sleep(step.wait || 400); }
    cursor.remove();
    demo.append("\n");
  }
  demo.append(span("p", "$"), " ", cursor);
}

// start when the terminal is on screen; replay on click
let played = false;
new IntersectionObserver((entries, obs) => {
  if (entries.some((e) => e.isIntersecting) && !played) { played = true; obs.disconnect(); play(); }
}, { threshold: 0.3 }).observe(demo);
let busy = false;
demo.parentElement.addEventListener("click", async () => { if (busy) return; busy = true; await play(); busy = false; });
demo.parentElement.title = "Click to play again";

// ---- install tabs and copy
const cmd = document.getElementById("cmd"), copy = document.getElementById("copy");
for (const tab of document.querySelectorAll(".tabs button")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tabs button")) t.setAttribute("aria-selected", String(t === tab));
    cmd.textContent = tab.dataset.cmd;
  });
}
copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(cmd.textContent); copy.textContent = "copied"; }
  catch { const r = document.createRange(); r.selectNodeContents(cmd); const s = getSelection(); s.removeAllRanges(); s.addRange(r); copy.textContent = "select + copy"; }
  setTimeout(() => { copy.textContent = "copy"; }, 1600);
});

// ---- sections fade in once
if (!still && "IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }, { threshold: 0.08 });
  for (const s of document.querySelectorAll("main > section:not(.hero)")) { s.classList.add("reveal"); io.observe(s); }
}
