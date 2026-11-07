// Ground-truth verification: 1–2 people check / correct the draft labels of a
// fixed sample of DEV dialogs. Work is kept in localStorage (per browser) and
// saved as a new ground-truth version that overlays only the reviewed dialogs
// onto the latest version, so sequential saves by two reviewers merge.
import { api } from "../api.js";
import { esc, toast, confirmDialog, modal, busy, plural, icon, CHANNEL, TYPE_LABEL, fmtDate } from "../util.js";
import { transcriptHtml, bindRuns } from "../card/transcript.js";
import { cvIcon } from "../card/icons.js";

const GROUP = "DEV";
const KEY = `cqa.verify.${GROUP}.v1`;
/** Fixed stratified random sample (language × channel). */
export const SAMPLE = [
  "p1-ru-004", "p1-ru-008", "p1-ru-011", "p1-ru-017", "p1-ru-020", "p1-ru-021", "p1-ru-028", "p1-ru-030",
  "p1-kz-007", "p1-kz-009", "p1-kz-010", "p1-kz-014", "p1-kz-015",
  "p1-en-008", "p1-en-012", "p1-en-013", "p1-en-014",
  "p4-ru-001", "p4-ru-004", "p4-ru-005",
];
const STATUS = { todo: "не проверен", wip: "в работе", ok: "подтверждён", fixed: "исправлен" };

let current = null;
/** Same path, new ?id= — switch dialog in place. */
export function onQuery(q) { if (current) current.select(q.id); }

const nowIso = () => new Date().toISOString();
const isUnderscore = (k) => k.startsWith("_");

function blankState() {
  return { reviewer: "", hideDraft: true, items: {}, knownGt: null, lastSave: null, lastId: null };
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && typeof s === "object" && s.items) return { ...blankState(), ...s };
  } catch { /* ignore */ }
  return blankState();
}

