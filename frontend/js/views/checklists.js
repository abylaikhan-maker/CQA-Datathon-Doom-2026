import { api } from "../api.js";
import {
  esc, $, $$, fmtNum, fmtDate, toast, busy, modal, TYPE_LABEL,
  plural, icon, confirmDialog,
} from "../util.js";

let draft = null;            // config being edited
let base = null;             // config of the version being edited (null for a new checklist)
let openSet = new Set();     // expanded criterion objects
let newSet = new Set();      // criteria added in this editing session
let settingsOpen = false;    // «Настройки чек-листа» disclosure state (survives re-renders)
let showErrs = false;        // validation messages appear only after an edit or a save attempt

const TYPE_SHORT = { binary: "Да / Нет", scale: "Шкала", critical: "Грубая ошибка" };
const FIELD = {
  id: "ID", code: "Код", title: "Название", section: "Секция", type: "Тип ответа", weight: "Вес",
  na_allowed: "N/A разрешён", description: "Формулировка", guidance: "Уточнения для оценки",
  na_condition: "Условие N/A", scale: "Шкала",
};
const LONG_FIELDS = new Set(["description", "guidance", "na_condition", "general_rules"]);

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

let offUnload = null;

export async function render(root, params, query = {}) {
  if (offUnload) { offUnload(); offUnload = null; }
  const [list, appealDetail] = await Promise.all([
    api.checklists(), /^\d+$/.test(query.appeal || "") ? api.appeal(Number(query.appeal)) : null,
  ]);
  const feedback = appealDetail?.appeal.status !== "open" ? appealDetail : null;
  const family = feedback ? list.filter((c) => c.name === feedback.evaluation.checklist_name) : [];
  let current;
  if (params.id === "new") {
    current = { id: null, config: blankConfig(), version: null, is_active: false };
  } else {
    const id = params.id ? Number(params.id) : (family[0] || list.find((c) => c.is_active) || list[0])?.id;
    current = id ? await api.checklist(id) : { id: null, config: blankConfig() };
  }
  if (!root.isConnected) return;
  draft = structuredClone(current.config);
  draft.sections ||= [];
  draft.criteria ||= [];
  base = current.id ? structuredClone(current.config) : null;
  openSet = new Set();
  newSet = new Set();
  settingsOpen = !current.id; // a new checklist starts with its name visible
  showErrs = false;
  const meta = list.find((c) => c.id === current.id);
  const source = family.some((c) => c.id === current.id) ? feedback.appeal : null;
  const target = source ? draft.criteria.find((c) => c.id === source.criterion_id) : null;
  if (target) openSet.add(target);
  const conversation = query.conversation || (source ? feedback.conversation.id : "");
  const comparison = query.eval || (source ? feedback.evaluation.id : null);
  const hasEarlierVersion = list.some((c) => c.name === current.config.name && c.version < current.version);
  const ruleCheckQuery = target ? `?${new URLSearchParams({ criterion: target.id })}` : "";
  const editorParams = new URLSearchParams();
  if (query.conversation) editorParams.set("conversation", query.conversation);
  if (query.eval) editorParams.set("eval", query.eval);
  if (feedback) editorParams.set("appeal", feedback.appeal.id);
  const editorQuery = editorParams.size ? `?${editorParams}` : "";
  const returnToDialog = (kid) => {
    const q = new URLSearchParams({ checklist: kid });
    if (comparison) q.set("eval", comparison);
    if (target) q.set("crit", target.id);
    return `#/conversation/${encodeURIComponent(conversation)}?${q}`;
  };

  root.innerHTML = `<div class="cl-page">
    <div class="page-head">
      <div><h1>Чек-листы</h1>
        <div class="sub">Измените критерий, сохраните новую версию и примените её к набору диалогов. Старые оценки остаются привязаны к своей версии.</div></div>
      <div class="spacer"></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/checklists/new${esc(editorQuery)}" data-nav-guard>${icon("plus")}Новый чек-лист</a></div>
    </div>
    ${source ? `<div class="qa-handoff">
      <span class="qa-handoff-icon">${icon("list")}</span>
      <div><b>Правило по апелляции <a href="#/appeals/${source.id}">#${source.id}</a></b>
        <div>${esc(source.reason)}</div>
        <div>${target ? "Сформулируйте общее правило для похожих диалогов и сохраните новую версию." : "Спорного критерия нет в этой версии. Выберите подходящую версию слева."}</div></div>
      ${target ? '<button type="button" class="btn" id="focus-feedback-rule">К уточнению</button>' : ""}
    </div>` : conversation ? `<div class="qa-handoff">
      <span class="qa-handoff-icon">${icon("chat")}</span>
      <div><b>Новые правила для диалога <span class="mono">${esc(conversation)}</span></b>
      <div>Сохраните версию, затем вернитесь к диалогу и переоцените его.</div></div>
      <a class="btn" href="${esc(returnToDialog(current.id || ""))}" id="return-dialog">К диалогу</a>
    </div>` : ""}
    <div class="cl-grid">
      <section class="card cl-list" aria-label="Версии чек-листов">
        <div class="card-head"><h2>Версии</h2><span class="badge">${list.length}</span></div>
        <div class="cl-scroll">
          ${list.map((c) => `
            <button type="button" class="cl-item ${c.id === current.id ? "sel" : ""}" data-id="${c.id}" ${c.id === current.id ? 'aria-current="true"' : ""}>
              <span class="t"><b>${esc(c.name)}</b><span class="ver">v${esc(c.version)}</span>${c.is_active ? `<span class="badge yes">активный</span>` : ""}</span>
              <span class="meta meta-list"><span>${c.criteria_count} ${plural(c.criteria_count, ["критерий", "критерия", "критериев"])}</span><span>${c.evaluations} ${plural(c.evaluations, ["оценка", "оценки", "оценок"])}</span><span>${esc(fmtDate(c.created_at))}</span></span>
              ${c.note ? `<span class="cl-note" style="display:-webkit-box">${esc(c.note)}</span>` : ""}
            </button>`).join("") || `<div class="empty">Нет чек-листов</div>`}
        </div>
      </section>
      <section class="card cl-editor" aria-label="Редактор чек-листа">
        <div class="card-head">
          <div class="ed-head-main">
            <h2>${current.id ? `${esc(current.config.name)} <span class="muted">v${esc(current.version)}</span>` : "Новый чек-лист"}
              ${current.is_active ? `<span class="badge yes">${icon("check")}активный</span>` : ""}</h2>
            ${current.id ? `<div class="muted small meta-list">${meta ? `<span>создан ${esc(fmtDate(meta.created_at))}</span><span>${meta.evaluations} ${plural(meta.evaluations, ["оценка", "оценки", "оценок"])}</span>` : ""}${current.note ? `<span>«${esc(current.note)}»</span>` : ""}</div>` : `<div class="muted small">Заполните параметры и добавьте критерии</div>`}
            ${current.source_appeal_id ? `<a class="small" href="#/appeals/${current.source_appeal_id}">Апелляция #${current.source_appeal_id}</a>` : ""}
          </div>
          <div class="ed-head-actions">
            ${current.id && !current.is_active ? `<button class="btn btn-sm" type="button" id="btn-activate">${icon("star")}Сделать активным</button>` : ""}
            ${current.id && hasEarlierVersion ? `<a class="btn btn-sm" id="btn-rule-check" href="#/checklists/${current.id}/rule-check${esc(ruleCheckQuery)}">${icon("check")}Проверить правило</a>` : ""}
            ${current.id ? `<button class="btn btn-sm" type="button" id="btn-apply">${icon("play")}Применить к набору…</button>` : ""}
            <button class="btn btn-sm" type="button" id="btn-json">${icon("code")}JSON</button>
          </div>
        </div>
        ${current.id ? '<section class="card-pad rule-suggestions" id="rule-suggestions" aria-label="Предложения по правилам" hidden></section>' : ""}
        <div class="card-pad" id="editor"></div>
        <div class="save-bar" id="save-bar"></div>
      </section>
    </div></div>`;
  const page = root.firstElementChild;

  const leaveOk = async () => !isDirty() || confirmDialog({
    title: "Несохранённые изменения",
    body: `<p style="margin:0">Изменения в редакторе не сохранены и будут потеряны.</p>`,
    okText: "Уйти без сохранения", danger: true,
  });
  $$(".cl-item", page).forEach((el) => el.addEventListener("click", async () => {
    if (Number(el.dataset.id) === current.id) return;
    if (await leaveOk()) location.hash = `#/checklists/${el.dataset.id}${editorQuery}`;
  }));
  $("[data-nav-guard]", page).addEventListener("click", async (e) => {
    e.preventDefault();
    if (await leaveOk()) location.hash = `#/checklists/new${editorQuery}`;
  });
  $("#btn-rule-check", page)?.addEventListener("click", async (e) => {
    e.preventDefault();
    const hash = e.currentTarget.hash;
    if (await leaveOk()) location.hash = hash;
  });
  $("#return-dialog", page)?.addEventListener("click", async (e) => {
    e.preventDefault();
    if (await leaveOk()) location.hash = returnToDialog(current.id || "");
  });
  $("#btn-activate", page)?.addEventListener("click", async (e) => {
    busy(e.currentTarget, true, "…");
    try {
      await api.activateChecklist(current.id);
      toast(`«${current.config.name} v${current.version}» теперь активный — он выбирается по умолчанию для новых оценок`);
      render(root, params, query);
    } catch (err) { toast(err.message, true); busy(e.currentTarget, false); }
  });
  $("#btn-apply", page)?.addEventListener("click", () => applyDialog(current));
  $("#btn-json", page).addEventListener("click", () => jsonDialog(page, current));

  const editor = $("#editor", page);
  const suggestionAppeals = new Set();
  drawEditor(editor);
  applyRuleDraft(current, editor, suggestionAppeals);
  $("#focus-feedback-rule", page)?.addEventListener("click", () => focusGuidance(editor, target));
  const suggestionSection = $("#rule-suggestions", page);
  if (suggestionSection) loadRuleSuggestions(suggestionSection, current, editor, suggestionAppeals);
  editor.addEventListener("input", (e) => onInput(e, editor));
  editor.addEventListener("change", (e) => onChange(e, editor));
  editor.addEventListener("click", (e) => onClick(e, editor));
  $("#save-bar", page).addEventListener("click", (e) => {
    if (e.target.closest("[data-act=save]")) {
      openSave(page, current, list, conversation ? returnToDialog : null, source?.id, [...suggestionAppeals]);
    }
    if (e.target.closest("[data-act=show-err]")) revealFirstError(editor);
  });

  const onUnload = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", onUnload);
  offUnload = () => window.removeEventListener("beforeunload", onUnload);
  return offUnload;
}

