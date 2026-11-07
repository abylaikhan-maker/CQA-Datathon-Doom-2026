import { api } from "../api.js";
import { esc, $, fmtNum, scoreClass, toast, busy, modal, LANG, CHANNEL } from "../util.js";

const state = { group: localStorage.getItem("cqa.group") || "", lang: "", channel: "", q: "", status: "" };

export async function render(root) {
  const [groups, checklists] = await Promise.all([api.groups(), api.checklists()]);
  if (state.group && !groups.some((g) => g.id === state.group)) state.group = "";
  const active = checklists.find((c) => c.is_active) || checklists[0];

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Диалоги</h1><div class="sub">Загрузите набор, выберите чек-лист и запустите оценку оператора.</div></div>
      <div class="spacer"></div>
      <button class="btn" id="btn-upload">Загрузить JSON</button>
      <button class="btn btn-primary" id="btn-import">Импорт из API</button>
    </div>
    <div class="card">
      <div class="toolbar">
        <label class="field">Набор
          <select class="input" id="f-group">
            <option value="">Все наборы</option>
            ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === state.group ? "selected" : ""}>${esc(g.id)} (${g.count})</option>`).join("")}
          </select></label>
        <label class="field">Язык
          <select class="input" id="f-lang"><option value="">Все</option>
            ${["RU", "KZ", "EN"].map((l) => `<option ${l === state.lang ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field">Канал
          <select class="input" id="f-channel"><option value="">Все</option>
            <option value="agent chat" ${state.channel === "agent chat" ? "selected" : ""}>Чат</option>
            <option value="voice call" ${state.channel === "voice call" ? "selected" : ""}>Звонок</option></select></label>
        <label class="field">Статус
          <select class="input" id="f-status"><option value="">Все</option>
            <option value="none" ${state.status === "none" ? "selected" : ""}>Не оценён</option>
            <option value="done" ${state.status === "done" ? "selected" : ""}>Оценён</option>
            <option value="critical" ${state.status === "critical" ? "selected" : ""}>Грубая ошибка</option>
            <option value="appeal" ${state.status === "appeal" ? "selected" : ""}>Есть апелляция</option>
            <option value="error" ${state.status === "error" ? "selected" : ""}>Ошибка</option></select></label>
        <label class="field grow">Поиск по ID
          <input class="input" id="f-q" placeholder="p1-ru-001" value="${esc(state.q)}"></label>
        <label class="field" style="min-width:240px">Чек-лист для оценки
          <select class="input" id="f-checklist">
            ${checklists.map((c) => `<option value="${c.id}" ${c.id === active?.id ? "selected" : ""}>${esc(c.name)} · v${c.version}${c.is_active ? " (активный)" : ""}</option>`).join("")}
          </select></label>
        <button class="btn btn-primary" id="btn-batch" title="Оценить диалоги набора, у которых нет оценки по выбранному чек-листу">Оценить новые</button>
        <button class="btn" id="btn-rebatch" title="Переоценить все диалоги набора выбранным чек-листом">Переоценить все</button>
      </div>
      <div class="batch-box hidden" id="batch-box"></div>
      <div class="table-wrap" id="table"></div>
    </div>`;

  let rows = [];
  const checklistId = () => Number($("#f-checklist", root).value);

  async function load() {
    rows = await api.conversations({ group: state.group || null, checklist_id: checklistId() });
    draw();
  }

  function draw() {
    const q = state.q.trim().toLowerCase();
    const list = rows.filter((r) =>
      (!state.lang || r.language === state.lang) &&
      (!state.channel || r.channel === state.channel) &&
      (!q || r.id.toLowerCase().includes(q)) &&
      (!state.status ||
        (state.status === "none" && !r.eval_id) ||
        (state.status === "done" && r.status === "done") ||
        (state.status === "critical" && r.final_critical === "true") ||
        (state.status === "appeal" && Number(r.appeals) > 0) ||
        (state.status === "error" && r.status === "error")));
    const t = $("#table", root);
    if (!rows.length) {
      t.innerHTML = `<div class="empty">Диалогов пока нет. Нажмите «Импорт из API» (group_id = DEV) или загрузите JSON.</div>`;
      return;
    }
    const evaluated = rows.filter((r) => r.status === "done");
    const avg = evaluated.length ? evaluated.reduce((s, r) => s + Number(r.final_total || 0), 0) / evaluated.length : null;
    t.innerHTML = `
      <table class="table">
        <thead><tr>
          <th>ID диалога</th><th>Канал</th><th>Язык</th><th class="num">Реплик</th>
          <th class="num">Итог</th><th>Грубая ошибка</th><th>Статус</th><th>Апелляции</th>
        </tr></thead>
        <tbody>
          ${list.map((r) => `
            <tr class="click" data-id="${esc(r.id)}">
              <td class="mono"><a href="#/conversation/${encodeURIComponent(r.id)}">${esc(r.id)}</a></td>
              <td>${r.channel === "voice call" ? "🎧 " : "💬 "}${esc(CHANNEL[r.channel] || r.channel || "—")}</td>
              <td title="${esc(LANG[r.language] || "")}">${esc(r.language || "—")}</td>
              <td class="num">${r.messages}</td>
              <td class="num">${scoreCell(r)}</td>
              <td>${r.status === "done" ? (r.final_critical === "true" ? `<span class="badge crit">Выявлена</span>` : `<span class="muted small">нет</span>`) : ""}</td>
              <td>${statusBadge(r)}</td>
              <td>${Number(r.open_appeals) ? `<span class="badge warn">открыта: ${r.open_appeals}</span>` : Number(r.appeals) ? `<span class="badge brand">рассмотрено: ${r.appeals}</span>` : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <div class="eval-meta">Показано ${list.length} из ${rows.length} · оценено ${evaluated.length} · средний итог ${fmtNum(avg)}</div>`;
  }

  $("#table", root).addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && !e.target.closest("a")) location.hash = `#/conversation/${encodeURIComponent(tr.dataset.id)}`;
  });
  const bind = (id, key, reload = false) =>
    $(id, root).addEventListener(id === "#f-q" ? "input" : "change", (e) => {
      state[key] = e.target.value;
      if (key === "group") localStorage.setItem("cqa.group", state.group);
      reload ? load() : draw();
    });
  bind("#f-group", "group", true);
  bind("#f-lang", "lang");
  bind("#f-channel", "channel");
  bind("#f-status", "status");
  bind("#f-q", "q");
  $("#f-checklist", root).addEventListener("change", load);

  $("#btn-import", root).addEventListener("click", () => importDialog(onImported));
  $("#btn-upload", root).addEventListener("click", () => uploadDialog(onImported));
  function onImported(res) {
    toast(`Импортировано ${res.imported} диалогов в набор ${res.group}`);
    state.group = res.group;
    localStorage.setItem("cqa.group", res.group);
    render(root);
  }

  let poll = null;
  async function startBatch(onlyMissing, btn) {
    const scope = state.group ? `набора ${state.group}` : "всех наборов";
    if (!onlyMissing && !confirm(`Переоценить все диалоги ${scope} выбранным чек-листом? Предыдущие оценки сохранятся в истории.`)) return;
    busy(btn, true, "Запуск…");
    try {
      const b = await api.batch({ group: state.group || null, checklist_id: checklistId(), only_missing: onlyMissing });
      if (!b.total) { toast("Нет диалогов для оценки — все уже оценены этим чек-листом"); return; }
      toast(`Запущена оценка ${b.total} диалогов`);
      trackBatch(b.id);
    } catch (e) { toast(e.message, true); } finally { busy(btn, false); }
  }
  function trackBatch(id) {
    clearInterval(poll);
    const box = $("#batch-box", root);
    box.classList.remove("hidden");
    const tick = async () => {
      let b;
      try { b = await api.batchStatus(id); } catch { return; }
      const pct = b.total ? Math.round(((b.done + b.failed) / b.total) * 100) : 100;
      box.innerHTML = `
        ${b.status === "running" ? '<span class="spinner"></span>' : "✓"}
        <b>Пакет #${b.id}</b> <span>${b.done + b.failed} / ${b.total}</span>
        <div class="progress"><i style="width:${pct}%"></i></div>
        ${b.failed ? `<span class="badge no">ошибок: ${b.failed}</span>` : ""}
        <span class="muted">стоимость ≈ $${fmtNum(b.cost_usd, 4)}</span>`;
      if (b.status !== "running") {
        clearInterval(poll);
        localStorage.removeItem("cqa.batch");
        toast(`Пакет #${b.id} завершён: ${b.done} оценено${b.failed ? `, ${b.failed} с ошибкой` : ""}`);
      }
      await load();
    };
    localStorage.setItem("cqa.batch", id);
    tick();
    poll = setInterval(tick, 2500);
  }
  $("#btn-batch", root).addEventListener("click", (e) => startBatch(true, e.currentTarget));
  $("#btn-rebatch", root).addEventListener("click", (e) => startBatch(false, e.currentTarget));

  await load();
  const running = localStorage.getItem("cqa.batch");
  if (running) trackBatch(Number(running));
  return () => clearInterval(poll);
}

