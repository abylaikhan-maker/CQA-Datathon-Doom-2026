// Hash router. Each view is a module exporting `render(root, params, query)`
// that may return a cleanup function. Views only touch `root`, so each one can
// be mounted on its own (e.g. a single Dynamics 365 form tab).
import { api } from "./api.js";
import { esc, $$, icon } from "./util.js";
import * as conversations from "./views/conversations.js";
import * as card from "./views/card.js";
import * as checklists from "./views/checklists.js";
import * as ruleCheck from "./views/rule-check.js";
import * as appeals from "./views/appeals.js";
import * as analytics from "./views/analytics.js";
import * as accuracy from "./views/accuracy.js";
import * as regulations from "./views/regulations.js";
import * as verify from "./views/verify.js";
import * as rules from "./views/rules.js";

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
  { re: /^\/rules$/, view: rules, nav: "rules", title: "Правила из апелляций", skel: "list" },
  { re: /^\/regulations$/, view: regulations, nav: "regulations", title: "Регламенты", skel: "list" },
  { re: /^\/verify$/, view: verify, nav: "accuracy", title: "Проверка эталона", skel: "split" },
  { re: /^\/verify\/(.+)$/, view: verify, nav: "accuracy", keys: ["id"], title: "Проверка эталона", skel: "split" },
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

  // Errors belong to the screen that caused them: don't carry them over.
  document.querySelectorAll("#toasts .toast.err").forEach((t) => t.remove());
  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  const token = ++seq;
  $$(".sidebar nav a[data-nav]").forEach((a) => {
    const on = a.dataset.nav === m.r.nav;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.title = `${m.r.title} · CQA`;
  // Progress of the first-run guide on «Диалоги» (steps that have no server-side trace).
  try {
    if (m.r.view === card) localStorage.setItem("cqa.seen.card", "1");
    if (m.r.view === accuracy) localStorage.setItem("cqa.seen.accuracy", "1");
  } catch { /* ignore */ }
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
        <div class="user">
          <span class="ava" title="${esc(email)}" aria-hidden="true">${esc(email.slice(0, 1))}</span>
          <span class="who"><span class="email" title="${esc(email)}">${esc(email)}</span><a href="/oauth2/sign_out?rd=%2F">Выйти</a></span>
          <a class="foot-ic logout-ic" href="/oauth2/sign_out?rd=%2F" title="Выйти (${esc(email)})" aria-label="Выйти из аккаунта ${esc(email)}">${icon("logout")}</a>
        </div>` : "") +
      `<div class="model" title="Модель: ${esc(m.model)}"><span class="dot" aria-hidden="true"></span><span class="model-t">Модель: <b>${esc(m.model)}</b></span></div>` +
      (m.provider === "mock" ? `<div class="mock" title="Демо-режим: ключ LLM не задан, оценки — простые эвристики">${icon("alert")}<span class="mock-t">Демо-режим · оценки по эвристикам</span></div>` : "");
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
loadMeta();
route();