/** «Открыть в редакторе» on #/rules: the proposed guidance addition arrives as an unsaved draft change. */
function applyRuleDraft(current, editor, suggestionAppeals) {
  let d = null;
  try {
    d = JSON.parse(sessionStorage.getItem("cqa.ruleDraft") || "null");
    sessionStorage.removeItem("cqa.ruleDraft");
  } catch { /* ignore */ }
  if (!d || d.checklistId !== current.id || !d.addition) return;
  const criterion = draft.criteria.find((c) => c.id === d.criterionId);
  if (!criterion) { toast("В этой версии нет критерия из предложения", true); return; }
  criterion.guidance = [criterion.guidance?.trim(), d.addition].filter(Boolean).join("\n\n");
  (d.appeals || []).forEach((aid) => suggestionAppeals.add(aid));
  focusGuidance(editor, criterion);
  toast("Предложение добавлено в инструкцию критерия — проверьте текст и сохраните новую версию");
}

function focusGuidance(editor, criterion) {
  const index = draft.criteria.indexOf(criterion);
  if (index < 0) return;
  openSet.add(criterion);
  drawEditor(editor);
  $(`[data-k="criteria.${index}.guidance"]`, editor)?.focus();
}

async function loadRuleSuggestions(section, current, editor, suggestionAppeals) {
  let result;
  try {
    result = await api.ruleSuggestions(current.id);
  } catch {
    if (section.isConnected) {
      section.hidden = false;
      section.textContent = "Не удалось загрузить предложения по правилам.";
    }
    return;
  }
  if (!section.isConnected) return;
  const counts = new Map(result.items.map((item) => [item.criterion_id, item.case_count]));
  const items = current.config.criteria.filter((c) => counts.has(c.id));
  section.innerHTML = `
    <h3>Предложения по правилам</h3>
    <p class="muted small">После ${result.minimum_cases} пересмотренных оценок по разным диалогам Gemini может предложить уточнение к критерию.
      Все кейсы и предложения по версиям — в разделе <a href="#/rules?v=${current.id}">«Правила из апелляций»</a>.</p>
    ${items.length ? `<ul class="rule-suggestion-list">${items.map((c) => {
      const count = counts.get(c.id);
      const ready = count >= result.minimum_cases;
      const status = ready ? `${count} ${plural(count, ["диалог", "диалога", "диалогов"])}` : `${count} из ${result.minimum_cases} диалогов`;
      return `<li><b>${esc(c.code || c.id)} · ${esc(c.title)}</b>
        <span class="badge ${ready ? "brand" : "outline"}">${status}</span>
        ${ready ? `<button type="button" class="btn btn-sm" data-suggest-rule="${esc(c.id)}">Предложить уточнение</button>` : ""}
      </li>`;
    }).join("")}</ul>` : '<p class="muted small">Для этой версии пока нет пересмотренных оценок по апелляциям.</p>'}`;
  section.hidden = false;

  let generating = false;
  section.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-suggest-rule]");
    if (!button || generating) return;
    const id = button.dataset.suggestRule;
    const original = current.config.criteria.find((c) => c.id === id);
    const criterion = draft.criteria.find((c) => c.id === id);
    const isOriginal = () => draft?.criteria.includes(criterion) && JSON.stringify(criterion) === JSON.stringify(original);
    if (!isOriginal()) {
      toast("Сохраните текущие изменения этого критерия перед запросом предложения.", true);
      return;
    }
    generating = true;
    busy(button, true, "Готовим предложение…");
    try {
      const proposal = await api.suggestRule(current.id, id);
      if (!section.isConnected) return;
      const links = proposal.appeal_ids.map((aid) => `<a href="#/appeals/${esc(aid)}" target="_blank" rel="noopener">#${esc(aid)}</a>`).join(", ");
      const preview = modal({
        title: `Предложение по критерию ${original.code || original.id}`,
        cancelText: "Закрыть",
        submitText: "Вставить в черновик",
        body: `<p>${esc(proposal.reason)}</p>
          ${proposal.addition ? `<blockquote class="rule-suggestion-text">${esc(proposal.addition)}</blockquote>` : ""}
          <div class="muted small">Апелляции ${links}</div>`,
        onSubmit: proposal.addition ? () => {
          if (!section.isConnected || !isOriginal()) {
            toast("Критерий в редакторе изменился. Откройте сохранённую версию и запросите уточнение снова.", true);
            return;
          }
          criterion.guidance = [criterion.guidance?.trim(), proposal.addition].filter(Boolean).join("\n\n");
          proposal.appeal_ids.forEach((aid) => suggestionAppeals.add(aid));
          focusGuidance(editor, criterion);
        } : null,
      });
      const dialog = $('[role="dialog"]', preview.el);
      dialog.classList.add("modal-wide");
      dialog.setAttribute("aria-label", `Предложение по критерию ${original.code || original.id}`);
    } catch (error) {
      if (section.isConnected) toast(error.message, true);
    } finally {
      generating = false;
      busy(button, false);
    }
  });
}

