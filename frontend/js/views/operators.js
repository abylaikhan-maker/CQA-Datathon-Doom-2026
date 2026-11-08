// «Операторы»: team leaderboard + skills matrix (#/operators) and one operator's dashboard
// (#/operators/:key): scores vs the team, criteria, score per dialog, repeated mistakes,
// the personal AI review and the list of the operator's dialogs.
import { api } from "../api.js";
import { esc, $, fmtNum, scoreClass, plural, icon, pct, LANG, CHANNEL } from "../util.js";
import { DLG, NONE, readFilters, filterBar, apiParams, periodLabel, opHref, cardHref, reviewPanel, dayColumns, pill, delta, fmtDay } from "./team-common.js";

export async function render(root, params, query) {
  const [groups, checklists] = await Promise.all([api.groups(), api.checklists()]);
  if (!root.isConnected) return;
  return params.id ? detail(root, params.id, query, groups, checklists) : list(root, query, groups, checklists);
}

const clickRows = (root) => root.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-href]");
  if (tr && !e.target.closest("a, button")) location.hash = tr.dataset.href;
});

/* ----------------------------------------------------------------- list ---- */

async function list(root, query, groups, checklists) {
  const f = readFilters(query);
  root.innerHTML = `<div class="tm-page">
    <header class="page-head">
      <div><h1>Операторы</h1>
        <div class="sub">Работа каждого оператора по его диалогам за период: средний итог, грубые ошибки, апелляции и выполнение каждого критерия. Строка открывает дашборд оператора.</div></div>
      <div class="spacer"></div>
      <div class="page-actions"><a class="btn" href="#/ai-review">${icon("bulb")}ИИ-обзор команды</a></div>
    </header>
    <div id="tm-filter"></div>
    <div id="op-body"><div class="skel-kpis">${'<div class="skel"></div>'.repeat(5)}</div></div>
  </div>`;
  clickRows(root);

  let seq = 0, sort = { k: "avg", dir: -1 };
  let data = null;
  async function load() {
    const my = ++seq;
    $("#op-body", root).style.opacity = ".55";
    try {
      data = await api.teamOperators(apiParams(f));
    } catch (e) {
      $("#op-body", root).innerHTML = `<div class="note warn">${esc(e.message)}</div>`;
      return;
    } finally { $("#op-body", root).style.opacity = ""; }
    if (my !== seq || !root.isConnected) return;
    draw();
  }

  function draw() {
    const t = data.team, cl = data.checklist;
    const body = $("#op-body", root);
    if (!t.dialogs) {
      body.innerHTML = `<div class="card empty-state"><div class="ic">${icon("inbox")}</div><h3>За период нет диалогов</h3><p>Выберите другой период или набор.</p></div>`;
      return;
    }
    const named = data.operators.filter((o) => !o.unknown);
    const ranked = named.filter((o) => o.avg !== null);
    const best = ranked[0], worst = ranked[ranked.length - 1];
    const unknown = data.operators.find((o) => o.unknown);
    const val = (o, k) => (k === "name" ? o.name : k === "weak" ? (o.weakest[0]?.pct ?? 999) : o[k] ?? -1);
    const rows = sort.k === "avg" && sort.dir < 0 ? [...data.operators] : [...data.operators].sort((a, b) => (a.unknown - b.unknown) || (sort.k === "name"
      ? sort.dir * a.name.localeCompare(b.name, "ru") : sort.dir * (val(a, sort.k) - val(b, sort.k))));
    const th = (k, label, cls = "") => `<th class="${cls}" aria-sort="${sort.k === k ? (sort.dir > 0 ? "ascending" : "descending") : "none"}">
      <button type="button" class="th-sort" data-sort="${k}">${label}${sort.k === k ? icon(sort.dir > 0 ? "up" : "down") : ""}</button></th>`;
    const crits = cl.criteria;

    body.innerHTML = `
      <div class="kpis tm-kpis">
        <div class="card kpi"><span class="lbl">${icon("star")}Операторов</span><span class="v">${named.length}</span>
          <span class="foot">${esc(periodLabel(f.from, f.to))}</span></div>
        <div class="card kpi ${scoreClass(t.avg) === "hi" ? "is-good" : scoreClass(t.avg) === "mid" ? "is-warn" : scoreClass(t.avg) === "lo" ? "is-bad" : ""}">
          <span class="lbl">${icon("score")}Средний итог команды</span><span class="v">${fmtNum(t.avg, 1)}<small> / 100</small></span>
          <span class="foot">${t.evaluated} ${plural(t.evaluated, ["оценённый диалог", "оценённых диалога", "оценённых диалогов"])}</span></div>
        ${best ? `<a class="card kpi is-good" href="${opHref(best.key)}"><span class="lbl">${icon("up")}Лучший итог</span><span class="v tm-kpi-name">${esc(best.name)}</span>
          <span class="foot">${fmtNum(best.avg, 1)} · ${best.evaluated} ${plural(best.evaluated, DLG)}</span></a>` : ""}
        ${worst && worst !== best ? `<a class="card kpi ${scoreClass(worst.avg) === "lo" ? "is-bad" : "is-warn"}" href="${opHref(worst.key)}"><span class="lbl">${icon("down")}Нужна поддержка</span><span class="v tm-kpi-name">${esc(worst.name)}</span>
          <span class="foot">${fmtNum(worst.avg, 1)} · ${worst.evaluated} ${plural(worst.evaluated, DLG)}${worst.critical ? ` · грубых: ${worst.critical}` : ""}</span></a>` : ""}
        <div class="card kpi ${t.critical ? "is-bad" : ""}"><span class="lbl">${icon("alert")}Грубые ошибки</span><span class="v">${t.critical}</span>
          <span class="foot">у ${new Set(data.operators.filter((o) => o.critical).map((o) => o.key)).size} ${plural(data.operators.filter((o) => o.critical).length, ["оператора", "операторов", "операторов"])}</span></div>
      </div>
      ${unknown ? `<p class="tm-note muted small">${icon("info")}${unknown.dialogs} ${plural(unknown.dialogs, DLG)} без имени оператора (нет поля operator, а оператор не представился или имя скрыто) — они собраны в строку «Не указан» и не участвуют в рейтинге.</p>` : ""}

      <section class="card">
        <div class="card-head"><h2>Рейтинг операторов</h2><span class="muted small">команда: ${fmtNum(t.avg, 1)}</span></div>
        <div class="table-wrap" style="max-height:none">
          <table class="table tm-board">
            <thead><tr><th class="num">#</th>${th("name", "Оператор")}${th("dialogs", "Диалогов", "num")}${th("avg", "Средний итог", "num").replace("<th ", '<th title="Рейтинг: сначала операторы без грубых ошибок, затем по среднему итогу" ')}
              <th class="num col-opt">К команде</th>${th("min", "Мин.", "num col-opt")}${th("critical", "Грубые", "num")}${th("low", "Ниже 65", "num col-opt")}
              ${th("changed_appeals", "Апелляции", "num col-opt")}${th("weak", "Слабое место", "col-opt")}</tr></thead>
            <tbody>${rows.map((o) => `
              <tr class="click ${o.unknown ? "is-unknown" : ""}" data-href="${opHref(o.key)}">
                <td class="num muted">${o.unknown || o.avg === null ? "" : ranked.indexOf(o) + 1}</td>
                <td><a href="${opHref(o.key)}"><b>${esc(o.name)}</b></a><small class="tm-sub">${Object.keys(o.languages).join(" · ")} · последний ${esc(fmtDay(o.last_day))}</small></td>
                <td class="num">${o.dialogs}${o.evaluated < o.dialogs ? `<small class="tm-sub">оценено ${o.evaluated}</small>` : ""}</td>
                <td class="num"><span class="tm-scorebar"><i class="${scoreClass(o.avg)}" style="width:${o.avg ?? 0}%"></i></span>${pill(o.avg)}</td>
                <td class="num col-opt">${o.unknown ? "" : delta(o.delta)}</td>
                <td class="num col-opt">${pill(o.min)}</td>
                <td class="num">${o.critical ? `<span class="badge no">${o.critical}</span>` : `<span class="muted">0</span>`}</td>
                <td class="num col-opt">${o.low}</td>
                <td class="num col-opt" title="Подано / изменено по апелляции">${o.appeals ? `${o.appeals} / ${o.changed_appeals}` : `<span class="muted">—</span>`}</td>
                <td class="small col-opt">${o.weakest[0] ? `${esc(o.weakest[0].code || "")} ${esc(o.weakest[0].title)} <span class="muted">${fmtNum(o.weakest[0].pct, 0)}%</span>` : `<span class="muted">—</span>`}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </section>

      <section class="card" style="margin-top:16px">
        <div class="card-head"><h2>Матрица навыков</h2><span class="muted small">доля набранных баллов по критерию; для грубых нарушений — число случаев</span><div class="spacer"></div>
          <div class="legend"><span><i style="background:var(--good-bg);box-shadow:inset 0 0 0 1px var(--good)"></i>от 85%</span><span><i style="background:var(--warn-bg);box-shadow:inset 0 0 0 1px var(--warn)"></i>65–84%</span><span><i style="background:var(--bad-bg);box-shadow:inset 0 0 0 1px var(--bad)"></i>ниже 65%</span></div></div>
        <div class="table-wrap" style="max-height:none">
          <table class="table tm-matrix">
            <thead><tr><th>Оператор</th>${crits.map((c) => `<th class="num" title="${esc(c.title)}"><span class="tm-mx-h">${esc(c.code || c.id)}<small>${esc(c.title)}</small></span></th>`).join("")}</tr></thead>
            <tbody>
              ${rows.map((o) => `<tr class="click ${o.unknown ? "is-unknown" : ""}" data-href="${opHref(o.key)}"><td><b>${esc(o.name)}</b></td>${crits.map((c) => cell(o.criteria[c.id], c, o.name)).join("")}</tr>`).join("")}
              <tr class="tm-mx-team"><td><b>Команда</b></td>${crits.map((c) => cell(t.criteria[c.id], c, "Команда")).join("")}</tr>
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function cell(v, c, who) {
    if (!v || !v.n) return `<td class="num tm-mx is-empty" title="${esc(`${who} · ${c.title}: не применимо`)}">—</td>`;
    if (c.type === "critical") {
      return `<td class="num tm-mx ${v.violations ? "lo" : "hi"}" title="${esc(`${who} · ${c.title}: ${v.violations} из ${v.n}`)}">${v.violations ? `${icon("alert")}${v.violations}` : "0"}</td>`;
    }
    return `<td class="num tm-mx ${scoreClass(v.pct)}" title="${esc(`${who} · ${c.title}: ${fmtNum(v.pct, 1)}% от максимума, баллы потеряны в ${v.fails} из ${v.n}`)}">${fmtNum(v.pct, 0)}</td>`;
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b || !data) return;
    const k = b.dataset.sort;
    sort = sort.k === k ? { k, dir: -sort.dir } : { k, dir: k === "name" || k === "weak" ? 1 : -1 };
    draw();
  });
  filterBar($("#tm-filter", root), f, { groups, checklists }, () => load());
  await load();
}

