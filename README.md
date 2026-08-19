# RoadLens — AI road damage detection and reconstruction priority

Detects pavement distress in road imagery, then answers the question that
actually matters to a road authority: **which road do we rebuild first, and
what will it cost?**

Detection alone does not do that. A badly cracked village lane carrying eighty
vehicles a day matters less than moderate rutting on the arterial every
ambulance uses. RoadLens scores each segment on a 0–100 **Reconstruction
Priority Index** combining measured distress with traffic exposure, network
criticality, safety risk and environmental decay — then recommends a treatment,
estimates the cost, and allocates a fixed budget across the network.

```
   photo ─► detection ─► distress + PCI ─┐
                                          ├─► RPI 0–100 ─► priority band
   segment context (traffic, class,     ─┘                      │
   drainage, crashes, monsoon)                                  ▼
                                              treatment ─► cost ─► budget plan
```

---

## Quick start

```bash
pip install -r requirements.txt
python run.py
```

Opens <http://127.0.0.1:8000>. A 28-segment Delhi and Ghaziabad demo network
seeds itself on first run, and six sample road images ship with the app — so you can watch detection,
scoring, treatment selection and budget allocation work end to end within about
thirty seconds of cloning, without finding a road photograph first.

Python 3.10+. No database server, no bundler, no API keys, and no network
access at view time: Leaflet, the Lucide icon set and the Inter font are all
served locally.

### With Docker

```bash
docker compose up --build
```

### Tests

```bash
pip install pytest httpx
pytest                       # 143 tests
python scripts/smoke_check.py   # assert a running deployment is actually useful
```

### Updating frontend assets

`frontend/vendor/` is committed, so npm is only needed to change a dependency:

```bash
npm install                  # runs scripts/vendor.js via postinstall
npm run vendor               # or re-copy assets on demand
python scripts/make_samples.py   # regenerate the sample imagery
```

---

## What it does

**Dashboard** — network condition at a glance, the priority queue, and a map
where marker colour and size both carry the priority band.

**Analyse** — upload a road photograph, set the segment context, get boxed
detections, a scored priority with a full breakdown, a recommended treatment
and a costed estimate. Every result explains itself in plain English.

**Network register** — every segment, sortable and filterable, with the
recommended work and cost per segment.

**Segment detail** — score composition, condition history over successive
inspections, and a live *what-if* panel: change the traffic count or the
drainage rating and watch the priority move.

**Budget** — set an available budget and see what gets funded. Ranking strictly
by priority spends the entire budget on two reconstruction jobs while fifty
cheap sealing jobs go unfunded, so the allocator ranks by **value per rupee**
(priority × years of life bought ÷ cost) while funding every P1 hazard first.

**Analytics** — distress mix, condition by road class, backlog by intervention
type, and network condition over time.

**Method** — a glossary of every term the tool uses, then how each number is
produced and what it cannot tell you. The jargon (RPI, PCI, AADT) also carries
an inline **?** wherever it appears, so nobody has to guess.

Both the register and the budget plan **export to CSV** — filtered and sorted as
shown on screen — so a works order can leave the tool and enter a spreadsheet.

---

## The two engines

Detection is pluggable. The active engine is shown in the header and recorded
on every result, so a score is never ambiguous about its evidence.

| Engine | Status | Notes |
|---|---|---|
| **Morphological CV baseline** | always available | No training, no PyTorch. Ships working. |
| **YOLOv8** | when a checkpoint exists | Drop one at `data/models/road_damage.pt` |

The classical engine is genuine computer vision, not a placeholder — it
segments the pavement, then finds potholes as dark compact blobs against a
morphological background estimate, cracks as *anisotropic* dark linear
structure, and alligator cracking as multi-orientation crack density. Three
details in it are load-bearing and were each a bug first:

- **Potholes run on the un-equalised image.** CLAHE's tiles land at roughly
  pothole scale, so it normalises each pothole up to mid-grey and the cavity
  disappears before the detector sees it.
- **The background estimate is a closing, not a blur, and its kernel must be
  wider than the defect.** A blur wide enough to span a pothole is dragged down
  by the pothole's own darkness, and the deepest part of the cavity reports
  zero contrast.
- **The pavement mask fills its interior holes.** The texture test rejects
  smooth regions — which is exactly what deep shadow, standing water or fresh
  tar inside a pothole looks like. Unfilled, the mask cuts out the very defect
  the detector exists to find.

**It deliberately does not detect ravelling, rutting or edge break.** A
texture-variance ravelling detector was built and then removed: measured across
controlled imagery, the local texture statistics of sound and ravelled pavement
were indistinguishable (25th-percentile sigma 3.2 vs 3.1). Every threshold that
caught real ravelling also flagged sound road — and that error runs in the
expensive direction, recommending resurfacing for a pavement that does not need
it. Those classes stay in the taxonomy and are reported by the neural engine,
which learns them from labelled examples rather than a hand-picked statistic.

It is still a baseline: it will miss cracks in poor light and report shadows
and wet marks as damage. See [`training/`](training/README.md) to replace it
with a model trained on RDD2022 (47,420 annotated images). No reconfiguration —
install a checkpoint and the neural engine takes over on the next request.

---

## The score