/* ------------------------------------------------------------ model ---- */

function blankConfig() {
  return {
    name: "Новый чек-лист", description: "", rounding: 2, general_rules: "",
    sections: [{ id: "main", title: "Основное" }],
    criteria: [],
  };
}

function newCriterion() {
  const n = draft.criteria.length + 1;
  let id = `c${String(n).padStart(2, "0")}`;
  while (draft.criteria.some((c) => c.id === id)) id += "x";
  return {
    id, code: String(n).padStart(2, "0"), section: draft.sections[0]?.id || "", title: "",
    type: "binary", weight: 10, na_allowed: false, description: "", guidance: "", na_condition: "",
  };
}

const scoredCriteria = () => draft.criteria.filter((c) => c.type !== "critical");
const totalWeight = () => scoredCriteria().reduce((s, c) => s + (Number(c.weight) || 0), 0);
const share = (c) => {
  const tw = totalWeight();
  return c.type === "critical" || !tw ? 0 : ((Number(c.weight) || 0) / tw) * 100;
};

function validate() {
  const e = {};
  if (!String(draft.name || "").trim()) e.name = "Укажите название чек-листа";
  if (!draft.criteria.length) e.criteria = "Добавьте хотя бы один критерий";
  const seen = {};
  draft.criteria.forEach((c) => { const id = String(c.id || "").trim(); if (id) seen[id] = (seen[id] || 0) + 1; });
  draft.criteria.forEach((c, i) => {
    const k = (f) => `criteria.${i}.${f}`;
    const id = String(c.id || "").trim();
    if (!id) e[k("id")] = "Укажите ID";
    else if (seen[id] > 1) e[k("id")] = "ID повторяется";
    if (!String(c.title || "").trim()) e[k("title")] = "Укажите название критерия";
    if (c.type !== "critical" && Number(c.weight) < 0) e[k("weight")] = "Вес не может быть отрицательным";
    if (c.type === "scale") {
      const vals = (c.scale || []).map((s) => (s.value === "" || s.value === null ? NaN : Number(s.value)));
      if (vals.some((v) => !Number.isFinite(v))) e[k("scale")] = "У каждой ступени должен быть балл";
      else if (new Set(vals).size !== vals.length) e[k("scale")] = "Баллы ступеней не должны повторяться";
      else if (vals.length < 2) e[k("scale")] = "Шкале нужно минимум 2 ступени";
      else if (Math.max(...vals) <= 0) e[k("scale")] = "Верхняя ступень должна быть больше 0";
    }
  });
  return e;
}

/* ------------------------------------------------------------- diff ---- */

const normScale = (sc) => JSON.stringify([...(sc || [])].map((s) => ({ v: Number(s.value), d: String(s.description || "").trim() })).sort((a, b) => b.v - a.v));
const scaleValues = (sc) => [...(sc || [])].map((s) => Number(s.value)).sort((a, b) => b - a).map((v) => fmtNum(v)).join(" / ") || "—";

function fieldValue(c, f) {
  if (f === "weight") return c.type === "critical" ? 0 : Number(c.weight) || 0;
  if (f === "na_allowed") return !!c.na_allowed;
  if (f === "scale") return c.type === "scale" ? normScale(c.scale) : "";
  return String(c[f] ?? "").trim();
}

function computeDiff(a, b) {
  const d = { general: [], added: [], removed: [], changed: [], reordered: false };
  if (!a) return d;
  for (const [f, label] of [["name", "Название"], ["description", "Описание"], ["rounding", "Округление"], ["general_rules", "Общие правила"]]) {
    const x = String(a[f] ?? "").trim(), y = String(b[f] ?? "").trim();
    if (x !== y) d.general.push({ f, label, old: x, new: y });
  }
  const as = new Map((a.sections || []).map((s) => [s.id, s])), bs = new Map((b.sections || []).map((s) => [s.id, s]));
  for (const [id, s] of bs) {
    if (!as.has(id)) d.general.push({ label: "Секция добавлена", new: s.title || id });
    else if ((as.get(id).title || "") !== (s.title || "")) d.general.push({ label: `Секция «${id}» переименована`, old: as.get(id).title, new: s.title });
  }
  for (const [id, s] of as) if (!bs.has(id)) d.general.push({ label: "Секция удалена", old: s.title || id });

  const am = new Map(a.criteria.map((c) => [c.id, c])), bm = new Map(b.criteria.map((c) => [c.id, c]));
  b.criteria.forEach((c) => { if (!am.has(c.id)) d.added.push(c); });
  a.criteria.forEach((c) => { if (!bm.has(c.id)) d.removed.push(c); });
  b.criteria.forEach((c) => {
    const o = am.get(c.id);
    if (!o) return;
    const fields = Object.keys(FIELD).filter((f) => f !== "id" && fieldValue(o, f) !== fieldValue(c, f));
    if (fields.length) d.changed.push({ old: o, now: c, fields });
  });
  const ao = a.criteria.map((c) => c.id).filter((id) => bm.has(id)), bo = b.criteria.map((c) => c.id).filter((id) => am.has(id));
  d.reordered = ao.join("\u0001") !== bo.join("\u0001");
  return d;
}

