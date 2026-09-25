/* Hand-rolled SVG charts.
 *
 * No charting library: every mark here is a few dozen lines, and rolling them
 * keeps the page dependency-free and lets the marks follow the house rules
 * exactly — thin marks, hairline solid grid, 4px rounded data-ends anchored to
 * the baseline, a 2px surface gap between adjacent fills, selective direct
 * labels, a hover layer on every chart and a table view behind each one.
 */

import { esc, num, place } from './core.js?v=26';
import { animate, reducedMotion } from '../ui/ui.js?v=26';

const NS = 'http://www.w3.org/2000/svg';

/* ---------- tooltip singleton ---------- */

let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    document.body.append(tip);
  }
  return tip;
}

/* The chart tip tracks the cursor rather than an element, so it is anchored to
 * a Floating UI virtual element — a zero-size rect at the pointer. That gets
 * the same flip/shift behaviour as the help tip, which matters for marks near
 * the right edge of a chart or inside a scrolling card. */
function showTip(evt, html) {
  const t = tooltip();
  t.innerHTML = html;
  t.classList.add('on');
  const virtual = {
    getBoundingClientRect: () => ({
      width: 0, height: 0,
      x: evt.clientX, y: evt.clientY,
      top: evt.clientY, bottom: evt.clientY,
      left: evt.clientX, right: evt.clientX,
    }),
  };
  place(virtual, t, { placement: 'top', offset: 12 });
}
const hideTip = () => tip && tip.classList.remove('on');

/* ---------- entrance ---------- */

/**
 * Wipe a chart in from the left. Applied to the whole plot group rather than
 * to individual marks, so it works the same for bars, lines and areas without
 * touching their geometry.
 */
export function revealChart(svgEl, { duration = 0.55 } = {}) {
  if (!svgEl || reducedMotion() || !window.Motion) return;
  const id = `clip-${Math.random().toString(36).slice(2, 8)}`;
  const NSU = 'http://www.w3.org/2000/svg';
  const vb = (svgEl.getAttribute('viewBox') || '0 0 100 100').split(/\s+/).map(Number);
  const [, , w, h] = vb;

  const defs = document.createElementNS(NSU, 'defs');
  const clip = document.createElementNS(NSU, 'clipPath');
  clip.setAttribute('id', id);
  const rect = document.createElementNS(NSU, 'rect');
  rect.setAttribute('x', 0);
  rect.setAttribute('y', 0);
  rect.setAttribute('height', h);
  rect.setAttribute('width', 0);
  clip.append(rect);
  defs.append(clip);
  svgEl.prepend(defs);

  // Move the drawn content under the clip, leaving defs where it is.
  const group = document.createElementNS(NSU, 'g');
  group.setAttribute('clip-path', `url(#${id})`);
  [...svgEl.childNodes].filter((n) => n !== defs).forEach((n) => group.append(n));
  svgEl.append(group);

  animate(rect, { width: [0, w] }, { duration, easing: 'ease-out' })
    .then(() => {
      // Unwrap once done: a live clip-path breaks the hover hit areas.
      [...group.childNodes].forEach((n) => svgEl.append(n));
      group.remove();
      defs.remove();
    });
}

/* ---------- helpers ---------- */

