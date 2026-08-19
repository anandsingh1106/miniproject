/* Budget allocation — what to fund this cycle, and what gets deferred. */

import {
  $, api, html, raw, currency, num, bandChip, bandColor, emptyState, debounce,
} from './core.js';
import { allocationBar } from './charts.js';

const PRESETS = [
  { label: '₹5 Cr', value: 50_000_000 },
  { label: '₹15 Cr', value: 150_000_000 },
  { label: '₹30 Cr', value: 300_000_000 },
  { label: '₹50 Cr', value: 500_000_000 },
];

export async function budgetView(mount) {
  let amount = 150_000_000;

  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <h1>Budget allocation</h1>
        <p class="lede">
          Ranking by priority alone spends the whole budget on two reconstruction jobs while
          fifty cheap sealing jobs go unfunded — and those fifty prevent far more future
          damage. This allocator ranks by value per rupee (priority × years of life bought,
          divided by cost), then funds every P1 hazard first regardless of its ratio.
        </p>
      </div>
    </div>

    <div class="filters">
      <div class="field grow">
        <label for="amt">Available budget — <span class="mono" id="amt-label"></span></label>
        <input type="range" id="amt" min="10000000" max="1000000000" step="10000000" value="${amount}">
      </div>
      <div class="field">
        <label>Presets</label>
        <div class="seg-control" id="presets">
          ${PRESETS.map((p) => html`<button data-v="${p.value}">${p.label}</button>`)}
        </div>
      </div>
    </div>

    <div id="out"></div>`;

  const label = $('#amt-label', mount);
  const slider = $('#amt', mount);

  const refresh = debounce(async () => {
    label.textContent = currency(amount);
    $('#presets button', mount);
    mount.querySelectorAll('#presets button').forEach((b) =>
      b.classList.toggle('active', Number(b.dataset.v) === amount));
    await render($('#out', mount), amount);
  }, 140);

  slider.addEventListener('input', (e) => {
    amount = Number(e.target.value);
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

  label.textContent = currency(amount);
  await render($('#out', mount), amount);
  mount.querySelectorAll('#presets button').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.v) === amount));
}

async function render(mount, amount) {
  const plan = await api.budget(amount);

  mount.innerHTML = html`
    ${plan.unfunded_critical > 0 ? html`
      <div class="alert critical" role="alert">
        <span class="ico" aria-hidden="true">●</span>
        <div>
          <strong>${num(plan.unfunded_critical)} critical segment${raw(plan.unfunded_critical === 1 ? '' : 's')}
          cannot be funded at this budget.</strong>
          P1 works are funded ahead of everything else, so this is a genuine shortfall rather
          than a ranking artefact. A further ${currency(plan.shortfall)} clears the full backlog.
        </div>
      </div>` : ''}

    <div class="grid g-4" style="margin-bottom:16px">
      <div class="stat">
        <div class="label">Funded this cycle</div>
        <div class="value">${num(plan.funded_count)}</div>
        <div class="sub">of ${num(plan.funded_count + plan.deferred_count)} segments needing work</div>
      </div>
      <div class="stat">
        <div class="label">Allocated</div>
        <div class="value">${currency(plan.allocated)}</div>
        <div class="sub">${currency(plan.remaining)} unspent</div>
      </div>
      <div class="stat">
        <div class="label">Backlog coverage</div>
        <div class="value">${num(plan.coverage_pct, 0)}<small>%</small></div>
        <div class="sub">of ${currency(plan.total_required)} required</div>
      </div>
      <div class="stat">
        <div class="label">Shortfall</div>
        <div class="value" style="color:${plan.shortfall > 0 ? bandColor('P1') : 'inherit'}">
          ${currency(plan.shortfall)}
        </div>
        <div class="sub">${plan.shortfall > 0 ? 'Deferred to a later cycle' : 'Full backlog covered'}</div>
      </div>
    </div>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>Spend against backlog</h2>
        <span class="hint">${currency(plan.allocated)} of ${currency(plan.total_required)}</span>
      </div>
      <div class="card-body"><div id="alloc"></div></div>
    </section>

    <div class="grid g-2">
      <section class="card">
        <div class="card-head">
          <h2>Funded</h2>
          <span class="hint">${num(plan.funded_count)} segments · ${currency(plan.allocated)}</span>
        </div>
        <div class="card-body flush">
          ${raw(table(plan.funded, true))}
        </div>
        <div class="card-foot">
          Ordered by value per rupee, with P1 hazards funded first.
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Deferred</h2>
          <span class="hint">${num(plan.deferred_count)} segments · ${currency(plan.shortfall)}</span>
        </div>
        <div class="card-body flush">
          ${raw(table(plan.deferred, false))}
        </div>
        <div class="card-foot">
          These continue to decay. Deferring a ${currency(50000)} seal today typically buys a
          reconstruction bill an order of magnitude larger within a few seasons.
        </div>
      </section>
    </div>`;

  allocationBar($('#alloc', mount), plan.allocated, Math.max(0, plan.total_required - plan.allocated), {
    fundedLabel: `Funded — ${currency(plan.allocated)}`,
    deferredLabel: `Unfunded backlog — ${currency(plan.shortfall)}`,
  });

  mount.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => { location.hash = `#/segment/${tr.dataset.id}`; });
  });
}

function table(rows, funded) {
  if (!rows.length) {
    return emptyState(
      funded ? 'Nothing funded' : 'Nothing deferred',
      funded ? 'Increase the budget to fund the first works.'
             : 'This budget covers the entire backlog.',
      funded ? '💸' : '✅');
  }
  return html`
    <div class="table-wrap" style="max-height:520px;overflow-y:auto">
      <table>
        <thead>
          <tr>
            <th>Segment</th><th>Priority</th><th>Work</th>
            <th class="num">Cost</th><th class="num">Value/₹</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((s) => html`
            <tr class="clickable" data-id="${s.id}">
              <td>
                <div class="cell-title">${s.name}</div>
                <div class="cell-sub">${s.ward || ''} · ${s.road_class} · PCI ${num(s.pci, 0)}</div>
              </td>
              <td>${raw(bandChip(s.band_code, '', true))}</td>
              <td style="font-size:12.5px">${s.treatment_name}</td>
              <td class="num">${currency(s.total_cost)}</td>
              <td class="num muted" style="font-size:12px">${num(s.ratio * 1e6, 1)}</td>
            </tr>`)}
        </tbody>
      </table>
    </div>`;
}
