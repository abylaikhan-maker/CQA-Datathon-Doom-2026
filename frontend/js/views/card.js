import { api } from "../api.js";
import {
  esc, $, $$, fmtNum, fmtDate, toast, busy, modal, ring, answerView, tsSeconds, fmtClock, fmtTs,
  SPEAKER, LANG, CHANNEL,
} from "../util.js";
import { refreshBadge } from "../app.js";

let ctx = null; // { root, conv, evaluation, checklists, cfgById, seconds[] }

export async function render(root, params, query) {
  const [conv, checklists] = await Promise.all([api.conversation(params.id), api.checklists()]);
  const seconds = conv.transcript.map((m) => tsSeconds(m.timestamp, conv.transcript[0]?.timestamp));
  const duration = seconds.filter((s) => s !== null).pop();
  ctx = { root, conv, checklists, seconds, evaluation: null, openCrit: query.crit || null };
  const active = checklists.find((c) => c.is_active) || checklists[0];
  const isCall = conv.channel === "voice call" || !!conv.audio_url;

  root.innerHTML = `
    <div class="crumbs"><a href="#/conversations">Диалоги</a> / ${esc(conv.dataset_group)}</div>
    <div class="page-head">
      <div>
        <h1>Анализ разговора</h1>
        <div class="sub"><span class="mono">${esc(conv.id)}</span> · ${esc(CHANNEL[conv.channel] || conv.channel || "")} ·
          ${esc(LANG[conv.language] || conv.language || "")} · ${conv.transcript.length} реплик${duration ? ` · ${fmtClock(duration)}` : ""}</div>
      </div>
      <div class="spacer"></div>
      <select class="input" id="sel-checklist" style="width:auto;max-width:300px" aria-label="Чек-лист">
        ${checklists.map((c) => `<option value="${c.id}" ${c.id === active?.id ? "selected" : ""}>${esc(c.name)} · v${c.version}${c.is_active ? " (активный)" : ""}</option>`).join("")}
      </select>
      <button class="btn btn-primary" id="btn-eval">Оценить</button>
    </div>
    ${isCall ? `
      <div class="card player">
        <b>🎧 Запись звонка</b>
        ${conv.audio_url ? `<audio id="audio" controls preload="none" src="${esc(conv.audio_url)}"></audio>
          <a class="btn btn-sm" href="${esc(conv.audio_url)}" target="_blank" rel="noopener">Открыть в плеере ↗</a>`
          : `<span class="muted">Ссылка на запись отсутствует</span>`}
        <span class="muted small" id="audio-pos"></span>
      </div>` : ""}
    <div class="conv-grid">
      <section class="card">
        <div class="card-head"><h2>Расшифровка</h2><div class="spacer"></div>
          <span class="muted small">Бот и система — контекст, не оцениваются</span></div>
        <div class="transcript" id="transcript">
          ${conv.transcript.map((m, i) => msgHtml(m, i + 1, seconds[i], isCall && conv.audio_url)).join("")}
        </div>
      </section>
      <section class="card" id="eval-panel"></section>
    </div>`;

  $("#transcript", root).addEventListener("click", (e) => {
    const p = e.target.closest("[data-play]");
    if (p) playAt(Number(p.dataset.play));
  });
  $("#btn-eval", root).addEventListener("click", (e) => runEvaluation(e.currentTarget));
  const audio = $("#audio", root);
  if (audio) audio.addEventListener("timeupdate", () => syncAudio(audio.currentTime));

  const evId = query.eval ? Number(query.eval) : conv.evaluations[0]?.id;
  if (evId) await loadEvaluation(evId);
  else drawEmpty();
  if (query.msg) focusMsg(Number(query.msg));
  return () => { ctx = null; };
}

export function onQuery(query) {
  if (!ctx) return;
  if (query.eval && Number(query.eval) !== ctx.evaluation?.id) loadEvaluation(Number(query.eval));
  if (query.msg) focusMsg(Number(query.msg));
}

function msgHtml(m, n, sec, playable) {
  const sp = String(m.speaker || "").toLowerCase();
  return `
    <div class="msg ${esc(sp)}" id="msg-${n}" data-n="${n}">
      <div class="n">#${n}</div>
      <div class="meta">
        <span class="who">${esc(SPEAKER[sp] || m.speaker)}</span>
        <span class="ts-link" title="${esc(m.timestamp)}">${esc(fmtTs(m.timestamp))}</span>
        ${playable && sec !== null ? `<button class="play" data-play="${n}" title="Прослушать с ${fmtClock(sec)}">▶ ${fmtClock(sec)}</button>` : ""}
      </div>
      <div class="text">${esc(m.text)}</div>
    </div>`;
}