function svg(w, h, extra = {}) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('class', 'chart');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`);
  s.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  s.setAttribute('role', 'img');
  for (const [k, v] of Object.entries(extra)) s.setAttribute(k, v);
  return s;
}

function node(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  return n;
}

/** Bar path with only the data-end rounded, so the mark stays anchored to the
 *  baseline instead of floating on two rounded corners. */
function barPathH(x, y, w, h, r = 4) {
  const rr = Math.min(r, w, h / 2);
  if (w <= rr) return `M${x},${y}h${w}v${h}h${-w}z`;
  return `M${x},${y}h${w - rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - 2 * rr}a${rr},${rr} 0 0 1 ${-rr},${rr}h${-(w - rr)}z`;
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) || 10) * mag;
  const out = [];
  // Runs past the maximum, not up to it. Stopping at the last tick below max
  // leaves the scale short of the data, and every bar longer than that tick
  // overflows the plot area.
  for (let v = 0; v < max - step * 1e-9; v += step) out.push(v);
  out.push(out.length ? out[out.length - 1] + step : step);
  return out;
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The container's width, floored so a hidden or unlaid-out mount still draws. */
function fitWidth(mount, min = 420) {
  const w = Math.round(mount.getBoundingClientRect().width);
  return Math.max(min, w || 640);
}

/* ==========================================================================
   Horizontal bar chart
   ========================================================================== */

/**
 * @param {HTMLElement} mount
 * @param {Array<{label,value,color?,sub?,glyph?}>} data
 * @param {object} opts  { format, valueLabel, labelWidth, height, unit }
 */
export function hbar(mount, data, opts = {}) {
  const {
    format = (v) => num(v),
    labelWidth = 116,
    barH = 18,
    gap = 14,
    unit = '',
    title = '',
  } = opts;

  mount.innerHTML = '';
  if (!data.length) {
    mount.innerHTML = '<div class="empty" style="padding:24px">No data yet.</div>';
    return;
  }

  const padR = 62;
  const padT = 8;
  const padB = 24;
  // Match the viewBox to the container's actual width. With a fixed viewBox the
  // SVG scales to fit, and every label scales with it — an 11px axis label
  // renders at 23px in a full-width card. Sizing to the container keeps the
  // drawing at 1:1 so type stays the size it was specified at.
  const W = fitWidth(mount);
  const plotW = W - labelWidth - padR;
  const H = padT + data.length * (barH + gap) - gap + padB;

  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  const ticks = niceTicks(max);
  const scale = (v) => (v / (ticks[ticks.length - 1] || max)) * plotW;

  const s = svg(W, H, { 'aria-label': title || 'Bar chart' });

  // Recessive solid hairline grid, drawn under the marks.
  ticks.forEach((t) => {
    const x = labelWidth + scale(t);
    s.append(node('line', { class: 'grid-line', x1: x, y1: padT, x2: x, y2: H - padB }));
    const lbl = node('text', {
      class: 'axis-label', x, y: H - padB + 14, 'text-anchor': 'middle',
    });
    lbl.textContent = format(t);
    s.append(lbl);
  });

  data.forEach((d, i) => {
    const y = padT + i * (barH + gap);
    const w = Math.max(1.5, scale(d.value));

    const cat = node('text', {
      class: 'cat-label', x: labelWidth - 10, y: y + barH / 2 + 4, 'text-anchor': 'end',
    });
    cat.textContent = truncate(d.label, 18);
    if (d.label.length > 18) {
      const t = node('title');
      t.textContent = d.label;
      cat.append(t);
    }
    s.append(cat);

    const bar = node('path', {
      class: 'mark',
      d: barPathH(labelWidth, y, w, barH),
      fill: d.color || 'var(--series-1)',
    });
    s.append(bar);

    // Direct value label outside the bar end — never inside, where a short
    // bar would clip it.
    const val = node('text', {
      class: 'value-label', x: labelWidth + w + 8, y: y + barH / 2 + 4,
    });
    val.textContent = format(d.value) + unit;
    s.append(val);

    // Hit target spans the full row, not just the mark.
    const hit = node('rect', {
      class: 'hit', x: 0, y: y - gap / 2, width: W, height: barH + gap,
    });
    hit.addEventListener('mousemove', (e) => showTip(e, `
      <div class="t-title">${esc(d.label)}</div>
      <div class="t-row">
        <span class="k"><span style="width:9px;height:9px;border-radius:2px;display:inline-block;background:${d.color || 'var(--series-1)'}"></span>${esc(opts.valueLabel || 'Value')}</span>
        <span class="v">${esc(format(d.value) + unit)}</span>
      </div>
      ${d.sub ? `<div class="t-row"><span class="k">${esc(d.sub)}</span></div>` : ''}`));
    hit.addEventListener('mouseleave', hideTip);
    s.append(hit);
  });

  mount.append(s);
  revealChart(s);
  mount.append(dataTable(data, opts.valueLabel || 'Value', format, unit));
}

/* ==========================================================================
   Donut
   ==========================================================================
   For a part-to-whole split of a single measure into a handful of ordered
   bins — the one shape a stacked bar reads worse than. Deliberately not
   offered for anything above five slices: past that the arcs stop being
   comparable and a bar chart is the honest answer.
   ========================================================================== */

/** Ring sector between two angles, drawn clockwise from 12 o'clock. */
function arcPath(cx, cy, rOut, rIn, a0, a1) {
  const at = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = at(rOut, a0);
  const [x1, y1] = at(rOut, a1);
  const [x2, y2] = at(rIn, a1);
  const [x3, y3] = at(rIn, a0);
  return `M${x0},${y0}A${rOut},${rOut} 0 ${large} 1 ${x1},${y1}`
       + `L${x2},${y2}A${rIn},${rIn} 0 ${large} 0 ${x3},${y3}Z`;
}

/**
 * @param {HTMLElement} mount
 * @param {Array<{label,value,color?,sub?}>} data
 * @param {object} opts { size, thickness, centre, centreSub, valueLabel, format, title }
 */
export function donut(mount, data, opts = {}) {
  const {
    size = 176,
    thickness = 26,
    centre = '',
    centreSub = '',
    valueLabel = 'Segments',
    format = (v) => num(v),
    title = '',
  } = opts;

  mount.innerHTML = '';
  const total = data.reduce((a, d) => a + (d.value || 0), 0);
  if (!total) {
    mount.innerHTML = '<div class="empty" style="padding:24px">No data yet.</div>';
    return;
  }

  const cx = size / 2;
  const cy = size / 2;
  const rOut = size / 2 - 2;
  const rIn = rOut - thickness;

  const s = svg(size, size, { 'aria-label': title || 'Donut chart' });
  s.classList.add('donut');

  let a = -Math.PI / 2;
  data.forEach((d) => {
    const frac = (d.value || 0) / total;
    if (frac <= 0) return;
    const a1 = a + frac * Math.PI * 2;
    // A single full slice has no arc — the start and end points coincide, and
    // the path collapses to nothing. Draw it as a plain ring instead.
    const mark = frac > 0.9999
      ? node('circle', {
          class: 'mark', cx, cy, r: (rOut + rIn) / 2,
          fill: 'none', stroke: d.color || 'var(--series-1)', 'stroke-width': thickness,
        })
      : node('path', {
          class: 'mark', d: arcPath(cx, cy, rOut, rIn, a, a1),
          fill: d.color || 'var(--series-1)',
        });
    const pct = Math.round(frac * 100);
    mark.addEventListener('mousemove', (e) => showTip(e, `
      <div class="t-title">${esc(d.label)}</div>
      <div class="t-row">
        <span class="k"><span style="width:9px;height:9px;border-radius:2px;display:inline-block;background:${d.color || 'var(--series-1)'}"></span>${esc(valueLabel)}</span>
        <span class="v">${esc(format(d.value))} · ${pct}%</span>
      </div>
      ${d.sub ? `<div class="t-row"><span class="k">${esc(d.sub)}</span></div>` : ''}`));
    mark.addEventListener('mouseleave', hideTip);
    s.append(mark);
    a = a1;
  });

  if (centre) {
    const big = node('text', { class: 'donut-centre', x: cx, y: cy - 1, 'text-anchor': 'middle' });
    big.textContent = centre;
    s.append(big);
  }
  if (centreSub) {
    const small = node('text', {
      class: 'donut-centre-sub', x: cx, y: cy + 15, 'text-anchor': 'middle',
    });
    small.textContent = centreSub;
    s.append(small);
  }

  // Legend carries the share, so the arcs never need a label pointing at them.
  const list = document.createElement('ul');
  list.className = 'donut-legend';
  list.innerHTML = data.map((d) => `
    <li>
      <span class="swatch" style="background:${d.color || 'var(--series-1)'}"></span>
      <span class="k">${esc(d.label)}</span>
      <span class="pc">${Math.round(((d.value || 0) / total) * 100)}%</span>
      <span class="v">${esc(format(d.value))}</span>
    </li>`).join('');

  const wrap = document.createElement('div');
  wrap.className = 'donut-wrap';
  wrap.append(s, list);
  mount.append(wrap);
  revealChart(s);
  mount.append(dataTable(data, valueLabel, format));
}

/* ==========================================================================
   Multi-series line chart
   ========================================================================== */

/**
 * @param {Array<{name,color,points:Array<{x,y}>}>} series  x = category label
 */
export function line(mount, series, opts = {}) {
  const {
    format = (v) => num(v, 0),
    yMax = null,
    yLabel = '',
    height = 230,
  } = opts;

  mount.innerHTML = '';
  const cats = series[0]?.points.map((p) => p.x) || [];
  if (!cats.length) {
    mount.innerHTML = '<div class="empty" style="padding:24px">No history yet.</div>';
    return;
  }

  // With fewer than two points there is no line to draw; bars read honestly.
  if (cats.length < 2) {
    hbar(mount, series.map((s) => ({
      label: s.name, value: s.points[0].y, color: s.color,
    })), { format, valueLabel: yLabel });
    return;
  }

  const W = fitWidth(mount);
  const H = height;
  const padL = 40, padR = 18, padT = 14, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const max = yMax ?? Math.max(...series.flatMap((s) => s.points.map((p) => p.y)), 0) * 1.12;
  const ticks = niceTicks(max || 1);
  const top = ticks[ticks.length - 1] || 1;

  const X = (i) => padL + (cats.length === 1 ? plotW / 2 : (i / (cats.length - 1)) * plotW);
  const Y = (v) => padT + plotH - (v / top) * plotH;

  const s = svg(W, H, { 'aria-label': opts.title || 'Line chart' });

  ticks.forEach((t) => {
    const y = Y(t);
    s.append(node('line', { class: 'grid-line', x1: padL, y1: y, x2: W - padR, y2: y }));
    const lbl = node('text', { class: 'axis-label', x: padL - 8, y: y + 4, 'text-anchor': 'end' });
    lbl.textContent = format(t);
    s.append(lbl);
  });

  // X labels — thinned so they never collide.
  const every = Math.ceil(cats.length / 8);
  cats.forEach((c, i) => {
    if (i % every && i !== cats.length - 1) return;
    const lbl = node('text', {
      class: 'axis-label', x: X(i), y: H - padB + 16, 'text-anchor': 'middle',
    });
    lbl.textContent = c;
    s.append(lbl);
  });

  const endpoints = [];
  series.forEach((ser) => {
    const d = ser.points.map((p, i) => `${i ? 'L' : 'M'}${X(i)},${Y(p.y)}`).join('');
    s.append(node('path', {
      class: 'mark', d, fill: 'none', stroke: ser.color,
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
    // Markers carry a 2px surface ring so overlapping series stay separable.
    ser.points.forEach((p, i) => {
      s.append(node('circle', {
        class: 'mark', cx: X(i), cy: Y(p.y), r: 4,
        fill: ser.color, stroke: 'var(--surface-1)', 'stroke-width': 2,
      }));
    });
    // Selective direct label: the endpoint only.
    endpoints.push({ y: Y(ser.points[ser.points.length - 1].y), value: ser.points[ser.points.length - 1].y });
  });

  // Place the endpoint labels last, pushed apart where series converge — two
  // labels on top of each other are worse than no labels at all.
  endpoints.sort((a, b) => a.y - b.y);
  endpoints.forEach((e, i) => {
    const prev = endpoints[i - 1];
    e.ly = prev && e.y - prev.ly < 13 ? prev.ly + 13 : e.y;
  });
  endpoints.forEach((e) => {
    const lbl = node('text', {
      class: 'value-label', x: W - padR, y: e.ly - 9, 'text-anchor': 'end',
      fill: 'var(--text-primary)',
    });
    lbl.textContent = format(e.value);
    s.append(lbl);
  });

  // Crosshair band per x-position.
  cats.forEach((c, i) => {
    const bw = plotW / cats.length;
    const hit = node('rect', {
      class: 'hit', x: X(i) - bw / 2, y: padT, width: bw, height: plotH,
    });
    hit.addEventListener('mousemove', (e) => showTip(e, `
      <div class="t-title">${esc(c)}</div>
      ${series.map((ser) => `
        <div class="t-row">
          <span class="k"><span style="width:14px;height:2px;border-radius:1px;display:inline-block;background:${ser.color}"></span>${esc(ser.name)}</span>
          <span class="v">${esc(format(ser.points[i]?.y ?? 0))}</span>
        </div>`).join('')}`));
    hit.addEventListener('mouseleave', hideTip);
    s.append(hit);
  });

  mount.append(s);
  revealChart(s);
  if (series.length >= 2) mount.append(legend(series, true));
  mount.append(lineTable(cats, series, format));
}

/* ==========================================================================
   Sparkline — condition history inside a card
   ========================================================================== */

export function sparkline(mount, values, color = 'var(--series-1)') {
  mount.innerHTML = '';
  if (values.length < 2) return;
  const W = 160, H = 34, pad = 4;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const X = (i) => pad + (i / (values.length - 1)) * (W - pad * 2);
  const Y = (v) => pad + (1 - (v - min) / span) * (H - pad * 2);

  const s = svg(W, H, { 'aria-hidden': 'true' });
  s.style.width = `${W}px`;
  s.append(node('path', {
    d: values.map((v, i) => `${i ? 'L' : 'M'}${X(i)},${Y(v)}`).join(''),
    fill: 'none', stroke: color, 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));
  s.append(node('circle', {
    cx: X(values.length - 1), cy: Y(values[values.length - 1]), r: 3.5,
    fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2,
  }));
  mount.append(s);
}

/* ==========================================================================
   Budget allocation bar — one stacked track, 2px surface gap between fills
   ========================================================================== */

export function allocationBar(mount, funded, deferred, opts = {}) {
  mount.innerHTML = '';
  const total = funded + deferred;
  if (total <= 0) return;
  const W = 640, H = 34, r = 4;
  const fw = (funded / total) * W;
  const dw = Math.max(0, W - fw - (fw > 0 && funded < total ? 2 : 0));   // 2px surface gap

  const s = svg(W, H, { 'aria-label': 'Funded versus deferred works' });
  s.setAttribute('preserveAspectRatio', 'none');
  s.style.height = `${H}px`;

  if (fw > 0) {
    s.append(node('path', {
      d: barPathH(0, 0, fw, H, r), fill: 'var(--series-1)', class: 'mark',
    }));
  }
  if (dw > 0) {
    s.append(node('path', {
      d: barPathH(W - dw, 0, dw, H, r), fill: 'var(--surface-3)', class: 'mark',
    }));
  }
  mount.append(s);
  mount.append(legend([
    { name: opts.fundedLabel || 'Funded this cycle', color: 'var(--series-1)' },
    { name: opts.deferredLabel || 'Deferred — unfunded', color: 'var(--surface-3)' },
  ]));
}

/* ==========================================================================
   Legend & table views
   ========================================================================== */

export function legend(items, asLine = false) {
  const d = document.createElement('div');
  d.className = 'legend';
  d.innerHTML = items.map((i) => `
    <span class="item">
      <span class="swatch${asLine ? ' line' : ''}" style="background:${i.color}"></span>${esc(i.name)}
    </span>`).join('');
  return d;
}

/** Every chart ships a table view — identity is never colour-alone. */
function dataTable(data, valueLabel, format, unit = '') {
  const d = document.createElement('details');
  d.className = 'data-table';
  d.innerHTML = `<summary>Table view</summary>
    <table class="chart-table">
      <thead><tr><th>Category</th><th class="num">${esc(valueLabel)}</th></tr></thead>
      <tbody>${data.map((r) => `
        <tr><td>${esc(r.label)}</td><td class="num">${esc(format(r.value) + unit)}</td></tr>`).join('')}
      </tbody>
    </table>`;
  return d;
}

function lineTable(cats, series, format) {
  const d = document.createElement('details');
  d.className = 'data-table';
  d.innerHTML = `<summary>Table view</summary>
    <table class="chart-table">
      <thead><tr><th>Period</th>${series.map((s) => `<th class="num">${esc(s.name)}</th>`).join('')}</tr></thead>
      <tbody>${cats.map((c, i) => `
        <tr><td>${esc(c)}</td>${series.map((s) => `<td class="num">${esc(format(s.points[i]?.y ?? 0))}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>`;
  return d;
}
