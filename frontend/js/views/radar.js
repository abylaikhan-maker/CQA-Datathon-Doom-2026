import { api } from "../api.js";
import { $, CHANNEL, LANG, busy, esc, fmtDate, fmtNum, icon, plural } from "../util.js";

const CATEGORIES = {
  access: "Вход и доступ",
  app: "Приложение",
  documents: "Документы и отчёты",
  deposit: "Пополнение и переводы",
  withdrawal: "Вывод средств",
  trading: "Торговые операции",
  verification: "Идентификация и данные",
  support: "Поддержка и процессы",
  other: "Другое",
};
const RUN_STATUS = { running: "В процессе", finished: "Завершён", error: "Ошибка" };
const POLL_MS = 2500;

function hrefFor(group, runId) {
  const query = new URLSearchParams({ group });
  if (runId) query.set("run", runId);
  return `#/radar?${query}`;
}

function runName(run) {
  return `#${run.id} · ${fmtDate(run.created_at)} · ${RUN_STATUS[run.status] || run.status}`;
}

function empty(title, description) {
  return `<div class="card empty-state">
    <div class="ic">${icon("score")}</div>
    <h3>${esc(title)}</h3><p>${esc(description)}</p>
  </div>`;
}

function metric(label, value) {
  return `<div class="card card-pad radar-metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function quoteRow(item) {
  const href = `#/conversation/${encodeURIComponent(item.conversation_id)}?msg=${encodeURIComponent(item.turn)}`;
  return `<li class="radar-quote">
    <div class="radar-quote-main">
      <div class="radar-quote-meta">
        <span class="mono">${esc(item.conversation_id)}</span>
        <span>${esc(CHANNEL[item.channel] || item.channel)}</span>
        <span>${esc(LANG[item.language] || item.language)}</span>
      </div>
      <blockquote>${esc(item.quote)}</blockquote>
    </div>
    <a class="btn btn-sm radar-source" href="${esc(href)}">К реплике №${esc(item.turn)} ${icon("chev")}</a>
  </li>`;
}

function problemsHtml(groups) {
  return groups.map((problem, index) => {
    const count = new Set(problem.items.map((item) => item.conversation_id)).size;
    const noun = plural(count, ["диалог", "диалога", "диалогов"]);
    return `<details class="card radar-problem" ${index === 0 ? "open" : ""}>
      <summary>
        <span class="radar-problem-text">
          <span class="radar-category">${esc(CATEGORIES[problem.category] || CATEGORIES.other)}</span>
          <strong>${esc(problem.label)}</strong>
        </span>
        <span class="badge outline radar-count">${fmtNum(count, 0)} ${noun}</span>
      </summary>
      <ul class="radar-quotes">${problem.items.map(quoteRow).join("")}</ul>
    </details>`;
  }).join("");
}

function warningsHtml(run) {
  const result = run.result || {};
  const failedIds = result.failed_ids || [];
  return `${run.failed ? `<aside class="radar-warning">
    <strong>Не удалось обработать ${fmtNum(run.failed, 0)} ${plural(run.failed, ["диалог", "диалога", "диалогов"])}</strong>
    ${failedIds.length ? `<p class="mono">${failedIds.map(esc).join(", ")}</p>` : ""}
  </aside>` : ""}
  ${result.stale_evidence ? `<aside class="radar-warning">
    <strong>Часть транскриптов обновилась</strong>
    <p>Запустите анализ снова, чтобы сверить все реплики с текущими транскриптами.</p>
  </aside>` : ""}`;
}

function reportHtml(run, group) {
  if (!group) return empty("Нет наборов для анализа", "Загрузите набор диалогов в разделе «Разговоры».");
  if (!run) return empty("Для этого набора ещё нет отчёта", "Запустите анализ, чтобы найти повторяющиеся жалобы клиентов.");
  if (run.status === "running") {
    const processed = run.done + run.failed;
    return `<section class="card card-pad radar-progress" aria-label="Ход анализа">
      <div class="radar-progress-heading"><h2>Анализ выполняется</h2>
        <span>Обработано ${fmtNum(processed, 0)} из ${fmtNum(run.total, 0)}</span></div>
      <progress aria-label="Обработано диалогов" value="${processed}" max="${run.total}"></progress>
      <p class="muted small">После обработки диалогов радар сгруппирует найденные жалобы.</p>
    </section>`;
  }
  if (run.status === "error") {
    return `<section class="card card-pad radar-warning">
      <h2>Анализ не завершился</h2>
      <p>${esc(run.error || "Попробуйте запустить анализ снова.")}</p>
    </section>${warningsHtml(run)}`;
  }
  const result = run.result;
  if (!result) return empty("Отчёт пока недоступен", "Нажмите «Обновить», чтобы повторить загрузку.");
  return `
    <div class="radar-metrics">
      ${metric("Диалогов проанализировано", `${fmtNum(run.done, 0)} <small>из ${fmtNum(run.total, 0)}</small>`)}
      ${metric("Диалогов с жалобами", fmtNum(result.dialogs_with_signals, 0))}
      ${metric("Повторяющихся проблем", fmtNum(result.groups.length, 0))}
    </div>
    <p class="radar-run-meta muted small">
      Прогон #${esc(run.id)} · ${esc(run.model)} · ${esc(fmtDate(run.finished_at || run.created_at))}
    </p>
    ${warningsHtml(run)}
    ${result.groups.length ? `
      <section class="radar-results-list" aria-label="Повторяющиеся жалобы">
        <div class="radar-results-heading"><h2>Повторяющиеся жалобы</h2>
          <p class="muted small">Число рядом с темой — сколько разных диалогов её подтверждают.</p></div>
        ${problemsHtml(result.groups)}
      </section>`
      : empty("Повторяющиеся жалобы не найдены", "Для группы нужны подтверждающие реплики из двух или более диалогов.")}`;
}

