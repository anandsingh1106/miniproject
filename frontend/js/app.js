/* Shell + hash router. */

import {
  $, html, raw, meta, initTheme, toggleTheme, errorState, spinner,
  icon, paintIcons, wireHelp,
} from './core.js';
import { dashboardView } from './view-dashboard.js';
import { analyzeView } from './view-analyze.js';
import { networkView, segmentView } from './view-network.js';
import { budgetView } from './view-budget.js';
import { analyticsView } from './view-analytics.js';
import { methodView } from './view-method.js';

const ROUTES = [
  { path: '/',          nav: 'Dashboard', view: dashboardView },
  { path: '/analyze',   nav: 'Analyse',   view: analyzeView },
  { path: '/network',   nav: 'Network',   view: networkView },
  { path: '/budget',    nav: 'Budget',    view: budgetView },
  { path: '/analytics', nav: 'Analytics', view: analyticsView },
  { path: '/method',    nav: 'Method',    view: methodView },
  { path: '/segment/:id', view: segmentView, hidden: true },
];

initTheme();

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
  $('#shell').innerHTML = html`
    <header class="topbar">
      <div class="brand">
        ${raw(`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 21 9 3h6l5 18" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M12 6.5v3M12 13v3M12 19v1.5" stroke="var(--text-secondary)" stroke-width="1.8" stroke-linecap="round"/>
        </svg>`)}
        RoadLens<span class="brand-sub">Pavement Asset Intelligence</span>
      </div>
      <nav class="nav" id="nav" aria-label="Main"></nav>
      <div class="topbar-right">
        <span class="engine-pill ${raw(heuristic ? 'heuristic' : '')}"
              title="${engine?.active_label || ''}">
          <span class="dot" aria-hidden="true"></span>
          ${heuristic ? 'CV baseline' : 'Neural model'}
        </span>
        <button class="icon-btn" id="theme-btn" title="Toggle light / dark theme"
                aria-label="Toggle colour theme">${icon('moon-star')}</button>
      </div>
    </header>
    <main id="view"></main>`;

  $('#nav').innerHTML = ROUTES.filter((r) => !r.hidden)
    .map((r) => `<a href="#${r.path}" data-path="${r.path}">${r.nav}</a>`).join('');

  $('#theme-btn').addEventListener('click', () => {
    toggleTheme();
    // Charts read colours from CSS at build time, so re-render after a swap.
    router();
  });

  paintIcons($('#shell'));
}

function markActive(path) {
  document.querySelectorAll('#nav a').forEach((a) => {
    const p = a.dataset.path;
    a.classList.toggle('active', p === path || (p === '/network' && path.startsWith('/segment')));
  });
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
  window.scrollTo({ top: 0 });
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
