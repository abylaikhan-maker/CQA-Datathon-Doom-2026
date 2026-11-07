import { api } from "../api.js";
import { esc, $, $$, fmtNum, fmtDate, toast, busy, modal, TYPE_LABEL } from "../util.js";

let draft = null;

export async function render(root, params) {
  const list = await api.checklists();
  let current;
  if (params.id === "new") {
    current = { id: null, config: blankConfig(), version: null, is_active: false };
  } else {
    const id = params.id ? Number(params.id) : (list.find((c) => c.is_active) || list[0])?.id;
    current = id ? await api.checklist(id) : { id: null, config: blankConfig() };
  }
  draft = structuredClone(current.config);

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Чек-листы</h1><div class="sub">Каждое сохранение создаёт новую версию. Старые оценки остаются привязаны к своей версии.</div></div>
      <div class="spacer"></div>
      <a class="btn" href="#/checklists/new">+ Новый чек-лист</a>
    </div>
    <div class="cl-grid">
      <section class="card">
        <div class="card-head"><h2>Версии</h2></div>
        ${list.map((c) => `
          <div class="cl-item ${c.id === current.id ? "sel" : ""}" data-id="${c.id}">
            <div class="row"><b class="grow">${esc(c.name)}</b>${c.is_active ? `<span class="badge yes">активный</span>` : ""}</div>
            <div class="muted small">v${c.version} · ${c.criteria_count} критериев · ${c.evaluations} оценок · ${fmtDate(c.created_at)}</div>
            ${c.note ? `<div class="small">${esc(c.note)}</div>` : ""}
          </div>`).join("") || `<div class="empty">Нет чек-листов</div>`}
      </section>
      <section>
        <div class="card" style="margin-bottom:16px">
          <div class="card-head">
            <h2>${current.id ? `${esc(current.config.name)} · v${current.version}` : "Новый чек-лист"}</h2>
            ${current.is_active ? `<span class="badge yes">активный</span>` : ""}
            <div class="spacer"></div>
            ${current.id && !current.is_active ? `<button class="btn btn-sm" id="btn-activate">Сделать активным</button>` : ""}
            ${current.id ? `<button class="btn btn-sm" id="btn-apply">Применить к набору…</button>` : ""}
            <button class="btn btn-sm" id="btn-json">JSON</button>
          </div>
          <div class="card-pad" id="editor"></div>
        </div>
      </section>
    </div>`;

  $$(".cl-item", root).forEach((el) => el.addEventListener("click", () => (location.hash = `#/checklists/${el.dataset.id}`)));
  $("#btn-activate", root)?.addEventListener("click", async () => {
    await api.activateChecklist(current.id);
    toast("Чек-лист активирован — он будет выбран по умолчанию для новых оценок");
    render(root, params);
  });
  $("#btn-apply", root)?.addEventListener("click", () => applyDialog(current));
  $("#btn-json", root).addEventListener("click", () => jsonDialog(root));

  const editor = $("#editor", root);
  drawEditor(editor);
  editor.addEventListener("input", (e) => onInput(e, editor));
  editor.addEventListener("change", (e) => onInput(e, editor, true));
  editor.addEventListener("click", (e) => onClick(e, editor, root, current));
}

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

function totalWeight() {
  return draft.criteria.filter((c) => c.type !== "critical").reduce((s, c) => s + Number(c.weight || 0), 0);
}