export async function render(root, params, query) {
  const [active, versions, convList, me] = await Promise.all([
    api.activeChecklist(),
    api.groundTruth(),
    api.conversations({ group: GROUP }).catch(() => []),
    api.me().catch(() => ({})),
  ]);
  const crits = (active && active.config && active.config.criteria) || [];
  const cfg = active.config || {};
  const convMeta = Object.fromEntries((convList || []).map((c) => [c.id, c]));
  const gtList = (versions || []).filter((v) => v.dataset_group === GROUP).sort((a, b) => b.version - a.version);

  if (!gtList.length) {
    root.innerHTML = `
      <div class="page-head"><div><div class="crumbs"><a href="#/accuracy">Точность</a> / Проверка эталона</div><h1>Проверка эталона</h1></div></div>
      <div class="card empty-state">
        <div class="ic">${icon("inbox")}</div>
        <h3>Для набора ${esc(GROUP)} нет эталона</h3>
        <p>Сначала загрузите черновик разметки на вкладке «Точность», затем вернитесь сюда.</p>
        <a class="btn btn-primary" href="#/accuracy">Открыть «Точность»</a>
      </div>`;
    return;
  }

  const verifiedOf = (gt) => (gt && gt.meta && gt.meta._meta && gt.meta._meta.verified) || {};
  let latest = await api.groundTruthGet(gtList[0].id);
  // Baseline for "how wrong was the draft": the newest version nobody has verified yet (the raw draft).
  const baseInfo = gtList.find((v) => !Object.keys((v.meta && v.meta._meta && v.meta._meta.verified) || {}).length) || gtList[gtList.length - 1];
  const baseline = baseInfo.id === latest.id ? latest : await api.groundTruthGet(baseInfo.id);

  const email = me.email || window.CQA_USER || "";
  let st = loadState();
  let storageOk = true;
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(st)); storageOk = true; }
    catch { if (storageOk) toast("Не удалось сохранить прогресс в браузере (localStorage недоступен)", true); storageOk = false; }
  };
  if (!st.knownGt) { st.knownGt = { id: latest.id, version: latest.version }; persist(); }

  const who = () => email || (st.reviewer || "").trim();
  const optionsOf = (c) => {
    const o = [];
    if (c.type === "scale") [...(c.scale || [])].sort((a, b) => b.value - a.value).forEach((s) => o.push({ v: String(s.value), label: String(s.value), title: s.description }));
    else if (c.type === "critical") o.push({ v: "yes", label: "Выявлено", title: "Да — грубая ошибка есть" }, { v: "no", label: "Не выявлено", title: "Нет — грубой ошибки нет" });
    else o.push({ v: "yes", label: "Да" }, { v: "no", label: "Нет" });
    if (c.na_allowed) o.push({ v: "na", label: "N/A", title: c.na_condition || "" });
    return o;
  };
  const valLabel = (c, v) => {
    if (v === undefined || v === null || v === "") return "—";
    if (v === "na") return "N/A";
    if (c.type === "critical") return v === "yes" ? "Выявлено" : v === "no" ? "Не выявлено" : String(v);
    if (c.type === "scale") return String(v);
    return v === "yes" ? "Да" : v === "no" ? "Нет" : String(v);
  };
  const norm = (v) => (v === undefined || v === null ? undefined : String(v).trim().toLowerCase());

  // ---------- per-item helpers ----------
  const item = (id) => st.items[id];
  function ensureItem(id) {
    if (!st.items[id]) {
      const lab = latest.labels[id] || {};
      const draft = {};
      crits.forEach((c) => { if (lab[c.id] !== undefined) draft[c.id] = norm(lab[c.id]); });
      st.items[id] = {
        draft, draftV: latest.version, draftNote: lab._note || "", draftUnc: Array.isArray(lab._uncertain) ? lab._uncertain : [],
        answers: {}, comments: {}, unc: [], revealed: false, confirmedAt: null, savedAt: null,
      };
      persist();
    }
    return st.items[id];
  }
  const eff = (it, cid) => (it.answers[cid] !== undefined ? it.answers[cid] : (!st.hideDraft && !it.confirmedAt ? it.draft[cid] : undefined));
  const answeredCount = (it) => crits.filter((c) => eff(it, c.id) !== undefined).length;
  const allAnswered = (it) => answeredCount(it) === crits.length;
  const isRevealed = (it) => !st.hideDraft || it.revealed || !!it.confirmedAt;
  const changedOf = (it) => crits.filter((c) => eff(it, c.id) !== undefined && eff(it, c.id) !== it.draft[c.id]).map((c) => c.id);
  const statusOf = (id) => {
    const it = item(id);
    if (!it) return "todo";
    if (it.confirmedAt) return changedOf(it).length ? "fixed" : "ok";
    const touched = Object.keys(it.answers).length || Object.values(it.comments || {}).some(Boolean) || (it.unc || []).length;
    return touched ? "wip" : "todo";
  };
  const isUnsaved = (it) => !!(it && it.confirmedAt && (!it.savedAt || it.savedAt < it.confirmedAt));
  const confirmedIds = () => SAMPLE.filter((id) => item(id) && item(id).confirmedAt);

  // ---------- skeleton ----------
  root.innerHTML = `
    <div class="cv-page vf-page">
    <div class="page-head vf-head">
      <div>
        <div class="crumbs"><a href="#/accuracy">Точность</a> / Проверка эталона</div>
        <h1>Проверка эталона</h1>
        <div class="sub">Проверьте разметку ${SAMPLE.length} диалогов набора ${esc(GROUP)}: по ней выбираем модель. Отмечайте свой ответ по каждому критерию, черновик откроется после.</div>
      </div>
      <div class="spacer"></div>
      <div class="vf-head-ctl">
        ${email ? `<span class="vf-who" title="Проверяющий">${icon("check")}${esc(email)}</span>` : `
          <label class="field vf-name"><span>Проверяющий</span>
            <input class="input" id="vf-reviewer" autocomplete="name" placeholder="Имя или почта" value="${esc(st.reviewer)}"></label>`}
        <label class="vf-switch"><input type="checkbox" id="vf-hide" ${st.hideDraft ? "checked" : ""}><span>Скрыть черновик</span></label>
        <button class="btn btn-primary" id="vf-save" type="button">${icon("upload")}<span>Сохранить в эталон</span></button>
      </div>
    </div>
    <div id="vf-banner"></div>
    <div class="card vf-progress" id="vf-progress"></div>
    <div class="vf-grid">
      <nav class="card vf-list" aria-label="Диалоги для проверки"><div class="vf-list-in" id="vf-list"></div></nav>
      <section class="card vf-tr" aria-label="Транскрипт">
        <div class="card-head vf-tr-head" id="vf-tr-head"></div>
        <div id="vf-audio"></div>
        <div class="cv-transcript vf-transcript" id="vf-transcript" tabindex="0" aria-label="Транскрипт диалога"></div>
      </section>
      <section class="card vf-crit-card" aria-label="Критерии">
        <div class="vf-crit-scroll" id="vf-crit"></div>
        <div class="vf-foot" id="vf-foot"></div>
      </section>
    </div>
    <section class="card vf-summary" id="vf-summary" aria-label="Сводка расхождений"></section>
    <div class="vf-live cv-sr" aria-live="polite" id="vf-live"></div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const live = (msg) => { const el = $("#vf-live"); if (el) el.textContent = msg; };
  let curId = null;
  let openCmt = null;
  let selSeq = 0;
  const convCache = new Map();

  // ---------- banner (GT changed since start / last save) ----------
  function paintBanner() {
    const parts = [];
    if (st.knownGt && st.knownGt.id !== latest.id) {
      parts.push(`<div class="vf-note is-warn" role="status">${icon("alert")}<div>Пока вы работали, эталон обновился: <b>v${esc(st.knownGt.version)} → v${esc(latest.version)}</b>${latest.author ? ` (${esc(latest.author)})` : ""}${latest.note ? ` — «${esc(latest.note)}»` : ""}. Сохранение всё равно безопасно: на новую версию накладываются только ваши проверенные диалоги, проверки коллег сохраняются.</div></div>`);
    }
    if (st.lastSave) {
      parts.push(`<div class="vf-note is-ok" role="status">${icon("done")}<div>Последнее сохранение: <b>эталон ${esc(GROUP)} v${esc(st.lastSave.version)}</b> · ${esc(fmtDate(st.lastSave.at))} · ${esc(st.lastSave.n)} ${plural(st.lastSave.n, ["диалог", "диалога", "диалогов"])}, изменено ${esc(st.lastSave.changed)} ${plural(st.lastSave.changed, ["метка", "метки", "меток"])}.</div></div>`);
    }
    $("#vf-banner").innerHTML = parts.join("");
  }

  // ---------- progress ----------
  function paintProgress() {
    const done = confirmedIds();
    const fixed = done.filter((id) => statusOf(id) === "fixed").length;
    const inGt = verifiedOf(latest);
    const unsaved = done.filter((id) => isUnsaved(item(id)) || !inGt[id]).length;
    const changedLabels = done.reduce((n, id) => n + changedOf(item(id)).length, 0);
    const pctDone = Math.round((done.length / SAMPLE.length) * 100);
    const next = unsaved && done.length === SAMPLE.length ? "Все диалоги проверены. Осталось нажать «Сохранить в эталон»."
      : unsaved ? `Проверенные диалоги (${unsaved}) можно сохранить в эталон сейчас или после остальных.`
      : done.length === SAMPLE.length ? "Все диалоги проверены и сохранены."
      : "Отметьте ответ по каждому критерию и нажмите «Подтвердить диалог». Следующий диалог откроется сам.";
    $("#vf-progress").innerHTML = `
      <div class="vf-prog-main"><b class="num-t">${done.length} из ${SAMPLE.length}</b><span class="muted">проверено</span></div>
      <div class="vf-next">${cvIcon(unsaved ? "alert" : done.length === SAMPLE.length ? "check" : "arrowRight")}<span>${esc(next)}</span></div>
      <div class="progress vf-prog-bar" role="progressbar" aria-label="Проверено диалогов" aria-valuemin="0" aria-valuemax="${SAMPLE.length}" aria-valuenow="${done.length}"><i style="width:${pctDone}%"></i></div>
      <div class="vf-prog-stats small">
        <span><i class="vf-dot vf-st-ok"></i>подтверждено ${done.length - fixed}</span>
        <span><i class="vf-dot vf-st-fixed"></i>исправлено ${fixed} (${changedLabels} ${plural(changedLabels, ["метка", "метки", "меток"])})</span>
        <span class="vf-keys muted" title="Клавиши">1–8 — критерий · ←/→ — ответ в критерии или соседний диалог · Ctrl+Enter — подтвердить</span>
        <span class="${unsaved ? "vf-unsaved" : "muted"}">${unsaved ? `не сохранено в эталон: ${unsaved}` : done.length ? "всё сохранено" : "прогресс хранится в этом браузере"}</span>
      </div>`;
    const save = $("#vf-save");
    save.disabled = !unsaved;
    save.classList.toggle("btn-primary", !!unsaved);
    save.title = unsaved ? `Создать новую версию эталона с ${unsaved} проверенными диалогами` : "Нет подтверждённых несохранённых диалогов";
  }

  // ---------- list ----------
  function paintList() {
    const others = verifiedOf(latest);
    $("#vf-list").innerHTML = `
      <div class="vf-list-head">Диалоги <span class="muted num-t">${confirmedIds().length}/${SAMPLE.length}</span></div>
      ${SAMPLE.map((id, i) => {
        const m = convMeta[id];
        const s = statusOf(id);
        const it = item(id);
        const nCh = it && it.confirmedAt ? changedOf(it).length : 0;
        const o = others[id];
        const byOther = o && o.by && o.by !== who() ? o.by : "";
        const isCall = m ? m.channel === "voice call" : false;
        return `
          <a class="vf-item${id === curId ? " is-current" : ""}" href="#/verify?id=${encodeURIComponent(id)}" data-id="${esc(id)}" ${id === curId ? 'aria-current="true"' : ""}>
            <span class="vf-dot vf-st-${s}" aria-hidden="true"></span>
            <span class="vf-item-main">
              <span class="vf-item-id"><span class="vf-idx num-t">${i + 1}.</span> ${esc(id)}</span>
              <span class="vf-item-sub">
                ${m ? `<span class="lang">${esc(m.language)}</span><span class="vf-chan" title="${esc(CHANNEL[m.channel] || m.channel || "")}">${icon(isCall ? "phone" : "chat")}</span>` : `<span class="vf-miss">нет в наборе</span>`}
                <span class="vf-item-st vf-t-${s}" title="Ваша проверка в этом браузере">вы: ${esc(STATUS[s])}${s === "fixed" ? ` · ${nCh}` : ""}${isUnsaved(it) ? ` <span class="vf-unsaved-dot" title="Не сохранено в эталон">●</span>` : ""}</span>
              </span>
              ${byOther ? `<span class="vf-item-other" title="Уже проверено и сохранено в эталоне">в эталоне: проверил(а) ${esc(byOther)}</span>` : ""}
            </span>
          </a>`;
      }).join("")}`;
    const cur = $("#vf-list .is-current");
    if (cur) {
      const box = $("#vf-list").parentElement;
      const b = box.getBoundingClientRect(), r = cur.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - 40;
      if (r.left < b.left || r.right > b.right) box.scrollLeft += r.left - b.left - 40;
    }
  }

  // ---------- transcript ----------
  async function paintTranscript(id, token) {
    const head = $("#vf-tr-head"), tr = $("#vf-transcript"), au = $("#vf-audio");
    const m = convMeta[id] || {};
    head.innerHTML = `
      <h2 class="vf-tr-title">${esc(id)}</h2>
      ${m.language ? `<span class="lang">${esc(m.language)}</span>` : ""}
      ${m.channel ? `<span class="vf-chan">${icon(m.channel === "voice call" ? "phone" : "chat")}${esc(CHANNEL[m.channel] || m.channel)}</span>` : ""}
      ${m.messages ? `<span class="muted small">${m.messages} ${plural(m.messages, ["реплика", "реплики", "реплик"])}</span>` : ""}
      <div class="spacer"></div>
      <a class="btn btn-sm btn-ghost" href="#/conversation/${encodeURIComponent(id)}" target="_blank" rel="noopener">${cvIcon("external")}Открыть разбор<span class="cv-sr"> (в новой вкладке)</span></a>`;
    au.innerHTML = "";
    tr.innerHTML = `<div class="vf-loading muted"><span class="spinner"></span> Загрузка диалога…</div>`;
    let conv = convCache.get(id);
    if (!conv) {
      try { conv = await api.conversation(id); convCache.set(id, conv); }
      catch (e) {
        if (token !== selSeq) return;
        tr.innerHTML = `<div class="vf-loading" role="alert">Не удалось загрузить диалог: ${esc(e.message)}</div>`;
        return;
      }
    }
    if (token !== selSeq) return;
    const isCall = conv.channel === "voice call" || !!conv.audio_url;
    if (isCall) {
      au.innerHTML = `<div class="vf-audio">${icon("phone")}<audio controls preload="none" src="${esc(api.audioUrl(id))}" aria-label="Запись звонка ${esc(id)}"></audio></div>`;
    }
    const msgs = conv.transcript || [];
    tr.innerHTML = msgs.length
      ? transcriptHtml(msgs, { idPrefix: "vf-msg-" })
      : `<div class="vf-loading muted">Транскрипт пуст</div>`;
    bindRuns(tr);
    tr.scrollTop = 0;
  }

  // ---------- criteria ----------
  function critHtml(it, c, idx) {
    const v = eff(it, c.id);
    const rev = isRevealed(it);
    const d = it.draft[c.id];
    const diff = rev && v !== undefined && v !== d;
    const opts = optionsOf(c);
    const tabV = v !== undefined && opts.some((o) => o.v === v) ? v : opts[0].v;
    const sel = c.type === "scale" && v !== undefined && v !== "na" ? (c.scale || []).find((s) => String(s.value) === v) : null;
    const cmt = (it.comments || {})[c.id] || "";
    const showCmt = cmt || diff || openCmt === c.id;
    const unc = (it.unc || []).includes(c.id);
    let mark = "";
    if (rev) {
      if (d === undefined) mark = `<span class="badge outline">в черновике нет</span>`;
      else if (v === undefined) mark = `<span class="badge outline" title="Значение черновика">черновик: ${esc(valLabel(c, d))}</span>`;
      else if (diff) mark = `<span class="badge warn vf-diff-badge" title="Ваш ответ отличается от черновика">≠ черновик: ${esc(valLabel(c, d))}</span>`;
      else mark = `<span class="badge yes" title="Совпадает с черновиком">${icon("check")}как в черновике</span>`;
    } else if (v === undefined) {
      mark = `<span class="badge outline muted">нет ответа</span>`;
    }
    const help = [
      c.description ? `<p>${esc(c.description)}</p>` : "",
      c.na_allowed && c.na_condition ? `<p><b>N/A:</b> ${esc(c.na_condition)}</p>` : !c.na_allowed ? `<p class="muted">N/A не допускается.</p>` : "",
      c.type === "scale" ? `<ul class="vf-scale">${[...(c.scale || [])].sort((a, b) => b.value - a.value).map((s) => `<li><b>${esc(s.value)}</b> — ${esc(s.description)}</li>`).join("")}</ul>` : "",
      c.guidance ? `<div class="vf-guid"><b>Уточнения:</b> ${esc(c.guidance)}</div>` : "",
    ].join("");
    return `
      <section class="vf-c${diff ? " is-diff" : ""}${v === undefined ? " is-empty" : ""}" data-crit="${esc(c.id)}" id="vf-c-${esc(c.id)}">
        <div class="vf-c-head">
          <span class="vf-key" aria-hidden="true" title="Клавиша ${idx + 1}">${idx + 1}</span>
          <div class="vf-c-title"><b>${esc(c.code || c.id)} · ${esc(c.title)}</b><span class="muted small">${esc(TYPE_LABEL[c.type] || c.type)}</span></div>
          <div class="vf-c-mark">${mark}</div>
        </div>
        <div class="vf-seg${c.type === "scale" ? " is-scale" : ""}" role="radiogroup" aria-label="${esc(c.code || c.id)} ${esc(c.title)}">
          ${opts.map((o) => {
            const on = v === o.v;
            const isD = rev && d === o.v;
            return `<button type="button" role="radio" aria-checked="${on}" tabindex="${o.v === tabV ? 0 : -1}"
              class="vf-opt vf-o-${o.v === "yes" ? (c.type === "critical" ? "bad" : "yes") : o.v === "no" ? (c.type === "critical" ? "yes" : "no") : o.v === "na" ? "na" : "sc"}${isD ? " is-draft" : ""}"
              data-c="${esc(c.id)}" data-v="${esc(o.v)}" ${o.title ? `title="${esc(o.title)}"` : ""}>${esc(o.label)}${isD ? `<span class="vf-dmark" title="Значение черновика">ч</span>` : ""}</button>`;
          }).join("")}
        </div>
        ${sel ? `<div class="vf-sel-desc small">${esc(sel.value)} — ${esc(sel.description)}</div>` : ""}
        <div class="vf-c-tools">
          <details class="vf-help"><summary>Правило</summary><div class="vf-help-in">${help}</div></details>
          <label class="check small vf-unc" title="Даже человеку трудно решить — метка будет учтена отдельно как спорная"><input type="checkbox" data-unc="${esc(c.id)}" ${unc ? "checked" : ""}>спорно</label>
          ${rev && it.draftUnc.includes(c.id) ? `<span class="badge warn small" title="Черновик отметил этот критерий как спорный">черновик: спорно</span>` : ""}
          ${showCmt ? "" : `<button type="button" class="btn-link small" data-addcmt="${esc(c.id)}">+ комментарий</button>`}
        </div>
        ${showCmt ? `<input class="input vf-cmt" data-cmt="${esc(c.id)}" maxlength="500" placeholder="${diff ? "Почему не так, как в черновике? (необязательно)" : "Комментарий (необязательно)"}" value="${esc(cmt)}" aria-label="Комментарий к ${esc(c.code || c.id)}">` : ""}
      </section>`;
  }

  function paintCriteria({ keepFocus = true } = {}) {
    if (!curId) return;
    const it = ensureItem(curId);
    const box = $("#vf-crit");
    const ae = document.activeElement;
    const focusSel = keepFocus && ae && box.contains(ae)
      ? (ae.dataset.c ? `[data-c="${ae.dataset.c}"][data-v="${ae.dataset.v}"]` : ae.dataset.cmt ? `[data-cmt="${ae.dataset.cmt}"]` : ae.dataset.unc ? `[data-unc="${ae.dataset.unc}"]` : null)
      : null;
    const rev = isRevealed(it);
    const top = [];
    if (st.hideDraft && !rev) top.push(`<div class="vf-note is-info">${icon("bulb")}<div>Черновик скрыт, чтобы не влиять на вашу оценку. Он откроется, когда вы ответите на все ${crits.length} критериев.</div></div>`);
    if (rev && it.draftNote) top.push(`<div class="vf-note">${icon("list")}<div><b>Заметка черновика:</b> ${esc(it.draftNote)}</div></div>`);
    if (it.confirmedAt) {
      const ch = changedOf(it).length;
      top.push(`<div class="vf-note ${ch ? "is-warn" : "is-ok"}">${icon("done")}<div>${ch ? `Исправлен: изменено ${ch} ${plural(ch, ["метка", "метки", "меток"])}` : "Подтверждён без изменений"} · ${esc(fmtDate(it.confirmedAt))}${isUnsaved(it) ? " · <b>не сохранён в эталон</b>" : " · сохранён"}. Изменение ответа снимет подтверждение.</div></div>`);
    }
    box.innerHTML = top.join("") + crits.map((c, i) => critHtml(it, c, i)).join("");
    if (focusSel) { const el = box.querySelector(focusSel); if (el) el.focus({ preventScroll: true }); }
    paintFoot();
  }

  function paintFoot() {
    const it = item(curId);
    if (!it) return;
    const n = answeredCount(it), total = crits.length;
    const ready = n === total;
    const ch = ready ? changedOf(it).length : 0;
    const rev = isRevealed(it);
    $("#vf-foot").innerHTML = `
      <div class="vf-foot-info small">
        <span class="num-t"><b>${n}</b> из ${total} отвечено${ready || it.confirmedAt ? "" : `, осталось ${total - n}`}</span>
        <span class="vf-foot-bar" aria-hidden="true"><i style="width:${Math.round((n / (total || 1)) * 100)}%"></i></span>
        ${rev && n ? `<span class="${changedOf(it).length ? "vf-t-fixed" : "muted"}">отличий от черновика: ${changedOf(it).length}</span>` : ""}
      </div>
      <div class="vf-foot-btns">
        ${st.hideDraft && !rev ? `<button type="button" class="btn btn-sm btn-ghost" data-act="reveal" title="Открыть черновик, не отвечая на все критерии">Показать черновик</button>` : ""}
        <button type="button" class="btn btn-sm btn-ghost" data-act="clear" ${Object.keys(it.answers).length || it.confirmedAt ? "" : "disabled"}>Очистить</button>
        <button type="button" class="btn btn-primary" data-act="confirm" ${ready ? "" : "disabled"} title="${ready ? "Ctrl+Enter" : `Ответьте на все ${total} критериев`}">
          ${icon("check")}${it.confirmedAt ? "Подтвердить снова" : ch ? `Подтвердить (изменено ${ch})` : "Подтвердить диалог"}</button>
      </div>`;
  }

  // ---------- summary ----------
  function paintSummary() {
    const teamV = verifiedOf(latest);
    const ids = new Set([...Object.keys(teamV), ...confirmedIds()]);
    const base = baseline.labels || {};
    const rows = crits.map((c) => ({ c, n: 0, ch: 0, trans: {} }));
    let dialogsChanged = 0, labelsChanged = 0, labelsTotal = 0;
    const idsArr = [...ids].sort();
    idsArr.forEach((id) => {
      const it = item(id);
      const cur = it && it.confirmedAt ? Object.fromEntries(crits.map((c) => [c.id, eff(it, c.id)])) : (latest.labels[id] || {});
      const b = base[id] || {};
      let any = false;
      rows.forEach((r) => {
        const nv = norm(cur[r.c.id]), ov = norm(b[r.c.id]);
        if (nv === undefined) return;
        r.n++; labelsTotal++;
        if (nv !== ov) {
          r.ch++; labelsChanged++; any = true;
          const k = `${valLabel(r.c, ov)} → ${valLabel(r.c, nv)}`;
          r.trans[k] = (r.trans[k] || 0) + 1;
        }
      });
      if (any) dialogsChanged++;
    });
    const mine = confirmedIds();
    const mineCh = mine.reduce((n, id) => n + changedOf(item(id)).length, 0);
    const reviewers = {};
    Object.values(teamV).forEach((v) => { if (v && v.by) reviewers[v.by] = (reviewers[v.by] || 0) + 1; });
    $("#vf-summary").innerHTML = `
      <div class="card-head"><h2>Сводка: насколько черновик расходится с проверкой</h2><div class="spacer"></div>
        <button type="button" class="btn btn-sm" data-act="export">${icon("download")}Скачать мою проверку (JSON)</button></div>
      <div class="card-pad">
        <p class="small muted vf-sum-lead">Сравнение с исходным черновиком <b>v${esc(baseline.version)}</b>${baseline.meta && baseline.meta._meta && baseline.meta._meta.author ? ` (${esc(baseline.meta._meta.author)})` : ""}.
          Учтены диалоги, уже сохранённые в эталон v${esc(latest.version)} (${Object.keys(teamV).length}), и подтверждённые в этом браузере (${mine.length}; изменено ${mineCh} ${plural(mineCh, ["метка", "метки", "меток"])}).
          ${Object.keys(reviewers).length ? `Проверяли: ${Object.entries(reviewers).map(([k, v]) => `${esc(k)} — ${v}`).join(", ")}.` : ""}</p>
        ${idsArr.length ? `
        <div class="vf-sum-kpis">
          <div><b class="num-t">${idsArr.length}</b><span>${plural(idsArr.length, ["диалог проверен", "диалога проверено", "диалогов проверено"])}</span></div>
          <div><b class="num-t">${dialogsChanged}</b><span>с исправлениями</span></div>
          <div><b class="num-t">${labelsChanged}<small> / ${labelsTotal}</small></b><span>меток изменено</span></div>
          <div><b class="num-t">${labelsTotal ? Math.round(100 - (labelsChanged / labelsTotal) * 100) : "—"}%</b><span>черновик совпал</span></div>
        </div>
        <div class="table-wrap vf-sum-table"><table class="table">
          <thead><tr><th>Критерий</th><th class="num">Проверено</th><th class="num">Изменено</th><th class="num">Доля</th><th>Какие исправления</th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr class="${r.ch ? "vf-row-ch" : ""}">
              <td><b>${esc(r.c.code || r.c.id)}</b> ${esc(r.c.title)}</td>
              <td class="num">${r.n}</td>
              <td class="num">${r.ch ? `<b>${r.ch}</b>` : "0"}</td>
              <td class="num">${r.n ? Math.round((r.ch / r.n) * 100) + "%" : "—"}</td>
              <td class="small">${Object.entries(r.trans).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="vf-tr-chip">${esc(k)}${v > 1 ? ` ×${v}` : ""}</span>`).join(" ") || '<span class="muted">—</span>'}</td>
            </tr>`).join("")}</tbody>
        </table></div>` : `<div class="muted">Пока нет проверенных диалогов.</div>`}
      </div>`;
  }

  const paintAll = () => { paintBanner(); paintProgress(); paintList(); paintCriteria(); paintSummary(); };
  const afterChange = () => { persist(); paintProgress(); paintList(); paintSummary(); };

  // ---------- selection ----------
  function firstOpen(after = null) {
    const start = after ? SAMPLE.indexOf(after) + 1 : 0;
    for (let k = 0; k < SAMPLE.length; k++) {
      const id = SAMPLE[(start + k) % SAMPLE.length];
      if (!(item(id) && item(id).confirmedAt)) return id;
    }
    return null;
  }
  function select(id) {
    if (!id || !SAMPLE.includes(id)) id = (st.lastId && SAMPLE.includes(st.lastId)) ? st.lastId : (firstOpen() || SAMPLE[0]);
    if (id === curId) return;
    curId = id;
    openCmt = null;
    st.lastId = id;
    ensureItem(id);
    persist();
    const token = ++selSeq;
    paintList();
    paintCriteria({ keepFocus: false });
    $("#vf-crit").scrollTop = 0;
    paintTranscript(id, token);
    // Warm up the next dialog so switching feels instant.
    const nx = SAMPLE[(SAMPLE.indexOf(id) + 1) % SAMPLE.length];
    if (!convCache.has(nx)) api.conversation(nx).then((c) => convCache.set(nx, c)).catch(() => {});
  }
  const go = (id) => {
    const h = `#/verify?id=${encodeURIComponent(id)}`;
    if (location.hash !== h) location.hash = h; else select(id);
  };
  const step = (d) => go(SAMPLE[(SAMPLE.indexOf(curId) + d + SAMPLE.length) % SAMPLE.length]);

  // ---------- actions ----------
  function setAnswer(cid, v) {
    const it = ensureItem(curId);
    const wasRevealed = isRevealed(it);
    const prev = eff(it, cid);
    if (prev === v && it.answers[cid] === v) return;
    if (it.confirmedAt) {
      // Freeze the full set first so un-confirming keeps the other answers.
      crits.forEach((c) => { if (it.answers[c.id] === undefined) it.answers[c.id] = eff(it, c.id); });
      if (it.answers[cid] !== v) it.confirmedAt = null;
    }
    it.answers[cid] = v;
    if (st.hideDraft && !it.revealed && allAnswered(it)) {
      it.revealed = true;
      const ch = changedOf(it).length;
      if (!wasRevealed) live(ch ? `Черновик открыт: отличается в ${ch} ${plural(ch, ["критерии", "критериях", "критериях"])}, проверьте их` : "Черновик открыт: всё совпало");
    }
    paintCriteria();
    afterChange();
  }
  function confirmItem() {
    const it = item(curId);
    if (!it || !allAnswered(it)) { toast(`Ответьте на все ${crits.length} критериев`, true); return; }
    crits.forEach((c) => { it.answers[c.id] = eff(it, c.id); });
    it.revealed = true;
    it.confirmedAt = nowIso();
    const ch = changedOf(it).length;
    persist();
    live(`${curId}: ${ch ? `исправлен (${ch} ${plural(ch, ["метка", "метки", "меток"])})` : "подтверждён"}`);
    const nx = firstOpen(curId);
    afterChange();
    if (nx && nx !== curId) go(nx);
    else { paintCriteria(); toast(`Все ${SAMPLE.length} диалогов проверены — нажмите «Сохранить в эталон»`); }
  }

  async function askName() {
    return new Promise((resolve) => {
      let done = false;
      const m = modal({
        title: "Кто проверял?",
        body: `<label class="field">Имя или почта<input class="input" id="vf-name-in" value="${esc(st.reviewer)}" maxlength="80"></label>
               <div class="hint small muted">Будет записано в эталон рядом с каждым проверенным диалогом.</div>`,
        submitText: "Продолжить",
        onSubmit: (el) => {
          const v = el.querySelector("#vf-name-in").value.trim();
          if (!v) { toast("Укажите имя", true); return false; }
          st.reviewer = v; persist();
          const inp = $("#vf-reviewer"); if (inp) inp.value = v;
          done = true; resolve(v);
        },
      });
      const obs = new MutationObserver(() => { if (!m.el.isConnected) { obs.disconnect(); if (!done) resolve(null); } });
      obs.observe(document.body, { childList: true });
    });
  }

  let saving = false;
  async function save() {
    if (saving) return; // one save at a time (double click / Enter on the button)
    saving = true;
    try { await doSave(); } finally { saving = false; }
  }
  async function doSave() {
    const btn = $("#vf-save");
    let by = who();
    if (!by) { by = await askName(); if (!by) return; }
    busy(btn, true, "Сохранение…");
    try {
      // Always overlay onto the freshest version.
      const list = (await api.groundTruth()).filter((v) => v.dataset_group === GROUP).sort((a, b) => b.version - a.version);
      if (!list.length) throw new Error("Эталон для набора не найден");
      const fresh = list[0].id === latest.id ? latest : await api.groundTruthGet(list[0].id);
      const freshV = verifiedOf(fresh);
      const include = confirmedIds().filter((id) => isUnsaved(item(id)) || !freshV[id]);
      if (!include.length) { toast("Нет новых проверенных диалогов для сохранения"); return; }
      const conflicts = include.filter((id) => freshV[id] && freshV[id].by && freshV[id].by !== by);
      const changedTotal = include.reduce((n, id) => n + changedOf(item(id)).length, 0);
      const moved = st.knownGt && st.knownGt.id !== fresh.id;
      busy(btn, false);
      const ok = await confirmDialog({
        title: "Сохранить в эталон",
        okText: `Создать v${fresh.version + 1}`,
        body: `
          <p>Будет создана новая версия эталона <b>${esc(GROUP)} v${fresh.version + 1}</b> на основе последней <b>v${fresh.version}</b>:
            ${include.length} ${plural(include.length, ["проверенный диалог", "проверенных диалога", "проверенных диалогов"])} заменят метки, изменено ${changedTotal} ${plural(changedTotal, ["метка", "метки", "меток"])}. Остальные ${Object.keys(fresh.labels).length - include.length} диалогов и проверки коллег не меняются.</p>
          ${moved ? `<div class="vf-note is-warn">${icon("alert")}<div>С начала вашей проверки эталон обновился: v${esc(st.knownGt.version)} → v${esc(fresh.version)}${fresh.author ? ` (${esc(fresh.author)})` : ""}. Это нормально: ваши диалоги накладываются поверх.</div></div>` : ""}
          ${conflicts.length ? `<div class="vf-note is-warn">${icon("alert")}<div>Эти диалоги уже проверил(а) коллега, ваша разметка их заменит: ${conflicts.map((id) => `<b>${esc(id)}</b> (${esc(freshV[id].by)})`).join(", ")}.</div></div>` : ""}
          <p class="small muted">Проверяющий: ${esc(by)}</p>`,
      });
      if (!ok) return;
      busy(btn, true, "Сохранение…");
      const labels = JSON.parse(JSON.stringify(fresh.labels || {}));
      const verified = { ...freshV };
      include.forEach((id) => {
        const it = item(id);
        const prev = labels[id] || {};
        const keep = Object.fromEntries(Object.entries(prev).filter(([k]) => isUnderscore(k) && k !== "_uncertain"));
        const lab = { ...keep };
        crits.forEach((c) => { lab[c.id] = it.answers[c.id]; });
        if ((it.unc || []).length) lab._uncertain = [...it.unc];
        labels[id] = lab;
        const changed = changedOf(it);
        const comments = Object.fromEntries(Object.entries(it.comments || {}).filter(([, v]) => v && v.trim()).map(([k, v]) => [k, v.trim()]));
        verified[id] = {
          by, at: it.confirmedAt, changed,
          from: Object.fromEntries(changed.map((c) => [c, it.draft[c] === undefined ? null : it.draft[c]])),
          comments, uncertain: [...(it.unc || [])], draft_version: it.draftV,
        };
      });
      const metaKeys = Object.fromEntries(Object.entries(fresh.meta || {}).filter(([k]) => isUnderscore(k)));
      const payload = { ...metaKeys, _meta: { ...((fresh.meta && fresh.meta._meta) || {}), verified }, labels };
      const note = `Ручная проверка: ${include.length} ${plural(include.length, ["диалог", "диалога", "диалогов"])} (изменено ${changedTotal} ${plural(changedTotal, ["метка", "метки", "меток"])}) · ${by}`;
      const res = await api.uploadGroundTruth(GROUP, JSON.stringify(payload), note);
      const at = nowIso();
      include.forEach((id) => { item(id).savedAt = at; });
      st.knownGt = { id: res.id, version: res.version };
      st.lastSave = { version: res.version, id: res.id, at, n: include.length, changed: changedTotal };
      persist();
      latest = await api.groundTruthGet(res.id).catch(() => ({ ...fresh, id: res.id, version: res.version, labels, meta: payload }));
      toast(`Сохранено: эталон ${GROUP} v${res.version} (${res.labels} диалогов)`);
      paintAll();
    } catch (e) {
      toast(`Не удалось сохранить: ${e.message}. Прогресс в браузере не потерян.`, true);
    } finally {
      busy(btn, false);
      paintProgress();
    }
  }

  function exportJson() {
    const data = { group: GROUP, reviewer: who() || null, exported_at: nowIso(), base_version: latest.version, items: st.items };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `verify-${GROUP}-${(who() || "reviewer").replace(/[^\w.-]+/g, "_")}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- events ----------
  root.addEventListener("click", (e) => {
    const opt = e.target.closest(".vf-opt");
    if (opt) { setAnswer(opt.dataset.c, opt.dataset.v); return; }
    const add = e.target.closest("[data-addcmt]");
    if (add) {
      openCmt = add.dataset.addcmt; paintCriteria();
      const inp = root.querySelector(`[data-cmt="${add.dataset.addcmt}"]`); if (inp) inp.focus();
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const a = act.dataset.act;
    if (a === "confirm") confirmItem();
    else if (a === "reveal") { const it = item(curId); it.revealed = true; persist(); paintCriteria(); }
    else if (a === "clear") {
      confirmDialog({ title: "Очистить ответы?", body: `<p>Ответы, комментарии и подтверждение для <b>${esc(curId)}</b> будут сброшены.</p>`, okText: "Очистить", danger: true })
        .then((ok) => {
          if (!ok) return;
          const it = item(curId);
          Object.assign(it, { answers: {}, comments: {}, unc: [], revealed: false, confirmedAt: null });
          paintCriteria(); afterChange();
        });
    } else if (a === "export") exportJson();
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "vf-hide") { st.hideDraft = t.checked; persist(); paintCriteria(); afterChange(); return; }
    if (t.dataset.unc) {
      const it = ensureItem(curId);
      const s = new Set(it.unc || []);
      if (t.checked) s.add(t.dataset.unc); else s.delete(t.dataset.unc);
      it.unc = crits.map((c) => c.id).filter((id) => s.has(id));
      if (it.confirmedAt) it.confirmedAt = nowIso();
      afterChange(); paintCriteria();
    }
  });
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "vf-reviewer") { st.reviewer = t.value; persist(); return; }
    if (t.dataset.cmt) {
      const it = ensureItem(curId);
      it.comments = { ...(it.comments || {}), [t.dataset.cmt]: t.value };
      if (it.confirmedAt) it.confirmedAt = nowIso();
      persist();
      clearTimeout(t._tm);
      t._tm = setTimeout(() => { paintProgress(); paintList(); }, 400);
    }
  });
  $("#vf-save").addEventListener("click", save);

  const onKey = (e) => {
    if (!root.isConnected || document.querySelector(".modal-back")) return;
    const t = e.target;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); confirmItem(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t.closest && t.closest("input, textarea, select, audio, video, [contenteditable]")) return;
    const seg = t.closest && t.closest(".vf-seg");
    if (seg && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const btns = [...seg.querySelectorAll(".vf-opt")];
      let i = btns.indexOf(t.closest(".vf-opt"));
      if (e.key === "Home") i = 0; else if (e.key === "End") i = btns.length - 1;
      else i = (i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + btns.length) % btns.length;
      const b = btns[i];
      setAnswer(b.dataset.c, b.dataset.v);
      const nb = root.querySelector(`.vf-opt[data-c="${b.dataset.c}"][data-v="${b.dataset.v}"]`);
      if (nb) nb.focus();
      return;
    }
    if (/^[1-9]$/.test(e.key) && Number(e.key) <= crits.length) {
      e.preventDefault();
      const c = crits[Number(e.key) - 1];
      const sec = root.querySelector(`#vf-c-${CSS.escape(c.id)}`);
      if (!sec) return;
      const b = sec.querySelector('.vf-opt[tabindex="0"]') || sec.querySelector(".vf-opt");
      sec.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (b) b.focus({ preventScroll: true });
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (t.closest && t.closest(".vf-transcript")) return;
      e.preventDefault();
      step(e.key === "ArrowLeft" ? -1 : 1);
    }
  };
  document.addEventListener("keydown", onKey);

  // Another tab of the same browser saved progress: adopt it.
  const onStorage = (e) => {
    if (e.key !== KEY) return;
    st = loadState();
    paintAll();
  };
  window.addEventListener("storage", onStorage);

  const inst = { select };
  current = inst;
  paintBanner();
  paintProgress();
  paintSummary();
  select(query.id || params.id);

  return () => {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("storage", onStorage);
    root.querySelectorAll("audio").forEach((a) => { try { a.pause(); } catch { /* ignore */ } });
    if (current === inst) current = null;
  };
}
