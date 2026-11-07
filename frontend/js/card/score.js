// HTML builders for the "Оценка качества" panel (pure functions, no DOM state).
import { esc, fmtNum, fmtDate, fmtTs, answerView, SPEAKER } from "../util.js";

export function ringHtml(value, size = 128) {
  const r = 44, c = 2 * Math.PI * r;
  const has = value !== null && value !== undefined;
  const v = has ? Math.max(0, Math.min(100, Number(value))) : 0;
  const tone = !has ? "none" : v >= 85 ? "hi" : v >= 65 ? "mid" : "lo";
  return `
    <div class="cv-ring cv-tone-${tone}" style="width:${size}px;height:${size}px" role="img" aria-label="Итог ${has ? fmtNum(value) : "не рассчитан"} из 100">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="cv-ring-bg" cx="50" cy="50" r="${r}"/>
        ${v > 0 ? `<circle class="cv-ring-fg" cx="50" cy="50" r="${r}" stroke-dasharray="${((c * v) / 100).toFixed(2)} ${c.toFixed(2)}"/>` : ""}
      </svg>
      <div class="cv-ring-val"><b>${has ? fmtNum(value) : "—"}</b><span>/ 100</span></div>
    </div>`;
}

/** Icon text + kind for a criterion answer (✓ ✕ ~ N/A !). */
export function iconFor(crit, answer) {
  const av = answerView(crit, answer);
  if (answer === "na") return { ...av, icon: "N/A" };
  return av;
}

/** Strip a leading "<Title> — Да." echo that the model sometimes adds. */
export function shortReason(crit, row) {
  let t = String(row.explanation || "").trim();
  if (crit && crit.title && t.toLowerCase().startsWith(crit.title.toLowerCase())) {
    const dot = t.indexOf(". ");
    if (dot > 0 && dot < crit.title.length + 40) t = t.slice(dot + 2);
  }
  return t;
}

export const firstRef = (row) => (row && ((row.evidence || [])[0] || (row.checked_range || [])[0])) || null;

const pointsLabel = (crit, row, srow) => {
  const av = answerView(crit, row.answer);
  if (crit.type === "critical") return { main: `<span class="cv-pill ${row.answer === "yes" ? "is-crit" : "is-ok"}">${esc(av.label)}</span>`, sub: "без баллов" };
  if (row.answer === "na") return { main: `<span class="cv-pill is-na">N/A</span>`, sub: `вес ${fmtNum(crit.weight)} перераспределён` };
  const redistributed = srow && srow.max_points !== null && Math.abs(srow.max_points - crit.weight) > 0.001;
  return {
    main: `${fmtNum(srow?.points)}<span class="cv-of"> / ${fmtNum(srow?.max_points)}</span>`,
    sub: `${esc(av.label)} · вес ${fmtNum(crit.weight)}${redistributed ? ` → ${fmtNum(srow.max_points)}` : ""}`,
  };
};

function evidenceHtml(row, msgs, rel) {
  const chips = (row.evidence || []).map((n) => {
    const m = msgs[n - 1];
    if (!m) return "";
    const sp = String(m.speaker || "").toLowerCase();
    const t = rel && rel[n - 1] !== null && rel[n - 1] !== undefined ? rel[n - 1] : null;
    return `<button type="button" class="cv-ev cv-ev-${esc(sp)}" data-msg="${n}" aria-label="Перейти к реплике #${n}">
      <span class="cv-ev-ref">#${n} · ${esc(SPEAKER[sp] || m.speaker)}${t !== null ? ` · ${esc(t)}` : m.timestamp ? ` · ${esc(fmtTs(m.timestamp))}` : ""}</span>
      <span class="cv-ev-q">${esc(m.text)}</span></button>`;
  }).join("");
  return chips ? `<div class="cv-sub-h">Реплики-доказательства</div><div class="cv-ev-list">${chips}</div>` : "";
}