const diffCount = (d) => d.general.length + d.added.length + d.removed.length + d.changed.length + (d.reordered ? 1 : 0);

function showValue(cfg, c, f) {
  if (f === "type") return TYPE_LABEL[c.type] || c.type;
  if (f === "na_allowed") return c.na_allowed ? "да" : "нет";
  if (f === "weight") return c.type === "critical" ? "без баллов" : fmtNum(c.weight);
  if (f === "section") return (cfg.sections || []).find((s) => s.id === c.section)?.title || c.section || "—";
  if (f === "scale") return c.type === "scale" ? scaleValues(c.scale) : "—";
  return String(c[f] ?? "").trim() || "—";
}

function inlineChange(o, n) {
  return `<span class="diff-old">${esc(o)}</span> → <span class="diff-new">${esc(n)}</span>`;
}
function blockChange(o, n) {
  return `<div class="diff-text">${o ? `<span class="diff-old">${esc(o)}</span>` : ""}${n ? `<span class="diff-new">${esc(n)}</span>` : ""}</div>`;
}

function diffHtml(d) {
  const n = diffCount(d);
  if (!n) return `<div class="diff-empty">Изменений нет — новая версия совпадёт с текущей.</div>`;
  const crit = (c) => `<span class="code">${esc(c.code || c.id)}</span>${esc(c.title || "Без названия")}`;
  const items = [];
  if (d.general.length) {
    items.push(`<div class="diff-item gen"><div class="dh">Общие параметры</div><ul>${d.general.map((g) => {
      if (LONG_FIELDS.has(g.f)) return `<li><span class="f">${esc(g.label)}</span>${blockChange(g.old, g.new)}</li>`;
      if (g.old !== undefined && g.new !== undefined) return `<li><span class="f">${esc(g.label)}:</span> ${inlineChange(g.old || "—", g.new || "—")}</li>`;
      return `<li><span class="f">${esc(g.label)}:</span> ${g.new !== undefined ? `<span class="diff-new">${esc(g.new)}</span>` : `<span class="diff-old">${esc(g.old)}</span>`}</li>`;
    }).join("")}</ul></div>`);
  }
  d.added.forEach((c) => items.push(`<div class="diff-item add"><div class="dh"><span class="badge yes">добавлен</span>${crit(c)}</div>
    <ul><li>${esc(TYPE_LABEL[c.type] || c.type)} · вес ${esc(showValue(draft, c, "weight"))} · N/A ${c.na_allowed ? "разрешён" : "запрещён"}${c.type === "scale" ? ` · шкала ${esc(scaleValues(c.scale))}` : ""}</li>
    ${c.description ? `<li>${esc(c.description)}</li>` : ""}</ul></div>`));
  d.removed.forEach((c) => items.push(`<div class="diff-item del"><div class="dh"><span class="badge no">удалён</span>${crit(c)}</div></div>`));
  d.changed.forEach(({ old, now, fields }) => items.push(`<div class="diff-item mod"><div class="dh"><span class="badge warn">изменён</span>${crit(now)}</div><ul>
    ${fields.map((f) => {
      if (LONG_FIELDS.has(f)) return `<li><span class="f">${FIELD[f]}</span>${blockChange(String(old[f] ?? "").trim(), String(now[f] ?? "").trim())}</li>`;
      if (f === "scale") {
        const ov = showValue(base, old, f), nv = showValue(draft, now, f);
        return `<li><span class="f">Шкала:</span> ${ov === nv ? "изменены описания ступеней" : inlineChange(ov, nv)}</li>`;
      }
      return `<li><span class="f">${FIELD[f]}:</span> ${inlineChange(showValue(base, old, f), showValue(draft, now, f))}</li>`;
    }).join("")}</ul></div>`));
  if (d.reordered) items.push(`<div class="diff-item gen"><div class="dh">Изменён порядок критериев</div></div>`);
  return `
    <div class="diff-sum">
      ${d.added.length ? `<span class="badge yes">+${d.added.length} ${plural(d.added.length, ["добавлен", "добавлено", "добавлено"])}</span>` : ""}
      ${d.removed.length ? `<span class="badge no">−${d.removed.length} ${plural(d.removed.length, ["удалён", "удалено", "удалено"])}</span>` : ""}
      ${d.changed.length ? `<span class="badge warn">${d.changed.length} ${plural(d.changed.length, ["критерий изменён", "критерия изменено", "критериев изменено"])}</span>` : ""}
      ${d.general.length ? `<span class="badge brand">общие параметры: ${d.general.length}</span>` : ""}
    </div>
    <div class="diff-list">${items.join("")}</div>`;
}

function autoNote(d) {
  const parts = [];
  d.changed.forEach(({ now, fields }) => parts.push(`${now.code || now.id} ${now.title}: ${fields.map((f) => FIELD[f].toLowerCase()).join(", ")}`));
  d.added.forEach((c) => parts.push(`добавлен ${c.code || c.id} ${c.title}`));
  d.removed.forEach((c) => parts.push(`удалён ${c.code || c.id} ${c.title}`));
  if (d.general.length) parts.push("общие параметры");
  if (d.reordered) parts.push("порядок критериев");
  const s = parts.join("; ");
  return s.length > 200 ? s.slice(0, 197) + "…" : s;
}

function isDirty() {
  if (!draft) return false;
  if (!base) return draft.criteria.length > 0;
  return diffCount(computeDiff(base, draft)) > 0;
}

/* ----------------------------------------------------------- editor ---- */

function errSlot(key) { return `<small class="field-err" data-err="${esc(key)}" role="alert"></small>`; }

