// Conversation card: transcript (chat), call player with a speaker timeline,
// the evaluation panel (score ring, why the score dropped, criteria, appeals)
// and the regulation check below.
// Deep link: #/conversation/<id>?eval=<id>&crit=<criterionId>&msg=<n>&checklist=<id>&compare=<evalId>
import { api } from "../api.js";
import { esc, $, $$, fmtNum, fmtDate, toast, busy, modal, answerView, tsSeconds, fmtClock, LANG, CHANNEL, icon } from "../util.js";
import { refreshBadge } from "../app.js";
import { createPlayer, buildSegments, audioTimeline } from "../card/player.js";
import { transcriptHtml, scrollInBox, revealMsg, collapseAuto, bindRuns } from "../card/transcript.js";
import { mountRegulation } from "../card/regulation.js";
import { ringHtml, critHtml, lossesHtml, lossItems, metaHtml, loadingHtml, updateLoading, firstRef, plural, icHtml, scoreBadgeHtml, isRevised, changeReview } from "../card/score.js";
import { cvIcon, scrollBehavior } from "../card/icons.js";

let ctx = null;

const FILTERS = [
  { key: "all", label: "Все" },
  { key: "client", label: "Клиент" },
  { key: "operator", label: "Оператор" },
  { key: "ctx", label: "Бот и система" },
];

