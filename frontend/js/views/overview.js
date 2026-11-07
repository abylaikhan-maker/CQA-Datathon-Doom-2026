// «Обзор» (was «Аналитика»): counters, statuses, what needs attention, averages by language,
// score distribution and results per criterion. Every number links to «Диалоги» with that
// filter applied. The «С чего начать» guide lives here too.
import { api } from "../api.js";
import { esc, $, fmtNum, scoreClass, plural, icon, pct } from "../util.js";
import { charts, median } from "./analytics.js";

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const seen = (k) => store.get(`cqa.seen.${k}`) === "1";
const DLG = ["диалог", "диалога", "диалогов"];
const isNew = (r) => !r.eval_id || r.status === "error";
const cardHref = (r) => `#/conversation/${encodeURIComponent(r.id)}${r.eval_id ? `?eval=${r.eval_id}` : ""}`;
/** Link to «Диалоги» with filters (keys understood by views/conversations.js). */
const dlg = (q = {}) => {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== "" && v != null));
  return `#/conversations${p.size ? `?${p}` : ""}`;
};

export async function render(root) {
  const [groups, checklists, meta] = await Promise.all([api.groups(), api.checklists(), api.meta().catch(() => null)]);
  if (!root.isConnected) return;
  let group = store.get("cqa.group") || "";
  if (group && !groups.some((g) => g.id === group)) group = "";
  let kid = Number(store.get("cqa.checklist")) || null;
  if (!checklists.some((c) => c.id === kid)) kid = (checklists.find((c) => c.is_active) || checklists[0])?.id ?? null;

  root.innerHTML = `<div class="ov-page">
    <header class="page-head">
      <div><h1>Обзор</h1>
        <div class="sub">Последняя оценка каждого диалога выбранной версией чек-листа, с учётом решений по апелляциям. Любая цифра открывает «Диалоги» с этим фильтром.</div></div>
      <div class="spacer"></div>
      <div class="page-actions ov-pick">
        <label class="field">Набор<select class="input" id="ov-group">
          <option value="">Все наборы</option>
          ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === group ? "selected" : ""}>${esc(g.id)} (${g.count})</option>`).join("")}
        </select></label>
        <label class="field">Чек-лист<select class="input" id="ov-checklist">
          ${checklists.map((c) => `<option value="${c.id}" ${c.id === kid ? "selected" : ""}>v${c.version} · ${esc(c.name)}${c.is_active ? " · активный" : ""}</option>`).join("")}
        </select></label>
        <a class="btn" id="ov-export" download>${icon("download")}Экспорт CSV</a>
      </div>
    </header>
    <div id="ov-guide"></div>
    <div id="ov-body"><div class="skel-kpis">${'<div class="skel"></div>'.repeat(6)}</div></div>
  </div>`;

  $("#ov-group", root).addEventListener("change", (e) => { group = e.target.value; store.set("cqa.group", group); load(); });
  $("#ov-checklist", root).addEventListener("change", (e) => { kid = Number(e.target.value); store.set("cqa.checklist", String(kid)); load(); });

  let seq = 0;
  async function load() {
    const my = ++seq;
    const params = { group: group || null, checklist_id: kid };
    $("#ov-export", root).href = api.exportUrl(params);
    $("#ov-body", root).style.opacity = ".55";
    const [stats, rows, checklist, rules] = await Promise.all([
      api.stats(params),
      api.conversations({ ...params, include_criteria: true }),
      kid ? api.checklist(kid) : null,
      kid ? api.ruleSuggestions(kid).catch(() => null) : null,
    ]);
    if (my !== seq || !root.isConnected) return;
    $("#ov-body", root).style.opacity = "";
    draw(rows, checklist, rules, stats);
    drawGuide(root, rows, groups);
  }

  function draw(rows, checklist, rules, s) {
    const body = $("#ov-body", root);
    if (!rows.length) {
      body.innerHTML = `<div class="card empty-state"><div class="ic">${icon("inbox")}</div>
        <h3>${group ? `В наборе ${esc(group)} нет диалогов` : "Диалогов пока нет"}</h3>
        <p>Импортируйте набор из API организаторов или загрузите файл с транскриптами.</p>
        <a class="btn btn-primary" href="${dlg({ do: "import" })}">${icon("cloud")}Импорт из API</a></div>`;
      return;
    }
    const n = rows.length;
    const done = rows.filter((r) => r.status === "done" && r.final_total !== null);
    const running = rows.filter((r) => r.eval_id && !["done", "error"].includes(r.status));
    const errors = rows.filter((r) => r.status === "error");
    const none = rows.filter((r) => !r.eval_id);
    const crit = done.filter((r) => r.final_critical === "true");
    const low = done.filter((r) => Number(r.final_total) < 65);
    const openAp = rows.reduce((t, r) => t + Number(r.open_appeals || 0), 0);
    const withAp = rows.filter((r) => Number(r.appeals) > 0).length;
    const avg = done.length ? done.reduce((t, r) => t + Number(r.final_total || 0), 0) / done.length : null;
    const med = median(done.map((r) => Number(r.final_total)));
    const sc = scoreClass(avg);
    const ap = s.appeals || { open: 0, changed: 0, confirmed: 0 };
    const readyRules = (rules?.items || []).filter((it) => it.case_count >= rules.minimum_cases).length;
    const evalPct = pct(done.length, n);

    const statuses = [
      { k: "done", label: "Оценены", n: done.length, href: dlg({ status: "done" }), cls: "s-done" },
      { k: "none", label: "Не оценены", n: none.length, href: dlg({ status: "none" }), cls: "s-none" },
      { k: "run", label: "Оцениваются", n: running.length, href: dlg(), cls: "s-run" },
      { k: "error", label: "Ошибка оценки", n: errors.length, href: dlg({ status: "error" }), cls: "s-error" },
    ].filter((x) => x.n || x.k === "done" || x.k === "none");

    const attention = [
      { n: crit.length, text: `${plural(crit.length, DLG)} с грубой ошибкой`, href: dlg({ crit: "violation" }), tone: "bad", ic: "alert" },
      { n: openAp, text: plural(openAp, ["апелляция ждёт решения", "апелляции ждут решения", "апелляций ждут решения"]), href: "#/appeals", tone: "warn", ic: "scale" },
      { n: low.length, text: `${plural(low.length, DLG)} с итогом ниже 65`, href: dlg({ band: "lo" }), tone: "bad", ic: "score" },
      { n: errors.length, text: `${plural(errors.length, DLG)} с ошибкой оценки`, href: dlg({ status: "error" }), tone: "bad", ic: "alert", act: "Повторить" },
      { n: none.length, text: `${plural(none.length, DLG)} ещё не ${none.length === 1 ? "оценён" : "оценены"}`, href: dlg({ status: "none", do: "eval" }), tone: "", ic: "play", act: "Оценить" },
      { n: readyRules, text: plural(readyRules, ["критерий готов к уточнению правила", "критерия готовы к уточнению правила", "критериев готовы к уточнению правила"]), href: `#/rules?v=${kid}`, tone: "brand", ic: "refresh" },
    ].filter((x) => x.n);

    body.innerHTML = `
      <div class="kpis ov-kpis">
        <a class="card kpi" href="${dlg({ status: "none" })}" title="Показать неоценённые"><span class="lbl">${icon("done")}Оценено</span>
          <span class="v">${done.length}<small> / ${n}</small></span>
          <span class="meter" title="${fmtNum(evalPct, 0)}% диалогов оценено"><i style="width:${evalPct ?? 0}%"></i></span></a>
        <div class="card kpi ${sc === "hi" ? "is-good" : sc === "mid" ? "is-warn" : sc === "lo" ? "is-bad" : ""}"><span class="lbl">${icon("score")}Средний итог</span>
          <span class="v">${fmtNum(avg)}<small> / 100</small></span><span class="foot">${med !== null ? `медиана ${fmtNum(med)}` : "нет оценок"}</span></div>
        <a class="card kpi ${crit.length ? "is-bad" : ""}" href="${dlg({ crit: "violation" })}" title="Показать диалоги с грубой ошибкой"><span class="lbl">${icon("alert")}Грубые ошибки</span>
          <span class="v">${crit.length}</span><span class="foot">${done.length ? `${fmtNum(pct(crit.length, done.length), 0)}% оценённых` : "оцените диалоги"}</span></a>
        <a class="card kpi ${openAp ? "is-warn" : ""}" href="#/appeals"><span class="lbl">${icon("scale")}Открытые апелляции</span>
          <span class="v">${openAp}</span><span class="foot meta-list" title="По всем наборам и версиям"><span>изменено ${ap.changed}</span><span>подтверждено ${ap.confirmed}</span></span></a>
        <div class="card kpi"><span class="lbl">${icon("coin")}Стоимость оценки</span>
          <span class="v">${s.avg_cost_usd != null ? `$${fmtNum(s.avg_cost_usd, 4)}` : "—"}</span>
          <span class="foot">${s.avg_cost_usd != null ? `≈ $${fmtNum(s.avg_cost_usd * s.evaluated, 3)} за ${s.evaluated} ${plural(s.evaluated, DLG)}` : "нет данных"}</span></div>
        <div class="card kpi"><span class="lbl">${icon("clock")}Время оценки</span>
          <span class="v">${s.avg_duration_ms ? fmtNum(s.avg_duration_ms / 1000, 1) : "—"}<small> с</small></span>
          <span class="foot">${meta?.model ? `модель ${esc(meta.model)}` : "в среднем на диалог"}</span></div>
      </div>

      <div class="ov-grid">
        <section class="card card-pad ov-status" aria-labelledby="ov-st-h">
          <h2 class="card-title" id="ov-st-h">Статусы диалогов <span class="muted small">${n} ${plural(n, DLG)}${group ? ` в наборе ${esc(group)}` : ""}</span></h2>
          <div class="ov-stack" role="img" aria-label="${esc(statuses.map((x) => `${x.label}: ${x.n}`).join(", "))}">
            ${statuses.filter((x) => x.n).map((x) => `<i class="${x.cls}" style="flex:${x.n}" title="${esc(x.label)}: ${x.n}"></i>`).join("")}
          </div>
          <ul class="ov-list">
            ${statuses.map((x) => `<li><a href="${x.href}"><span class="ov-dot ${x.cls}"></span><span class="ov-l">${esc(x.label)}</span>
              <b>${x.n}</b><span class="ov-pct">${fmtNum(pct(x.n, n), 0)}%</span>${icon("chev")}</a></li>`).join("")}
            <li><a href="${dlg({ status: "appeal" })}"><span class="ov-dot s-ap"></span><span class="ov-l">С апелляцией</span><b>${withAp}</b><span class="ov-pct">${fmtNum(pct(withAp, n), 0)}%</span>${icon("chev")}</a></li>
          </ul>
        </section>

        <section class="card card-pad ov-attn" aria-labelledby="ov-at-h">
          <h2 class="card-title" id="ov-at-h">Требует внимания</h2>
          ${attention.length ? `<ul class="ov-attn-list">${attention.map((a) => `
            <li class="is-${a.tone || "plain"}"><a href="${a.href}">
              <span class="ov-attn-ic">${icon(a.ic)}</span>
              <span class="ov-attn-t"><b>${a.n}</b> ${esc(a.text)}</span>
              <span class="ov-attn-go">${a.act || "Открыть"}${icon("chev")}</span></a></li>`).join("")}</ul>`
            : `<div class="ov-ok">${icon("check")}<div><b>Всё спокойно</b><span>Нет грубых ошибок, открытых апелляций и неоценённых диалогов.</span></div></div>`}
        </section>
      </div>
      ${done.length ? charts(s, rows, done, checklist?.config || { criteria: [], sections: [] }, checklist) : `
        <div class="card empty-state"><div class="ic">${icon("score")}</div>
          <h3>Пока нет оценок по этой версии чек-листа</h3>
          <p>Запустите оценку — здесь появятся средний итог по языкам, распределение баллов и результаты по каждому критерию.</p>
          <a class="btn btn-primary" href="${dlg({ status: "none", do: "eval" })}">${icon("play")}Оценить диалоги</a></div>`}`;
    body.onclick = (e) => {
      const tr = e.target.closest("tr[data-href]");
      if (tr && !e.target.closest("a")) location.hash = tr.dataset.href;
    };
  }

  await load();
}