/** A criterion row (collapsed header + expandable body). */
export function critHtml({ row, crit, srow, orow, appeals, msgs, rel, canAppeal, open }) {
  if (!crit) return "";
  const ic = iconFor(crit, row.answer);
  const pts = pointsLabel(crit, row, srow);
  const openAppeal = appeals.find((a) => a.status === "open");
  const cid = esc(crit.id);
  const range = row.checked_range
    ? `<div class="cv-note cv-note-range"><b>Проверенный участок:</b>
        <button type="button" class="cv-link" data-msg="${row.checked_range[0]}">#${row.checked_range[0]}</button>–<button type="button" class="cv-link" data-msg="${row.checked_range[1]}">#${row.checked_range[1]}</button>
        ${row.answer === "no" ? " — ожидаемое действие здесь не найдено" : ""}</div>` : "";
  let review = "";
  if (row.review) {
    const who = row.review.reviewer ? ` · ${esc(row.review.reviewer)}` : "";
    review = row.review.confirmed
      ? `<div class="cv-review is-confirmed"><div class="cv-review-h">✔ Оценка подтверждена проверяющим${who}</div>
          <div class="cv-review-r">${esc(row.review.reason)}</div></div>`
      : `<div class="cv-review is-changed"><div class="cv-review-h">✎ Изменено проверяющим${who}</div>
          <div class="cv-review-ft">
            <span class="cv-was"><small>Модель</small>${esc(answerView(crit, row.review.from).label)}${orow && orow.points !== null && orow.points !== undefined ? ` · ${fmtNum(orow.points)} б.` : ""}</span>
            <span class="cv-arrow" aria-hidden="true">→</span>
            <span class="cv-now"><small>Итог</small>${esc(answerView(crit, row.review.to).label)}${srow && srow.points !== null && srow.points !== undefined ? ` · ${fmtNum(srow.points)} б.` : ""}</span>
          </div>
          <div class="cv-review-r">Причина: ${esc(row.review.reason)}</div></div>`;
  }
  const apps = appeals.map((a) => `
    <div class="cv-note cv-note-appeal ${a.status === "open" ? "is-open" : ""}">
      <span>${a.status === "open" ? "⏳ Апелляция на рассмотрении" : a.status === "changed" ? "Апелляция: оценка изменена" : "Апелляция: оценка подтверждена"}
      — «${esc(a.comment)}»</span> <a href="#/appeals/${a.id}">Апелляция #${a.id} →</a></div>`).join("");
  const ref = firstRef(row);
  return `
    <div class="cv-crit ${open ? "is-open" : ""}" data-crit="${cid}">
      <button type="button" class="cv-crit-top" data-toggle="${cid}" aria-expanded="${open ? "true" : "false"}" aria-controls="cvc-${cid}">
        <span class="cv-ic cv-k-${ic.kind}" aria-hidden="true">${esc(ic.icon)}</span>
        <span class="cv-crit-main">
          <span class="cv-crit-title">${crit.code ? `<span class="cv-code">${esc(crit.code)}</span>` : ""}${esc(crit.title)}</span>
          <span class="cv-crit-sub">${pts.sub}
            ${openAppeal ? `<span class="cv-tag is-warn">апелляция</span>` : ""}${row.review ? `<span class="cv-tag is-brand">${row.review.confirmed ? "подтверждено" : "пересмотрено"}</span>` : ""}</span>
        </span>
        <span class="cv-crit-pts">${pts.main}</span>
        <span class="cv-chev" aria-hidden="true"></span>
      </button>
      <div class="cv-crit-body" id="cvc-${cid}" ${open ? "" : "hidden"}>
        <p class="cv-expl">${esc(row.explanation || "—")}</p>
        ${row.answer === "na" && row.na_reason ? `<div class="cv-note cv-note-na"><b>Почему N/A:</b> ${esc(row.na_reason)}</div>` : ""}
        ${evidenceHtml(row, msgs, rel)}
        ${range}
        ${row.warning ? `<div class="cv-note cv-note-warn">⚠ ${esc(row.warning)}</div>` : ""}
        ${review}
        ${apps}
        <div class="cv-crit-actions">
          ${ref ? `<button type="button" class="btn btn-sm" data-jump="${cid}">Перейти к фрагменту</button>` : ""}
          ${canAppeal && !openAppeal ? `<button type="button" class="btn btn-sm cv-btn-appeal" data-appeal="${cid}">Оспорить оценку</button>` : ""}
        </div>
      </div>
    </div>`;
}

