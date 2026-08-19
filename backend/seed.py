"""Demo network seeding.

A prioritisation tool is meaningless with one road in it — the whole point is
the ranking across a network. This seeds 28 real Delhi and Ghaziabad road
segments, with their actual locations and plausible traffic figures, so the
dashboard, the budget optimiser and the analytics are populated on first run,
before any image has been uploaded.

The roads and their coordinates are real; the *condition* data is synthetic,
generated from a fixed seed so the numbers are reproducible and everyone sees
the same demo. Nothing here is a survey result. Real inspections uploaded
through the UI sit alongside these and are scored by exactly the same engine.
"""
from __future__ import annotations

import json
import random
import re
import uuid
from datetime import datetime, timedelta, timezone

from . import config, costing, db
from .priority import SegmentContext, compute_rpi

CITY = "Delhi NCR"

# Delhi and Ghaziabad. Traffic volumes here are genuinely an order of magnitude
# above a tier-2 city — Delhi's ring roads carry six figures a day — and the
# monsoon term is driven less by rainfall than by drainage: NCR's problem is
# short, intense bursts landing on carriageways with blocked or absent storm
# drains, which is why several segments below are "moderate" monsoon but "poor"
# drainage.
#
# name, ward/locality, city, class, length_m, aadt, commercial %, lat, lon,
# years since resurface, accidents(3yr), drainage, monsoon, emergency route,
# school zone, complaints
NETWORK = [
    # ---- Delhi ----
    ("Ring Road, Ashram Chowk", "Ashram", "Delhi", "URB", 1800, 185000, 12, 28.5720, 77.2590, 5.5, 24, "poor", "high", True, False, 62),
    ("NH-48, Dhaula Kuan", "Dhaula Kuan", "Delhi", "NH", 2600, 220000, 18, 28.5920, 77.1610, 4.0, 19, "fair", "moderate", True, False, 34),
    ("Mathura Road, Badarpur", "Badarpur", "Delhi", "NH", 2400, 145000, 32, 28.5100, 77.3020, 8.0, 27, "poor", "high", False, False, 58),
    ("GT Karnal Road, Azadpur", "Azadpur", "Delhi", "NH", 2200, 128000, 35, 28.7070, 77.1750, 6.0, 21, "fair", "moderate", False, False, 47),
    ("Outer Ring Road, Mukarba Chowk", "Mukarba", "Delhi", "URB", 2800, 165000, 22, 28.7360, 77.1560, 6.0, 18, "fair", "high", True, False, 39),
    ("Rohtak Road, Peeragarhi", "Peeragarhi", "Delhi", "NH", 2100, 112000, 29, 28.6800, 77.0900, 7.0, 16, "fair", "moderate", False, False, 44),
    ("Vikas Marg, Laxmi Nagar", "Laxmi Nagar", "Delhi", "URB", 1600, 96000, 9, 28.6360, 77.2770, 5.0, 14, "fair", "high", False, True, 41),
    ("Aurobindo Marg, AIIMS", "AIIMS", "Delhi", "URB", 1400, 88000, 7, 28.5670, 77.2100, 3.0, 11, "good", "moderate", True, False, 18),
    ("Najafgarh Road, Janakpuri", "Janakpuri", "Delhi", "MDR", 1900, 74000, 14, 28.6220, 77.0810, 7.0, 12, "fair", "high", False, True, 33),
    ("Mehrauli–Badarpur Road, Saket", "Saket", "Delhi", "URB", 1700, 82000, 11, 28.5230, 77.2060, 4.5, 9, "good", "moderate", False, True, 15),
    ("Nelson Mandela Marg, Vasant Kunj", "Vasant Kunj", "Delhi", "URB", 1500, 58000, 8, 28.5250, 77.1580, 1.5, 4, "good", "low", False, False, 5),
    ("Wazirabad Road, Bhajanpura", "Bhajanpura", "Delhi", "MDR", 2000, 67000, 24, 28.6960, 77.2680, 9.5, 17, "poor", "high", False, False, 55),
    ("Okhla Industrial Area Road", "Okhla", "Delhi", "COL", 1300, 42000, 41, 28.5300, 77.2730, 8.5, 10, "poor", "moderate", False, False, 37),
    ("Dwarka Sector 21 Approach", "Dwarka", "Delhi", "COL", 1100, 31000, 9, 28.5520, 77.0580, 2.0, 3, "good", "low", False, True, 6),
    ("Rohini Sector 18 Internal", "Rohini", "Delhi", "LOC", 800, 12000, 5, 28.7370, 77.1180, 4.0, 2, "good", "moderate", False, True, 9),

    # ---- Ghaziabad ----
    ("NH-9, Vijay Nagar Bypass", "Vijay Nagar", "Ghaziabad", "NH", 2900, 138000, 38, 28.6800, 77.4300, 6.5, 22, "fair", "moderate", True, False, 43),
    ("GT Road, Ghaziabad City", "City Centre", "Ghaziabad", "SH", 2300, 94000, 33, 28.6650, 77.4300, 9.0, 19, "poor", "high", False, False, 61),
    ("Hapur Road, Ghaziabad", "Hapur Chungi", "Ghaziabad", "SH", 2500, 71000, 36, 28.6700, 77.4550, 10.0, 15, "poor", "moderate", False, False, 52),
    ("Delhi–Meerut Expressway Link, Indirapuram", "Indirapuram", "Ghaziabad", "NH", 2100, 108000, 26, 28.6420, 77.3720, 1.5, 8, "good", "moderate", True, False, 11),
    ("Raj Nagar Extension Road", "Raj Nagar Ext", "Ghaziabad", "MDR", 2400, 46000, 19, 28.7060, 77.4180, 7.5, 11, "poor", "high", False, True, 48),
    ("Loni Road, Ghaziabad", "Loni", "Ghaziabad", "MDR", 2700, 52000, 31, 28.7500, 77.2830, 11.0, 18, "poor", "high", False, False, 66),
    ("Vaishali Sector 4 Arterial", "Vaishali", "Ghaziabad", "URB", 1400, 38000, 8, 28.6420, 77.3390, 4.0, 6, "fair", "moderate", False, True, 19),
    ("Vasundhara Sector 13 Road", "Vasundhara", "Ghaziabad", "COL", 1200, 27000, 7, 28.6600, 77.3600, 3.5, 4, "good", "moderate", False, True, 13),
    ("Mohan Nagar Junction Approach", "Mohan Nagar", "Ghaziabad", "URB", 1000, 63000, 21, 28.6800, 77.3450, 8.0, 14, "poor", "high", False, False, 45),
    ("Sahibabad Industrial Area Road", "Sahibabad", "Ghaziabad", "COL", 1600, 34000, 44, 28.6790, 77.3320, 9.5, 13, "poor", "moderate", False, False, 51),
    ("Kavi Nagar Internal Road", "Kavi Nagar", "Ghaziabad", "LOC", 700, 9000, 4, 28.6720, 77.4400, 2.0, 1, "good", "low", False, True, 4),
    ("Crossings Republik Approach", "Crossings", "Ghaziabad", "COL", 1500, 24000, 12, 28.6350, 77.4200, 6.0, 5, "fair", "moderate", False, False, 26),
    ("Modinagar Bypass, NH-58", "Modinagar", "Ghaziabad", "SH", 3100, 41000, 42, 28.8330, 77.5780, 9.0, 16, "fair", "moderate", False, False, 39),
]