function scoreCell(r) {
  if (r.status !== "done") return "";
  const fin = r.final_total, orig = r.total;
  const changed = fin !== null && orig !== null && Number(fin) !== Number(orig);
  return `${changed ? `<span class="strike">${fmtNum(orig)}</span>` : ""}<span class="score-pill ${scoreClass(fin)}">${fmtNum(fin)}</span>`;
}

function statusBadge(r) {
  if (!r.eval_id) return `<span class="badge">не оценён</span>`;
  if (r.status === "done") return `<span class="badge yes">оценён</span>`;
  if (r.status === "error") return `<span class="badge no" title="${esc(r.error || "")}">ошибка</span>`;
  return `<span class="badge warn"><span class="spinner" style="width:10px;height:10px"></span> ${r.status === "running" ? "оценка" : "в очереди"}</span>`;
}

export function importDialog(done) {
  modal({
    title: "Импорт набора из API организаторов",
    submitText: "Импортировать",
    body: `
      <label class="field">group_id
        <input class="input" id="imp-group" value="DEV" placeholder="DEV"></label>
      <label class="field">Адрес API (необязательно — по умолчанию из настроек сервера)
        <input class="input" id="imp-url" placeholder="https://…?group_id={group_id}"></label>
      <div class="muted small">Запрос выполняется через сервер (без CORS). Повторный импорт обновляет диалоги, оценки сохраняются.</div>`,
    onSubmit: async (el) => {
      const g = $("#imp-group", el).value.trim();
      if (!g) throw new Error("Укажите group_id");
      done(await api.importGroup(g, $("#imp-url", el).value.trim()));
    },
  });
}

export function uploadDialog(done) {
  modal({
    title: "Загрузить транскрипт(ы)",
    submitText: "Загрузить",
    body: `
      <label class="field">JSON-файл
        <input type="file" class="input" id="up-file" accept=".json,application/json"></label>
      <label class="field">…или вставьте JSON
        <textarea class="input mono" id="up-text" rows="8" placeholder='{"conversation_id":"demo-1","channel":"agent chat","language":"RU","transcript":[{"timestamp":"00:02","speaker":"operator","text":"Здравствуйте!"}]}'></textarea></label>
      <label class="field">Набор (group)
        <input class="input" id="up-group" placeholder="UPLOAD"></label>
      <div class="muted small">Принимается полный ответ API, объект <code>data</code>, массив записей или одна запись.</div>`,
    onSubmit: async (el) => {
      const f = $("#up-file", el).files[0];
      const text = f ? await f.text() : $("#up-text", el).value.trim();
      if (!text) throw new Error("Выберите файл или вставьте JSON");
      done(await api.upload(text, $("#up-group", el).value.trim() || null));
    },
  });
}