```
RPI = 100 × ( 0.40·D + 0.22·T + 0.18·N + 0.12·S + 0.08·E ) × G
```

| | Component | What it captures |
|---|---|---|
| **D** | Distress | `structural_weight × severity × √area` per detection. The square root is deliberate — the second square metre of alligator cracking tells you much less than the first. |
| **T** | Traffic | Log curve on AADT; 500→5,000 vehicles/day matters far more than 30,000→35,000. Commercial share counts separately, because pavement damage scales with roughly the fourth power of axle load. |
| **N** | Network | Road class, plus uplifts for emergency routes and school zones. |
| **S** | Safety | Hazard-weighted distress, crashes per km-year, citizen complaints. |
| **E** | Environment | Drainage and monsoon exposure. Water is what destroys a bituminous road, so this raises priority *before* damage is visible. |
| **G** | Growth | 1.00–1.35 escalation for compounding decay. Where a prior inspection exists the **measured** rate overrides the modelled one. |

Two deliberate departures from a pure weighted sum:

- **Safety override.** A high-severity pothole on a road carrying >10,000
  vehicles/day is floored at P2, and >25,000 at P1, whatever the arithmetic
  says. Weighted averages dilute a genuine hazard, and no authority accepts "it
  averaged out" as a reason for not fixing one.
- **Growth is capped at 1.35**, so a modelling assumption can never outvote
  observed condition.

Bands: **P1** ≥75 (30 days) · **P2** ≥55 (90 days) · **P3** ≥35 (this financial
year) · **P4** monitor.

Alongside RPI, distress density becomes a **PCI** on the familiar 0–100 scale.
PCI drives *what work*; RPI drives *what order*. They can disagree — a quiet
lane at PCI 35 needs reconstruction but does not need it first.

---

## Project layout

```
backend/
  config.py            distress taxonomy, road classes, weights, unit rates
  priority.py          the RPI engine + plain-English rationale
  costing.py           treatment selection, costing, budget allocation
  detection/
    cv_detector.py     classical CV engine (the zero-download baseline)
    yolo_detector.py   neural engine
    registry.py        engine selection
  db.py  main.py  seed.py
frontend/              vanilla ES modules, no build step
  js/charts.js         hand-rolled SVG charts
  vendor/              Leaflet, Lucide, Inter — vendored from npm, committed
  samples/             generated demo road imagery
training/              RDD2022 → YOLO pipeline + evaluation
tests/                 143 tests over scoring, costing, detection and the API
scripts/               asset vendoring, sample generation, deployment smoke check
```

Everything a civil engineer might retune — distress weights, road classes,
component weights, band thresholds, unit rates — lives in `backend/config.py`.
Swap the rates for the local Schedule of Rates and nothing else changes.

---

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/analyze` | Detect + score an uploaded image (multipart) |
| `POST /api/rescore` | Re-score against modified context (powers what-if) |
| `GET  /api/segments` | Network register, latest inspection joined |
| `GET  /api/segments/{id}` | Segment detail + inspection history |
| `GET  /api/budget?amount=` | Allocation plan for a budget |
| `GET  /api/analytics` | Network aggregates |
| `GET  /api/meta` | Taxonomy, classes, weights, active engine |

Interactive docs at `/docs`.

```bash
curl -F image=@road.jpg -F road_class=NH -F aadt=38000 \
     -F drainage_quality=poor -F is_emergency_route=true \
     http://127.0.0.1:8000/api/analyze
```

---

## Limitations

These matter more than the feature list.

- **One photograph is treated as representative of a whole segment.** It
  usually is not. Use several frames per segment and average them; a single
  frame of the worst 3 m of a good road will over-score it, and the reverse is
  just as easy.
- **Severity is inferred from image area, not depth.** A camera cannot see how
  deep a pothole is, and depth is what damages a wheel. Stereo capture or a
  depth sensor is the real fix.
- **No scale reference.** Area is a fraction of visible pavement, not square
  metres. Physical extent needs camera height and angle, or a known marker in
  frame.
- **The classical engine is a baseline.** Train the neural one before trusting
  it on real survey data.
- **Costs are indicative** — typical 2024–25 rates. Replace with the local SoR
  before these numbers reach a budget document.
- **The weights are a defensible starting point, not a calibrated model.** They
  encode engineering judgement about relative importance. Calibrating them
  against an authority's own intervention history would make them much
  stronger.
- **The sample images are procedurally generated, not photographs.** They
  demonstrate the pipeline; they are not evidence of detector accuracy on real
  imagery. They are labelled as synthetic in the UI.
- **The seeded network uses real Delhi and Ghaziabad roads and coordinates, but
  entirely synthetic condition data**, generated from a fixed seed so the demo
  is reproducible. No number in it is a survey result.
- **`AADT_SATURATION` is calibrated for Delhi NCR** (150,000). Lower it for a
  smaller network, or a genuinely busy road there will score no higher than a
  quiet one. Real inspections sit alongside it and are scored by
  exactly the same engine. `POST /api/seed?force=true` regenerates it.

---

## Development

```bash
python run.py --reload           # auto-reload
python run.py --port 9000
```

Data lives in `data/` (SQLite + uploaded images) and is safe to delete — the
demo network re-seeds on next start.
