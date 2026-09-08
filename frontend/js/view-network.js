/* Network register + per-segment detail with what-if rescoring. */

import {
  $, $$, api, meta, html, raw, esc, currency, num, clamp, debounce,
  bandChip, bandColor, damageColor, damageChartRows, pciColor, relTime, dateStr,
  emptyState, rpiMeter, icon, help, downloadCSV, toast, paintIcons,
} from './core.js?v=25';
import { hbar, line, sparkline } from './charts.js?v=25';
import { menu, reveal } from '../ui/ui.js?v=25';
import { peekSegment } from './segment-peek.js?v=25';

/* ======================================================================
   Network register
   ====================================================================== */

const sortState = { key: 'rpi', dir: -1 };

/* Sort presets for the "Sort by" control. The sortable column headers write
   the same {key, dir} pair, so the two controls are two ways into one state
   rather than two states that can disagree. */
const SORTS = [
  { id: 'rpi-desc',   label: 'Priority (high to low)',  key: 'rpi',            dir: -1 },
  { id: 'rpi-asc',    label: 'Priority (low to high)',  key: 'rpi',            dir: 1 },
  { id: 'pci-asc',    label: 'Condition (worst first)', key: 'pci',            dir: 1 },
  { id: 'cost-desc',  label: 'Cost (high to low)',      key: 'total_cost',     dir: -1 },
  { id: 'aadt-desc',  label: 'Traffic (busiest first)', key: 'aadt',           dir: -1 },
  { id: 'name-asc',   label: 'Segment name (A–Z)',      key: 'name',           dir: 1 },
];

const PER_PAGE = [10, 25, 50, 0];   // 0 = all

