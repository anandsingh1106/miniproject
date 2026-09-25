/* Segment quick-look.
 *
 * Clicking a row used to navigate away, losing the filters, the scroll position
 * and the sort you had set up. Most of the time the question is small — how bad
 * is this one, what work does it need — so this answers it in a drawer and
 * leaves the list untouched. The full page is one click away for the rest.
 */

import {
  api, html, raw, esc, num, currency, relTime, bandChip, bandColor,
  rpiMeter, pciColor, icon, paintIcons, meta,
} from './core.js?v=26';
import { drawer, animate } from '../ui/ui.js?v=26';

/** Cache: reopening the same segment in one session should feel instant. */
const cache = new Map();

/* Mirrors pci_label() in backend/priority.py — the API only returns the label
   on the segments list, not on a single inspection. */
function pciLabel(pci) {
  const p = Number(pci);
  if (!Number.isFinite(p)) return '';
  if (p >= 85) return 'Good';
  if (p >= 70) return 'Satisfactory';
  if (p >= 55) return 'Fair';
  if (p >= 40) return 'Poor';
  if (p >= 25) return 'Very Poor';
  return 'Failed';
}

const row = (k, v) => html`
  <div class="peek-row"><dt>${k}</dt><dd>${v}</dd></div>`;

/**
 * Open the quick-look drawer for `id`.
 * Loads in the background, so the drawer appears immediately with a skeleton.
 */
export function peekSegment(id) {
  const d = drawer({
    title: 'Segment',
    side: 'right',
    content: html`<div class="peek-skeleton">
      ${raw('<div class="skeleton" style="height:13px;margin-bottom:9px"></div>'.repeat(3))}
      <div class="skeleton" style="height:72px;margin:16px 0"></div>
      ${raw('<div class="skeleton" style="height:13px;margin-bottom:9px"></div>'.repeat(5))}
    </div>`,
    actions: [
      { label: 'Full report', variant: 'primary', value: 'open' },
    ],
  });

  d.closed.then((v) => {
    if (v === 'open') location.hash = `#/segment/${encodeURIComponent(id)}`;
  });

  (async () => {
    try {
      let data = cache.get(id);
      if (!data) {
        const [m, res] = await Promise.all([meta(), api.segment(id)]);
        data = { m, res };
        cache.set(id, data);
      }
      // The drawer may already be closed by the time this resolves.
      if (!document.body.contains(d.el)) return;
      render(d, data);
    } catch (err) {
      if (!document.body.contains(d.el)) return;
      d.body.innerHTML = html`
        <div class="alert critical" role="alert" style="margin:0">
          <span class="ico">${icon('alert-circle')}</span>
          <div>Could not load this segment. ${esc(err.message || '')}</div>
        </div>`;
      paintIcons(d.body);
    }
  })();

  return d;
}

function render(d, { m, res }) {
  const seg = res.segment;
  const latest = res.latest;
  const title = d.el.querySelector('.ui-panel-head h2');
  if (title) title.textContent = seg.name;

  if (!latest) {
    d.body.innerHTML = html`
      <p class="muted" style="margin-top:0">
        ${seg.name} has no inspection yet, so it has no score.
      </p>
      ${row('Ward', seg.ward || '—')}
      ${row('Road class', seg.road_class)}`;
    return;
  }

  const dets = latest.detections || [];
  // Detections carry a taxonomy code (D00, RUT…); meta holds the readable name.
  const byType = new Map();
  dets.forEach((x) => {
    const code = x.code || 'Other';
    byType.set(code, (byType.get(code) || 0) + 1);
  });
  const types = [...byType.entries()]
    .map(([code, n]) => [m.damage_types?.[code]?.short || code, n])
    .sort((a, b) => b[1] - a[1]);

  d.body.innerHTML = html`
    <div class="peek-head">
      ${raw(bandChip(latest.band_code, latest.band_label))}
      <span class="muted" style="font-size:12.5px">
        inspected ${relTime(latest.created_at || seg.inspected_at)}
      </span>
    </div>

    <div class="peek-scores">
      <div class="peek-score">
        <span class="peek-score-label">RPI</span>
        <span class="peek-score-value" style="color:${bandColor(latest.band_code)}">
          ${num(latest.rpi, 1)}
        </span>
        ${raw(rpiMeter(latest.rpi, latest.band_code))}
      </div>
      <div class="peek-score">
        <span class="peek-score-label">PCI</span>
        <span class="peek-score-value" style="color:${pciColor(latest.pci)}">
          ${num(latest.pci, 0)}
        </span>
        <span class="muted" style="font-size:12px">${pciLabel(latest.pci)}</span>
      </div>
    </div>

    <div class="peek-work">
      <div class="peek-work-name">${latest.treatment_name || 'No treatment recommended'}</div>
      <div class="peek-work-cost">${currency(latest.total_cost)}</div>
    </div>

    <dl class="peek-list">
      ${row('Ward', seg.ward || '—')}
      ${row('Road class', seg.road_class)}
      ${row('Traffic (AADT)', num(seg.aadt))}
      ${row('Length', `${num(seg.length_m)} m`)}
      ${row('Drainage', seg.drainage_quality || '—')}
      ${seg.is_emergency_route ? row('Route', 'Emergency route') : ''}
    </dl>

    ${types.length ? html`
      <div class="peek-section-title">Detected distress — ${num(dets.length)} total</div>
      <div class="peek-chips">
        ${types.map(([label, n]) => html`
          <span class="peek-chip"><b>${n}</b> ${label}</span>`)}
      </div>` : html`
      <p class="muted" style="font-size:13px">No distress detected in the latest inspection.</p>`}`;

  paintIcons(d.body);
  animate(d.body, { opacity: [0, 1] }, { duration: 0.2 });
}
