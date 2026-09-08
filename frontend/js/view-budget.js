/* Budget allocation — what to fund this cycle, and what gets deferred. */

import {
  $, api, html, raw, currency, num, bandChip, bandColor, emptyState, debounce,
  icon, help, downloadCSV,
} from './core.js?v=25';
import { donut } from './charts.js?v=25';

const PRESETS = [
  { label: '₹5 Cr', value: 50_000_000 },
  { label: '₹15 Cr', value: 150_000_000 },
  { label: '₹30 Cr', value: 300_000_000 },
  { label: '₹50 Cr', value: 500_000_000 },
];

/* How many rows each table shows before "View all" expands it. Eight is what
   fits beside the other column without the page growing a scrollbar of its
   own — the rest are one click away, not gone. */
const PREVIEW_ROWS = 8;

const BANDS = ['P1', 'P2', 'P3', 'P4'];

export async function budgetView(mount) {
  let amount = 150_000_000;

  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <h1>Budget allocation</h1>
        <p class="lede">
          Rank and allocate the available budget to the highest-priority segments
          for the most damage prevented per rupee.
        </p>
      </div>
      <button class="btn" id="export-plan">${icon('file-down')} Export works order</button>
    </div>

    <div class="alert info banner">
      <span class="ico">${icon('info')}</span>
      <div>
        Ranking by priority alone spends the whole budget on two reconstruction jobs
        while fifty cheap sealing jobs go unfunded — and those fifty prevent far more
        future damage. The allocator ranks by value per rupee (priority × years of life
        bought, divided by cost), then funds every P1 hazard first regardless of its ratio.
      </div>
      <a class="banner-link" href="#/method">How allocation works →</a>
    </div>

    <div id="out"></div>

    <div class="sim-bar">
      <span class="sim-ico">${icon('lightbulb')}</span>
      <p class="sim-tip">
        Adjust the available budget to see how the allocation changes — a larger
        budget reaches further down into P2 and P3 before the money runs out.
      </p>
      <div class="sim-control">
        <label for="amt">Simulate budget <span class="mono" id="amt-label"></span></label>
        <input type="range" id="amt" min="10000000" max="1000000000"
               step="10000000" value="${amount}">
        <div class="seg-control" id="presets">
          ${PRESETS.map((p) => html`<button data-v="${p.value}">${p.label}</button>`)}
        </div>
      </div>
    </div>`;

  const label = $('#amt-label', mount);
  const slider = $('#amt', mount);
  const markPresets = () => mount.querySelectorAll('#presets button').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.v) === amount));

  const refresh = debounce(async () => {
    markPresets();
    await render($('#out', mount), amount);
  }, 140);

  slider.addEventListener('input', (e) => {
    amount = Number(e.target.value);
    // The label tracks the drag; the plan waits for the debounce, because each
    // change is a round trip to the allocator.
    label.textContent = currency(amount);
    refresh();
  });
  mount.querySelectorAll('#presets button').forEach((b) => {
    b.addEventListener('click', () => {
      amount = Number(b.dataset.v);
      slider.value = amount;
      label.textContent = currency(amount);
      refresh();
    });
  });

  $('#export-plan', mount).addEventListener('click', async () => {
    const plan = await api.budget(amount);
    downloadCSV(`roadlens-works-order-${new Date().toISOString().slice(0, 10)}.csv`, [
      { header: 'Status', value: (r) => r._status },
      { header: 'Segment', value: (r) => r.name },
      { header: 'Ward', value: (r) => r.ward || '' },
      { header: 'Road class', value: (r) => r.road_class },
      { header: 'Priority band', value: (r) => r.band_code },
      { header: 'RPI', value: (r) => (r.rpi ?? 0).toFixed(1) },
      { header: 'PCI', value: (r) => (r.pci ?? 0).toFixed(0) },
      { header: 'Recommended work', value: (r) => r.treatment_name || '' },
      { header: 'Estimated cost (INR)', value: (r) => Math.round(r.total_cost || 0) },
      { header: 'Design life (yr)', value: (r) => r.life_years || '' },
      { header: 'Value per rupee', value: (r) => (r.ratio ?? 0).toExponential(3) },
    ], [
      ...plan.funded.map((r) => ({ ...r, _status: 'FUNDED' })),
      ...plan.deferred.map((r) => ({ ...r, _status: 'DEFERRED' })),
    ]);
  });

  label.textContent = currency(amount);
  await render($('#out', mount), amount);
  markPresets();
}

async function render(mount, amount) {
  const plan = await api.budget(amount);
  const needing = plan.funded_count + plan.deferred_count;

  /* Where the money actually went, by band. The allocator returns a flat list,
     so the split is summed here rather than asked for — one pass, no extra
     call, and it cannot drift from the list shown below it. */
  const byBand = BANDS.map((code) => ({
    code,
    label: `${code} ${bandLabel(code)}`,
    color: bandColor(code),
    value: plan.funded
      .filter((s) => s.band_code === code)
      .reduce((n, s) => n + (s.total_cost || 0), 0),
  })).filter((b) => b.value > 0);

  const pct = (v, of) => (of > 0 ? (v / of) * 100 : 0);
  const utilised = pct(plan.allocated, plan.budget);
  const maxRatio = Math.max(...plan.funded.map((s) => s.ratio || 0),
                            ...plan.deferred.map((s) => s.ratio || 0), 0);

  mount.innerHTML = html`
    ${plan.unfunded_critical > 0 ? html`
      <div class="alert critical" role="alert">
        <span class="ico">${icon('alert-circle')}</span>
        <div>
          <strong>${num(plan.unfunded_critical)} critical segment${raw(plan.unfunded_critical === 1 ? '' : 's')}
          cannot be funded at this budget.</strong>
          P1 works are funded ahead of everything else, so this is a genuine shortfall rather
          than a ranking artefact. A further ${currency(plan.shortfall)} clears the full backlog.
        </div>
      </div>` : ''}

    <div class="grid g-4" style="margin-bottom:16px">
      <div class="stat">
        <span class="stat-ico" style="color:var(--accent)">${icon('database')}</span>
        <div class="stat-text">
          <div class="label">Available budget</div>
          <div class="value">${currency(plan.budget)}</div>
        </div>
      </div>

      <div class="stat">
        <span class="stat-ico" style="color:var(--status-good)">${icon('pie-chart')}</span>
        <div class="stat-text">
          <div class="label">Allocated <span class="pct">${num(utilised, 0)}%</span></div>
          <div class="value">${currency(plan.allocated)}</div>
          ${raw(miniBar(utilised, 'var(--status-good)'))}
        </div>
      </div>

      <div class="stat">
        <span class="stat-ico" style="color:${bandColor('P3')}">${icon('clock')}</span>
        <div class="stat-text">
          <div class="label">Remaining <span class="pct">${num(100 - utilised, 0)}%</span></div>
          <div class="value">${currency(plan.remaining)}</div>
          ${raw(miniBar(100 - utilised, bandColor('P3')))}
        </div>
      </div>

      <div class="stat">
        <span class="stat-ico" style="color:var(--accent)">${icon('file-text')}</span>
        <div class="stat-text">
          <div class="label">Segments funded</div>
          <div class="value">${num(plan.funded_count)}<small> / ${num(needing)}</small></div>
          ${raw(miniBar(pct(plan.funded_count, needing), 'var(--accent)'))}
        </div>
      </div>
    </div>

    <div class="grid g-main budget-main" style="margin-bottom:16px;align-items:start">
      <section class="card">
        <div class="card-head">
          <h2>Budget utilisation</h2>
          <span class="delta ${raw(utilised >= 99 ? 'up' : '')}">${num(utilised, 0)}% utilised</span>
        </div>
        <div class="card-body">
          <p class="util-line">
            <strong>${currency(plan.allocated)}</strong> of ${currency(plan.budget)} allocated
          </p>
          <div class="util-bar">
            ${byBand.map((b) => html`
              <span style="width:${pct(b.value, plan.budget)}%;background:${b.color}"
                    title="${b.label} — ${currency(b.value)}"></span>`)}
            ${plan.remaining > 0 ? html`
              <span class="unallocated" style="width:${pct(plan.remaining, plan.budget)}%"
                    title="Unallocated — ${currency(plan.remaining)}"></span>` : ''}
          </div>
          <div class="util-legend">
            ${byBand.map((b) => html`
              <div class="ul-item">
                <span class="ul-dot" style="background:${b.color}"></span>
                <span class="ul-k">${b.label}</span>
                <span class="ul-v">${currency(b.value)}
                  <span class="muted">(${num(pct(b.value, plan.budget), 0)}%)</span></span>
              </div>`)}
            ${plan.remaining > 0 ? html`
              <div class="ul-item">
                <span class="ul-dot unallocated"></span>
                <span class="ul-k">Unallocated</span>
                <span class="ul-v">${currency(plan.remaining)}
                  <span class="muted">(${num(pct(plan.remaining, plan.budget), 0)}%)</span></span>
              </div>` : ''}
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Allocation by priority</h2>
        </div>
        <div class="card-body">
          <div id="alloc-donut"></div>
        </div>
      </section>
    </div>

    <div class="grid g-2">
      <section class="card">
        <div class="card-head">
          <h2>Funded segments</h2>
          <span class="count-pill good">${num(plan.funded_count)} segments · ${currency(plan.allocated)}</span>
        </div>
        <div class="card-body flush">
          ${raw(table(plan.funded, true, maxRatio))}
        </div>
        <div class="card-foot">
          Ordered by value per rupee, with P1 hazards funded first.
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Deferred segments</h2>
          <span class="count-pill warn">${num(plan.deferred_count)} segments · ${currency(plan.deferred_cost)}</span>
        </div>
        <div class="card-body flush">
          ${raw(table(plan.deferred, false, maxRatio))}
        </div>
        <div class="card-foot">
          These continue to decay. Deferring a ${currency(50000)} seal today typically buys a
          reconstruction bill an order of magnitude larger within a few seasons.
        </div>
      </section>
    </div>`;

  /* The donut splits what was spent, so unallocated money has no slice — it is
     not a priority band, and giving it one would make P1's share look smaller
     than the share of the works order it actually is. */
  donut($('#alloc-donut', mount), byBand, {
    centre: currency(plan.allocated),
    centreSub: 'allocated',
    valueLabel: 'Allocated',
    format: (v) => currency(v),
    title: 'Allocated budget by priority band',
  });

  mount.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => { location.hash = `#/segment/${tr.dataset.id}`; });
  });

  mount.querySelectorAll('.show-all').forEach((btn) => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.card').querySelector('.table-wrap');
      const hidden = wrap.querySelectorAll('tr.overflow');
      const showing = btn.dataset.open === '1';
      hidden.forEach((tr) => { tr.hidden = showing; });
      btn.dataset.open = showing ? '0' : '1';
      btn.textContent = showing
        ? `View all ${num(hidden.length + PREVIEW_ROWS)} segments →`
        : 'Show fewer ↑';
    });
  });
}

