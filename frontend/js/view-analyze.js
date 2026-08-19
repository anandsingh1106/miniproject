/* Analyse — upload a road image, detect distress, score the segment. */

import {
  $, $$, api, meta, html, raw, esc, currency, num, clamp,
  bandChip, bandColor, damageColor, errorState, debounce,
} from './core.js';

const CONTEXT_FIELDS = [
  'road_class', 'aadt', 'commercial_pct', 'length_m', 'surface_type',
  'last_resurfaced_years', 'accidents_3yr', 'drainage_quality', 'monsoon_exposure',
  'is_emergency_route', 'has_school_zone', 'public_reports',
];

let state = { file: null, result: null, selected: null };

export async function analyzeView(mount) {
  const m = await meta();
  state = { file: null, result: null, selected: null };

  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <h1>Analyse a road image</h1>
        <p class="lede">
          Detection finds the distress. The score turns it into a priority by weighing that
          distress against how much traffic the road carries, how critical it is to the
          network, and how fast it will decay — a badly cracked lane nobody uses does not
          outrank moderate damage on an ambulance route.
        </p>
      </div>
    </div>

    <div class="grid g-side">
      <div>
        <section class="card" style="margin-bottom:16px">
          <div class="card-head"><h2>1 · Road image</h2></div>
          <div class="card-body">
            <div class="dropzone" id="drop" role="button" tabindex="0"
                 aria-label="Choose or drop a road image">
              ${raw(`<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>`)}
              <div class="big">Drop a photo, or click to choose</div>
              <div class="small">JPEG, PNG or WebP · up to 12 MB</div>
            </div>
            <input type="file" id="file" accept="image/*" class="sr-only">
            <div id="preview" style="margin-top:12px"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>2 · Segment context</h2>
            <span class="hint">Drives 60% of the score</span>
          </div>
          <div class="card-body">
            <div class="field">
              <label for="f-name">Segment name</label>
              <input type="text" id="f-name" placeholder="e.g. Karve Road, Kothrud">
            </div>

            <div class="grid g-2" style="gap:12px">
              <div class="field">
                <label for="f-road_class">Road class</label>
                <select id="f-road_class">
                  ${Object.values(m.road_classes).map((c) => html`
                    <option value="${c.code}" ${raw(c.code === 'URB' ? 'selected' : '')}>${c.name}</option>`)}
                </select>
              </div>
              <div class="field">
                <label for="f-surface_type">Surface</label>
                <select id="f-surface_type">
                  ${Object.entries(m.surface_types).map(([k, v]) => html`
                    <option value="${k}">${v}</option>`)}
                </select>
              </div>
            </div>

            <div class="grid g-2" style="gap:12px">
              <div class="field">
                <label for="f-aadt">Traffic (AADT)</label>
                <input type="number" id="f-aadt" value="8000" min="0" step="500">
                <div class="help">Vehicles per day</div>
              </div>
              <div class="field">
                <label for="f-commercial_pct">Commercial %</label>
                <input type="number" id="f-commercial_pct" value="12" min="0" max="100" step="1">
                <div class="help">Trucks and buses do the damage</div>
              </div>
            </div>

            <div class="grid g-2" style="gap:12px">
              <div class="field">
                <label for="f-length_m">Length (m)</label>
                <input type="number" id="f-length_m" value="500" min="10" step="50">
              </div>
              <div class="field">
                <label for="f-last_resurfaced_years">Years since resurfacing</label>
                <input type="number" id="f-last_resurfaced_years" value="6" min="0" step="0.5">
              </div>
            </div>

            <div class="grid g-2" style="gap:12px">
              <div class="field">
                <label for="f-drainage_quality">Drainage</label>
                <select id="f-drainage_quality">
                  <option value="good">Good</option>
                  <option value="fair" selected>Fair</option>
                  <option value="poor">Poor</option>
                </select>
              </div>
              <div class="field">
                <label for="f-monsoon_exposure">Monsoon exposure</label>
                <select id="f-monsoon_exposure">
                  <option value="low">Low</option>
                  <option value="moderate" selected>Moderate</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>

            <div class="grid g-2" style="gap:12px">
              <div class="field">
                <label for="f-accidents_3yr">Crashes (3 yr)</label>
                <input type="number" id="f-accidents_3yr" value="0" min="0" step="1">
              </div>
              <div class="field">
                <label for="f-public_reports">Citizen complaints</label>
                <input type="number" id="f-public_reports" value="0" min="0" step="1">
              </div>
            </div>

            <label class="check">
              <input type="checkbox" id="f-is_emergency_route">
              <span>Emergency route <span class="muted">— hospital, fire or disaster corridor</span></span>
            </label>
            <label class="check">
              <input type="checkbox" id="f-has_school_zone">
              <span>School zone</span>
            </label>

            <hr class="divider">

            <div class="field">
              <label for="f-conf">Detection confidence threshold
                <span class="mono" id="conf-val">0.25</span></label>
              <input type="range" id="f-conf" min="0.05" max="0.8" step="0.05" value="0.25">
              <div class="help">Lower catches more, and reports more false positives.</div>
            </div>

            <label class="check">
              <input type="checkbox" id="f-save" checked>
              <span>Save to the network register</span>
            </label>

            <button class="btn primary" id="run" style="width:100%;margin-top:8px" disabled>
              Detect and score
            </button>
          </div>
        </section>
      </div>

      <div id="results">
        <div class="card"><div class="card-body">
          ${raw(placeholder())}
        </div></div>
      </div>
    </div>`;

  wireUpload(mount);
  $('#f-conf', mount).addEventListener('input', (e) => {
    $('#conf-val', mount).textContent = Number(e.target.value).toFixed(2);
  });
  $('#run', mount).addEventListener('click', () => run(mount, m));
}

function placeholder() {
  return html`<div class="empty">
    ${raw(`<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`)}
    <h3>No analysis yet</h3>
    <p style="margin:0;max-width:38ch;margin-inline:auto">
      Choose a road photograph and set the segment context, then run the detector.
    </p>
  </div>`;
}

/* ---------- upload wiring ---------- */

function wireUpload(mount) {
  const drop = $('#drop', mount);
  const input = $('#file', mount);

  const pick = () => input.click();
  drop.addEventListener('click', pick);
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
  });

  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files?.[0];
    if (f) accept(f, mount);
  });
  input.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) accept(f, mount);
  });
}

function accept(file, mount) {
  if (!file.type.startsWith('image/')) {
    $('#preview', mount).innerHTML = html`
      <div class="alert warn"><span class="ico">⚠</span><div>That is not an image file.</div></div>`;
    return;
  }
  state.file = file;
  const url = URL.createObjectURL(file);
  $('#preview', mount).innerHTML = html`
    <div style="display:flex;gap:11px;align-items:center;padding:9px;background:var(--surface-2);border-radius:var(--radius-sm)">
      <img src="${url}" alt="" style="width:56px;height:44px;object-fit:cover;border-radius:4px;flex:none">
      <div style="flex:1;min-width:0">
        <div style="font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${file.name}</div>
        <div class="muted" style="font-size:12px">${num(file.size / 1024)} KB</div>
      </div>
    </div>`;
  $('#run', mount).disabled = false;
}

/* ---------- run ---------- */

async function run(mount, m) {
  const btn = $('#run', mount);
  const results = $('#results', mount);
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analysing…';
  results.innerHTML = html`<div class="card"><div class="card-body">
    <div class="empty"><div class="spinner" style="margin:0 auto 10px"></div>
    Detecting distress and scoring the segment…</div></div></div>`;

  const fd = new FormData();
  fd.append('image', state.file);
  CONTEXT_FIELDS.forEach((f) => {
    const node = $(`#f-${f}`, mount);
    fd.append(f, node.type === 'checkbox' ? node.checked : node.value);
  });
  fd.append('conf_threshold', $('#f-conf', mount).value);
  fd.append('save', $('#f-save', mount).checked);

  const name = $('#f-name', mount).value.trim();
  if (name) {
    fd.append('segment_name', name);
    fd.append('segment_id', 'SEG-' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 22).replace(/-$/, ''));
  }

  try {
    state.result = await api.analyze(fd);
    renderResults(results, state.result, m, mount);
  } catch (err) {
    results.innerHTML = errorState(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Detect and score';
  }
}