export async function networkView(mount) {
  const [m, data] = await Promise.all([meta(), api.segments()]);
  const wards = [...new Set(data.segments.map((s) => s.ward).filter(Boolean))].sort();
  const bandCount = (code) => data.segments.filter((s) => s.band_code === code).length;

  /* Paging is per visit, not per session: arriving at the register from a
     search and landing on page 3 of the previous visit's filter is a puzzle,
     not a convenience. */
  let page = 1;
  let perPage = 10;

  const bandIcon = { P1: 'alert-triangle', P2: 'alert-circle', P3: 'info', P4: 'leaf' };

  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <h1>Network register</h1>
        <p class="lede">
          Every inspected segment, ranked. Sort by any column — but note that ranking by
          cost alone is what produces a maintenance backlog, which is exactly what the
          priority index exists to prevent.
        </p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="export" aria-haspopup="true" aria-expanded="false">
          ${icon('download')} Export</button>
        <a class="btn primary" href="#/analyze">${icon('plus')} Add an inspection</a>
      </div>
    </div>

    <div class="grid g-5" style="margin-bottom:16px">
      <div class="stat mini">
        <span class="stat-ico" style="color:var(--accent)">${icon('route')}</span>
        <div class="stat-text">
          <div class="value">${num(data.segments.length)}</div>
          <div class="label">Total segments</div>
        </div>
      </div>
      ${m.bands.map((b) => html`
        <div class="stat mini">
          <span class="stat-ico" style="color:${bandColor(b.code)}">${icon(bandIcon[b.code] || 'circle')}</span>
          <div class="stat-text">
            <div class="value" style="color:${bandColor(b.code)}">${num(bandCount(b.code))}</div>
            <div class="label">${b.label} (${b.code})</div>
          </div>
        </div>`)}
    </div>

    <div class="filters">
      <div class="field grow search-field">
        <label for="q" class="sr-only">Search segments</label>
        <span class="sf-ico" aria-hidden="true">${icon('search')}</span>
        <input type="search" id="q" placeholder="Search segment, ward or location…">
      </div>
      <div class="field">
        <label for="f-band">Priority</label>
        <select id="f-band">
          <option value="">All bands</option>
          ${m.bands.map((b) => html`<option value="${b.code}">${b.code} · ${b.label}</option>`)}
        </select>
      </div>
      <div class="field">
        <label for="f-class">Road class</label>
        <select id="f-class">
          <option value="">All classes</option>
          ${Object.values(m.road_classes).map((c) => html`
            <option value="${c.code}">${c.name}</option>`)}
        </select>
      </div>
      <div class="field">
        <label for="f-ward">Ward</label>
        <select id="f-ward">
          <option value="">All wards</option>
          ${wards.map((w) => html`<option value="${w}">${w}</option>`)}
        </select>
      </div>
      <button class="btn" id="reset">Reset</button>
    </div>

    <div id="chips" class="filter-chips" hidden></div>

    <section class="card">
      <div class="card-head table-head">
        <h2 id="count">${num(data.segments.length)} segments</h2>
        <div class="table-tools">
          <span class="hint" id="sum"></span>
          <label class="sort-by">
            <span>Sort by</span>
            <select id="f-sort">
              ${SORTS.map((s) => html`<option value="${s.id}">${s.label}</option>`)}
              <option value="custom" hidden>Custom (column)</option>
            </select>
          </label>
        </div>
      </div>
      <div class="card-body flush">
        <div class="table-wrap">
          <table class="register">
            <thead>
              <tr>
                <th class="rank">#</th>
                <th class="sortable" data-k="name">Segment</th>
                <th class="sortable" data-k="ward">Location</th>
                <th class="sortable" data-k="road_class">Class</th>
                <th class="sortable" data-k="band_code">Priority</th>
                <th class="sortable num" data-k="rpi">RPI</th>
                <th class="sortable num" data-k="pci">PCI</th>
                <th class="sortable num" data-k="aadt">AADT</th>
                <th class="sortable num" data-k="detection_count">Defects</th>
                <th class="sortable" data-k="treatment_name">Recommended work</th>
                <th class="sortable num" data-k="total_cost">Est. cost</th>
                <th class="right">Action</th>
              </tr>
            </thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
      </div>
      <div class="card-foot pager" id="pager"></div>
    </section>`;

  const apply = ({ resetPage = true } = {}) => {
    if (resetPage) page = 1;

    const q = $('#q', mount).value.toLowerCase().trim();
    const band = $('#f-band', mount).value;
    const cls = $('#f-class', mount).value;
    const ward = $('#f-ward', mount).value;

    const rows = data.segments.filter((s) => (
      (!q || s.name.toLowerCase().includes(q) || (s.ward || '').toLowerCase().includes(q))
      && (!band || s.band_code === band)
      && (!cls || s.road_class === cls)
      && (!ward || s.ward === ward)
    ));

    const { key, dir } = sortState;
    rows.sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
    });

    visible = rows;

    // Page the sorted list, and pull a short page back into range when a
    // filter shrinks the result set under the cursor.
    const size = perPage || rows.length || 1;
    const pages = Math.max(1, Math.ceil(rows.length / size));
    if (page > pages) page = pages;
    const from = (page - 1) * size;
    const slice = rows.slice(from, from + size);

    renderRows(mount, slice, from);
    renderPager(mount, { total: rows.length, from, shown: slice.length, page, pages });

    $('#count', mount).textContent = `${num(rows.length)} segment${rows.length === 1 ? '' : 's'}`;
    const cost = rows.reduce((n, s) => n + (s.total_cost || 0), 0);
    $('#sum', mount).textContent = `Total estimated cost: ${currency(cost)}`;

    $$('thead th.sortable', mount).forEach((th) => {
      const active = th.dataset.k === key;
      th.querySelector('.arrow')?.remove();
      if (active) {
        th.insertAdjacentHTML('beforeend', `<span class="arrow">${dir === 1 ? '▲' : '▼'}</span>`);
      }
    });

    // Keep the Sort by control showing what the table is actually doing, even
    // when the sort came from a column header with no preset of its own.
    const preset = SORTS.find((s) => s.key === key && s.dir === dir);
    $('#f-sort', mount).value = preset ? preset.id : 'custom';

    renderChips({ q, band, cls, ward });
  };

  /* ---- pagination ---- */

  function renderPager(host, { total, from, shown, page: p, pages }) {
    const pager = $('#pager', host);
    if (!total) { pager.hidden = true; return; }
    pager.hidden = false;

    // A window of at most five page buttons, centred on the current page —
    // twenty-eight segments is three pages, but the register grows.
    const first = Math.max(1, Math.min(p - 2, pages - 4));
    const nums = [];
    for (let i = first; i <= Math.min(pages, first + 4); i += 1) nums.push(i);

    pager.innerHTML = `
      <span class="pager-count">
        Showing ${num(from + 1)}–${num(from + shown)} of ${num(total)} segments
      </span>
      <div class="pager-controls">
        <button class="page-btn" data-go="prev" ${p === 1 ? 'disabled' : ''}
                aria-label="Previous page"><i data-lucide="chevron-left"></i></button>
        ${nums.map((n) => `<button class="page-btn ${n === p ? 'active' : ''}"
            data-go="${n}" ${n === p ? 'aria-current="page"' : ''}>${n}</button>`).join('')}
        <button class="page-btn" data-go="next" ${p === pages ? 'disabled' : ''}
                aria-label="Next page"><i data-lucide="chevron-right"></i></button>
        <label class="per-page">
          <span class="sr-only">Rows per page</span>
          <select id="f-per">
            ${PER_PAGE.map((n) => `<option value="${n}" ${n === perPage ? 'selected' : ''}>${
              n ? `${n} / page` : 'All'}</option>`).join('')}
          </select>
        </label>
      </div>`;

    pager.querySelectorAll('.page-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const go = btn.dataset.go;
        if (go === 'prev') page = Math.max(1, p - 1);
        else if (go === 'next') page = Math.min(pages, p + 1);
        else page = Number(go);
        apply({ resetPage: false });
        // The table header is the reference point after a page change; the top
        // of the document would put the filters back under the cursor.
        $('.register', host)?.scrollIntoView({ block: 'nearest' });
      });
    });
    $('#f-per', pager).addEventListener('change', (e) => {
      perPage = Number(e.target.value);
      apply();
    });
    paintIcons(pager);
  }

  /* What is filtering the list, stated plainly. Without this the only clue is
     a select somewhere above, which is easy to miss and easy to forget — and a
     forgotten filter is what makes an exported works order wrong. */
  const chipHost = $('#chips', mount);
  function renderChips(f) {
    const bandLabel = (code) => {
      const b = m.bands.find((x) => x.code === code);
      return b ? `${b.code} ${b.label}` : code;
    };
    const clsLabel = (code) => m.road_classes[code]?.name || code;

    const active = [
      f.q && { key: 'q', label: `“${f.q}”`, clear: () => { $('#q', mount).value = ''; } },
      f.band && { key: 'band', label: bandLabel(f.band), clear: () => { $('#f-band', mount).value = ''; } },
      f.cls && { key: 'cls', label: clsLabel(f.cls), clear: () => { $('#f-class', mount).value = ''; } },
      f.ward && { key: 'ward', label: f.ward, clear: () => { $('#f-ward', mount).value = ''; } },
    ].filter(Boolean);

    chipHost.hidden = !active.length;
    if (!active.length) { chipHost.innerHTML = ''; return; }

    chipHost.innerHTML = active.map((a) => `
      <button type="button" class="filter-chip" data-k="${esc(a.key)}">
        <span>${esc(a.label)}</span>
        <i data-lucide="x" aria-hidden="true"></i>
        <span class="sr-only">Remove this filter</span>
      </button>`).join('')
      + `<button type="button" class="filter-chip clear-all" data-k="__all">Clear all</button>`;

    chipHost.querySelectorAll('.filter-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.k === '__all') {
          $('#q', mount).value = '';
          ['#f-band', '#f-class', '#f-ward'].forEach((x) => { $(x, mount).value = ''; });
        } else {
          active.find((a) => a.key === btn.dataset.k)?.clear();
        }
        apply();
      });
    });
    paintIcons(chipHost);
  }

  // Export whatever is currently on screen — filters and sort included, and
  // every matching row rather than the visible page. An export that silently
  // ignores the active filter is a reporting bug waiting to happen when
  // someone pastes it into a works order.
  let visible = [];
  const exportCSV = () => {
    downloadCSV(`roadlens-network-${new Date().toISOString().slice(0, 10)}.csv`, [
      { header: 'Segment', value: (r) => r.name },
      { header: 'Ward', value: (r) => r.ward || '' },
      { header: 'Road class', value: (r) => r.road_class },
      { header: 'Priority band', value: (r) => r.band_code || '' },
      { header: 'Priority label', value: (r) => r.band_label || '' },
      { header: 'RPI', value: (r) => (r.rpi == null ? '' : r.rpi.toFixed(1)) },
      { header: 'PCI', value: (r) => (r.pci == null ? '' : r.pci.toFixed(0)) },
      { header: 'AADT', value: (r) => r.aadt },
      { header: 'Length (m)', value: (r) => r.length_m },
      { header: 'Defects detected', value: (r) => r.detection_count },
      { header: 'Recommended work', value: (r) => r.treatment_name || '' },
      { header: 'Estimated cost (INR)', value: (r) => Math.round(r.total_cost || 0) },
      { header: 'Design life (yr)', value: (r) => r.life_years || '' },
      { header: 'Last inspected', value: (r) => (r.inspected_at || '').slice(0, 10) },
    ], visible);
  };

  /* JSON keeps the full row as the API returned it — useful for anyone piping
     the export into their own tooling rather than a spreadsheet. */
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(visible, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roadlens-network-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${visible.length} segments as JSON`, 'success');
  };

  $('#export', mount).addEventListener('click', (e) => {
    e.stopPropagation();
    menu(e.currentTarget, [
      { label: `CSV — ${visible.length} rows`, icon: 'table', onClick: exportCSV },
      { label: `JSON — ${visible.length} rows`, icon: 'braces', onClick: exportJSON },
    ], { placement: 'bottom-end' });
  });

  $('#q', mount).addEventListener('input', debounce(apply, 160));
  ['#f-band', '#f-class', '#f-ward'].forEach((sel) =>
    $(sel, mount).addEventListener('change', () => apply()));
  $('#f-sort', mount).addEventListener('change', (e) => {
    const s = SORTS.find((x) => x.id === e.target.value);
    if (!s) return;
    sortState.key = s.key;
    sortState.dir = s.dir;
    apply();
  });
  $('#reset', mount).addEventListener('click', () => {
    $('#q', mount).value = '';
    ['#f-band', '#f-class', '#f-ward'].forEach((s) => { $(s, mount).value = ''; });
    apply();
  });
  $$('thead th.sortable', mount).forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (sortState.key === k) sortState.dir *= -1;
      else { sortState.key = k; sortState.dir = (k === 'name' || k === 'ward' || k === 'treatment_name') ? 1 : -1; }
      apply();
    });
  });

  apply();
}

