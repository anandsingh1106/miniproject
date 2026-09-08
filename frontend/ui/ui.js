/* Interactive UI components.
 *
 * The house style is unchanged: markup is built with the `html` tag from
 * core.js, colours come from the CSS tokens, and nothing here needs a build
 * step. What these add over plain markup is the behaviour that is tedious and
 * easy to get wrong — focus trapping, Escape handling, ARIA wiring, anchored
 * positioning (Floating UI) and motion that honours prefers-reduced-motion.
 *
 * Positioning and animation are delegated to the vendored globals, but every
 * component degrades to a working, unanimated version when they are absent, so
 * a missing asset never leaves a dialog that cannot be closed.
 */

import { html, raw, esc, paintIcons, $$ } from '../js/core.js?v=25';

const FUI = () => window.FloatingUIDOM;
const M = () => window.Motion;

/** Users who ask for less motion get none; every helper checks this. */
export const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/* ---------- motion helpers ---------- */

/**
 * Animate `el`. A thin wrapper over Motion.animate that no-ops when the
 * library is missing or the user prefers reduced motion, so callers never
 * need to guard. Returns a promise that always resolves.
 */
export function animate(el, keyframes, options = {}) {
  const m = M();
  if (!m || !el || reducedMotion()) return Promise.resolve();
  try {
    const controls = m.animate(el, keyframes, options);
    return controls?.finished ?? Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

/**
 * Fade-and-rise the elements matching `selector` inside `root`, one after
 * another. Used for card grids and table rows on first paint.
 */
export function reveal(root, selector = '.card', { delay = 0.05, duration = 0.4 } = {}) {
  const m = M();
  const els = $$(selector, root);
  if (!els.length) return Promise.resolve();
  if (!m || reducedMotion()) {
    els.forEach((el) => { el.style.opacity = ''; el.style.transform = ''; });
    return Promise.resolve();
  }
  return animate(
    els,
    { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0)'] },
    { duration, delay: m.stagger ? m.stagger(delay) : 0, easing: 'ease-out' },
  );
}

/** Count a number up to `to`. Falls back to setting the final value at once. */
export function countUp(el, to, { duration = 0.8, format = (v) => Math.round(v) } = {}) {
  const m = M();
  if (!el) return Promise.resolve();
  if (!m || reducedMotion()) { el.textContent = format(to); return Promise.resolve(); }
  try {
    return m.animate(0, to, {
      duration,
      easing: 'ease-out',
      onUpdate: (v) => { el.textContent = format(v); },
    })?.finished ?? Promise.resolve();
  } catch {
    el.textContent = format(to);
    return Promise.resolve();
  }
}

/* ---------- focus management ---------- */

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Keep Tab inside `container` while it is open. Returns a cleanup function. */
function trapFocus(container, restoreTo) {
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = $$(FOCUSABLE, container).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKey);
  return () => {
    container.removeEventListener('keydown', onKey);
    if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
  };
}

/* ---------- modal / drawer ---------- */

let openLayers = 0;

/**
 * Open a modal dialog. `content` may be a SafeHTML value, a markup string or a
 * DOM node.
 *
 *   const m = modal({ title: 'Edit segment', content: html`…`,
 *                     actions: [{ label: 'Save', variant: 'primary', onClick: save }] });
 *   const result = await m.closed;
 *
 * Returns { el, panel, body, close, closed }. An action's onClick may return
 * false to keep the dialog open (e.g. failed validation).
 */
export function modal(opts = {}) {
  return overlay({ ...opts, variant: 'modal' });
}

/** Same API as modal(), but slides in from the side. Good for filters/details. */
export function drawer(opts = {}) {
  return overlay({ ...opts, variant: 'drawer' });
}

function overlay({
  title = '', content = '', actions = [], variant = 'modal',
  size = 'md', side = 'right', dismissible = true, onClose,
} = {}) {
  const prevFocus = document.activeElement;
  const host = document.createElement('div');
  host.className = `ui-overlay ui-overlay-${variant}`;
  host.dataset.side = side;

  const labelId = `ui-t-${Math.random().toString(36).slice(2, 8)}`;
  const head = title
    ? `<header class="ui-panel-head">
         <h2 id="${labelId}">${esc(title)}</h2>
         ${dismissible ? `<button type="button" class="icon-btn" data-close aria-label="Close">
           <i data-lucide="x" aria-hidden="true"></i></button>` : ''}
       </header>`
    : '';

  host.innerHTML = html`
    <div class="ui-backdrop" data-close></div>
    <div class="ui-panel ui-${raw(variant)} ui-size-${raw(size)}" role="dialog"
         aria-modal="true" ${raw(title ? `aria-labelledby="${labelId}"` : '')}>
      ${raw(head)}
      <div class="ui-panel-body"></div>
      ${raw(actions.length ? '<footer class="ui-panel-foot"></footer>' : '')}
    </div>`;

  const body = host.querySelector('.ui-panel-body');
  if (content instanceof Node) body.append(content);
  else body.innerHTML = content?.toString?.() ?? '';

  const foot = host.querySelector('.ui-panel-foot');
  if (foot) {
    actions.forEach((a, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      // app.css styles the accent fill as .btn.primary and the red as
      // .btn.danger; anything else is the default outline button.
      b.className = `btn${a.variant ? ` ${a.variant}` : ''}`;
      b.textContent = a.label ?? `Action ${i + 1}`;
      b.addEventListener('click', async () => {
        const r = await a.onClick?.(api);
        if (r !== false && a.closes !== false) close(a.value !== undefined ? a.value : r);
      });
      foot.append(b);
    });
  }

  document.body.append(host);
  paintIcons(host);
  openLayers += 1;
  document.body.classList.add('ui-locked');

  const panel = host.querySelector('.ui-panel');
  const untrap = trapFocus(host, prevFocus);

  let settle;
  const closed = new Promise((r) => { settle = r; });
  let done = false;

  function close(value) {
    if (done) return;
    done = true;
    onClose?.(value);
    untrap();
    openLayers = Math.max(0, openLayers - 1);
    if (!openLayers) document.body.classList.remove('ui-locked');
    document.removeEventListener('keydown', onEsc);
    Promise.all([
      animate(host.querySelector('.ui-backdrop'), { opacity: [1, 0] }, { duration: 0.15 }),
      animate(panel, variant === 'drawer'
        ? { opacity: [1, 0], transform: ['translateX(0)', side === 'left' ? 'translateX(-16px)' : 'translateX(16px)'] }
        : { opacity: [1, 0], transform: ['scale(1)', 'scale(.97)'] },
        { duration: 0.15, easing: 'ease-in' }),
    ]).then(() => { host.remove(); settle(value); });
  }

  function onEsc(e) {
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(undefined); }
  }
  document.addEventListener('keydown', onEsc);

  if (dismissible) {
    host.querySelectorAll('[data-close]').forEach((n) =>
      n.addEventListener('click', () => close(undefined)));
  }

  animate(host.querySelector('.ui-backdrop'), { opacity: [0, 1] }, { duration: 0.18 });
  animate(panel, variant === 'drawer'
    ? { opacity: [0, 1], transform: [side === 'left' ? 'translateX(-16px)' : 'translateX(16px)', 'translateX(0)'] }
    : { opacity: [0, 1], transform: ['scale(.97) translateY(6px)', 'scale(1) translateY(0)'] },
    { duration: 0.22, easing: 'ease-out' });

  // Focus the first useful control, else the panel itself.
  const firstField = $$(FOCUSABLE, body)[0] || $$(FOCUSABLE, host)[0];
  if (firstField) firstField.focus({ preventScroll: true });
  else { panel.tabIndex = -1; panel.focus({ preventScroll: true }); }

  const api = { el: host, panel, body, close, closed };
  return api;
}

