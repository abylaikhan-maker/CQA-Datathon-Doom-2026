// Shared parts of «ИИ-обзор» and «Операторы»: the period / set / checklist filter bar,
// small chart helpers and the AI review panel (create, poll, render, history).
import { api } from "../api.js";
import { esc, $, fmtNum, scoreClass, plural, icon, toast, busy } from "../util.js";

export const DLG = ["диалог", "диалога", "диалогов"];
export const NONE = "__none__";
const KEY = "cqa.team.filters";

const store = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } },
  set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ } },
};

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const PRESETS = [
  { k: "all", label: "Всё время", range: () => ["", ""] },
  { k: "today", label: "Сегодня", range: () => [iso(new Date()), iso(new Date())] },
  { k: "7", label: "7 дней", range: () => [daysAgo(6), iso(new Date())] },
  { k: "30", label: "30 дней", range: () => [daysAgo(29), iso(new Date())] },
  { k: "month", label: "Этот месяц", range: () => { const d = new Date(); return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), iso(d)]; } },
];

export function fmtDay(s, withYear = false) {
  if (!s) return "";
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("ru-RU", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
}

export function periodLabel(from, to) {
  if (!from && !to) return "за всё время";
  if (from && to && from === to) return `за ${fmtDay(from, true)}`;
  if (from && to) return `${fmtDay(from)} — ${fmtDay(to, true)}`;
  return from ? `с ${fmtDay(from, true)}` : `по ${fmtDay(to, true)}`;
}

export const opHref = (key) => `#/operators/${encodeURIComponent(key)}`;
export const cardHref = (d) => `#/conversation/${encodeURIComponent(d.id)}${d.eval_id ? `?eval=${d.eval_id}` : ""}`;

/** Current filters: URL query first, then the saved ones. */
export function readFilters(query = {}) {
  const s = store.get();
  const f = {
    from: query.from ?? s.from ?? "", to: query.to ?? s.to ?? "",
    group: query.group ?? s.group ?? "", checklist_id: Number(query.checklist ?? s.checklist_id) || null,
  };
  return f;
}

export const apiParams = (f) => ({ date_from: f.from || null, date_to: f.to || null, group: f.group || null, checklist_id: f.checklist_id || null });

/**
 * Filter bar. `onChange(f)` runs after any change; filters are saved for both screens.
 * Returns { get, setChecklist }.
 */
export function filterBar(box, f, { groups, checklists }, onChange) {
  if (!checklists.some((c) => c.id === f.checklist_id)) f.checklist_id = (checklists.find((c) => c.is_active) || checklists[0])?.id ?? null;
  if (f.group && !groups.some((g) => g.id === f.group)) f.group = "";
  const presetOf = () => PRESETS.find((p) => { const [a, b] = p.range(); return a === f.from && b === f.to; })?.k || "";
  box.innerHTML = `
    <div class="tm-filters" role="group" aria-label="Фильтры периода">
      <div class="chips tm-presets" role="group" aria-label="Быстрый выбор периода">
        ${PRESETS.map((p) => `<button type="button" class="chip" data-preset="${p.k}">${esc(p.label)}</button>`).join("")}
      </div>
      <label class="field">С<input class="input" type="date" id="tm-from"></label>
      <label class="field">По<input class="input" type="date" id="tm-to"></label>
      <label class="field">Набор<select class="input" id="tm-group">
        <option value="">Все наборы</option>
        ${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.id)} (${g.count})</option>`).join("")}
      </select></label>
      <label class="field">Чек-лист<select class="input" id="tm-checklist">
        ${checklists.map((c) => `<option value="${c.id}">v${c.version} · ${esc(c.name)}${c.is_active ? " · активный" : ""}</option>`).join("")}
      </select></label>
    </div>`;
  const sync = () => {
    $("#tm-from", box).value = f.from;
    $("#tm-to", box).value = f.to;
    $("#tm-from", box).max = f.to || "";
    $("#tm-to", box).min = f.from || "";
    $("#tm-group", box).value = f.group;
    $("#tm-checklist", box).value = f.checklist_id ?? "";
    const p = presetOf();
    box.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === p)));
  };
  const changed = () => { store.set(f); sync(); onChange(f); };
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    [f.from, f.to] = PRESETS.find((p) => p.k === b.dataset.preset).range();
    changed();
  });
  box.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "tm-from") { f.from = e.target.value; if (f.to && f.from > f.to) f.to = f.from; }
    if (id === "tm-to") { f.to = e.target.value; if (f.from && f.to && f.from > f.to) f.from = f.to; }
    if (id === "tm-group") f.group = e.target.value;
    if (id === "tm-checklist") f.checklist_id = Number(e.target.value) || null;
    changed();
  });
  sync();
  store.set(f);
  return { get: () => f };
}

/* --------------------------------------------------------------- charts ---- */

export const pill = (v) => v === null || v === undefined
  ? `<span class="muted">—</span>` : `<span class="score-pill ${scoreClass(v)}">${fmtNum(v, 1)}</span>`;

export function delta(v, unit = "") {
  if (v === null || v === undefined) return `<span class="muted">—</span>`;
  const n = Number(v);
  const cls = n > 0.05 ? "up" : n < -0.05 ? "down" : "flat";
  return `<span class="tm-delta ${cls}" title="Разница со средним по команде">${n > 0 ? "+" : n < 0 ? "−" : "±"}${fmtNum(Math.abs(n), 1)}${unit}</span>`;
}

/** Column chart of the average score per day (one series). */
export function dayColumns(days) {
  const pts = days.filter((d) => d.dialogs);
  if (!pts.length) return `<div class="muted small">Нет диалогов за период</div>`;
  const maxN = Math.max(...pts.map((d) => d.dialogs));
  return `
    <div class="tm-cols" role="img" aria-label="${esc(pts.map((d) => `${fmtDay(d.day)}: средний итог ${fmtNum(d.avg, 1)}, ${d.dialogs} ${plural(d.dialogs, DLG)}`).join("; "))}">
      <div class="tm-cols-grid" aria-hidden="true"><span style="bottom:100%">100</span><span style="bottom:85%">85</span><span style="bottom:65%">65</span><span style="bottom:0">0</span></div>
      ${pts.map((d) => {
        const h = d.avg === null ? 0 : Math.max(2, d.avg);
        return `<div class="tm-col" tabindex="0" title="${esc(`${fmtDay(d.day, true)}\nСредний итог: ${fmtNum(d.avg, 1)}\nДиалогов: ${d.dialogs}, оценено: ${d.evaluated}\nГрубых ошибок: ${d.critical}`)}">
          <i class="${scoreClass(d.avg)}" style="height:${h}%"></i>
          ${d.avg !== null ? `<b style="bottom:calc(${h}% + 3px)">${fmtNum(d.avg, 0)}</b>` : ""}
          <span class="tm-col-x">${esc(fmtDay(d.day))}<small>${d.dialogs}</small></span>
        </div>`;
      }).join("")}
    </div>
    <div class="tm-cols-cap muted small">Столбец — средний итог за день; под датой — число диалогов (максимум ${maxN}).</div>`;
}

/** Horizontal bars 0–100. items: [{label, sub, value, href, title}] */
export function bars(items, { empty = "Нет данных" } = {}) {
  if (!items.length) return `<div class="muted small">${esc(empty)}</div>`;
  return `${items.map((x) => {
    const tag = x.href ? "a" : "div";
    return `<${tag} class="hbar tm-hbar" ${x.href ? `href="${esc(x.href)}"` : ""} title="${esc(x.title || `${x.label}: ${fmtNum(x.value, 1)}`)}">
      <span class="lbl"><b class="l1">${esc(x.label)}</b>${x.sub ? `<small>${esc(x.sub)}</small>` : ""}</span>
      <div class="track"><div class="fill ${x.cls || ""}" style="width:${Math.max(0, Math.min(100, Number(x.value) || 0))}%"></div></div>
      <span class="num">${x.value === null || x.value === undefined ? "—" : fmtNum(x.value, x.digits ?? 1)}${x.unit || ""}</span>
    </${tag}>`;
  }).join("")}
  <div class="hbar-axis tm-hbar-axis" aria-hidden="true"><span></span><div><span>0</span><span>50</span><span>100</span></div><span></span></div>`;
}

/* ------------------------------------------------------------ AI review ---- */

const TONE = {
  good: { label: "Стабильно", cls: "good", ic: "check" },
  attention: { label: "Есть просадки", cls: "warn", ic: "info" },
  critical: { label: "Требует вмешательства", cls: "bad", ic: "alert" },
};
const SEV = { high: ["Высокий", "no"], medium: ["Средний", "warn"], low: ["Низкий", "na"] };
const RISK = { high: ["Высокий риск", "no"], medium: ["Средний риск", "warn"], low: ["Низкий риск", "yes"] };
const PRIO = { high: ["Срочно", "no"], medium: ["Важно", "warn"], low: ["Планово", "na"] };

const dlgChips = (ids) => ids.length ? `<span class="tm-refs">${ids.map((id) => `<a class="tm-ref" href="#/conversation/${encodeURIComponent(id)}" title="Открыть разбор диалога">${esc(id)}</a>`).join("")}</span>` : "";
const opChips = (names) => names.length ? `<span class="tm-refs">${names.map((n) => `<a class="tm-ref tm-ref-op" href="${opHref(n)}" title="Дашборд оператора">${icon("star")}${esc(n)}</a>`).join("")}</span>` : "";

function critChips(codes, checklist) {
  if (!codes.length) return "";
  const byCode = Object.fromEntries((checklist?.criteria || []).map((c) => [c.code || c.id, c]));
  return `<span class="tm-refs">${codes.map((c) => `<span class="badge outline" title="${esc(byCode[c]?.title || "")}">${esc(c)} ${esc(byCode[c]?.title || "")}</span>`).join("")}</span>`;
}

const RISK_ORDER = { high: 0, medium: 1, low: 2 };

function opsBlock(list, opStats) {
  const ops = [...list].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || (opStats[a.name]?.avg ?? 101) - (opStats[b.name]?.avg ?? 101));
  const watch = ops.filter((o) => o.risk !== "low"), calm = ops.filter((o) => o.risk === "low");
  const card = (o) => {
    const st = opStats[o.name];
    return `<a class="tm-op is-${o.risk}" href="${opHref(o.name)}">
      <div class="tm-op-h"><b>${esc(o.name)}</b>${st ? pill(st.avg) : ""}<span class="badge ${RISK[o.risk][1]}">${RISK[o.risk][0]}</span></div>
      ${st ? `<span class="muted small">${st.evaluated} ${plural(st.evaluated, DLG)}${st.critical ? ` · грубых ошибок: ${st.critical}` : ""}</span>` : ""}
      <p>${esc(o.assessment)}</p>
      <dl><dt>${icon("check")}Сильное</dt><dd>${esc(o.strength)}</dd><dt>${icon("target")}Развивать</dt><dd>${esc(o.focus)}</dd></dl>
    </a>`;
  };
  return `
    <section class="tm-block" aria-label="Операторы">
      <h3 class="tm-h">${icon("star")}Операторы <span class="muted small">${watch.length ? `требуют внимания: ${watch.length} из ${ops.length}` : `все ${ops.length} — без замечаний`}</span></h3>
      ${watch.length ? `<div class="tm-ops">${watch.map(card).join("")}</div>` : ""}
      ${calm.length ? `<div class="tm-calm"><span class="tm-calm-l">${icon("check")}Стабильно работают</span>
        ${calm.map((o) => `<a class="tm-ref tm-ref-op" href="${opHref(o.name)}" title="${esc(o.assessment)}">${esc(o.name)}${opStats[o.name] ? ` <b>${fmtNum(opStats[o.name].avg, 0)}</b>` : ""}</a>`).join("")}</div>` : ""}
    </section>`;
}

export function renderReview(r, { checklist, opStats = {}, single = false } = {}) {
  const x = r.result;
  const tone = TONE[x.tone] || TONE.attention;
  const meta = [
    periodLabel(r.date_from, r.date_to),
    r.dataset_group ? `набор ${r.dataset_group}` : "все наборы",
    r.checklist_version ? `чек-лист v${r.checklist_version}` : "",
    r.stats?.evaluated != null ? `${r.stats.evaluated} ${plural(r.stats.evaluated, ["оценённый диалог", "оценённых диалога", "оценённых диалогов"])}` : "",
  ].filter(Boolean);
  const foot = [
    r.model ? `модель ${r.model}` : "", r.cost_usd ? `$${fmtNum(r.cost_usd, 4)}` : "",
    r.duration_ms ? `${fmtNum(r.duration_ms / 1000, 1)} с` : "",
    r.finished_at ? new Date(r.finished_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "",
    r.author || "",
  ].filter(Boolean);
  return `
    <div class="tm-hero is-${tone.cls}">
      <span class="tm-hero-ic">${icon(tone.ic)}</span>
      <div class="tm-hero-t">
        <div class="tm-hero-top"><span class="badge ${tone.cls === "good" ? "yes" : tone.cls === "bad" ? "no" : "warn"}">${esc(tone.label)}</span>
          <span class="muted small">${esc(meta.join(" · "))}</span></div>
        <h3>${esc(x.headline)}</h3>
        <p>${esc(x.overall)}</p>
        <div class="tm-hero-foot muted small">${icon("bulb")}ИИ-обзор · ${esc(foot.join(" · "))}</div>
      </div>
    </div>
    <section class="tm-block" aria-label="Проблемы">
      <h3 class="tm-h">${icon("alert")}Проблемы <span class="muted small">${x.problems.length}</span></h3>
      ${x.problems.length ? `<ul class="tm-items tm-items-grid">${[...x.problems].sort((a, b) => RISK_ORDER[a.severity] - RISK_ORDER[b.severity]).map((p) => `
        <li class="tm-item is-${p.severity}"><div class="tm-item-h"><b>${esc(p.title)}</b><span class="badge ${SEV[p.severity][1]}">${SEV[p.severity][0]}</span></div>
          <p>${esc(p.detail)}</p>${critChips(p.criteria, checklist)}${single ? "" : opChips(p.operators)}${dlgChips(p.dialogs)}</li>`).join("")}</ul>`
        : `<p class="muted small">Существенных проблем не найдено.</p>`}
    </section>
    <section class="tm-block" aria-label="Сильные стороны">
      <h3 class="tm-h">${icon("check")}Сильные стороны</h3>
      ${x.strengths.length ? `<ul class="tm-items tm-items-grid">${x.strengths.map((s) => `
        <li class="tm-item is-good"><b>${esc(s.title)}</b><p>${esc(s.detail)}</p>${dlgChips(s.dialogs)}</li>`).join("")}</ul>`
        : `<p class="muted small">Не выделены.</p>`}
    </section>
    ${!single && x.operators.length ? opsBlock(x.operators, opStats) : ""}
    ${single && x.operators[0] ? `
      <div class="tm-two">
        <div class="tm-item is-good"><b>${icon("check")}Сильное</b><p>${esc(x.operators[0].strength)}</p></div>
        <div class="tm-item is-medium"><b>${icon("target")}Развивать</b><p>${esc(x.operators[0].focus)}</p></div>
      </div>` : ""}
    <section class="tm-block" aria-label="Рекомендации">
      <h3 class="tm-h">${icon("route")}Что сделать</h3>
      <ol class="tm-recs">${[...x.recommendations].sort((a, b) => RISK_ORDER[a.priority] - RISK_ORDER[b.priority]).map((c) => `
        <li><span class="badge ${PRIO[c.priority][1]}">${PRIO[c.priority][0]}</span>
          <div><b>${esc(c.action)}</b><p>${esc(c.reason)}</p>${single ? "" : opChips(c.operators)}</div></li>`).join("")}</ol>
    </section>`;
}

/**
 * AI review panel. `getParams()` returns the API filters; `operator` = operator key for a personal review.
 * Shows the newest review that matches the filters, lets the user create one and lists earlier ones.
 */
export function reviewPanel(box, { getParams, operator = null, checklist = () => null, opStats = () => ({}), title }) {
  let pollT = null, alive = true, shownId = null;
  const same = (r, p) => (r.date_from || null) === (p.date_from || null) && (r.date_to || null) === (p.date_to || null)
    && (r.dataset_group || null) === (p.group || null) && Number(r.checklist_id) === Number(p.checklist_id);

  box.innerHTML = `
    <div class="card-head"><h2>${icon("bulb")}${esc(title)}</h2><div class="spacer"></div>
      <button class="btn btn-primary" type="button" data-make>${icon("refresh")}Сформировать обзор</button></div>
    <div class="card-pad tm-review" data-body aria-live="polite"></div>
    <details class="tm-hist" data-hist-wrap hidden><summary>История обзоров <span class="muted small" data-hist-n></span></summary><ul data-hist></ul></details>`;
  const body = $("[data-body]", box), make = $("[data-make]", box);

  async function refresh(openId = null) {
    clearTimeout(pollT);
    const p = getParams();
    let list = [];
    try {
      list = await api.teamReviews({ scope: operator ? "operator" : "team", operator: operator || null });
    } catch (e) { body.innerHTML = `<div class="note warn">${esc(e.message)}</div>`; return; }
    if (!alive) return;
    const match = openId ? list.find((r) => r.id === openId) : list.find((r) => same(r, p) && r.status !== "error") || list.find((r) => same(r, p));
    const hist = $("[data-hist]", box);
    $("[data-hist-wrap]", box).hidden = !list.length;
    $("[data-hist-n]", box).textContent = list.length ? `(${list.length})` : "";
    hist.innerHTML = list.map((r) => `
      <li><button type="button" class="tm-hist-row ${match && r.id === match.id ? "is-on" : ""}" data-open="${r.id}">
        <span class="tm-hist-d">${new Date(r.created_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
        <span class="tm-hist-p">${esc(periodLabel(r.date_from, r.date_to))}${r.dataset_group ? ` · ${esc(r.dataset_group)}` : ""}</span>
        <span class="tm-hist-t">${r.status === "done" ? esc(r.headline || "") : r.status === "running" ? "готовится…" : `<span class="bad">ошибка</span>`}</span>
      </button></li>`).join("");
    if (!match) {
      shownId = null;
      body.innerHTML = `<div class="tm-empty">
        <span class="tm-empty-ic">${icon("bulb")}</span>
        <div><b>Обзора за этот период ещё нет</b>
          <p>Модель изучит оценки и резюме ${operator ? "диалогов оператора" : "диалогов команды"} за выбранные даты и подготовит дашборд:
          сильные стороны, проблемы со ссылками на диалоги${operator ? "" : ", оценку каждого оператора"} и план действий. Обычно это занимает 15–60 секунд.</p></div></div>`;
      make.innerHTML = `${icon("play")}Сформировать обзор`;
      return;
    }
    shownId = match.id;
    make.innerHTML = `${icon("refresh")}${same(match, p) ? "Обновить обзор" : "Сформировать за этот период"}`;
    if (match.status === "running") {
      const full = await api.teamReview(match.id).catch(() => match);
      if (!alive) return;
      const secs = Math.round((Date.now() - new Date(full.created_at)) / 1000);
      body.innerHTML = `<div class="tm-wait"><span class="spinner"></span><div><b>Готовим ИИ-обзор…</b>
        <p class="muted small">${esc(periodLabel(full.date_from, full.date_to))} · ${full.stats?.evaluated ?? "—"} ${plural(full.stats?.evaluated ?? 0, DLG)} · прошло ${secs} с</p></div></div>`;
      make.disabled = true;
      pollT = setTimeout(() => refresh(openId), 2500);
      return;
    }
    make.disabled = false;
    if (match.status === "error") {
      body.innerHTML = `<div class="note warn">${icon("alert")} Не удалось подготовить обзор: ${esc(match.error || "ошибка")}. Попробуйте ещё раз.</div>`;
      return;
    }
    const full = await api.teamReview(match.id);
    if (!alive || shownId !== match.id) return;
    body.innerHTML = (!same(full, p) ? `<div class="note">${icon("info")} Показан обзор ${esc(periodLabel(full.date_from, full.date_to))}${full.dataset_group ? `, набор ${esc(full.dataset_group)}` : ""} — фильтры сейчас другие.</div>` : "")
      + renderReview(full, { checklist: checklist(), opStats: opStats(), single: !!operator });
  }

  make.addEventListener("click", async () => {
    busy(make, true, "Запускаем…");
    try {
      const r = await api.createTeamReview({ ...getParams(), operator: operator || null });
      busy(make, false);
      await refresh(r.id);
    } catch (e) {
      busy(make, false);
      toast(e.message, true);
    }
  });
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open]");
    if (b) refresh(Number(b.dataset.open));
  });

  return { refresh: () => refresh(), stop: () => { alive = false; clearTimeout(pollT); } };
}