function drawEditor(el, focusKey) {
  el.innerHTML = `
    <details class="ed-settings" id="ed-settings" ${settingsOpen ? "open" : ""}>
      <summary>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
        <span class="ed-settings-t">Настройки чек-листа</span>
        <span class="ed-settings-sub">название, описание, общие правила для модели</span>
        <span class="err-dot" title="Есть ошибки"></span>
      </summary>
      <div class="ed-settings-body">
        <div class="ed-general">
          <label class="field span4">Название чек-листа<input class="input" data-k="name" value="${esc(draft.name)}">${errSlot("name")}</label>
          <label class="field span2">Округление итога, знаков<input class="input" type="number" min="0" max="4" data-k="rounding" value="${esc(draft.rounding ?? 2)}"></label>
          <label class="field span6">Описание<input class="input" data-k="description" value="${esc(draft.description || "")}" placeholder="Коротко: для чего этот чек-лист"></label>
          <label class="field span6">Общие правила для оценщика <span class="hint">контекст, который модель получает вместе с критериями</span>
            <textarea class="input" rows="4" data-k="general_rules">${esc(draft.general_rules || "")}</textarea></label>
        </div>
      </div>
    </details>

    <div class="ed-section-title">Критерии <span class="muted">(${draft.criteria.length})</span><span class="spacer"></span>
      ${draft.criteria.length ? `<button class="btn btn-sm btn-ghost" type="button" data-act="expand-all">${draft.criteria.every((c) => openSet.has(c)) ? "Свернуть все" : "Развернуть все"}</button>` : ""}</div>
    <div class="weights" id="weights"></div>
    ${errSlot("criteria")}
    <div id="crit-list">${draft.criteria.map((c, i) => critEditor(c, i)).join("") || `<div class="diff-empty">Критериев пока нет. Добавьте первый: название, тип ответа и вес.</div>`}</div>
    <button class="btn" type="button" data-act="add-crit">${icon("plus")}Добавить критерий</button>`;
  $("#ed-settings", el).addEventListener("toggle", (e) => { settingsOpen = e.currentTarget.open; });
  paint(el);
  if (focusKey) {
    const f = el.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
    if (f) f.focus();
  }
}