export async function render(root, params, query) {
  const [conv, checklists] = await Promise.all([api.conversation(params.id), api.checklists()]);
  // Superseded by a newer navigation: the router already detached this host.
  if (!root.isConnected) return undefined;
  const first = conv.transcript[0]?.timestamp;
  const seconds = conv.transcript.map((m) => tsSeconds(m.timestamp, first));
  const known = seconds.filter((s) => s !== null && s !== undefined);
  const duration = known.length ? Math.max(...known) : null;
  const isCall = conv.channel === "voice call" || !!conv.audio_url;
  const history = conv.evaluations.find((ev) => ev.id === Number(query.eval)) || conv.evaluations[0];
  const selected = checklists.find((c) => c.id === Number(query.checklist))
    || checklists.find((c) => c.is_active) || checklists[0];
  const hasCtx = conv.transcript.some((m) => !["client", "operator"].includes(String(m.speaker || "").toLowerCase()));

  // For calls, message positions are in recording time (start / cut pause / lead), not transcript time.
  const clock = (arr) => arr.map((s) => (s === null || s === undefined ? null : fmtClock(s)));
  const audioSec = isCall && conv.audio_url ? audioTimeline(conv.transcript, seconds, null) : seconds;
  ctx = {
    root, conv, checklists, seconds: audioSec, isCall, evaluation: null, player: null,
    checklistId: selected ? selected.id : null, pinnedChecklist: !!query.checklist, clCache: new Map(),
    openCrit: query.crit || null, compareId: Number(query.compare) || null,
    whyExpanded: false, followUntil: 0, loadingTimer: null, pollTimer: null,
    rel: isCall ? clock(audioSec) : null, keep: new Set(),
  };
  const mine = ctx;
  const cleanup = () => {
    if (mine.regulation) mine.regulation();
    if (mine.player) mine.player.destroy();
    clearInterval(mine.loadingTimer);
    clearTimeout(mine.pollTimer);
    if (ctx === mine) ctx = null;
  };

  const chan = CHANNEL[conv.channel] || conv.channel || (isCall ? "Звонок" : "Чат");
  const n = conv.transcript.length;
  root.innerHTML = `
    <div class="cv-page">
    <div class="crumbs"><a href="#/conversations">Разговоры</a> / ${esc(conv.title?.trim() || (isCall ? "Разбор звонка" : "Разбор чата"))}</div>
    <header class="cv-head">
      <div class="cv-id">
        <span class="cv-id-ic cv-id-${isCall ? "call" : "chat"}" aria-hidden="true">${cvIcon(isCall ? "phone" : "chat")}</span>
        <div class="cv-id-main">
          <h1 class="cv-id-title"><span class="cv-sr">${esc(chan)} </span>${esc(conv.id)}</h1>
          <ul class="cv-facts" aria-label="О диалоге">
            <li>${cvIcon(isCall ? "phone" : "chat")}${esc(chan)}</li>
            ${conv.language ? `<li>${cvIcon("globe")}${esc(LANG[conv.language] || conv.language)}</li>` : ""}
            ${duration ? `<li title="${isCall ? "Длительность разговора по меткам расшифровки; запись звонка может быть длиннее" : "Длительность по меткам времени"}">${cvIcon("clock")}${isCall ? "разговор " : ""}${fmtClock(duration)}</li>` : ""}
            <li>${cvIcon("msgs")}${n} ${plural(n, "реплика", "реплики", "реплик")}</li>
            ${conv.dataset_group ? `<li title="Набор данных">${cvIcon("list")}набор ${esc(conv.dataset_group)}</li>` : ""}
          </ul>
        </div>
      </div>
      <div class="cv-head-score" id="cv-head-score"></div>
      <div class="cv-eval-ctl" id="cv-eval-ctl"></div>
    </header>
    <div id="cv-version-ready" class="qa-handoff" hidden></div>
    ${isCall ? `<div id="cv-player-host"></div>` : ""}
    <div class="cv-grid" id="cv-grid">
      <section class="card cv-tr-card" aria-label="Расшифровка">
        <div class="card-head cv-tr-head">
          <h2>Расшифровка</h2><div class="spacer"></div>
          <div class="cv-filter" role="group" aria-label="Показать реплики">
            ${FILTERS.filter((f) => f.key !== "ctx" || hasCtx).map((f) => `<button type="button" data-filter="${f.key}" aria-pressed="${f.key === "all"}">${esc(f.label)}</button>`).join("")}
          </div>
        </div>
        <div class="cv-tr-ctx" id="cv-tr-ctx" hidden></div>
        <div class="cv-transcript" id="transcript" data-filter="all" tabindex="0" aria-label="Реплики диалога">
          ${transcriptHtml(conv.transcript, { secs: audioSec, playable: isCall && !!conv.audio_url })}
        </div>
        <button type="button" class="cv-follow" id="cv-follow" hidden>${cvIcon("arrowDown")}К текущей реплике</button>
      </section>
      <section class="card cv-ev-card" id="eval-panel" aria-label="Оценка качества" tabindex="-1"></section>
    </div>
    <section class="card cv-reg-card" id="cv-reg" aria-label="Сверка с регламентом"></section>
    </div>`;

  const tr = $("#transcript", root);
  bindRuns(tr);
  tr.addEventListener("click", (e) => {
    const p = e.target.closest("[data-play]");
    if (p) playAt(Number(p.dataset.play));
  });
  // Manual scrolling pauses karaoke auto-follow for a few seconds.
  const pauseFollow = () => { if (ctx) ctx.followUntil = Date.now() + 6000; };
  ["wheel", "touchmove", "keydown", "mousedown"].forEach((t) => tr.addEventListener(t, pauseFollow, { passive: true }));
  $("#cv-follow", root).addEventListener("click", () => {
    ctx.followUntil = 0;
    $("#cv-follow", root).hidden = true;
    const el = playingEl();
    if (el) scrollInBox(tr, el);
  });
  $$("[data-filter]", root).forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));
  $("#cv-tr-ctx", root).addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) toggleCrit(ctx.openCrit);
  });
  // Evaluation controls live either in the header (re-evaluate) or in the empty panel (first run).
  root.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-sel-checklist]");
    if (!sel || !ctx) return;
    ctx.checklistId = Number(sel.value);
    ctx.pinnedChecklist = true;
    $$("[data-sel-checklist]", root).forEach((s) => { if (s !== sel) s.value = sel.value; });
    if (!ctx.evaluation) paintPreview();
    updateChecklistControls();
  });
  root.addEventListener("click", (e) => {
    const run = e.target.closest("[data-run-eval]");
    if (run) { runEvaluation(run); return; }
    const go = e.target.closest("[data-goto-score]");
    if (go) {
      e.preventDefault();
      const panel = $("#eval-panel", root);
      panel.scrollIntoView({ block: "start", behavior: scrollBehavior() });
      panel.focus({ preventScroll: true });
    }
  });

  if (isCall) {
    const mineCtx = ctx;
    ctx.player = createPlayer($("#cv-player-host", root), {
      // The organizer link is an HTML page with an hourly-expiring mp3 link; the backend caches the file.
      audioUrl: conv.audio_url ? api.audioUrl(conv.id) : null,
      sourceUrl: conv.audio_url || null,
      segments: buildSegments(conv.transcript, audioSec),
      retime: (duration) => {
        // The real file length tells how much of the recording pause was cut out.
        const sec = audioTimeline(conv.transcript, seconds, duration);
        mineCtx.seconds = sec;
        mineCtx.rel = clock(sec);
        $$("[data-play]", root).forEach((b) => {
          const s = sec[Number(b.dataset.play) - 1];
          if (s === null || s === undefined) return;
          b.lastChild.textContent = fmtClock(s);
          b.setAttribute("aria-label", `Прослушать реплику #${b.dataset.play} с ${fmtClock(s)}`);
        });
        return buildSegments(conv.transcript, sec);
      },
      onSegment: (n) => focusMsg(n, { seek: false }),
      onActive: (n, isPlaying) => karaoke(n, isPlaying),
    });
  }

  ctx.regulation = mountRegulation({ root, convId: conv.id, focusMsg: (n, opts) => { if (ctx === mine) focusMsg(n, opts); } });

  if (history) await loadEvaluation(history.id);
  else drawEmpty();
  if (ctx === mine && query.msg) focusMsg(Number(query.msg));
  return cleanup;
}

export function onQuery(query) {
  if (!ctx) return;
  const go = async () => {
    const kid = Number(query.checklist);
    if (ctx.checklists.some((c) => c.id === kid)) {
      ctx.checklistId = kid;
      ctx.pinnedChecklist = true;
      $$("[data-sel-checklist]", ctx.root).forEach((s) => { s.value = String(kid); });
      updateChecklistControls();
    }
    const id = Number(query.eval);
    const compareId = Number(query.compare) || null;
    if (id !== ctx.evaluation?.id && ctx.conv.evaluations.some((ev) => ev.id === id)) {
      ctx.openCrit = query.crit || null;
      ctx.compareId = compareId;
      await loadEvaluation(id);
    } else if (ctx.evaluation && compareId !== ctx.compareId) {
      ctx.openCrit = query.crit || null;
      ctx.compareId = compareId;
      drawEvaluation(ctx.evaluation);
    } else if (query.crit && query.crit !== ctx.openCrit) {
      toggleCrit(query.crit, true, { focus: !query.msg });
    }
    if (ctx && query.msg) focusMsg(Number(query.msg), { page: true });
  };
  go().catch((e) => toast(e.message, true));
}

