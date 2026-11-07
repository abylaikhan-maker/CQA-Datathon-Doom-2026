// Регламенты: company regulation files and a check of a whole dataset against them.
import { api } from "../api.js";
import { esc, $, toast, busy, icon, fmtDate, fmtNum, plural, confirmDialog } from "../util.js";
import { clauseBody } from "../card/regulation.js";

const POLL_MS = 2500;
const ACCEPT = ".pdf,.docx,.txt,.md,.markdown";

export async function render(root) {
  const [docs, groups] = await Promise.all([api.regulations(), api.groups()]);
  if (!root.isConnected) return undefined;
  let timer = null;
  const state = { docs, group: (groups.find((g) => g.id === "DEV") || groups[0])?.id || "", run: null };

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Регламенты</h1>
        <p class="sub">Документы компании, с которыми сверяются обещания операторов: сроки, суммы, условия, запреты.
          Сверка показывается в карточке разговора рядом с репликой и не меняет баллы по чек-листу.</p>
      </div>
    </div>
    <div class="reg-grid">
      <section class="card reg-docs" aria-labelledby="reg-docs-h">
        <div class="card-head"><h2 id="reg-docs-h">Документы</h2></div>
        <label class="dropzone reg-drop" id="reg-drop">
          <input type="file" id="reg-file" accept="${ACCEPT}" multiple>
          ${icon("upload")}
          <span><b>Выберите файл</b> или перетащите сюда</span>
          <span class="reg-drop-hint">PDF, DOCX, TXT или Markdown, до 10 МБ. Пункты «2.1», «п. 3.4» распознаются автоматически.</span>
        </label>
        <div id="reg-list" class="reg-list"></div>
      </section>
      <section class="card reg-run" aria-labelledby="reg-run-h">
        <div class="card-head"><h2 id="reg-run-h">Сверка набора</h2></div>
        <div class="card-pad reg-run-body">
          <p class="reg-run-text">Сверяет каждый разговор набора со всеми загруженными регламентами. Результат появится в карточках разговоров.</p>
          <div class="reg-run-ctl">
            <label class="reg-sr" for="reg-group">Набор</label>
            <select class="input" id="reg-group">
              ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === state.group ? "selected" : ""}>${esc(g.id)} · ${fmtNum(g.count, 0)}</option>`).join("") || "<option>Нет наборов</option>"}
            </select>
            <button class="btn btn-primary" id="reg-start" type="button">${icon("doc")}Сверить набор</button>
          </div>
          <div id="reg-run-status" aria-live="polite"></div>
        </div>
      </section>
    </div>`;

  const list = $("#reg-list", root);
  const drawList = () => {
    list.innerHTML = state.docs.length ? state.docs.map(docHtml).join("") : `
      <div class="reg-empty">Пока нет ни одного регламента. Загрузите документ — например, регламент сроков ответа и вывода средств.</div>`;
    $("#reg-start", root).disabled = !state.docs.length || !state.group;
  };
  const reload = async () => { state.docs = await api.regulations(); if (root.isConnected) drawList(); };

  const upload = async (files) => {
    for (const file of files) {
      try {
        const doc = await api.uploadRegulation(file);
        toast(`Загружено: «${doc.title}», ${doc.clause_count} ${plural(doc.clause_count, ["пункт", "пункта", "пунктов"])}`);
      } catch (err) {
        toast(`${file.name}: ${err.message}`, true);
      }
    }
    await reload();
  };

  const drop = $("#reg-drop", root);
  $("#reg-file", root).addEventListener("change", (e) => { upload([...e.target.files]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); upload([...e.dataTransfer.files]); });

  list.addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open]");
    if (open) {
      const box = $(`#reg-cl-${open.dataset.open}`, root);
      if (!box.hidden) { box.hidden = true; open.setAttribute("aria-expanded", "false"); return; }
      busy(open, true, "Пункты");
      try {
        const doc = await api.regulation(open.dataset.open);
        box.innerHTML = clausesHtml(doc.clauses);
        box.hidden = false;
        open.setAttribute("aria-expanded", "true");
      } catch (err) { toast(err.message, true); } finally { busy(open, false); }
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const doc = state.docs.find((d) => String(d.id) === del.dataset.del);
      const ok = await confirmDialog({
        title: "Удалить регламент?",
        body: `«${esc(doc?.title || "")}» больше не будет участвовать в сверке. Уже сделанные сверки останутся, но будут помечены как устаревшие.`,
        okText: "Удалить", danger: true,
      });
      if (!ok) return;
      try { await api.deleteRegulation(del.dataset.del); toast("Регламент удалён"); await reload(); } catch (err) { toast(err.message, true); }
    }
  });

  // Dataset run with progress.
  const status = $("#reg-run-status", root);
  const drawRun = () => { status.innerHTML = runHtml(state.run); $("#reg-start", root).disabled = !state.docs.length || !state.group || state.run?.status === "running"; };
  const poll = async () => {
    clearTimeout(timer);
    if (!state.run || state.run.status !== "running") return;
    try {
      state.run = await api.regulationRun(state.run.id);
    } catch { /* try again on the next tick */ }
    if (!root.isConnected) return;
    drawRun();
    if (state.run.status === "running") timer = setTimeout(poll, POLL_MS);
  };
  const loadRun = async () => {
    clearTimeout(timer);
    state.run = null;
    if (state.group) {
      const runs = await api.regulationRuns(state.group);
      state.run = runs[0] ? await api.regulationRun(runs[0].id) : null;
    }
    if (!root.isConnected) return;
    drawRun();
    if (state.run?.status === "running") timer = setTimeout(poll, POLL_MS);
  };
  $("#reg-group", root).addEventListener("change", (e) => { state.group = e.target.value; loadRun(); });
  $("#reg-start", root).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, "Запуск…");
    try {
      state.run = await api.startRegulationRun(state.group);
      drawRun();
      timer = setTimeout(poll, POLL_MS);
    } catch (err) { toast(err.message, true); } finally { busy(btn, false); drawRun(); }
  });

  drawList();
  await loadRun();
  return () => clearTimeout(timer);
}