function critEditor(c, i) {
  const k = (f) => `criteria.${i}.${f}`;
  const open = openSet.has(c);
  return `
    <div class="ed-crit ${open ? "open" : ""} ${newSet.has(c) ? "is-new" : ""}" data-ci="${i}">
      <div class="ed-crit-head">
        <button type="button" class="ed-toggle" data-act="toggle" data-i="${i}" aria-expanded="${open}" aria-controls="crit-body-${i}">
          <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
          <span class="code" data-h="code">${esc(c.code || "")}</span>
          <span class="title" data-h="title"></span>
          <span class="err-dot" title="Есть ошибки"></span>
          <span class="tags">
            <span class="badge">${esc(TYPE_SHORT[c.type] || c.type)}</span>
            <span class="badge brand keep" data-h="weight"></span>
            ${c.na_allowed ? `<span class="badge na">N/A</span>` : ""}
          </span>
        </button>
        <div class="ed-crit-tools">
          <button class="btn btn-sm btn-ghost btn-icon" type="button" data-act="up" data-i="${i}" aria-label="Переместить выше" title="Выше" ${i === 0 ? "disabled" : ""}>${icon("up")}</button>
          <button class="btn btn-sm btn-ghost btn-icon" type="button" data-act="down" data-i="${i}" aria-label="Переместить ниже" title="Ниже" ${i === draft.criteria.length - 1 ? "disabled" : ""}>${icon("down")}</button>
          <button class="btn btn-sm btn-ghost btn-danger btn-icon" type="button" data-act="del-crit" data-i="${i}" aria-label="Удалить критерий" title="Удалить критерий">${icon("trash")}</button>
        </div>
      </div>
      <div class="ed-crit-body" id="crit-body-${i}">
        <label class="field span4">Название<input class="input" data-k="${k("title")}" value="${esc(c.title)}" placeholder="Например: Установление контакта">${errSlot(k("title"))}</label>
        <label class="field">Код<input class="input" data-k="${k("code")}" value="${esc(c.code || "")}"></label>
        <label class="field">Идентификатор<input class="input mono" data-k="${k("id")}" value="${esc(c.id)}" spellcheck="false">${errSlot(k("id"))}</label>
        <label class="field span2">Тип ответа
          <select class="input" data-k="${k("type")}" data-redraw>
            ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${v === c.type ? "selected" : ""}>${esc(l)}</option>`).join("")}
          </select></label>
        <label class="field">Вес<input class="input" type="number" min="0" step="0.5" data-k="${k("weight")}" value="${c.type === "critical" ? 0 : esc(c.weight)}" ${c.type === "critical" ? 'disabled title="Грубая ошибка не даёт баллов"' : ""}>${errSlot(k("weight"))}</label>
        <div class="field"><span>N/A</span><label class="checkline"><input type="checkbox" data-k="${k("na_allowed")}" data-redraw ${c.na_allowed ? "checked" : ""}> разрешён</label></div>
        <label class="field span6">${c.type === "critical" ? "Что считается грубой ошибкой" : c.type === "scale" ? "Что оценивается по шкале" : "Формулировка: что значит «Да»"}
          <textarea class="input" rows="2" data-k="${k("description")}">${esc(c.description || "")}</textarea></label>
        <label class="field span6">Уточнения для оценки (памятка для модели: пограничные случаи, что не считать нарушением)
          <textarea class="input" rows="3" data-k="${k("guidance")}">${esc(c.guidance || "")}</textarea></label>
        ${c.na_allowed ? `<label class="field span6">Когда ставить N/A<input class="input" data-k="${k("na_condition")}" value="${esc(c.na_condition || "")}" placeholder="Например: запрос не требовал идентификации"></label>` : ""}
        ${c.type === "scale" ? `
          <div class="field span6"><span>Шкала <span class="hint">верхняя ступень даёт полный вес, остальные — пропорционально</span></span>
            <div class="scale-head"><span>Балл</span><span>Описание ступени</span><span></span></div>
            ${(c.scale || []).map((s, j) => `
              <div class="scale-row">
                <input class="input" type="number" step="any" data-k="${k(`scale.${j}.value`)}" value="${esc(s.value)}" aria-label="Балл ступени ${j + 1}">
                <input class="input" data-k="${k(`scale.${j}.description`)}" value="${esc(s.description)}" placeholder="Описание ступени" aria-label="Описание ступени ${j + 1}">
                <button class="btn btn-sm btn-ghost btn-danger btn-icon" type="button" data-act="del-step" data-i="${i}" data-j="${j}" aria-label="Удалить ступень ${j + 1}" title="Удалить ступень">${icon("x")}</button>
              </div>`).join("")}
            ${errSlot(k("scale"))}
            <div><button class="btn btn-sm" type="button" data-act="add-step" data-i="${i}">${icon("plus")}Ступень</button></div>
          </div>` : ""}
      </div>
    </div>`;
}

/** Updates validation messages, criterion headers, weights and the save bar without re-rendering inputs. */
function paint(el) {
  const errs = showErrs ? validate() : {};
  $$("[data-err]", el).forEach((s) => { s.textContent = errs[s.dataset.err] || ""; });
  $$("[data-k]", el).forEach((inp) => {
    if (errs[inp.dataset.k]) inp.setAttribute("aria-invalid", "true"); else inp.removeAttribute("aria-invalid");
  });
  $$(".ed-crit", el).forEach((card) => {
    const i = Number(card.dataset.ci), c = draft.criteria[i];
    if (!c) return;
    const prefix = `criteria.${i}.`;
    card.classList.toggle("has-err", Object.keys(errs).some((k) => k.startsWith(prefix)));
    const t = $("[data-h=title]", card);
    t.textContent = c.title || "Без названия";
    t.classList.toggle("empty-t", !c.title);
    $("[data-h=code]", card).textContent = c.code || "";
    $("[data-h=weight]", card).textContent = c.type === "critical" ? "без баллов" : `вес ${fmtNum(c.weight)} · ${fmtNum(share(c), 1)}%`;
  });
  const set = $("#ed-settings", el);
  if (set) set.classList.toggle("has-err", Object.keys(errs).some((k) => k === "name"));
  paintWeights(el);
  paintSaveBar(el, errs);
}

function paintWeights(el) {
  const box = $("#weights", el);
  if (!box) return;
  const tw = totalWeight();
  const scored = scoredCriteria().filter((c) => Number(c.weight) > 0);
  const crit = draft.criteria.length - scoredCriteria().length;
  box.innerHTML = `
    <div class="w-top">
      <span>Сумма весов: <b class="num-t">${fmtNum(tw)}</b></span>
      ${tw === 100 ? `<span class="badge yes">${icon("check")}= 100</span>` : `<span class="badge warn">≠ 100</span>`}
      <span class="muted">с баллами: ${scoredCriteria().length}</span>
      ${crit ? `<span class="muted">грубых ошибок (без баллов): ${crit}</span>` : ""}
    </div>
    ${scored.length ? `<div class="weights-bar" role="img" aria-label="Доли весов: ${esc(scored.map((c) => `${c.code || c.id} — ${fmtNum(share(c), 1)}%`).join(", "))}">
      ${scored.map((c) => `<i style="flex:${Number(c.weight)}" title="${esc(`${c.code || c.id} ${c.title || ""}: вес ${fmtNum(c.weight)} → ${fmtNum(share(c), 1)}% итога`)}">${share(c) >= 5 ? esc(c.code || c.id) : ""}</i>`).join("")}
    </div>` : `<div class="muted small">Нет критериев с весом</div>`}
    ${tw !== 100 && tw > 0 ? `<div class="w-note">Сумма не равна 100 — это допустимо: каждый вес пересчитывается в долю от суммы (например, вес ${fmtNum(scored[0]?.weight)} даёт ${fmtNum(share(scored[0] || {}), 1)}% итога).</div>` : ""}`;
}

function paintSaveBar(el, errs) {
  const bar = el.closest(".cl-editor")?.querySelector("#save-bar");
  if (!bar) return;
  const nErr = Object.keys(errs).length;
  const d = computeDiff(base, draft), n = diffCount(d);
  const parts = [];
  if (nErr) parts.push(`<span class="badge no">${icon("alert")}${nErr} ${plural(nErr, ["ошибка", "ошибки", "ошибок"])}</span><button class="btn-link small" type="button" data-act="show-err">показать</button>`);
  if (base) parts.push(n ? `<span class="badge warn">${n} ${plural(n, ["изменение", "изменения", "изменений"])}</span><span class="muted sb-help">перед сохранением покажем, что изменилось</span>` : `<span class="muted">Изменений нет<span class="sb-help">. Откройте критерий и отредактируйте его — кнопка сохранения станет активной</span></span>`);
  else parts.push(`<span class="muted">Новый чек-лист</span><span class="muted">${draft.criteria.length} ${plural(draft.criteria.length, ["критерий", "критерия", "критериев"])}</span>`);
  // Update in place: a field's `change` fires on mousedown of the save button, and replacing the
  // button at that moment swallowed the click (the first «Сохранить» click after typing did nothing).
  if (!bar.querySelector("[data-act=save]")) {
    bar.innerHTML = `
      <div class="status" aria-live="polite"></div>
      <button class="btn btn-primary" type="button" data-act="save">${icon("check")}Сохранить новую версию…</button>`;
  }
  const html = parts.join("");
  const status = bar.querySelector(".status");
  if (status.innerHTML !== html) status.innerHTML = html;
  const btn = bar.querySelector("[data-act=save]");
  const off = !!base && !n;
  btn.disabled = off;
  if (off) btn.title = "Нет изменений для сохранения"; else btn.removeAttribute("title");
}

function revealFirstError(el) {
  const errs = validate();
  const key = Object.keys(errs)[0];
  if (!key) return;
  const m = key.match(/^criteria\.(\d+)\./);
  if (key === "name" || key.startsWith("sections.")) {
    settingsOpen = true;
    const set = $("#ed-settings", el);
    if (set) set.open = true;
  }
  if (m) {
    const c = draft.criteria[Number(m[1])];
    if (c && !openSet.has(c)) { openSet.add(c); drawEditor(el); }
  }
  const target = el.querySelector(`[data-k="${CSS.escape(key)}"]`) || el.querySelector(`[data-err="${CSS.escape(key)}"]`);
  if (target) {
    const settings = target.closest("details");
    if (settings) settings.open = true;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    if (target.focus) target.focus({ preventScroll: true });
  }
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts.at(-1)] = value;
}

function onInput(e, editor) {
  const t = e.target;
  if (!t.dataset.k || t.type === "checkbox" || t.tagName === "SELECT") return;
  showErrs = true;
  let v = t.value;
  if (t.type === "number") v = v === "" ? (t.dataset.k.includes(".scale.") ? "" : 0) : Number(v);
  const k = t.dataset.k;
  const sec = k.match(/^sections\.(\d+)\.id$/);
  if (sec) {
    // Keep criteria attached to a renamed section.
    const old = draft.sections[Number(sec[1])].id;
    draft.criteria.forEach((c) => { if (c.section === old) c.section = v; });
  }
  setPath(draft, k, v);
  if (/^sections\.\d+\.(id|title)$/.test(k)) syncSectionOptions(editor);
  paint(editor);
}

/** Rebuilds the criterion section selects in place (no re-render, focus stays put). */
function syncSectionOptions(editor) {
  $$('select[data-k$=".section"]', editor).forEach((sel) => {
    const c = draft.criteria[Number(sel.dataset.k.split(".")[1])];
    sel.innerHTML = `<option value="">—</option>` + draft.sections.map((s) =>
      `<option value="${esc(s.id)}" ${s.id === c.section ? "selected" : ""}>${esc(s.title || s.id)}</option>`).join("");
  });
}

function onChange(e, editor) {
  const t = e.target;
  if (!t.dataset.k) return;
  showErrs = true;
  // Text fields are already applied by onInput; a change event only re-checks validation.
  if (t.type !== "checkbox" && t.tagName !== "SELECT") { paint(editor); return; }
  const k = t.dataset.k;
  const v = t.type === "checkbox" ? t.checked : t.value;
  setPath(draft, k, v);
  if (k.endsWith(".type")) {
    const c = draft.criteria[Number(k.split(".")[1])];
    if (v === "scale" && !(c.scale || []).length) c.scale = [{ value: 10, description: "" }, { value: 5, description: "" }, { value: 0, description: "" }];
    if (v === "critical") { c.weight = 0; c.na_allowed = false; }
    if (v !== "critical" && !Number(c.weight)) c.weight = 10;
  }
  // Type and N/A change the shape of the criterion form.
  if (t.dataset.redraw !== undefined) drawEditor(editor, k);
  else paint(editor);
}

async function onClick(e, editor) {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const i = Number(b.dataset.i);
  let focusKey = null;
  switch (b.dataset.act) {
    case "toggle": {
      const c = draft.criteria[i];
      if (openSet.has(c)) openSet.delete(c); else openSet.add(c);
      const card = b.closest(".ed-crit");
      card.classList.toggle("open", openSet.has(c));
      b.setAttribute("aria-expanded", String(openSet.has(c)));
      const ex = $("[data-act=expand-all]", editor);
      if (ex) ex.textContent = draft.criteria.every((x) => openSet.has(x)) ? "Свернуть все" : "Развернуть все";
      return;
    }
    case "expand-all": {
      const all = draft.criteria.every((c) => openSet.has(c));
      openSet = all ? new Set() : new Set(draft.criteria);
      break;
    }
    case "add-crit": {
      const c = newCriterion();
      draft.criteria.push(c);
      openSet.add(c); newSet.add(c);
      focusKey = `criteria.${draft.criteria.length - 1}.title`;
      break;
    }
    case "del-crit": {
      const c = draft.criteria[i];
      const ok = await confirmDialog({
        title: "Удалить критерий?",
        body: `<p style="margin:0">Критерий <b>${esc(c.code || "")} ${esc(c.title || c.id)}</b> будет удалён из новой версии. Сохранённые версии и оценки не изменятся.</p>`,
        okText: "Удалить", danger: true,
      });
      if (!ok) return;
      draft.criteria.splice(i, 1);
      break;
    }
    case "up": [draft.criteria[i - 1], draft.criteria[i]] = [draft.criteria[i], draft.criteria[i - 1]]; focusKey = null; break;
    case "down": [draft.criteria[i + 1], draft.criteria[i]] = [draft.criteria[i], draft.criteria[i + 1]]; break;
    case "add-step": {
      const sc = (draft.criteria[i].scale ||= []);
      sc.push({ value: "", description: "" });
      focusKey = `criteria.${i}.scale.${sc.length - 1}.value`;
      break;
    }
    case "del-step": draft.criteria[i].scale.splice(Number(b.dataset.j), 1); break;
    case "add-section": {
      let n = draft.sections.length + 1, id = `s${n}`;
      while (draft.sections.some((s) => s.id === id)) id = `s${++n}`;
      draft.sections.push({ id, title: "" });
      focusKey = `sections.${draft.sections.length - 1}.title`;
      break;
    }
    case "del-section": {
      const s = draft.sections[i];
      const used = draft.criteria.filter((c) => c.section === s.id).length;
      if (used) { toast(`Секция используется в ${used} ${plural(used, ["критерии", "критериях", "критериях"])} — сначала перенесите их`, true); return; }
      draft.sections.splice(i, 1);
      break;
    }
    default: return;
  }
  drawEditor(editor, focusKey);
  if (b.dataset.act === "up" || b.dataset.act === "down") {
    const j = b.dataset.act === "up" ? i - 1 : i + 1;
    editor.querySelector(`[data-act="${b.dataset.act}"][data-i="${j}"]`)?.focus();
  }
}

/* ------------------------------------------------------------- save ---- */

function cleanConfig() {
  const cfg = structuredClone(draft);
  cfg.name = String(cfg.name || "").trim();
  cfg.sections = cfg.sections.map((s) => ({ ...s, id: String(s.id).trim() }));
  const secIds = new Set(cfg.sections.map((s) => s.id));
  cfg.criteria.forEach((c) => { if (c.section && !secIds.has(c.section)) c.section = cfg.sections[0]?.id || ""; });
  cfg.criteria.forEach((c) => {
    c.id = String(c.id).trim();
    c.title = String(c.title).trim();
    if (c.type === "scale") c.scale = (c.scale || []).map((s) => ({ value: Number(s.value), description: s.description || "" }));
  });
  return cfg;
}

function openSave(page, current, list, returnToDialog, sourceAppealId, suggestionAppeals) {
  const editor = $("#editor", page);
  const errs = validate();
  if (Object.keys(errs).length) {
    showErrs = true;
    paint(editor);
    toast(`Исправьте ошибки в чек-листе (${Object.keys(errs).length})`, true);
    revealFirstError(editor);
    return;
  }
  const cfg = cleanConfig();
  const d = computeDiff(base, cfg);
  const sameName = list.filter((c) => c.name === cfg.name);
  const next = sameName.length ? Math.max(...sameName.map((c) => c.version)) + 1 : 1;
  const nameChanged = base && base.name !== cfg.name;
  const appeals = [...new Set([sourceAppealId, ...suggestionAppeals].filter(Boolean))];
  const originNote = appeals.length ? `По ${appeals.length === 1 ? "апелляции" : "апелляциям"} ${appeals.map((id) => `#${id}`).join(", ")}` : "";
  const note = [originNote, base ? autoNote(d) : ""].filter(Boolean).join(" · ");
  const m = modal({
    title: `Сохранить «${cfg.name}» v${next}`,
    submitText: returnToDialog ? `Сохранить v${next} и вернуться` : `Сохранить v${next}`,
    body: `
      ${base ? `<div class="small muted">Сравнение с <b>${esc(base.name)} v${esc(current.version)}</b>. Будет создана новая версия <b>v${next}</b>; оценки по v${esc(current.version)} останутся привязаны к ней.</div>`
        : `<div class="small muted">Будет создан чек-лист <b>${esc(cfg.name)}</b>, версия <b>v${next}</b>, ${cfg.criteria.length} ${plural(cfg.criteria.length, ["критерий", "критерия", "критериев"])}.</div>`}
      ${nameChanged ? `<div class="note warn">Название изменено: версии нумеруются в пределах названия, поэтому это будет «${esc(cfg.name)}» v${next}.</div>` : ""}
      ${base ? diffHtml(d) : ""}
      <label class="field">Комментарий к версии <span class="hint">виден в списке версий</span>
        <input class="input" id="sv-note" maxlength="300" value="${esc(note.slice(0, 300))}" placeholder="Что изменено и зачем"></label>
      <label class="check"><input type="checkbox" id="sv-activate" ${returnToDialog || suggestionAppeals.length ? "" : "checked"}> Сделать активной — выбирается по умолчанию для новых оценок</label>`,
    onSubmit: async (el) => {
      const ok = $("[data-ok]", el);
      busy(ok, true, "Сохранение…");
      try {
        const activate = $("#sv-activate", el).checked;
        const saved = await api.saveChecklist(cfg, $("#sv-note", el).value.trim() || null, activate, sourceAppealId);
        draft = null; base = null; // not dirty any more
        toast(`Сохранено: ${saved.name} v${saved.version}`);
        if (returnToDialog) location.hash = returnToDialog(saved.id);
        else {
          location.hash = `#/checklists/${saved.id}`;
          if (!suggestionAppeals.length) {
            setTimeout(() => applyDialog({ id: saved.id, version: saved.version, config: saved.config || cfg, is_active: activate }, { justSaved: true }), 0);
          }
        }
      } finally { busy(ok, false); }
    },
  });
  m.el.querySelector(".modal").classList.add("modal-wide");
}

