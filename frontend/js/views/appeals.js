// Appeals: list (open / resolved tabs) and the reviewer's decision page.
import { api } from "../api.js";
import { esc, $, $$, fmtNum, fmtDate, toast, busy, answerView, answerOptions, LANG, CHANNEL } from "../util.js";
import { refreshBadge } from "../app.js";
import { msgHtml } from "../card/transcript.js";
import { iconFor, plural } from "../card/score.js";

let tab = "open";

export async function render(root, params) {
  if (params.id) return renderDetail(root, Number(params.id));
  const all = await api.appeals();
  const lists = { open: all.filter((a) => a.status === "open"), resolved: all.filter((a) => a.status !== "open") };
  const draw = () => {
    const list = lists[tab];
    root.innerHTML = `
      <div class="page-head">
        <div><h1>Апелляции</h1><div class="sub">Оспоренные оценки: проверяющий изучает доказательства и подтверждает или меняет ответ — итог пересчитывается.</div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="ap-tabs" role="tablist" aria-label="Статус апелляций">
            ${tabBtn("open", "На рассмотрении", lists.open.length)}
            ${tabBtn("resolved", "Рассмотренные", lists.resolved.length)}
          </div>
        </div>
        <div role="tabpanel" id="ap-panel" aria-labelledby="ap-tab-${tab}">
          ${list.length ? `
            <div class="ap-list">
              <div class="ap-row ap-row-head" aria-hidden="true"><span>Статус</span><span>Критерий и диалог</span><span>Комментарий</span><span>Оценка / итог</span><span class="ap-date">${tab === "open" ? "Подана" : "Рассмотрена"}</span></div>
              ${list.map(rowHtml).join("")}
            </div>`
          : `<div class="ap-empty"><b>${tab === "open" ? "Нет апелляций на рассмотрении" : "Пока нет рассмотренных апелляций"}</b>
              <span>${tab === "open" ? "Оспорить оценку можно в карточке диалога — кнопка «Оспорить оценку» у критерия." : "Решения проверяющих появятся здесь."}</span></div>`}
        </div>
      </div>`;
    $$("[data-tab]", root).forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; draw(); $(`[data-tab="${tab}"]`, root)?.focus(); }));
    $(".ap-tabs", root).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      tab = tab === "open" ? "resolved" : "open";
      draw();
      $(`[data-tab="${tab}"]`, root)?.focus();
    });
  };
  draw();
}

const tabBtn = (key, label, n) =>
  `<button type="button" class="ap-tab" role="tab" id="ap-tab-${key}" data-tab="${key}" aria-selected="${tab === key}" aria-controls="ap-panel" tabindex="${tab === key ? 0 : -1}">${label}<span class="ap-count">${n}</span></button>`;

const rawAnswer = (a) => (a === "yes" ? "Да" : a === "no" ? "Нет" : a === "na" ? "N/A" : a === null || a === undefined ? "—" : fmtNum(a));

const statusHtml = (s) =>
  s === "open" ? `<span class="ap-status is-open">на рассмотрении</span>`
  : s === "changed" ? `<span class="ap-status is-changed">оценка изменена</span>`
  : `<span class="ap-status is-confirmed">оценка подтверждена</span>`;

function deltaHtml(before, after) {
  if (before === null || before === undefined || after === null || after === undefined) return "";
  const d = Number(after) - Number(before);
  if (Math.abs(d) < 0.001) return `<span class="ap-delta is-zero">±0</span>`;
  return `<span class="ap-delta ${d > 0 ? "is-up" : "is-down"}">${d > 0 ? "+" : "−"}${fmtNum(Math.abs(d))}</span>`;
}