/* ------------------------------------------------------------ guide ---- */

let sampleCrit = { id: null, crit: undefined };

function guideSteps(rows, groups, redraw) {
  const total = groups.reduce((t, g) => t + Number(g.count || 0), 0) || rows.length;
  const done = rows.filter((r) => r.status === "done");
  const sample = [...done].sort((a, b) => Number(a.final_total) - Number(b.final_total) || a.id.localeCompare(b.id))
    .find((r) => Number(r.final_total) > 0) || done[0];
  const appeals = rows.reduce((t, r) => t + Number(r.appeals || 0), 0);
  const decided = rows.reduce((t, r) => t + Math.max(0, Number(r.appeals || 0) - Number(r.open_appeals || 0)), 0);
  const open = rows.reduce((t, r) => t + Number(r.open_appeals || 0), 0);
  const nNew = rows.filter(isNew).length;
  const card = sample ? cardHref(sample) : null;
  if (sample && sampleCrit.id !== sample.eval_id) loadSampleCrit(sample, redraw);
  const critHref = card && sampleCrit.id === sample?.eval_id && sampleCrit.crit
    ? `${card}${card.includes("?") ? "&" : "?"}crit=${encodeURIComponent(sampleCrit.crit)}` : card;
  const steps = [
    { ok: total > 0, t: "Загрузите диалоги", d: "Из API организаторов или файлом JSON", act: { href: dlg({ do: "import" }), label: "Импорт из API" } },
    { ok: done.length > 0, t: "Запустите оценку", d: "Модель проверит каждый диалог по чек-листу", act: { href: dlg({ status: "none", do: "eval" }), label: nNew ? `Оценить новые (${nNew})` : "Оценить новые" }, need: total > 0 },
    { ok: seen("card"), t: "Откройте разбор", d: "Баллы, объяснения и реплики-доказательства", act: { href: card, label: "Открыть разбор" } },
    { ok: appeals > 0, t: "Оспорьте оценку", d: "«Оспорить оценку» у критерия в разборе", act: { href: critHref, label: "К критериям" } },
    { ok: decided > 0, t: "Примите решение", d: "Проверяющий подтверждает или меняет ответ", act: { href: "#/appeals", label: open ? `Открытых: ${open}` : "К апелляциям" } },
    { ok: seen("accuracy"), t: "Сверьте с эталоном", d: "Насколько ответы модели совпадают с разметкой", act: { href: "#/accuracy", label: "Точность" } },
  ];
  if (steps[3].ok || steps[4].ok) steps[2].ok = true;
  return steps;
}