/**
 * Ask a yes/no question. Resolves true when confirmed, false otherwise.
 *
 *   if (await confirm({ title: 'Delete segment?', danger: true })) …
 */
export function confirm({
  title = 'Are you sure?', body = '', confirmLabel = 'Confirm',
  cancelLabel = 'Cancel', danger = false,
} = {}) {
  const m = modal({
    title,
    size: 'sm',
    content: body ? html`<p class="muted" style="margin:0">${body}</p>` : '',
    actions: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, variant: danger ? 'danger' : 'primary', value: true },
    ],
  });
  return m.closed.then((v) => v === true);
}

/* ---------- tabs ---------- */

/**
 * Progressively enhance a tab container. Expects:
 *
 *   <div class="ui-tabs">
 *     <div class="ui-tablist">
 *       <button data-tab="a">A</button><button data-tab="b">B</button>
 *     </div>
 *     <div data-panel="a">…</div><div data-panel="b">…</div>
 *   </div>
 *
 * Arrow keys move between tabs, as the ARIA pattern expects.
 */
export function tabs(root, { onChange } = {}) {
  const list = root.querySelector('.ui-tablist');
  if (!list) return { select: () => {} };
  const btns = $$('[data-tab]', list);
  const panels = $$('[data-panel]', root);

  list.setAttribute('role', 'tablist');
  btns.forEach((b) => {
    b.setAttribute('role', 'tab');
    b.type = 'button';
    const p = panels.find((x) => x.dataset.panel === b.dataset.tab);
    if (p) {
      const id = `uip-${b.dataset.tab}-${Math.random().toString(36).slice(2, 6)}`;
      p.id = id;
      p.setAttribute('role', 'tabpanel');
      b.setAttribute('aria-controls', id);
    }
  });

  function select(key, { focus = false } = {}) {
    btns.forEach((b) => {
      const on = b.dataset.tab === key;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    panels.forEach((p) => {
      const on = p.dataset.panel === key;
      p.hidden = !on;
      if (on) {
        animate(p, { opacity: [0, 1], transform: ['translateY(4px)', 'translateY(0)'] },
          { duration: 0.2, easing: 'ease-out' });
      }
    });
    onChange?.(key);
  }

  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) select(b.dataset.tab);
  });
  list.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const next = e.key === 'ArrowRight' ? i + 1
      : e.key === 'ArrowLeft' ? i - 1
      : e.key === 'Home' ? 0
      : e.key === 'End' ? btns.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    select(btns[(next + btns.length) % btns.length].dataset.tab, { focus: true });
  });

  const initial = btns.find((b) => b.classList.contains('active')) || btns[0];
  if (initial) select(initial.dataset.tab);
  return { select };
}

