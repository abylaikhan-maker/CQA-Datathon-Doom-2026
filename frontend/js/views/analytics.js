import { api } from "../api.js";
import { esc, $, fmtNum, LANG } from "../util.js";

const st = { group: "", checklist_id: "" };

export async function render(root) {
  const [groups, checklists] = await Promise.all([api.groups(), api.checklists()]);
  if (!st.checklist_id) st.checklist_id = String((checklists.find((c) => c.is_active) || checklists[0])?.id || "");
  const s = await api.stats({ group: st.group || null, checklist_id: st.checklist_id || null });
  const cl = checklists.find((c) => String(c.id) === st.checklist_id);
  const cfg = cl ? (await api.checklist(cl.id)).config : null;
  const critMeta = Object.fromEntries((cfg?.criteria || []).map((c) => [c.id, c]));

  const langMax = 100;
  const histMax = Math.max(1, ...s.histogram);
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Аналитика</h1><div class="sub">Последняя оценка каждого диалога с учётом решений по апелляциям.</div></div>
      <div class="spacer"></div>
      <select class="input" id="a-group" style="width:auto">
        <option value="">Все наборы</option>
        ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === st.group ? "selected" : ""}>${esc(g.id)}</option>`).join("")}
      </select>
      <select class="input" id="a-cl" style="width:auto">
        ${checklists.map((c) => `<option value="${c.id}" ${String(c.id) === st.checklist_id ? "selected" : ""}>${esc(c.name)} · v${c.version}</option>`).join("")}
      </select>
      <a class="btn" href="${api.exportUrl({ group: st.group || null, checklist_id: st.checklist_id || null })}">Экспорт CSV</a>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="lbl">Оценено диалогов</div><div class="v">${s.evaluated}</div></div>
      <div class="card kpi"><div class="lbl">Средний итог</div><div class="v">${fmtNum(s.avg_total)}<small> / 100</small></div></div>
      <div class="card kpi"><div class="lbl">Грубые ошибки</div><div class="v" style="color:${s.critical ? "var(--bad)" : "inherit"}">${s.critical}</div></div>
      <div class="card kpi"><div class="lbl">Апелляции: открыто / изменено / подтв.</div><div class="v">${s.appeals.open}<small> / ${s.appeals.changed} / ${s.appeals.confirmed}</small></div></div>
      <div class="card kpi"><div class="lbl">Стоимость одной оценки</div><div class="v">${s.avg_cost_usd !== null ? "$" + fmtNum(s.avg_cost_usd, 4) : "—"}</div></div>
      <div class="card kpi"><div class="lbl">Время одной оценки</div><div class="v">${s.avg_duration_ms ? fmtNum(s.avg_duration_ms / 1000, 1) : "—"}<small> с</small></div></div>
    </div>
    <div class="an-grid">
      <div class="card card-pad">
        <h3>Средний итог по языкам</h3>
        ${Object.entries(s.by_language).map(([l, v]) => `
          <div class="hbar" title="${esc(LANG[l] || l)}: ${v.n} диалогов, средний итог ${fmtNum(v.avg)}">
            <span>${esc(l)} <span class="muted small">(${v.n})</span></span>
            <div class="track"><div class="fill" style="width:${(v.avg / langMax) * 100}%"></div></div>
            <span class="num">${fmtNum(v.avg)}</span>
          </div>`).join("") || `<div class="muted">Нет данных</div>`}
      </div>
      <div class="card card-pad">
        <h3>Распределение итоговых баллов</h3>
        <div class="hist">${s.histogram.map((n, i) => `<div style="height:${(n / histMax) * 100}%" title="${i * 10}–${i === 9 ? 100 : i * 10 + 9.99}: ${n} диалогов"></div>`).join("")}</div>
        <div class="hist-x">${s.histogram.map((_, i) => `<span>${i * 10}</span>`).join("")}</div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Результаты по критериям</h2><div class="spacer"></div>
        <div class="legend"><span><i style="background:var(--good)"></i>Да / не выявлено</span><span><i style="background:var(--bad)"></i>Нет / выявлено</span><span><i style="background:#b8c2bc"></i>N/A</span></div></div>
      <table class="table">
        <thead><tr><th>Критерий</th><th>Тип</th><th class="num">Да</th><th class="num">Нет</th><th class="num">N/A</th><th class="num">Ср. по шкале</th><th style="width:30%">Доля</th></tr></thead>
        <tbody>
          ${Object.entries(s.criteria).map(([id, d]) => {
            const c = critMeta[id] || { title: id, type: "" };
            const isCrit = c.type === "critical";
            const yes = isCrit ? d.no : d.yes, no = isCrit ? d.yes : d.no;
            const scaleN = d.scale;
            return `<tr>
              <td><span class="mono muted">${esc(c.code || "")}</span> ${esc(c.title)}</td>
              <td class="small muted">${c.type === "scale" ? "шкала" : isCrit ? "флаг" : "да/нет"}</td>
              <td class="num">${c.type === "scale" ? "—" : yes}</td>
              <td class="num">${c.type === "scale" ? "—" : no}</td>
              <td class="num">${d.na}</td>
              <td class="num">${scaleN ? fmtNum(d.scale_sum / scaleN) : "—"}</td>
              <td>${c.type === "scale" ? `<div class="stack"><i class="s-yes" style="flex:${scaleN}"></i><i class="s-na" style="flex:${d.na}"></i></div>`
                : `<div class="stack" title="Да ${yes} · Нет ${no} · N/A ${d.na}"><i class="s-yes" style="flex:${yes}"></i><i class="s-no" style="flex:${no}"></i><i class="s-na" style="flex:${d.na}"></i></div>`}</td>
            </tr>`;
          }).join("") || `<tr><td colspan="7" class="empty">Нет оценок</td></tr>`}
        </tbody>
      </table>
    </div>`;

  $("#a-group", root).addEventListener("change", (e) => { st.group = e.target.value; render(root); });
  $("#a-cl", root).addEventListener("change", (e) => { st.checklist_id = e.target.value; render(root); });
}
