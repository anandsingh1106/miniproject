# frontend/ui — the design system

Everything here is generic: it knows about buttons, dialogs and colour tokens,
but nothing about roads, segments or priority scores. That is the line to hold
when adding to this folder — anything that mentions the domain belongs in
`frontend/js/` with the views.

```
ui/
  ui.js        components: modal, drawer, confirm, tabs, accordion, menu,
               plus the motion helpers (animate, reveal, countUp)
  theme.js     palette + density switching, saved to localStorage
  themes.css   the presets themselves — token overrides only
```

## Using a component

```js
import { modal, confirm, menu, tabs, accordion, reveal } from '../ui/ui.js';

// A dialog. An action returning false keeps it open (failed validation).
const m = modal({
  title: 'Edit segment',
  content: html`<p>Any markup goes here.</p>`,
  actions: [
    { label: 'Cancel' },
    { label: 'Save', variant: 'primary', onClick: save },
  ],
});
const result = await m.closed;

if (await confirm({ title: 'Delete segment?', danger: true })) …
```

The live gallery at `#/components` renders every component next to the code
that produces it — the fastest way to see what is available.

## Changing the look

Components read CSS custom properties and never hard-code a colour, so
restyling the app means editing tokens, not component rules. Add a preset by
copying a `[data-preset]` block in `themes.css`, renaming it, and adding its id
to `PRESETS` in `theme.js`. Nothing else needs to change.

```js
RoadLensTheme.set('slate');        // default | slate | forest | contrast
RoadLensTheme.density('compact');  // comfortable | compact
```

**Do not retheme the data colours.** The status palette (`--status-*`), the
categorical slots (`--series-*`) and the sequential ramp (`--seq-*`) encode
what a chart *means* — priority bands are states, damage types are identities,
pavement condition is a magnitude. Changing them changes the reading, so every
preset here deliberately leaves them alone.

## Dependencies

`ui.js` imports `esc`/`html`/`paintIcons` from `../js/core.js`, and uses two
vendored globals when present:

- **Floating UI** (`window.FloatingUIDOM`) — anchors menus and tooltips so they
  flip and shift inside scroll containers.
- **Motion** (`window.Motion`) — the animations.

Both are optional at runtime: every component falls back to a working,
unanimated version if the global is missing, so a failed asset copy never
leaves a dialog that cannot be closed. Motion is also skipped entirely when the
visitor prefers reduced motion.
