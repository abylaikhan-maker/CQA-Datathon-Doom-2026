// Inline stroke icons for the card / appeals / verify screens (24×24, currentColor).
// Static markup only; decorative by default (aria-hidden). Size and stroke come from CSS (.cv-svg).
const P = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  partial: '<path d="M5 12h14"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.6v.01"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5S9.6 5.9 12 3.5z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  msgs: '<path d="M4 4h12v9H8l-4 3z"/><path d="M9 16v1h7l4 3V8h-3"/>',
  bot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M3 13v2M21 13v2"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  hourglass: '<path d="M7 3.5h10M7 20.5h10M8 3.5c0 4 4 5.5 4 8.5s-4 4.5-4 8.5M16 3.5c0 4-4 5.5-4 8.5s4 4.5 4 8.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.3 3 7.7 7 9 4-1.3 7-4.7 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  scale: '<path d="M12 3v18M5 7h14M5 7l-3 7h6zM19 7l-3 7h6zM8 21h8"/>',
  sparkle: '<path d="M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".6"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
};

/** <svg> markup for an icon. `label` makes it meaningful (role=img) instead of decorative. */
export function cvIcon(name, { cls = "", label = "" } = {}) {
  const a11y = label ? `role="img" aria-label="${String(label).replace(/"/g, "&quot;")}"` : 'aria-hidden="true"';
  return `<svg class="cv-svg ${cls}" viewBox="0 0 24 24" ${a11y} focusable="false">${P[name] || ""}</svg>`;
}

/** Icon for an answer kind (yes / no / part / na / crit). N/A stays text — it reads better than any glyph. */
export function answerGlyph(kind, { critical = false } = {}) {
  if (critical) return cvIcon("alert");
  if (kind === "yes") return cvIcon("check");
  if (kind === "no") return cvIcon("x");
  if (kind === "part") return cvIcon("partial");
  return '<span class="cv-na-t">N/A</span>';
}

/** Respect the OS "reduce motion" setting for programmatic scrolling. */
export const scrollBehavior = () =>
  (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