// ------------------------------------------------------------ transcript ----

function setFilter(key) {
  const tr = $("#transcript", ctx.root);
  tr.dataset.filter = key;
  $$("[data-filter]", ctx.root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === key)));
}

function playAt(n) {
  const s = ctx.seconds[n - 1];
  focusMsg(n, { seek: false });
  if (!ctx.player || s === null || s === undefined) return;
  if (!ctx.player.hasAudio()) { toast("Запись недоступна в браузере — откройте её по ссылке «Открыть в плеере»", true); return; }
  ctx.followUntil = 0;
  ctx.player.seekTo(s, { autoplay: true });
}

/** Highlight + scroll to a message. For calls the recording is positioned there too. */
function focusMsg(n, { seek = true, scroll = true, page = false } = {}) {
  if (!ctx) return;
  const el = $(`#msg-${n}`, ctx.root);
  if (!el) return;
  const tr = $("#transcript", ctx.root);
  if (tr.dataset.filter !== "all" && !matchesFilter(el, tr.dataset.filter)) setFilter("all");
  // A message inside a collapsed bot/system run: open the run (and close runs opened only for the previous focus).
  collapseAuto(tr, new Set([...ctx.keep, n]));
  revealMsg(el);
  $$(".cv-msg.is-focus", ctx.root).forEach((m) => m.classList.remove("is-focus"));
  el.classList.add("is-focus");
  // restart the flash animation
  el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash");
  if (scroll) {
    ctx.followUntil = Date.now() + 4000;
    scrollInBox(tr, el);
    // Explicit jumps also bring the transcript itself into view (single-column / mobile layout).
    const r = tr.getBoundingClientRect();
    if (page && (r.bottom < 80 || r.top > window.innerHeight - 80)) $(".cv-tr-card", ctx.root).scrollIntoView({ block: "start", behavior: scrollBehavior() });
  }
  if (ctx.player) {
    ctx.player.setMarks({ focus: n });
    if (seek && ctx.player.hasAudio()) ctx.player.seekTo(ctx.seconds[n - 1], { autoplay: false });
  }
}

const matchesFilter = (el, f) => f === "all" || (f === "ctx" ? !["client", "operator"].includes(el.dataset.sp) : el.dataset.sp === f);

/** The element that represents the playing message: the message, or its collapsed run. */
function playingEl() {
  const el = ctx && $(".cv-msg.is-playing", ctx.root);
  return el ? el.closest(".cv-run.is-collapsed") || el : null;
}

function karaoke(n, isPlaying) {
  if (!ctx) return;
  $$(".cv-msg.is-playing, .cv-run.is-playing", ctx.root).forEach((m) => m.classList.remove("is-playing"));
  if (!n) return;
  const el = $(`#msg-${n}`, ctx.root);
  if (!el) return;
  el.classList.add("is-playing");
  // Inside a collapsed context run: light up the run row instead of expanding it mid-playback.
  const tr = $("#transcript", ctx.root);
  const run = el.closest(".cv-run.is-collapsed");
  if (run) run.classList.add("is-playing");
  if (!isPlaying) return;
  const follow = $("#cv-follow", ctx.root);
  if (Date.now() >= ctx.followUntil) { scrollInBox(tr, run || el); follow.hidden = true; }
  else follow.hidden = false;
}