def _synth_detections(rng: random.Random, severity_bias: float) -> list[dict]:
    """Fabricate a plausible distress set.

    `severity_bias` (0..1) is derived from the segment's age, drainage and truck
    share, so generated condition correlates with the physical factors that
    actually cause it rather than being pure noise.

    The counts and areas below are calibrated so the seeded network lands on a
    realistic spread — most segments fair to satisfactory, a handful critical.
    A generator tuned any hotter puts every road at RPI 100, which makes the
    prioritisation look impressive and say nothing: if everything is critical,
    nothing is ranked.
    """
    dets: list[dict] = []

    if severity_bias < 0.18:
        return dets

    # Distress mix shifts with severity: light roads show isolated cracking,
    # failing roads show fatigue cracking and potholes.
    n = max(0, int(rng.gauss(severity_bias * 7.0, 1.5)))
    for _ in range(n):
        r = rng.random()
        if severity_bias > 0.62 and r < 0.26:
            code = "D40"
        elif severity_bias > 0.52 and r < 0.46:
            code = "D20"
        elif severity_bias > 0.45 and r < 0.56:
            code = "RUT"
        elif r < 0.70:
            code = rng.choice(["D00", "D10"])
        elif r < 0.82:
            code = "RAV"
        elif r < 0.90:
            code = "EDG"
        else:
            code = rng.choice(["D43", "D44"])

        area = abs(rng.gauss(0.008 + severity_bias * 0.022, 0.007)) + 0.002
        area = min(0.10, area)
        conf = min(0.96, max(0.30, rng.gauss(0.68, 0.13)))

        scale = 2.0 if code in ("D40", "RUT") else 1.0
        s = area * scale * (0.6 + 0.4 * conf)
        sev = "high" if s >= 0.055 else "medium" if s >= 0.018 else "low"

        w = min(0.42, max(0.04, area ** 0.5 * rng.uniform(0.9, 1.7)))
        h = min(0.42, max(0.04, area / max(w, 0.04)))
        dets.append({
            "code": code, "confidence": round(conf, 3),
            "x": round(rng.uniform(0.03, max(0.04, 0.95 - w)), 3),
            "y": round(rng.uniform(0.28, max(0.29, 0.95 - h)), 3),
            "w": round(w, 3), "h": round(h, 3),
            "severity": sev, "area_ratio": round(area, 4),
            "notes": "synthetic demo observation",
        })
    return dets


