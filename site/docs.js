// Documentation pages: copy buttons on code blocks and the guide list on small screens.
"use strict";
for (const button of document.querySelectorAll(".code-wrap .copy")) {
  button.addEventListener("click", async () => {
    const text = button.parentElement.querySelector("code").textContent;
    try { await navigator.clipboard.writeText(text); button.textContent = "copied"; } catch { button.textContent = "select + copy"; }
    setTimeout(() => { button.textContent = "copy"; }, 1500);
  });
}
const side = document.querySelector(".side"), toggle = document.querySelector(".side-toggle");
if (side && toggle) toggle.addEventListener("click", () => toggle.setAttribute("aria-expanded", String(side.classList.toggle("open"))));
