/* Method — how the score is built, and what it cannot tell you. */

import { meta, html, raw, num, bandColor, damageColor, GLOSSARY, icon } from './core.js?v=25';

export async function methodView(mount) {
  const m = await meta();
  const engines = m.engine.engines;

  mount.innerHTML = html`
    <div class="page-head">
      <div>
        <h1>How RoadLens works</h1>
        <p class="lede">
          Detection, scoring, treatment selection and budget allocation — what each stage
          does, the assumptions it makes, and where those assumptions break.
        </p>
      </div>
    </div>

    <div class="prose">
      <h2>Terms used in this tool</h2>
      <p>
        Road asset management runs on jargon. Every term below also appears as a small
        <strong>?</strong> beside the number it describes, so you never have to come back here.
      </p>
      <div class="card" style="margin:14px 0"><div class="card-body">
        <dl class="glossary">
          ${Object.values(GLOSSARY).map((g) => html`
            <div class="glossary-row">
              <dt>${g.term}</dt>
              <dd>${g.body}</dd>
            </div>`)}
        </dl>
      </div></div>

      <h2>1 · Detection</h2>
      <p>
        An uploaded image goes to whichever detection engine is available. Every result
        records which engine produced it, so a score is never ambiguous about its evidence.
      </p>

      <div class="grid g-2" style="gap:14px;margin:16px 0">
        ${engines.map((e) => html`
          <div class="card"><div class="card-body">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span class="tag ${raw(e.available ? 'accent' : '')}">${e.kind}</span>
              <strong>${e.label}</strong>
            </div>
            <p class="muted" style="font-size:13px;margin:0">${e.detail}</p>
          </div></div>`)}
      </div>

      <h3>The classical baseline</h3>
      <p>
        The morphological engine is not a neural network. It exists so the system works the
        moment it is installed, with no 2.5 GB download and no trained checkpoint. It
        segments the pavement, then runs four detectors over it:
      </p>
      <ul>
        <li><strong>Pavement segmentation</strong> — weakly-coloured, mid-tone, <em>textured</em>
          regions. The texture test is what separates a grey road from a grey sky; colour
          alone cannot, and getting it wrong silently under-scores every photo with the
          horizon in frame.</li>
        <li><strong>Potholes</strong> — dark compact blobs measured against a morphological
          background estimate. A blur wide enough to span a pothole gets dragged down by the
          pothole's own darkness, so the deepest part of the defect disappears; a closing
          erases the defect outright and leaves a clean picture of the intact road.</li>
        <li><strong>Cracks</strong> — the difference between the strongest and weakest
          <em>oriented</em> black-hat response. A crack answers strongly across itself and
          weakly along itself; aggregate speckle answers the same in every direction, so the
          difference isolates real linear structure.</li>
        <li><strong>Alligator cracking</strong> — grid cells where crack density is high in
          several orientations at once, reported as an area rather than as individual cracks.</li>
      </ul>
      <p>
        <strong>It deliberately does not detect ravelling, rutting or edge break.</strong> A
        texture-variance ravelling detector was built and then removed: measured across
        controlled test imagery, the local texture statistics of sound and ravelled pavement
        were indistinguishable (25th-percentile sigma 3.2 versus 3.1). Every threshold that
        caught real ravelling also flagged sound road — and that failure runs in the expensive
        direction, recommending resurfacing for a pavement that does not need it. Those three
        classes stay in the taxonomy and are reported by the trained neural engine, which
        learns them from labelled examples rather than from a hand-picked statistic.
      </p>
      <p>
        Its accuracy is well below a model trained on RDD2022. It is a baseline, and the
        <code>training/</code> directory exists to replace it. Drop a trained checkpoint at
        <code>data/models/road_damage.pt</code> and the neural engine takes over automatically.
      </p>

      <h2>2 · The Reconstruction Priority Index</h2>
      <p>
        Detecting damage is only half the problem. An authority with a fixed budget needs to
        know <em>which</em> damaged road to rebuild first, and "the one with the most
        potholes" is the wrong answer — a badly cracked village lane carrying eighty vehicles
        a day matters less than moderate rutting on the arterial every ambulance uses.
      </p>

      <div class="formula">RPI = 100 × ( ${Object.entries(m.weights).map(([k, w]) => `${w} · ${k[0].toUpperCase()}`).join('  +  ')} ) × G</div>

      <p>Each component is normalised to 0–1 before weighting:</p>
      <ul>
        <li><strong>D · Distress (${m.weights.distress})</strong> — every detection contributes
          <code>structural_weight × severity × √area</code>. The square root is deliberate:
          the second square metre of alligator cracking tells you much less than the first did.</li>
        <li><strong>T · Traffic (${m.weights.traffic})</strong> — a log curve on AADT, because
          500 → 5,000 vehicles a day changes the calculus far more than 30,000 → 35,000.
          Commercial share counts separately: pavement damage scales with roughly the fourth
          power of axle load, so trucks consume a road, not cars.</li>
        <li><strong>N · Network (${m.weights.network})</strong> — road class, plus uplifts for
          emergency routes and school zones.</li>
        <li><strong>S · Safety (${m.weights.safety})</strong> — hazard-weighted distress, crash
          history normalised per km-year, and citizen complaints as a human-in-the-loop check
          on both.</li>
        <li><strong>E · Environment (${m.weights.environment})</strong> — drainage and monsoon
          exposure. Water is what actually destroys a bituminous road, so this term raises
          priority <em>before</em> the damage is visible, which is the entire point of
          preventive maintenance.</li>
        <li><strong>G · Growth (1.00–1.35)</strong> — escalation for compounding deterioration.
          Where an earlier inspection exists the <em>measured</em> rate of change is used and
          overrides the modelled one: observation beats assumption.</li>
      </ul>

      <h3>Two deliberate departures from a weighted sum</h3>
      <p>
        <strong>Safety override.</strong> A high-severity pothole on a road carrying more than
        10,000 vehicles a day is floored at P2, and at P1 above 25,000, whatever the arithmetic
        says. Weighted averages dilute a genuine hazard, and no road authority would accept
        "it averaged out" as a reason for not fixing one.
      </p>
      <p>
        <strong>The growth multiplier is capped at 1.35.</strong> Deterioration compounds, but
        a larger multiplier would let a modelling assumption outvote observed condition.
      </p>

      <h3>Priority bands</h3>
      <div class="grid g-2" style="gap:12px;margin:14px 0">
        ${m.bands.map((b) => html`
          <div class="card"><div class="card-body" style="padding:13px 15px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
              <strong style="color:${bandColor(b.code)}">${b.code} · ${b.label}</strong>
              <span class="mono muted" style="font-size:12px">RPI ≥ ${num(b.min, 0)}</span>
            </div>
            <div class="muted" style="font-size:12.5px;margin-top:3px">${b.window}</div>
          </div></div>`)}
      </div>

      <h2>3 · Condition index and treatment</h2>
      <p>
        Alongside RPI, distress density is converted to a Pavement Condition Index on the
        familiar 0–100 scale where 100 is a new pavement. PCI drives the treatment decision;
        RPI drives the ordering. They answer different questions and they can disagree — a
        quiet lane at PCI 35 needs reconstruction but does not need it <em>first</em>.
      </p>
      <p>Two rules govern treatment selection, and both exist because the obvious ordering gets them wrong:</p>
      <ul>
        <li><strong>A surface treatment cannot fix a structural failure.</strong> Widespread
          alligator cracking and deep rutting both mean the base has gone. An overlay laid
          over that reflects the same cracking back through within a season, so the cheap
          option is not actually cheaper.</li>
        <li><strong>Discrete defects get discrete repairs.</strong> Potholes are checked before
          the overlay rule, because a low condition index driven by three potholes would
          otherwise trigger milling the entire segment — spending lakhs on what a patching
          crew handles in a morning.</li>
      </ul>

      <div class="card" style="margin:16px 0"><div class="card-body flush">
        <div class="table-wrap"><table>
          <thead><tr><th>Treatment</th><th class="num">₹/m²</th><th class="num">Life</th><th>When</th></tr></thead>
          <tbody>
            ${Object.values(m.treatments).map((t) => html`
              <tr>
                <td class="cell-title">${t.name}</td>
                <td class="num">${t.rate_per_sqm ? num(t.rate_per_sqm) : '—'}</td>
                <td class="num">${t.life_years ? `${t.life_years} yr` : '—'}</td>
                <td class="secondary" style="font-size:12.5px">${t.description}</td>
              </tr>`)}
          </tbody>
        </table></div>
      </div></div>

      <h2>4 · Budget allocation</h2>
      <p>
        Funding strictly in RPI order looks correct and is not. It ignores cost, and reliably
        spends an entire budget on two reconstruction jobs while fifty cheap sealing jobs —
        which together prevent far more future damage — go unfunded.
      </p>
      <div class="formula">value per rupee  =  ( RPI × treatment design life ) ÷ cost</div>
      <p>
        Segments are ranked by that ratio, so cheap preventive work on an important road
        scores extremely well — which is what pavement-preservation practice actually
        recommends. P1 Critical segments are funded first regardless of their ratio: a hazard
        is not something a cost-benefit ratio gets to veto.
      </p>

      <h2>5 · Distress taxonomy</h2>
      <p>
        Codes follow the RDD2022 / Japan Road Association convention used by the public Road
        Damage Detection benchmark, extended with three types that matter for reconstruction
        decisions but are absent from that label set.
      </p>
      <div class="card" style="margin:14px 0"><div class="card-body flush">
        <div class="table-wrap"><table>
          <thead>
            <tr><th>Code</th><th>Distress</th><th class="num">Structural</th>
                <th class="num">Safety</th><th>Meaning</th></tr>
          </thead>
          <tbody>
            ${m.damage_order.map((c) => {
              const d = m.damage_types[c];
              return html`
                <tr>
                  <td>
                    <span style="display:inline-flex;align-items:center;gap:7px">
                      <span style="width:9px;height:9px;border-radius:2px;background:${damageColor(c)}"
                            aria-hidden="true"></span>
                      <span class="mono">${c}</span>
                    </span>
                  </td>
                  <td class="cell-title">${d.name}</td>
                  <td class="num">${num(d.structural_weight, 2)}</td>
                  <td class="num">${num(d.safety_weight, 2)}</td>
                  <td class="secondary" style="font-size:12.5px">${d.description}</td>
                </tr>`;
            })}
          </tbody>
        </table></div>
      </div></div>

      <h2>Limitations</h2>
      <p>These matter more than the feature list, so they are stated plainly:</p>
      <ul>
        <li><strong>One photograph is treated as representative of the whole segment.</strong>
          It usually is not. A survey pass with several frames per segment, averaged, is the
          honest way to use this — a single frame of the worst 3 m of a good road will
          over-score it, and the reverse is just as easy to do.</li>
        <li><strong>Severity is inferred from image area, not depth.</strong> A camera cannot
          see how deep a pothole is, and depth is what determines whether it damages a wheel.
          Stereo capture or a depth sensor is the real fix.</li>
        <li><strong>No scale reference.</strong> Area is a fraction of visible pavement, not
          square metres. Physical extent needs camera height and angle, or a known marker
          in frame.</li>
        <li><strong>The classical engine is a baseline.</strong> It will miss cracks in poor
          light and report shadows, tar patches and wet marks as damage. Train the neural
          engine before trusting it on real survey data.</li>
        <li><strong>Costs are indicative.</strong> Rates come from a typical 2024–25 schedule
          and should be replaced with the local SoR before any of these numbers reach a
          budget document.</li>
        <li><strong>The weights are a defensible starting point, not a calibrated model.</strong>
          They encode engineering judgement about relative importance. Calibrating them
          against an authority's own intervention history would make them much stronger.</li>
      </ul>
    </div>`;
}