/* ---------- results ---------- */

function renderResults(mount, r, m, formRoot) {
  const s = r.scoring;
  const d = r.detection;
  const t = r.treatment;
  const dets = d.detections;

  const byType = {};
  dets.forEach((x) => {
    byType[x.code] = byType[x.code] || { code: x.code, count: 0, area: 0 };
    byType[x.code].count += 1;
    byType[x.code].area += x.area_ratio;
  });

  mount.innerHTML = html`
    ${d.warnings.map((w) => html`
      <div class="alert warn"><span class="ico" aria-hidden="true">⚠</span><div>${w}</div></div>`)}

    <section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>Detection</h2>
        <span class="hint">
          ${d.engine_label} · ${num(d.inference_ms)} ms ·
          ${num(d.pavement_fraction * 100)}% pavement in frame
        </span>
      </div>
      <div class="card-body tight">
        <div class="viewer" id="viewer">
          <img src="${r.image_url || ''}" alt="Analysed road surface" id="shot">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" id="boxes" aria-hidden="true"></svg>
        </div>
      </div>
      <div class="card-body flush">
        <div class="det-list" id="detlist"></div>
      </div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2>Reconstruction priority</h2>
        ${raw(bandChip(s.band.code, s.band.label))}
      </div>
      <div class="card-body">
        <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:4px">
          <div>
            <div style="font-size:44px;font-weight:650;letter-spacing:-.03em;line-height:1;
                        color:${bandColor(s.band.code)};font-variant-numeric:tabular-nums">
              ${num(s.rpi, 1)}
            </div>
            <div class="muted" style="font-size:12px;margin-top:3px">RPI · out of 100</div>
          </div>
          <div style="flex:1;min-width:150px">
            <div style="font-size:24px;font-weight:600;font-variant-numeric:tabular-nums">
              ${num(s.pci, 0)}<span class="muted" style="font-size:14px;font-weight:450"> / 100</span>
            </div>
            <div class="muted" style="font-size:12px;margin-top:3px">
              Pavement condition — ${s.pci_label.toLowerCase()}
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:600">${s.band.window}</div>
            <div class="muted" style="font-size:12px;margin-top:3px">Response window</div>
          </div>
        </div>

        <hr class="divider">

        <h3 style="margin-bottom:11px">Score composition</h3>
        <div class="breakdown">
          ${(() => {
            // Bar length is each component's share of the total, so the five
            // bars read as a decomposition of the score and always sum to 100%.
            const total = Object.values(s.weighted).reduce((a, b) => a + b, 0) || 1;
            return Object.entries(s.weighted).map(([k, v]) => html`
              <div class="bd-row">
                <span class="k">${LABELS[k]}</span>
                <span class="track"><span class="fill"
                  style="width:${clamp(v / total * 100, 0, 100)}%"></span></span>
                <span class="v">${num(v / total * 100, 0)}%</span>
              </div>`);
          })()}
        </div>
        <p class="muted" style="font-size:12px;margin:11px 0 0">
          Share of the ${num(s.rpi, 1)}-point score. Each component is scored 0–1, then weighted
          (${Object.entries(m.weights).map(([k, w]) => `${LABELS[k].toLowerCase()} ${w}`).join(', ')}).
          ${s.growth_multiplier > 1.01
            ? `A deterioration multiplier of ${num(s.growth_multiplier, 2)}× is then applied.`
            : ''}
        </p>
      </div>
      <div class="card-foot">
        <ul class="rationale">
          ${s.rationale.map((line) => html`
            <li class="${raw(s.overrides.includes(line) ? 'override' : '')}">${line}</li>`)}
        </ul>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Recommended intervention</h2>
        <span class="tag accent">${t.treatment_name}</span>
      </div>
      <div class="card-body">
        <p class="secondary" style="margin-bottom:14px">${t.reason}</p>
        <dl class="kv">
          <dt>Treatment</dt><dd>${t.treatment_name}</dd>
          <dt>Treated area</dt><dd>${num(t.area_sqm)} m²</dd>
          <dt>Rate</dt><dd>₹${num(t.rate_per_sqm)}/m²</dd>
          <dt>Works cost</dt><dd>${currency(t.base_cost, { compact: false })}</dd>
          <dt>Plus mobilisation and traffic management</dt>
          <dd>${currency(t.total_cost - t.base_cost, { compact: false })}</dd>
          <dt style="font-weight:600;color:var(--text-primary)">Total estimate</dt>
          <dd style="font-size:16px">${currency(t.total_cost, { compact: false })}</dd>
          <dt>Design life</dt><dd>${t.life_years ? `${t.life_years} years` : '—'}</dd>
          <dt>Cost per year of life</dt>
          <dd>${t.life_years ? currency(t.cost_per_year, { compact: false }) : '—'}</dd>
        </dl>
        ${t.reasoning ? html`<p class="muted" style="font-size:12px;margin:12px 0 0">${t.reasoning}</p>` : ''}
      </div>
      ${r.saved ? html`
        <div class="card-foot">
          Saved to the register.
          ${r.segment_id ? html`<a href="#/segment/${r.segment_id}">Open the segment record →</a>`
                         : html`<a href="#/network">View the network →</a>`}
        </div>` : ''}
    </section>`;

  drawBoxes(mount, dets);
  drawList(mount, dets, m);
}