function rowHtml(a) {
  const resolved = a.status !== "open";
  const changed = a.status === "changed";
  return `
    <a class="ap-row" href="#/appeals/${a.id}" aria-label="Апелляция #${a.id}: ${esc(a.criterion_title || a.criterion_id)}">
      <div class="ap-cell-status">${statusHtml(a.status)}<span class="ap-id">#${a.id}</span></div>
      <div class="ap-cell-crit">
        <div class="ap-crit">${a.criterion_code ? `<span class="cv-code">${esc(a.criterion_code)}</span>` : ""}${esc(a.criterion_title || a.criterion_id)}</div>
        <div class="ap-dialog"><span class="mono">${esc(a.conversation_id)}</span>${a.channel ? `<span>${esc(CHANNEL[a.channel] || a.channel)}</span>` : ""}${a.language ? `<span>${esc(LANG[a.language] || a.language)}</span>` : ""}</div>
      </div>
      <div class="ap-cell-comment">
        <div class="ap-comment">${esc(a.comment)}</div>
        ${a.author ? `<div class="ap-author">${esc(a.author)}</div>` : ""}
      </div>
      <div class="ap-ba">
        <div class="ap-ba-line"><span class="ap-ba-k">Ответ</span>
          ${changed ? `<span class="ap-was is-struck">${esc(rawAnswer(a.original_answer))}</span>→<b>${esc(rawAnswer(a.new_answer))}</b>` : `<b>${esc(rawAnswer(a.original_answer))}</b>`}</div>
        <div class="ap-ba-line"><span class="ap-ba-k">Итог</span>
          ${resolved ? `<span class="ap-was">${fmtNum(a.total_before)}</span>→<b>${fmtNum(a.total_after)}</b>${deltaHtml(a.total_before, a.total_after)}` : `<b>${fmtNum(a.total_before)}</b>`}</div>
      </div>
      <div class="ap-date">${esc(fmtDate(resolved ? a.resolved_at : a.created_at))}</div>
    </a>`;
}

// ---------------------------------------------------------------- detail ----

/** Points a criterion would get for `value` (null when it depends on N/A redistribution). */
function pointsFor(crit, value, srow) {
  if (crit.type === "critical" || value === "na") return null;
  const max = srow && srow.max_points !== null && srow.max_points !== undefined ? Number(srow.max_points) : Number(crit.weight);
  if (crit.type === "scale") {
    const top = Math.max(...(crit.scale || []).map((s) => Number(s.value)));
    return top > 0 ? (max * Number(value)) / top : 0;
  }
  return value === "yes" ? max : 0;
}

