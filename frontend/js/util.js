// Shared helpers: escaping, formatting, toasts, modals, timestamps.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const SPEAKER = { client: "Клиент", operator: "Оператор", bot: "Бот", system: "Система" };
export const LANG = { RU: "Русский", KZ: "Қазақша", EN: "English" };
export const CHANNEL = { "agent chat": "Чат", "voice call": "Звонок" };
export const TYPE_LABEL = { binary: "Да / Нет", scale: "Шкала", critical: "Грубая ошибка (без баллов)" };

export function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: digits });
}

export function scoreClass(v) {
  if (v === null || v === undefined) return "";
  const n = Number(v);
  return n >= 85 ? "hi" : n >= 65 ? "mid" : "lo";
}

export function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Answer label + css kind for a criterion answer. */
export function answerView(crit, answer) {
  if (answer === "na") return { label: "N/A", kind: "na", icon: "–" };
  if (crit && crit.type === "scale") {
    const vals = (crit.scale || []).map((s) => Number(s.value));
    const top = Math.max(...vals);
    const v = Number(answer);
    const kind = v >= top ? "yes" : v <= Math.min(...vals) ? "no" : "part";
    return { label: `${fmtNum(v)} из ${fmtNum(top)}`, kind, icon: kind === "yes" ? "✓" : kind === "no" ? "✕" : "~" };
  }
  if (crit && crit.type === "critical") {
    return answer === "yes"
      ? { label: "Выявлено", kind: "no", icon: "!" }
      : { label: "Не выявлено", kind: "yes", icon: "✓" };
  }
  return answer === "yes" ? { label: "Да", kind: "yes", icon: "✓" } : { label: "Нет", kind: "no", icon: "✕" };
}

/** Allowed answers for a criterion (for appeal decisions). */
export function answerOptions(crit) {
  const opts = [];
  if (crit.type === "scale") {
    [...(crit.scale || [])].sort((a, b) => b.value - a.value).forEach((s) => opts.push({ value: String(s.value), label: `${s.value} — ${s.description}` }));
  } else if (crit.type === "critical") {
    opts.push({ value: "yes", label: "Выявлено (Да)" }, { value: "no", label: "Не выявлено (Нет)" });
  } else {
    opts.push({ value: "yes", label: "Да" }, { value: "no", label: "Нет" });
  }
  if (crit.na_allowed) opts.push({ value: "na", label: "N/A" });
  return opts;
}

/** Seconds from the conversation start for a message timestamp (MM:SS, HH:MM:SS or ISO 8601). */
export function tsSeconds(ts, firstTs) {
  const parse = (t) => {
    if (!t) return null;
    const s = String(t).trim();
    if (/^\d{1,2}(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) {
      return s.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
    }
    const d = Date.parse(s);
    return Number.isNaN(d) ? null : d / 1000;
  };
  const a = parse(ts);
  if (a === null) return null;
  const isClock = /^\d{1,2}:/.test(String(ts).trim());
  if (isClock) return a;
  const b = parse(firstTs);
  return b === null ? null : Math.max(0, a - b);
}

export function fmtClock(sec) {
  if (sec === null || sec === undefined) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Short display for a raw timestamp (ISO -> HH:MM:SS local to the string). */
export function fmtTs(ts) {
  const s = String(ts || "");
  const m = s.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : s;
}

export function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 3500);
}

/** Simple modal. `body` is HTML. Returns {el, close}. onSubmit(el) may return false to keep open. */
export function modal({ title, body, submitText = "Сохранить", onSubmit, cancelText = "Отмена" }) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="btn btn-ghost btn-sm" data-x aria-label="Закрыть">✕</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        <button class="btn" data-x>${esc(cancelText)}</button>
        ${onSubmit ? `<button class="btn btn-primary" data-ok>${esc(submitText)}</button>` : ""}
      </div>
    </div>`;
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-x]")) close(); });
  const ok = back.querySelector("[data-ok]");
  if (ok) {
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      try {
        const res = await onSubmit(back);
        if (res !== false) close();
      } catch (e) {
        toast(e.message, true);
      } finally {
        ok.disabled = false;
      }
    });
  }
  document.body.appendChild(back);
  const first = back.querySelector("textarea, input, select");
  if (first) first.focus();
  return { el: back, close };
}

export function busy(btn, on, text) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${esc(text || "")}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

export function ring(value, size = 112) {
  const r = 46, c = 2 * Math.PI * r;
  const v = value === null || value === undefined ? 0 : Math.max(0, Math.min(100, Number(value)));
  const color = value === null || value === undefined ? "var(--line-strong)" : v >= 85 ? "var(--good)" : v >= 65 ? "var(--warn)" : "var(--bad)";
  return `
    <div class="ring" style="width:${size}px;height:${size}px">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--brand-100)" stroke-width="8"/>
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
          stroke-dasharray="${(c * v) / 100} ${c}"/>
      </svg>
      <div class="val"><b>${value === null || value === undefined ? "—" : fmtNum(value)}</b><span>/ 100</span></div>
    </div>`;
}