function playAt(n) {
  const audio = $("#audio", ctx.root);
  const s = ctx.seconds[n - 1];
  if (!audio || s === null) return;
  audio.currentTime = s;
  audio.play().catch(() => toast("Браузер не смог воспроизвести запись — откройте её в плеере", true));
}

function syncAudio(t) {
  const pos = $("#audio-pos", ctx.root);
  if (pos) pos.textContent = fmtClock(t);
}

function focusMsg(n, { play = true } = {}) {
  const el = $(`#msg-${n}`, ctx.root);
  if (!el) return;
  $$(".msg.focus", ctx.root).forEach((m) => m.classList.remove("focus"));
  el.classList.add("focus");
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  if (play && $("#audio", ctx.root) && !$("#audio", ctx.root).paused) playAt(n);
}

function markEvidence(crow) {
  $$(".msg.evidence, .msg.in-range", ctx.root).forEach((m) => m.classList.remove("evidence", "in-range"));
  if (!crow) return;
  (crow.evidence || []).forEach((n) => $(`#msg-${n}`, ctx.root)?.classList.add("evidence"));
  if (crow.checked_range) {
    for (let n = crow.checked_range[0]; n <= crow.checked_range[1]; n++) $(`#msg-${n}`, ctx.root)?.classList.add("in-range");
  }
}

function drawEmpty() {
  $("#eval-panel", ctx.root).innerHTML = `
    <div class="card-head"><h2>Оценка качества</h2></div>
    <div class="empty">Диалог ещё не оценён.<br>Выберите чек-лист и нажмите «Оценить».</div>`;
}

async function runEvaluation(btn) {
  const kid = Number($("#sel-checklist", ctx.root).value);
  busy(btn, true, "Оценка…");
  $("#eval-panel", ctx.root).innerHTML = `
    <div class="card-head"><h2>Оценка качества</h2></div>
    <div class="empty"><span class="spinner"></span><br><br>Модель анализирует диалог по чек-листу…</div>`;
  try {
    const ev = await api.evaluate(ctx.conv.id, kid);
    ctx.conv = await api.conversation(ctx.conv.id);
    history.replaceState(null, "", `#/conversation/${encodeURIComponent(ctx.conv.id)}?eval=${ev.id}`);
    drawEvaluation(ev);
    if (ev.status === "error") toast(`Ошибка оценки: ${ev.error}`, true);
  } catch (e) {
    toast(e.message, true);
    drawEmpty();
  } finally {
    busy(btn, false);
  }
}

async function loadEvaluation(id) {
  const ev = await api.evaluation(id);
  drawEvaluation(ev);
}

