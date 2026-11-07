// Regulation check on the conversation card: operator promises paired with regulation clauses,
// and a note under each operator message that has a finding. Does not touch the checklist score.
import { api } from "../api.js";
import { esc, $, $$, toast, busy, icon, fmtDate, plural } from "../util.js";

const VERDICT = {
  conflicts: { label: "Расходится с регламентом", short: "Расходится", cls: "is-conflict", icon: "alert" },
  not_covered: { label: "В регламенте нет", short: "Нет в регламенте", cls: "is-none", icon: "doc" },
  matches: { label: "Соответствует регламенту", short: "Соответствует", cls: "is-match", icon: "check" },
};
const ORDER = ["conflicts", "not_covered", "matches"];
const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
/** Clause text without its own leading number ("2.1 Срок…" → "Срок…"); the ref is shown separately. */
export const clauseBody = (clause) => (clause.ref.startsWith("п.")
  ? clause.text.replace(/^\s*(?:п\.\s*|пункт\s+)?\d{1,3}(?:\.\d{1,3})*[.)]?\s+/i, "") : clause.text);

/** Mounts the section into `#cv-reg` and the notes into the transcript. Returns a cleanup function. */
export function mountRegulation({ root, convId, focusMsg }) {
  const host = $("#cv-reg", root);
  const state = { check: null, error: null, running: false };
  let alive = true;

  const draw = () => {
    host.innerHTML = sectionHtml(state);
    annotate(root, state.check);
  };

  host.addEventListener("click", async (e) => {
    const msg = e.target.closest("[data-msg]");
    if (msg) { focusMsg(Number(msg.dataset.msg), { page: true }); return; }
    const run = e.target.closest("[data-reg-run]");
    if (!run || state.running) return;
    state.running = true;
    busy(run, true, "Сверяем…");
    host.classList.add("is-running");
    try {
      state.check = await api.runRegulationCheck(convId);
      state.error = null;
      const n = state.check.counts?.conflicts || 0;
      toast(n ? `Сверка готова: ${n} ${plural(n, ["расхождение", "расхождения", "расхождений"])} с регламентом` : "Сверка готова, расхождений нет");
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.running = false;
      if (alive) { host.classList.remove("is-running"); draw(); }
    }
  });

  // A note under an operator message leads to its finding in the section.
  const onNote = (e) => {
    const note = e.target.closest("[data-reg-finding]");
    if (!note) return;
    const item = $(`#reg-f-${note.dataset.regFinding}`, root);
    if (!item) return;
    item.scrollIntoView({ block: "center", behavior: "smooth" });
    item.classList.remove("is-flash");
    void item.offsetWidth;
    item.classList.add("is-flash");
  };
  const tr = $("#transcript", root);
  tr.addEventListener("click", onNote);

  api.regulationCheck(convId)
    .then((check) => { state.check = check; })
    .catch((err) => { state.error = err.message; })
    .finally(() => { if (alive) draw(); });

  return () => {
    alive = false;
    tr.removeEventListener("click", onNote);
  };
}

function sorted(check) {
  return (check?.findings || [])
    .map((f, i) => ({ ...f, i }))
    .sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || a.turn - b.turn);
}