function markEvidence(row, crit, { announce = true } = {}) {
  $$(".cv-msg.is-evidence, .cv-msg.in-range", ctx.root).forEach((m) => m.classList.remove("is-evidence", "in-range"));
  const tr = $("#transcript", ctx.root);
  const bar = $("#cv-tr-ctx", ctx.root);
  const original = row && ctx.evaluation?.criteria?.find((r) => r.criterion_id === row.criterion_id);
  const revised = isRevised(row, original);
  $(".cv-tr-card", ctx.root).classList.toggle("is-critical-evidence", !revised && crit?.type === "critical" && row?.answer === "yes");
  const range = [];
  if (row?.checked_range && (announce || !row.evidence?.length)) {
    for (let n = row.checked_range[0]; n <= row.checked_range[1]; n++) range.push(n);
  }
  const evidence = row ? row.evidence || [] : [];
  ctx.keep = new Set(evidence);
  collapseAuto(tr, ctx.keep);
  if (row) {
    evidence.forEach((n) => {
      const el = $(`#msg-${n}`, ctx.root);
      if (!el) return;
      el.classList.add("is-evidence");
      revealMsg(el); // evidence is never hidden inside a collapsed run
    });
    range.forEach((n) => $(`#msg-${n}`, ctx.root)?.classList.add("in-range"));
  }
  if (ctx.player) ctx.player.setMarks({ evidence, range, focus: null });
  const ev = evidence.length;
  if (!row || !crit || !announce || (!ev && !range.length)) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.innerHTML = `
    <span class="cv-tr-ctx-dot" aria-hidden="true"></span>
    <span class="cv-tr-ctx-text">${revised ? "Фрагменты из оценки модели" : ev ? `Подсвечено ${ev} ${plural(ev, "доказательство", "доказательства", "доказательств")}` : "Подсвечен проверенный участок"} по критерию
      <b>${crit.code ? esc(crit.code) + " " : ""}${esc(crit.title)}</b>${range.length ? `, участок #${range[0]}–#${range[range.length - 1]}` : ""}</span>
    <button type="button" class="cv-x" data-clear aria-label="Снять подсветку">${cvIcon("close")}</button>`;
}

// ------------------------------------------------------------ evaluation ----

function checklistOptions() {
  // Version first: it is what differs between options and must survive truncation on phones.
  return ctx.checklists.map((c) => `<option value="${c.id}" ${c.id === ctx.checklistId ? "selected" : ""}>v${c.version} · ${esc(c.name)}${c.is_active ? " · активный" : ""}</option>`).join("");
}

/** Header control: shown once the dialog has at least one evaluation (re-evaluate with any checklist version). */
function paintHeadCtl(show) {
  const host = $("#cv-eval-ctl", ctx.root);
  if (!host) return;
  host.innerHTML = show ? `
    <label class="cv-sr" for="sel-checklist">Чек-лист для новой оценки</label>
    <select class="input" id="sel-checklist" data-sel-checklist>${checklistOptions()}</select>
    <a class="btn" id="cv-edit-checklist">${icon("list")}Изменить чек-лист</a>
    <button class="btn btn-primary" id="btn-eval" type="button" data-run-eval>${cvIcon("sparkle")}Переоценить диалог</button>` : "";
  updateChecklistControls();
}

/** «Изменить чек-лист» link and the hint shown when another checklist version is selected. */
function updateChecklistControls() {
  if (!ctx) return;
  const kid = ctx.checklistId;
  const cl = ctx.checklists.find((item) => item.id === kid);
  const edit = $("#cv-edit-checklist", ctx.root);
  if (edit) {
    edit.hidden = !cl;
    if (cl) {
      const q = new URLSearchParams({ conversation: ctx.conv.id });
      if (ctx.evaluation) q.set("eval", ctx.evaluation.id);
      edit.href = `#/checklists/${cl.id}?${q}`;
    }
  }
  const ready = $("#cv-version-ready", ctx.root);
  if (!ready) return;
  const ev = ctx.evaluation;
  const changed = !!cl && ev?.status === "done" && ev.checklist_id !== kid;
  const canCheckRule = changed && cl.name === ev.checklist_name && cl.version > ev.checklist_version;
  const ruleCheckQuery = canCheckRule ? new URLSearchParams({
    baseline: ev.checklist_id, ...(ctx.openCrit ? { criterion: ctx.openCrit } : {}),
  }) : null;
  ready.hidden = !changed;
  ready.innerHTML = changed ? `<span class="qa-handoff-icon">${icon("refresh")}</span>
    <div><b>Выбрана другая версия чек-листа · v${esc(cl.version)}</b>
    <div>Нажмите «Переоценить диалог», чтобы применить её к этому разговору.</div></div>
    ${canCheckRule ? `<a class="btn btn-sm" href="#/checklists/${kid}/rule-check?${esc(String(ruleCheckQuery))}">Проверить правило</a>` : ""}` : "";
}

function paintHeadScore(ev) {
  const host = $("#cv-head-score", ctx.root);
  if (!host) return;
  if (!ev || ev.status !== "done") { host.innerHTML = ""; return; }
  const revised = ev.total !== null && ev.final_total !== null && Math.abs(Number(ev.total) - Number(ev.final_total)) > 0.001;
  host.innerHTML = scoreBadgeHtml(ev.final_score ? ev.final_score.total : ev.final_total, { revised });
}

function panelHead(ev) {
  const hist = ctx.conv.evaluations;
  return `
    <div class="card-head cv-ev-head">
      <h2>Оценка качества</h2><div class="spacer"></div>
      ${hist.length > 1 ? `<label class="cv-sr" for="sel-eval">История оценок</label>
        <select class="input cv-hist" id="sel-eval">
          ${hist.map((h) => `<option value="${h.id}" ${ev && h.id === ev.id ? "selected" : ""}>#${h.id} · ${esc(h.checklist_name)} v${h.checklist_version} · ${esc(fmtDate(h.created_at))}${h.status === "error" ? " · ошибка" : h.final_total !== null && h.final_total !== undefined ? ` · ${fmtNum(h.final_total)}` : ""}</option>`).join("")}
        </select>`
      : ev ? `<span class="cv-muted-s">${esc(ev.checklist_name)} · v${ev.checklist_version}</span>` : ""}
    </div>`;
}

function drawEmpty() {
  stopLoading();
  paintHeadCtl(false);
  paintHeadScore(null);
  $("#cv-grid", ctx.root).classList.add("is-empty");
  const n = ctx.conv.transcript.length;
  $("#eval-panel", ctx.root).innerHTML = `${panelHead(null)}
    <div class="cv-cta">
      <span class="cv-cta-ic" aria-hidden="true">${cvIcon("list")}</span>
      <h3 class="cv-cta-title">Диалог ещё не оценён</h3>
      <p class="cv-cta-text">Модель проверит ${n} ${plural(n, "реплику", "реплики", "реплик")} по каждому критерию чек-листа, поставит баллы и объяснит решения ссылками на реплики. Обычно это занимает 10–30 секунд.</p>
      <label class="field cv-cta-field" for="sel-checklist-cta">Чек-лист
        <select class="input" id="sel-checklist-cta" data-sel-checklist>${checklistOptions()}</select></label>
      <button class="btn btn-primary cv-cta-btn" id="btn-eval-cta" type="button" data-run-eval>${cvIcon("sparkle")}Оценить диалог</button>
      <div class="cv-cta-preview" id="cv-cta-preview"></div>
    </div>`;
  bindHistory();
  paintPreview();
}

