/* Shared plumbing: API client, formatting, and small DOM helpers. */

export const API = '';   // same origin — FastAPI serves this site

/* ---------- DOM ---------- */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Marker type for markup that is already safe.
 *  It extends String so it still behaves as one everywhere — assigning it to
 *  `innerHTML` or interpolating it into another template both just work. */
class SafeHTML extends String {}

/** Tagged template that escapes interpolated values by default.
 *
 *  Anything that came out of `html` or `raw` is passed through untouched, so
 *  templates nest without double-escaping; everything else is escaped. Without
 *  the pass-through, a nested `html` block renders as visible angle-bracket
 *  soup rather than as markup. */
export function html(strings, ...values) {
  const out = strings.reduce((acc, s, i) => {
    if (i === 0) return s;
    return acc + render(values[i - 1]) + s;
  }, '');
  return new SafeHTML(out);
}

function render(v) {
  if (v instanceof SafeHTML) return v;
  if (v && v.__raw) return v.value ?? '';
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export const raw = (value) => ({ __raw: true, value: value ?? '' });

export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  kids.flat().forEach((k) => node.append(k?.nodeType ? k : document.createTextNode(k)));
  return node;
}

/* ---------- API ---------- */

async function request(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || body?.detail || `Request failed (${res.status})`);
  return body;
}

export const api = {
  meta:        ()            => request('/api/meta'),
  health:      ()            => request('/api/health'),
  segments:    (params = {}) => request('/api/segments?' + new URLSearchParams(clean(params))),
  segment:     (id)          => request('/api/segments/' + encodeURIComponent(id)),
  inspections: (params = {}) => request('/api/inspections?' + new URLSearchParams(clean(params))),
  inspection:  (id)          => request('/api/inspections/' + encodeURIComponent(id)),
  analytics:   ()            => request('/api/analytics'),
  budget:      (amount)      => request('/api/budget?amount=' + encodeURIComponent(amount)),
  analyze:     (formData)    => request('/api/analyze', { method: 'POST', body: formData }),
  rescore:     (payload)     => request('/api/rescore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }),
};

const clean = (o) => Object.fromEntries(
  Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)
);

/* ---------- Shared metadata cache ---------- */

let _meta = null;
export async function meta() {
  if (!_meta) _meta = await api.meta();
  return _meta;
}
export const metaSync = () => _meta;

/* ---------- Formatting ---------- */

/** Indian numbering (lakh / crore) — the units a municipal budget is written in. */
export function currency(v, { compact = true } = {}) {
  const n = Number(v) || 0;
  if (!compact) return '₹' + Math.round(n).toLocaleString('en-IN');
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(n >= 1e8 ? 0 : 2) + ' Cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(n >= 1e6 ? 0 : 1) + ' L';
  if (n >= 1e3) return '₹' + (n / 1e3).toFixed(0) + 'k';
  return '₹' + Math.round(n);
}

export const num = (v, d = 0) =>
  (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

export function relTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(+then)) return '—';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export const dateStr = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(+d) ? '—'
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

/* ---------- Colour roles ---------- */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Priority bands are *states*, so they wear the reserved status palette. */
export const bandColor = (code) => css({
  P1: '--status-critical', P2: '--status-serious',
  P3: '--status-warning',  P4: '--status-good',
}[code] || '--text-muted');

/** Icon + label pairing, so a band is never signalled by colour alone. */
export const bandGlyph = (code) => ({ P1: '●', P2: '◆', P3: '▲', P4: '■' }[code] || '·');

/** Damage types are *identities*, so they wear categorical slots in fixed
 *  order. The order is pinned to config.DAMAGE_ORDER on the server, so a
 *  filter that removes a type never repaints the survivors. */
const DAMAGE_SLOT = {
  D40: 1, D20: 2, RUT: 3, EDG: 4, RAV: 5, D10: 6, D00: 7, D43: 8, D44: 8,
};
export const damageColor = (code) => css(`--series-${DAMAGE_SLOT[code] || 1}`);

/** Nine distress types, eight categorical slots.
 *
 *  D43 (faded crosswalk) and D44 (faded lane line) are the same distress —
 *  worn thermoplastic — differing only in where it was painted, so they fold
 *  into one charted identity. Leaving them separate would put two bars of the
 *  identical colour side by side, which is exactly the confusion the
 *  fixed-slot rule exists to prevent. Detection lists still name them
 *  individually, because there the text carries the identity, not the colour.
 */
const CHART_FOLD = { D44: 'D43' };
const FOLD_LABEL = { D43: 'Faded marking' };

/** Fold per-code counts into chart rows: [{label, value, color, sub}]. */
export function damageChartRows(counts, meta) {
  const merged = new Map();
  for (const code of meta.damage_order) {
    const n = counts[code] || 0;
    if (!n) continue;
    const key = CHART_FOLD[code] || code;
    const row = merged.get(key) || {
      label: FOLD_LABEL[key] || meta.damage_types[key].short,
      value: 0,
      color: damageColor(key),
      sub: meta.damage_types[key].description,
      codes: [],
    };
    row.value += n;
    row.codes.push(code);
    merged.set(key, row);
  }
  return [...merged.values()];
}

/** Pavement condition is a *magnitude* — one hue, light to dark. */
export function pciColor(pci) {
  const p = Number(pci) || 0;
  if (p >= 85) return css('--seq-100');
  if (p >= 70) return css('--seq-250');
  if (p >= 55) return css('--seq-400');
  if (p >= 40) return css('--seq-550');
  return css('--seq-700');
}

export const seriesColor = (i) => css(`--series-${(i % 8) + 1}`);

/* ---------- Reusable fragments ---------- */

export const bandChip = (code, label, outline = false) => html`
  <span class="band band-${code}${raw(outline ? ' outline' : '')}">
    <span class="glyph" aria-hidden="true">${bandGlyph(code)}</span>${code} ${label || ''}
  </span>`;

export const rpiMeter = (rpi, band) => html`
  <div class="meter">
    <span class="n">${rpi === null || rpi === undefined ? '—' : num(rpi, 1)}</span>
    <span class="track"><span class="fill"
      style="width:${Math.max(2, Math.min(100, Number(rpi) || 0))}%;background:${bandColor(band)}"></span></span>
  </div>`;

export const spinner = (label = 'Loading…') => html`
  <div class="empty"><div class="spinner" style="margin:0 auto 10px"></div>${label}</div>`;

export function emptyState(title, body, icon = '📭') {
  return html`<div class="empty">
    <div style="font-size:30px;margin-bottom:8px" aria-hidden="true">${icon}</div>
    <h3>${title}</h3><p style="margin:0">${body}</p></div>`;
}

export function errorState(err) {
  return html`<div class="alert critical" role="alert">
    <span class="ico" aria-hidden="true">⚠</span>
    <div><strong>Something went wrong.</strong><br>${err?.message || String(err)}</div>
  </div>`;
}

/* ---------- Theme ---------- */

export function initTheme() {
  const saved = localStorage.getItem('roadlens-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  return saved;
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('roadlens-theme', next);
  window.dispatchEvent(new CustomEvent('themechange', { detail: next }));
  return next;
}

/* ---------- Misc ---------- */

export function debounce(fn, ms = 220) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