/* ---------- accordion ---------- */

/**
 * Wire <details class="ui-accordion-item"> elements for reveal animation and
 * optional single-open behaviour. Native <details> keeps it accessible and
 * keyboard-operable with no extra work.
 */
export function accordion(root, { single = false } = {}) {
  const items = $$('details.ui-accordion-item', root);
  items.forEach((d) => {
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      if (single) items.forEach((o) => { if (o !== d) o.open = false; });
      const inner = d.querySelector('.ui-accordion-body');
      if (inner) {
        animate(inner, { opacity: [0, 1], transform: ['translateY(-4px)', 'translateY(0)'] },
          { duration: 0.2, easing: 'ease-out' });
      }
    });
  });
  return items;
}

/* ---------- dropdown menu ---------- */

let closeOpenMenu = null;

/**
 * Anchored menu.
 *
 *   menu(button, [
 *     { label: 'Export CSV', icon: 'download', onClick: … },
 *     { separator: true },
 *     { label: 'Delete', danger: true, onClick: … },
 *   ]);
 *
 * Positioned by Floating UI so it flips and shifts inside scroll containers.
 */
export function menu(anchor, items = [], { placement = 'bottom-start' } = {}) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ui-menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = items.map((it) => (
    it.separator
      ? '<div class="ui-menu-sep" role="separator"></div>'
      : `<button type="button" role="menuitem" class="ui-menu-item${it.danger ? ' danger' : ''}"
           ${it.disabled ? 'disabled' : ''}>
           ${it.icon ? `<i data-lucide="${esc(it.icon)}" aria-hidden="true"></i>` : ''}
           <span>${esc(it.label ?? '')}</span>
           ${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}
         </button>`
  )).join('');
  document.body.append(el);
  paintIcons(el);

  const actionable = items.filter((i) => !i.separator);
  $$('.ui-menu-item', el).forEach((b, i) => {
    b.addEventListener('click', () => {
      const it = actionable[i];
      if (it?.disabled) return;
      closeMenu();
      it?.onClick?.();
    });
  });

  const fui = FUI();
  const reposition = () => {
    if (!fui) {
      const r = anchor.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8))}px`;
      el.style.top = `${r.bottom + 6}px`;
      return;
    }
    fui.computePosition(anchor, el, {
      placement,
      strategy: 'fixed',
      middleware: [fui.offset(6), fui.flip({ padding: 8 }), fui.shift({ padding: 8 })],
    }).then(({ x, y }) => Object.assign(el.style, { left: `${x}px`, top: `${y}px` }));
  };
  const stop = fui ? fui.autoUpdate(anchor, el, reposition) : (reposition(), null);

  animate(el, { opacity: [0, 1], transform: ['scale(.97) translateY(-4px)', 'scale(1) translateY(0)'] },
    { duration: 0.14, easing: 'ease-out' });

  const onDoc = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { closeMenu(); anchor.focus?.(); return; }
    const btns = $$('.ui-menu-item:not([disabled])', el);
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = e.key === 'ArrowDown' ? i + 1 : i - 1;
      btns[(n + btns.length) % btns.length]?.focus();
    }
  };
  // Deferred so the click that opened the menu does not immediately close it.
  setTimeout(() => document.addEventListener('click', onDoc), 0);
  document.addEventListener('keydown', onKey);

  closeOpenMenu = () => {
    stop?.();
    document.removeEventListener('click', onDoc);
    document.removeEventListener('keydown', onKey);
    el.remove();
    closeOpenMenu = null;
    anchor.setAttribute('aria-expanded', 'false');
  };
  anchor.setAttribute('aria-expanded', 'true');
  $$('.ui-menu-item:not([disabled])', el)[0]?.focus();
  return { close: closeMenu, el };
}

/** Close whichever menu is open, if any. */
export function closeMenu() {
  if (closeOpenMenu) closeOpenMenu();
}