/** Criteria of the selected checklist, so it is clear what exactly will be checked. */
async function paintPreview() {
  const box = $("#cv-cta-preview", ctx.root);
  if (!box || !ctx.checklistId) return;
  const id = ctx.checklistId;
  const owner = ctx;
  let cl = ctx.clCache.get(id);
  if (!cl) {
    try { cl = await api.checklist(id); owner.clCache.set(id, cl); } catch { return; }
  }
  if (ctx !== owner || ctx.checklistId !== id || !box.isConnected) return;
  const crits = (cl.config || cl).criteria || [];
  if (!crits.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="cv-cta-sub">Что проверим · ${crits.length} ${plural(crits.length, "критерий", "критерия", "критериев")}</div>
    <ul class="cv-cta-crits">${crits.map((c) => `<li><span class="cv-code">${esc(c.code || "")}</span><span>${esc(c.title)}${c.type === "critical" ? ` <span class="cv-tag is-warn">без баллов</span>` : ""}</span></li>`).join("")}</ul>`;
}

function startLoading(ev) {
  stopLoading();
  const cl = ctx.checklists.find((c) => c.id === ctx.checklistId);
  const crits = ev?.checklist?.criteria?.length || cl?.criteria_count || 0;
  $("#cv-grid", ctx.root).classList.remove("is-empty");
  paintHeadScore(null);
  $("#eval-panel", ctx.root).innerHTML = panelHead(ev) + loadingHtml({ messages: ctx.conv.transcript.length, criteria: crits });
  bindHistory();
  const t0 = ev && ev.created_at ? Math.min(Date.now(), Date.parse(ev.created_at)) : Date.now();
  const panel = $("#eval-panel", ctx.root);
  const tickFn = () => updateLoading(panel, (Date.now() - t0) / 1000);
  tickFn();
  ctx.loadingTimer = setInterval(tickFn, 500);
}

function stopLoading() {
  if (ctx) clearInterval(ctx.loadingTimer);
}

async function runEvaluation(btn) {
  const kid = ctx.checklistId;
  if (!kid) { toast("Нет чек-листа для оценки", true); return; }
  const headBtn = $("#btn-eval", ctx.root);
  const sels = $$("[data-sel-checklist]", ctx.root);
  busy(headBtn || btn, true, "Оценка…");
  sels.forEach((s) => (s.disabled = true));
  startLoading(null);
  const mine = ctx;
  const previous = ctx.evaluation;
  try {
    const ev = await api.evaluate(ctx.conv.id, kid);
    if (ctx !== mine) return;
    const updated = await api.conversation(mine.conv.id);
    if (ctx !== mine) return;
    ctx.conv = { ...ctx.conv, evaluations: updated.evaluations };
    // Re-evaluated with another checklist version: show both totals side by side.
    ctx.compareId = previous?.status === "done" && previous.checklist_id !== ev.checklist_id ? previous.id : null;
    ctx.openCrit = null;
    ctx.pinnedChecklist = false;
    drawEvaluation(ev);
    setUrl();
    if (ev.status === "error") toast(`Ошибка оценки: ${ev.error}`, true);
    else toast(`Оценка готова: ${fmtNum(ev.final_total)} из 100`);
  } catch (e) {
    if (ctx !== mine) return;
    toast(e.message, true);
    if (ctx.evaluation) drawEvaluation(ctx.evaluation); else drawEmpty();
  } finally {
    if (ctx === mine) {
      const hb = $("#btn-eval", ctx.root);
      if (hb) busy(hb, false);
      $$("[data-sel-checklist]", ctx.root).forEach((s) => (s.disabled = false));
    }
  }
}

async function loadEvaluation(id) {
  const owner = ctx;
  const ev = await api.evaluation(id);
  // Navigated to another card (or away) while loading: don't draw into it.
  if (!ctx || ctx !== owner || !owner.root.isConnected) return;
  drawEvaluation(ev);
}

function drawEvaluation(ev) {
  // Re-evaluation defaults to the checklist version of the evaluation on screen
  // (unless a version was picked explicitly, e.g. ?checklist= from the checklist editor).
  if (!ctx.pinnedChecklist && ev.checklist_id && ctx.checklists.some((c) => c.id === ev.checklist_id) && ctx.checklistId !== ev.checklist_id) {
    ctx.checklistId = ev.checklist_id;
    $$("[data-sel-checklist]", ctx.root).forEach((sel) => { if (!sel.disabled) sel.value = String(ev.checklist_id); });
  }
  ctx.evaluation = ev;
  updateChecklistControls();
  clearTimeout(ctx.pollTimer);
  const panel = $("#eval-panel", ctx.root);
  $("#cv-grid", ctx.root).classList.remove("is-empty");
  if (!$("#btn-eval", ctx.root)) paintHeadCtl(true);
  paintHeadScore(ev);

  if (ev.status !== "done") {
    if (ev.status === "running" || ev.status === "pending") {
      startLoading(ev);
      ctx.pollTimer = setTimeout(() => ctx && ctx.evaluation?.id === ev.id && loadEvaluation(ev.id).catch(() => {}), 2500);
    } else {
      stopLoading();
      panel.innerHTML = panelHead(ev) + `<div class="cv-pad">
        <div class="cv-note cv-note-warn">${cvIcon("alert")}<span><b>Оценка не получилась:</b> ${esc(ev.error || "неизвестная ошибка")}</span></div>
        <button class="btn btn-primary" type="button" data-run-eval>${cvIcon("sparkle")}Повторить оценку</button></div>`;
      bindHistory();
    }
    markEvidence(null);
    return;
  }
  stopLoading();

  const cfg = ev.checklist;
  const score = ev.final_score;
  const critCfg = Object.fromEntries(cfg.criteria.map((c) => [c.id, c]));
  const scoreRows = Object.fromEntries(score.criteria.map((r) => [r.criterion_id, r]));
  const origRows = Object.fromEntries(ev.score.criteria.map((r) => [r.criterion_id, r]));
  const appealsBy = {};
  ev.appeals.forEach((a) => (appealsBy[a.criterion_id] = appealsBy[a.criterion_id] || []).push(a));
  if (ctx.openCrit && !critCfg[ctx.openCrit]) ctx.openCrit = null;

  const totalChanged = ev.total !== null && ev.final_total !== null && Math.abs(Number(ev.total) - Number(ev.final_total)) > 0.001;
  const resolved = ev.appeals.filter((a) => a.status !== "open").length;
  const openApp = ev.appeals.filter((a) => a.status === "open").length;
  const delta = totalChanged ? Number(ev.final_total) - Number(ev.total) : 0;
  const rowsBy = Object.fromEntries(ev.final_criteria.map((r) => [r.criterion_id, r]));
  const previous = ctx.conv.evaluations.find((item) => item.id === ctx.compareId && item.id !== ev.id && item.status === "done");
  const reviewCriteria = cfg.criteria.filter((c) => rowsBy[c.id]?.evidence_review);
  const canAppeal = cfg.criteria.some((c) => rowsBy[c.id] && !(appealsBy[c.id] || []).some((a) => a.status === "open"));
  const anyRevised = ev.final_criteria.some((r) => isRevised(r, origRows[r.criterion_id]));

  // Criteria grouped by checklist section, in checklist order.
  const sectionTitle = Object.fromEntries((cfg.sections || []).map((s) => [s.id, s.title]));
  const secScore = Object.fromEntries((score.sections || []).map((s) => [s.section_id, s]));
  const groups = [];
  cfg.criteria.forEach((c) => {
    if (!rowsBy[c.id]) return;
    let g = groups.find((x) => x.id === (c.section || ""));
    if (!g) groups.push((g = { id: c.section || "", items: [] }));
    g.items.push(c);
  });

  const critical = score.critical
    ? `<div class="cv-banner is-crit" role="alert">
        <span class="cv-banner-ic" aria-hidden="true">${cvIcon("alert")}</span>
        <div><b>Грубая ошибка</b> — отмечается отдельно от балла
          <div class="cv-banner-list">${score.critical_criteria.map((id) => `<button type="button" class="cv-link" data-open="${esc(id)}">${esc(critCfg[id]?.title || id)}</button>`).join(", ")}</div></div>
      </div>`
    : `<div class="cv-banner is-ok"><span class="cv-banner-ic" aria-hidden="true">${cvIcon("shield")}</span>Грубых ошибок не выявлено</div>`;

  panel.innerHTML = panelHead(ev) + `
    <div class="cv-score">
      ${ringHtml(score.total)}
      <div class="cv-score-side">
        <div class="cv-score-cap">${totalChanged ? "Итог после пересмотра" : "Итоговая оценка"}</div>
        ${totalChanged ? `
          <div class="cv-revised">
            <span class="cv-revised-was"><small>Модель</small><s>${fmtNum(ev.total)}</s></span>
            ${cvIcon("arrowRight", { cls: "cv-revised-arrow" })}
            <span class="cv-revised-now"><small>Итог</small><b>${fmtNum(ev.final_total)}</b></span>
            <span class="cv-delta ${delta > 0 ? "is-up" : "is-down"}">${delta > 0 ? "+" : "−"}${fmtNum(Math.abs(delta))}</span>
          </div>
          <div class="cv-muted-s">Исходная оценка модели ${fmtNum(ev.total)}, решений по апелляциям: ${resolved}</div>`
        : resolved ? `<div class="cv-muted-s">Апелляции рассмотрены (${resolved}), итог не изменился</div>` : ""}
        ${openApp ? `<div><span class="cv-tag is-warn">${cvIcon("hourglass")}${openApp} ${plural(openApp, "апелляция", "апелляции", "апелляций")} на рассмотрении</span></div>` : ""}
        ${score.total === null ? `<div class="cv-note cv-note-na">Итог не рассчитывается: нет применимых критериев с весом.</div>` : ""}
        <div class="cv-secs">
          ${(score.sections || []).filter((s) => s.max_points !== null).map((s) => {
            const pct = s.max_points ? (s.points / s.max_points) * 100 : 0;
            return `<div class="cv-sec"><span>${esc(s.title)}</span><b>${fmtNum(s.points)} / ${fmtNum(s.max_points)}</b>
              <div class="cv-bar cv-tone-${pct >= 85 ? "hi" : pct >= 65 ? "mid" : "lo"}"><i style="width:${pct.toFixed(1)}%"></i></div></div>`;
          }).join("")}
        </div>
      </div>
    </div>
    ${previous ? `<div class="cv-version-compare">
      <div><b>Оценки модели по двум версиям</b><span>Один и тот же разговор</span></div>
      <div class="cv-version-values"><span><small>v${esc(previous.checklist_version)}</small><strong>${fmtNum(previous.total)}</strong></span>
      ${cvIcon("arrowRight")}<span><small>v${esc(ev.checklist_version)}</small><strong>${fmtNum(ev.total)}</strong></span></div>
    </div>` : ""}
    ${reviewCriteria.length ? `<div class="cv-evidence-banner">
      ${cvIcon("alert")}
      <div><strong>Требует проверки</strong><span>Сверьте основания по ${reviewCriteria.length} ${plural(reviewCriteria.length, "критерию", "критериям", "критериям")}: цитаты модели не нашлись в репликах.</span></div>
      <button type="button" class="btn btn-sm" data-open="${esc(reviewCriteria[0].id)}">Проверить</button>
    </div>` : ""}
    ${ev.summary ? `<div class="cv-summary${ev.summary.length > 240 ? " is-clamped" : ""}">
      <h3 class="cv-summary-h">Резюме модели${anyRevised ? " · до пересмотра" : ""}</h3>
      <p class="cv-summary-t" id="cv-summary-t">${esc(ev.summary)}</p>
      ${ev.summary.length > 240 ? `<button type="button" class="cv-more" data-sum-more aria-expanded="false" aria-controls="cv-summary-t">Читать полностью</button>` : ""}
    </div>` : ""}
    ${critical}
    <div id="cv-why">${lossesHtml({ ev, critCfg, scoreRows, appealsBy, expanded: ctx.whyExpanded })}</div>
    <div class="cv-crits" id="crit-list">
      <div class="cv-crits-h"><h3>Все критерии</h3><span class="cv-muted-s">откройте критерий, чтобы увидеть объяснение и реплики</span>
        <button type="button" class="btn btn-sm cv-appeal-main" data-appeal-all ${canAppeal ? "" : "disabled"}>${cvIcon("scale")}Оспорить оценку</button></div>
      ${groups.map((g) => {
        const ss = secScore[g.id];
        return `<div class="cv-group">
          <div class="cv-group-h"><span>${esc(sectionTitle[g.id] || ss?.title || "")}</span>
            ${ss ? `<span>${ss.max_points !== null ? `${fmtNum(ss.points)} / ${fmtNum(ss.max_points)}` : g.items.every((c) => rowsBy[c.id].answer === "na") ? "все N/A, вес перераспределён" : "без баллов"}</span>` : ""}</div>
          ${g.items.map((c) => critHtml({
            row: rowsBy[c.id], crit: c, srow: scoreRows[c.id], orow: origRows[c.id], appeals: appealsBy[c.id] || [],
            msgs: ctx.conv.transcript, rel: ctx.rel, canAppeal: true, open: ctx.openCrit === c.id,
          })).join("")}
        </div>`;
      }).join("")}
    </div>
    ${metaHtml(ev)}`;

  bindHistory();
  panel.onclick = onPanelClick;
  if (ctx.openCrit) {
    toggleCrit(ctx.openCrit, true);
    // Deep link (e.g. from an appeal): bring the opened criterion and its reviewer note into view.
    const el = $(`.cv-crit[data-crit="${CSS.escape(ctx.openCrit)}"]`, ctx.root);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", behavior: scrollBehavior() }));
  } else {
    // Quietly mark the main finding (critical error, else the biggest loss) in the transcript.
    const crit = cfg.criteria.find((c) => c.type === "critical" && rowsBy[c.id]?.answer === "yes")
      || lossItems(ev, critCfg, scoreRows)[0]?.crit;
    const row = crit && rowsBy[crit.id];
    if (row && !isRevised(row, origRows[crit.id])) markEvidence(row, crit, { announce: false });
    else markEvidence(null);
  }
}

function onPanelClick(e) {
  const t = e.target;
  const msg = t.closest("[data-msg]");
  if (msg) { focusMsg(Number(msg.dataset.msg), { page: true }); return; }
  if (t.closest("[data-appeal-all]")) { appealDialog(); return; }
  const ap = t.closest("[data-appeal]");
  if (ap) { appealDialog(ap.dataset.appeal); return; }
  const jump = t.closest("[data-jump]");
  if (jump) { toggleCrit(jump.dataset.jump, true, { page: true }); return; }
  const open = t.closest("[data-open]");
  if (open) {
    toggleCrit(open.dataset.open, true);
    const el = $(`.cv-crit[data-crit="${CSS.escape(open.dataset.open)}"]`, ctx.root);
    if (el) el.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    return;
  }
  const sm = t.closest("[data-sum-more]");
  if (sm) {
    const box = sm.closest(".cv-summary");
    const open = box.classList.toggle("is-clamped") === false;
    sm.setAttribute("aria-expanded", String(open));
    sm.textContent = open ? "Свернуть" : "Читать полностью";
    return;
  }
  if (t.closest("[data-more]")) {
    ctx.whyExpanded = !ctx.whyExpanded;
    const ev = ctx.evaluation;
    const critCfg = Object.fromEntries(ev.checklist.criteria.map((c) => [c.id, c]));
    const scoreRows = Object.fromEntries(ev.final_score.criteria.map((r) => [r.criterion_id, r]));
    const appealsBy = {};
    ev.appeals.forEach((a) => (appealsBy[a.criterion_id] = appealsBy[a.criterion_id] || []).push(a));
    $("#cv-why", ctx.root).innerHTML = lossesHtml({ ev, critCfg, scoreRows, appealsBy, expanded: ctx.whyExpanded });
    return;
  }
  const tog = t.closest("[data-toggle]");
  if (tog) toggleCrit(tog.dataset.toggle);
}

function bindHistory() {
  const sel = $("#sel-eval", ctx.root);
  if (sel) sel.addEventListener("change", () => {
    history.replaceState(null, "", `#/conversation/${encodeURIComponent(ctx.conv.id)}?eval=${sel.value}`);
    ctx.openCrit = null;
    ctx.compareId = null;
    ctx.pinnedChecklist = false;
    loadEvaluation(Number(sel.value)).catch((e) => toast(e.message, true));
  });
}