async function loadSampleCrit(sample, redraw) {
  sampleCrit = { id: sample.eval_id, crit: undefined };
  try {
    const ev = await api.evaluation(sample.eval_id);
    const list = ev.final_score?.criteria || ev.score?.criteria || [];
    const lost = list.find((c) => c.points !== null && c.max_points !== null && Number(c.points) < Number(c.max_points));
    if (sampleCrit.id !== sample.eval_id) return;
    sampleCrit.crit = lost ? lost.criterion_id : null;
    redraw();
  } catch { /* keep the plain link */ }
}

function drawGuide(root, rows, groups) {
  const box = $("#ov-guide", root);
  if (!box) return;
  const redraw = () => { if (box.isConnected) drawGuide(root, rows, groups); };
  const steps = guideSteps(rows, groups, redraw);
  const nDone = steps.filter((x) => x.ok).length;
  if (store.get("cqa.guide.hidden") === "1" || nDone === steps.length) {
    box.innerHTML = nDone < steps.length
      ? `<button class="btn btn-ghost btn-sm ov-guide-reopen" type="button" data-guide-show>${icon("info")}С чего начать</button>` : "";
  } else {
    const next = steps.findIndex((x) => !x.ok);
    box.innerHTML = `
      <section class="guide" aria-labelledby="guide-h">
        <div class="guide-head">
          <h2 id="guide-h">С чего начать</h2>
          <span class="guide-prog">Пройдено ${nDone} из ${steps.length}</span>
          <button class="btn btn-sm guide-x" type="button" data-guide-hide aria-label="Скрыть подсказку «С чего начать»" title="Скрыть">${icon("x")}</button>
        </div>
        <ol class="guide-steps">
          ${steps.map((x, i) => {
            const st = x.ok ? "done" : i === next ? "next" : "todo";
            const cls = `btn btn-sm ${st === "next" ? "guide-cta" : "guide-btn"}`;
            const action = x.ok ? "" : x.act.href === null || x.need === false
              ? `<button class="${cls}" type="button" disabled title="Сначала выполните предыдущие шаги">${esc(x.act.label)}</button>`
              : `<a class="${cls}" href="${esc(x.act.href)}">${esc(x.act.label)}</a>`;
            return `<li class="guide-step is-${st}" ${st === "next" ? 'aria-current="step"' : ""}>
              <span class="guide-mark" aria-hidden="true">${x.ok ? icon("check") : i + 1}</span>
              <span class="sr-only">${x.ok ? "Выполнено:" : st === "next" ? "Следующий шаг:" : ""}</span>
              <b class="guide-t">${esc(x.t)}</b><span class="guide-d">${esc(x.d)}</span>
              ${action ? `<span class="guide-act">${action}</span>` : ""}</li>`;
          }).join("")}
        </ol>
      </section>`;
  }
  box.onclick = (e) => {
    if (e.target.closest("[data-guide-hide]")) { store.set("cqa.guide.hidden", "1"); redraw(); }
    if (e.target.closest("[data-guide-show]")) { store.del("cqa.guide.hidden"); redraw(); }
  };
}
