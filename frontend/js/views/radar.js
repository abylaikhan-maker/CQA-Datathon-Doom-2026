import { api } from "../api.js";
import { $, CHANNEL, LANG, busy, esc, fmtDate, fmtNum, icon, modal, plural, toast } from "../util.js";

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
const TASK_STATUS = {
  new: { label: "На рассмотрении", badge: "warn" },
  in_progress: { label: "В работе", badge: "brand" },
  fixed: { label: "Исправлено", badge: "yes" },
};
const TASKS_HREF = "#/radar?tab=tasks";
const taskHref = (id) => `${TASKS_HREF}&task=${encodeURIComponent(id)}`;
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

function metric(symbol, label, value, hint = "") {
  return `<div class="card radar-metric">
    <span class="radar-metric-icon">${icon(symbol)}</span>
    <div><span class="radar-metric-label">${label}</span>
      <div class="radar-metric-value"><strong>${value}</strong>${hint ? `<span>${hint}</span>` : ""}</div>
    </div>
  </div>`;
}

const sourceHref = (item) => `#/conversation/${encodeURIComponent(item.conversation_id)}?msg=${encodeURIComponent(item.turn)}`;
const affectedCount = (problem) => new Set(problem.items.map((item) => item.conversation_id)).size;

function quoteRow(item) {
  return `<li class="radar-quote">
    <div class="radar-quote-main">
      <div class="radar-quote-meta">
        <span class="mono">${esc(item.conversation_id)}</span>
        <span>${esc(CHANNEL[item.channel] || item.channel)}</span>
        <span>${esc(LANG[item.language] || item.language)}</span>
      </div>
      <blockquote>${esc(item.quote)}</blockquote>
    </div>
    <a class="btn btn-sm radar-source" href="${esc(sourceHref(item))}">К реплике №${esc(item.turn)} ${icon("chev")}</a>
  </li>`;
}