/* ---------- pieces ---------- */

const BAND_LABELS = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Routine' };
const bandLabel = (code) => BAND_LABELS[code] || code;

/** A thin progress rule under a figure. Decoration for the number above it, so
 *  it is hidden from the reader that would otherwise hear a bare percentage. */
function miniBar(percent, color) {
  const w = Math.max(0, Math.min(100, percent));
  return `<span class="mini-bar" aria-hidden="true">
    <span style="width:${w}%;background:${color}"></span></span>`;
}

/** Value per rupee, as a chip whose tint follows the figure.
 *  Three steps of the accent rather than a green-to-red scale: value per rupee
 *  is a magnitude, and the red/amber/green palette is reserved for the
 *  priority bands, which are states. */
function vprChip(ratio, max) {
  const share = max > 0 ? ratio / max : 0;
  const tier = share >= 0.66 ? 'high' : share >= 0.33 ? 'mid' : 'low';
  return `<span class="vpr ${tier}">${num(ratio * 1e6, 1)}</span>`;
}

function table(rows, funded, maxRatio) {
  if (!rows.length) {
    return emptyState(
      funded ? 'Nothing funded' : 'Nothing deferred',
      funded ? 'Increase the budget to fund the first works.'
             : 'This budget covers the entire backlog.',
      funded ? '💸' : '✅');
  }
  const extra = Math.max(0, rows.length - PREVIEW_ROWS);
  return html`
    <div class="table-wrap">
      <table class="plan-table">
        <thead>
          <tr>
            <th class="rank">#</th>
            <th>Segment</th><th>Priority</th><th>Recommended work</th>
            <th class="num">Cost</th><th class="num">Value/₹${help('value_per_rupee')}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((s, i) => html`
            <tr class="clickable ${raw(i >= PREVIEW_ROWS ? 'overflow' : '')}"
                data-id="${s.id}" ${raw(i >= PREVIEW_ROWS ? 'hidden' : '')}>
              <td class="rank"><span class="rank-n">${i + 1}</span></td>
              <td>
                <div class="cell-title">${s.name}</div>
                <div class="cell-sub">${s.ward || '—'} · RPI ${num(s.rpi, 1)}</div>
              </td>
              <td>${raw(bandChip(s.band_code, '', true))}</td>
              <td style="font-size:12.5px">${s.treatment_name}</td>
              <td class="num">${currency(s.total_cost)}</td>
              <td class="num">${raw(vprChip(s.ratio || 0, maxRatio))}</td>
            </tr>`)}
        </tbody>
      </table>
    </div>
    ${extra > 0 ? html`
      <button type="button" class="show-all" data-open="0">
        View all ${num(rows.length)} segments →</button>` : ''}`;
}