def seed(force: bool = False) -> dict:
    db.init_db()
    if not force and db.counts()["segments"] > 0:
        return {"seeded": False, "reason": "network already present"}

    if force:
        db.reset()

    rng = random.Random(20240817)
    now = datetime.now(timezone.utc)
    created = 0

    for (name, ward, city, cls, length, aadt, comm, lat, lon, age, acc,
         drain, monsoon, emergency, school, reports) in NETWORK:
        # City-prefixed so two authorities can share a register without their
        # ids colliding, and long enough that similarly-named arterials in the
        # same city stay distinct.
        slug = re.sub(r"[^A-Z0-9]+", "-", name.upper()).strip("-")[:30]
        seg_id = f"{city[:3].upper()}-{slug}"
        seg = {
            "id": seg_id, "name": name, "ward": ward, "city": city,
            "road_class": cls, "surface_type": rng.choice(["BC", "BC", "DBM", "SD"]),
            "length_m": float(length), "lat": lat, "lon": lon,
            "aadt": aadt, "commercial_pct": float(comm),
            "last_resurfaced_years": age, "accidents_3yr": acc,
            "drainage_quality": drain, "monsoon_exposure": monsoon,
            "is_emergency_route": int(emergency), "has_school_zone": int(school),
            "public_reports": reports,
            "created_at": (now - timedelta(days=400)).isoformat(timespec="seconds"),
        }
        db.upsert_segment(seg)

        # Physical drivers of condition, blended into a single bias.
        design_life = config.ROAD_CLASSES[cls]["design_life"]
        bias = (
            0.42 * min(1.0, age / design_life)
            + 0.20 * {"poor": 1.0, "fair": 0.5, "good": 0.12}[drain]
            + 0.18 * min(1.0, comm / 38.0)
            + 0.12 * {"high": 1.0, "moderate": 0.5, "low": 0.1}[monsoon]
            + 0.08 * min(1.0, aadt / 40000.0)
        )
        bias = min(1.0, max(0.0, bias * rng.uniform(0.85, 1.15)))

        # Four inspections over about 18 months. The condition factor climbs
        # slowly toward the segment's full bias, which gives the deterioration
        # term real history to measure and the trend charts something to plot.
        prev_score = None
        schedule = ((548, 0.74), (365, 0.83), (180, 0.91), (12, 1.0))
        for idx, (days_ago, decay) in enumerate(schedule):
            dets = _synth_detections(rng, bias * decay)
            ctx = SegmentContext(
                road_class=cls, aadt=aadt, commercial_pct=float(comm),
                length_m=float(length), surface_type=seg["surface_type"],
                last_resurfaced_years=max(0.5, age - (days_ago / 365.0)),
                accidents_3yr=acc, drainage_quality=drain, monsoon_exposure=monsoon,
                is_emergency_route=emergency, has_school_zone=school,
                public_reports=reports,
                prev_distress_score=prev_score,
                days_since_prev=(schedule[idx - 1][0] - days_ago) if idx else None,
            )
            res = compute_rpi(dets, ctx, pavement_fraction=1.0)
            treatment, why = costing.recommend_treatment(res.pci, dets, ctx)
            est = costing.estimate_cost(treatment, ctx, dets, res.pci)

            scoring = res.to_dict()
            scoring["treatment_reason"] = why
            scoring["context"] = ctx.__dict__

            db.insert_inspection({
                "id": str(uuid.uuid4()),
                "segment_id": seg_id,
                "created_at": (now - timedelta(days=days_ago)).isoformat(timespec="seconds"),
                "image_path": None, "image_name": None,
                "engine": "demo-seed", "engine_label": "Seeded demo observation",
                "engine_kind": "synthetic",
                "inference_ms": 0.0, "pavement_fraction": 1.0,
                "detections_json": json.dumps(dets),
                "rpi": res.rpi, "band_code": res.band_code, "band_label": res.band_label,
                "pci": res.pci,
                "distress_score": res.components["distress"],
                "dominant_damage": res.dominant_damage,
                "scoring_json": json.dumps(scoring),
                "treatment": treatment, "treatment_name": est.treatment_name,
                "total_cost": est.total_cost, "life_years": est.life_years,
                "cost_json": json.dumps(est.to_dict()),
                "notes": "Seeded demo network",
            })
            prev_score = res.components["distress"]
        created += 1

    return {"seeded": True, "segments": created}