/* --------------------------------------------------------------- detail ---- */

async function detail(root, key, query, groups, checklists) {
  const f = readFilters(query);
  root.innerHTML = `<div class="tm-page">
    <a class="back-link tm-back" href="#/operators">${icon("back")}Все операторы</a>
    <header class="page-head">
      <div><h1 id="op-name">${esc(key === NONE ? "Не указан" : key)}</h1><div class="sub" id="op-sub">Работа оператора по его диалогам за период.</div></div>
      <div class="spacer"></div>
      <div class="page-actions"><label class="field">Другой оператор<select class="input" id="op-switch"><option>${esc(key === NONE ? "Не указан" : key)}</option></select></label></div>
    </header>
    <div id="tm-filter"></div>
    <div id="op-body"><div class="skel-kpis">${'<div class="skel"></div>'.repeat(6)}</div></div>
    <section class="card tm-review-card" id="op-review" aria-label="ИИ-разбор оператора" ${key === NONE ? "hidden" : ""}></section>
    <div id="op-dialogs"></div>
  </div>`;
  clickRows(root);
  let data = null;
  const panel = key === NONE ? null : reviewPanel($("#op-review", root), {
    title: "ИИ-разбор оператора", operator: key, getParams: () => apiParams(f), checklist: () => data?.checklist,
  });
  $("#op-switch", root).addEventListener("change", (e) => { if (e.target.value) location.hash = opHref(e.target.value); });

  let seq = 0;
  async function load() {
    const my = ++seq;
    $("#op-body", root).style.opacity = ".55";
    try {
      data = await api.teamOperator(key, apiParams(f));
    } catch (e) {
      if (my !== seq) return;
      $("#op-body", root).innerHTML = `<div class="card empty-state"><div class="ic">${icon("inbox")}</div><h3>${esc(e.message)}</h3>
        <p>Выберите другой период — или вернитесь к <a href="#/operators">списку операторов</a>.</p></div>`;
      $("#op-dialogs", root).innerHTML = "";
      $("#op-review", root).hidden = true;
      return;
    } finally { $("#op-body", root).style.opacity = ""; }
    if (my !== seq || !root.isConnected) return;
    $("#op-review", root).hidden = key === NONE;
    draw();
    panel?.refresh();
  }

  function draw() {
    const s = data.stats, t = data.team, cl = data.checklist, op = data.operator;
    $("#op-switch", root).innerHTML = `<option value="">${esc(op.name)}</option>` + data.others.map((o) => `<option value="${esc(o.key)}">${esc(o.name)}</option>`).join("");
    $("#op-sub", root).innerHTML = `${op.rank ? `<b>${op.rank}-е место</b> из ${op.ranked} по среднему итогу · ` : ""}${s.dialogs} ${plural(s.dialogs, DLG)} ${esc(periodLabel(f.from, f.to))} · ${Object.entries(s.languages).map(([k, n]) => `${esc(LANG[k] || k)} ${n}`).join(", ")}${op.unknown ? " · диалоги без имени оператора, рейтинг не считается" : ""}`;
    const sc = scoreClass(s.avg);
    const fails = cl.criteria.map((c) => ({ c, n: data.dialogs.filter((d) => d.failed.some((x) => x.id === c.id)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n);

    $("#op-body", root).innerHTML = `
      <div class="kpis tm-kpis">
        <div class="card kpi ${sc === "hi" ? "is-good" : sc === "mid" ? "is-warn" : sc === "lo" ? "is-bad" : ""}"><span class="lbl">${icon("score")}Средний итог</span>
          <span class="v">${fmtNum(s.avg, 1)}<small> / 100</small></span><span class="foot">команда ${fmtNum(t.avg, 1)} · ${delta(s.avg !== null && t.avg !== null ? s.avg - t.avg : null)}</span></div>
        <div class="card kpi"><span class="lbl">${icon("chat")}Диалогов</span><span class="v">${s.dialogs}</span>
          <span class="foot">оценено ${s.evaluated} · ${fmtNum(pct(s.dialogs, t.dialogs), 0)}% нагрузки команды</span></div>
        <div class="card kpi"><span class="lbl">${icon("target")}Разброс</span><span class="v">${fmtNum(s.min, 0)}–${fmtNum(s.max, 0)}</span>
          <span class="foot">медиана ${fmtNum(s.median, 1)}</span></div>
        <div class="card kpi ${s.critical ? "is-bad" : ""}"><span class="lbl">${icon("alert")}Грубые ошибки</span><span class="v">${s.critical}</span>
          <span class="foot">${s.evaluated ? `${fmtNum(pct(s.critical, s.evaluated), 0)}% · у команды ${fmtNum(pct(t.critical, t.evaluated), 0)}%` : "—"}</span></div>
        <div class="card kpi ${s.low ? "is-warn" : ""}"><span class="lbl">${icon("down")}Ниже 65</span><span class="v">${s.low}</span>
          <span class="foot">${s.high} ${plural(s.high, DLG)} от 85</span></div>
        <div class="card kpi ${s.reg_conflicts ? "is-bad" : ""}"><span class="lbl">${icon("scale")}Апелляции · регламент</span><span class="v">${s.appeals}<small> / ${s.reg_conflicts}</small></span>
          <span class="foot">изменено ${s.changed_appeals} · расхождений с регламентом ${s.reg_conflicts}</span></div>
      </div>

      <div class="tm-grid">
        <section class="card card-pad">
          <div class="card-title">Критерии: оператор и команда <span class="muted small">доля набранных баллов</span></div>
          <div class="legend"><span><i style="background:var(--brand-600)"></i>${esc(op.name)}</span><span><i style="background:var(--na-mark)"></i>Команда</span></div>
          <div class="tm-pairs">${cl.criteria.map((c) => {
            const a = s.criteria[c.id], b = t.criteria[c.id];
            if (c.type === "critical") {
              return `<div class="tm-pair is-flag"><span class="tm-pair-l"><b>${esc(c.code || "")} ${esc(c.title)}</b><small>грубое нарушение</small></span>
                <span class="tm-pair-flag ${a?.violations ? "bad" : ""}">${a?.violations ? `${icon("alert")}${a.violations} ${plural(a.violations, ["случай", "случая", "случаев"])}` : `${icon("check")}не выявлено`}</span>
                <span class="muted small">команда: ${b?.violations || 0}</span></div>`;
            }
            const dv = a?.pct !== null && a?.pct !== undefined && b?.pct !== null ? a.pct - b.pct : null;
            return `<div class="tm-pair" title="${esc(`${c.title}\n${op.name}: ${fmtNum(a?.pct, 1)}% (потеря баллов в ${a?.fails ?? 0} из ${a?.n ?? 0})\nКоманда: ${fmtNum(b?.pct, 1)}%`)}">
              <span class="tm-pair-l"><b>${esc(c.code || "")} ${esc(c.title)}</b><small>${a?.n ? `баллы потеряны в ${a.fails} из ${a.n}` : "не применимо"}</small></span>
              <span class="tm-pair-bars"><i class="me" style="width:${a?.pct ?? 0}%"></i><i class="team" style="width:${b?.pct ?? 0}%"></i></span>
              <span class="tm-pair-v"><b>${a?.pct !== null && a?.pct !== undefined ? `${fmtNum(a.pct, 0)}%` : "—"}</b>${dv !== null ? delta(dv, "") : ""}</span>
            </div>`;
          }).join("")}</div>
        </section>
        <section class="card card-pad">
          <div class="card-title">Итог по диалогам <span class="muted small">по дате, столбец открывает разбор</span></div>
          ${dialogColumns(data.dialogs)}
          <div class="card-title" style="margin-top:18px">Повторяющиеся ошибки</div>
          ${fails.length ? `<ul class="tm-fails">${fails.map(({ c, n }) => `
            <li><span><b>${esc(c.code || "")} ${esc(c.title)}</b></span>
              <span class="tm-fail-bar"><i style="width:${(n / Math.max(1, s.evaluated)) * 100}%" class="${c.type === "critical" ? "lo" : ""}"></i></span>
              <b class="num">${n}<small> из ${s.evaluated}</small></b></li>`).join("")}</ul>`
            : `<div class="ov-ok">${icon("check")}<div><b>Без потерь баллов</b><span>Во всех оценённых диалогах критерии выполнены.</span></div></div>`}
        </section>
      </div>
      ${data.days.length > 1 ? `<section class="card card-pad" style="margin-bottom:16px"><div class="card-title">Средний итог по дням</div>${dayColumns(data.days)}</section>` : ""}`;

    $("#op-dialogs", root).innerHTML = `
      <section class="card" style="margin-top:16px">
        <div class="card-head"><h2>Диалоги оператора</h2><span class="muted small">${data.dialogs.length}</span></div>
        <div class="table-wrap" style="max-height:none">
          <table class="table tm-dlg">
            <thead><tr><th>Дата</th><th>Диалог</th><th class="num">Итог</th><th>Где потеряны баллы</th><th class="col-opt">Резюме оценки</th></tr></thead>
            <tbody>${data.dialogs.map((d) => `
              <tr class="click" data-href="${cardHref(d)}">
                <td class="small">${esc(fmtDay(d.day, true))}</td>
                <td><a class="mono" href="${cardHref(d)}">${esc(d.id)}</a><small class="tm-sub">${esc(CHANNEL[d.channel] || d.channel || "")} · ${esc(d.language || "")}${d.appeals ? ` · апелляций ${d.appeals}` : ""}${d.reg_conflicts ? ` · <span class="bad">регламент: ${d.reg_conflicts}</span>` : ""}</small></td>
                <td class="num">${d.eval_id ? pill(d.total) : `<span class="muted small">не оценён</span>`}${d.critical ? `<small class="tm-sub bad">грубая ошибка</small>` : ""}</td>
                <td>${d.failed.length ? `<span class="tm-refs">${d.failed.map((x) => `<span class="badge ${x.critical ? "crit" : "outline"}" title="${esc(`${x.title}${x.explanation ? `: ${x.explanation}` : ""}`)}">${esc(x.code || x.id)}</span>`).join("")}</span>` : d.eval_id ? `<span class="badge yes">все выполнены</span>` : ""}</td>
                <td class="small col-opt tm-summary">${esc(d.summary || "")}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>
      </section>`;
  }

  filterBar($("#tm-filter", root), f, { groups, checklists }, () => load());
  await load();
  return () => panel?.stop();
}

function dialogColumns(dialogs) {
  const ev = dialogs.filter((d) => d.total !== null && d.total !== undefined);
  if (!ev.length) return `<div class="muted small">Нет оценённых диалогов</div>`;
  return `<div class="tm-cols tm-cols-dlg" role="img" aria-label="${esc(ev.map((d) => `${d.id}: ${fmtNum(d.total, 0)}`).join("; "))}">
    <div class="tm-cols-grid" aria-hidden="true"><span style="bottom:100%">100</span><span style="bottom:85%">85</span><span style="bottom:65%">65</span><span style="bottom:0">0</span></div>
    ${ev.map((d) => {
      const h = Math.max(2, Number(d.total));
      return `<a class="tm-col" href="${cardHref(d)}" title="${esc(`${d.id} · ${fmtDay(d.day, true)}\nИтог: ${fmtNum(d.total, 1)}${d.critical ? "\nГрубая ошибка" : ""}${d.failed.length ? `\nПотеряны баллы: ${d.failed.map((x) => x.code).join(", ")}` : ""}`)}">
        <i class="${d.critical ? "lo crit" : scoreClass(d.total)}" style="height:${h}%"></i>
        ${ev.length <= 24 ? `<b style="bottom:calc(${h}% + 3px)">${fmtNum(d.total, 0)}</b>` : ""}
      </a>`;
    }).join("")}
  </div>`;
}
