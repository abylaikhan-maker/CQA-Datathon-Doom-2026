// «Правила из апелляций»: the checklist learns from reviewer decisions.
// When reviewers changed the model's answer for one criterion in N different conversations
// (appeal status «changed»), Gemini proposes an addition to that criterion's guidance.
// The addition is saved as a new checklist version (not active), checked on control
// examples (#/checklists/<id>/rule-check) and only then switched on.
import { api } from "../api.js";
import { esc, $, toast, busy, plural, icon, answerView, fmtDate } from "../util.js";

const DRAFT_KEY = "cqa.ruleDraft"; // hand-off to the checklist editor (views/checklists.js)
const forms = {
  conv: ["диалог", "диалога", "диалогов"],
  crit: ["критерий", "критерия", "критериев"],
  case: ["исправление", "исправления", "исправлений"],
};

export async function render(root, params, query) {
  const list = await api.checklists();
  if (!root.isConnected) return;
  if (!list.length) {
    root.innerHTML = `${head()}<div class="card empty-state"><h3>Чек-листов пока нет</h3><p>Создайте чек-лист и оцените диалоги.</p>
      <a class="btn btn-primary" href="#/checklists/new">Новый чек-лист</a></div>`;
    return;
  }
  // Suggestions are computed per version (cases come from evaluations made with that version).
  const results = await Promise.all(list.map((c) => api.ruleSuggestions(c.id).catch(() => ({ minimum_cases: 2, items: [] }))));
  if (!root.isConnected) return;
  const byId = new Map(list.map((c, i) => [c.id, { ...c, s: results[i] }]));
  const ready = (v) => v.s.items.filter((it) => it.case_count >= v.s.minimum_cases).length;
  const withCases = list.map((c) => byId.get(c.id)).filter((v) => v.s.items.length);
  const pick = byId.get(Number(query.v))
    || [...withCases].sort((a, b) => ready(b) - ready(a) || b.version - a.version)[0]
    || byId.get((list.find((c) => c.is_active) || list[0]).id);

  root.innerHTML = `<div class="rl-page">
    ${head()}
    <ol class="rl-flow" aria-label="Как это работает">
      <li><b>Апелляция</b><span>Проверяющий меняет ответ модели и пишет причину</span></li>
      <li><b>Повторяемость</b><span>По критерию набирается ${pick.s.minimum_cases}+ разных ${plural(pick.s.minimum_cases, forms.conv)}</span></li>
      <li><b>Предложение</b><span>Gemini формулирует общее уточнение к инструкции критерия</span></li>
      <li><b>Новая версия</b><span>Уточнение сохраняется в новой версии, текущая не меняется</span></li>
      <li><b>Проверка</b><span>Сравнение версий на контрольных примерах, затем включение</span></li>
    </ol>
    <div class="rl-tools">
      <label class="field">Версия чек-листа, по оценкам которой собраны апелляции
        <select class="input" id="rl-version">
          ${list.map((c) => {
            const v = byId.get(c.id);
            const n = v.s.items.length, r = ready(v);
            return `<option value="${c.id}" ${c.id === pick.id ? "selected" : ""}>${esc(c.name)} · v${c.version}${c.is_active ? " (активная)" : ""} — ${n ? `${n} ${plural(n, forms.crit)} с исправлениями${r ? `, готово: ${r}` : ""}` : "исправлений нет"}</option>`;
          }).join("")}
        </select></label>
    </div>
    <div id="rl-body"></div>
  </div>`;
  $("#rl-version", root).addEventListener("change", (e) => { location.hash = `#/rules?v=${e.target.value}`; });
  await drawVersion($("#rl-body", root), pick, list);
}

const head = () => `
  <header class="page-head">
    <div><h1>Правила из апелляций</h1>
      <div class="sub">Чек-лист дообучается на решениях проверяющих: если ответ модели по критерию исправляли в нескольких разных диалогах, Gemini предлагает дополнить инструкцию этого критерия. Учитываются только апелляции, где оценка изменена и указана причина.</div></div>
    <div class="spacer"></div>
    <div class="page-actions"><a class="btn" href="#/appeals">К апелляциям</a></div>
  </header>`;

