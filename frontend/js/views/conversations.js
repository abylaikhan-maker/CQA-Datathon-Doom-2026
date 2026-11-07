import { api } from "../api.js";
import {
  esc, $, fmtNum, scoreClass, toast, busy, modal, LANG, CHANNEL,
  plural, debounce, icon, pct, confirmDialog,
} from "../util.js";

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Survives navigation to a card and back.
const state = {
  group: store.get("cqa.group") || "", checklistId: null,
  lang: "", channel: "", status: "", q: "",
  sort: { key: "id", dir: 1 },
};
let activePoll = null;
const seen = (k) => store.get(`cqa.seen.${k}`) === "1";

const LANG_ORDER = ["RU", "KZ", "EN"];
const STATUS = [
  { v: "", label: "Все" },
  { v: "none", label: "Не оценены", test: (r) => !r.eval_id },
  { v: "done", label: "Оценены", test: (r) => r.status === "done" },
  { v: "critical", label: "Грубые ошибки", test: (r) => r.status === "done" && r.final_critical === "true", cls: "crit-chip" },
  { v: "appeal", label: "С апелляцией", test: (r) => Number(r.appeals) > 0 },
  { v: "error", label: "Ошибки оценки", test: (r) => r.status === "error" },
];
const isNew = (r) => !r.eval_id || r.status === "error";
const chanIcon = (c) => icon(c === "voice call" ? "phone" : "chat");
const chanLabel = (c) => CHANNEL[c] || c || "—";