export async function render(root, params, query = {}) {
  const groups = await api.groups();
  const group = groups.find((entry) => entry.id === query.group)
    || groups.find((entry) => entry.id === "DEV") || groups[0];
  let runs = group ? await api.radarRuns(group.id) : [];
  const selected = runs.find((entry) => String(entry.id) === query.run) || runs[0];
  let run = selected ? await api.radarRun(selected.id) : null;
  if (!root.isConnected) return;

  root.innerHTML = `<div class="radar-page">
    <div class="page-head">
      <div><h1>Радар проблем</h1>
        <div class="sub">Повторяющиеся жалобы клиентов со ссылками на исходные реплики.</div></div>
      <div class="radar-actions">
        <label class="field">Набор диалогов
          <select class="input" id="radar-group" ${group ? "" : "disabled"}>
            ${groups.map((entry) => `<option value="${esc(entry.id)}" ${entry === group ? "selected" : ""}>${esc(entry.id)} · ${fmtNum(entry.count, 0)}</option>`).join("") || '<option>Нет наборов</option>'}
          </select>
        </label>
        <button class="btn" id="radar-refresh" type="button" ${group ? "" : "disabled"}>${icon("refresh")}Обновить</button>
        <button class="btn btn-primary" id="radar-run" type="button"></button>
      </div>
    </div>
    <label class="field radar-history" id="radar-history" hidden>Прогон
      <select class="input" id="radar-run-select"></select>
    </label>
    <p id="radar-feedback" class="radar-warning" role="status" hidden></p>
    <div id="radar-progress" aria-live="polite" class="radar-sr"></div>
    <div id="radar-results"></div>
  </div>`;

  const history = $("#radar-history", root);
  const runSelect = $("#radar-run-select", root);
  const runButton = $("#radar-run", root);
  const refreshButton = $("#radar-refresh", root);
  const feedback = $("#radar-feedback", root);
  const progress = $("#radar-progress", root);
  const results = $("#radar-results", root);
  let timer;
  let pending = false;

  function updateRun(next) {
    run = next;
    if (!next) return;
    const index = runs.findIndex((entry) => entry.id === next.id);
    if (index < 0) runs.unshift(next);
    else runs[index] = next;
  }

  function drawControls() {
    const running = runs.some((entry) => entry.status === "running");
    runButton.disabled = !group || running;
    runButton.innerHTML = running ? "Анализ выполняется" : `${icon("play")}Анализировать набор`;
    history.hidden = runs.length < 2;
    runSelect.innerHTML = runs.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === run?.id ? "selected" : ""}>${esc(runName(entry))}</option>`).join("");
  }

  function drawReport() {
    results.dataset.runStatus = run?.status || "empty";
    results.innerHTML = reportHtml(run, group);
    const announcement = run?.status === "running" ? `Обработано ${run.done + run.failed} из ${run.total}` : "";
    if (progress.textContent !== announcement) progress.textContent = announcement;
  }

  function showFeedback(message = "") {
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  function schedule(delay = POLL_MS) {
    clearTimeout(timer);
    const active = runs.find((entry) => entry.status === "running");
    if (root.isConnected && active) timer = setTimeout(() => poll(active.id), delay);
  }

  async function poll(id) {
    if (!root.isConnected) return;
    if (pending) { schedule(); return; }
    pending = true;
    let delay = POLL_MS;
    try {
      const next = await api.radarRun(id);
      if (!root.isConnected) return;
      const isSelected = run?.id === id;
      if (isSelected) {
        updateRun(next);
        drawReport();
      } else {
        const index = runs.findIndex((entry) => entry.id === id);
        if (index >= 0) runs[index] = next;
      }
      if (next.status !== "running") drawControls();
      showFeedback();
    } catch {
      showFeedback("Не удалось обновить ход анализа. Радар попробует ещё раз.");
      delay = 6000;
    } finally {
      pending = false;
      schedule(delay);
    }
  }

  async function refresh() {
    if (pending || !group) return;
    pending = true;
    refreshButton.disabled = true;
    try {
      const latest = await api.radarRuns(group.id);
      const summary = latest.find((entry) => String(entry.id) === query.run) || latest[0];
      const next = summary ? await api.radarRun(summary.id) : null;
      if (!root.isConnected) return;
      runs = latest;
      updateRun(next);
      showFeedback();
      drawControls();
      drawReport();
    } catch (err) {
      showFeedback(err.message);
    } finally {
      pending = false;
      refreshButton.disabled = false;
      schedule();
    }
  }

  $("#radar-group", root).addEventListener("change", (event) => { location.hash = hrefFor(event.target.value); });
  runSelect.addEventListener("change", (event) => { location.hash = hrefFor(group.id, event.target.value); });
  refreshButton.addEventListener("click", refresh);
  runButton.addEventListener("click", async () => {
    if (pending || !group) return;
    pending = true;
    busy(runButton, true, "Запускаем…");
    try {
      const next = await api.startRadar(group.id);
      if (!root.isConnected) return;
      query.run = String(next.id);
      window.history.replaceState(null, "", hrefFor(group.id, next.id));
      updateRun(next);
      showFeedback();
      drawReport();
    } catch (err) {
      showFeedback(err.message);
    } finally {
      pending = false;
      drawControls();
      schedule();
    }
  });

  updateRun(run);
  drawControls();
  drawReport();
  schedule();
  return () => clearTimeout(timer);
}