function drawEditor(el) {
  const tw = totalWeight();
  el.innerHTML = `
    <div class="ed-crit-body" style="padding:0 0 14px">
      <label class="field span3">Название<input class="input" data-k="name" value="${esc(draft.name)}"></label>
      <label class="field">Округление<input class="input" type="number" min="0" max="4" data-k="rounding" value="${esc(draft.rounding ?? 2)}"></label>
      <div class="field span2"><span>Сумма весов: <b>${fmtNum(tw)}</b> ${tw !== 100 ? `<span class="badge warn" title="Итог всё равно нормируется к 100">≠ 100</span>` : `<span class="badge yes">= 100</span>`}</span>
        <div class="weights-bar" title="Доли весов">${draft.criteria.filter((c) => c.type !== "critical" && c.weight > 0).map((c) => `<i style="flex:${c.weight}" title="${esc(c.code)} ${esc(c.title)}: ${c.weight}"></i>`).join("")}</div></div>
      <label class="field span6">Общие правила для оценщика (контекст для модели)
        <textarea class="input" rows="3" data-k="general_rules">${esc(draft.general_rules || "")}</textarea></label>
    </div>
    <h3>Секции</h3>
    <div style="margin-bottom:14px">
      ${draft.sections.map((s, i) => `
        <div class="scale-row" style="grid-template-columns:140px 1fr auto">
          <input class="input mono" data-k="sections.${i}.id" value="${esc(s.id)}" placeholder="id">
          <input class="input" data-k="sections.${i}.title" value="${esc(s.title)}" placeholder="Название секции">
          <button class="btn btn-sm btn-ghost btn-danger" data-act="del-section" data-i="${i}" title="Удалить секцию">✕</button>
        </div>`).join("")}
      <button class="btn btn-sm" data-act="add-section">+ Секция</button>
    </div>
    <h3>Критерии (${draft.criteria.length})</h3>
    ${draft.criteria.map((c, i) => critEditor(c, i)).join("")}
    <div class="row" style="margin-top:6px">
      <button class="btn" data-act="add-crit">+ Добавить критерий</button>
      <div class="spacer grow"></div>
      <input class="input" id="save-note" placeholder="Комментарий к версии (что изменено)" style="max-width:320px">
      <label class="check small"><input type="checkbox" id="save-activate" checked> сделать активным</label>
      <button class="btn btn-primary" data-act="save">Сохранить новую версию</button>
    </div>`;
}

function critEditor(c, i) {
  const k = (f) => `criteria.${i}.${f}`;
  return `
    <div class="ed-crit">
      <div class="ed-crit-head">
        <b class="mono">${esc(c.code || "")}</b><b class="grow">${esc(c.title || "Без названия")}</b>
        <span class="badge">${esc(TYPE_LABEL[c.type])}</span>
        <button class="btn btn-sm btn-ghost" data-act="up" data-i="${i}" title="Выше" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="btn btn-sm btn-ghost" data-act="down" data-i="${i}" title="Ниже" ${i === draft.criteria.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn btn-sm btn-ghost btn-danger" data-act="del-crit" data-i="${i}" title="Удалить критерий">Удалить</button>
      </div>
      <div class="ed-crit-body">
        <label class="field">Код<input class="input" data-k="${k("code")}" value="${esc(c.code || "")}"></label>
        <label class="field">ID<input class="input mono" data-k="${k("id")}" value="${esc(c.id)}"></label>
        <label class="field span2">Название<input class="input" data-k="${k("title")}" value="${esc(c.title)}"></label>
        <label class="field span2">Секция
          <select class="input" data-k="${k("section")}">
            <option value="">—</option>
            ${draft.sections.map((s) => `<option value="${esc(s.id)}" ${s.id === c.section ? "selected" : ""}>${esc(s.title)}</option>`).join("")}
          </select></label>
        <label class="field span2">Тип ответа
          <select class="input" data-k="${k("type")}" data-redraw>
            ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${v === c.type ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
        <label class="field">Вес<input class="input" type="number" min="0" step="0.5" data-k="${k("weight")}" data-redraw value="${c.type === "critical" ? 0 : esc(c.weight)}" ${c.type === "critical" ? "disabled" : ""}></label>
        <label class="field" style="justify-content:flex-end"><span class="check"><input type="checkbox" data-k="${k("na_allowed")}" data-redraw ${c.na_allowed ? "checked" : ""}> N/A разрешён</span></label>
        <label class="field span6">Формулировка / что значит «Да»
          <textarea class="input" rows="2" data-k="${k("description")}">${esc(c.description || "")}</textarea></label>
        <label class="field span6">Уточнения для оценки (памятка для модели: пограничные случаи, что не считать нарушением)
          <textarea class="input" rows="3" data-k="${k("guidance")}">${esc(c.guidance || "")}</textarea></label>
        ${c.na_allowed ? `<label class="field span6">Условие N/A<input class="input" data-k="${k("na_condition")}" value="${esc(c.na_condition || "")}"></label>` : ""}
        ${c.type === "scale" ? `
          <div class="field span6"><span>Шкала (верхняя ступень даёт полный вес)</span>
            ${(c.scale || []).map((s, j) => `
              <div class="scale-row">
                <input class="input" type="number" step="any" data-k="${k(`scale.${j}.value`)}" value="${esc(s.value)}" placeholder="балл">
                <input class="input" data-k="${k(`scale.${j}.description`)}" value="${esc(s.description)}" placeholder="Описание ступени">
                <button class="btn btn-sm btn-ghost btn-danger" data-act="del-step" data-i="${i}" data-j="${j}">✕</button>
              </div>`).join("")}
            <div><button class="btn btn-sm" data-act="add-step" data-i="${i}">+ Ступень</button></div>
          </div>` : ""}
      </div>
    </div>`;
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts.at(-1)] = value;
}