async function drawVersion(box, ver, list) {
  const checklist = await api.checklist(ver.id);
  if (!box.isConnected) return;
  const min = ver.s.minimum_cases;
  const items = new Map(ver.s.items.map((it) => [it.criterion_id, it]));
  const crits = checklist.config.criteria;
  const withCases = crits.filter((c) => items.has(c.id));
  const readyCrits = withCases.filter((c) => items.get(c.id).case_count >= min);
  const totalCases = withCases.reduce((s, c) => s + items.get(c.id).case_count, 0);
  const family = list.filter((c) => c.name === checklist.name).sort((a, b) => b.version - a.version);
  const latest = family[0];

  box.innerHTML = `
    <div class="kpis rl-kpis">
      <div class="card kpi"><span class="lbl">${icon("refresh")}Исправлено проверяющими</span><span class="v">${totalCases}</span>
        <span class="foot">${totalCases ? `в ${withCases.length} ${plural(withCases.length, forms.crit)}` : "по оценкам этой версии"}</span></div>
      <div class="card kpi ${readyCrits.length ? "is-good" : ""}"><span class="lbl">${icon("check")}Готово к предложению</span><span class="v">${readyCrits.length}</span>
        <span class="foot">${min}+ разных ${plural(min, forms.conv)} по критерию</span></div>
      <div class="card kpi"><span class="lbl">${icon("clock")}Копят кейсы</span><span class="v">${withCases.length - readyCrits.length}</span>
        <span class="foot">нужно ещё исправление в другом диалоге</span></div>
    </div>
    ${latest.id !== ver.id ? `<div class="note rl-note">Новая версия будет создана на основе последней — <b>v${latest.version}</b>, чтобы не потерять изменения после v${ver.version}.</div>` : ""}
    ${withCases.length ? withCases.map((c) => critCard(c, items.get(c.id), min)).join("")
      : `<div class="card empty-state"><h3>По оценкам v${checklist.version} исправлений пока нет</h3>
          <p>Когда проверяющий изменит ответ модели в апелляции, кейс появится здесь. Выберите другую версию выше или откройте апелляции.</p>
          <a class="btn" href="#/appeals">Открыть апелляции</a></div>`}
    ${crits.length > withCases.length ? `<details class="card rl-rest"><summary>Критерии без исправлений · ${crits.length - withCases.length}</summary>
      <ul>${crits.filter((c) => !items.has(c.id)).map((c) => `<li><span class="cv-code">${esc(c.code || c.id)}</span>${esc(c.title)}</li>`).join("")}</ul></details>` : ""}`;

  box.onclick = async (e) => {
    const sug = e.target.closest("[data-suggest]");
    if (sug) { await suggest(sug, checklist, latest); return; }
    const save = e.target.closest("[data-save]");
    if (save) { await saveVersion(save, checklist, latest, ver); return; }
    const edit = e.target.closest("[data-edit]");
    if (edit) { openInEditor(edit, latest); return; }
    const act = e.target.closest("[data-activate]");
    if (act) {
      busy(act, true, "Включаем…");
      try {
        await api.activateChecklist(Number(act.dataset.activate));
        toast("Версия включена: новые оценки пойдут по ней");
        act.replaceWith(Object.assign(document.createElement("span"), { className: "badge brand", textContent: "активная" }));
      } catch (err) { toast(err.message, true); busy(act, false); }
    }
  };
}

function critCard(c, item, min) {
  const isReady = item.case_count >= min;
  return `<section class="card rl-crit" data-crit="${esc(c.id)}" aria-label="${esc(c.title)}">
    <div class="rl-crit-head">
      <div class="rl-crit-t"><span class="cv-code">${esc(c.code || c.id)}</span><h2>${esc(c.title)}</h2></div>
      <span class="badge ${isReady ? "brand" : "outline"}">${isReady
        ? `${item.case_count} ${plural(item.case_count, forms.conv)} — готово`
        : `${item.case_count} из ${min} ${plural(min, forms.conv)}`}</span>
      <div class="spacer"></div>
      ${isReady ? `<button type="button" class="btn btn-primary btn-sm" data-suggest="${esc(c.id)}">${icon("refresh")}Предложить уточнение</button>` : ""}
    </div>
    <details class="rl-guidance"${c.guidance ? "" : " open"}>
      <summary>Действующая инструкция к критерию</summary>
      <p>${c.guidance ? esc(c.guidance) : '<span class="muted">Уточнений пока нет — только описание критерия.</span>'}</p>
      ${c.description ? `<p class="muted small">${esc(c.description)}</p>` : ""}
    </details>
    <div class="rl-cases-h">Решения проверяющих</div>
    <ul class="rl-cases">${item.cases.map((k) => `
      <li>
        <div class="rl-case-meta">
          <a href="#/appeals/${k.appeal_id}">Апелляция #${k.appeal_id}</a>
          <a class="mono" href="#/conversation/${encodeURIComponent(k.conversation_id)}?crit=${encodeURIComponent(c.id)}">${esc(k.conversation_id)}</a>
          <span class="rl-ans"><s>${esc(answerView(c, k.model_answer).label)}</s>${icon("chev")}<b>${esc(answerView(c, k.reviewer_answer).label)}</b></span>
        </div>
        <p>${esc(k.reason)}</p>
      </li>`).join("")}</ul>
    <div class="rl-proposal" data-proposal hidden></div>
  </section>`;
}

