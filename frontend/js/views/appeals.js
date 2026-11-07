import { api } from "../api.js";
import { esc, $, $$, fmtNum, fmtDate, toast, busy, answerView, answerOptions, SPEAKER, fmtTs, LANG } from "../util.js";
import { refreshBadge } from "../app.js";

let tab = "open";

export async function render(root, params) {
  if (params.id) return renderDetail(root, Number(params.id));
  const list = await api.appeals(tab);
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Апелляции</h1><div class="sub">Проверяющий изучает доказательства, подтверждает или меняет оценку.</div></div>
    </div>
    <div class="card">
      <div class="card-head">
        <div class="tabs">
          <button class="tab ${tab === "open" ? "active" : ""}" data-tab="open">На рассмотрении</button>
          <button class="tab ${tab === "resolved" ? "active" : ""}" data-tab="resolved">Рассмотренные</button>
        </div>
      </div>
      ${list.length ? `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Диалог</th><th>Критерий</th><th>Комментарий</th><th>Оценка</th><th class="num">Итог</th><th>Статус</th><th>Создана</th></tr></thead>
        <tbody>${list.map((a) => `
          <tr class="click" data-id="${a.id}">
            <td class="mono">${a.id}</td>
            <td class="mono">${esc(a.conversation_id)} <span class="muted">${esc(a.language || "")}</span></td>
            <td><span class="mono muted">${esc(a.criterion_code || "")}</span> ${esc(a.criterion_title || a.criterion_id)}</td>
            <td style="max-width:320px">${esc(a.comment)}</td>
            <td>${answerLabel(a.original_answer)}${a.status === "changed" ? ` → <b>${answerLabel(a.new_answer)}</b>` : ""}</td>
            <td class="num">${fmtNum(a.total_before)}${a.total_after !== null && a.total_after !== undefined ? ` → <b>${fmtNum(a.total_after)}</b>` : ""}</td>
            <td>${statusBadge(a.status)}</td>
            <td class="small muted">${fmtDate(a.created_at)}</td>
          </tr>`).join("")}</tbody>
      </table></div>` : `<div class="empty">${tab === "open" ? "Нет открытых апелляций. Оспорить оценку можно в карточке диалога." : "Пока нет рассмотренных апелляций."}</div>`}
    </div>`;
  $$("[data-tab]", root).forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; render(root, params); }));
  $$("tr[data-id]", root).forEach((tr) => tr.addEventListener("click", () => (location.hash = `#/appeals/${tr.dataset.id}`)));
}

const answerLabel = (a) => (a === "yes" ? "Да" : a === "no" ? "Нет" : a === "na" ? "N/A" : fmtNum(a));
const statusBadge = (s) =>
  s === "open" ? `<span class="badge warn">на рассмотрении</span>` : s === "changed" ? `<span class="badge brand">оценка изменена</span>` : `<span class="badge yes">подтверждена</span>`;