function onInput(e, editor, isChange = false) {
  const t = e.target;
  if (!t.dataset.k) return;
  let v = t.type === "checkbox" ? t.checked : t.value;
  if (t.type === "number") v = v === "" ? 0 : Number(v);
  setPath(draft, t.dataset.k, v);
  if (t.dataset.k.endsWith(".type")) {
    const i = Number(t.dataset.k.split(".")[1]);
    const c = draft.criteria[i];
    if (v === "scale" && !(c.scale || []).length) c.scale = [{ value: 10, description: "" }, { value: 5, description: "" }, { value: 0, description: "" }];
    if (v === "critical") { c.weight = 0; c.na_allowed = false; }
  }
  if (isChange && t.dataset.redraw !== undefined) drawEditor(editor);
}

async function onClick(e, editor, root, current) {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const i = Number(b.dataset.i);
  switch (b.dataset.act) {
    case "add-crit": draft.criteria.push(newCriterion()); break;
    case "del-crit":
      if (!confirm(`Удалить критерий «${draft.criteria[i].title || draft.criteria[i].id}»?`)) return;
      draft.criteria.splice(i, 1); break;
    case "up": [draft.criteria[i - 1], draft.criteria[i]] = [draft.criteria[i], draft.criteria[i - 1]]; break;
    case "down": [draft.criteria[i + 1], draft.criteria[i]] = [draft.criteria[i], draft.criteria[i + 1]]; break;
    case "add-step": (draft.criteria[i].scale ||= []).push({ value: 0, description: "" }); break;
    case "del-step": draft.criteria[i].scale.splice(Number(b.dataset.j), 1); break;
    case "add-section": draft.sections.push({ id: `s${draft.sections.length + 1}`, title: "" }); break;
    case "del-section": draft.sections.splice(i, 1); break;
    case "save": return save(b, root);
  }
  drawEditor(editor);
}

async function save(btn, root) {
  busy(btn, true, "Сохранение…");
  try {
    const saved = await api.saveChecklist(draft, $("#save-note", root).value.trim() || null, $("#save-activate", root).checked);
    toast(`Сохранено: ${saved.name} v${saved.version}`);
    location.hash = `#/checklists/${saved.id}`;
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy(btn, false);
  }
}

async function applyDialog(current) {
  const groups = await api.groups();
  modal({
    title: `Применить «${current.config.name} v${current.version}»`,
    submitText: "Запустить оценку",
    body: `
      <label class="field">Набор диалогов
        <select class="input" id="ap-group">
          ${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.id)} (${g.count})</option>`).join("")}
          <option value="">Все наборы</option>
        </select></label>
      <label class="check"><input type="checkbox" id="ap-missing" checked> только диалоги без оценки этой версией</label>
      <div class="muted small">Оценка идёт в фоне; прогресс виден на странице «Диалоги».</div>`,
    onSubmit: async (el) => {
      const group = $("#ap-group", el).value || null;
      const b = await api.batch({ group, checklist_id: current.id, only_missing: $("#ap-missing", el).checked });
      if (!b.total) { toast("Нет диалогов для оценки"); return; }
      localStorage.setItem("cqa.batch", b.id);
      if (group) localStorage.setItem("cqa.group", group);
      toast(`Запущена оценка ${b.total} диалогов`);
      location.hash = "#/conversations";
    },
  });
}

function jsonDialog(root) {
  modal({
    title: "Конфигурация в JSON",
    submitText: "Применить к редактору",
    body: `<textarea class="input mono" id="js-text" rows="20">${esc(JSON.stringify(draft, null, 2))}</textarea>
      <div class="muted small">Можно скопировать или вставить конфигурацию. Сохраните затем как новую версию.</div>`,
    onSubmit: (el) => {
      const parsed = JSON.parse($("#js-text", el).value);
      if (!Array.isArray(parsed.criteria)) throw new Error("Нет массива criteria");
      parsed.sections ||= [];
      draft = parsed;
      drawEditor($("#editor", root));
    },
  });
}
