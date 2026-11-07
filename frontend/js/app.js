// Hash router. Each view is a module exporting `render(root, params, query)`
// that may return a cleanup function. Views only touch `root`, so each one can
// be mounted on its own (e.g. a single Dynamics 365 form tab).
import { api } from "./api.js";
import { esc, $$ } from "./util.js";
import * as conversations from "./views/conversations.js";
import * as card from "./views/card.js";
import * as checklists from "./views/checklists.js";
import * as appeals from "./views/appeals.js";
import * as analytics from "./views/analytics.js";

const routes = [
  { re: /^\/conversations$/, view: conversations, nav: "conversations" },
  { re: /^\/conversation\/(.+)$/, view: card, nav: "conversations", keys: ["id"] },
  { re: /^\/checklists$/, view: checklists, nav: "checklists" },
  { re: /^\/checklists\/(new|\d+)$/, view: checklists, nav: "checklists", keys: ["id"] },
  { re: /^\/appeals$/, view: appeals, nav: "appeals" },
  { re: /^\/appeals\/(\d+)$/, view: appeals, nav: "appeals", keys: ["id"] },
  { re: /^\/analytics$/, view: analytics, nav: "analytics" },
];

let cleanup = null;
let lastPath = null;

async function route() {
  const hash = location.hash.replace(/^#/, "") || "/conversations";
  const [path, qstr] = hash.split("?");
  const query = Object.fromEntries(new URLSearchParams(qstr || ""));
  const m = routes.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  const root = document.getElementById("view");
  if (!m) { location.hash = "#/conversations"; return; }

  // Same card, only the query changed (e.g. ?msg=5) — let the view handle it in place.
  if (path === lastPath && m.r.view.onQuery) { m.r.view.onQuery(query); return; }
  lastPath = path;

  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  $$(".sidebar nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === m.r.nav));
  const params = {};
  (m.r.keys || []).forEach((k, i) => (params[k] = decodeURIComponent(m.m[i + 1])));
  root.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
  try {
    cleanup = await m.r.view.render(root, params, query);
  } catch (e) {
    root.innerHTML = `<div class="card card-pad"><h2>Ошибка</h2><p>${esc(e.message)}</p></div>`;
  }
  root.focus({ preventScroll: true });
  refreshBadge();
}

export async function refreshBadge() {
  try {
    const open = await api.appeals("open");
    const b = document.getElementById("appeals-badge");
    b.hidden = !open.length;
    b.textContent = open.length;
  } catch { /* ignore */ }
}

async function loadMeta() {
  try {
    const [m, me] = await Promise.all([api.meta(), api.me()]);
    window.CQA_USER = me.email || null;
    document.getElementById("meta-info").innerHTML =
      (me.email ? `<div class="user">${esc(me.email)}<br><a href="/oauth2/sign_out?rd=%2F">Выйти</a></div>` : "") +
      `Модель: <b>${esc(m.model)}</b>${m.provider === "mock" ? "<br>⚠ mock-режим: ключ LLM не задан" : ""}`;
  } catch { /* ignore */ }
}

// Back from Google sign-in: restore the screen the user was on.
try {
  const back = sessionStorage.getItem("cqa.returnTo");
  if (back) { sessionStorage.removeItem("cqa.returnTo"); if (!location.hash) location.hash = back; }
} catch { /* ignore */ }

window.addEventListener("hashchange", route);
loadMeta();
route();