function setUrl() {
  const ev = ctx.evaluation;
  if (!ev) return;
  const q = new URLSearchParams({ eval: String(ev.id) });
  const kid = ctx.checklistId;
  if (kid && (kid !== ev.checklist_id || ctx.compareId)) q.set("checklist", kid);
  if (ctx.compareId) q.set("compare", ctx.compareId);
  if (ctx.openCrit) q.set("crit", ctx.openCrit);
  history.replaceState(null, "", `#/conversation/${encodeURIComponent(ctx.conv.id)}?${q.toString()}`);
}

function toggleCrit(id, forceOpen = false, { focus = true, page = false } = {}) {
  if (!ctx || !ctx.evaluation || !id) return;
  const el = $(`.cv-crit[data-crit="${CSS.escape(id)}"]`, ctx.root);
  if (!el) return;
  const willOpen = forceOpen || !el.classList.contains("is-open");
  $$(".cv-crit.is-open", ctx.root).forEach((c) => {
    c.classList.remove("is-open");
    c.querySelector(".cv-crit-top").setAttribute("aria-expanded", "false");
    c.querySelector(".cv-crit-body").hidden = true;
  });
  if (willOpen) {
    el.classList.add("is-open");
    el.querySelector(".cv-crit-top").setAttribute("aria-expanded", "true");
    el.querySelector(".cv-crit-body").hidden = false;
    ctx.openCrit = id;
    const row = ctx.evaluation.final_criteria.find((r) => r.criterion_id === id);
    const crit = ctx.evaluation.checklist.criteria.find((c) => c.id === id);
    markEvidence(row, crit);
    const ref = firstRef(row);
    if (focus && ref) focusMsg(ref, { page });
  } else {
    ctx.openCrit = null;
    markEvidence(null);
    $$(".cv-msg.is-focus", ctx.root).forEach((m) => m.classList.remove("is-focus"));
  }
  setUrl();
}