function docHtml(d) {
  const size = d.size_bytes >= 1024 * 1024 ? `${fmtNum(d.size_bytes / 1024 / 1024, 1)} МБ` : `${fmtNum(Math.max(1, d.size_bytes / 1024), 0)} КБ`;
  return `
    <article class="reg-doc">
      <div class="reg-doc-row">
        <span class="reg-doc-ic">${icon("doc")}</span>
        <div class="reg-doc-main">
          <b>${esc(d.title)}</b>
          <span class="reg-doc-meta">${esc(d.filename)} · ${size} · ${d.clause_count} ${plural(d.clause_count, ["пункт", "пункта", "пунктов"])} · ${esc(fmtDate(d.created_at))}${d.author ? ` · ${esc(d.author)}` : ""}</span>
        </div>
        <div class="reg-doc-actions">
          <button class="btn btn-sm" type="button" data-open="${d.id}" aria-expanded="false">${icon("list")}Пункты</button>
          <button class="btn btn-sm btn-ghost btn-danger btn-icon" type="button" data-del="${d.id}" aria-label="Удалить «${esc(d.title)}»">${icon("trash")}</button>
        </div>
      </div>
      <div class="reg-clauses" id="reg-cl-${d.id}" hidden></div>
    </article>`;
}

function clausesHtml(clauses) {
  let section = null;
  return `<ol class="reg-clause-list">${clauses.map((c) => {
    const head = c.section && c.section !== section ? `<li class="reg-sec">${esc(c.section)}</li>` : "";
    section = c.section;
    return `${head}<li class="reg-clause"><span class="reg-ref">${esc(c.ref)}</span><p>${esc(clauseBody(c))}</p></li>`;
  }).join("")}</ol>`;
}

function runHtml(run) {
  if (!run) return `<div class="reg-empty">Этот набор ещё не сверяли.</div>`;
  if (run.status === "running") {
    const done = run.done + run.failed;
    return `<div class="reg-progress"><progress value="${done}" max="${run.total}"></progress>
      <span>Сверено ${done} из ${run.total}${run.failed ? `, с ошибкой ${run.failed}` : ""}</span></div>`;
  }
  if (run.status === "error") return `<div class="cv-note cv-note-warn">${esc(run.error || "Сверка не завершилась.")}</div>`;
  const r = run.result || { conversations: [], totals: {}, failed_ids: [] };
  const withConflicts = r.conversations.filter((c) => c.conflicts > 0);
  const t = r.totals || {};
  return `
    <div class="reg-totals">
      <span class="cv-reg-count is-conflict">${icon("alert")}Расходится: <b>${t.conflicts || 0}</b></span>
      <span class="cv-reg-count is-none">${icon("doc")}Нет в регламенте: <b>${t.not_covered || 0}</b></span>
      <span class="cv-reg-count is-match">${icon("check")}Соответствует: <b>${t.matches || 0}</b></span>
    </div>
    <p class="reg-run-meta">Прогон №${run.id} · ${esc(fmtDate(run.finished_at || run.created_at))} · сверено ${r.conversations.length} из ${run.total}${r.failed_ids?.length ? `, не удалось ${r.failed_ids.length}` : ""}</p>
    ${withConflicts.length ? `<h3 class="reg-h3">Разговоры с расхождениями</h3>
      <ul class="reg-conv-list">${withConflicts.map((c) => `
        <li><a href="#/conversation/${encodeURIComponent(c.conversation_id)}">${esc(c.conversation_id)}</a>
          <span class="cv-reg-count is-conflict">${c.conflicts} ${plural(c.conflicts, ["расхождение", "расхождения", "расхождений"])}</span></li>`).join("")}
      </ul>` : `<div class="reg-empty">Расхождений с регламентами не найдено.</div>`}`;
}
