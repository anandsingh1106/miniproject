/* Dashboard — network status at a glance, and what to do first. */

import {
  $, api, html, raw, currency, num, bandChip, bandColor,
  rpiMeter, relTime, emptyState, meta, icon, help,
} from './core.js?v=25';
import { hbar, donut } from './charts.js?v=25';
import { renderMap } from './map.js?v=25';
import { countUp, reveal } from '../ui/ui.js?v=25';
import { peekSegment } from './segment-peek.js?v=25';
import { profile } from './profile.js?v=25';

/* PCI bins. Thresholds match the backend's own pci_label(), so the donut and
   the "Fair"/"Poor" wording elsewhere in the app never disagree.
   Condition is a magnitude, so it wears the sequential ramp rather than the
   status palette — the same rule the rest of the app follows. */
const PCI_BINS = [
  { label: 'Good (PCI ≥ 70)', test: (p) => p >= 70, color: 'var(--seq-250)' },
  { label: 'Fair (50 – 70)',  test: (p) => p >= 50, color: 'var(--seq-400)' },
  { label: 'Poor (< 50)',     test: () => true,     color: 'var(--seq-700)' },
];

export async function dashboardView(mount) {
  const [a, segs, m] = await Promise.all([api.analytics(), api.segments(), meta()]);
  const t = a.totals;
  const top = segs.segments.filter((s) => s.rpi !== null).slice(0, 8);

  const criticalCost = segs.segments
    .filter((s) => s.band_code === 'P1')
    .reduce((sum, s) => sum + (s.total_cost || 0), 0);

  const bandCount = (code) => a.bands.find((b) => b.code === code)?.count || 0;
  const atRisk = bandCount('P2') + bandCount('P3');

  /* Condition mix, binned from the segments already fetched — no extra call. */
  const scored = segs.segments.filter((s) => s.pci !== null && s.pci !== undefined);
  const conditionMix = PCI_BINS.map((b) => ({ ...b, value: 0 }));
  scored.forEach((s) => {
    conditionMix[PCI_BINS.findIndex((b) => b.test(s.pci))].value += 1;
  });

  /* The only month-over-month figure the API actually supports: the trend
     series is built from inspection history, so the last two rounds are a
     real comparison. Every other tile is a snapshot with nothing to compare
     against, and inventing a delta for those would be inventing data. */
  const trend = a.trend || [];
  const pciShift = trend.length >= 2
    ? +(trend[trend.length - 1].avg_pci - trend[trend.length - 2].avg_pci).toFixed(1)
    : null;

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });

  mount.innerHTML = html`
    <section class="welcome">
      <span class="welcome-ico">${icon('activity')}</span>
      <div class="welcome-text">
        <h1>Welcome back, ${profile().firstName}</h1>
        <p>Here's the latest status of your road network.</p>
      </div>
      <div class="welcome-meta">
        <div class="w-date">${today}</div>
        <div class="w-note">${icon('leaf')} ${num(t.network_km, 1)} km under management</div>
      </div>
    </section>

    <div class="grid g-4" style="margin-bottom:16px">
      <div class="stat">
        <span class="stat-ico" style="color:var(--accent)">${icon('route')}</span>
        <div class="stat-text">
          <div class="label">Total segments</div>
          <div class="value" id="kpi-segments">${num(t.segments)}</div>
          <div class="sub">${num(t.scored)} scored across ${num(t.network_km, 1)} km</div>
        </div>
      </div>
      <div class="stat">
        <span class="stat-ico" style="color:${bandColor('P1')}">${icon('alert-triangle')}</span>
        <div class="stat-text">
          <div class="label">Critical — P1${help('band')}</div>
          <div class="value" id="kpi-critical" style="color:${bandColor('P1')}">${num(t.critical)}</div>
          <div class="sub">${num(t.high)} more at P2 High</div>
        </div>
      </div>
      <div class="stat">
        <span class="stat-ico" style="color:${bandColor('P3')}">${icon('clipboard-list')}</span>
        <div class="stat-text">
          <div class="label">At risk — P2 / P3</div>
          <div class="value" id="kpi-risk">${num(atRisk)}</div>
          <div class="sub">Planned, not yet urgent</div>
        </div>
      </div>
      <div class="stat">
        <span class="stat-ico" style="color:var(--status-good)">${icon('database')}</span>
        <div class="stat-text">
          <div class="label">Maintenance backlog</div>
          <div class="value">${currency(t.total_cost)}</div>
          <div class="sub">Estimated cost to clear</div>
        </div>
      </div>
    </div>

    <div class="grid g-main dash-main" style="margin-bottom:16px">
      <section class="card">
        <div class="card-head">
          <div>
            <h2>Geographic distribution</h2>
            <p class="card-sub">Marker size and colour represent the priority band</p>
          </div>
          <a class="btn sm ghost" href="#/map">${icon('maximize-2')} Full map</a>
        </div>
        <div id="map"></div>
      </section>

      <div class="side-stack">
        ${t.critical > 0 ? html`
          <section class="card notice" role="alert">
            <div class="card-body">
              <div class="notice-row">
                <span class="notice-ico">${icon('alert-circle')}</span>
                <div>
                  <h3>${num(t.critical)} segment${raw(t.critical === 1 ? '' : 's')} at P1 Critical</h3>
                  <p>
                    These need intervention within 30 days. Estimated cost to clear
                    the critical backlog: <strong>${currency(criticalCost)}</strong>.
                  </p>
                  <a class="btn sm danger" href="#/budget">Plan the spend →</a>
                </div>
              </div>
            </div>
          </section>` : ''}

        <section class="card">
          <div class="card-head">
            <h2>Priority distribution</h2>
            <span class="hint">${num(t.scored)} scored</span>
          </div>
          <div class="card-body">
            <div id="band-chart"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>Network condition${help('PCI')}</h2>
            ${pciShift === null ? '' : html`
              <span class="delta ${raw(pciShift >= 0 ? 'up' : 'down')}"
                    title="Change in mean PCI between the last two inspection rounds">
                ${raw(pciShift >= 0 ? '↑' : '↓')} ${num(Math.abs(pciShift), 1)}
              </span>`}
          </div>
          <div class="card-body">
            <div id="pci-donut"></div>
          </div>
          <div class="card-foot">
            Mean PCI ${num(t.avg_pci, 1)} — ${t.avg_pci_label.toLowerCase()}${
              pciShift === null ? '' : html`, ${raw(pciShift >= 0 ? 'up' : 'down')} ${
                num(Math.abs(pciShift), 1)} since the previous inspection round`}.
          </div>
        </section>
      </div>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>Reconstruction priority queue</h2>
        <a class="btn sm ghost" href="#/network">All segments →</a>
      </div>
      <div class="card-body flush">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="rank">#</th>
                <th>Segment</th><th>Location</th><th>Priority</th>
                <th class="num">RPI</th>
                <th>Recommended work</th><th class="num">Cost</th>
                <th class="right">Action</th>
              </tr>
            </thead>
            <tbody id="queue"></tbody>
          </table>
        </div>
      </div>
      <div class="card-foot">
        Ranked by Reconstruction Priority Index. <a href="#/method">How the score works →</a>
      </div>
    </section>`;

  /* Priority queue */
  const tbody = $('#queue', mount);
  if (!top.length) {
    tbody.innerHTML = `<tr><td colspan="8">${emptyState(
      'No inspections yet', 'Analyse a road image to populate the queue.', '🛣️')}</td></tr>`;
  } else {
    tbody.innerHTML = top.map((s, i) => html`
      <tr class="clickable" data-id="${s.id}">
        <td class="rank"><span class="rank-dot band-${s.band_code}">${i + 1}</span></td>
        <td>
          <div class="cell-title">${s.name}</div>
          <div class="cell-sub">${relTime(s.inspected_at)}</div>
        </td>
        <td class="cell-sub">${s.ward || '—'}</td>
        <td>${raw(bandChip(s.band_code, s.band_label, true))}</td>
        <td class="num">${raw(rpiMeter(s.rpi, s.band_code))}</td>
        <td>
          <div class="cell-title" style="font-weight:450">${s.treatment_name || '—'}</div>
        </td>
        <td class="num">${currency(s.total_cost)}</td>
        <td class="right"><span class="row-action">View →</span></td>
      </tr>`).join('');
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        // Modifier-click keeps the old behaviour: straight to the full report.
        if (e.metaKey || e.ctrlKey) { location.hash = `#/segment/${tr.dataset.id}`; return; }
        peekSegment(tr.dataset.id);
      });
    });
    reveal(tbody, 'tr', { delay: 0.03, duration: 0.3 });
  }

  /* Priority bands wear the reserved status palette — they are states. */
  hbar($('#band-chart', mount), a.bands.map((b) => ({
    label: `${b.code} ${b.label}`,
    value: b.count,
    color: bandColor(b.code),
    sub: m.bands.find((x) => x.code === b.code)?.window,
  })), { valueLabel: 'Segments', labelWidth: 104, title: 'Segments by priority band' });

  donut($('#pci-donut', mount), conditionMix, {
    centre: num(t.avg_pci, 1),
    centreSub: 'mean PCI',
    valueLabel: 'Segments',
    title: 'Segments by pavement condition',
  });

  renderMap($('#map', mount), segs.segments);

  /* The headline numbers count up on arrival. Each keeps its own formatter so
     the animated value reads the same as the final one. */
  countUp($('#kpi-segments', mount), t.segments);
  countUp($('#kpi-critical', mount), t.critical);
  countUp($('#kpi-risk', mount), atRisk);
}