function problemsHtml(groups, analyzed) {
  const ranked = groups.map((problem, index) => ({ problem, index, count: affectedCount(problem) }))
    .sort((a, b) => b.count - a.count);
  const rows = ranked.map(({ problem, index, count }) => {
    const category = esc(CATEGORIES[problem.category] || CATEGORIES.other);
    const share = analyzed > 0 ? `${fmtNum(count * 100 / analyzed, 1)}%` : "—";
    return `<tr>
      <th scope="row"><span class="radar-category-inline">${category}</span>${esc(problem.label)}</th>
      <td class="radar-category-col"><span class="radar-category-tag">${category}</span></td>
      <td class="num radar-reach"><strong>${fmtNum(count, 0)}</strong><span class="radar-share-inline">${share}</span></td>
      <td class="num radar-share-col">${share}</td>
      <td><div class="radar-row-actions">
        <button class="btn btn-sm" type="button" data-radar-sources="${index}" aria-label="Цитаты · ${esc(problem.label)}">${icon("chat")}Цитаты</button>
        <button class="btn btn-sm radar-compose" type="button" data-radar-draft="${index}" aria-label="Собрать инсайт · ${esc(problem.label)}">${icon("copy")}<span><span class="radar-compose-label">Собрать </span>инсайт</span></button>
      </div></td>
    </tr>`;
  }).join("");
  return `<section class="card radar-results" aria-labelledby="radar-topics-heading">
    <div class="radar-results-heading"><h2 id="radar-topics-heading">Повторяющиеся жалобы</h2>
      <p class="muted small">Доля от всех проанализированных диалогов</p></div>
    <div class="radar-table-wrap" tabindex="0" role="region" aria-labelledby="radar-topics-heading">
      <table class="table radar-table">
        <thead><tr>
          <th scope="col">Тема</th><th scope="col" class="radar-category-col">Категория</th>
          <th scope="col" class="num">Диалоги<span class="radar-share-inline"> и доля</span></th>
          <th scope="col" class="num radar-share-col">Доля</th><th scope="col">Действия</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function openSources(problem) {
  const count = affectedCount(problem);
  const title = "Исходные реплики";
  const m = modal({
    title,
    cancelText: "Закрыть",
    body: `<div><strong>${esc(problem.label)}</strong>
      <div class="muted small">${esc(CATEGORIES[problem.category] || CATEGORIES.other)} · ${fmtNum(count, 0)} ${plural(count, ["диалог", "диалога", "диалогов"])}</div>
    </div>
    <ul class="radar-quotes">${problem.items.map(quoteRow).join("")}</ul>`,
  });
  const dialog = $('[role="dialog"]', m.el);
  dialog.classList.add("modal-wide");
  dialog.setAttribute("aria-label", title);
  $(".radar-source", m.el)?.focus();
  return m;
}

function openInsight(problem, run) {
  const count = affectedCount(problem);
  const sources = problem.items.map((item) => {
    const url = new URL(sourceHref(item), window.location.href).href;
    const channel = CHANNEL[item.channel] || item.channel;
    return `- ${item.conversation_id} · ${channel} · реплика №${item.turn}\n  «${item.quote}»\n  ${url}`;
  });
  const insight = [
    `Инсайт · ${problem.label}`,
    `Категория · ${CATEGORIES[problem.category] || CATEGORIES.other}`,
    "",
    "Затронутые диалоги",
    `${count} из ${run.done} обработанных · набор ${run.dataset_group} · прогон №${run.id}`,
    "",
    "Исходные реплики", ...sources,
  ].join("\n");
  const m = modal({
    title: "Инсайт",
    cancelText: "Закрыть",
    submitText: "Передать техкоманде",
    body: `<label class="field">Текст инсайта
      <textarea class="input radar-draft-text" id="radar-draft-text" rows="13">${esc(insight)}</textarea></label>
      <p class="muted small">После передачи инсайт появится в очереди задач внутри CQA.</p>
      <p class="muted small radar-draft-status" id="radar-draft-status" role="status"></p>`,
    onSubmit: async (el) => {
      const report = $("#radar-draft-text", el).value.trim();
      if (!report) throw new Error("Введите текст инсайта.");
      const task = await api.createRadarTask({ run_id: run.id, group_index: problem.source_group_index, report });
      if (!el.isConnected) return;
      toast(`Задача №${task.id} в очереди техкоманды.`);
      location.hash = taskHref(task.id);
    },
  });
  const dialog = $('[role="dialog"]', m.el);
  dialog.classList.add("modal-wide");
  dialog.setAttribute("aria-label", "Инсайт");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn";
  copy.textContent = "Скопировать инсайт";
  $("[data-ok]", m.el).before(copy);
  copy.addEventListener("click", async () => {
    const input = $("#radar-draft-text", m.el);
    const status = $("#radar-draft-status", m.el);
    try {
      await navigator.clipboard.writeText(input.value);
      status.textContent = "Инсайт скопирован.";
    } catch {
      input.focus();
      input.select();
      status.textContent = "Текст выделен. Скопируйте его вручную.";
    }
  });
  return m;
}

function taskReportHtml(report) {
  return report.split(/\r?\n/).map((line) => {
    const source = line.trim().match(/^https?:\/\/[^#\s]+(#\/conversation\/\S+)$/);
    return source ? `  <a href="${esc(source[1])}">${esc(source[1])}</a>` : esc(line);
  }).join("\n");
}

function openTask(task) {
  const title = `Задача №${task.id}`;
  const m = modal({
    title,
    cancelText: "Закрыть",
    submitText: "Сохранить статус",
    body: `<div><strong>${esc(task.title)}</strong></div>
      <pre class="radar-task-report">${taskReportHtml(task.report)}</pre>
      <div class="field"><label for="radar-task-status">Статус задачи</label>
        <select id="radar-task-status" class="input">
          ${Object.entries(TASK_STATUS).map(([id, status]) => `<option value="${id}" ${id === task.status ? "selected" : ""}>${status.label}</option>`).join("")}
        </select>
      </div>`,
    onSubmit: async (el) => {
      await api.setRadarTaskStatus(task.id, $("#radar-task-status", el).value);
      if (!el.isConnected) return;
      toast(`Статус задачи №${task.id} сохранён.`);
      location.hash = TASKS_HREF;
    },
  });
  const dialog = $('[role="dialog"]', m.el);
  dialog.classList.add("modal-wide");
  dialog.setAttribute("aria-label", title);
  return m;
}

async function renderTasks(root, query) {
  const tasks = await api.radarTasks();
  if (!root.isConnected) return;
  root.innerHTML = `<div class="radar-page">
    <header class="page-head">
      <div><h1>Задачи техкоманды</h1><p class="sub">Инсайты, переданные на рассмотрение и исправление.</p></div>
      <a class="btn" href="#/radar">${icon("back")}К инсайтам</a>
    </header>
    ${tasks.length ? `<section class="card radar-results" aria-label="Очередь техкоманды">
      <div class="radar-table-wrap">
        <table class="table radar-table radar-task-table">
          <thead><tr><th scope="col">Задача</th><th scope="col" class="num radar-task-count">Диалоги</th>
            <th scope="col">Статус</th><th scope="col" class="radar-task-date">Обновлено</th></tr></thead>
          <tbody>${tasks.map((task) => {
            const status = TASK_STATUS[task.status];
            return `<tr>
              <th scope="row"><a class="radar-task-link" href="${taskHref(task.id)}">№${esc(task.id)} · ${esc(task.title)}</a>
                <small>${esc(CATEGORIES[task.category] || CATEGORIES.other)}</small></th>
              <td class="num radar-task-count">${fmtNum(task.affected_count, 0)}</td>
              <td><span class="badge ${status.badge}">${status.label}</span></td>
              <td class="radar-task-date">${esc(fmtDate(task.updated_at))}</td></tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    </section>` : empty("Очередь пока пуста", "Откройте «Собрать инсайт» в отчёте и передайте его техкоманде.")}
  </div>`;
  if (!/^\d+$/.test(query.task || "")) return;
  try {
    const task = await api.radarTask(Number(query.task));
    if (!root.isConnected) return;
    const dialog = openTask(task);
    return () => dialog.close();
  } catch (error) {
    if (root.isConnected) toast(error.message, true);
  }
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
  if (!run) return empty("Для этого набора ещё нет отчёта", "Нажмите «Запустить анализ», чтобы найти повторяющиеся жалобы клиентов.");
  if (run.status === "running") {
    const processed = run.done + run.failed;
    return `<section class="card card-pad radar-progress" aria-label="Ход анализа">
      <div class="radar-progress-heading"><h2>Анализ выполняется</h2>
        <span>Обработано ${fmtNum(processed, 0)} из ${fmtNum(run.total, 0)}</span></div>
      <progress aria-label="Обработано диалогов" value="${processed}" max="${run.total}"></progress>
      <p class="muted small">Найденные жалобы будут сгруппированы после обработки диалогов.</p>
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
  const complaintShare = run.done > 0 ? `${fmtNum(result.dialogs_with_signals * 100 / run.done, 1)}% от проанализированных` : "";
  return `
    <section class="radar-metrics" aria-label="Сводка по набору">
      ${metric("done", "Диалогов проанализировано", fmtNum(run.done, 0), `из ${fmtNum(run.total, 0)} в наборе`)}
      ${metric("chat", "Диалогов с жалобами", fmtNum(result.dialogs_with_signals, 0), complaintShare)}
      ${metric("score", "Повторяющихся тем", fmtNum(result.groups.length, 0), "от 2 диалогов на тему")}
    </section>
    ${warningsHtml(run)}
    ${result.groups.length ? problemsHtml(result.groups, run.done)
      : empty("Повторяющиеся жалобы не найдены", "Для группы нужны подтверждающие реплики из двух или более диалогов.")}
    <p class="radar-run-meta muted small">
      Отчёт №${esc(run.id)} · ${esc(fmtDate(run.finished_at || run.created_at))} · ${esc(run.model)}
    </p>`;
}

export async function render(root, params, query = {}) {
  if (query.tab === "tasks") return renderTasks(root, query);
  const groups = await api.groups();
  const group = groups.find((entry) => entry.id === query.group)
    || groups.find((entry) => entry.id === "DEV") || groups[0];
  let runs = group ? await api.radarRuns(group.id) : [];
  const selected = runs.find((entry) => String(entry.id) === query.run) || runs[0];
  let run = selected ? await api.radarRun(selected.id) : null;
  if (!root.isConnected) return;

  root.innerHTML = `<div class="radar-page">
    <div class="page-head">
      <div><h1>Сервис инсайтов</h1>
        <div class="sub">Какие жалобы повторяются и сколько диалогов затронуто.</div></div>
      <div class="radar-actions">
        <div class="field"><label for="radar-group">Набор диалогов</label>
          <select class="input" id="radar-group" ${group ? "" : "disabled"}>
            ${groups.map((entry) => `<option value="${esc(entry.id)}" ${entry === group ? "selected" : ""}>${esc(entry.id)} · ${fmtNum(entry.count, 0)}</option>`).join("") || '<option>Нет наборов</option>'}
          </select>
        </div>
        <div class="field radar-history" id="radar-history" hidden><label for="radar-run-select">Отчёт</label>
          <select class="input" id="radar-run-select"></select>
        </div>
        <button class="btn" id="radar-refresh" type="button" title="Загрузить актуальное состояние отчёта" ${group ? "" : "disabled"}>${icon("refresh")}Обновить</button>
        <button class="btn btn-primary" id="radar-run" type="button"></button>
      </div>
    </div>
    <section class="radar-guide" aria-labelledby="radar-guide-heading">
      <h2 id="radar-guide-heading">Как пользоваться</h2>
      <ol>
        <li>Выберите набор.</li>
        <li>Откройте отчёт или запустите анализ.</li>
        <li>Проверьте цитаты и передайте инсайт.</li>
      </ol>
      <a class="btn btn-sm radar-queue-link" href="${TASKS_HREF}">${icon("list")}Задачи техкоманды</a>
    </section>
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
  let dialog;
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
    runButton.innerHTML = running ? "Анализ выполняется" : `${icon("play")}Запустить анализ`;
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
      showFeedback("Не удалось обновить ход анализа. Повторим запрос через несколько секунд.");
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
  results.addEventListener("click", (event) => {
    const button = event.target.closest("[data-radar-draft], [data-radar-sources]");
    if (!button) return;
    const { radarDraft, radarSources } = button.dataset;
    const problem = run?.result?.groups[Number(radarDraft ?? radarSources)];
    if (!problem) return;
    dialog?.close();
    dialog = radarDraft === undefined ? openSources(problem) : openInsight(problem, run);
  });
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
  return () => {
    clearTimeout(timer);
    dialog?.close();
  };
}
