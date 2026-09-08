/* Shell + hash router. */

import {
  $, api, html, raw, meta, initTheme, errorState, spinner,
  icon, paintIcons, wireHelp, debounce, num, esc, setTheme, currentTheme,
} from './core.js?v=25';
import { dashboardView } from './view-dashboard.js?v=25';
import { analyzeView } from './view-analyze.js?v=25';
import { networkView, segmentView } from './view-network.js?v=25';
import { budgetView } from './view-budget.js?v=25';
import { analyticsView } from './view-analytics.js?v=25';
import { methodView } from './view-method.js?v=25';
import { initPresets, setPreset, setDensity, getPreset, getDensity, PRESETS, DENSITIES }
  from '../ui/theme.js?v=25';
import { menu, reveal } from '../ui/ui.js?v=25';
import { componentsView } from './view-components.js?v=25';
import { mapView } from './view-map.js?v=25';
import { profile } from './profile.js?v=25';

const ROUTES = [
  { path: '/',          nav: 'Dashboard', icon: 'layout-dashboard', view: dashboardView },
  { path: '/analyze',   nav: 'Analyse',   icon: 'scan-line',        view: analyzeView },
  { path: '/network',   nav: 'Network',   icon: 'list',             view: networkView },
  { path: '/map',       nav: 'Map View',  icon: 'map-pin',          view: mapView },
  { path: '/budget',    nav: 'Budget',    icon: 'wallet',           view: budgetView },
  { path: '/analytics', nav: 'Analytics', icon: 'chart-line',       view: analyticsView },
  { path: '/method',    nav: 'Method',    icon: 'book-open',        view: methodView },
  { path: '/components', nav: 'Components', icon: 'component',      view: componentsView },
  { path: '/segment/:id', view: segmentView, hidden: true },
];

/* The nav is grouped: the first five are the daily workflow, the rest is
   reference. A flat list of eight reads as undifferentiated; two short groups
   are scannable. */
const NAV_GROUPS = [
  { label: 'Main',     paths: ['/', '/analyze', '/network', '/map', '/budget'] },
  { label: 'Insights', paths: ['/analytics', '/method', '/components'] },
];

initTheme();
initPresets();

