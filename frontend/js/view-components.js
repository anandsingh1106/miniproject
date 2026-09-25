/* Component gallery — a live reference for ui/ui.js.
 *
 * Every block below is both the rendered component and the code that produces
 * it, so this page doubles as the documentation: change a component and the
 * gallery shows the change immediately. Linked from the Method page.
 */

import { html, raw, esc, $, toast } from './core.js?v=26';
import {
  modal, drawer, confirm, tabs, accordion, menu, reveal, countUp, animate, reducedMotion,
} from '../ui/ui.js?v=26';
import { PRESETS, DENSITIES, setPreset, setDensity, getPreset, getDensity } from '../ui/theme.js?v=26';

/** A code sample shown under each demo. */
const code = (src) => html`<pre class="ui-code"><code>${src.trim()}</code></pre>`;

export async function componentsView(mount) {
  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <h1>Component gallery</h1>
        <p class="lede">
          Every interactive piece in <code>ui/ui.js</code>, live. Each one is styled
          from the same tokens as the rest of the app, so it follows whichever
          palette you pick. Copy the snippet under a demo to use it in a view.
        </p>
      </div>
    </div>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Appearance</h2>
        <span class="hint">defined in ui/themes.css</span></div>
      <div class="card-body">
        <p class="muted" style="margin-top:0">
          Palette and density are independent of light/dark — every preset works in both.
          The choice is saved, so it survives a reload.
        </p>
        <div class="ui-demo-row">
          <div class="field">
            <label for="c-preset">Palette</label>
            <select id="c-preset">
              ${raw(PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)} — ${esc(p.hint)}</option>`).join(''))}
            </select>
          </div>
          <div class="field">
            <label for="c-density">Density</label>
            <select id="c-density">
              ${raw(DENSITIES.map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join(''))}
            </select>
          </div>
        </div>
        ${code(`import { setPreset, setDensity } from '../ui/theme.js?v=26';
setPreset('slate');        // default | slate | forest | contrast
setDensity('compact');     // comfortable | compact

// or from the browser console, with no code change:
RoadLensTheme.set('forest');`)}
      </div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Dialogs</h2></div>
      <div class="card-body">
        <div class="ui-demo-row">
          <button class="btn" id="d-modal">Open modal</button>
          <button class="btn" id="d-form">Modal with a form</button>
          <button class="btn" id="d-drawer">Open drawer</button>
          <button class="btn danger" id="d-confirm">Confirm (danger)</button>
        </div>
        <p class="muted" style="font-size:12.5px">
          Focus is trapped while open and restored on close; Escape and the backdrop
          both dismiss. An action returning <code>false</code> keeps the dialog open.
        </p>
        ${code(`import { modal, confirm } from '../ui/ui.js?v=26';

const m = modal({
  title: 'Edit segment',
  content: html\`<p>Any markup goes here.</p>\`,
  actions: [
    { label: 'Cancel' },
    { label: 'Save', variant: 'primary', onClick: async () => {
        if (!valid()) { toast('Fix the errors', 'error'); return false; }  // stays open
        await save();
      } },
  ],
});
const result = await m.closed;

if (await confirm({ title: 'Delete segment?', danger: true })) …`)}
      </div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Dropdown menu</h2></div>
      <div class="card-body">
        <div class="ui-demo-row">
          <button class="btn" id="d-menu" aria-haspopup="true" aria-expanded="false">
            Actions ▾
          </button>
        </div>
        <p class="muted" style="font-size:12.5px">
          Anchored with Floating UI, so it flips and shifts to stay on screen even
          inside a scrolling card. Arrow keys move, Escape closes.
        </p>
        ${code(`import { menu } from '../ui/ui.js?v=26';

menu(button, [
  { label: 'Export CSV', icon: 'download', hint: '⌘E', onClick: exportCsv },
  { label: 'Duplicate', icon: 'copy', onClick: dup },
  { separator: true },
  { label: 'Delete', icon: 'trash-2', danger: true, onClick: del },
], { placement: 'bottom-end' });`)}
      </div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Tabs</h2></div>
      <div class="card-body">
        <div class="ui-tabs" id="d-tabs">
          <div class="ui-tablist">
            <button data-tab="overview" class="active">Overview</button>
            <button data-tab="detail">Detail</button>
            <button data-tab="raw">Raw</button>
          </div>
          <div data-panel="overview">
            <p class="muted">Panels are plain elements — put anything in them.</p>
          </div>
          <div data-panel="detail">
            <p class="muted">Arrow keys, Home and End move between tabs.</p>
          </div>
          <div data-panel="raw">
            <p class="muted">Only the selected panel is in the accessibility tree.</p>
          </div>
        </div>
        ${code(`<div class="ui-tabs">
  <div class="ui-tablist">
    <button data-tab="a" class="active">A</button>
    <button data-tab="b">B</button>
  </div>
  <div data-panel="a">…</div>
  <div data-panel="b">…</div>
</div>

tabs(root, { onChange: (key) => … });`)}
      </div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Accordion</h2></div>
      <div class="card-body">
        <div class="ui-accordion" id="d-acc">
          <details class="ui-accordion-item" open>
            <summary>How is RPI calculated?</summary>
            <div class="ui-accordion-body">
              Built on native <code>&lt;details&gt;</code>, so it works without JavaScript
              and is keyboard-operable for free.
            </div>
          </details>
          <details class="ui-accordion-item">
            <summary>What does single mode do?</summary>
            <div class="ui-accordion-body">
              Opening one item closes the others.
            </div>
          </details>
          <details class="ui-accordion-item">
            <summary>Is it animated?</summary>
            <div class="ui-accordion-body">
              The body fades in — unless the visitor prefers reduced motion.
            </div>
          </details>
        </div>
        ${code(`accordion(root, { single: true });`)}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Motion</h2>
        <span class="hint">${raw(reducedMotion()
          ? 'reduced motion is on — animations are skipped'
          : 'respects prefers-reduced-motion')}</span></div>
      <div class="card-body">
        <div class="ui-demo-row">
          <button class="btn" id="d-count">Count up</button>
          <button class="btn" id="d-reveal">Stagger reveal</button>
          <button class="btn" id="d-shake">Shake (invalid)</button>
        </div>
        <div class="ui-demo-row" style="align-items:baseline;gap:26px">
          <div class="stat"><span class="label">Segments</span>
            <span class="value" id="d-num">0</span></div>
          <div class="ui-demo-boxes" id="d-boxes">
            ${raw('<div class="ui-demo-box"></div>'.repeat(5))}
          </div>
        </div>
        ${code(`import { countUp, reveal, animate } from '../ui/ui.js?v=26';

countUp($('#total'), 1284);                    // animated number
reveal(view, '.card');                         // staggered entrance
animate(el, { transform: ['translateX(0)', 'translateX(-6px)',
                          'translateX(6px)', 'translateX(0)'] }, { duration: .3 });`)}
      </div>
    </section>`;

  /* ----- wiring ----- */

  const preset = $('#c-preset', mount);
  const density = $('#c-density', mount);
  preset.value = getPreset();
  density.value = getDensity();
  // A palette change re-renders the whole route (app.js listens for
  // themechange), which rebuilds this view — so no manual repaint here.
  preset.addEventListener('change', () => setPreset(preset.value));
  density.addEventListener('change', () => setDensity(density.value));

  $('#d-modal', mount).addEventListener('click', () => {
    modal({
      title: 'Segment SR-114',
      content: html`<p style="margin-top:0">
          Anything can go in the body — markup, a form, a chart.
        </p>
        <p class="muted" style="margin-bottom:0">
          Try Tab: focus stays inside. Escape closes.
        </p>`,
      actions: [
        { label: 'Close' },
        { label: 'Got it', variant: 'primary' },
      ],
    });
  });

  $('#d-form', mount).addEventListener('click', () => {
    const m = modal({
      title: 'Add a segment',
      content: html`
        <div class="field" style="margin-bottom:12px">
          <label for="m-name">Segment name</label>
          <input id="m-name" placeholder="e.g. Ward 7 — Link Road">
        </div>
        <div class="field">
          <label for="m-class">Road class</label>
          <select id="m-class">
            <option>Arterial</option><option>Collector</option><option>Local</option>
          </select>
        </div>`,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save',
          variant: 'primary',
          onClick: () => {
            const v = $('#m-name', m.body).value.trim();
            if (!v) {
              toast('Give the segment a name', 'error');
              // Returning false keeps the dialog open.
              animate($('#m-name', m.body).parentElement, {
                transform: ['translateX(0)', 'translateX(-5px)', 'translateX(5px)', 'translateX(0)'],
              }, { duration: 0.25 });
              return false;
            }
            toast(`Saved “${v}”`, 'success');
            return v;
          },
        },
      ],
    });
  });

  $('#d-drawer', mount).addEventListener('click', () => {
    drawer({
      title: 'Filters',
      side: 'right',
      content: html`<p class="muted" style="margin-top:0">
        A drawer takes the same options as a modal — good for filter panels
        and detail views that should not cover the page.
      </p>`,
      actions: [{ label: 'Apply', variant: 'primary' }],
    });
  });

  $('#d-confirm', mount).addEventListener('click', async () => {
    const ok = await confirm({
      title: 'Delete segment SR-114?',
      body: 'This removes its detections and scores. It cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    toast(ok ? 'Deleted' : 'Cancelled', ok ? 'success' : 'info');
  });

  $('#d-menu', mount).addEventListener('click', (e) => {
    e.stopPropagation();
    menu(e.currentTarget, [
      { label: 'Export CSV', icon: 'download', hint: 'E', onClick: () => toast('Exported', 'success') },
      { label: 'Duplicate', icon: 'copy', onClick: () => toast('Duplicated') },
      { label: 'Unavailable', icon: 'ban', disabled: true },
      { separator: true },
      { label: 'Delete', icon: 'trash-2', danger: true, onClick: () => toast('Deleted', 'warn') },
    ]);
  });

  tabs($('#d-tabs', mount));
  accordion($('#d-acc', mount), { single: true });

  const runCount = () => countUp($('#d-num', mount), 1284);
  $('#d-count', mount).addEventListener('click', runCount);
  runCount();

  $('#d-reveal', mount).addEventListener('click', () =>
    reveal($('#d-boxes', mount), '.ui-demo-box', { delay: 0.06 }));

  $('#d-shake', mount).addEventListener('click', (e) =>
    animate(e.currentTarget, {
      transform: ['translateX(0)', 'translateX(-6px)', 'translateX(6px)', 'translateX(0)'],
    }, { duration: 0.3 }));
}