/** Appeal form for one criterion, or (no critId) with a criterion picker. */
function appealDialog(critId) {
  const ev = ctx.evaluation;
  const rows = new Map(ev.final_criteria.map((row) => [row.criterion_id, row]));
  const pending = new Set(ev.appeals.filter((a) => a.status === "open").map((a) => a.criterion_id));
  const choices = ev.checklist.criteria.filter((c) => rows.has(c.id) && !pending.has(c.id) && (!critId || c.id === critId));
  if (!choices.length) return;
  const summary = (crit) => {
    const row = rows.get(crit.id);
    const srow = ev.final_score.criteria.find((r) => r.criterion_id === crit.id);
    const original = ev.criteria.find((r) => r.criterion_id === crit.id);
    const decision = changeReview(row, original);
    return `${icHtml(crit, row.answer)}
        <div><b>Сейчас: ${esc(answerView(crit, row.answer).label)}</b>${srow && srow.points !== null && srow.points !== undefined ? `, ${fmtNum(srow.points)} из ${fmtNum(srow.max_points)} балл.` : ""}
          <div class="cv-muted-s">${decision ? `Решение проверяющего · ${esc(decision.reason)}` : esc(row.explanation || "")}</div></div>`;
  };
  const first = choices[0];
  const { el: dlg } = modal({
    title: critId ? `Оспорить оценку: ${first.code ? first.code + " " : ""}${first.title}` : "Оспорить оценку",
    submitText: "Отправить апелляцию",
    body: `
      ${critId ? "" : `<label class="field">Критерий
        <select class="input" id="ap-criterion">${choices.map((c) => `<option value="${esc(c.id)}">${esc(c.code ? `${c.code} ${c.title}` : c.title)}</option>`).join("")}</select></label>`}
      <div class="cv-ap-cur" id="ap-summary">${summary(first)}</div>
      <label class="field">Почему оценка неверна
        <textarea class="input" id="ap-comment" rows="4" placeholder="Например: оператор представился в реплике #3, приветствие было на казахском"></textarea></label>
      <label class="field">Автор (необязательно)
        <input class="input" id="ap-author" placeholder="Оператор / супервайзер" value="${esc(window.CQA_USER || "")}" ${window.CQA_USER ? "readonly" : ""}></label>
      <div class="cv-muted-s">Проверяющий увидит ваш комментарий, объяснение модели и фрагмент диалога, затем подтвердит или изменит оценку. Итог пересчитается автоматически.</div>`,
    onSubmit: async (el) => {
      const comment = $("#ap-comment", el).value.trim();
      if (!comment) throw new Error("Добавьте комментарий");
      const chosen = $("#ap-criterion", el)?.value || first.id;
      const a = await api.createAppeal({ evaluation_id: ev.id, criterion_id: chosen, comment, author: $("#ap-author", el).value.trim() || null });
      toast(`Апелляция #${a.id} отправлена проверяющему`);
      if (ctx?.evaluation?.id !== ev.id) return;
      ctx.openCrit = chosen;
      await loadEvaluation(ev.id);
      refreshBadge();
    },
  });
  $("#ap-criterion", dlg)?.addEventListener("change", (e) => {
    $("#ap-summary", dlg).innerHTML = summary(choices.find((c) => c.id === e.target.value));
  });
}