function match(hash) {
  const path = (hash.replace(/^#/, '') || '/').split('?')[0];
  for (const r of ROUTES) {
    if (!r.path.includes(':')) {
      if (r.path === path) return { route: r, params: {} };
      continue;
    }
    const rp = r.path.split('/').filter(Boolean);
    const pp = path.split('/').filter(Boolean);
    if (rp.length !== pp.length) continue;
    const params = {};
    const ok = rp.every((seg, i) => {
      if (seg.startsWith(':')) { params[seg.slice(1)] = decodeURIComponent(pp[i]); return true; }
      return seg === pp[i];
    });
    if (ok) return { route: r, params };
  }
  return { route: ROUTES[0], params: {} };
}

function renderShell(engine) {
  const heuristic = engine?.active_kind !== 'neural';
  const p = profile();
  /* Drawn in `currentColor` throughout: the mark now sits inside a filled
     accent badge (css/skin.css), where the old accent-on-surface stroke would
     have disappeared into the fill. */
  const mark = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 21 9 3h6l5 18" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M12 6.5v3M12 13v3M12 19v1.5" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" opacity=".6"/>
    </svg>`;

  $('#shell').innerHTML = html`
    <aside class="sidebar" id="sidebar">
      <div class="side-brand">
        ${raw(mark)}
        <span class="side-brand-text">
          RoadLens<small>Pavement Asset Intelligence</small>
        </span>
      </div>
      <nav class="side-nav" id="nav" aria-label="Main"></nav>
      <div class="side-foot">
        <div class="side-card">
          <div class="side-card-art" aria-hidden="true">${icon('trees')}</div>
          <div class="side-card-title">Better roads,<br>safer communities</div>
          <span class="engine-pill ${raw(heuristic ? 'heuristic' : '')}"
                title="${engine?.active_label || ''}">
            <span class="dot" aria-hidden="true"></span>
            ${heuristic ? 'CV baseline' : 'Neural model'}
          </span>
        </div>
      </div>
    </aside>

    <div class="scrim" id="scrim" hidden></div>

    <div class="content">
      <header class="topbar" id="topbar">
        <button class="icon-btn nav-toggle" id="nav-toggle" aria-label="Open navigation"
                aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button>
        <div class="crumb" id="crumb"></div>

        <form class="topsearch" id="topsearch" role="search" autocomplete="off">
          ${icon('search')}
          <input type="search" id="topsearch-input" aria-label="Search segments"
                 placeholder="Search a segment or ward…"
                 aria-controls="topsearch-results" aria-expanded="false">
          <div class="topsearch-results" id="topsearch-results" hidden></div>
        </form>

        <div class="topbar-right">
          <button class="icon-btn search-toggle" id="search-toggle"
                  aria-label="Search segments">${icon('search')}</button>
          <button class="icon-btn has-badge" id="alerts-btn"
                  title="Segments needing attention" aria-haspopup="true"
                  aria-expanded="false" aria-label="Segments needing attention">
            ${icon('bell')}</button>

          <div class="theme-switch" role="group" aria-label="Colour theme">
            <button id="theme-light" title="Light theme"
                    aria-label="Light theme" aria-pressed="false">${icon('sun')}</button>
            <button id="theme-dark" title="Dark theme"
                    aria-label="Dark theme" aria-pressed="false">${icon('moon')}</button>
          </div>

          <button class="profile-chip" id="profile-btn" aria-haspopup="true"
                  aria-expanded="false">
            <span class="avatar" aria-hidden="true">${p.initials}</span>
            <span class="who">
              <span class="who-name">${p.name}</span>
              ${p.role ? html`<span class="who-role">${p.role}</span>` : ''}
            </span>
            ${icon('chevron-down')}
          </button>
        </div>
      </header>
      <main id="view"></main>
    </div>`;

  $('#nav').innerHTML = NAV_GROUPS.map((g) => `
    <div class="side-group">
      <div class="side-group-label">${g.label}</div>
      ${g.paths.map((path) => {
        const r = ROUTES.find((x) => x.path === path);
        if (!r) return '';
        return `<a href="#${r.path}" data-path="${r.path}">
          <i data-lucide="${r.icon}" aria-hidden="true"></i><span>${r.nav}</span></a>`;
      }).join('')}
    </div>`).join('');

  /* Mobile: the rail slides over the content and the scrim closes it. */
  const setNav = (open) => {
    document.body.classList.toggle('nav-open', open);
    $('#scrim').hidden = !open;
    $('#nav-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  $('#nav-toggle').addEventListener('click', () =>
    setNav(!document.body.classList.contains('nav-open')));
  $('#scrim').addEventListener('click', () => setNav(false));
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) setNav(false); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setNav(false);
  });

  wireSearch();
  wireAlerts();

  /* Theme switch. Both halves are always present and one is always pressed,
     so the control shows the current theme rather than only the next one —
     which is what a lone toggle icon leaves ambiguous. Charts sample their
     colours from CSS when they are built, so a swap re-renders the view. */
  const syncTheme = () => {
    const dark = currentTheme() === 'dark';
    $('#theme-light').setAttribute('aria-pressed', dark ? 'false' : 'true');
    $('#theme-dark').setAttribute('aria-pressed', dark ? 'true' : 'false');
  };
  $('#theme-light').addEventListener('click', () => { setTheme('light'); router(); });
  $('#theme-dark').addEventListener('click', () => { setTheme('dark'); router(); });
  syncTheme();

  /* Appearance lives in the profile menu now: palette presets and density,
     both defined in ui/themes.css. A tick marks the active choice. */
  $('#profile-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const active = getPreset();
    const density = getDensity();
    menu(e.currentTarget, [
      ...PRESETS.map((x) => ({
        label: x.label + (x.id === active ? '  ✓' : ''),
        icon: 'swatch-book',
        onClick: () => setPreset(x.id),
      })),
      { separator: true },
      ...DENSITIES.map((d) => ({
        label: d.label + (d.id === density ? '  ✓' : ''),
        icon: 'rows-3',
        onClick: () => setDensity(d.id),
      })),
      { separator: true },
      { label: 'How the score works', icon: 'book-open',
        onClick: () => { location.hash = '#/method'; } },
    ], { placement: 'bottom-end' });
  });

  // A palette swap changes the CSS custom properties the charts sampled when
  // they were built, so the current view is rebuilt from scratch.
  window.addEventListener('themechange', () => { syncTheme(); router(); });

  // The display name is settable from the console; keep the chip in step
  // without tearing down the shell and its listeners.
  window.addEventListener('profilechange', () => {
    const now = profile();
    $('#profile-btn .avatar').textContent = now.initials;
    $('#profile-btn .who-name').textContent = now.name;
    // The role line is only rendered when there is a role to show, so a
    // profile that has none has nothing to update here.
    const role = $('#profile-btn .who-role');
    if (role) role.textContent = now.role;
  });

  paintIcons($('#shell'));
}

/* ==========================================================================
   Global search
   ==========================================================================
   Finding a named segment used to mean Network → type into the filter. The
   top bar now does it from anywhere: the panel offers the first few matches
   for a jump straight to the report, and Enter hands the whole query to the
   Network view so the result is a filtered, sortable, exportable list rather
   than a dead end.
   ========================================================================== */

/* Set by a search submit, consumed by the Network view on its next render.
   A module variable rather than a query string because the hash is the
   router's, and #/network?q=… would need every other view to tolerate it. */
let pendingQuery = '';

function wireSearch() {
  const form = $('#topsearch');
  const input = $('#topsearch-input');
  const panel = $('#topsearch-results');
  const bar = $('#topbar');
  let seq = 0;

  const close = () => {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };

  const run = debounce(async () => {
    const q = input.value.trim();
    // One letter matches most of the network — not a useful list.
    if (q.length < 2) { close(); return; }
    const mine = ++seq;
    let rows;
    try {
      rows = (await api.segments({ q })).segments;
    } catch {
      // A failed lookup is not worth an error state in the chrome; the
      // Network view will report it properly if the user presses Enter.
      close();
      return;
    }
    if (mine !== seq) return;   // a later keystroke already answered
    panel.innerHTML = rows.length
      ? rows.slice(0, 6).map((r) => `
          <button type="button" data-id="${esc(r.id)}">
            <i data-lucide="map-pin" aria-hidden="true"></i>
            <span class="r-main">
              <span class="r-name">${esc(r.name)}</span>
              <span class="r-sub">${esc(r.ward || '—')}${r.rpi === null || r.rpi === undefined
                ? '' : ` · RPI ${num(r.rpi, 1)}`}</span>
            </span>
          </button>`).join('')
      : `<div class="r-empty">No segment or ward matches “${esc(q)}”.</div>`;
    paintIcons(panel);
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }, 200);

  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (panel.innerHTML) panel.hidden = false; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); }
  });

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    close();
    input.value = '';
    location.hash = `#/segment/${encodeURIComponent(btn.dataset.id)}`;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    close();
    if (!q) return;
    pendingQuery = q;
    const here = (location.hash.replace(/^#/, '') || '/').split('?')[0];
    // Already on Network: the hash will not change, so nothing would re-render.
    if (here === '/network') router();
    else location.hash = '#/network';
  });

  // Clicking anywhere else dismisses the panel.
  document.addEventListener('click', (e) => { if (!form.contains(e.target)) close(); });

  // Narrow screens: the field is hidden behind its own icon.
  $('#search-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = bar.classList.toggle('search-open');
    if (open) input.focus(); else close();
  });
}

/** Fill the Network view's filter from a search submit, once. */
function applyPendingQuery(view, path) {
  if (!pendingQuery || path !== '/network') return;
  const term = pendingQuery;
  pendingQuery = '';
  const q = $('#q', view);
  if (!q) return;
  q.value = term;
  q.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ==========================================================================
   Attention bell
   ==========================================================================
   The count is the P1 backlog — the same number the dashboard leads with, put
   where it is visible from every page. The menu jumps straight to the worst
   offenders, which is the action the count implies.
   ========================================================================== */

let alertCache = { at: 0, rows: [] };

async function loadAlerts({ maxAge = 30_000 } = {}) {
  if (Date.now() - alertCache.at < maxAge) return alertCache.rows;
  const rows = (await api.segments({ band: 'P1' })).segments;
  alertCache = { at: Date.now(), rows };
  return rows;
}

function paintAlertBadge(count) {
  const btn = $('#alerts-btn');
  if (!btn) return;
  btn.querySelector('.badge')?.remove();
  if (!count) return;
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = count > 99 ? '99+' : String(count);
  btn.append(b);
  btn.setAttribute('aria-label', `${count} segment${count === 1 ? '' : 's'} at P1 Critical`);
}

async function refreshAlerts() {
  try {
    paintAlertBadge((await loadAlerts()).length);
  } catch {
    // The badge is an affordance, not a feature — a failed poll stays silent.
  }
}

function wireAlerts() {
  $('#alerts-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const anchor = e.currentTarget;
    let rows = [];
    try { rows = await loadAlerts({ maxAge: 0 }); } catch { /* fall through */ }
    paintAlertBadge(rows.length);
    menu(anchor, rows.length ? [
      ...rows.slice(0, 6).map((r) => ({
        label: `${r.name} — RPI ${num(r.rpi, 1)}`,
        icon: 'alert-circle',
        onClick: () => { location.hash = `#/segment/${encodeURIComponent(r.id)}`; },
      })),
      { separator: true },
      { label: rows.length > 6 ? `All ${rows.length} critical segments` : 'Open the network list',
        icon: 'list', onClick: () => { location.hash = '#/network'; } },
    ] : [
      { label: 'Nothing at P1 Critical', icon: 'check-circle-2', disabled: true },
    ], { placement: 'bottom-end' });
  });
}

function markActive(path) {
  document.querySelectorAll('#nav a').forEach((a) => {
    const p = a.dataset.path;
    a.classList.toggle('active', p === path || (p === '/network' && path.startsWith('/segment')));
  });
  // The sidebar no longer carries the page name, so the topbar states where
  // you are — including for /segment/:id, which has no nav entry of its own.
  const crumb = document.getElementById('crumb');
  if (crumb) {
    const r = ROUTES.find((x) => x.path === path);
    crumb.textContent = r?.nav || (path.startsWith('/segment') ? 'Segment' : '');
  }
}

let token = 0;
async function router() {
  const { route, params } = match(location.hash);
  const mine = ++token;
  const view = $('#view');
  markActive(route.path);
  view.innerHTML = spinner();
  try {
    await route.view(view, params);
  } catch (err) {
    if (mine !== token) return;
    console.error(err);
    view.innerHTML = errorState(err);
  }
  if (mine !== token) return;
  // Views emit icon placeholders and help affordances as plain markup; both are
  // activated here, once, rather than in every view.
  paintIcons(view);
  wireHelp(view);
  applyPendingQuery(view, route.path);
  reveal(view, '.card');
  window.scrollTo({ top: 0 });
  // Cached for 30s, so navigating around does not re-fetch on every hop.
  refreshAlerts();
}

window.addEventListener('hashchange', router);

(async function boot() {
  try {
    const m = await meta();
    renderShell(m.engine);
  } catch (err) {
    document.getElementById('shell').innerHTML =
      `<main style="padding:40px 20px;max-width:640px;margin:0 auto">
        ${errorState(new Error(
          'Could not reach the RoadLens API. Make sure the server is running — python run.py'
        ))}
        <p class="muted" style="font-size:13px">${err.message}</p>
      </main>`;
    return;
  }
  await router();
})();
