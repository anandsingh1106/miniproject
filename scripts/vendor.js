#!/usr/bin/env node
/* Copy the browser-ready files out of node_modules into frontend/vendor/.
 *
 * The app has no bundler on purpose — it is plain ES modules served straight by
 * FastAPI, which keeps `python run.py` the only step needed to run it. But
 * loading libraries from a CDN would make the page depend on the public
 * internet at view time, which is wrong for a tool meant to run on a municipal
 * network or a laptop in the field. Vendoring gets both: real dependencies,
 * managed by npm, served locally.
 *
 * node_modules/ is gitignored; frontend/vendor/ is committed, so a fresh clone
 * runs without npm at all.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'frontend', 'vendor');

const COPY = [
  // Leaflet — map rendering
  ['leaflet/dist/leaflet.js', 'leaflet/leaflet.js'],
  ['leaflet/dist/leaflet.css', 'leaflet/leaflet.css'],
  ['leaflet/dist/images/marker-icon.png', 'leaflet/images/marker-icon.png'],
  ['leaflet/dist/images/marker-icon-2x.png', 'leaflet/images/marker-icon-2x.png'],
  ['leaflet/dist/images/marker-shadow.png', 'leaflet/images/marker-shadow.png'],
  ['leaflet/dist/images/layers.png', 'leaflet/images/layers.png'],
  ['leaflet/dist/images/layers-2x.png', 'leaflet/images/layers-2x.png'],

  // Lucide — icon set
  ['lucide/dist/umd/lucide.min.js', 'lucide/lucide.min.js'],

  // Floating UI — anchor positioning for tooltips and popovers. UMD builds,
  // because there is no bundler here to resolve the bare specifier that the
  // ESM build imports. Core must load before dom: dom reads it as a global.
  ['@floating-ui/core/dist/floating-ui.core.umd.min.js',
   'floating-ui/floating-ui.core.umd.min.js'],
  ['@floating-ui/dom/dist/floating-ui.dom.umd.min.js',
   'floating-ui/floating-ui.dom.umd.min.js'],

  // Motion — animation engine (UMD, standalone, exposes window.Motion).
  // Drives the reveal/stagger helpers in js/ui.js and respects
  // prefers-reduced-motion at the call site.
  ['motion/dist/motion.js', 'motion/motion.js'],

  // Inter — variable font, self-hosted (no Google Fonts call)
  ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
   'inter/inter-latin-wght-normal.woff2'],
];

function copy(from, to) {
  const src = path.join(ROOT, 'node_modules', from);
  const dest = path.join(OUT, to);
  if (!fs.existsSync(src)) {
    console.warn(`  skip (not found): ${from}`);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(1);
  console.log(`  ${to.padEnd(42)} ${kb.padStart(8)} KB`);
  return true;
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.error('node_modules/ not found. Run: npm install');
    process.exit(1);
  }
  console.log('Vendoring browser assets into frontend/vendor/\n');
  const ok = COPY.filter(([from, to]) => copy(from, to)).length;
  console.log(`\n${ok}/${COPY.length} assets vendored.`);
  if (ok < COPY.length) {
    console.error('Some assets were missing — check package versions.');
    process.exit(1);
  }
}

main();