export async function render(root) {
  clearInterval(activePoll);
  const [groups, checklists] = await Promise.all([api.groups(), api.checklists()]);
  if (state.group && !groups.some((g) => g.id === state.group)) state.group = "";
  if (!checklists.some((c) => c.id === state.checklistId)) {
    state.checklistId = (checklists.find((c) => c.is_active) || checklists[0])?.id ?? null;
  }
  const clName = (id) => {
    const c = checklists.find((x) => x.id === id);
    return c ? `${c.name} · v${c.version}` : `#${id}`;
  };

  const hasAny = groups.some((g) => Number(g.count) > 0);
  root.innerHTML = `<div class="conv-page">
    <div class="page-head">
      <div><h1>Диалоги</h1>
        <div class="sub">Загрузите диалоги, выберите версию чек-листа и запустите оценку. Нажмите на строку, чтобы открыть разбор с объяснениями.</div></div>
      <div class="spacer"></div>
      <div class="page-actions">
        <button class="btn btn-ghost" type="button" id="btn-guide" hidden>${icon("info")}С чего начать</button>
        <button class="btn" type="button" id="btn-upload">${icon("upload")}Загрузить JSON</button>
        <button class="btn ${hasAny ? "" : "btn-primary"}" type="button" id="btn-import">${icon("cloud")}Импорт из API</button>
      </div>
    </div>
    <div id="guide"></div>
    <div id="batch"></div>
    <div class="kpis" id="kpis"></div>
    <section class="card conv-card" aria-label="Список диалогов">
      <div class="conv-tools">
        <button class="btn filters-toggle" type="button" id="btn-filters" aria-expanded="false" aria-controls="filters">${icon("filter")}Фильтры<span class="n" id="filters-n" hidden></span></button>
        <label class="field f-group">Набор
          <select class="input" id="f-group">
            <option value="">Все наборы</option>
            ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === state.group ? "selected" : ""}>${esc(g.id)} (${g.count})</option>`).join("")}
          </select></label>
        <label class="field f-search">Поиск по ID
          <span class="input-icon">${icon("search")}<input class="input" type="search" id="f-q" placeholder="например, p1-ru-001" value="${esc(state.q)}" autocomplete="off"></span></label>
        <label class="field f-cl">Чек-лист для оценки
          <select class="input" id="f-checklist">
            ${checklists.map((c) => `<option value="${c.id}" ${c.id === state.checklistId ? "selected" : ""}>${esc(c.name)} · v${c.version}${c.is_active ? " (активный)" : ""}</option>`).join("")}
          </select></label>
        <div class="actions">
          <button class="btn btn-primary" type="button" id="btn-batch" title="Оценить диалоги без оценки выбранным чек-листом">${icon("play")}Оценить новые<span class="n" id="batch-n" hidden></span></button>
          <button class="btn" type="button" id="btn-rebatch" title="Заново оценить все диалоги выбранным чек-листом">${icon("refresh")}Переоценить все</button>
        </div>
      </div>
      <div class="conv-filters" id="filters" role="group" aria-label="Фильтры"></div>
      <div class="table-wrap" id="table"></div>
      <div class="table-foot" id="foot"></div>
    </section></div>`;
  const page = root.firstElementChild;

  let rows = [];
  const filtersActive = () => !!(state.lang || state.channel || state.status || state.q.trim());

  async function load() {
    rows = await api.conversations({ group: state.group || null, checklist_id: state.checklistId });
    draw();
  }

  function filtered(skip) {
    const q = state.q.trim().toLowerCase();
    const st = STATUS.find((s) => s.v === state.status);
    return rows.filter((r) =>
      (skip === "lang" || !state.lang || r.language === state.lang) &&
      (skip === "channel" || !state.channel || r.channel === state.channel) &&
      (skip === "status" || !st?.test || st.test(r)) &&
      (!q || r.id.toLowerCase().includes(q)));
  }

  function sorted(list) {
    const { key, dir } = state.sort;
    const val = (r) => key === "score" ? (r.status === "done" ? Number(r.final_total) : null)
      : key === "messages" ? Number(r.messages) : r.id;
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === null && y === null) return a.id.localeCompare(b.id);
      if (x === null) return 1; // not evaluated always last
      if (y === null) return -1;
      const c = typeof x === "string" ? x.localeCompare(y, "ru", { numeric: true }) : x - y;
      return c * dir || a.id.localeCompare(b.id);
    });
  }

  function draw() {
    const list = sorted(filtered());
    drawGuide();
    drawKpis(list);
    drawFilters();
    drawTable(list);
    const nNew = (filtersActive() ? filtered() : rows).filter(isNew).length;
    const bn = $("#batch-n", root);
    bn.hidden = !nNew;
    bn.textContent = nNew;
    $("#btn-batch", root).title = nNew ? `Оценить ${nNew} ${plural(nNew, ["диалог", "диалога", "диалогов"])} без оценки выбранным чек-листом` : "Все диалоги уже оценены этим чек-листом";
    const nf = [state.group, state.lang, state.channel, state.status].filter(Boolean).length;
    const nEl = $("#filters-n", root);
    nEl.hidden = !nf;
    nEl.textContent = nf;
    const foot = $("#foot", root);
    foot.innerHTML = rows.length ? `
      <span>Показано <b>${list.length}</b> из ${rows.length}</span>
      <span>Чек-лист: ${esc(clName(state.checklistId))}</span>
      ${filtersActive() ? `<button class="btn-link" type="button" data-reset>Сбросить фильтры</button>` : ""}` : "";
    foot.hidden = !rows.length;
  }

  // ---- «С чего начать»: the demo path with live state, until most dialogs are evaluated.
  let sampleCrit = { id: null, crit: undefined }; // first criterion that lost points in the example dialog
  function guideSteps() {
    const total = groups.reduce((s, g) => s + Number(g.count || 0), 0) || rows.length;
    const done = rows.filter((r) => r.status === "done");
    // Example dialog: the lowest evaluated score has the most deductions to explain.
    const sample = [...done].sort((a, b) => Number(a.final_total) - Number(b.final_total) || a.id.localeCompare(b.id))
      .find((r) => Number(r.final_total) > 0) || done[0];
    const appeals = rows.reduce((s, r) => s + Number(r.appeals || 0), 0);
    const decided = rows.reduce((s, r) => s + Math.max(0, Number(r.appeals || 0) - Number(r.open_appeals || 0)), 0);
    const open = rows.reduce((s, r) => s + Number(r.open_appeals || 0), 0);
    const nNew = rows.filter(isNew).length;
    const card = sample ? cardHref(sample) : null;
    if (sample && sampleCrit.id !== sample.eval_id) loadSampleCrit(sample);
    const critHref = card && sampleCrit.id === sample?.eval_id && sampleCrit.crit
      ? `${card}${card.includes("?") ? "&" : "?"}crit=${encodeURIComponent(sampleCrit.crit)}` : card;
    const steps = [
      { ok: total > 0, t: "Загрузите диалоги", d: "Из API организаторов или файлом JSON", act: { btn: "import", label: "Импорт из API" } },
      { ok: done.length > 0, t: "Запустите оценку", d: "Модель проверит каждый диалог по чек-листу", act: { btn: "eval", label: nNew ? `Оценить новые (${nNew})` : "Оценить новые" }, need: total > 0 },
      { ok: seen("card"), t: "Откройте разбор", d: "Баллы, объяснения и реплики-доказательства", act: { href: card, label: "Открыть разбор" } },
      { ok: appeals > 0, t: "Оспорьте оценку", d: "«Оспорить оценку» у критерия в разборе", act: { href: critHref, label: "К критериям" } },
      { ok: decided > 0, t: "Примите решение", d: "Проверяющий подтверждает или меняет ответ", act: { href: "#/appeals", label: open ? `Открытых: ${open}` : "К апелляциям" } },
      { ok: seen("accuracy"), t: "Сверьте с эталоном", d: "Насколько ответы модели совпадают с разметкой", act: { href: "#/accuracy", label: "Точность" } },
    ];
    // An appeal or a decision is only possible from the dialog review, so it counts as opened.
    if (steps[3].ok || steps[4].ok) steps[2].ok = true;
    return steps;
  }

  async function loadSampleCrit(sample) {
    sampleCrit = { id: sample.eval_id, crit: undefined };
    try {
      const ev = await api.evaluation(sample.eval_id);
      const list = ev.final_score?.criteria || ev.score?.criteria || [];
      const lost = list.find((c) => c.points !== null && c.max_points !== null && Number(c.points) < Number(c.max_points));
      if (sampleCrit.id !== sample.eval_id) return;
      sampleCrit.crit = lost ? lost.criterion_id : null;
      if (root.isConnected && $(".guide", root)) drawGuide();
    } catch { /* keep the plain link */ }
  }

  const phone = () => window.matchMedia("(max-width: 760px)").matches;

  function drawGuide() {
    const box = $("#guide", root), reopen = $("#btn-guide", root);
    const steps = guideSteps();
    const nDone = steps.filter((s) => s.ok).length;
    const evaluated = rows.filter((r) => r.status === "done").length;
    const little = !rows.length || evaluated < rows.length * 0.5;
    const relevant = little || nDone < steps.length;
    const hidden = store.get("cqa.guide.hidden") === "1";
    reopen.hidden = !(hidden && relevant);
    if (hidden || !relevant) { box.innerHTML = ""; return; }
    const next = steps.findIndex((s) => !s.ok);
    // Collapsed to one line on phones, and once the core path (up to the decision) is done.
    const coreDone = evaluated > 0 && steps.slice(0, 5).every((s) => s.ok);
    let pref = null;
    try { pref = sessionStorage.getItem("cqa.guide.open"); } catch { /* ignore */ }
    const expanded = pref === "1" ? true : pref === "0" ? false : !(phone() || coreDone);
    const actionOf = (s, i, state) => {
      if (s.ok) return "";
      const cls = `btn btn-sm ${state === "next" ? "guide-cta" : "guide-btn"}`;
      const a = s.act;
      if (a.href === null || s.need === false) return `<button class="${cls}" type="button" disabled title="Сначала выполните предыдущие шаги">${esc(a.label)}</button>`;
      return a.btn ? `<button class="${cls}" type="button" data-guide="${a.btn}">${esc(a.label)}</button>`
        : `<a class="${cls}" href="${esc(a.href)}">${esc(a.label)}</a>`;
    };
    const closeBtn = `<button class="btn btn-sm guide-x" type="button" data-guide-hide aria-label="Скрыть подсказку «С чего начать»" title="Скрыть">${icon("x")}</button>`;
    if (!expanded) {
      const s = steps[next];
      box.innerHTML = `
        <section class="guide is-collapsed" aria-label="С чего начать">
          <button class="guide-bar" type="button" data-guide-toggle aria-expanded="false" aria-controls="guide">
            <span class="guide-mark" aria-hidden="true">${s ? next + 1 : icon("check")}</span>
            <span class="guide-bar-t">${s ? `<span class="guide-prog">Шаг ${next + 1} из ${steps.length}:</span> <b>${esc(s.t)}</b>` : "<b>Все шаги пройдены</b>"}</span>
            <span class="guide-bar-more">Все шаги${icon("down")}</span>
          </button>
          ${s ? `<span class="guide-bar-act">${actionOf(s, next, "next")}</span>` : ""}
          ${closeBtn}
        </section>`;
      return;
    }
    box.innerHTML = `
      <section class="guide" aria-labelledby="guide-h">
        <div class="guide-head">
          <h2 id="guide-h">С чего начать</h2>
          <span class="guide-prog">${nDone === steps.length ? "Все шаги пройдены" : `Пройдено ${nDone} из ${steps.length}`}</span>
          <button class="btn btn-sm guide-btn guide-fold" type="button" data-guide-toggle aria-expanded="true" aria-controls="guide">Свернуть${icon("up")}</button>
          ${closeBtn}
        </div>
        <ol class="guide-steps">
          ${steps.map((s, i) => {
            const state = s.ok ? "done" : i === next ? "next" : "todo";
            const action = actionOf(s, i, state);
            return `
            <li class="guide-step is-${state}" ${state === "next" ? 'aria-current="step"' : ""}>
              <span class="guide-mark" aria-hidden="true">${s.ok ? icon("check") : i + 1}</span>
              <span class="sr-only">${s.ok ? "Выполнено:" : state === "next" ? "Следующий шаг:" : ""}</span>
              <b class="guide-t">${esc(s.t)}</b>
              <span class="guide-d">${esc(s.d)}</span>
              ${action ? `<span class="guide-act">${action}</span>` : ""}
            </li>`;
          }).join("")}
        </ol>
      </section>`;
    // On phones the steps scroll sideways: bring the next one into view without moving the page.
    const ol = $(".guide-steps", box), cur = $(".is-next", box);
    if (ol && cur && ol.scrollWidth > ol.clientWidth) ol.scrollLeft = Math.max(0, cur.offsetLeft - ol.offsetLeft - 16);
  }

  function drawKpis(list) {
    const k = $("#kpis", root);
    if (!rows.length) { k.innerHTML = ""; k.hidden = true; return; }
    k.hidden = false;
    const done = list.filter((r) => r.status === "done");
    const avg = done.length ? done.reduce((s, r) => s + Number(r.final_total || 0), 0) / done.length : null;
    const crit = done.filter((r) => r.final_critical === "true").length;
    const open = list.reduce((s, r) => s + Number(r.open_appeals || 0), 0);
    const allAppeals = list.reduce((s, r) => s + Number(r.appeals || 0), 0);
    const calls = list.filter((r) => r.channel === "voice call").length;
    const evalPct = pct(done.length, list.length);
    const sc = scoreClass(avg);
    k.innerHTML = `
      <div class="card kpi">
        <div class="lbl">${icon("list")}Диалогов</div>
        <div class="v">${list.length}${list.length !== rows.length ? `<small> из ${rows.length}</small>` : ""}</div>
        <div class="foot meta-list"><span>чатов ${list.length - calls}</span><span>звонков ${calls}</span></div>
      </div>
      <div class="card kpi">
        <div class="lbl">${icon("done")}Оценено</div>
        <div class="v">${done.length}<small> / ${list.length}</small></div>
        <div class="meter" title="${fmtNum(evalPct, 0)}% диалогов оценено"><i style="width:${evalPct ?? 0}%"></i></div>
      </div>
      <div class="card kpi ${sc === "hi" ? "is-good" : sc === "mid" ? "is-warn" : sc === "lo" ? "is-bad" : ""}">
        <div class="lbl">${icon("score")}Средний итог</div>
        <div class="v">${fmtNum(avg)}<small> / 100</small></div>
        <div class="foot">${done.length ? `по ${done.length} ${plural(done.length, ["оценке", "оценкам", "оценкам"])}` : "нет оценок"}</div>
      </div>
      <button type="button" class="card kpi kpi-btn ${crit ? "is-bad" : ""}" data-kpi-status="critical" title="Показать диалоги с грубой ошибкой">
        <span class="lbl">${icon("alert")}Грубые ошибки</span>
        <span class="v">${crit}</span>
        <span class="foot">${done.length ? `${fmtNum(pct(crit, done.length), 0)}% оценённых` : "—"}</span>
      </button>
      <a class="card kpi ${open ? "is-warn" : ""}" href="#/appeals" title="Перейти к апелляциям">
        <span class="lbl">${icon("scale")}Открытые апелляции</span>
        <span class="v">${open}</span>
        <span class="foot">всего апелляций: ${allAppeals}</span>
      </a>`;
  }

  function chip(f, v, label, n, extra = "") {
    const on = state[f] === v;
    return `<button type="button" class="chip ${extra}" data-f="${f}" data-v="${esc(v)}" aria-pressed="${on}" ${!on && v && !n ? "disabled" : ""}>${label}${n !== undefined ? `<span class="n">${n}</span>` : ""}</button>`;
  }

  function drawFilters() {
    const f = $("#filters", root);
    if (!rows.length) { f.innerHTML = ""; f.hidden = true; return; }
    f.hidden = false;
    const byLang = filtered("lang"), byChan = filtered("channel"), byStatus = filtered("status");
    const langs = [...new Set(rows.map((r) => r.language).filter(Boolean))]
      .sort((a, b) => (LANG_ORDER.indexOf(a) + 1 || 99) - (LANG_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    const chans = [...new Set(rows.map((r) => r.channel).filter(Boolean))];
    const count = (list, fn) => list.filter(fn).length;
    f.innerHTML = `
      <div class="chips" role="group" aria-label="Язык"><span class="chips-label">Язык</span>
        ${chip("lang", "", "Все")}
        ${langs.map((l) => chip("lang", l, `<span title="${esc(LANG[l] || l)}">${esc(l)}</span>`, count(byLang, (r) => r.language === l))).join("")}
      </div>
      <div class="chips" role="group" aria-label="Канал"><span class="chips-label">Канал</span>
        ${chip("channel", "", "Все")}
        ${chans.map((c) => chip("channel", c, `${chanIcon(c)}${esc(chanLabel(c))}`, count(byChan, (r) => r.channel === c))).join("")}
      </div>
      <div class="chips" role="group" aria-label="Статус"><span class="chips-label">Статус</span>
        ${STATUS.map((s) => chip("status", s.v, s.label, s.test ? count(byStatus, s.test) : undefined, s.cls || "")).join("")}
      </div>`;
  }

  function th(key, label, cls = "") {
    const on = state.sort.key === key;
    const aria = on ? (state.sort.dir > 0 ? "ascending" : "descending") : "none";
    return `<th class="${cls}" aria-sort="${aria}"><button type="button" class="th-sort" data-sort="${key}" ${on ? `data-dir="${state.sort.dir}"` : ""}>${label}<span class="arr" aria-hidden="true">${icon(on ? (state.sort.dir > 0 ? "up" : "down") : "sort")}</span></button></th>`;
  }

  function drawTable(list) {
    const t = $("#table", root);
    if (!rows.length) {
      t.innerHTML = `
        <div class="empty-state">
          <div class="ic">${icon("inbox")}</div>
          <h3>${state.group ? `В наборе ${esc(state.group)} нет диалогов` : "Диалогов пока нет"}</h3>
          <p>Импортируйте набор из API организаторов (group_id = DEV) или загрузите транскрипты в JSON.</p>
          <div class="row" style="justify-content:center">
            <button class="btn btn-primary" type="button" data-cta="import">${icon("cloud")}Импорт из API</button>
            <button class="btn" type="button" data-cta="upload">${icon("upload")}Загрузить JSON</button>
          </div>
        </div>`;
      return;
    }
    if (!list.length) {
      t.innerHTML = `
        <div class="empty-state">
          <div class="ic">${icon("filter")}</div>
          <h3>Ничего не найдено</h3>
          <p>Под выбранные фильтры не подходит ни один диалог.</p>
          <button class="btn" type="button" data-reset>Сбросить фильтры</button>
        </div>`;
      return;
    }
    t.innerHTML = `
      <table class="table conv-table">
        <caption class="sr-only">Диалоги и результаты оценки</caption>
        <thead><tr>
          ${th("id", "ID диалога")}
          <th class="col-opt">Канал</th><th>Язык</th>
          ${th("messages", "Реплик", "num col-opt")}
          ${th("score", "Итог", "num")}
          <th class="col-opt">Грубая ошибка</th><th class="col-opt">Статус</th><th class="col-opt">Апелляции</th>
        </tr></thead>
        <tbody>
          ${list.map((r) => {
            const crit = r.status === "done" && r.final_critical === "true";
            return `
            <tr class="click ${crit ? "is-crit" : ""}" data-id="${esc(r.id)}" data-href="${esc(cardHref(r))}">
              <td class="id-cell"><a href="${cardHref(r)}">${esc(r.id)}</a></td>
              <td class="col-opt"><span class="chan">${chanIcon(r.channel)}${esc(chanLabel(r.channel))}</span></td>
              <td><span class="lang" title="${esc(LANG[r.language] || r.language || "")}">${esc(r.language || "—")}</span></td>
              <td class="num col-opt">${esc(r.messages)}</td>
              <td class="num">${scoreCell(r)}</td>
              <td class="col-opt">${r.status === "done" ? (crit ? `<span class="badge crit">${icon("alert")}Выявлена</span>` : `<span class="muted small">нет</span>`) : ""}</td>
              <td class="col-opt">${statusBadge(r)}</td>
              <td class="col-opt">${Number(r.open_appeals) ? `<span class="badge warn">открыта: ${esc(r.open_appeals)}</span>` : Number(r.appeals) ? `<span class="badge brand">рассмотрено: ${esc(r.appeals)}</span>` : ""}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
  }

  function resetFilters() {
    Object.assign(state, { lang: "", channel: "", status: "", q: "" });
    $("#f-q", root).value = "";
    draw();
  }

  // ---- events
  page.addEventListener("click", (e) => {
    const chipBtn = e.target.closest("[data-f]");
    if (chipBtn) { state[chipBtn.dataset.f] = chipBtn.dataset.v; draw(); return; }
    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn) {
      const key = sortBtn.dataset.sort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === "score" ? -1 : 1 };
      draw();
      root.querySelector(`[data-sort="${key}"]`)?.focus();
      return;
    }
    if (e.target.closest("[data-reset]")) { resetFilters(); return; }
    const kpi = e.target.closest("[data-kpi-status]");
    if (kpi) { state.status = state.status === kpi.dataset.kpiStatus ? "" : kpi.dataset.kpiStatus; draw(); return; }
    const g = e.target.closest("[data-guide]");
    if (g) {
      if (g.dataset.guide === "import") importDialog(onImported);
      else if (g.dataset.guide === "eval") startBatch(true, g);
      return;
    }
    if (e.target.closest("[data-guide-hide]")) {
      store.set("cqa.guide.hidden", "1"); drawGuide();
      $("#btn-guide", root).focus();
      return;
    }
    const tg = e.target.closest("[data-guide-toggle]");
    if (tg) {
      const open = tg.getAttribute("aria-expanded") !== "true";
      try { sessionStorage.setItem("cqa.guide.open", open ? "1" : "0"); } catch { /* ignore */ }
      drawGuide();
      $("#guide [data-guide-toggle]", root)?.focus();
      return;
    }
    if (e.target.closest("#btn-guide")) {
      store.del("cqa.guide.hidden");
      try { sessionStorage.setItem("cqa.guide.open", "1"); } catch { /* ignore */ }
      drawGuide();
      $(".guide h2", root)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.target.closest("#btn-filters")) {
      const card = $(".conv-card", root), on = !card.classList.contains("show-filters");
      card.classList.toggle("show-filters", on);
      $("#btn-filters", root).setAttribute("aria-expanded", String(on));
      return;
    }
    const cta = e.target.closest("[data-cta]");
    if (cta) { (cta.dataset.cta === "import" ? importDialog : uploadDialog)(onImported); return; }
    const tr = e.target.closest("tr[data-id]");
    if (tr && !e.target.closest("a")) location.hash = tr.dataset.href;
  });
  $("#f-group", root).addEventListener("change", (e) => {
    state.group = e.target.value;
    store.set("cqa.group", state.group);
    load();
  });
  $("#f-checklist", root).addEventListener("change", (e) => { state.checklistId = Number(e.target.value); load(); });
  const onSearch = debounce(() => draw(), 120);
  $("#f-q", root).addEventListener("input", (e) => { state.q = e.target.value; onSearch(); });

  $("#btn-import", root).addEventListener("click", () => importDialog(onImported));
  $("#btn-upload", root).addEventListener("click", () => uploadDialog(onImported));
  function onImported(res) {
    toast(`Импортировано ${res.imported} ${plural(res.imported, ["диалог", "диалога", "диалогов"])} в набор ${res.group}. Нажмите «Оценить новые», чтобы запустить оценку.`);
    state.group = res.group;
    store.set("cqa.group", res.group);
    render(root);
  }

  // ---- batches
  let costPromise = null;
  const avgCost = () => (costPromise ||= api.stats({ checklist_id: state.checklistId }).then((s) => s.avg_cost_usd).catch(() => null));

  async function startBatch(onlyMissing, btn) {
    const scoped = filtersActive();
    const scope = scoped ? filtered() : rows;
    const targets = onlyMissing ? scope.filter(isNew) : scope;
    if (!targets.length) {
      toast(onlyMissing ? "Нет новых диалогов: все уже оценены этим чек-листом" : "Нет диалогов для оценки");
      return;
    }
    const cost = await avgCost();
    const n = targets.length;
    const ok = await confirmDialog({
      title: onlyMissing ? "Оценить новые диалоги" : "Переоценить все диалоги",
      okText: `Оценить ${n} ${plural(n, ["диалог", "диалога", "диалогов"])}`,
      body: `
        <dl class="cost-list">
          <dt>Чек-лист</dt><dd>${esc(clName(state.checklistId))}</dd>
          <dt>Набор</dt><dd>${esc(state.group || "все наборы")}</dd>
          <dt>Диалогов к оценке</dt><dd>${n}</dd>
          ${cost ? `<dt>Ориентировочная стоимость</dt><dd>≈ $${fmtNum(cost * n, 3)}</dd>` : ""}
        </dl>
        ${scoped ? `<div class="note warn">Учитываются активные фильтры: будут оценены только показанные диалоги.</div>` : ""}
        <div class="note">${onlyMissing ? "Оценка идёт в фоне, прогресс и стоимость будут видны над таблицей." : "Каждый диалог будет оценён заново. Предыдущие оценки сохранятся в истории."}</div>`,
    });
    if (!ok) return;
    busy(btn, true, "Запуск…");
    try {
      const body = { group: state.group || null, checklist_id: state.checklistId, only_missing: onlyMissing };
      if (scoped) body.conversation_ids = scope.map((r) => r.id);
      const b = await api.batch(body);
      if (!b.total) { toast("Нет диалогов для оценки"); return; }
      toast(`Запущена оценка ${b.total} ${plural(b.total, ["диалога", "диалогов", "диалогов"])}`);
      trackBatch(b.id);
    } catch (e) { toast(e.message, true); } finally { busy(btn, false); }
  }

  function trackBatch(id) {
    clearInterval(activePoll);
    const box = $("#batch", root);
    let first = true, t0 = null, d0 = 0;
    const tick = async () => {
      let b;
      try { b = await api.batchStatus(id); } catch { clearInterval(activePoll); store.del("cqa.batch"); return; }
      if (!root.isConnected) { clearInterval(activePoll); return; }
      const processed = Number(b.done) + Number(b.failed);
      const running = b.status === "running";
      if (first) {
        first = false;
        // Show the rows of the batch's checklist/group so statuses move live.
        let switched = false;
        if (b.checklist_id && b.checklist_id !== state.checklistId && checklists.some((c) => c.id === b.checklist_id)) {
          state.checklistId = b.checklist_id; $("#f-checklist", root).value = String(b.checklist_id); switched = true;
        }
        if (b.dataset_group && b.dataset_group !== state.group && groups.some((g) => g.id === b.dataset_group)) {
          state.group = b.dataset_group; store.set("cqa.group", state.group); $("#f-group", root).value = state.group; switched = true;
        }
        if (switched) costPromise = null;
        t0 = Date.now(); d0 = processed;
      }
      box.innerHTML = batchPanel(b, { clName, eta: running ? eta(t0, d0, processed, b.total) : null });
      if (!running) {
        clearInterval(activePoll);
        if (store.get("cqa.batch") === String(id)) {
          store.del("cqa.batch");
          toast(`Оценка набора #${b.id} завершена: ${b.done} ${plural(b.done, ["оценка", "оценки", "оценок"])}${b.failed ? `, ошибок: ${b.failed}` : ""}`, !!b.failed && !b.done);
        }
      }
      await load();
    };
    store.set("cqa.batch", String(id));
    tick();
    activePoll = setInterval(tick, 2500);
  }
  $("#batch", root).addEventListener("click", (e) => {
    if (e.target.closest("[data-hide-batch]")) $("#batch", root).innerHTML = "";
  });
  $("#btn-batch", root).addEventListener("click", (e) => startBatch(true, e.currentTarget));
  $("#btn-rebatch", root).addEventListener("click", (e) => startBatch(false, e.currentTarget));

  await load();
  const running = store.get("cqa.batch");
  if (running) trackBatch(Number(running));
  return () => clearInterval(activePoll);
}