const LABELS = {
  distress: 'Pavement distress',
  traffic: 'Traffic exposure',
  network: 'Network criticality',
  safety: 'Safety risk',
  environment: 'Environmental',
};

function drawBoxes(mount, dets) {
  const svg = $('#boxes', mount);
  if (!dets.length) { svg.innerHTML = ''; return; }
  svg.innerHTML = dets.map((d, i) => {
    const c = damageColor(d.code);
    const x = d.x * 100, y = d.y * 100, w = d.w * 100, h = d.h * 100;
    return `<g data-i="${i}">
      <rect class="det-box" x="${x}" y="${y}" width="${w}" height="${h}"
            stroke="${c}" rx="0.6"></rect>
    </g>`;
  }).join('');
}

function drawList(mount, dets, m) {
  const list = $('#detlist', mount);
  if (!dets.length) {
    list.innerHTML = `<div class="empty" style="padding:26px">
      <h3>No distress detected</h3>
      <p style="margin:0">The pavement in this frame is within tolerance,
      or the surface was not clearly visible.</p></div>`;
    return;
  }
  list.innerHTML = dets.map((d, i) => {
    const meta = m.damage_types[d.code] || { name: d.code };
    return html`
      <div class="det-item" data-i="${i}">
        <span class="swatch" style="background:${damageColor(d.code)}"></span>
        <span class="grow">
          <span class="name">${meta.name}</span>
          <span class="meta"> · ${num(d.confidence * 100)}% confidence
            ${d.notes ? ` · ${d.notes}` : ''}</span>
        </span>
        <span class="sev sev-${d.severity}">${d.severity}</span>
      </div>`;
  }).join('');

  // Hovering a row highlights its box, and vice versa.
  const boxes = $$('#boxes g', mount);
  $$('.det-item', mount).forEach((row) => {
    const i = Number(row.dataset.i);
    const on = () => {
      row.classList.add('sel');
      boxes.forEach((b, j) => b.querySelector('rect')
        .classList.toggle('sel', j === i));
      boxes.forEach((b, j) => { b.style.opacity = j === i ? '1' : '.3'; });
    };
    const off = () => {
      row.classList.remove('sel');
      boxes.forEach((b) => {
        b.style.opacity = '1';
        b.querySelector('rect').classList.remove('sel');
      });
    };
    row.addEventListener('mouseenter', on);
    row.addEventListener('mouseleave', off);
  });
}