function renderRows(mount, rows, offset = 0) {
  const tbody = $('#rows', mount);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="12">${emptyState(
      'Nothing matches', 'Try clearing a filter.', '🔍')}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((s, i) => html`
    <tr class="clickable" data-id="${s.id}">
      <td class="rank"><span class="rank-n">${offset + i + 1}</span></td>
      <td>
        <div class="cell-title">${s.name}</div>
        <div class="cell-sub">
          ${s.inspected_at ? `Updated: ${relTime(s.inspected_at)}` : 'Not yet inspected'}
          ${s.is_emergency_route ? ' · emergency route' : ''}
          ${s.has_school_zone ? ' · school zone' : ''}</div>
      </td>
      <td class="cell-sub">${s.ward || '—'}</td>
      <td><span class="tag">${s.road_class}</span></td>
      <td>${s.band_code ? bandChip(s.band_code, s.band_label, true) : raw('<span class="muted">—</span>')}</td>
      <td class="num">${raw(rpiMeter(s.rpi, s.band_code))}</td>
      <td class="num">
        <span style="display:inline-flex;align-items:center;gap:6px;justify-content:flex-end">
          <span style="width:8px;height:8px;border-radius:2px;background:${pciColor(s.pci)}"
                aria-hidden="true"></span>${s.pci === null ? '—' : num(s.pci, 0)}
        </span>
      </td>
      <td class="num">${num(s.aadt)}</td>
      <td class="num">${num(s.detection_count)}</td>
      <td>${s.treatment_name || raw('<span class="muted">—</span>')}</td>
      <td class="num">${s.total_cost ? currency(s.total_cost) : '—'}</td>
      <td class="right actions">
        <a class="btn sm view-btn" href="#/segment/${encodeURIComponent(s.id)}">
          View ${raw('<i data-lucide="arrow-right" aria-hidden="true"></i>')}</a>
        <button type="button" class="icon-btn row-menu" data-id="${s.id}"
                aria-haspopup="true" aria-label="More actions for ${s.name}">
          ${icon('more-vertical')}</button>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      // The row opens the quick look; the cell's own controls speak for
      // themselves, so they must not also fire the row's handler.
      if (e.target.closest('.actions')) return;
      if (e.metaKey || e.ctrlKey) { location.hash = `#/segment/${tr.dataset.id}`; return; }
      peekSegment(tr.dataset.id);
    });
  });

  tbody.querySelectorAll('.row-menu').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      menu(btn, [
        { label: 'Open full report', icon: 'external-link',
          onClick: () => { location.hash = `#/segment/${encodeURIComponent(id)}`; } },
        { label: 'Quick look', icon: 'eye', onClick: () => peekSegment(id) },
        { separator: true },
        { label: 'Copy link', icon: 'copy',
          onClick: async () => {
            const url = `${location.origin}${location.pathname}#/segment/${encodeURIComponent(id)}`;
            try {
              await navigator.clipboard.writeText(url);
              toast('Link copied', 'success');
            } catch {
              // Clipboard access needs a secure context, which a plain-http
              // LAN install does not have. Say so rather than failing mutely.
              toast('Could not copy — the clipboard needs HTTPS.', 'warn');
            }
          } },
      ], { placement: 'bottom-end' });
    });
  });

  paintIcons(tbody);
  reveal(tbody, 'tr', { delay: 0.012, duration: 0.26 });
}

