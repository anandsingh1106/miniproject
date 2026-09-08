/* Theme preset + density switching.
 *
 * core.js already owns light/dark (initTheme/toggleTheme). This sits beside it
 * and handles the *palette* choice, which is an independent axis: any preset
 * works in both light and dark.
 *
 * Presets are defined entirely in ui/themes.css as data-preset blocks. This
 * module only sets the attribute and remembers the choice, so adding a preset
 * means editing CSS — no change here.
 */

const PRESET_KEY = 'roadlens-preset';
const DENSITY_KEY = 'roadlens-density';

/** Presets that ui/themes.css defines. 'default' means the base app.css tokens. */
export const PRESETS = [
  { id: 'default', label: 'Default', hint: 'Cool grey, indigo accent' },
  { id: 'slate', label: 'Slate', hint: 'Bluer neutrals, higher contrast' },
  { id: 'forest', label: 'Forest', hint: 'Warm ground, green accent' },
  { id: 'contrast', label: 'High contrast', hint: 'Heavy borders, no shadows' },
];

export const DENSITIES = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
];

const root = () => document.documentElement;

/* localStorage throws in some privacy modes; a theme is never worth an
   exception, so every access is guarded. */
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export function getPreset() { return read(PRESET_KEY) || 'default'; }
export function getDensity() { return read(DENSITY_KEY) || 'comfortable'; }

/** Apply a palette preset. Unknown ids fall back to the base tokens. */
export function setPreset(id) {
  const known = PRESETS.some((p) => p.id === id) ? id : 'default';
  if (known === 'default') delete root().dataset.preset;
  else root().dataset.preset = known;
  write(PRESET_KEY, known);
  // Charts read colours from CSS when they are built, so tell the app to
  // repaint. app.js listens for this and re-runs the current route.
  window.dispatchEvent(new CustomEvent('themechange', { detail: { preset: known } }));
  return known;
}

export function setDensity(id) {
  const known = DENSITIES.some((d) => d.id === id) ? id : 'comfortable';
  if (known === 'comfortable') delete root().dataset.density;
  else root().dataset.density = known;
  write(DENSITY_KEY, known);
  window.dispatchEvent(new CustomEvent('themechange', { detail: { density: known } }));
  return known;
}

/** Restore the saved preset/density. Call once at boot, before first paint. */
export function initPresets() {
  const p = getPreset();
  const d = getDensity();
  if (p !== 'default') root().dataset.preset = p;
  if (d !== 'comfortable') root().dataset.density = d;
}

// A tiny console handle, so the look can be tried without editing code:
//   RoadLensTheme.set('slate'); RoadLensTheme.density('compact');
window.RoadLensTheme = {
  set: setPreset,
  density: setDensity,
  get: () => ({ preset: getPreset(), density: getDensity() }),
  presets: PRESETS.map((p) => p.id),
};
