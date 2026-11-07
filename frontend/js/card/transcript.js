// Chat-style transcript rendering shared by the conversation card, the appeal page and #/verify.
// Operator and client are bubbles on opposite sides; bot / system messages are
// subtle centred context rows. Consecutive runs of context messages collapse into one
// expandable row ("Бот и система · 3 сообщения") — they are context, not the conversation.
// Collapsed messages stay in the DOM (ids, #N numbering, evidence classes keep working);
// callers use revealMsg() to open a run before highlighting / scrolling to a message inside it.
// All external text goes through esc().
import { esc, fmtClock, fmtTs, SPEAKER } from "../util.js";
import { cvIcon, scrollBehavior } from "./icons.js";

export const speakerKind = (sp) => {
  const s = String(sp || "").toLowerCase();
  return s === "client" || s === "operator" || s === "bot" || s === "system" ? s : "other";
};

const isContext = (k) => k === "bot" || k === "system" || k === "other";

/**
 * One transcript message.
 * opts: { sec: seconds from start (calls), playable: show ▶ button, cls: extra classes, idPrefix }
 */
export function msgHtml(m, n, { sec = null, playable = false, cls = "", idPrefix = "msg-" } = {}) {
  const k = speakerKind(m.speaker);
  const who = SPEAKER[k] || m.speaker || "—";
  const ts = m.timestamp ? `<span class="cv-ts" title="${esc(m.timestamp)}">${esc(fmtTs(m.timestamp))}</span>` : "";
  const play = playable && sec !== null && sec !== undefined
    ? `<button type="button" class="cv-play" data-play="${n}" aria-label="Прослушать реплику #${n} с ${fmtClock(sec)}">${cvIcon("play")}<span>${fmtClock(sec)}</span></button>`
    : "";
  if (isContext(k)) {
    return `
      <div class="cv-msg cv-ctx cv-sp-${k} ${cls}" id="${idPrefix}${n}" data-n="${n}" data-sp="${k}">
        <div class="cv-ctx-in">
          <span class="cv-n">#${n}</span><span class="cv-who">${esc(who)}</span>
          <span class="cv-ctx-text">${esc(m.text)}</span>${ts}${play}
        </div>
      </div>`;
  }
  return `
    <div class="cv-msg cv-sp-${k} ${cls}" id="${idPrefix}${n}" data-n="${n}" data-sp="${k}">
      <div class="cv-bubble">
        <div class="cv-mhead"><span class="cv-n">#${n}</span><span class="cv-who">${esc(who)}</span>${ts}${play}</div>
        <div class="cv-text">${esc(m.text)}</div>
      </div>
    </div>`;
}

const LONG_CTX = 160; // a single context message longer than this also collapses

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/**
 * The whole transcript with context runs collapsed.
 * opts: { secs: per-message seconds (calls), playable, idPrefix, clsFor(n) -> extra classes,
 *         expand(n) -> true when a run containing message n must start expanded }
 */
export function transcriptHtml(msgs, { secs = null, playable = false, idPrefix = "msg-", clsFor = null, expand = null } = {}) {
  const one = (m, i) => msgHtml(m, i + 1, { sec: secs ? secs[i] : null, playable, idPrefix, cls: clsFor ? clsFor(i + 1) : "" });
  let html = "";
  let runNo = 0;
  for (let i = 0; i < msgs.length;) {
    if (!isContext(speakerKind(msgs[i].speaker))) { html += one(msgs[i], i); i++; continue; }
    let j = i;
    while (j < msgs.length && isContext(speakerKind(msgs[j].speaker))) j++;
    const run = msgs.slice(i, j);
    const long = run.some((m) => String(m.text || "").length > LONG_CTX);
    if (run.length < 2 && !long) { html += one(msgs[i], i); i = j; continue; }
    const from = i + 1, to = j;
    const kinds = new Set(run.map((m) => speakerKind(m.speaker)));
    const who = kinds.size === 1 && kinds.has("bot") ? "Бот" : kinds.size === 1 && kinds.has("system") ? "Система" : "Бот и система";
    const open = !!(expand && run.some((_, k) => expand(from + k)));
    const id = `${idPrefix}run-${++runNo}`;
    const first = String(run[0].text || "").replace(/\s+/g, " ").trim();
    html += `
      <div class="cv-run ${open ? "is-auto" : "is-collapsed"}" data-run="${runNo}" data-from="${from}" data-to="${to}">
        <button type="button" class="cv-run-toggle" data-run-toggle aria-expanded="${open}" aria-controls="${id}">
          ${cvIcon("bot", { cls: "cv-run-ic" })}
          <span class="cv-run-main">
            <span class="cv-run-label">${who} · ${run.length} ${plural(run.length, "сообщение", "сообщения", "сообщений")}
              <span class="cv-run-range">${from === to ? `#${from}` : `#${from}–#${to}`}</span></span>
            <span class="cv-run-prev">${esc(first)}</span>
          </span>
          <span class="cv-run-act"><span class="cv-run-show">Показать</span><span class="cv-run-hide">Свернуть</span>${cvIcon("down", { cls: "cv-run-chev" })}</span>
        </button>
        <div class="cv-run-body" id="${id}">${run.map((m, k) => one(m, i + k)).join("")}</div>
      </div>`;
    i = j;
  }
  return html;
}

function setRun(run, open, how) {
  run.classList.toggle("is-collapsed", !open);
  run.classList.toggle("is-auto", open && how === "auto");
  run.querySelector(".cv-run-toggle").setAttribute("aria-expanded", String(open));
}

/** Open the collapsed run that contains `el` (a .cv-msg). Returns true if something opened. */
export function revealMsg(el) {
  const run = el && el.closest(".cv-run.is-collapsed");
  if (!run) return false;
  setRun(run, true, "auto");
  return true;
}

/** Re-collapse runs that were opened automatically and hold no message from `keep` (Set of n). */
export function collapseAuto(box, keep = new Set()) {
  if (!box) return;
  box.querySelectorAll(".cv-run.is-auto").forEach((run) => {
    const from = Number(run.dataset.from), to = Number(run.dataset.to);
    for (const n of keep) if (n >= from && n <= to) return;
    setRun(run, false);
  });
}

/** The collapsible run that holds message `n`, if any. */
export function runOf(box, n) {
  if (!box) return null;
  return [...box.querySelectorAll(".cv-run")].find((r) => n >= Number(r.dataset.from) && n <= Number(r.dataset.to)) || null;
}

/** Click-to-toggle for run headers inside `box` (safe to call repeatedly). */
export function bindRuns(box) {
  if (!box || box.dataset.runsBound) return;
  box.dataset.runsBound = "1";
  box.addEventListener("click", (e) => {
    const t = e.target.closest("[data-run-toggle]");
    if (!t || !box.contains(t)) return;
    const run = t.closest(".cv-run");
    setRun(run, run.classList.contains("is-collapsed"), "user");
  });
}

/** Scroll `el` into view inside its scrollable `box` only (never moves the page). */
export function scrollInBox(box, el, { center = true, smooth = true } = {}) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  const delta = center ? r.top - b.top - (b.height - r.height) / 2 : r.top < b.top ? r.top - b.top - 8 : r.bottom > b.bottom ? r.bottom - b.bottom + 8 : 0;
  if (Math.abs(delta) < 2) return;
  box.scrollTo({ top: box.scrollTop + delta, behavior: smooth ? scrollBehavior() : "auto" });
}
