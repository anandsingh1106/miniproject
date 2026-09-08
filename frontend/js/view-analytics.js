/* Analytics — where the network is failing, and what it will cost. */

import {
  $, api, meta, html, raw, currency, num, bandColor, damageChartRows,
} from './core.js?v=25';
import { hbar, line } from './charts.js?v=25';

export async function analyticsView(mount) {
  const [a, m] = await Promise.all([api.analytics(), meta()]);
  const t = a.totals;

  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <h1>Network analytics</h1>
        <p class="lede">
          Aggregate view across ${num(t.segments)} segments and ${num(t.network_km, 1)} km.
          Each panel answers one question; the table view under each chart carries the same
          numbers for anyone who would rather read them.
        </p>
      </div>
    </div>

    <div class="grid g-4" style="margin-bottom:16px">
      <div class="stat">
        <div class="label">Mean condition</div>
        <div class="value">${num(t.avg_pci, 1)}<small> / 100</small></div>
        <div class="sub">${t.avg_pci_label}</div>
      </div>
      <div class="stat">
        <div class="label">Needing urgent work</div>
        <div class="value" style="color:${bandColor('P1')}">${num(t.critical + t.high)}</div>
        <div class="sub">${num(t.backlog_km, 1)} km at P1 or P2</div>
      </div>
      <div class="stat">
        <div class="label">Total backlog</div>
        <div class="value">${currency(t.total_cost)}</div>
        <div class="sub">All recommended interventions</div>
      </div>
      <div class="stat">
        <div class="label">Cost per km</div>
        <div class="value">${currency(t.network_km ? t.total_cost / t.network_km : 0)}</div>
        <div class="sub">Network average</div>
      </div>
    </div>

    <div class="grid g-2" style="margin-bottom:16px">
      <section class="card">
        <div class="card-head">
          <h2>Distress mix across the network</h2>
          <span class="hint">All recorded inspections</span>
        </div>
        <div class="card-body"><div id="c-damage"></div></div>
        <div class="card-foot">
          Alligator cracking and rutting are the ones that matter for reconstruction —
          both mean the base has started to fail, not just the surface.
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Priority distribution</h2>
          <span class="hint">${num(t.scored)} scored segments</span>
        </div>
        <div class="card-body"><div id="c-bands"></div></div>
        <div class="card-foot">
          A healthy network is weighted toward P3 and P4. Weight in P1 and P2 is deferred
          maintenance that has already compounded.
        </div>
      </section>
    </div>

    <div class="grid g-2" style="margin-bottom:16px">
      <section class="card">
        <div class="card-head">
          <h2>Condition by road class</h2>
          <span class="hint">Mean PCI — higher is better</span>
        </div>
        <div class="card-body"><div id="c-class"></div></div>
        <div class="card-foot">
          Where mean condition is worst relative to traffic carried is where the next
          resurfacing programme should go.
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Backlog by intervention type</h2>
          <span class="hint">Estimated cost</span>
        </div>
        <div class="card-body"><div id="c-treat"></div></div>
        <div class="card-foot">
          Reconstruction dominates the cost while affecting the fewest segments — which is
          exactly the argument for funding preventive work earlier.
        </div>
      </section>
    </div>

    <section class="card">
      <div class="card-head">
        <h2>Network condition over time</h2>
        <span class="hint">Mean across all inspections in each period</span>
      </div>
      <div class="card-body"><div id="c-trend"></div></div>
      <div class="card-foot">
        Condition falling while priority rises is the signature of a network decaying faster
        than it is being maintained. Both are on the same 0–100 scale, so one axis serves both.
      </div>
    </section>`;

  /* Damage types are identities — categorical slots, fixed order. */
  const damageCounts = Object.fromEntries(a.damage.map((d) => [d.code, d.count]));
  hbar($('#c-damage', mount), damageChartRows(damageCounts, m),
    { valueLabel: 'Instances', labelWidth: 112, title: 'Distress instances by type' });

  /* Priority bands are states — reserved status palette. */
  hbar($('#c-bands', mount), a.bands.map((b) => ({
    label: `${b.code} ${b.label}`,
    value: b.count,
    color: bandColor(b.code),
    sub: m.bands.find((x) => x.code === b.code)?.window,
  })), { valueLabel: 'Segments', labelWidth: 104, title: 'Segments by priority band' });

  /* One series over nominal categories — one colour, not a value ramp. */
  hbar($('#c-class', mount), a.by_class.map((c) => ({
    label: c.name,
    value: c.avg_pci,
    color: 'var(--series-1)',
    sub: `${c.count} segments · mean RPI ${num(c.avg_rpi, 1)}`,
  })), {
    valueLabel: 'Mean PCI', labelWidth: 140,
    format: (v) => num(v, 0), title: 'Mean pavement condition by road class',
  });

  hbar($('#c-treat', mount), a.by_treatment.map((x) => ({
    label: x.name,
    value: x.cost,
    color: 'var(--series-1)',
    sub: `${x.count} segment${x.count === 1 ? '' : 's'}`,
  })), {
    valueLabel: 'Estimated cost', labelWidth: 150,
    format: (v) => currency(v), title: 'Backlog cost by intervention type',
  });

  const trend = a.trend;
  line($('#c-trend', mount), [
    {
      name: 'Mean pavement condition (PCI)',
      color: 'var(--series-1)',
      points: trend.map((x) => ({ x: fmtMonth(x.month), y: x.avg_pci })),
    },
    {
      name: 'Mean reconstruction priority (RPI)',
      color: 'var(--series-2)',
      points: trend.map((x) => ({ x: fmtMonth(x.month), y: x.avg_rpi })),
    },
  ], { yMax: 100, height: 200, format: (v) => num(v, 0),
       title: 'Network condition and priority over time' });
}

function fmtMonth(ym) {
  const [y, mm] = (ym || '').split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(mm) - 1] || ym} ${String(y).slice(2)}`;
}
