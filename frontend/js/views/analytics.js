import { api } from "../api.js";
import { esc, fmtNum, LANG, plural, icon } from "../util.js";

const LANG_ORDER = ["RU", "KZ", "EN"];
// Chart helpers for «Обзор» (views/overview.js). Links open «Диалоги» with the matching filter.
const dlgLink = (q) => `#/conversations?${new URLSearchParams(q)}`;

export function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function hbars(entries, labelOf) {
  if (!entries.length) return `<div class="muted small">Нет данных</div>`;
  return `
    ${entries.map(([k, v]) => {
      const { label, sub } = labelOf(k);
      return `
      <a class="hbar" href="${dlgLink({ lang: k })}" title="${esc(`${sub || label}: ${v.n} ${plural(v.n, ["диалог", "диалога", "диалогов"])}, средний итог ${fmtNum(v.avg)} — открыть диалоги`)}">
        <span class="lbl"><b class="l1">${esc(label)}${sub ? ` <span>${esc(sub)}</span>` : ""}</b><small>${v.n} ${plural(v.n, ["диалог", "диалога", "диалогов"])}</small></span>
        <div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, Number(v.avg) || 0))}%"></div></div>
        <span class="num">${fmtNum(v.avg)}</span>
      </a>`;
    }).join("")}
    <div class="hbar-axis" aria-hidden="true"><span></span><div><span>0</span><span>50</span><span>100</span></div><span></span></div>`;
}