function eta(t0, d0, processed, total) {
  const elapsed = (Date.now() - t0) / 1000, doneNow = processed - d0;
  if (doneNow < 1 || elapsed < 3) return null;
  const left = ((total - processed) * elapsed) / doneNow;
  return left < 60 ? "меньше минуты" : `≈ ${Math.round(left / 60)} мин`;
}

function duration(a, b) {
  if (!a || !b) return null;
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

function batchPanel(b, { clName, eta: etaText }) {
  const total = Number(b.total) || 0, done = Number(b.done) || 0, failed = Number(b.failed) || 0;
  const running = b.status === "running";
  const p = total ? Math.round(((done + failed) / total) * 100) : 100;
  const took = !running ? duration(b.created_at, b.finished_at) : null;
  return `
    <div class="card batch-panel ${running ? "is-running" : "is-done"} ${failed ? "has-fail" : ""}" role="status">
      <div class="bp-ic">${running ? '<span class="spinner" aria-hidden="true"></span>' : icon(failed ? "alert" : "check")}</div>
      <div class="bp-title">
        <b>Оценка набора #${esc(b.id)}${running ? "" : " завершена"}</b>
        <span class="muted small meta-list"><span>${esc(clName(b.checklist_id))}</span>${b.dataset_group ? `<span>набор ${esc(b.dataset_group)}</span>` : ""}</span>
      </div>
      <div class="bp-pct">${p}%${!running ? `<button class="btn btn-sm btn-ghost" type="button" data-hide-batch aria-label="Скрыть панель оценки набора">${icon("x")}</button>` : ""}</div>
      <div class="bp-bar" role="progressbar" aria-label="Прогресс оценки набора" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done + failed}">
        ${done ? `<i style="width:${(done / Math.max(total, 1)) * 100}%" title="Оценено: ${done}"></i>` : ""}
        ${failed ? `<i class="f" style="width:${(failed / Math.max(total, 1)) * 100}%" title="Ошибок: ${failed}"></i>` : ""}
      </div>
      <div class="bp-stats" style="grid-column:2">
        <span>Оценено <b>${done}</b> из <b>${total}</b></span>
        ${failed ? `<span style="color:var(--bad)">Ошибок <b style="color:inherit">${failed}</b></span>` : ""}
        <span>Стоимость <b>$${fmtNum(b.cost_usd, 4)}</b>${done ? ` <span class="muted">(≈ $${fmtNum(Number(b.cost_usd) / done, 4)} за диалог)</span>` : ""}</span>
        ${running && etaText ? `<span>Осталось <b>${etaText}</b></span>` : ""}
        ${took ? `<span>Время <b>${took}</b></span>` : ""}
      </div>
    </div>`;
}

function scoreCell(r) {
  if (r.status !== "done") return `<span class="muted">—</span>`;
  const fin = r.final_total, orig = r.total;
  const changed = fin !== null && orig !== null && Number(fin) !== Number(orig);
  const v = Math.max(0, Math.min(100, Number(fin) || 0));
  const title = `Итог ${fmtNum(fin)} из 100${changed ? ` (до апелляции ${fmtNum(orig)})` : ""}`;
  return `<span class="scorebar" title="${esc(title)}">
    ${changed ? `<span class="strike">${fmtNum(orig)}</span>` : ""}
    <span class="sb-track" aria-hidden="true"><i class="sb-fill ${scoreClass(fin)}" style="width:${v}%"></i></span>
    <span class="score-pill ${scoreClass(fin)}">${fmtNum(fin)}</span></span>`;
}

function statusBadge(r) {
  if (!r.eval_id) return `<span class="badge outline">не оценён</span>`;
  if (r.status === "done") return `<span class="badge yes"><span class="dot"></span>оценён</span>`;
  if (r.status === "error") return `<span class="badge no" title="${esc(r.error || "")}">ошибка</span>`;
  return `<span class="badge warn"><span class="spinner" style="width:10px;height:10px" aria-hidden="true"></span>${r.status === "running" ? "оценивается" : "в очереди"}</span>`;
}

export function importDialog(done) {
  const m = modal({
    title: "Импорт набора из API организаторов",
    submitText: "Импортировать",
    body: `
      <label class="field">group_id
        <input class="input" id="imp-group" value="DEV" placeholder="DEV" autocomplete="off" required></label>
      <div class="quick-picks" aria-label="Быстрый выбор">
        <button type="button" class="chip" data-pick="DEV">DEV</button>
      </div>
      <details class="more">
        <summary>Другой адрес API</summary>
        <label class="field">Адрес API <span class="hint">по умолчанию — из настроек сервера</span>
          <input class="input" id="imp-url" placeholder="https://…?group_id={group_id}" autocomplete="off"></label>
      </details>
      <div class="note">Запрос выполняется через сервер. Повторный импорт обновляет транскрипты, оценки сохраняются.</div>`,
    onSubmit: async (el) => {
      const g = $("#imp-group", el).value.trim();
      if (!g) { $("#imp-group", el).focus(); throw new Error("Укажите group_id"); }
      const ok = $("[data-ok]", el);
      busy(ok, true, "Импорт…");
      try {
        done(await api.importGroup(g, $("#imp-url", el).value.trim()));
      } finally { busy(ok, false); }
    },
  });
  m.el.addEventListener("click", (e) => {
    const p = e.target.closest("[data-pick]");
    if (p) { $("#imp-group", m.el).value = p.dataset.pick; $("#imp-group", m.el).focus(); }
  });
  $("#imp-group", m.el).select();
}

function countRecords(o) {
  if (o && typeof o === "object" && !Array.isArray(o) && "isSuccess" in o) o = o.data || {};
  if (o && Array.isArray(o.records)) return { n: o.records.length, group: o.dataset_group_id || "" };
  if (Array.isArray(o)) return { n: o.length, group: "" };
  if (o && typeof o === "object" && "transcript" in o) return { n: 1, group: "" };
  return { n: 0, group: "" };
}

export function uploadDialog(done) {
  let fileText = null;
  const m = modal({
    title: "Загрузить транскрипты",
    submitText: "Загрузить",
    body: `
      <label class="dropzone" id="up-drop">
        <input type="file" id="up-file" accept=".json,application/json">
        ${icon("upload")}
        <span id="up-drop-text"><b>Перетащите JSON-файл сюда</b> или нажмите, чтобы выбрать</span>
        <span class="muted small" id="up-drop-info">Полный ответ API, объект <code>data</code>, массив записей или одна запись</span>
      </label>
      <div class="or-sep">или вставьте JSON</div>
      <label class="field"><span class="sr-only">JSON</span>
        <textarea class="input mono" id="up-text" rows="6" placeholder='{"conversation_id":"demo-1","channel":"agent chat","language":"RU","transcript":[{"timestamp":"00:02","speaker":"operator","text":"Здравствуйте!"}]}'></textarea></label>
      <label class="field">Набор (group) <span class="hint">необязательно; по умолчанию из файла или UPLOAD</span>
        <input class="input" id="up-group" placeholder="UPLOAD" autocomplete="off"></label>`,
    onSubmit: async (el) => {
      const text = fileText ?? $("#up-text", el).value.trim();
      if (!text) throw new Error("Выберите файл или вставьте JSON");
      try { JSON.parse(text); } catch { throw new Error("Это не корректный JSON — проверьте файл"); }
      const ok = $("[data-ok]", el);
      busy(ok, true, "Загрузка…");
      try {
        done(await api.upload(text, $("#up-group", el).value.trim() || null));
      } finally { busy(ok, false); }
    },
  });
  const el = m.el, drop = $("#up-drop", el), info = $("#up-drop-info", el), dtext = $("#up-drop-text", el);
  async function useFile(f) {
    if (!f) return;
    const text = await f.text();
    let summary;
    try {
      const { n, group } = countRecords(JSON.parse(text));
      summary = n ? `Найдено записей: <b>${n}</b>${group ? ` · набор ${esc(group)}` : ""}` : `<span style="color:var(--bad)">Записи не найдены — проверьте формат</span>`;
      if (group && !$("#up-group", el).value) $("#up-group", el).placeholder = group;
    } catch {
      summary = `<span style="color:var(--bad)">Файл не является корректным JSON</span>`;
    }
    fileText = text;
    drop.classList.add("has-file");
    dtext.innerHTML = `<b>${esc(f.name)}</b> · ${fmtNum(f.size / 1024, 1)} КБ`;
    info.innerHTML = `${summary} · <button type="button" class="btn-link" data-clear>убрать</button>`;
  }
  $("#up-file", el).addEventListener("change", (e) => useFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => useFile(e.dataTransfer.files[0]));
  drop.addEventListener("click", (e) => {
    if (!e.target.closest("[data-clear]")) return;
    e.preventDefault();
    fileText = null;
    $("#up-file", el).value = "";
    drop.classList.remove("has-file");
    dtext.innerHTML = `<b>Перетащите JSON-файл сюда</b> или нажмите, чтобы выбрать`;
    info.innerHTML = `Полный ответ API, объект <code>data</code>, массив записей или одна запись`;
  });
}

// Open the card on the evaluation the row shows (the list is filtered by checklist version).
function cardHref(r) {
  return `#/conversation/${encodeURIComponent(r.id)}${r.eval_id ? `?eval=${r.eval_id}` : ""}`;
}