/* ======================================================================
   Segment detail
   ====================================================================== */

export async function segmentView(mount, params) {
  const [m, data] = await Promise.all([meta(), api.segment(params.id)]);
  const seg = data.segment;
  const latest = data.latest;
  const history = [...data.history].reverse();      // oldest first for the trend

  if (!latest) {
    mount.innerHTML = html`
      <div class="page-head"><div><h1>${seg.name}</h1>
        <p class="lede">${seg.ward || ''} · ${m.road_classes[seg.road_class]?.name}</p></div>
        <a class="btn" href="#/network">← Network</a></div>
      <div class="card"><div class="card-body">
        ${raw(emptyState('No inspections recorded', 'Analyse an image of this road to score it.', '📷'))}
      </div></div>`;
    return;
  }

  const s = latest.scoring;
  const cost = latest.cost;
  const dets = latest.detections;

  const byType = {};
  dets.forEach((d) => {
    byType[d.code] = byType[d.code] || { code: d.code, count: 0 };
    byType[d.code].count += 1;
  });
  const damageBars = damageChartRows(
    Object.fromEntries(Object.entries(byType).map(([c, v]) => [c, v.count])), m);

  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <a href="#/network" class="muted" style="font-size:13px">← Network register</a>
        <h1 style="margin-top:5px">${seg.name}</h1>
        <p class="lede">
          ${seg.ward ? `${seg.ward} · ` : ''}${m.road_classes[seg.road_class]?.name} ·
          ${num(seg.length_m)} m · ${m.surface_types[seg.surface_type] || seg.surface_type}
          ${seg.is_emergency_route ? ' · emergency route' : ''}
          ${seg.has_school_zone ? ' · school zone' : ''}
        </p>
      </div>
      ${raw(bandChip(s.band.code, s.band.label))}
    </div>

    <div class="grid g-4" style="margin-bottom:16px">
      <div class="stat">
        <div class="label">Priority index${help('RPI')}</div>
        <div class="value" style="color:${bandColor(s.band.code)}">${num(s.rpi, 1)}</div>
        <div class="sub">${s.band.window}</div>
      </div>
      <div class="stat">
        <div class="label">Pavement condition${help('PCI')}</div>
        <div class="value">${num(s.pci, 0)}<small> / 100</small></div>
        <div class="sub">${s.pci_label}</div>
      </div>
      <div class="stat">
        <div class="label">Estimated cost</div>
        <div class="value">${currency(cost.total_cost)}</div>
        <div class="sub">${cost.treatment_name}</div>
      </div>
      <div class="stat">
        <div class="label">Distress found</div>
        <div class="value">${num(dets.length)}</div>
        <div class="sub">Last inspected ${relTime(latest.created_at)}</div>
      </div>
    </div>

    <div class="grid g-main" style="margin-bottom:16px">
      <div>
        ${latest.image_path ? html`
          <section class="card" style="margin-bottom:16px">
            <div class="card-head">
              <h2>Inspection imagery</h2>
              <span class="hint">${latest.engine_label} · ${dateStr(latest.created_at)}</span>
            </div>
            <div class="card-body tight">
              <div class="viewer">
                <img src="/api/image/${latest.image_path}" alt="Road surface at ${esc(seg.name)}">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  ${dets.map((d) => html`<rect class="det-box"
                    x="${d.x * 100}" y="${d.y * 100}" width="${d.w * 100}" height="${d.h * 100}"
                    stroke="${damageColor(d.code)}" rx="0.6"></rect>`)}
                </svg>
              </div>
            </div>
          </section>` : ''}

        <section class="card" style="margin-bottom:16px">
          <div class="card-head">
            <h2>Why this score</h2>
            <span class="hint">RPI ${num(s.rpi, 1)}</span>
          </div>
          <div class="card-body">
            <div class="breakdown" style="margin-bottom:16px">
              ${(() => {
                const total = Object.values(s.weighted).reduce((a, b) => a + b, 0) || 1;
                return Object.entries(s.weighted).map(([k, v]) => html`
                  <div class="bd-row">
                    <span class="k">${COMP[k]}</span>
                    <span class="track"><span class="fill"
                      style="width:${clamp(v / total * 100, 0, 100)}%"></span></span>
                    <span class="v">${num(v / total * 100, 0)}%</span>
                  </div>`);
              })()}
            </div>
            <ul class="rationale">
              ${s.rationale.map((l) => html`
                <li class="${raw(s.overrides.includes(l) ? 'override' : '')}">${l}</li>`)}
            </ul>
          </div>
        </section>

        ${history.length > 1 ? html`
          <section class="card">
            <div class="card-head">
              <h2>Condition history</h2>
              <span class="hint">${history.length} inspections</span>
            </div>
            <div class="card-body"><div id="hist"></div></div>
            <div class="card-foot">
              Priority rises as condition falls. When both move together the pavement is
              decaying faster than the response window assumes.
            </div>
          </section>` : ''}

        <section class="card" style="margin-top:16px">
          <div class="card-head"><h2>Segment attributes</h2></div>
          <div class="card-body">
            <dl class="kv" style="grid-template-columns:auto 1fr auto 1fr;gap:9px 22px">
              <dt>Road class</dt><dd>${m.road_classes[seg.road_class]?.name}</dd>
              <dt>Traffic (AADT)</dt><dd>${num(seg.aadt)}</dd>
              <dt>Commercial share</dt><dd>${num(seg.commercial_pct)}%</dd>
              <dt>Length</dt><dd>${num(seg.length_m)} m</dd>
              <dt>Since resurfacing</dt><dd>${num(seg.last_resurfaced_years, 1)} yr</dd>
              <dt>Crashes (3 yr)</dt><dd>${num(seg.accidents_3yr)}</dd>
              <dt>Drainage</dt><dd style="text-transform:capitalize">${seg.drainage_quality}</dd>
              <dt>Monsoon exposure</dt><dd style="text-transform:capitalize">${seg.monsoon_exposure}</dd>
              <dt>Citizen reports</dt><dd>${num(seg.public_reports)}</dd>
              <dt>Surface</dt><dd>${m.surface_types[seg.surface_type] || seg.surface_type}</dd>
            </dl>
          </div>
        </section>
      </div>

      <div>
        <section class="card" style="margin-bottom:16px">
          <div class="card-head"><h2>Recommended work</h2></div>
          <div class="card-body">
            <div class="tag accent" style="margin-bottom:10px">${cost.treatment_name}</div>
            <p class="secondary" style="font-size:13px">${s.treatment_reason || cost.description}</p>
            <dl class="kv">
              <dt>Area</dt><dd>${num(cost.area_sqm)} m²</dd>
              <dt>Rate</dt><dd>₹${num(cost.rate_per_sqm)}/m²</dd>
              <dt>Total</dt><dd>${currency(cost.total_cost, { compact: false })}</dd>
              <dt>Design life</dt><dd>${cost.life_years || '—'} yr</dd>
              <dt>Per year</dt>
              <dd>${cost.life_years ? currency(cost.cost_per_year, { compact: false }) : '—'}</dd>
            </dl>
          </div>
        </section>

        ${damageBars.length ? html`
          <section class="card" style="margin-bottom:16px">
            <div class="card-head"><h2>Distress mix</h2></div>
            <div class="card-body"><div id="dmg"></div></div>
          </section>` : ''}

        <section class="card">
          <div class="card-head">
            <h2>What-if</h2>
            <span class="hint">Rescores live</span>
          </div>
          <div class="card-body">
            <p class="muted" style="font-size:12.5px;margin-bottom:14px">
              Change an assumption and watch the priority move. The detected distress stays
              fixed — only the context changes.
            </p>
            <div class="field">
              <label for="w-aadt">Traffic (AADT) <span class="mono" id="w-aadt-v">${num(seg.aadt)}</span></label>
              <input type="range" id="w-aadt" min="500" max="60000" step="500" value="${seg.aadt}">
            </div>
            <div class="field">
              <label for="w-class">Road class</label>
              <select id="w-class">
                ${Object.values(m.road_classes).map((c) => html`
                  <option value="${c.code}" ${raw(c.code === seg.road_class ? 'selected' : '')}>${c.name}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="w-drain">Drainage</label>
              <select id="w-drain">
                ${['good', 'fair', 'poor'].map((v) => html`
                  <option value="${v}" ${raw(v === seg.drainage_quality ? 'selected' : '')}
                    style="text-transform:capitalize">${v}</option>`)}
              </select>
            </div>
            <label class="check">
              <input type="checkbox" id="w-emerg" ${raw(seg.is_emergency_route ? 'checked' : '')}>
              <span>Emergency route</span>
            </label>
            <hr class="divider">
            <div id="whatif"></div>
          </div>
        </section>
      </div>
    </div>`;

  if (damageBars.length) {
    hbar($('#dmg', mount), damageBars, {
      valueLabel: 'Instances', labelWidth: 96, barH: 15, gap: 12,
      title: 'Distress instances by type',
    });
  }

  if (history.length > 1) {
    const cats = history.map((h) => dateStr(h.created_at));
    line($('#hist', mount), [
      {
        name: 'Pavement condition (PCI)',
        color: 'var(--series-1)',
        points: history.map((h, i) => ({ x: cats[i], y: h.pci || 0 })),
      },
      {
        name: 'Reconstruction priority (RPI)',
        color: 'var(--series-2)',
        points: history.map((h, i) => ({ x: cats[i], y: h.rpi || 0 })),
      },
    ], { yMax: 100, format: (v) => num(v, 0), title: 'Condition and priority over time' });
  }

  wireWhatIf(mount, seg, latest, m);
}

const COMP = {
  distress: 'Pavement distress',
  traffic: 'Traffic exposure',
  network: 'Network criticality',
  safety: 'Safety risk',
  environment: 'Environmental',
};

function wireWhatIf(mount, seg, latest, m) {
  const out = $('#whatif', mount);
  const baseline = latest.scoring.rpi;

  const run = debounce(async () => {
    out.innerHTML = '<div class="muted" style="font-size:12.5px">Rescoring…</div>';
    const ctx = {
      ...(latest.scoring.context || {}),
      road_class: $('#w-class', mount).value,
      aadt: Number($('#w-aadt', mount).value),
      drainage_quality: $('#w-drain', mount).value,
      is_emergency_route: $('#w-emerg', mount).checked,
      length_m: seg.length_m,
      commercial_pct: seg.commercial_pct,
      accidents_3yr: seg.accidents_3yr,
      monsoon_exposure: seg.monsoon_exposure,
      has_school_zone: !!seg.has_school_zone,
      public_reports: seg.public_reports,
      last_resurfaced_years: seg.last_resurfaced_years,
    };
    try {
      const r = await api.rescore({
        detections: latest.detections,
        context: ctx,
        pavement_fraction: latest.pavement_fraction || 1,
      });
      const s = r.scoring;
      const delta = s.rpi - baseline;
      out.innerHTML = html`
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
          <span style="font-size:28px;font-weight:650;letter-spacing:-.025em;
                       color:${bandColor(s.band.code)};font-variant-numeric:tabular-nums">
            ${num(s.rpi, 1)}
          </span>
          ${raw(bandChip(s.band.code, s.band.label, true))}
          <span class="muted" style="font-size:12.5px">
            ${delta === 0 ? 'unchanged'
              : `${delta > 0 ? '+' : ''}${num(delta, 1)} vs. recorded ${num(baseline, 1)}`}
          </span>
        </div>
        <p class="secondary" style="font-size:12.5px;margin:10px 0 0">
          ${r.treatment.treatment_name} · ${currency(r.treatment.total_cost)}
        </p>`;
    } catch (err) {
      out.innerHTML = `<div class="muted" style="font-size:12.5px">Could not rescore: ${esc(err.message)}</div>`;
    }
  }, 180);

  $('#w-aadt', mount).addEventListener('input', (e) => {
    $('#w-aadt-v', mount).textContent = num(e.target.value);
    run();
  });
  ['#w-class', '#w-drain', '#w-emerg'].forEach((sel) =>
    $(sel, mount).addEventListener('change', run));
  run();
}