async function renderDetail(root, id) {
  const { appeal: a, evaluation: ev, conversation: conv } = await api.appeal(id);
  const crit = ev.checklist.criteria.find((c) => c.id === a.criterion_id);
  const row = ev.criteria.find((r) => r.criterion_id === a.criterion_id); // original model result
  const srow = ev.score.criteria.find((r) => r.criterion_id === a.criterion_id);
  const curRow = ev.final_criteria.find((r) => r.criterion_id === a.criterion_id);
  const msgs = conv.transcript;

  // Dialog fragment: evidence + checked range, with ±2 messages of context.
  const focus = new Set(row.evidence || []);
  const marks = new Set();
  (row.evidence || []).forEach((n) => { for (let k = n - 2; k <= n + 2; k++) marks.add(k); });
  if (row.checked_range) for (let k = row.checked_range[0] - 1; k <= row.checked_range[1] + 1; k++) marks.add(k);
  if (!marks.size) for (let k = 1; k <= Math.min(6, msgs.length); k++) marks.add(k);
  const shown = [...marks].filter((n) => n >= 1 && n <= msgs.length).sort((x, y) => x - y);

  const fragment = shown.map((n, idx) => {
    const m = msgs[n - 1];
    const gap = idx > 0 && n - shown[idx - 1] > 1 ? `<div class="muted small" style="padding:4px 16px">…</div>` : "";
    return `${gap}<div class="msg ${esc(m.speaker)} ${focus.has(n) ? "focus" : ""} ${row.checked_range && n >= row.checked_range[0] && n <= row.checked_range[1] ? "in-range" : ""}">
      <div class="n">#${n}</div>
      <div class="meta"><span class="who">${esc(SPEAKER[m.speaker] || m.speaker)}</span><span class="ts-link">${esc(fmtTs(m.timestamp))}</span></div>
      <div class="text">${esc(m.text)}</div></div>`;
  }).join("");

  const av = answerView(crit, a.original_answer);
  const isOpen = a.status === "open";
  root.innerHTML = `
    <div class="crumbs"><a href="#/appeals">Апелляции</a> / #${a.id}</div>
    <div class="page-head">
      <div><h1>Апелляция #${a.id}</h1>
        <div class="sub">Диалог <a class="mono" href="#/conversation/${encodeURIComponent(conv.id)}?eval=${ev.id}&crit=${encodeURIComponent(crit.id)}">${esc(conv.id)}</a> ·
          ${esc(LANG[conv.language] || conv.language || "")} · оценка #${ev.id} (${esc(ev.checklist_name)} v${ev.checklist_version})</div></div>
      <div class="spacer"></div>${statusBadge(a.status)}
    </div>
    <div class="ap-grid">
      <section>
        <div class="card card-pad" style="margin-bottom:16px">
          <h2><span class="mono muted">${esc(crit.code || "")}</span> ${esc(crit.title)}</h2>
          <dl class="kv">
            <dt>Спорная оценка</dt><dd><span class="badge ${av.kind === "part" ? "warn" : av.kind}">${esc(av.label)}</span>
              ${srow && srow.points !== null ? ` · ${fmtNum(srow.points)} / ${fmtNum(srow.max_points)} балл.` : ""}</dd>
            <dt>Критерий</dt><dd class="small">${esc(crit.description || "")}${crit.na_allowed && crit.na_condition ? `<br><span class="muted">N/A: ${esc(crit.na_condition)}</span>` : ""}</dd>
            <dt>Обоснование модели</dt><dd>${esc(row.explanation || "—")}</dd>
            ${row.na_reason ? `<dt>Причина N/A</dt><dd>${esc(row.na_reason)}</dd>` : ""}
            ${crit.type === "scale" ? `<dt>Шкала</dt><dd class="small">${crit.scale.map((s) => `<div><b>${s.value}</b> — ${esc(s.description)}</div>`).join("")}</dd>` : ""}
          </dl>
        </div>
        <div class="card">
          <div class="card-head"><h2>Фрагмент диалога</h2><div class="spacer"></div>
            <a class="btn btn-sm" href="#/conversation/${encodeURIComponent(conv.id)}?eval=${ev.id}&crit=${encodeURIComponent(crit.id)}${row.evidence?.[0] ? `&msg=${row.evidence[0]}` : ""}">Открыть полностью</a></div>
          <div class="transcript" style="max-height:none">${fragment}</div>
        </div>
      </section>
      <section>
        <div class="card card-pad" style="margin-bottom:16px">
          <h3>Комментарий апелляции</h3>
          <div class="quote">${esc(a.comment)}</div>
          <div class="muted small" style="margin-top:6px">${a.author ? esc(a.author) + " · " : ""}${fmtDate(a.created_at)}</div>
        </div>
        <div class="card card-pad">
          ${isOpen ? `
            <h3>Решение проверяющего</h3>
            <div class="choice" style="margin-bottom:12px">
              <label><input type="radio" name="dec" value="confirm" checked><span>Подтвердить оценку</span></label>
              <label><input type="radio" name="dec" value="change"><span>Изменить оценку</span></label>
            </div>
            <label class="field hidden" id="new-wrap" style="margin-bottom:12px">Новая оценка
              <select class="input" id="new-answer">
                ${answerOptions(crit).filter((o) => String(o.value) !== String(curRow.answer)).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}
              </select></label>
            <label class="field" style="margin-bottom:12px">Причина решения
              <textarea class="input" id="reason" rows="3" placeholder="Например: оператор представился в реплике #3 — критерий выполнен"></textarea></label>
            <label class="field" style="margin-bottom:14px">Проверяющий
              <input class="input" id="reviewer" placeholder="ФИО" value="${esc(window.CQA_USER || "")}" ${window.CQA_USER ? "readonly" : ""}></label>
            <div class="row"><div class="grow muted small">Текущий итог: <b>${fmtNum(ev.final_total)}</b></div>
              <button class="btn btn-primary" id="btn-decide">Сохранить решение</button></div>
          ` : `
            <h3>Решение</h3>
            <dl class="kv">
              <dt>Решение</dt><dd>${a.status === "changed" ? `Изменено: ${esc(answerView(crit, a.original_answer).label)} → <b>${esc(answerView(crit, a.new_answer).label)}</b>` : "Оценка подтверждена"}</dd>
              <dt>Причина</dt><dd>${esc(a.reason)}</dd>
              <dt>Проверяющий</dt><dd>${esc(a.reviewer || "—")} · ${fmtDate(a.resolved_at)}</dd>
            </dl>
            <div class="row" style="margin-top:14px;gap:20px">
              <div><div class="muted small">Исходный итог</div><div class="delta">${fmtNum(ev.total)}</div></div>
              <div><div class="muted small">До решения</div><div class="delta">${fmtNum(a.total_before)}</div></div>
              <div style="font-size:22px">→</div>
              <div><div class="muted small">После решения</div><div class="delta" style="color:var(--brand-700)">${fmtNum(a.total_after)}</div></div>
            </div>
            <div style="margin-top:12px"><a href="#/conversation/${encodeURIComponent(conv.id)}?eval=${ev.id}&crit=${encodeURIComponent(crit.id)}">Открыть карточку с финальным результатом →</a></div>
          `}
        </div>
      </section>
    </div>`;

  if (!isOpen) return;
  $$("input[name=dec]", root).forEach((r) => r.addEventListener("change", () =>
    $("#new-wrap", root).classList.toggle("hidden", $("input[name=dec]:checked", root).value !== "change")));
  $("#btn-decide", root).addEventListener("click", async (e) => {
    const decision = $("input[name=dec]:checked", root).value;
    const reason = $("#reason", root).value.trim();
    if (!reason) { toast("Укажите причину решения", true); return; }
    busy(e.currentTarget, true, "Сохранение…");
    try {
      const res = await api.decide(id, {
        decision, reason, reviewer: $("#reviewer", root).value.trim() || null,
        new_answer: decision === "change" ? $("#new-answer", root).value : null,
      });
      toast(`Решение сохранено. Итог: ${fmtNum(res.total_before)} → ${fmtNum(res.total_after)}`);
      refreshBadge();
      renderDetail(root, id);
    } catch (err) {
      toast(err.message, true);
      busy(e.currentTarget, false);
    }
  });
}
