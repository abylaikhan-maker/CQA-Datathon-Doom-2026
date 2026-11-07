// Hash router. Each view is a module exporting `render(root, params, query)`
// that may return a cleanup function. Views only touch `root`, so each one can
// be mounted on its own (e.g. a single Dynamics 365 form tab).
import { api } from "./api.js";
import { esc, $$ } from "./util.js";
import * as conversations from "./views/conversations.js";
import * as card from "./views/card.js";
import * as checklists from "./views/checklists.js";
import * as ruleCheck from "./views/rule-check.js";
import * as appeals from "./views/appeals.js";
import * as analytics from "./views/analytics.js";
import * as accuracy from "./views/accuracy.js";

const routes = [
  { re: /^\/conversations$/, view: conversations, nav: "conversations", title: "Разговоры", skel: "list" },
  { re: /^\/conversation\/(.+)$/, view: card, nav: "conversations", keys: ["id"], title: "Диалог", skel: "split" },
  { re: /^\/checklists$/, view: checklists, nav: "checklists", title: "Чек-листы", skel: "split" },
  { re: /^\/checklists\/(new|\d+)$/, view: checklists, nav: "checklists", keys: ["id"], title: "Чек-листы", skel: "split" },
  { re: /^\/checklists\/(\d+)\/rule-check$/, view: ruleCheck, nav: "checklists", keys: ["id"], title: "Проверка правила", skel: "list" },
  { re: /^\/appeals$/, view: appeals, nav: "appeals", title: "Апелляции", skel: "split" },
  { re: /^\/appeals\/(\d+)$/, view: appeals, nav: "appeals", keys: ["id"], title: "Апелляции", skel: "split" },
  { re: /^\/accuracy$/, view: accuracy, nav: "accuracy", title: "Точность", skel: "list" },
  { re: /^\/analytics$/, view: analytics, nav: "analytics", title: "Аналитика", skel: "list" },
];

let cleanup = null;
let lastPath = null;
let seq = 0;

/** Placeholder shown while a view loads its data (only if loading takes a moment). */
function skeleton(kind) {
  const lines = (n, w = [92, 78, 85, 64, 88, 70]) =>
    Array.from({ length: n }, (_, i) => `<div class="skel skel-line" style="width:${w[i % w.length]}%"></div>`).join("");
  const head = `<div><div class="skel skel-title"></div><div class="skel skel-line" style="width:340px;max-width:80%;margin-top:10px"></div></div>`;
  if (kind === "split") {
    return `<div class="skel-page" aria-hidden="true">${head}
      <div class="cl-grid"><div class="skel-card">${lines(6)}</div><div class="skel-card">${lines(10)}</div></div></div>`;
  }
  return `<div class="skel-page" aria-hidden="true">${head}
    <div class="skel-kpis">${'<div class="skel"></div>'.repeat(5)}</div>
    <div class="skel-card">${lines(9)}</div></div>`;
}

const bar = () => document.getElementById("route-bar");
function loading(on) {
  const b = bar();
  if (!b) return;
  if (on) { b.classList.remove("done"); void b.offsetWidth; b.classList.add("on"); }
  else { b.classList.remove("on"); b.classList.add("done"); }
}

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
  const token = ++seq;
  $$(".site-nav [data-nav]").forEach((a) => {
    const on = a.dataset.nav === m.r.nav;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.getElementById("reports-menu").classList.toggle("active", ["analytics", "accuracy"].includes(m.r.nav));
  document.title = `${m.r.title} · CQA`;
  const params = {};
  (m.r.keys || []).forEach((k, i) => (params[k] = decodeURIComponent(m.m[i + 1])));

  // Each navigation renders into its own host, so a slow, superseded render
  // writes into a detached node instead of over the newer screen.
  const host = document.createElement("div");
  host.className = "view-host";
  root.replaceChildren(host);
  window.scrollTo(0, 0);
  root.setAttribute("aria-busy", "true");
  loading(true);
  const skelTimer = setTimeout(() => { if (!host.childElementCount) host.innerHTML = skeleton(m.r.skel); }, 120);
  let result;
  try {
    result = await m.r.view.render(host, params, query);
  } catch (e) {
    if (token === seq) {
      host.innerHTML = `
        <div class="card empty-state" role="alert">
          <div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/></svg></div>
          <h3>Не удалось открыть страницу</h3>
          <p>${esc(e.message)}</p>
          <button class="btn btn-primary" type="button" data-retry>Повторить</button>
        </div>`;
      host.querySelector("[data-retry]").addEventListener("click", () => { lastPath = null; route(); });
    }
  } finally {
    clearTimeout(skelTimer);
  }
  if (token !== seq) { if (typeof result === "function") result(); return; }
  cleanup = result;
  root.setAttribute("aria-busy", "false");
  loading(false);
  host.classList.add("view-enter");
  root.focus({ preventScroll: true });
  refreshBadge();
}

export async function refreshBadge() {
  try {
    const open = await api.appeals("open");
    const b = document.getElementById("appeals-badge");
    b.hidden = !open.length;
    b.textContent = open.length;
    b.title = `Открытых апелляций: ${open.length}`;
  } catch { /* ignore */ }
}

async function loadMeta() {
  try {
    const [m, me] = await Promise.all([api.meta(), api.me()]);
    window.CQA_USER = me.email || null;
    const email = me.email || "";
    document.getElementById("meta-info").innerHTML =
      (email ? `
        <div class="site-account"><b>${esc(email)}</b><a href="/oauth2/sign_out?rd=%2F">Выйти</a></div>` : "") +
      `<div>Модель <b>${esc(m.model)}</b></div>` +
      (m.provider === "mock" ? `<div class="site-demo-note">Демо-режим · оценки по эвристикам</div>` : "");
    document.getElementById("workspace-menu").classList.toggle("is-demo", m.provider === "mock");
  } catch { /* ignore */ }
}

// Back from Google sign-in: restore the screen the user was on.
try {
  const back = sessionStorage.getItem("cqa.returnTo");
  if (back) { sessionStorage.removeItem("cqa.returnTo"); if (!location.hash) location.hash = back; }
} catch { /* ignore */ }

// The skip link must not change the hash (that would navigate).
document.getElementById("skip-link")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("view").focus();
});

window.addEventListener("hashchange", route);
for (const menu of $$(".site-menu")) {
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) menu.open = false; });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.open = false; });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
}
loadMeta();
route();