async function suggest(btn, checklist, latest) {
  const card = btn.closest(".rl-crit");
  const out = $("[data-proposal]", card);
  const cid = btn.dataset.suggest;
  busy(btn, true, "Gemini готовит предложение…");
  try {
    const p = await api.suggestRule(checklist.id, cid);
    if (!card.isConnected) return;
    out.hidden = false;
    out.dataset.appeals = p.appeal_ids.join(",");
    const links = p.appeal_ids.map((id) => `<a href="#/appeals/${id}">#${id}</a>`).join(", ");
    out.innerHTML = p.addition ? `
      <div class="rl-proposal-h">${icon("refresh")}<b>Предложение Gemini</b><span class="muted small">по апелляциям ${links}</span></div>
      <p class="rl-why">${esc(p.reason)}</p>
      <label class="field">Дополнение к инструкции — можно отредактировать
        <textarea class="input" rows="4" data-addition>${esc(p.addition)}</textarea></label>
      <div class="rl-actions">
        <button type="button" class="btn btn-primary" data-save="${esc(cid)}">${icon("check")}Сохранить как v${latest.version + 1}</button>
        <button type="button" class="btn" data-edit="${esc(cid)}">${icon("list")}Открыть в редакторе</button>
        <span class="muted small">Текущая версия не изменится, новая не включается автоматически.</span>
      </div>`
      : `<div class="rl-proposal-h">${icon("info")}<b>Gemini не предлагает изменений</b><span class="muted small">по апелляциям ${links}</span></div>
         <p class="rl-why">${esc(p.reason)}</p>`;
    $("[data-addition]", out)?.focus();
  } catch (err) {
    toast(err.message, true);
  } finally {
    busy(btn, false);
  }
}

function proposalOf(btn) {
  const out = btn.closest("[data-proposal]");
  return {
    cid: btn.dataset.save || btn.dataset.edit,
    addition: $("[data-addition]", out).value.trim(),
    appeals: out.dataset.appeals.split(",").filter(Boolean).map(Number),
    out,
  };
}

async function saveVersion(btn, checklist, latest, ver) {
  const { cid, addition, appeals, out } = proposalOf(btn);
  if (!addition) { toast("Дополнение пустое", true); return; }
  busy(btn, true, "Сохраняем…");
  try {
    const base = latest.id === checklist.id ? checklist : await api.checklist(latest.id);
    const cfg = structuredClone(base.config);
    const crit = cfg.criteria.find((c) => c.id === cid);
    if (!crit) throw new Error(`В v${base.version} нет этого критерия — откройте редактор и добавьте уточнение вручную.`);
    crit.guidance = [crit.guidance?.trim(), addition].filter(Boolean).join("\n\n");
    const note = `Уточнение ${crit.code || crit.id} по апелляциям ${appeals.map((a) => `#${a}`).join(", ")} (предложение Gemini)`;
    const saved = await api.saveChecklist(cfg, note.slice(0, 300), false, appeals[0] || null);
    toast(`Сохранено: ${saved.name} v${saved.version}`);
    const rc = new URLSearchParams({ baseline: ver.id, criterion: cid });
    out.innerHTML = `
      <div class="rl-done">
        <div class="rl-proposal-h">${icon("check")}<b>Создана версия v${saved.version}</b><span class="muted small">${esc(fmtDate(saved.created_at))} · пока не активна</span></div>
        <p class="rl-why">Перед включением сравните v${ver.version} и v${saved.version} на контрольных примерах по этому критерию — диалогам, где правильный ответ известен.</p>
        <div class="rl-actions">
          <a class="btn btn-primary" href="#/checklists/${saved.id}/rule-check?${rc}">${icon("check")}Проверить правило</a>
          <button type="button" class="btn" data-activate="${saved.id}">Сделать активной</button>
          <a class="btn btn-ghost" href="#/checklists/${saved.id}">Открыть v${saved.version}</a>
        </div>
      </div>`;
  } catch (err) {
    toast(err.message, true);
    busy(btn, false);
  }
}

function openInEditor(btn, latest) {
  const { cid, addition, appeals } = proposalOf(btn);
  if (!addition) { toast("Дополнение пустое", true); return; }
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ checklistId: latest.id, criterionId: cid, addition, appeals }));
  } catch { /* the editor simply opens without the draft */ }
  location.hash = `#/checklists/${latest.id}`;
}
