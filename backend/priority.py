"""The Reconstruction Priority Index (RPI).

Detecting damage is only half the problem. A network authority with a fixed
budget needs to know *which* damaged road to rebuild first, and "the one with
the most potholes" is the wrong answer — a badly cracked village lane carrying
80 vehicles a day matters less than moderate rutting on the arterial that every
ambulance in the district uses.

RPI answers that. It is a 0-100 score combining five components:

    RPI = 100 x (0.40 D + 0.22 T + 0.18 N + 0.12 S + 0.08 E) x G

    D  Distress      how bad the pavement is, from the detector
    T  Traffic       how many people are exposed to it (AADT, commercial mix)
    N  Network       how much the network depends on this link
    S  Safety        crash history, night-time risk, hazard-type distress
    E  Environment   drainage and monsoon exposure, which set the decay rate
    G  Growth        1.0-1.35 escalation for distress that is compounding fast

Every term is normalised to 0..1 before weighting, so the weights in
`config.RPI_WEIGHTS` mean what they look like they mean. Every score returned
carries the full breakdown plus a plain-English rationale, because a
prioritisation an engineer cannot interrogate is one they will not act on.

Two deliberate departures from a pure weighted sum:

* **Safety override.** A high-severity pothole on a road carrying more than
  10,000 vehicles a day is floored at P2, and at P1 above 25,000, whatever the
  arithmetic says. Weighted averages dilute a genuine hazard, and no road
  authority would accept "it averaged out" as a reason for not fixing one.
* **Growth multiplier is capped.** Deterioration compounds, but a multiplier
  larger than ~1.35 would let a modelling assumption outvote observed condition.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable

from . import config


@dataclass
class SegmentContext:
    """Everything about a road segment that is not in the photograph."""

    road_class: str = "URB"
    aadt: int = 8000                       # annual average daily traffic
    commercial_pct: float = 12.0           # % trucks and buses — they do the damage
    length_m: float = 500.0
    surface_type: str = "BC"
    last_resurfaced_years: float = 6.0
    accidents_3yr: int = 0
    drainage_quality: str = "fair"         # good | fair | poor
    monsoon_exposure: str = "moderate"     # low | moderate | high
    is_emergency_route: bool = False       # hospital / fire / disaster corridor
    has_school_zone: bool = False
    public_reports: int = 0                # citizen complaints logged
    prev_distress_score: float | None = None
    days_since_prev: int | None = None


@dataclass
class RPIResult:
    rpi: float
    band_code: str
    band_label: str
    band_window: str
    band_status: str
    components: dict[str, float] = field(default_factory=dict)
    weighted: dict[str, float] = field(default_factory=dict)
    growth_multiplier: float = 1.0
    pci: float = 100.0
    pci_label: str = "Good"
    distress_density: float = 0.0
    dominant_damage: str | None = None
    overrides: list[str] = field(default_factory=list)
    rationale: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "rpi": round(self.rpi, 1),
            "band": {
                "code": self.band_code, "label": self.band_label,
                "window": self.band_window, "status": self.band_status,
            },
            "components": {k: round(v, 4) for k, v in self.components.items()},
            "weighted": {k: round(v, 4) for k, v in self.weighted.items()},
            "growth_multiplier": round(self.growth_multiplier, 3),
            "pci": round(self.pci, 1),
            "pci_label": self.pci_label,
            "distress_density": round(self.distress_density, 4),
            "dominant_damage": self.dominant_damage,
            "overrides": self.overrides,
            "rationale": self.rationale,
        }


SEVERITY_FACTOR = {"low": 0.45, "medium": 0.80, "high": 1.25}
DRAINAGE_FACTOR = {"good": 0.20, "fair": 0.55, "poor": 1.00}
MONSOON_FACTOR = {"low": 0.20, "moderate": 0.55, "high": 1.00}


# ======================================================================
# Component D — pavement distress
# ======================================================================
def distress_component(detections: Iterable[dict], pavement_fraction: float = 1.0):
    """Aggregate detections into a 0..1 distress score and a 0..100 PCI.

    Each detection contributes `structural_weight x severity x sqrt(area)`.
    Area is square-rooted deliberately: distress severity does not scale
    linearly with extent — the second square metre of alligator cracking tells
    you much less than the first did.
    """
    dets = list(detections)
    if not dets:
        return 0.0, 100.0, 0.0, None, {}

    by_type: dict[str, dict] = {}
    total = 0.0

    for d in dets:
        code = d.get("code")
        meta = config.DAMAGE_TYPES.get(code)
        if not meta:
            continue
        sev = SEVERITY_FACTOR.get(d.get("severity", "low"), 0.45)
        area = max(0.0, float(d.get("area_ratio", 0.0)))
        conf = max(0.0, min(1.0, float(d.get("confidence", 0.5))))

        # Low-confidence detections contribute, but proportionately less.
        contribution = meta["structural_weight"] * sev * math.sqrt(area) * (0.55 + 0.45 * conf)
        total += contribution

        slot = by_type.setdefault(code, {"count": 0, "score": 0.0, "area": 0.0,
                                         "name": meta["name"], "short": meta["short"]})
        slot["count"] += 1
        slot["score"] += contribution
        slot["area"] += area

    # Density normalised against the pavement actually visible, so a photo that
    # is half sky is not scored as half as damaged.
    visible = max(0.12, pavement_fraction)
    density = total / visible

    # Saturating curve: distress score approaches but never reaches 1.0.
    score = 1.0 - math.exp(-2.35 * density)

    # PCI on the familiar 0-100 ASTM-style scale, where 100 is a new pavement.
    pci = 100.0 * math.exp(-2.9 * density)
    pci = max(0.0, min(100.0, pci))

    dominant = max(by_type.items(), key=lambda kv: kv[1]["score"])[0] if by_type else None
    return min(1.0, score), pci, density, dominant, by_type


def pci_label(pci: float) -> str:
    if pci >= 85:
        return "Good"
    if pci >= 70:
        return "Satisfactory"
    if pci >= 55:
        return "Fair"
    if pci >= 40:
        return "Poor"
    if pci >= 25:
        return "Very Poor"
    return "Failed"


# ======================================================================
# Component T — traffic exposure
# ======================================================================
def traffic_component(ctx: SegmentContext) -> float:
    """Exposure rises with volume, but sub-linearly, and heavy vehicles count extra.

    A log curve is used rather than a straight ratio because the jump from 500
    to 5,000 vehicles a day changes the calculus far more than 30,000 to 35,000.
    Commercial share matters on its own: pavement damage scales roughly with the
    fourth power of axle load, so trucks, not cars, consume a road.
    """
    aadt = max(0.0, float(ctx.aadt))
    volume = math.log10(1.0 + aadt) / math.log10(1.0 + config.AADT_SATURATION)
    volume = max(0.0, min(1.0, volume))

    commercial = max(0.0, min(1.0, ctx.commercial_pct / 45.0))
    return max(0.0, min(1.0, 0.72 * volume + 0.28 * commercial))


# ======================================================================
# Component N — network criticality
# ======================================================================
def network_component(ctx: SegmentContext) -> float:
    cls = config.ROAD_CLASSES.get(ctx.road_class, config.ROAD_CLASSES["LOC"])
    score = cls["importance"]
    if ctx.is_emergency_route:
        score = min(1.0, score + 0.22)     # ambulance and fire access
    if ctx.has_school_zone:
        score = min(1.0, score + 0.10)
    return max(0.0, min(1.0, score))


# ======================================================================
# Component S — safety risk
# ======================================================================
def safety_component(detections: Iterable[dict], ctx: SegmentContext) -> float:
    """Blend recorded crashes, citizen reports and hazard-type distress.

    Crash history is the strongest signal but is sparse and lags reality, so
    hazard-weighted distress carries most of the term and complaints act as a
    human-in-the-loop correction on both.
    """
    hazard = 0.0
    for d in detections:
        meta = config.DAMAGE_TYPES.get(d.get("code"))
        if not meta:
            continue
        sev = SEVERITY_FACTOR.get(d.get("severity", "low"), 0.45)
        hazard += meta["safety_weight"] * sev * math.sqrt(max(0.0, float(d.get("area_ratio", 0.0))))
    hazard_n = 1.0 - math.exp(-3.1 * hazard)

    # Crashes normalised per km per year so a 2 km segment is not flattered.
    km = max(0.05, ctx.length_m / 1000.0)
    rate = ctx.accidents_3yr / (km * 3.0)
    crash_n = 1.0 - math.exp(-rate / 2.2)

    reports_n = 1.0 - math.exp(-ctx.public_reports / 9.0)

    score = 0.52 * hazard_n + 0.31 * crash_n + 0.17 * reports_n
    if ctx.has_school_zone:
        score = min(1.0, score * 1.12)
    return max(0.0, min(1.0, score))


# ======================================================================
# Component E — environmental aggravation
# ======================================================================
def environment_component(ctx: SegmentContext) -> float:
    """Water is what actually destroys a bituminous road.

    Poor drainage plus heavy monsoon turns a sealed crack into a failed base in
    one season, so this term raises priority *before* the damage is visible —
    which is the whole point of preventive maintenance.
    """
    drain = DRAINAGE_FACTOR.get(ctx.drainage_quality, 0.55)
    monsoon = MONSOON_FACTOR.get(ctx.monsoon_exposure, 0.55)

    # Age relative to the class design life: an overdue pavement decays faster.
    cls = config.ROAD_CLASSES.get(ctx.road_class, config.ROAD_CLASSES["LOC"])
    age_ratio = min(1.5, ctx.last_resurfaced_years / max(1.0, cls["design_life"]))
    age_n = min(1.0, age_ratio / 1.2)

    return max(0.0, min(1.0, 0.42 * drain + 0.34 * monsoon + 0.24 * age_n))


# ======================================================================
# Growth multiplier
# ======================================================================
def growth_multiplier(detections: Iterable[dict], ctx: SegmentContext) -> tuple[float, str | None]:
    """Escalate segments whose condition is compounding.

    Two sources: the intrinsic growth rate of the distress mix present, and —
    when an earlier inspection exists — the *measured* rate of change, which
    always wins over the model because it is observation rather than assumption.
    """
    dets = list(detections)
    if not dets:
        return 1.0, None

    weights = 0.0
    rate = 0.0
    for d in dets:
        meta = config.DAMAGE_TYPES.get(d.get("code"))
        if not meta:
            continue
        w = SEVERITY_FACTOR.get(d.get("severity", "low"), 0.45)
        rate += meta["growth_rate"] * w
        weights += w
    intrinsic = (rate / weights) if weights else 0.0        # ~0.03..0.15 per month
    mult = 1.0 + min(0.20, intrinsic * 1.45)
    note = None

    if ctx.prev_distress_score is not None and ctx.days_since_prev:
        months = max(0.5, ctx.days_since_prev / 30.44)
        current, _pci, density, _dom, _bt = distress_component(dets)
        delta = (current - ctx.prev_distress_score) / months
        if delta > 0.004:
            observed = min(0.35, delta * 26.0)
            mult = 1.0 + max(mult - 1.0, observed)
            note = (f"Measured deterioration of {delta * 100:.1f} distress points per month "
                    f"since the previous inspection.")
        elif delta < -0.004:
            mult = max(1.0, mult - 0.05)
            note = "Condition improved since the previous inspection — recent work is holding."

    return min(1.35, mult), note


# ======================================================================
# The score
# ======================================================================
def compute_rpi(detections: Iterable[dict], ctx: SegmentContext,
                pavement_fraction: float = 1.0) -> RPIResult:
    dets = list(detections)

    d_score, pci, density, dominant, by_type = distress_component(dets, pavement_fraction)
    t_score = traffic_component(ctx)
    n_score = network_component(ctx)
    s_score = safety_component(dets, ctx)
    e_score = environment_component(ctx)
    g_mult, g_note = growth_multiplier(dets, ctx)

    w = config.RPI_WEIGHTS
    weighted = {
        "distress": w["distress"] * d_score,
        "traffic": w["traffic"] * t_score,
        "network": w["network"] * n_score,
        "safety": w["safety"] * s_score,
        "environment": w["environment"] * e_score,
    }
    base = sum(weighted.values())
    rpi = max(0.0, min(100.0, 100.0 * base * g_mult))

    overrides: list[str] = []

    # --- Safety override -------------------------------------------------
    severe_pothole = any(
        d.get("code") in ("D40", "RUT") and d.get("severity") == "high" for d in dets
    )
    if severe_pothole and ctx.aadt >= 25000 and rpi < 75.0:
        rpi = 75.0
        overrides.append(
            f"Escalated to P1: a high-severity hazard on a road carrying {ctx.aadt:,} "
            f"vehicles a day is an immediate risk regardless of the weighted score."
        )
    elif severe_pothole and ctx.aadt >= 10000 and rpi < 55.0:
        rpi = 55.0
        overrides.append(
            f"Escalated to P2: high-severity hazard on a road carrying {ctx.aadt:,} "
            f"vehicles a day."
        )

    if ctx.is_emergency_route and pci < 50.0 and rpi < 55.0:
        rpi = 55.0
        overrides.append(
            "Escalated to P2: designated emergency route with a PCI below 50 — "
            "response times are affected."
        )

    band = _band_for(rpi)
    result = RPIResult(
        rpi=rpi,
        band_code=band[1], band_label=band[2], band_window=band[3], band_status=band[4],
        components={"distress": d_score, "traffic": t_score, "network": n_score,
                    "safety": s_score, "environment": e_score},
        weighted=weighted,
        growth_multiplier=g_mult,
        pci=pci, pci_label=pci_label(pci),
        distress_density=density,
        dominant_damage=dominant,
        overrides=overrides,
    )
    result.rationale = _rationale(result, ctx, dets, by_type, g_note)
    return result


def _band_for(rpi: float):
    for band in config.PRIORITY_BANDS:
        if rpi >= band[0]:
            return band
    return config.PRIORITY_BANDS[-1]


def _rationale(res: RPIResult, ctx: SegmentContext, dets: list[dict],
               by_type: dict, growth_note: str | None) -> list[str]:
    """Plain-English explanation, ordered by how much each term actually moved
    the score. This is the part an engineer reads before signing off."""
    lines: list[str] = []
    cls = config.ROAD_CLASSES.get(ctx.road_class, config.ROAD_CLASSES["LOC"])

    if not dets:
        lines.append("No distress was detected in the submitted imagery. The score reflects "
                     "traffic exposure and environmental risk only.")
    else:
        counts = ", ".join(
            f"{v['count']} x {v['short'].lower()}"
            for _k, v in sorted(by_type.items(), key=lambda kv: -kv[1]["score"])[:4]
        )
        lines.append(
            f"Detected {len(dets)} distress instance{'s' if len(dets) != 1 else ''} "
            f"({counts}). Pavement condition index {res.pci:.0f}/100 — {res.pci_label.lower()}."
        )

    if res.dominant_damage:
        meta = config.DAMAGE_TYPES[res.dominant_damage]
        lines.append(f"Dominant distress is {meta['name'].lower()}. {meta['description']}")

    top = sorted(res.weighted.items(), key=lambda kv: -kv[1])[:2]
    names = {
        "distress": "the measured pavement condition",
        "traffic": f"traffic exposure ({ctx.aadt:,} AADT, {ctx.commercial_pct:.0f}% commercial)",
        "network": f"network importance ({cls['name']})",
        "safety": "safety risk",
        "environment": f"environmental exposure ({ctx.drainage_quality} drainage, "
                       f"{ctx.monsoon_exposure} monsoon exposure)",
    }
    lines.append(
        "The score is driven mainly by " + names[top[0][0]] +
        (f", then {names[top[1][0]]}." if len(top) > 1 else ".")
    )

    if res.growth_multiplier > 1.02:
        pct = (res.growth_multiplier - 1.0) * 100.0
        lines.append(growth_note or
                     f"Escalated {pct:.0f}% for compounding deterioration — the distress mix "
                     f"present worsens quickly if left untreated.")

    if ctx.is_emergency_route:
        lines.append("Segment is a designated emergency route, which raises its network weight.")
    if ctx.has_school_zone:
        lines.append("Segment falls in a school zone, which raises its safety weight.")

    lines.extend(res.overrides)
    lines.append(f"Result: {res.band_code} {res.band_label} — {res.band_window.lower()}.")
    return lines
