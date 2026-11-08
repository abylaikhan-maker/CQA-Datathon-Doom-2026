// «ИИ-обзор»: dashboard of the operator team for a period — key numbers, the AI review
// (strengths, problems with dialog links, per-operator assessment, action plan) and the charts behind it.
import { api } from "../api.js";
import { esc, $, fmtNum, scoreClass, plural, icon, pct } from "../util.js";
import { DLG, readFilters, filterBar, apiParams, periodLabel, opHref, reviewPanel, dayColumns, bars } from "./team-common.js";

export async function render(root, _params, query) {
  const [groups, checklists] = await Promise.all([api.groups(), api.checklists()]);
  if (!root.isConnected) return;
  const f = readFilters(query);
  let data = null;

  root.innerHTML = `<div class="tm-page">
    <header class="page-head">
      <div><h1>ИИ-обзор команды</h1>
        <div class="sub">Выберите период — модель разберёт оценки всех диалогов за эти даты и подготовит обзор работы операторов: что получается, где просадки и что сделать.</div></div>
    </header>
    <div id="tm-filter"></div>
    <div id="tm-kpis"><div class="skel-kpis">${'<div class="skel"></div>'.repeat(6)}</div></div>
    <section class="card tm-review-card" id="tm-review" aria-label="ИИ-обзор"></section>
    <div id="tm-charts"></div>
  </div>`;

  const panel = reviewPanel($("#tm-review", root), {
    title: "ИИ-обзор",
    getParams: () => apiParams(f),
    checklist: () => data?.checklist,
    opStats: () => Object.fromEntries((data?.operators || []).map((o) => [o.name, o])),
  });

  let seq = 0;
  async function load() {
    const my = ++seq;
    $("#tm-kpis", root).style.opacity = ".55";
    try {
      data = await api.teamOperators(apiParams(f));
    } catch (e) {
      $("#tm-kpis", root).innerHTML = `<div class="note warn">${esc(e.message)}</div>`;
      return;
    } finally { $("#tm-kpis", root).style.opacity = ""; }
    if (my !== seq || !root.isConnected) return;
    drawKpis();
    drawCharts();
    panel.refresh();
  }

  function drawKpis() {
    const t = data.team, b = data.bounds;
    const sc = scoreClass(t.avg);
    $("#tm-kpis", root).innerHTML = `
      <div class="kpis tm-kpis">
        <div class="card kpi"><span class="lbl">${icon("chat")}Диалогов за период</span>
          <span class="v">${t.dialogs}</span><span class="foot">${esc(periodLabel(f.from, f.to))}</span></div>
        <div class="card kpi"><span class="lbl">${icon("done")}Оценено</span>
          <span class="v">${t.evaluated}<small> / ${t.dialogs}</small></span>
          <span class="meter"><i style="width:${pct(t.evaluated, t.dialogs) ?? 0}%"></i></span></div>
        <div class="card kpi ${sc === "hi" ? "is-good" : sc === "mid" ? "is-warn" : sc === "lo" ? "is-bad" : ""}"><span class="lbl">${icon("score")}Средний итог</span>
          <span class="v">${fmtNum(t.avg, 1)}<small> / 100</small></span><span class="foot">${t.median !== null ? `медиана ${fmtNum(t.median, 1)}` : "нет оценок"}</span></div>
        <div class="card kpi ${t.critical ? "is-bad" : ""}"><span class="lbl">${icon("alert")}Грубые ошибки</span>
          <span class="v">${t.critical}</span><span class="foot">${t.evaluated ? `${fmtNum(pct(t.critical, t.evaluated), 0)}% оценённых` : "—"}</span></div>
        <div class="card kpi ${t.low ? "is-warn" : ""}"><span class="lbl">${icon("down")}Итог ниже 65</span>
          <span class="v">${t.low}</span><span class="foot">${t.high} ${plural(t.high, DLG)} от 85 и выше</span></div>
        <a class="card kpi" href="#/operators"><span class="lbl">${icon("star")}Операторов</span>
          <span class="v">${t.operators}</span><span class="foot">${data.operators.find((o) => o.unknown) ? `${data.operators.find((o) => o.unknown).dialogs} ${plural(data.operators.find((o) => o.unknown).dialogs, DLG)} без имени` : "все диалоги с именем"}</span></a>
      </div>
      ${b.no_date ? `<p class="tm-note muted small">${icon("info")}Дата диалога берётся из поля записи (date, started_at…); у ${b.no_date} из ${b.total} ${plural(b.total, DLG)} его нет — для них используется дата импорта.
        Оператор — поле operator / agent или имя из представления в первых репликах.</p>` : ""}`;
  }

  function drawCharts() {
    const t = data.team, cl = data.checklist;
    const ops = data.operators.filter((o) => o.avg !== null);
    const crit = cl.criteria.filter((c) => c.type !== "critical" && t.criteria[c.id]?.pct !== null && t.criteria[c.id])
      .map((c) => ({ c, v: t.criteria[c.id] })).sort((a, b) => a.v.pct - b.v.pct);
    const critFlags = cl.criteria.filter((c) => c.type === "critical").map((c) => ({ c, v: t.criteria[c.id] || { violations: 0, n: 0 } }));
    $("#tm-charts", root).innerHTML = !t.evaluated ? `
      <div class="card empty-state"><div class="ic">${icon("score")}</div><h3>За период нет оценённых диалогов</h3>
        <p>Расширьте период или запустите оценку диалогов.</p><a class="btn btn-primary" href="#/conversations?status=none&do=eval">${icon("play")}Оценить диалоги</a></div>` : `
      <h2 class="tm-section">Цифры за период</h2>
      <div class="tm-grid tm-cols-2">
        <div class="tm-stack">
        <section class="card card-pad">
          <div class="card-title">Средний итог по дням <span class="muted small">${data.days.length} ${plural(data.days.length, ["день", "дня", "дней"])}</span></div>
          ${dayColumns(data.days)}
        </section>
        <section class="card card-pad">
          <div class="card-title">Выполнение критериев <span class="muted small">доля набранных баллов от максимума, слабые сверху</span></div>
          ${bars(crit.map(({ c, v }) => ({ label: `${c.code || ""} ${c.title}`, sub: `потеря баллов в ${v.fails} ${plural(v.fails, DLG)}`, value: v.pct, unit: "%", digits: 0,
            href: `#/conversations?col=${encodeURIComponent(`${c.id}:Нет`)}`, title: `${c.title}: ${fmtNum(v.pct, 1)}% от максимума; баллы потеряны в ${v.fails} из ${v.n}` })))}
        </section>
        </div>
        <div class="tm-stack">
        <section class="card card-pad">
          <div class="card-title">Грубые нарушения и апелляции</div>
          <ul class="tm-flags">
            ${critFlags.map(({ c, v }) => `<li class="${v.violations ? "is-bad" : ""}"><span>${icon(v.violations ? "alert" : "check")}<b>${esc(c.code || "")} ${esc(c.title)}</b></span><b class="num">${v.violations}</b></li>`).join("")}
            <li><span>${icon("scale")}<b>Апелляций по диалогам периода</b></span><b class="num">${t.appeals}</b></li>
            <li><span>${icon("edit")}<b>Оценка изменена по апелляции</b></span><b class="num">${t.changed_appeals}</b></li>
            <li class="${t.reg_conflicts ? "is-bad" : ""}"><span>${icon("doc")}<b>Расхождения с регламентом</b><small>проверено ${t.reg_checked} ${plural(t.reg_checked, DLG)}</small></span><b class="num">${t.reg_conflicts}</b></li>
          </ul>
          ${t.weakest.length ? `<div class="insight">${icon("bulb")}<div>Чаще всего теряют баллы: ${t.weakest.map((w) => `<b>${esc(w.code || "")} ${esc(w.title)}</b> (${fmtNum(w.pct, 0)}%)`).join(", ")}.</div></div>` : ""}
        </section>
        <section class="card card-pad">
          <div class="card-title">Средний итог по операторам <span class="muted small">строка открывает дашборд оператора</span></div>
          ${bars(ops.map((o) => ({ label: o.name, sub: `${o.evaluated} ${plural(o.evaluated, DLG)}${o.critical ? ` · грубых: ${o.critical}` : ""}`, value: o.avg, href: opHref(o.key), cls: `is-${scoreClass(o.avg)}`,
            title: `${o.name}: средний итог ${fmtNum(o.avg, 1)} по ${o.evaluated} ${plural(o.evaluated, DLG)}` })), { empty: "Нет оценённых операторов" })}
        </section>
        </div>
      </div>
      <a class="btn tm-more" href="#/operators">${icon("arrow")}Рейтинг и матрица навыков операторов</a>`;
  }

  root.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.target.closest("a")) location.hash = tr.dataset.href;
  });
  filterBar($("#tm-filter", root), f, { groups, checklists }, () => load());
  await load();
  return () => panel.stop();
}
