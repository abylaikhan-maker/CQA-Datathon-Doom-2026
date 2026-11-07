// Conversation card: transcript (chat), call player with a speaker timeline, and
// the evaluation panel (score ring, why the score dropped, criteria, appeals).
// Deep link: #/conversation/<id>?eval=<id>&crit=<criterionId>&msg=<n>
import { api } from "../api.js";
import { esc, $, $$, fmtNum, fmtDate, toast, busy, modal, answerView, tsSeconds, fmtClock, LANG, CHANNEL } from "../util.js";
import { refreshBadge } from "../app.js";
import { createPlayer, buildSegments } from "../card/player.js";
import { msgHtml, scrollInBox } from "../card/transcript.js";
import { ringHtml, critHtml, lossesHtml, metaHtml, loadingHtml, updateLoading, firstRef, plural } from "../card/score.js";

let ctx = null;

const FILTERS = [
  { key: "all", label: "Все" },
  { key: "client", label: "Клиент" },
  { key: "operator", label: "Оператор" },
  { key: "ctx", label: "Бот · система" },
];

export async function render(root, params, query) {
  const [conv, checklists] = await Promise.all([api.conversation(params.id), api.checklists()]);
  const first = conv.transcript[0]?.timestamp;
  const seconds = conv.transcript.map((m) => tsSeconds(m.timestamp, first));
  const known = seconds.filter((s) => s !== null && s !== undefined);
  const duration = known.length ? Math.max(...known) : null;
  const isCall = conv.channel === "voice call" || !!conv.audio_url;
  const active = checklists.find((c) => c.is_active) || checklists[0];
  const hasCtx = conv.transcript.some((m) => !["client", "operator"].includes(String(m.speaker || "").toLowerCase()));

  ctx = {
    root, conv, checklists, seconds, isCall, evaluation: null, player: null,
    openCrit: query.crit || null, whyExpanded: false, followUntil: 0, loadingTimer: null, pollTimer: null,
    rel: isCall ? seconds.map((s) => (s === null || s === undefined ? null : fmtClock(s))) : null,
  };

  const chan = CHANNEL[conv.channel] || conv.channel || "";
  root.innerHTML = `
    <div class="crumbs"><a href="#/conversations">Диалоги</a> / ${esc(conv.dataset_group || "")}</div>
    <div class="page-head cv-head">
      <div class="cv-head-main">
        <h1>Анализ разговора</h1>
        <div class="cv-head-sub">
          <span class="cv-chip cv-chip-${isCall ? "call" : "chat"}">${isCall ? "🎧" : "💬"} ${esc(chan)}</span>
          <span class="mono">${esc(conv.id)}</span>
          ${conv.language ? `<span>${esc(LANG[conv.language] || conv.language)}</span>` : ""}
          ${duration ? `<span>${fmtClock(duration)}</span>` : ""}
          <span>${conv.transcript.length} ${plural(conv.transcript.length, "реплика", "реплики", "реплик")}</span>
        </div>
      </div>
      <div class="spacer"></div>
      <div class="cv-eval-ctl">
        <label class="cv-sr" for="sel-checklist">Чек-лист</label>
        <select class="input" id="sel-checklist">
          ${checklists.map((c) => `<option value="${c.id}" ${c.id === active?.id ? "selected" : ""}>${esc(c.name)} · v${c.version}${c.is_active ? " (активный)" : ""}</option>`).join("")}
        </select>
        <button class="btn btn-primary" id="btn-eval" type="button">Оценить</button>
      </div>
    </div>
    ${isCall ? `<div id="cv-player-host"></div>` : ""}
    <div class="cv-grid">
      <section class="card cv-tr-card" aria-label="Расшифровка">
        <div class="card-head cv-tr-head">
          <h2>Расшифровка</h2><div class="spacer"></div>
          <div class="cv-filter" role="group" aria-label="Фильтр по участнику">
            ${FILTERS.filter((f) => f.key !== "ctx" || hasCtx).map((f) => `<button type="button" data-filter="${f.key}" aria-pressed="${f.key === "all"}">${esc(f.label)}</button>`).join("")}
          </div>
        </div>
        <div class="cv-tr-ctx" id="cv-tr-ctx" hidden></div>
        <div class="cv-transcript" id="transcript" data-filter="all" tabindex="0" aria-label="Реплики диалога">
          ${conv.transcript.map((m, i) => msgHtml(m, i + 1, { sec: seconds[i], playable: isCall && !!conv.audio_url })).join("")}
        </div>
        <button type="button" class="cv-follow" id="cv-follow" hidden>↓ К текущей реплике</button>
      </section>
      <section class="card cv-ev-card" id="eval-panel" aria-label="Оценка качества"></section>
    </div>`;

  const tr = $("#transcript", root);
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
    const el = $(".cv-msg.is-playing", root);
    if (el) scrollInBox(tr, el);
  });
  $$("[data-filter]", root).forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));
  $("#cv-tr-ctx", root).addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) toggleCrit(ctx.openCrit);
  });
  $("#btn-eval", root).addEventListener("click", (e) => runEvaluation(e.currentTarget));

  if (isCall) {
    ctx.player = createPlayer($("#cv-player-host", root), {
      audioUrl: conv.audio_url || null,
      segments: buildSegments(conv.transcript, seconds),
      onSegment: (n) => focusMsg(n, { seek: false }),
      onActive: (n, isPlaying) => karaoke(n, isPlaying),
    });
  }

  const evId = query.eval ? Number(query.eval) : conv.evaluations[0]?.id;
  if (evId) await loadEvaluation(evId);
  else drawEmpty();
  if (query.msg) focusMsg(Number(query.msg));

  const mine = ctx;
  return () => {
    if (mine.player) mine.player.destroy();
    clearInterval(mine.loadingTimer);
    clearTimeout(mine.pollTimer);
    if (ctx === mine) ctx = null;
  };
}

