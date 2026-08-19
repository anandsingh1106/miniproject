/* Dashboard — network status at a glance, and what to do first. */

import {
  $, api, html, raw, currency, num, bandChip, bandColor, bandGlyph,
  rpiMeter, relTime, emptyState, meta,
} from './core.js';
import { hbar } from './charts.js';
import { renderMap } from './map.js';

export async function dashboardView(mount) {
  const [a, segs, m] = await Promise.all([api.analytics(), api.segments(), meta()]);
  const t = a.totals;
  const top = segs.segments.filter((s) => s.rpi !== null).slice(0, 8);

  const criticalCost = segs.segments
    .filter((s) => s.band_code === 'P1')
    .reduce((sum, s) => sum + (s.total_cost || 0), 0);

  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <h1>Network condition</h1>
        <p class="lede">
          ${num(t.segments)} segments across ${num(t.network_km, 1)} km, ranked by
          reconstruction priority. Scores combine detected pavement distress with traffic
          exposure, network criticality, safety risk and environmental factors.
        </p>
      </div>
      <a class="btn primary" href="#/analyze">
        ${raw(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`)}
        Analyse a road image
      </a>
    </div>

    ${t.critical > 0 ? html`
      <div class="alert critical" role="alert">
        <span class="ico" aria-hidden="true">●</span>
        <div>
          <strong>${num(t.critical)} segment${raw(t.critical === 1 ? '' : 's')} at P1 Critical.</strong>
          These need intervention within 30 days. Estimated cost to clear the
          critical backlog: <strong>${currency(criticalCost)}</strong>.
          <a href="#/budget">Plan the spend →</a>
        </div>
      </div>` : ''}

    <div class="grid g-4" style="margin-bottom:16px">
      <div class="stat">
        <div class="label">Critical — P1</div>
        <div class="value" style="color:${bandColor('P1')}">${num(t.critical)}</div>
        <div class="sub">${num(t.high)} more at P2 High</div>
      </div>
      <div class="stat">
        <div class="label">Network condition</div>
        <div class="value">${num(t.avg_pci, 1)}<small> / 100</small></div>
        <div class="sub">Mean PCI — ${t.avg_pci_label.toLowerCase()}</div>
      </div>
      <div class="stat">
        <div class="label">Maintenance backlog</div>
        <div class="value">${currency(t.total_cost)}</div>
        <div class="sub">Across ${num(t.scored)} scored segments</div>
      </div>
      <div class="stat">
        <div class="label">Urgent length</div>
        <div class="value">${num(t.backlog_km, 1)}<small> km</small></div>
        <div class="sub">P1 and P2 segments combined</div>
      </div>
    </div>

    <div class="grid g-main" style="margin-bottom:16px">
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
                  <th>Segment</th><th>Class</th><th>Priority</th>
                  <th class="num">RPI</th><th class="num">PCI</th>
                  <th>Recommended work</th><th class="num">Cost</th>
                </tr>
              </thead>
              <tbody id="queue"></tbody>
            </table>
          </div>
        </div>
        <div class="card-foot">
          Ranked by Reconstruction Priority Index. <a href="#/method">How the score works →</a>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Priority distribution</h2>
          <span class="hint">${num(t.scored)} scored</span>
        </div>
        <div class="card-body">
          <div id="band-chart"></div>
        </div>
        <div class="card-foot">
          ${m.bands.map((b) => html`
            <div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0">
              <span style="color:${bandColor(b.code)};font-weight:650">
                <span aria-hidden="true">${bandGlyph(b.code)}</span> ${b.code} ${b.label}
              </span>
              <span class="muted" style="font-size:12px">${b.window}</span>
            </div>`)}
        </div>
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>Geographic distribution</h2>
        <span class="hint">Marker colour and shape show the priority band</span>
      </div>
      <div id="map"></div>
    </section>`;

  /* Priority queue */
  const tbody = $('#queue', mount);
  if (!top.length) {
    tbody.innerHTML = `<tr><td colspan="7">${emptyState(
      'No inspections yet', 'Analyse a road image to populate the queue.', '🛣️')}</td></tr>`;
  } else {
    tbody.innerHTML = top.map((s) => html`
      <tr class="clickable" data-id="${s.id}">
        <td>
          <div class="cell-title">${s.name}</div>
          <div class="cell-sub">${s.ward || '—'} · inspected ${relTime(s.inspected_at)}</div>
        </td>
        <td><span class="tag">${s.road_class}</span></td>
        <td>${raw(bandChip(s.band_code, s.band_label, true))}</td>
        <td class="num">${raw(rpiMeter(s.rpi, s.band_code))}</td>
        <td class="num">${num(s.pci, 0)}</td>
        <td style="max-width:180px">
          <div class="cell-title" style="font-weight:450">${s.treatment_name || '—'}</div>
        </td>
        <td class="num">${currency(s.total_cost)}</td>
      </tr>`).join('');
    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => { location.hash = `#/segment/${tr.dataset.id}`; });
    });
  }

  /* Priority bands wear the reserved status palette — they are states. */
  hbar($('#band-chart', mount), a.bands.map((b) => ({
    label: `${b.code} ${b.label}`,
    value: b.count,
    color: bandColor(b.code),
    sub: m.bands.find((x) => x.code === b.code)?.window,
  })), { valueLabel: 'Segments', labelWidth: 104, title: 'Segments by priority band' });

  renderMap($('#map', mount), segs.segments);
}
