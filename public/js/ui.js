// Tiny DOM toolkit. Nothing here ever turns strings into HTML (no innerHTML anywhere),
// which is what lets the page run under a strict Trusted Types policy.

const SVGNS = 'http://www.w3.org/2000/svg';
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'required', 'multiple', 'hidden', 'open']);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  append(el, kids);
  return el;
}

// Hand-drawn 24px stroke icons.
const ICONS = {
  search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M16.2 16.2 21 21' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V7.5a4 4 0 0 1 8 0V11' }]],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M15 5V4.5A1.5 1.5 0 0 0 13.5 3h-9A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H5' }]],
  eye: [['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  eyeOff: [['path', { d: 'M3 3l18 18M10.6 6.1c.5-.1.9-.1 1.4-.1 6 0 9.5 6 9.5 6a17 17 0 0 1-2.9 3.6M6.5 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.5 0 2.9-.4 4.1-1M9.9 9.9a3 3 0 0 0 4.2 4.2' }]],
  edit: [['path', { d: 'M4 20h4.5L19.3 9.2a2.1 2.1 0 0 0-3-3L5.5 17v3M14.5 8l3 3' }]],
  external: [['path', { d: 'M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10' }]],
  menu: [['path', { d: 'M4 7h16M4 12h16M4 17h16' }]],
  close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  spark: [['path', { d: 'M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5' }]],
  users: [['circle', { cx: 9, cy: 8, r: 3.5 }], ['path', { d: 'M2.5 20a6.5 6.5 0 0 1 13 0M15.5 4.6a3.5 3.5 0 0 1 0 6.8M17.5 14.2a6.5 6.5 0 0 1 4 5.8' }]],
  device: [['rect', { x: 6.5, y: 2.5, width: 11, height: 19, rx: 2 }], ['path', { d: 'M11 18.5h2' }]],
  list: [['path', { d: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01' }]],
  download: [['path', { d: 'M12 4v11M7 10.5l5 5 5-5M5 20h14' }]],
  upload: [['path', { d: 'M12 20V9M7 13.5l5-5 5 5M5 4h14' }]],
  trash: [['path', { d: 'M4 7h16M9.5 11v6M14.5 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7' }]],
  shield: [['path', { d: 'M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6L12 3z' }], ['path', { d: 'M8.8 12.2l2.2 2.2 4.4-4.6' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  alert: [['path', { d: 'M12 3.5 21.5 20h-19L12 3.5z' }], ['path', { d: 'M12 10v4.5M12 17.5h.01' }]],
  logout: [['path', { d: 'M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10M14.5 16l4-4-4-4M18.5 12H9' }]],
  key: [['circle', { cx: 7.5, cy: 15.5, r: 4 }], ['path', { d: 'M10.5 12.5 20 3M16 7l3 3M13.5 9.5l2 2' }]],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]],
  restore: [['path', { d: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5' }]],
  back: [['path', { d: 'M10 6l6 6-6 6' }]],
  link: [['path', { d: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1' }]],
  calendar: [['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2 }], ['path', { d: 'M3.5 10h17M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2' }]],
  bell: [['path', { d: 'M6 16.5V11a6 6 0 1 1 12 0v5.5l1.6 2.2H4.4L6 16.5z' }], ['path', { d: 'M10 21a2.2 2.2 0 0 0 4 0' }]],
  globe: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M3.5 12h17M12 3.5c2.4 2.5 3.6 5.3 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.3-3.6-8.5s1.2-6 3.6-8.5z' }]],
  server: [['rect', { x: 4, y: 4, width: 16, height: 6.5, rx: 1.5 }], ['rect', { x: 4, y: 13.5, width: 16, height: 6.5, rx: 1.5 }], ['path', { d: 'M7.5 7.25h.01M7.5 16.75h.01M11 7.25h5M11 16.75h5' }]],
  chart: [['path', { d: 'M4 20h16M7 16.5V12M12 16.5V7M17 16.5V9.5' }]],
  card: [['rect', { x: 3, y: 5.5, width: 18, height: 13, rx: 2 }], ['path', { d: 'M3 10h18M7 15h3.5' }]],
  mail: [['rect', { x: 3.5, y: 5.5, width: 17, height: 13, rx: 2 }], ['path', { d: 'm4.5 7.5 7.5 5.5 7.5-5.5' }]],
  printer: [['path', { d: 'M7 9V3.5h10V9M7 17.5H5a1.5 1.5 0 0 1-1.5-1.5v-5.5A1.5 1.5 0 0 1 5 9h14a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 1-1.5 1.5h-2' }], ['rect', { x: 7, y: 14, width: 10, height: 6.5, rx: 1 }]],
};

export function icon(name, size = 20) {
  const el = svg('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'icon',
  });
  for (const [t, a] of ICONS[name] || []) el.append(svg(t, a));
  return el;
}

// The combination dial: the app's one moving part. It spins while keys are being derived.
export function dial(size = 132) {
  const ring = svg('g', { class: 'dial-ring' });
  for (let i = 0; i < 60; i++) {
    const long = i % 5 === 0;
    ring.append(svg('line', { x1: 60, y1: long ? 9 : 11, x2: 60, y2: 16, transform: `rotate(${i * 6} 60 60)`, class: long ? 'tick tick-long' : 'tick' }));
  }
  return svg(
    'svg',
    { viewBox: '0 0 120 120', width: size, height: size, class: 'dial', 'aria-hidden': 'true' },
    svg('circle', { cx: 60, cy: 60, r: 57, class: 'dial-rim' }),
    ring,
    svg('circle', { cx: 60, cy: 60, r: 36, class: 'dial-knob' }),
    svg('circle', { cx: 60, cy: 60, r: 27, class: 'dial-knob-inner' }),
    svg('path', { d: 'M60 2.5l-5 7h10z', class: 'dial-pointer' }),
    svg('rect', { x: 57.5, y: 27, width: 5, height: 13, rx: 2.5, class: 'dial-notch' }),
  );
}

export function button(label, { kind = 'secondary', iconName = null, onClick = null, type = 'button', title = null, small = false, disabled = false } = {}) {
  const b = h(
    'button',
    { type, class: `btn btn-${kind}${small ? ' btn-sm' : ''}${label ? '' : ' btn-icon'}`, title: title || null, 'aria-label': title || null, disabled },
    iconName ? icon(iconName, small ? 16 : 18) : null,
    label ? h('span', null, label) : null,
  );
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

let fieldSeq = 0;
export function field(labelText, control, hint = null) {
  const id = control.id || `f${++fieldSeq}`;
  const target = control.matches('input,select,textarea') ? control : control.querySelector('input,select,textarea');
  if (target && !target.id) target.id = id;
  const hintEl = hint ? h('p', { class: 'hint', id: `${target ? target.id : id}-hint` }, hint) : null;
  if (hintEl && target) target.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { for: target ? target.id : id }, labelText), control, hintEl);
}

const savedKids = new WeakMap();
export function setBusy(btn, busy, text) {
  if (busy) {
    if (!savedKids.has(btn)) savedKids.set(btn, [...btn.childNodes]);
    btn.disabled = true;
    btn.classList.add('is-busy');
    if (text) btn.replaceChildren(h('span', null, text));
  } else {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    if (savedKids.has(btn)) btn.replaceChildren(...savedKids.get(btn));
    savedKids.delete(btn);
  }
}

// ---------- toasts ----------
let toastHost = null;
export function toast(message, kind = 'info', ms = 3800) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: `toast toast-${kind}` }, icon(kind === 'error' ? 'alert' : 'check', 18), h('span', null, message));
  toastHost.append(t);
  while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
  setTimeout(() => t.remove(), ms);
}

// ---------- dialogs (native <dialog>: focus trap, Esc and backdrop for free) ----------
export function modal({ title, body, footer = null, wide = false, onClose = null }) {
  const closeBtn = button('', { kind: 'ghost', iconName: 'close', title: 'إغلاق' });
  const dlg = h(
    'dialog',
    { class: `modal${wide ? ' modal-wide' : ''}`, 'aria-labelledby': 'modal-title' },
    h('div', { class: 'modal-head' }, h('h2', { id: 'modal-title' }, title), closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  const close = () => {
    if (dlg.open) dlg.close();
  };
  closeBtn.addEventListener('click', close);
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (onClose) onClose();
  });
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close };
}

export function confirmDialog({ title, text, confirmLabel = 'تأكيد', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const yes = button(confirmLabel, { kind: danger ? 'danger' : 'primary' });
    const no = button('إلغاء', { kind: 'secondary' });
    const m = modal({
      title,
      body: (Array.isArray(text) ? text : [text]).map((p) => h('p', null, p)),
      footer: [yes, no],
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    yes.addEventListener('click', () => {
      answered = true;
      resolve(true);
      m.close();
    });
    no.addEventListener('click', () => m.close());
    no.focus();
  });
}

// ---------- formatting ----------
const ar = new Intl.NumberFormat('ar-EG-u-nu-latn');
export const num = (n) => ar.format(n);

export function relTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'الآن';
  const rtf = new Intl.RelativeTimeFormat('ar-EG-u-nu-latn', { numeric: 'auto' });
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (diff < 86400 * 30) return rtf.format(-Math.round(diff / 86400), 'day');
  return fmtDate(d);
}

export function fmtDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function countLabel(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${num(n)} ${few}`;
  return `${num(n)} ${many}`;
}