export function onQuery(query) {
  if (!ctx) return;
  const go = async () => {
    if (query.eval && Number(query.eval) !== ctx.evaluation?.id) {
      ctx.openCrit = query.crit || null;
      await loadEvaluation(Number(query.eval));
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
  $$(".cv-msg.is-focus", ctx.root).forEach((m) => m.classList.remove("is-focus"));
  el.classList.add("is-focus");
  // restart the flash animation
  el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash");
  if (scroll) {
    ctx.followUntil = Date.now() + 4000;
    scrollInBox(tr, el);
    // Explicit jumps also bring the transcript itself into view (single-column / mobile layout).
    const r = tr.getBoundingClientRect();
    if (page && (r.bottom < 80 || r.top > window.innerHeight - 80)) $(".cv-tr-card", ctx.root).scrollIntoView({ block: "start", behavior: "smooth" });
  }
  if (ctx.player) {
    ctx.player.setMarks({ focus: n });
    if (seek && ctx.player.hasAudio()) ctx.player.seekTo(ctx.seconds[n - 1], { autoplay: false });
  }
}

const matchesFilter = (el, f) => f === "all" || (f === "ctx" ? !["client", "operator"].includes(el.dataset.sp) : el.dataset.sp === f);

function karaoke(n, isPlaying) {
  if (!ctx) return;
  $$(".cv-msg.is-playing", ctx.root).forEach((m) => m.classList.remove("is-playing"));
  if (!n) return;
  const el = $(`#msg-${n}`, ctx.root);
  if (!el) return;
  el.classList.add("is-playing");
  if (!isPlaying) return;
  const tr = $("#transcript", ctx.root);
  const follow = $("#cv-follow", ctx.root);
  if (Date.now() >= ctx.followUntil) { scrollInBox(tr, el); follow.hidden = true; }
  else follow.hidden = false;
}

function markEvidence(row, crit) {
  $$(".cv-msg.is-evidence, .cv-msg.in-range", ctx.root).forEach((m) => m.classList.remove("is-evidence", "in-range"));
  const bar = $("#cv-tr-ctx", ctx.root);
  const range = [];
  if (row && row.checked_range) for (let n = row.checked_range[0]; n <= row.checked_range[1]; n++) range.push(n);
  if (row) {
    (row.evidence || []).forEach((n) => $(`#msg-${n}`, ctx.root)?.classList.add("is-evidence"));
    range.forEach((n) => $(`#msg-${n}`, ctx.root)?.classList.add("in-range"));
  }
  if (ctx.player) ctx.player.setMarks({ evidence: row ? row.evidence || [] : [], range, focus: null });
  if (!row || !crit) { bar.hidden = true; bar.innerHTML = ""; return; }
  const ev = (row.evidence || []).length;
  bar.hidden = false;
  bar.innerHTML = `
    <span class="cv-tr-ctx-dot" aria-hidden="true"></span>
    <span class="cv-tr-ctx-text">${ev ? `Подсвечено ${ev} ${plural(ev, "доказательство", "доказательства", "доказательств")}` : "Подсвечен проверенный участок"} по критерию
      <b>${crit.code ? esc(crit.code) + " " : ""}${esc(crit.title)}</b>${range.length ? ` · участок #${range[0]}–#${range[range.length - 1]}` : ""}</span>
    <button type="button" class="cv-x" data-clear aria-label="Снять подсветку">✕</button>`;
}

// ------------------------------------------------------------ evaluation ----

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
  $("#eval-panel", ctx.root).innerHTML = `${panelHead(null)}
    <div class="cv-empty">
      <div class="cv-empty-ic" aria-hidden="true">✓</div>
      <b>Диалог ещё не оценён</b>
      <span>Выберите чек-лист вверху и нажмите «Оценить» — модель проверит диалог по каждому критерию и объяснит решение со ссылками на реплики.</span>
    </div>`;
  bindHistory();
}

function startLoading(ev) {
  stopLoading();
  const kid = Number($("#sel-checklist", ctx.root).value);
  const cl = ctx.checklists.find((c) => c.id === kid);
  const crits = ev?.checklist?.criteria?.length || cl?.criteria_count || 0;
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
  const kid = Number($("#sel-checklist", ctx.root).value);
  const sel = $("#sel-checklist", ctx.root);
  busy(btn, true, "Оценка…");
  sel.disabled = true;
  startLoading(null);
  const mine = ctx;
  try {
    const ev = await api.evaluate(ctx.conv.id, kid);
    if (ctx !== mine) return;
    ctx.conv = { ...ctx.conv, evaluations: (await api.conversation(ctx.conv.id)).evaluations };
    history.replaceState(null, "", `#/conversation/${encodeURIComponent(ctx.conv.id)}?eval=${ev.id}`);
    ctx.openCrit = null;
    drawEvaluation(ev);
    if (ev.status === "error") toast(`Ошибка оценки: ${ev.error}`, true);
    else toast(`Оценка готова: ${fmtNum(ev.final_total)} из 100`);
  } catch (e) {
    if (ctx !== mine) return;
    toast(e.message, true);
    if (ctx.evaluation) drawEvaluation(ctx.evaluation); else drawEmpty();
  } finally {
    if (ctx === mine) { busy(btn, false); sel.disabled = false; }
  }
}

async function loadEvaluation(id) {
  const ev = await api.evaluation(id);
  if (!ctx) return;
  drawEvaluation(ev);
}

function drawEvaluation(ev) {
  ctx.evaluation = ev;
  clearTimeout(ctx.pollTimer);
  const panel = $("#eval-panel", ctx.root);

  if (ev.status !== "done") {
    if (ev.status === "running" || ev.status === "pending") {
      startLoading(ev);
      ctx.pollTimer = setTimeout(() => ctx && ctx.evaluation?.id === ev.id && loadEvaluation(ev.id).catch(() => {}), 2500);
    } else {
      stopLoading();
      panel.innerHTML = panelHead(ev) + `<div class="cv-pad">
        <div class="cv-note cv-note-warn"><b>Ошибка оценки:</b> ${esc(ev.error || "неизвестная ошибка")}</div>
        <p class="cv-muted-s">Нажмите «Оценить», чтобы повторить.</p></div>`;
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
        <span class="cv-banner-ic" aria-hidden="true">!</span>
        <div><b>Грубая ошибка</b> — отмечается отдельно от балла
          <div class="cv-banner-list">${score.critical_criteria.map((id) => `<button type="button" class="cv-link" data-open="${esc(id)}">${esc(critCfg[id]?.title || id)}</button>`).join(", ")}</div></div>
      </div>`
    : `<div class="cv-banner is-ok"><span class="cv-banner-ic" aria-hidden="true">✓</span>Грубых ошибок не выявлено</div>`;

  panel.innerHTML = panelHead(ev) + `
    <div class="cv-score">
      ${ringHtml(score.total)}
      <div class="cv-score-side">
        <div class="cv-score-cap">${totalChanged ? "Итог после пересмотра" : "Итоговая оценка"}</div>
        ${totalChanged ? `
          <div class="cv-revised">
            <span class="cv-revised-was" title="Исходная оценка модели">${fmtNum(ev.total)}</span>
            <span aria-hidden="true">→</span>
            <b>${fmtNum(ev.final_total)}</b>
            <span class="cv-delta ${delta > 0 ? "is-up" : "is-down"}">${delta > 0 ? "+" : "−"}${fmtNum(Math.abs(delta))}</span>
          </div>
          <div class="cv-muted-s">Исходная оценка модели: ${fmtNum(ev.total)} · решений по апелляциям: ${resolved}</div>`
        : resolved ? `<div class="cv-muted-s">Апелляции рассмотрены (${resolved}), итог не изменился</div>` : ""}
        ${openApp ? `<div class="cv-muted-s"><span class="cv-tag is-warn">${openApp} ${plural(openApp, "апелляция", "апелляции", "апелляций")} на рассмотрении</span></div>` : ""}
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
    ${critical}
    <div id="cv-why">${lossesHtml({ ev, critCfg, scoreRows, appealsBy, expanded: ctx.whyExpanded })}</div>
    ${ev.summary ? `<div class="cv-summary"><span class="cv-summary-h">Резюме модели</span>${esc(ev.summary)}</div>` : ""}
    <div class="cv-crits" id="crit-list">
      <div class="cv-crits-h"><h3>Критерии</h3><span class="cv-muted-s">нажмите, чтобы увидеть объяснение и реплики</span></div>
      ${groups.map((g) => {
        const ss = secScore[g.id];
        return `<div class="cv-group">
          <div class="cv-group-h"><span>${esc(sectionTitle[g.id] || ss?.title || "")}</span>
            ${ss ? `<span>${ss.max_points === null ? "без баллов" : `${fmtNum(ss.points)} / ${fmtNum(ss.max_points)}`}</span>` : ""}</div>
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
  if (ctx.openCrit) toggleCrit(ctx.openCrit, true);
  else markEvidence(null);
}

function onPanelClick(e) {
  const t = e.target;
  const msg = t.closest("[data-msg]");
  if (msg) { focusMsg(Number(msg.dataset.msg), { page: true }); return; }
  const ap = t.closest("[data-appeal]");
  if (ap) { appealDialog(ap.dataset.appeal); return; }
  const jump = t.closest("[data-jump]");
  if (jump) { toggleCrit(jump.dataset.jump, true, { page: true }); return; }
  const open = t.closest("[data-open]");
  if (open) {
    toggleCrit(open.dataset.open, true);
    const el = $(`.cv-crit[data-crit="${CSS.escape(open.dataset.open)}"]`, ctx.root);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
    loadEvaluation(Number(sel.value)).catch((e) => toast(e.message, true));
  });
}

function setUrl() {
  const ev = ctx.evaluation;
  if (!ev) return;
  const q = new URLSearchParams({ eval: String(ev.id) });
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

function appealDialog(critId) {
  const ev = ctx.evaluation;
  const crit = ev.checklist.criteria.find((c) => c.id === critId);
  const row = ev.final_criteria.find((r) => r.criterion_id === critId);
  const srow = ev.final_score.criteria.find((r) => r.criterion_id === critId);
  const av = answerView(crit, row.answer);
  modal({
    title: `Оспорить оценку: ${crit.code ? crit.code + " " : ""}${crit.title}`,
    submitText: "Подать апелляцию",
    body: `
      <div class="cv-ap-cur">
        <span class="cv-ic cv-k-${row.answer === "na" ? "na" : av.kind}" aria-hidden="true">${esc(row.answer === "na" ? "N/A" : av.icon)}</span>
        <div><b>Текущая оценка: ${esc(av.label)}</b>${srow && srow.points !== null && srow.points !== undefined ? ` · ${fmtNum(srow.points)} / ${fmtNum(srow.max_points)} балл.` : ""}
          <div class="cv-muted-s">${esc(row.explanation || "")}</div></div>
      </div>
      <label class="field">Комментарий — почему оценка неверна
        <textarea class="input" id="ap-comment" rows="4" placeholder="Например: оператор представился в реплике #3, приветствие было на казахском"></textarea></label>
      <label class="field">Автор (необязательно)
        <input class="input" id="ap-author" placeholder="Оператор / супервайзер" value="${esc(window.CQA_USER || "")}" ${window.CQA_USER ? "readonly" : ""}></label>
      <div class="cv-muted-s">Проверяющий увидит комментарий, объяснение модели и фрагмент диалога, затем подтвердит или изменит оценку.</div>`,
    onSubmit: async (el) => {
      const comment = $("#ap-comment", el).value.trim();
      if (!comment) throw new Error("Добавьте комментарий");
      const a = await api.createAppeal({ evaluation_id: ev.id, criterion_id: critId, comment, author: $("#ap-author", el).value.trim() || null });
      toast(`Апелляция #${a.id} отправлена проверяющему`);
      if (!ctx) return;
      ctx.openCrit = critId;
      await loadEvaluation(ev.id);
      refreshBadge();
    },
  });
}