export function charts(s, rows, done, cfg, cl) {
  const byLang = Object.entries(s.by_language || {})
    .sort(([a], [b]) => (LANG_ORDER.indexOf(a) + 1 || 99) - (LANG_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));

  const hist = s.histogram || [];
  const histMax = Math.max(1, ...hist);
  const avg = Number(s.avg_total);
  const histHtml = `
    <div class="hist" role="img" aria-label="Распределение итоговых баллов: ${esc(hist.map((n, i) => `${i * 10}–${i === 9 ? 100 : i * 10 + 9}: ${n}`).join(", "))}">
      ${hist.map((n, i) => {
        const h = (n / histMax) * 100;
        return `<div class="bin" title="${i * 10}–${i === 9 ? 100 : i * 10 + 9}: ${n} ${plural(n, ["диалог", "диалога", "диалогов"])}">
          <i style="height:${h}%"></i>${n ? `<span style="bottom:calc(${h}% + 2px)">${n}</span>` : ""}</div>`;
      }).join("")}
      ${Number.isFinite(avg) && s.avg_total !== null ? `<div class="avg-line ${avg > 70 ? "flip" : ""}" style="left:${Math.max(0, Math.min(100, avg))}%"><span>среднее ${fmtNum(avg)}</span></div>` : ""}
    </div>
    <div class="hist-x" aria-hidden="true">${hist.map((_, i) => `<span>${i * 10}</span>`).join("")}</div>`;

  // Criteria in checklist order, then any extra ids found in the stats.
  const metaById = Object.fromEntries((cfg.criteria || []).map((c) => [c.id, c]));
  const ids = [...(cfg.criteria || []).map((c) => c.id).filter((id) => s.criteria[id]), ...Object.keys(s.criteria).filter((id) => !metaById[id])];
  const scoredW = (cfg.criteria || []).filter((c) => c.type !== "critical").reduce((a, c) => a + Number(c.weight || 0), 0);
  const rowsData = ids.map((id) => {
    const d = s.criteria[id], c = metaById[id] || { id, title: id, type: d.scale ? "scale" : "binary" };
    const isCrit = c.type === "critical";
    let rate = null, rateLabel = "";
    if (c.type === "scale") {
      const top = Math.max(...(c.scale || []).map((x) => Number(x.value)), 0);
      rate = d.scale && top ? (d.scale_sum / d.scale / top) * 100 : null;
      rateLabel = rate === null ? "—" : `${fmtNum(d.scale_sum / d.scale, 1)} из ${fmtNum(top)}`;
    } else if (isCrit) {
      rate = d.yes + d.no ? (d.no / (d.yes + d.no)) * 100 : null;
    } else {
      rate = d.yes + d.no ? (d.yes / (d.yes + d.no)) * 100 : null;
    }
    return { id, d, c, isCrit, rate, rateLabel };
  });
  const weakest = rowsData.filter((r) => r.c.type !== "critical" && r.rate !== null).sort((a, b) => a.rate - b.rate)[0];
  const typeShort = (c) => (c.type === "scale" ? "шкала" : c.type === "critical" ? "флаг" : "да / нет");

  const critTable = `
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Результаты по критериям</h2><div class="spacer"></div>
        <div class="legend" aria-label="Легенда">
          <span><i style="background:var(--good)"></i>Да / не выявлено</span>
          <span><i style="background:var(--bad)"></i>Нет / выявлено</span>
          <span><i style="background:var(--na-mark)"></i>N/A</span>
          <span><i style="background:var(--brand-600)"></i>Шкала: средний балл от максимума</span>
        </div></div>
      <div class="table-wrap" style="max-height:none">
      <table class="table crit-table">
        <caption class="sr-only">Ответы по критериям чек-листа</caption>
        <thead><tr><th>Критерий</th><th class="col-opt">Тип</th><th class="num col-opt">Вес</th>
          <th class="num col-opt">Да</th><th class="num col-opt">Нет</th><th class="num col-opt">N/A</th><th class="num">Выполнение</th><th style="width:24%" class="dist col-opt">Распределение</th></tr></thead>
        <tbody>
          ${rowsData.map(({ d, c, isCrit, rate, rateLabel }) => {
            const yes = isCrit ? d.no : d.yes, no = isCrit ? d.yes : d.no;
            const total = yes + no + d.na + (c.type === "scale" ? d.scale : 0);
            const tip = c.type === "scale"
              ? `Оценено по шкале: ${d.scale}, средний балл ${rateLabel}, N/A: ${d.na}`
              : `${isCrit ? "Не выявлено" : "Да"}: ${yes} · ${isCrit ? "Выявлено" : "Нет"}: ${no} · N/A: ${d.na}`;
            const bar = c.type === "scale"
              ? `<div class="stack" title="${esc(tip)}"><i class="s-scale" style="flex:${rate ?? 0}"></i><i class="s-rest" style="flex:${100 - (rate ?? 0)}"></i></div>`
              : `<div class="stack" title="${esc(tip)}">${yes ? `<i class="s-yes" style="flex:${yes}"></i>` : ""}${no ? `<i class="s-no" style="flex:${no}"></i>` : ""}${d.na ? `<i class="s-na" style="flex:${d.na}"></i>` : ""}${total ? "" : `<i class="s-na" style="flex:1"></i>`}</div>`;
            const share = c.type !== "critical" && scoredW ? (Number(c.weight || 0) / scoredW) * 100 : null;
            const href = isCrit ? dlgLink({ crit: "violation" }) : dlgLink({ col: `${c.id}:Нет` });
            return `<tr class="click" data-href="${esc(href)}" title="${isCrit ? "Показать диалоги с нарушением" : "Показать диалоги, где по критерию «Нет»"}" ${isCrit && d.yes ? 'style="background:var(--bad-soft)"' : ""}>
              <td><span class="ct-title"><span><span class="mono muted">${esc(c.code || "")}</span> <a href="${esc(href)}"><b>${esc(c.title)}</b></a></span></span></td>
              <td class="small muted col-opt">${typeShort(c)}</td>
              <td class="num col-opt" title="${share !== null ? `${fmtNum(share, 1)}% итога` : "без баллов"}">${c.type === "critical" ? "—" : fmtNum(c.weight)}</td>
              <td class="num col-opt">${c.type === "scale" ? "—" : yes}</td>
              <td class="num col-opt">${c.type === "scale" ? "—" : no}</td>
              <td class="num col-opt">${d.na}</td>
              <td class="num"><span class="pct" title="${esc(tip)}">${rate === null ? "—" : c.type === "scale" ? esc(rateLabel) : isCrit ? `${d.yes} ${plural(d.yes, ["случай", "случая", "случаев"])}` : `${fmtNum(rate, 0)}%`}</span></td>
              <td class="dist col-opt">${bar}</td>
            </tr>`;
          }).join("") || `<tr><td colspan="8" class="empty">Нет оценок</td></tr>`}
        </tbody>
      </table></div>
      ${weakest ? `<div class="card-pad" style="padding-top:0"><div class="insight">${icon("bulb")}<div>Чаще всего не выполняется: <b>${esc(weakest.c.code || "")} ${esc(weakest.c.title)}</b> — ${weakest.c.type === "scale" ? `средний балл ${esc(weakest.rateLabel)}` : `«Да» только в ${fmtNum(weakest.rate, 0)}% случаев`}. Хорошая тема для обучения операторов.
        <div class="next-hint" style="margin-top:6px"><a href="${dlgLink({ col: `${weakest.c.id}:Нет` })}">Найти такие диалоги</a>${cl ? `<span aria-hidden="true">·</span><a href="#/checklists/${esc(cl.id)}">Уточнить формулировку в чек-листе</a>` : ""}</div></div></div></div>` : ""}
    </div>`;

  return `
    <div class="an-grid-2">
      <div class="card card-pad">
        <div class="card-title">Средний итог по языкам <span class="muted small">строка открывает диалоги</span></div>
        ${hbars(byLang, (k) => ({ label: k, sub: LANG[k] || "" }))}
      </div>
      <div class="card card-pad">
        <div class="card-title">Распределение итоговых баллов <span class="muted">${s.evaluated} ${plural(s.evaluated, ["диалог", "диалога", "диалогов"])}</span></div>
        ${histHtml}
      </div>
    </div>
    ${critTable}`;
}