/** "Почему снижена оценка": criteria that lost points, biggest loss first. */
export function lossesHtml({ ev, critCfg, scoreRows, appealsBy, expanded }) {
  const items = ev.final_criteria
    .map((row) => ({ row, crit: critCfg[row.criterion_id], s: scoreRows[row.criterion_id] }))
    .filter(({ crit, row, s }) => crit && crit.type !== "critical" && row.answer !== "na" && s && s.max_points !== null && s.points !== null && s.max_points - s.points > 0.001)
    .map((x) => ({ ...x, loss: x.s.max_points - x.s.points }))
    .sort((a, b) => b.loss - a.loss);
  if (!items.length) return "";
  const total = items.reduce((acc, x) => acc + x.loss, 0);
  const LIMIT = 3;
  const shown = expanded ? items : items.slice(0, LIMIT);
  return `
    <section class="cv-why" aria-label="Почему снижена оценка">
      <div class="cv-why-head"><h3>Почему снижена оценка</h3>
        <span class="cv-why-sum">−${fmtNum(total)} балл. · ${items.length} ${plural(items.length, "критерий", "критерия", "критериев")}</span></div>
      <ul class="cv-why-list">
        ${shown.map(({ row, crit, s, loss }) => {
          const ic = iconFor(crit, row.answer);
          const open = (appealsBy[crit.id] || []).some((a) => a.status === "open");
          const ref = firstRef(row);
          return `
          <li class="cv-why-item">
            <span class="cv-ic cv-k-${ic.kind}" aria-hidden="true">${esc(ic.icon)}</span>
            <div class="cv-why-main">
              <div class="cv-why-title">
                <button type="button" class="cv-link cv-why-name" data-open="${esc(crit.id)}">${crit.code ? `<span class="cv-code">${esc(crit.code)}</span>` : ""}${esc(crit.title)}</button>
                <span class="cv-why-pts">${fmtNum(s.points)} / ${fmtNum(s.max_points)} <b>−${fmtNum(loss)}</b></span>
              </div>
              <p class="cv-why-text">${esc(shortReason(crit, row) || "—")}</p>
              <div class="cv-why-actions">
                ${ref ? `<button type="button" class="btn btn-sm" data-jump="${esc(crit.id)}">Перейти к фрагменту${row.evidence && row.evidence[0] ? ` #${row.evidence[0]}` : ""}</button>` : ""}
                ${open ? `<span class="cv-tag is-warn">апелляция на рассмотрении</span>` : `<button type="button" class="btn btn-sm cv-btn-appeal" data-appeal="${esc(crit.id)}">Оспорить оценку</button>`}
              </div>
            </div>
          </li>`;
        }).join("")}
      </ul>
      ${items.length > LIMIT ? `<button type="button" class="cv-more" data-more>${expanded ? "Свернуть" : `Показать все (${items.length})`}</button>` : ""}
    </section>`;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function metaHtml(ev) {
  const parts = [`Оценка #${ev.id}`];
  if (ev.model) parts.push(`${esc(ev.model)}${ev.provider === "mock" ? " (mock)" : ""}`);
  if (ev.usage) parts.push(`${fmtNum(ev.usage.input_tokens, 0)} вх. / ${fmtNum(ev.usage.output_tokens, 0)} вых. токенов`);
  if (ev.cost_usd !== null && ev.cost_usd !== undefined) parts.push(`≈ $${fmtNum(ev.cost_usd, 4)}`);
  if (ev.duration_ms) parts.push(`${fmtNum(ev.duration_ms / 1000, 1)} с`);
  if (ev.finished_at) parts.push(esc(fmtDate(ev.finished_at)));
  return `<div class="cv-meta">${parts.map((p) => `<span>${p}</span>`).join("")}</div>`;
}

const STAGES = [
  [0, "Готовим диалог и чек-лист"],
  [2, "Модель читает реплики"],
  [7, "Сверяет диалог с критериями"],
  [15, "Формирует объяснения и ссылки на реплики"],
  [24, "Почти готово — считаем баллы"],
];

/** Loading view while the LLM evaluation runs (~10–30 s). Returns { html, update(elapsedSec) } helper. */
export function loadingHtml({ messages, criteria }) {
  return `
    <div class="cv-loading" role="status" aria-live="polite">
      <div class="cv-ld-top">
        <div class="cv-ld-orb" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="cv-ld-text">
          <b data-ld="stage">${esc(STAGES[0][1])}…</b>
          <div class="cv-ld-sub"><span data-ld="sec">0</span> с · обычно 10–30 с · ${messages} ${plural(messages, "реплика", "реплики", "реплик")}${criteria ? `, ${criteria} ${plural(criteria, "критерий", "критерия", "критериев")}` : ""}</div>
        </div>
      </div>
      <div class="cv-ld-bar" aria-hidden="true"><i></i></div>
      <ol class="cv-ld-steps">
        ${STAGES.map(([, s], i) => `<li data-step="${i}">${esc(s)}</li>`).join("")}
      </ol>
      <div class="cv-skel" aria-hidden="true">
        ${Array.from({ length: 6 }, (_, i) => `<div class="cv-skel-row"><i class="sq"></i><i class="ln" style="width:${55 + ((i * 17) % 35)}%"></i><i class="pt"></i></div>`).join("")}
      </div>
    </div>`;
}

export function updateLoading(root, sec) {
  const box = root.querySelector(".cv-loading");
  if (!box) return;
  let idx = 0;
  STAGES.forEach(([t], i) => { if (sec >= t) idx = i; });
  box.querySelector("[data-ld=sec]").textContent = String(Math.floor(sec));
  box.querySelector("[data-ld=stage]").textContent = `${STAGES[idx][1]}…`;
  box.querySelectorAll("[data-step]").forEach((li) => {
    const i = Number(li.dataset.step);
    li.className = i < idx ? "is-done" : i === idx ? "is-now" : "";
  });
}