function drawEvaluation(ev) {
  ctx.evaluation = ev;
  const panel = $("#eval-panel", ctx.root);
  const cfg = ev.checklist;
  const history_ = ctx.conv.evaluations;
  const head = `
    <div class="card-head">
      <h2>Оценка качества</h2><div class="spacer"></div>
      ${history_.length > 1 ? `<select class="input" id="sel-eval" style="width:auto;font-size:12.5px" aria-label="История оценок">
        ${history_.map((h) => `<option value="${h.id}" ${h.id === ev.id ? "selected" : ""}>#${h.id} · ${esc(h.checklist_name)} v${h.checklist_version} · ${fmtDate(h.created_at)}${h.status === "error" ? " · ошибка" : ""}</option>`).join("")}
      </select>` : `<span class="muted small">${esc(ev.checklist_name)} · v${ev.checklist_version}</span>`}
    </div>`;

  if (ev.status !== "done") {
    panel.innerHTML = head + `<div class="card-pad">${ev.status === "error"
      ? `<div class="note warn">Ошибка оценки: ${esc(ev.error)}</div><p class="muted small">Нажмите «Оценить», чтобы повторить.</p>`
      : `<div class="empty"><span class="spinner"></span> Оценка выполняется…</div>`}</div>`;
    bindHistory();
    if (ev.status === "running" || ev.status === "pending") setTimeout(() => ctx && ctx.evaluation?.id === ev.id && loadEvaluation(ev.id), 2500);
    return;
  }

  const score = ev.final_score;
  const changed = Number(ev.total) !== Number(ev.final_total) || ev.appeals.some((a) => a.status !== "open");
  const critCfg = Object.fromEntries(cfg.criteria.map((c) => [c.id, c]));
  const scoreRows = Object.fromEntries(score.criteria.map((r) => [r.criterion_id, r]));
  const origRows = Object.fromEntries(ev.score.criteria.map((r) => [r.criterion_id, r]));
  const appealsBy = {};
  ev.appeals.forEach((a) => (appealsBy[a.criterion_id] = appealsBy[a.criterion_id] || []).push(a));

  panel.innerHTML = head + `
    <div class="score-head">
      ${ring(score.total)}
      <div class="sections">
        ${changed ? `<div class="small">Исходная оценка <b>${fmtNum(ev.total)}</b> → итог после пересмотра <b>${fmtNum(ev.final_total)}</b></div>` : ""}
        ${score.total === null ? `<div class="note na">Итог не рассчитывается: нет применимых критериев с весом.</div>` : ""}
        ${(score.sections || []).filter((s) => s.max_points !== null).map((s) => `
          <div class="sec-row"><span>${esc(s.title)}</span><b>${fmtNum(s.points)} / ${fmtNum(s.max_points)}</b>
            <div class="progress"><i style="width:${s.max_points ? (s.points / s.max_points) * 100 : 0}%"></i></div></div>`).join("")}
      </div>
    </div>
    ${score.critical
      ? `<div class="crit-banner">⚠ Грубая ошибка: ${score.critical_criteria.map((id) => esc(critCfg[id]?.title || id)).join(", ")} — отмечено отдельно от балла</div>`
      : `<div class="ok-banner">Грубых ошибок не выявлено</div>`}
    ${ev.summary ? `<div class="summary">${esc(ev.summary)}</div>` : ""}
    <div id="crit-list">
      ${ev.final_criteria.map((row) => critHtml(row, critCfg[row.criterion_id], scoreRows[row.criterion_id], origRows[row.criterion_id], appealsBy[row.criterion_id] || [], cfg)).join("")}
    </div>
    <div class="eval-meta">
      <span>Оценка #${ev.id}</span><span>${esc(ev.model || "")}</span>
      ${ev.usage ? `<span>${fmtNum(ev.usage.input_tokens, 0)} вх. / ${fmtNum(ev.usage.output_tokens, 0)} вых. токенов</span>` : ""}
      ${ev.cost_usd !== null ? `<span>≈ $${fmtNum(ev.cost_usd, 5)}</span>` : ""}
      ${ev.duration_ms ? `<span>${fmtNum(ev.duration_ms / 1000, 1)} с</span>` : ""}
      <span>${fmtDate(ev.finished_at)}</span>
    </div>`;

  bindHistory();
  $("#crit-list", panel).addEventListener("click", (e) => {
    const evb = e.target.closest("[data-msg]");
    if (evb) { e.preventDefault(); focusMsg(Number(evb.dataset.msg)); return; }
    const ap = e.target.closest("[data-appeal]");
    if (ap) { appealDialog(ap.dataset.appeal); return; }
    if (e.target.closest("a, button")) return;
    const top = e.target.closest(".crit-top");
    if (top) toggleCrit(top.parentElement.dataset.crit);
  });
  if (ctx.openCrit) toggleCrit(ctx.openCrit, true);
}

function bindHistory() {
  const sel = $("#sel-eval", ctx.root);
  if (sel) sel.addEventListener("change", () => {
    history.replaceState(null, "", `#/conversation/${encodeURIComponent(ctx.conv.id)}?eval=${sel.value}`);
    loadEvaluation(Number(sel.value));
  });
}

function toggleCrit(id, forceOpen = false) {
  const el = $(`.crit[data-crit="${CSS.escape(id)}"]`, ctx.root);
  if (!el) return;
  const willOpen = forceOpen || !el.classList.contains("open");
  $$(".crit.open", ctx.root).forEach((c) => c.classList.remove("open"));
  if (willOpen) {
    el.classList.add("open");
    ctx.openCrit = id;
    const row = ctx.evaluation.final_criteria.find((r) => r.criterion_id === id);
    markEvidence(row);
    const first = (row.evidence || [])[0] || (row.checked_range || [])[0];
    if (first) focusMsg(first, { play: false });
  } else {
    ctx.openCrit = null;
    markEvidence(null);
  }
}

