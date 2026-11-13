// Turns docs/*.md into pages of the website (site/docs/*.html). No dependencies.
//
//   node scripts/build-site.mjs           write the pages
//   node scripts/build-site.mjs --check   fail if the committed pages are out of date
//
// The Markdown reader below understands exactly what the chainboot docs use: headings,
// paragraphs, fenced code, lists, tables, block quotes, bold, inline code and links.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const docsDir = path.join(root, "docs"), outDir = path.join(root, "site", "docs");
const REPO = "https://github.com/bettercallfolio/chainboot";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (text) => text.toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");

function href(url) {
  const doc = /^(\d\d-[a-z0-9-]+)\.md(#.*)?$/.exec(url);
  if (doc) return `${doc[1]}.html${doc[2] ?? ""}`;
  if (url.startsWith("#") || /^[a-z]+:/i.test(url)) return url;
  return `${REPO}/blob/main/docs/${url}`; // anything else is a file of the repository
}

/** Inline Markdown: code spans, links, bare URLs, bold. Everything else is escaped text. */
function inline(text) {
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const to = href(url), external = /^https?:/.test(to);
    return hold(`<a href="${esc(to)}"${external ? ' rel="noopener"' : ""}>${inline(label)}</a>`);
  });
  s = s.replace(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?]/g, (url) => hold(`<a href="${esc(url)}" rel="noopener">${esc(url)}</a>`));
  s = esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

function codeBlock(lines, lang) {
  // dim comments: "// ..." in JavaScript, "# ..." in shell (at the start of a line or after two spaces)
  const comment = lang === "js" ? /(^|\s)(\/\/ .*)$/ : lang === "sh" || lang === "powershell" ? /(^|\s{2,})(#(?!!).*)$/ : null;
  const body = lines.map((line) => {
    const m = comment?.exec(line);
    if (!m) return esc(line);
    const at = m.index + m[1].length;
    return `${esc(line.slice(0, at))}<span class="c">${esc(line.slice(at))}</span>`;
  }).join("\n");
  return `<div class="code-wrap"><pre><code>${body}</code></pre><button class="copy" type="button" aria-label="Copy this block">copy</button></div>`;
}

/** Block Markdown to HTML. Returns the HTML and the level-2 headings found (for the page outline). */
function render(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [], outline = [];
  let title = "";
  const isList = (l) => /^\s*([-*]|\d+\.)\s+/.test(l);
  const startsBlock = (l) => /^(#{1,4}\s|```|>|\|)/.test(l) || isList(l) || /^---+\s*$/.test(l);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(codeBlock(body, fence[1]));
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length, text = h[2].trim(), id = slug(text);
      if (level === 1) title ||= text.replace(/`/g, "");
      if (level === 2) outline.push({ id, text: text.replace(/`/g, "") });
      out.push(level === 1 ? `<h1>${inline(text)}</h1>` : `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inline(text)}</h${level}>`);
      i++; continue;
    }
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.startsWith("|") && /^\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].startsWith("|"); i++) rows.push(cells(lines[i]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (line.startsWith(">")) {
      const body = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) body.push(lines[i].replace(/^>\s?/, ""));
      out.push(`<blockquote>${render(body.join("\n")).html}</blockquote>`);
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m || /^\s*\d+\./.test(lines[i]) !== ordered) break;
        const parts = [m[2]];
        for (i++; i < lines.length && lines[i].trim() && /^\s+\S/.test(lines[i]) && !isList(lines[i]); i++) parts.push(lines[i].trim());
        items.push(parts.join(" "));
        // a blank line followed by another item of the same list keeps the list going
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j > i && j < lines.length && isList(lines[j]) && /^\s*\d+\./.test(lines[j]) === ordered) i = j; else if (j > i) break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para = [line.trim()];
    for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i]); i++) para.push(lines[i].trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { html: out.join("\n"), outline, title };
}

// ---------------------------------------------------------------- pages

const SUMMARY = {
  "01-getting-started": "Install, add an endpoint, run your first system, notes for each platform.",
  "02-how-it-works": "The whole idea in plain words: files as transactions, images, machines.",
  "03-machines": "Running, several terminals, keeping one up, services, exporting.",
  "04-saving": "Wallet sign-in, the vault, encryption, automatic saves, restore, conflicts.",
  "05-publishing": "Put any Linux distribution on chain: private by default, public when you say so.",
  "06-sdk": "Store files, move pointers, pool endpoints, encrypt for a wallet: with examples.",
  "07-format": "Every byte chainboot writes, so anyone can build a reader or writer.",
  "08-networks-and-costs": "Devnet, testnet, mainnet; what storing data costs; how long it stays.",
  "09-security": "What you trust, what you do not have to, and where the limits are.",
  "10-ideas-and-roadmap": "What else can be built with these parts, and what comes next.",
  "11-faq": "Common questions and what to do when something goes wrong.",
  "12-thanks": "The people and projects chainboot stands on.",
};