/* ------------------------------------------------------------ apply ---- */

async function applyDialog(cl, { justSaved = false } = {}) {
  let groups = [], cost = null;
  try {
    [groups, cost] = await Promise.all([
      api.groups(),
      api.stats({}).then((s) => s.avg_cost_usd).catch(() => null),
    ]);
  } catch (e) { toast(e.message, true); return; }
  const last = store.get("cqa.group");
  const name = cl.config?.name || "";
  const m = modal({
    title: justSaved ? `Версия v${cl.version} сохранена` : `Применить «${name} v${cl.version}»`,
    submitText: "Оценить диалоги",
    cancelText: justSaved ? "Позже" : "Отмена",
    body: `
      ${justSaved ? `<div class="success-head">${icon("done")}<div><b>«${esc(name)}» v${esc(cl.version)}${cl.is_active ? " сохранён и активирован" : " сохранён"}.</b><br><span class="small">Примените версию к набору — диалоги будут оценены по новому чек-листу.</span></div></div>` : ""}
      ${groups.length ? `
        <label class="field">Набор диалогов
          <select class="input" id="ap-group">
            <option value="__none" selected disabled>— выберите набор —</option>
            ${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.id)} (${g.count})${g.id === last ? " · последний" : ""}</option>`).join("")}
            <option value="">Все наборы</option>
          </select></label>
        <label class="check"><input type="checkbox" id="ap-missing" checked> Только диалоги без оценки этой версией</label>
        <dl class="cost-list" id="ap-est" aria-live="polite"></dl>
        <div class="note">Оценка идёт в фоне, прогресс и стоимость видны на странице «Диалоги». Предыдущие оценки сохраняются.</div>`
        : `<div class="note warn">Наборов пока нет — сначала импортируйте диалоги на странице «Диалоги».</div>`}`,
    onSubmit: async (el) => {
      if (!groups.length) { location.hash = "#/conversations"; return; }
      const gv = $("#ap-group", el).value;
      if (gv === "__none") { toast("Выберите набор диалогов", true); $("#ap-group", el).focus(); return false; }
      const group = gv || null;
      const ok = $("[data-ok]", el);
      busy(ok, true, "Запуск…");
      try {
        const b = await api.batch({ group, checklist_id: cl.id, only_missing: $("#ap-missing", el).checked });
        if (!b.total) { toast("Нет диалогов для оценки — все уже оценены этой версией"); return false; }
        store.set("cqa.batch", String(b.id));
        if (group) store.set("cqa.group", group);
        toast(`Запущена оценка ${b.total} ${plural(b.total, ["диалога", "диалогов", "диалогов"])} по v${cl.version}`);
        location.hash = "#/conversations";
      } finally { busy(ok, false); }
    },
  });
  if (!groups.length) { const ok = $("[data-ok]", m.el); ok.textContent = "К диалогам"; return; }
  const est = $("#ap-est", m.el);
  let seq = 0;
  async function estimate() {
    const my = ++seq;
    if ($("#ap-group", m.el).value === "__none") { est.innerHTML = `<dt>Будет оценено</dt><dd class="muted">выберите набор</dd>`; return; }
    est.innerHTML = `<dt>Будет оценено</dt><dd><span class="spinner" aria-hidden="true"></span></dd>`;
    try {
      const rows = await api.conversations({ group: $("#ap-group", m.el).value || null, checklist_id: cl.id });
      if (my !== seq) return;
      const n = $("#ap-missing", m.el).checked ? rows.filter((r) => !r.eval_id || r.status === "error").length : rows.length;
      const okBtn = $("[data-ok]", m.el);
      if (okBtn && !okBtn.disabled) okBtn.textContent = n ? `Оценить ${n} ${plural(n, ["диалог", "диалога", "диалогов"])}` : "Оценить диалоги";
      est.innerHTML = `<dt>Будет оценено</dt><dd>${n} ${plural(n, ["диалог", "диалога", "диалогов"])}</dd>
        ${cost && n ? `<dt>Ориентировочная стоимость</dt><dd>≈ $${fmtNum(cost * n, 3)}</dd>` : ""}`;
    } catch { if (my === seq) est.innerHTML = ""; }
  }
  $("#ap-group", m.el).addEventListener("change", estimate);
  $("#ap-missing", m.el).addEventListener("change", estimate);
  estimate();
}

/* ------------------------------------------------------------- JSON ---- */

function jsonDialog(page, current) {
  const fname = `${(draft.name || "checklist").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}${current.version ? `-v${current.version}` : ""}.json`;
  const m = modal({
    title: "Конфигурация в JSON",
    submitText: "Загрузить в редактор",
    body: `
      <div class="row">
        <button class="btn btn-sm" type="button" data-j="download">${icon("download")}Скачать .json</button>
        <button class="btn btn-sm" type="button" data-j="copy">${icon("copy")}Копировать</button>
        <label class="btn btn-sm" style="position:relative">${icon("upload")}Открыть файл…<input type="file" accept=".json,application/json" id="js-file" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>
      </div>
      <label class="field"><span class="sr-only">JSON</span><textarea class="input mono" id="js-text" rows="18" spellcheck="false">${esc(JSON.stringify(draft, null, 2))}</textarea></label>
      <div class="muted small">Изменённый JSON загружается в редактор как черновик — затем проверьте разницу и сохраните новую версию.</div>`,
    onSubmit: (el) => {
      let parsed;
      try { parsed = JSON.parse($("#js-text", el).value); } catch (e) { throw new Error("Некорректный JSON: " + e.message); }
      if (!parsed || !Array.isArray(parsed.criteria)) throw new Error("В JSON нет массива criteria");
      parsed.sections ||= [];
      draft = parsed;
      openSet = new Set(); newSet = new Set();
      drawEditor($("#editor", page));
      toast("JSON загружен в редактор — проверьте изменения и сохраните версию");
    },
  });
  m.el.querySelector(".modal").classList.add("modal-wide");
  const ta = $("#js-text", m.el);
  m.el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-j]");
    if (!b) return;
    if (b.dataset.j === "download") {
      const url = URL.createObjectURL(new Blob([ta.value], { type: "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: fname });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (b.dataset.j === "copy") {
      try { await navigator.clipboard.writeText(ta.value); toast("JSON скопирован"); }
      catch { ta.select(); toast("Не удалось скопировать автоматически — текст выделен, нажмите Ctrl+C", true); }
    }
  });
  $("#js-file", m.el).addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) ta.value = await f.text();
  });
}
