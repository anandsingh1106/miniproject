"""Treatment selection, cost estimation and budget allocation.

Priority tells you the order. This module answers the two questions that follow
immediately: *what work* does this segment need, and *what will it cost* — and
then, given a fixed budget, which set of segments to fund.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import config
from .priority import SegmentContext


@dataclass
class CostEstimate:
    treatment: str
    treatment_name: str
    description: str
    area_sqm: float
    rate_per_sqm: float
    base_cost: float
    total_cost: float
    life_years: int
    cost_per_year: float
    reasoning: str

    def to_dict(self) -> dict:
        return {
            "treatment": self.treatment,
            "treatment_name": self.treatment_name,
            "description": self.description,
            "area_sqm": round(self.area_sqm, 1),
            "rate_per_sqm": self.rate_per_sqm,
            "base_cost": round(self.base_cost),
            "total_cost": round(self.total_cost),
            "life_years": self.life_years,
            "cost_per_year": round(self.cost_per_year),
            "reasoning": self.reasoning,
            "currency": config.CURRENCY,
        }


def recommend_treatment(pci: float, detections, ctx: SegmentContext) -> tuple[str, str]:
    """Pick the intervention, following standard pavement-preservation logic.

    Two rules govern the ordering, and both exist because the obvious ordering
    gets them wrong:

    * **A surface treatment cannot fix a structural failure.** Widespread
      alligator cracking and deep rutting both mean the base has gone. An
      overlay laid over that reflects the same cracking back through within a
      season, so the cheap option is not actually cheaper.
    * **Discrete defects get discrete repairs.** Potholes are checked *before*
      the overlay rule, because a low condition index driven by three potholes
      would otherwise trigger milling the entire segment — spending lakhs to
      fix what a patching crew handles in a morning.
    """
    dets = list(detections)
    structural = [d for d in dets if d.get("code") in ("D20", "RUT")
                  and d.get("severity") in ("medium", "high")]
    potholes = [d for d in dets if d.get("code") == "D40"]
    cracks = [d for d in dets if d.get("code") in ("D00", "D10")]
    surface = [d for d in dets if d.get("code") in ("RAV", "EDG")]

    area = lambda ds: sum(float(d.get("area_ratio", 0.0)) for d in ds)  # noqa: E731
    structural_area = area(structural)
    total_area = area(dets)
    pothole_dominant = (
        potholes and not structural and total_area > 0
        and area(potholes) > 0.6 * total_area
    )

    # 1 — the base has failed.
    if pci < 40 or structural_area > 0.16 or len(structural) >= 4:
        return "reconstruct", (
            "Widespread fatigue cracking and rutting indicate the base course has failed. "
            "A surface treatment would reflect the same cracking back through within a "
            "season, so full-depth reconstruction is the only durable option."
        )

    # 2 — discrete potholes on a pavement that is otherwise intact.
    if pothole_dominant and pci >= 45:
        return "patch", (
            f"Distress is concentrated in {len(potholes)} discrete pothole"
            f"{'s' if len(potholes) != 1 else ''} on an otherwise sound pavement. "
            "Full-depth patching removes the hazard without the cost of resurfacing "
            "the whole segment."
        )

    # 3 — the surface course itself is worn through.
    if pci < 58 or (structural and (potholes or pci < 65)):
        return "overlay", (
            "The surface course is worn through in places but the base is still sound. "
            "Milling 40 mm and relaying restores ride quality and seals the pavement "
            "before water reaches the base."
        )

    # 4 — early structural or texture loss. Sealing alone is not enough here:
    #     alligator cracking, however light, means fatigue has started.
    if structural or surface or (pci < 80 and len(cracks) >= 3):
        return "micro", (
            "Early-stage fatigue or texture loss on a structurally sound pavement. "
            "Micro-surfacing restores skid resistance and seals the wearing course, "
            "which crack sealing alone would not achieve here."
        )

    # 5 — isolated cracking.
    if cracks or potholes:
        return "crack_seal", (
            "Isolated cracking on a structurally sound pavement. Sealing now prevents "
            "water ingress and costs roughly a tenth of the overlay it defers."
        )

    return "monitor", (
        "No intervention is warranted. Condition is within tolerance for this road class; "
        "re-inspect at the next scheduled cycle."
    )


def estimate_cost(treatment: str, ctx: SegmentContext, detections=None,
                  pci: float = 100.0) -> CostEstimate:
    """Cost the recommended work.

    Localised treatments (patching, crack sealing) are priced on the *affected*
    area, not the whole segment — the distinction matters, because pricing a
    pothole repair as if it covered the full carriageway would overstate it by
    two orders of magnitude and wreck the budget allocation downstream.
    """
    meta = config.TREATMENTS.get(treatment, config.TREATMENTS["monitor"])
    cls = config.ROAD_CLASSES.get(ctx.road_class, config.ROAD_CLASSES["LOC"])
    full_area = max(1.0, ctx.length_m * cls["width_m"])

    dets = list(detections or [])
    if treatment in ("patch", "crack_seal"):
        # Affected fraction from detections, with a floor so a real defect is
        # never costed at zero, and a ceiling above which a localised repair
        # stops making sense.
        frac = sum(float(d.get("area_ratio", 0.0)) for d in dets)
        frac = max(0.015, min(0.35, frac))
        area = full_area * frac
        note = f" Priced on the {frac * 100:.0f}% of the segment showing distress."
    else:
        area = full_area
        note = ""

    base = area * meta["rate_per_sqm"]

    # Mobilisation and traffic management. Both are a much larger share of a
    # small job than a large one, and both cost more on a busy road.
    if base > 0:
        mobilisation = max(18000.0, base * 0.06)
        traffic_mgmt = base * (0.11 if ctx.aadt > 20000 else 0.06 if ctx.aadt > 8000 else 0.03)
        total = base + mobilisation + traffic_mgmt
    else:
        total = 0.0

    life = meta["life_years"]
    return CostEstimate(
        treatment=treatment,
        treatment_name=meta["name"],
        description=meta["description"],
        area_sqm=area,
        rate_per_sqm=meta["rate_per_sqm"],
        base_cost=base,
        total_cost=total,
        life_years=life,
        cost_per_year=(total / life) if life else 0.0,
        reasoning=note.strip(),
    )


# ----------------------------------------------------------------------
# Budget allocation
# ----------------------------------------------------------------------
def allocate_budget(segments: list[dict], budget: float) -> dict:
    """Choose what to fund this cycle.

    Not simply "fund the highest RPI until the money runs out". That ranking
    ignores cost, and reliably spends an entire budget on two reconstruction
    jobs while fifty cheap sealing jobs — which together prevent far more
    future damage — go unfunded.

    Instead segments are ranked by *value per rupee*, where value is the
    priority score amortised over the design life of the treatment. Cheap
    preventive work on an important road scores extremely well, which is what
    pavement-preservation practice actually recommends.

    P1 Critical segments are funded first regardless of their ratio: a hazard
    is not something a cost-benefit ratio gets to veto.
    """
    scored = []
    for s in segments:
        cost = float(s.get("total_cost") or 0.0)
        rpi = float(s.get("rpi") or 0.0)
        life = max(1, int(s.get("life_years") or 1))
        if cost <= 0:
            continue
        # Value = priority x years of life bought, per rupee spent.
        ratio = (rpi * life) / cost
        scored.append({**s, "cost": cost, "ratio": ratio})

    critical = [s for s in scored if s.get("band_code") == "P1"]
    rest = [s for s in scored if s.get("band_code") != "P1"]

    critical.sort(key=lambda s: -s["ratio"])
    rest.sort(key=lambda s: -s["ratio"])

    funded, deferred = [], []
    spent = 0.0
    for s in critical + rest:
        if spent + s["cost"] <= budget:
            funded.append(s)
            spent += s["cost"]
        else:
            deferred.append(s)

    unfunded_critical = [s for s in deferred if s.get("band_code") == "P1"]
    total_required = sum(s["cost"] for s in scored)
    # Two different numbers that are easy to conflate:
    #   deferred_cost — what the unfunded work would cost to do.
    #   shortfall     — how much *more* budget is needed to clear the backlog.
    # They differ by whatever budget is left unspent because no remaining job
    # fits in it. Showing one where the other belongs overstates the ask.
    deferred_cost = sum(s["cost"] for s in deferred)

    return {
        "budget": budget,
        "allocated": spent,
        "remaining": max(0.0, budget - spent),
        "total_required": total_required,
        "deferred_cost": deferred_cost,
        "shortfall": max(0.0, total_required - budget),
        "funded_ids": [s["id"] for s in funded],
        "deferred_ids": [s["id"] for s in deferred],
        "funded_count": len(funded),
        "deferred_count": len(deferred),
        "unfunded_critical": len(unfunded_critical),
        "coverage_pct": (100.0 * spent / total_required) if total_required else 100.0,
        "funded": funded,
        "deferred": deferred,
    }