const files = fs.readdirSync(docsDir).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
const docs = files.map((f) => {
  const name = f.replace(/\.md$/, "");
  const r = render(fs.readFileSync(path.join(docsDir, f), "utf8"));
  // the last line of each guide ("Next: ...") is replaced by the previous/next links of the page
  const html = r.html.replace(/\n?<p>Next: .*<\/p>\s*$/, "");
  return { name, title: r.title, html, outline: r.outline, number: name.slice(0, 2) };
});

function page({ title, description, body, current }) {
  const side = docs.map((d) => {
    const here = d.name === current;
    const sub = here && d.outline.length ? `<ul>${d.outline.map((o) => `<li><a href="#${o.id}">${esc(o.text)}</a></li>`).join("")}</ul>` : "";
    return `<li${here ? ' class="here"' : ""}><a href="${d.name}.html"${here ? ' aria-current="page"' : ""}><span class="num">${d.number}</span>${esc(d.title)}</a>${sub}</li>`;
  }).join("\n        ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · chainboot docs</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#121416">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../style.css">
</head>
<body class="docs-page">
<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <div class="wrap bar">
    <a class="logo" href="../index.html" aria-label="chainboot, home">chainboot<span class="cursor" aria-hidden="true"></span></a>
    <nav aria-label="Site">
      <a href="../index.html#how">how it works</a>
      <a href="../index.html#systems">systems</a>
      <a href="../index.html#save">save</a>
      <a href="../index.html#publish">publish</a>
      <a href="../index.html#sdk">sdk</a>
      <a href="index.html" aria-current="page">docs</a>
    </nav>
    <a class="btn primary small" href="../index.html#install">install</a>
  </div>
</header>
<div class="wrap docs">
  <aside class="side" aria-label="Documentation">
    <button class="btn small side-toggle" type="button" aria-expanded="false" aria-controls="side-list">All guides</button>
    <ol id="side-list">
        <li${current === "index" ? ' class="here"' : ""}><a href="index.html"><span class="num">00</span>Overview</a></li>
        ${side}
    </ol>
  </aside>
  <main id="main" class="prose">
${body}
  </main>
</div>
<footer>
  <div class="wrap foot">
    <div><span class="logo">chainboot</span><span class="dim">MIT license</span></div>
    <nav aria-label="Links"><a href="../index.html">home</a><a href="index.html">docs</a><a href="${REPO}">github</a></nav>
  </div>
</footer>
<script src="../docs.js"></script>
</body>
</html>
`;
}

const pages = new Map();
docs.forEach((d, i) => {
  const prev = docs[i - 1], next = docs[i + 1];
  const nav = `<nav class="pager" aria-label="More guides">${prev ? `<a class="pager-prev" href="${prev.name}.html"><span>previous</span>${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a class="pager-next" href="${next.name}.html"><span>next</span>${esc(next.title)}</a>` : "<span></span>"}</nav>`;
  const source = `<p class="source"><a href="${REPO}/blob/main/docs/${d.name}.md" rel="noopener">Edit this page on GitHub</a></p>`;
  pages.set(`${d.name}.html`, page({ title: d.title, description: SUMMARY[d.name] ?? d.title, current: d.name, body: `<p class="label"># docs / ${d.number}</p>\n${d.html}\n${nav}\n${source}` }));
});
pages.set("index.html", page({
  title: "Documentation", description: "Guides for chainboot: getting started, how it works, saving, publishing, the SDK, the on-chain format, security.", current: "index",
  body: `<p class="label"># docs</p>\n<h1>Documentation</h1>\n<p>Twelve short guides, written in plain language. Start with the first two; the rest can be read in any order.</p>\n<ol class="doc-list">\n${docs.map((d) => `<li><a href="${d.name}.html"><span class="num">${d.number}</span><span><b>${esc(d.title)}</b><span>${esc(SUMMARY[d.name] ?? "")}</span></span></a></li>`).join("\n")}\n</ol>`,
}));

if (process.argv.includes("--check")) {
  const stale = [...pages].filter(([name, html]) => !fs.existsSync(path.join(outDir, name)) || fs.readFileSync(path.join(outDir, name), "utf8") !== html).map(([n]) => n);
  const extra = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !pages.has(f)) : [];
  if (stale.length || extra.length) {
    console.error(`site/docs is out of date (${[...stale, ...extra].join(", ")}). Run: npm run site`);
    process.exit(1);
  }
  console.log(`site/docs is up to date (${pages.size} pages)`);
} else {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, html] of pages) fs.writeFileSync(path.join(outDir, name), html);
  console.log(`wrote ${pages.size} pages to site/docs`);
}
