// HTML builders for the "Оценка качества" panel (pure functions, no DOM state).
import { esc, fmtNum, fmtDate, fmtTs, answerView, SPEAKER } from "../util.js";
import { cvIcon, answerGlyph } from "./icons.js";

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

/** Label + kind for a criterion answer (kind: yes / no / part / na). */
export function iconFor(crit, answer) {
  const av = answerView(crit, answer);
  if (answer === "na") return { ...av, icon: "N/A" };
  return av;
}

/** Answer badge: shape (✓ ✕ – N/A !) + colour, so the state never depends on colour alone. */
export function icHtml(crit, answer, cls = "") {
  const ic = iconFor(crit, answer);
  const critical = crit && crit.type === "critical" && answer === "yes";
  return `<span class="cv-ic cv-k-${critical ? "crit" : ic.kind} ${cls}" aria-hidden="true">${answerGlyph(ic.kind, { critical })}</span>`;
}

/** Compact total for the page header (mobile / single-column: the score panel is far below). */
export function scoreBadgeHtml(total, { revised = false } = {}) {
  const has = total !== null && total !== undefined;
  const v = has ? Number(total) : 0;
  const tone = !has ? "none" : v >= 85 ? "hi" : v >= 65 ? "mid" : "lo";
  return `<a class="cv-sbadge cv-tone-${tone}" href="#eval-panel" data-goto-score aria-label="Итог ${has ? fmtNum(total) : "не рассчитан"} из 100${revised ? ", после пересмотра" : ""}. Перейти к оценке">
    <b>${has ? fmtNum(total) : "—"}</b><span>/ 100${revised ? " · пересмотрено" : ""}</span></a>`;
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

/** Same answer regardless of representation: 20 / 20.0 / "20" for scale steps; yes / no / na as is. */
function sameAnswer(a, b) {
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const x = num(a), y = num(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
}

/** True when reviewers left this criterion with an answer different from the model's original one. */
export const isRevised = (row, orow) => !!(row && orow && !sameAnswer(orow.answer, row.answer));

export function changeReview(row, original) {
  if (!isRevised(row, original)) return null;
  const history = row.reviews || (row.review ? [row.review] : []);
  return history.findLast((decision) => !decision.confirmed) || null;
}

const pointsLabel = (crit, row, srow) => {
  const av = answerView(crit, row.answer);
  if (crit.type === "critical") return { main: `<span class="cv-pill ${row.answer === "yes" ? "is-crit" : "is-ok"}">${esc(av.label)}</span>`, sub: "без баллов" };
  if (row.answer === "na") return { main: `<span class="cv-pill is-na">N/A</span>`, sub: `<b class="cv-ans cv-ans-na">Не применимо</b> · вес ${fmtNum(crit.weight)} перераспределён` };
  const redistributed = srow && srow.max_points !== null && Math.abs(srow.max_points - crit.weight) > 0.001;
  return {
    main: `${fmtNum(srow?.points)}<span class="cv-of"> / ${fmtNum(srow?.max_points)}</span>`,
    sub: `<b class="cv-ans cv-ans-${av.kind}">${esc(av.label)}</b> · вес ${fmtNum(crit.weight)}${redistributed ? ` → ${fmtNum(srow.max_points)}` : ""}`,
  };
};

function evidenceHtml(row, msgs, rel) {
  const hasQuotes = Array.isArray(row.evidence_quotes);
  const quotes = hasQuotes ? row.evidence_quotes : (row.evidence || []).map((turn) => ({ turn }));
  const chips = quotes.map(({ turn: n, quote, issue }) => {
    const m = msgs[n - 1];
    if (!m && !issue) return "";
    const sp = String(m?.speaker || "").toLowerCase();
    const t = rel && rel[n - 1] !== null && rel[n - 1] !== undefined ? rel[n - 1] : null;
    const ref = m ? `#${n} · ${esc(SPEAKER[sp] || m.speaker)}${t !== null ? ` · ${esc(t)}` : m.timestamp ? ` · ${esc(fmtTs(m.timestamp))}` : ""}` : "Реплика недоступна";
    if (issue) return `<div class="cv-ev is-unverified">
      <span class="cv-ev-ref">${m ? `<button type="button" class="cv-link" data-msg="${n}">${ref}</button>` : ref}</span>
      ${quote ? `<span class="cv-ev-q">«${esc(quote)}»</span>` : ""}
      <span class="cv-ev-issue">${esc(issue)}</span>
    </div>`;
    return `<button type="button" class="cv-ev cv-ev-${esc(sp)}" data-msg="${n}" aria-label="Перейти к реплике #${n}">
      <span class="cv-ev-ref">${ref}${hasQuotes ? " · Цитата сверена" : ""}</span>
      <span class="cv-ev-q">${hasQuotes ? `«${esc(quote)}»` : esc(m.text)}</span></button>`;
  }).join("");
  const empty = row.evidence_review && !chips ? `<div class="cv-note cv-note-warn">${esc(row.evidence_review)}</div>` : "";
  return chips ? `<div class="cv-sub-h">${hasQuotes ? "Цитаты из оценки" : "Реплики из оценки"}</div><div class="cv-ev-list">${chips}</div>` : empty;
}

/** A criterion row (collapsed header + expandable body). */
export function critHtml({ row, crit, srow, orow, appeals, msgs, rel, canAppeal, open }) {
  if (!crit) return "";
  const pts = pointsLabel(crit, row, srow);
  const openAppeal = appeals.find((a) => a.status === "open");
  const revised = isRevised(row, orow);
  const modelAnswer = orow?.answer ?? row.answer;
  const cid = esc(crit.id);
  const range = row.checked_range
    ? `<div class="cv-note cv-note-range"><b>Проверенный участок:</b>
        <button type="button" class="cv-link" data-msg="${row.checked_range[0]}">#${row.checked_range[0]}</button>–<button type="button" class="cv-link" data-msg="${row.checked_range[1]}">#${row.checked_range[1]}</button>
        ${modelAnswer === "no" ? " — ожидаемое действие здесь не найдено" : ""}</div>` : "";
  // Older rows carry only `review` (latest decision); newer ones also keep the full `reviews` history.
  const reviews = row.reviews || (row.review ? [row.review] : []);
  const last = reviews[reviews.length - 1];
  const decision = changeReview(row, orow) || last;
  let review = "";
  if (decision) {
    const who = decision.reviewer ? ` · ${esc(decision.reviewer)}` : "";
    const head = revised ? `${cvIcon("edit")}Изменено проверяющим`
      : last.confirmed ? `${cvIcon("shield")}Оценка подтверждена проверяющим` : `${cvIcon("undo")}Возвращён ответ модели`;
    review = `<div class="cv-review ${revised ? "is-changed" : "is-confirmed"}"><div class="cv-review-h">${head}${who}</div>
        ${revised ? `<div class="cv-review-ft">
          <span class="cv-was"><small>Модель</small>${esc(answerView(crit, orow.answer).label)}${orow.points !== null && orow.points !== undefined ? ` · ${fmtNum(orow.points)} б.` : ""}</span>
          ${cvIcon("arrowRight", { cls: "cv-arrow" })}
          <span class="cv-now"><small>Итог</small>${esc(answerView(crit, row.answer).label)}${srow && srow.points !== null && srow.points !== undefined ? ` · ${fmtNum(srow.points)} б.` : ""}</span>
        </div>` : ""}
        <div class="cv-review-r">${revised ? "Причина: " : ""}${esc(decision.reason)}</div>
        ${reviews.length > 1 ? `<div class="cv-review-r">Решений по критерию: ${reviews.length}, история — в апелляциях ниже</div>` : ""}</div>`;
  }
  const apps = appeals.map((a) => `
    <div class="cv-note cv-note-appeal ${a.status === "open" ? "is-open" : ""}">
      ${cvIcon(a.status === "open" ? "hourglass" : "scale")}
      <span class="cv-note-appeal-t"><b>${a.status === "open" ? "Апелляция на рассмотрении" : a.status === "changed" ? "Апелляция: оценка изменена" : "Апелляция: оценка подтверждена"}</b>
      «${esc(a.comment)}»</span> <a href="#/appeals/${a.id}">Апелляция #${a.id}</a></div>`).join("");
  const ref = firstRef(row);
  return `
    <div class="cv-crit ${open ? "is-open" : ""}" data-crit="${cid}">
      <button type="button" class="cv-crit-top" data-toggle="${cid}" aria-expanded="${open ? "true" : "false"}" aria-controls="cvc-${cid}">
        ${icHtml(crit, row.answer)}
        <span class="cv-crit-main">
          <span class="cv-crit-title">${crit.code ? `<span class="cv-code">${esc(crit.code)}</span>` : ""}${esc(crit.title)}</span>
          <span class="cv-crit-sub">${pts.sub}
            ${row.evidence_review ? `<span class="cv-tag is-warn">${cvIcon("alert")}требует проверки</span>` : ""}${openAppeal ? `<span class="cv-tag is-warn">${cvIcon("hourglass")}апелляция</span>` : ""}${last ? `<span class="cv-tag is-brand">${revised ? "пересмотрено" : last.confirmed ? "подтверждено" : "ответ модели восстановлен"}</span>` : ""}</span>
        </span>
        <span class="cv-crit-pts">${pts.main}</span>
        <span class="cv-chev" aria-hidden="true"></span>
      </button>
      <div class="cv-crit-body" id="cvc-${cid}" ${open ? "" : "hidden"}>
        ${review}
        ${revised
          ? `<p class="cv-expl cv-expl-model"><span class="cv-expl-k">Объяснение модели (до пересмотра, ответ «${esc(answerView(crit, modelAnswer).label)}»):</span> ${esc(row.explanation || "—")}</p>`
          : last ? `<p class="cv-expl cv-expl-model"><span class="cv-expl-k">Объяснение модели:</span> ${esc(row.explanation || "—")}</p>`
          : `<p class="cv-expl">${esc(row.explanation || "—")}</p>`}
        ${modelAnswer === "na" && row.na_reason ? `<div class="cv-note cv-note-na"><b>Почему N/A:</b> ${esc(row.na_reason)}</div>` : ""}
        ${evidenceHtml(row, msgs, rel)}
        ${range}
        ${row.warning ? `<div class="cv-note cv-note-warn">${cvIcon("alert")}<span>${esc(row.warning)}</span></div>` : ""}
        ${apps}
        <div class="cv-crit-actions">
          ${ref ? `<button type="button" class="btn btn-sm" data-jump="${cid}">${cvIcon("target")}Показать в диалоге</button>` : ""}
          ${canAppeal && !openAppeal ? `<button type="button" class="btn btn-sm cv-btn-appeal" data-appeal="${cid}">${cvIcon("scale")}Оспорить оценку</button>` : ""}
        </div>
      </div>
    </div>`;
}

/** Criteria that lost points, biggest loss first. */
export function lossItems(ev, critCfg, scoreRows) {
  return ev.final_criteria
    .map((row) => ({ row, crit: critCfg[row.criterion_id], s: scoreRows[row.criterion_id] }))
    .filter(({ crit, row, s }) => crit && crit.type !== "critical" && row.answer !== "na" && s && s.max_points !== null && s.points !== null && s.max_points - s.points > 0.001)
    .map((x) => ({ ...x, loss: x.s.max_points - x.s.points }))
    .sort((a, b) => b.loss - a.loss);
}

export function lossesHtml({ ev, critCfg, scoreRows, appealsBy, expanded }) {
  const items = lossItems(ev, critCfg, scoreRows);
  if (!items.length) return "";
  const origRows = Object.fromEntries(ev.score.criteria.map((r) => [r.criterion_id, r]));
  const total = items.reduce((acc, x) => acc + x.loss, 0);
  const LIMIT = 3;
  const shown = expanded ? items : items.slice(0, LIMIT);
  return `
    <section class="cv-why" aria-label="Почему снижена оценка">
      <div class="cv-why-head"><h3>Почему снижена оценка</h3>
        <span class="cv-why-sum">−${fmtNum(total)} балл. · ${items.length} ${plural(items.length, "критерий", "критерия", "критериев")}</span></div>
      <ul class="cv-why-list">
        ${shown.map(({ row, crit, s, loss }) => {
          const open = (appealsBy[crit.id] || []).some((a) => a.status === "open");
          const decision = changeReview(row, origRows[crit.id]);
          const ref = decision ? null : firstRef(row);
          const rv = decision;
          return `
          <li class="cv-why-item">
            ${icHtml(crit, row.answer)}
            <div class="cv-why-main">
              <div class="cv-why-title">
                <button type="button" class="cv-link cv-why-name" data-open="${esc(crit.id)}">${crit.code ? `<span class="cv-code">${esc(crit.code)}</span>` : ""}${esc(crit.title)}</button>
                <span class="cv-why-pts">${fmtNum(s.points)} / ${fmtNum(s.max_points)} <b>−${fmtNum(loss)}</b></span>
              </div>
              ${rv ? `
              <p class="cv-why-review">
                <span class="cv-tag is-brand">${cvIcon("edit")}пересмотрено: ${esc(answerView(crit, origRows[crit.id]?.answer).label)} → ${esc(answerView(crit, row.answer).label)}</span>
                <span class="cv-why-reason">${esc(rv.reason || "")}</span></p>
              <p class="cv-why-text cv-why-model"><span class="cv-expl-k">Модель (до пересмотра):</span> ${esc(shortReason(crit, row) || "—")}</p>`
              : `<p class="cv-why-text">${esc(shortReason(crit, row) || "—")}</p>`}
              <div class="cv-why-actions">
                ${ref ? `<button type="button" class="btn btn-sm" data-jump="${esc(crit.id)}">${cvIcon("target")}Показать в диалоге${row.evidence && row.evidence[0] ? ` #${row.evidence[0]}` : ""}</button>` : ""}
                ${open ? `<span class="cv-tag is-warn">${cvIcon("hourglass")}апелляция на рассмотрении</span>` : rv ? "" : `<button type="button" class="btn btn-sm cv-btn-appeal" data-appeal="${esc(crit.id)}">${cvIcon("scale")}Оспорить оценку</button>`}
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