async function renderDetail(root, id) {
  const { appeal: a, evaluation: ev, conversation: conv } = await api.appeal(id);
  const crit = ev.checklist.criteria.find((c) => c.id === a.criterion_id);
  if (!crit) throw new Error("Критерий не найден в версии чек-листа этой оценки");
  const row = ev.criteria.find((r) => r.criterion_id === a.criterion_id) || {}; // original model result
  const curRow = ev.final_criteria.find((r) => r.criterion_id === a.criterion_id) || row;
  const srowFinal = ev.final_score.criteria.find((r) => r.criterion_id === a.criterion_id);
  const srowOrig = ev.score.criteria.find((r) => r.criterion_id === a.criterion_id);
  const msgs = conv.transcript || [];
  const isOpen = a.status === "open";
  const cardLink = (msg) => `#/conversation/${encodeURIComponent(conv.id)}?eval=${ev.id}&crit=${encodeURIComponent(crit.id)}${msg ? `&msg=${msg}` : ""}`;

  // Dialog fragment: evidence + checked range, with ±2 messages of context.
  const evid = new Set(row.evidence || []);
  const inRange = (n) => row.checked_range && n >= row.checked_range[0] && n <= row.checked_range[1];
  const marks = new Set();
  (row.evidence || []).forEach((n) => { for (let k = n - 2; k <= n + 2; k++) marks.add(k); });
  if (row.checked_range) for (let k = row.checked_range[0] - 1; k <= row.checked_range[1] + 1; k++) marks.add(k);
  if (!marks.size) for (let k = 1; k <= Math.min(6, msgs.length); k++) marks.add(k);
  const shown = [...marks].filter((n) => n >= 1 && n <= msgs.length).sort((x, y) => x - y);
  const gap = (k) => `<div class="ap-frag-gap"><span>… ${k} ${plural(k, "реплика скрыта", "реплики скрыты", "реплик скрыто")}</span></div>`;
  let fragment = shown[0] > 1 ? gap(shown[0] - 1) : "";
  shown.forEach((n, i) => {
    if (i > 0 && n - shown[i - 1] > 1) fragment += gap(n - shown[i - 1] - 1);
    fragment += msgHtml(msgs[n - 1], n, { idPrefix: "ap-msg-", cls: `${evid.has(n) ? "is-evidence" : ""} ${inRange(n) ? "in-range" : ""}` });
  });
  const lastShown = shown[shown.length - 1] || 0;
  if (lastShown < msgs.length) fragment += gap(msgs.length - lastShown);

  const disputed = a.original_answer;
  const dv = iconFor(crit, disputed);
  const ptsNow = pointsFor(crit, disputed, srowFinal);
  const maxNow = srowFinal && srowFinal.max_points !== null ? srowFinal.max_points : crit.type === "critical" ? null : crit.weight;
  const chan = CHANNEL[conv.channel] || conv.channel || "";

  const scaleList = crit.type === "scale" ? `
    <div class="ap-sec-h">Шкала критерия</div>
    <div class="ap-scale">${[...crit.scale].sort((x, y) => y.value - x.value).map((s) => {
      const cls = String(s.value) === String(disputed) ? "is-cur" : a.status === "changed" && String(s.value) === String(a.new_answer) ? "is-new" : "";
      return `<div class="${cls}"><b>${esc(s.value)}</b><span>${esc(s.description)}${cls === "is-cur" ? " · <em>спорная оценка</em>" : cls === "is-new" ? " · <em>решение проверяющего</em>" : ""}</span></div>`;
    }).join("")}</div>` : "";

  const opts = answerOptions(crit).filter((o) => String(o.value) !== String(curRow.answer));
  const curPts = pointsFor(crit, curRow.answer, srowFinal);

  root.innerHTML = `
    <div class="crumbs"><a href="#/appeals">Апелляции</a> / #${a.id}</div>
    <div class="page-head ap-head">
      <div>
        <h1>Апелляция #${a.id}</h1>
        <div class="ap-head-sub">
          ${statusHtml(a.status)}
          <a class="mono" href="${cardLink(row.evidence?.[0])}">${esc(conv.id)}</a>
          ${chan ? `<span>${esc(chan)}</span>` : ""}
          ${conv.language ? `<span>${esc(LANG[conv.language] || conv.language)}</span>` : ""}
          <span>оценка #${ev.id} · ${esc(ev.checklist_name)} v${ev.checklist_version}</span>
        </div>
      </div>
      <div class="spacer"></div>
      <a class="btn" href="${cardLink(row.evidence?.[0])}">Открыть карточку диалога →</a>
    </div>
    <div class="ap-grid">
      <div class="ap-col">
        <section class="card ap-crit-card" aria-label="Спорный критерий">
          <div class="ap-crit-title">
            <span class="cv-ic cv-k-${dv.kind}" aria-hidden="true">${esc(dv.icon)}</span>
            <div><h2>${crit.code ? `<span class="cv-code">${esc(crit.code)}</span>` : ""}${esc(crit.title)}</h2>
              ${crit.description ? `<p class="ap-crit-desc">${esc(crit.description)}</p>` : ""}</div>
          </div>
          <div class="ap-disputed">
            <div><div class="ap-disputed-k">Спорная оценка</div><div class="ap-disputed-v">${esc(answerView(crit, disputed).label)}</div></div>
            ${ptsNow !== null && maxNow !== null ? `<div><div class="ap-disputed-k">Баллы</div><div class="ap-disputed-v">${fmtNum(ptsNow)} <span class="cv-of">/ ${fmtNum(maxNow)}</span></div></div>` : ""}
            <div><div class="ap-disputed-k">Вес</div><div class="ap-disputed-v">${crit.type === "critical" ? "без баллов" : fmtNum(crit.weight)}</div></div>
            ${String(row.answer) !== String(disputed) && row.answer !== undefined ? `<div><div class="ap-disputed-k">Модель</div><div class="ap-disputed-v">${esc(answerView(crit, row.answer).label)}</div></div>` : ""}
          </div>
          <div class="ap-sec-h">Объяснение модели</div>
          <p class="ap-expl">${esc(row.explanation || "—")}</p>
          ${row.na_reason ? `<div class="cv-note cv-note-na"><b>Почему N/A:</b> ${esc(row.na_reason)}</div>` : ""}
          ${row.checked_range ? `<div class="cv-note cv-note-range"><b>Проверенный участок:</b> #${row.checked_range[0]}–#${row.checked_range[1]}${row.answer === "no" ? " — ожидаемое действие не найдено" : ""}</div>` : ""}
          ${crit.na_allowed && crit.na_condition ? `<div class="cv-note"><b>Когда допустим N/A:</b> ${esc(crit.na_condition)}</div>` : ""}
          ${scaleList}
        </section>
        <section class="card" aria-label="Фрагмент диалога">
          <div class="card-head"><h2>Фрагмент диалога</h2><div class="spacer"></div>
            <span class="cv-muted-s">${evid.size ? `${evid.size} ${plural(evid.size, "доказательство", "доказательства", "доказательств")} подсвечено` : ""}</span>
            <a class="btn btn-sm" href="${cardLink(row.evidence?.[0])}">Открыть полностью</a></div>
          <div class="ap-frag">${fragment || `<div class="ap-empty">Реплики не найдены</div>`}</div>
        </section>
      </div>
      <div class="ap-col">
        <section class="card" aria-label="Апелляция">
          <ol class="ap-timeline">
            <li class="is-done"><span class="ap-tl-dot" aria-hidden="true">✓</span><span class="ap-tl-text"><b>Подана</b><span>${esc(fmtDate(a.created_at))}${a.author ? ` · ${esc(a.author)}` : ""}</span></span></li>
            <li class="${isOpen ? "is-now" : "is-done"}"><span class="ap-tl-dot" aria-hidden="true">${isOpen ? "" : "✓"}</span><span class="ap-tl-text"><b>${isOpen ? "На рассмотрении" : "Рассмотрена"}</b><span>${isOpen ? "ожидает решения" : `${esc(fmtDate(a.resolved_at))}${a.reviewer ? ` · ${esc(a.reviewer)}` : ""}`}</span></span></li>
            <li class="${isOpen ? "" : "is-done"}"><span class="ap-tl-dot" aria-hidden="true">${isOpen ? "" : "✓"}</span><span class="ap-tl-text"><b>Итог пересчитан</b><span>${isOpen ? "после решения" : `${fmtNum(a.total_before)} → ${fmtNum(a.total_after)}`}</span></span></li>
          </ol>
          <div class="cv-pad">
            <div class="ap-sec-h" style="margin-top:0">Комментарий апелляции</div>
            <div class="ap-quote">${esc(a.comment)}</div>
            <div class="ap-by">${a.author ? esc(a.author) + " · " : ""}${esc(fmtDate(a.created_at))}</div>
          </div>
        </section>
        ${isOpen ? `
        <section class="card cv-pad" aria-label="Решение проверяющего">
          <h3>Решение проверяющего</h3>
          <div class="ap-form">
            <div class="ap-choice" role="radiogroup" aria-label="Решение">
              <label><input type="radio" name="dec" value="confirm" checked><span><b>Подтвердить</b><small>оценка модели верна</small></span></label>
              <label><input type="radio" name="dec" value="change" ${opts.length ? "" : "disabled"}><span><b>Изменить</b><small>выбрать новый ответ</small></span></label>
            </div>
            <fieldset class="ap-opt" id="new-wrap" hidden style="border:0;padding:0;margin:0">
              <legend class="ap-sec-h" style="margin-top:0">Новая оценка (сейчас: ${esc(answerView(crit, curRow.answer).label)})</legend>
              ${opts.map((o, i) => {
                const p = pointsFor(crit, o.value, srowFinal);
                return `<label><input type="radio" name="new-answer" value="${esc(o.value)}" ${i === 0 ? "checked" : ""}>
                  <span class="ap-opt-main">${esc(o.label)}</span>
                  <span class="ap-opt-pts">${o.value === "na" ? "вес перераспределится" : crit.type === "critical" ? "без баллов" : `${fmtNum(p)} / ${fmtNum(maxNow)}`}</span></label>`;
              }).join("")}
            </fieldset>
            <div class="ap-preview" id="ap-preview" aria-live="polite"></div>
            <label class="field">Причина решения
              <textarea class="input" id="reason" rows="3" placeholder="Например: оператор представился в реплике #3 — критерий выполнен"></textarea></label>
            <label class="field">Проверяющий
              <input class="input" id="reviewer" placeholder="ФИО или e-mail" value="${esc(window.CQA_USER || "")}" ${window.CQA_USER ? "readonly" : ""}></label>
            <div class="ap-actions">
              <button class="btn btn-primary" id="btn-decide" type="button">Сохранить решение</button>
            </div>
          </div>
        </section>` : resultHtml({ a, ev, crit, srowOrig, cardLink })}
      </div>
    </div>`;

  if (!isOpen) return;

  const preview = () => {
    const dec = $("input[name=dec]:checked", root).value;
    const box = $("#ap-preview", root);
    $("#new-wrap", root).hidden = dec !== "change";
    const total = ev.final_total;
    if (dec === "confirm") {
      box.innerHTML = `Итог останется <b>${fmtNum(total)}</b> · ответ «${esc(answerView(crit, curRow.answer).label)}» будет отмечен как подтверждённый`;
      return;
    }
    const nv = $("input[name=new-answer]:checked", root)?.value;
    if (nv === undefined) { box.textContent = ""; return; }
    const np = pointsFor(crit, nv, srowFinal);
    if (crit.type === "critical") {
      box.innerHTML = `Балл не изменится (<b>${fmtNum(total)}</b>), изменится флаг грубой ошибки`;
    } else if (np === null || curPts === null || total === null || total === undefined) {
      box.innerHTML = `Итог <b>${fmtNum(total)}</b> будет пересчитан с перераспределением весов N/A`;
    } else {
      const after = Number(total) + (np - curPts);
      box.innerHTML = `Итог: <b>${fmtNum(total)}</b> → <b>≈ ${fmtNum(after)}</b> ${deltaHtml(total, after)}`;
    }
  };
  $$("input[name=dec], input[name=new-answer]", root).forEach((r) => r.addEventListener("change", preview));
  preview();

  $("#btn-decide", root).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const decision = $("input[name=dec]:checked", root).value;
    const reasonEl = $("#reason", root);
    const reason = reasonEl.value.trim();
    if (!reason) { toast("Укажите причину решения", true); reasonEl.focus(); return; }
    busy(btn, true, "Сохранение…");
    try {
      const res = await api.decide(id, {
        decision, reason, reviewer: $("#reviewer", root).value.trim() || null,
        new_answer: decision === "change" ? $("input[name=new-answer]:checked", root)?.value ?? null : null,
      });
      toast(`Решение сохранено. Итог: ${fmtNum(res.total_before)} → ${fmtNum(res.total_after)}`);
      refreshBadge();
      await renderDetail(root, id);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      toast(err.message, true);
      busy(btn, false);
    }
  });
}

function resultHtml({ a, ev, crit, srowOrig, cardLink }) {
  const changed = a.status === "changed";
  const from = answerView(crit, a.original_answer), to = answerView(crit, a.new_answer);
  return `
    <section class="card ap-result" aria-label="Решение">
      <div class="ap-result-h"><h3>Решение проверяющего</h3>${statusHtml(a.status)}</div>
      <div class="ap-totals">
        <div class="ap-total is-before"><small>До решения</small><b>${fmtNum(a.total_before)}</b></div>
        <div class="ap-totals-arrow" aria-hidden="true">→${deltaHtml(a.total_before, a.total_after)}</div>
        <div class="ap-total is-after"><small>После решения</small><b>${fmtNum(a.total_after)}</b></div>
      </div>
      <dl class="ap-decision">
        <dt>Решение</dt>
        <dd>${changed
          ? `<span class="ap-change">Оценка изменена: <span class="cv-pill is-na" style="text-decoration:line-through">${esc(from.label)}</span>→<span class="cv-pill is-ok">${esc(to.label)}</span></span>`
          : `Оценка подтверждена: <b>${esc(from.label)}</b>`}</dd>
        <dt>Причина</dt><dd>${esc(a.reason || "—")}</dd>
        <dt>Проверяющий</dt><dd>${esc(a.reviewer || "—")} · ${esc(fmtDate(a.resolved_at))}</dd>
      </dl>
      ${ev.total !== null && Math.abs(Number(ev.total) - Number(a.total_before)) > 0.001
        ? `<div class="ap-orig-note">Исходная оценка модели: ${fmtNum(ev.total)}${srowOrig && srowOrig.points !== null ? ` · по критерию ${fmtNum(srowOrig.points)} б.` : ""}</div>` : ""}
      <div class="ap-orig-note">Текущий итог диалога: <b>${fmtNum(ev.final_total)}</b></div>
      <div class="ap-actions" style="margin-top:14px"><a class="btn btn-primary" href="${cardLink()}">Открыть карточку с финальным результатом →</a></div>
    </section>`;
}