function critHtml(row, crit, srow, orow, appeals, cfg) {
  if (!crit) return "";
  const av = answerView(crit, row.answer);
  const msgs = ctx.conv.transcript;
  let pts;
  if (crit.type === "critical") pts = `<span class="badge ${row.answer === "yes" ? "crit" : "yes"}">${av.label}</span><small>без баллов</small>`;
  else if (row.answer === "na") pts = `<span class="badge na">N/A</span><small>вес ${fmtNum(crit.weight)} перераспределён</small>`;
  else pts = `${fmtNum(srow?.points)} / ${fmtNum(srow?.max_points)}<small>${av.label} · вес ${fmtNum(crit.weight)}${srow && Math.abs(srow.max_points - crit.weight) > 0.001 ? ` → ${fmtNum(srow.max_points)}` : ""}</small>`;

  const ev = (row.evidence || []).map((n) => {
    const m = msgs[n - 1];
    if (!m) return "";
    return `<button class="ev" data-msg="${n}"><span class="ref">#${n} ${esc(SPEAKER[m.speaker] || m.speaker)} ${esc(fmtTs(m.timestamp))}</span><span class="q">${esc(m.text)}</span></button>`;
  }).join("");
  const range = row.checked_range
    ? `<div class="note">Проверенный участок: <a href="#" data-msg="${row.checked_range[0]}">#${row.checked_range[0]}</a>–<a href="#" data-msg="${row.checked_range[1]}">#${row.checked_range[1]}</a>${row.answer === "no" ? " — ожидаемое действие здесь не найдено" : ""}</div>` : "";
  const review = row.review
    ? row.review.confirmed
      ? `<div class="note review">✔ Оценка подтверждена проверяющим${row.review.reviewer ? ` (${esc(row.review.reviewer)})` : ""}: ${esc(row.review.reason)}</div>`
      : `<div class="note review">✎ Изменено проверяющим${row.review.reviewer ? ` (${esc(row.review.reviewer)})` : ""}: ${esc(answerView(crit, row.review.from).label)} → <b>${esc(answerView(crit, row.review.to).label)}</b>${orow && orow.points !== null ? ` (было ${fmtNum(orow.points)} балл.)` : ""}. Причина: ${esc(row.review.reason)}</div>`
    : "";
  const openAppeal = appeals.find((a) => a.status === "open");
  return `
    <div class="crit" data-crit="${esc(crit.id)}">
      <div class="crit-top">
        <span class="crit-ic ${av.kind}">${av.icon}</span>
        <span class="crit-title"><span class="code">${esc(crit.code || "")}</span>${esc(crit.title)}
          ${openAppeal ? ` <span class="badge warn">апелляция</span>` : ""}${row.review ? ` <span class="badge brand">пересмотрено</span>` : ""}</span>
        <span class="crit-pts">${pts}</span>
      </div>
      <div class="crit-body">
        <p>${esc(row.explanation || "—")}</p>
        ${row.answer === "na" && row.na_reason ? `<div class="note na">Причина N/A: ${esc(row.na_reason)}</div>` : ""}
        ${ev ? `<div class="ev-list">${ev}</div>` : ""}
        ${range}
        ${row.warning ? `<div class="note warn">${esc(row.warning)}</div>` : ""}
        ${review}
        ${appeals.map((a) => `<div class="note">${a.status === "open" ? "⏳ Апелляция на рассмотрении" : "Апелляция рассмотрена"}: «${esc(a.comment)}» · <a href="#/appeals/${a.id}">открыть</a></div>`).join("")}
        <div class="crit-actions">
          ${openAppeal ? "" : `<button class="btn btn-sm" data-appeal="${esc(crit.id)}">Оспорить оценку</button>`}
        </div>
      </div>
    </div>`;
}

function appealDialog(critId) {
  const ev = ctx.evaluation;
  const crit = ev.checklist.criteria.find((c) => c.id === critId);
  const row = ev.final_criteria.find((r) => r.criterion_id === critId);
  modal({
    title: `Апелляция: ${crit.code || ""} ${crit.title}`,
    submitText: "Подать апелляцию",
    body: `
      <div class="note">Текущая оценка: <b>${esc(answerView(crit, row.answer).label)}</b>. ${esc(row.explanation || "")}</div>
      <label class="field">Комментарий (почему оценка неверна)
        <textarea class="input" id="ap-comment" rows="4" placeholder="Например: оператор представился в реплике #3, приветствие было на казахском"></textarea></label>
      <label class="field">Автор (необязательно)
        <input class="input" id="ap-author" placeholder="Оператор / супервайзер" value="${esc(window.CQA_USER || "")}" ${window.CQA_USER ? "readonly" : ""}></label>`,
    onSubmit: async (el) => {
      const comment = $("#ap-comment", el).value.trim();
      if (!comment) throw new Error("Добавьте комментарий");
      const a = await api.createAppeal({ evaluation_id: ev.id, criterion_id: critId, comment, author: $("#ap-author", el).value.trim() || null });
      toast(`Апелляция #${a.id} отправлена проверяющему`);
      ctx.openCrit = critId;
      await loadEvaluation(ev.id);
      refreshBadge();
    },
  });
}