function sectionHtml({ check, error, running }) {
  const head = (button) => `
    <div class="card-head cv-reg-head">
      <div><h2>${icon("doc")}Сверка с регламентом</h2>
        <p class="cv-reg-sub">Обещания оператора — сроки, суммы, условия — рядом с пунктом регламента. На баллы не влияет.</p></div>
      <div class="spacer"></div>${button}
    </div>`;
  const runBtn = (again) => `<button class="btn ${again ? "" : "btn-primary"}" type="button" data-reg-run>${icon(again ? "refresh" : "doc")}${again ? "Сверить заново" : "Сверить с регламентом"}</button>`;
  const progress = running ? `<p class="cv-reg-progress" role="status">Модель читает регламент и реплики оператора. Обычно это 10–30 секунд.</p>` : "";

  if (error) return `${head("")}<div class="cv-reg-body"><div class="cv-note cv-note-warn">${esc(error)}</div></div>`;
  if (!check) return `${head("")}<div class="cv-reg-body"><div class="skel skel-line" style="width:60%"></div></div>`;
  if (check.status === "none" && !check.regulation_count) {
    return `${head("")}<div class="cv-reg-body"><div class="cv-reg-empty">
      Регламенты компании ещё не загружены. <a href="#/regulations">Загрузить регламент</a>, и здесь появится сверка обещаний оператора.
    </div></div>`;
  }
  if (check.status === "none") {
    return `${head(runBtn(false))}<div class="cv-reg-body">${progress || `<div class="cv-reg-empty">Диалог ещё не сверяли. Загружено документов: ${check.regulation_count}.</div>`}</div>`;
  }

  const items = sorted(check);
  const c = check.counts || {};
  const docs = (check.regulations || []).map((r) => `«${esc(r.title)}»`).join(", ");
  return `${head(runBtn(true))}
    <div class="cv-reg-body">
      ${progress}
      ${check.stale ? `<div class="cv-note cv-note-warn">Регламенты изменились после этой сверки — сверьте заново.</div>` : ""}
      <div class="cv-reg-summary">
        <span class="cv-reg-count is-conflict">${icon("alert")}Расходится: <b>${c.conflicts || 0}</b></span>
        <span class="cv-reg-count is-none">${icon("doc")}Нет в регламенте: <b>${c.not_covered || 0}</b></span>
        <span class="cv-reg-count is-match">${icon("check")}Соответствует: <b>${c.matches || 0}</b></span>
        <span class="cv-reg-meta">${esc(fmtDate(check.created_at))}${docs ? ` · ${docs}` : ""}</span>
      </div>
      ${items.length ? `<div class="cv-reg-list">${items.map(itemHtml).join("")}</div>`
        : `<div class="cv-reg-empty">В репликах оператора нет обещаний, которые можно сверить с регламентом.</div>`}
    </div>`;
}

function itemHtml(f) {
  const v = VERDICT[f.verdict] || VERDICT.not_covered;
  const cl = f.clause;
  const body = cl ? clauseBody(cl) : "";
  const shown = cl ? (f.clause_quote || body) : "";
  return `
    <article class="cv-reg-item ${v.cls}" id="reg-f-${f.i}">
      <div class="cv-reg-item-h">
        <span class="cv-reg-badge">${icon(v.icon)}${v.label}</span>
        <span class="cv-reg-topic">${esc(f.topic)}</span>
        ${f.promise ? `<span class="cv-reg-promise">${esc(f.promise)}</span>` : ""}
      </div>
      <div class="cv-reg-pair">
        <button type="button" class="cv-reg-side cv-reg-op" data-msg="${f.turn}">
          <span class="cv-reg-k">Оператор · реплика #${f.turn}</span>
          <span class="cv-reg-q">«${esc(f.quote)}»</span>
          ${f.quote_issue ? `<span class="cv-reg-issue">${esc(f.quote_issue)}</span>` : ""}
        </button>
        <div class="cv-reg-side cv-reg-doc">
          <span class="cv-reg-k">${cl ? `Регламент · ${esc(cl.ref)}${cl.section ? ` · ${esc(cl.section)}` : ""}` : "Регламент"}</span>
          <span class="cv-reg-q">${cl ? `«${esc(shown)}»` : "Пункта об этом нет ни в одном загруженном документе"}</span>
          ${cl ? `<span class="cv-reg-src">«${esc(cl.regulation_title)}»</span>` : ""}
          ${cl && f.clause_quote && f.clause_quote.length < body.length - 3 ? `<details class="cv-reg-full"><summary>Пункт целиком</summary><p>${esc(body)}</p></details>` : ""}
        </div>
      </div>
      ${f.explanation ? `<p class="cv-reg-expl">${esc(f.explanation)}</p>` : ""}
    </article>`;
}

function annotate(root, check) {
  $$(".cv-reg-note", root).forEach((el) => el.remove());
  if (!check || check.status !== "done") return;
  for (const f of sorted(check)) {
    if (f.quote_issue) continue;
    const bubble = $(`#msg-${f.turn} .cv-bubble`, root);
    if (!bubble) continue;
    const v = VERDICT[f.verdict] || VERDICT.not_covered;
    const text = f.clause ? `${f.clause.ref}: «${clip(f.clause_quote || clauseBody(f.clause))}»` : clip(f.promise || "");
    bubble.insertAdjacentHTML("beforeend", `
      <button type="button" class="cv-reg-note ${v.cls}" data-reg-finding="${f.i}" title="${esc(v.label)}">
        <span class="cv-reg-note-v">${icon(v.icon)}${v.short}</span>
        <span class="cv-reg-note-t">${esc(text)}</span>
      </button>`);
  }
}
