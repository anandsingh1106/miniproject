"""Demo network seeding.

A prioritisation tool is meaningless with one road in it — the whole point is
the ranking across a network. This seeds 24 segments of a plausible municipal
network so the dashboard, the budget optimiser and the analytics are populated
on first run, before any image has been uploaded.

Synthetic condition data is generated from a fixed seed, so the numbers are
reproducible and everyone sees the same demo. Real inspections uploaded through
the UI sit alongside these and are scored by exactly the same engine.
"""
from __future__ import annotations

import json
import random
import uuid
from datetime import datetime, timedelta, timezone

from . import config, costing, db
from .priority import SegmentContext, compute_rpi

CITY = "Pune"

# name, ward, class, length_m, aadt, commercial %, lat, lon, years since resurface,
# accidents, drainage, monsoon, emergency route, school zone, complaints
NETWORK = [
    ("Mumbai–Bengaluru Bypass, Warje", "Warje", "NH", 2400, 46000, 34, 18.4790, 73.8080, 7.5, 19, "fair", "high", True, False, 41),
    ("Nagar Road, Yerawada", "Yerawada", "NH", 1800, 38000, 26, 18.5510, 73.8890, 6.0, 14, "poor", "high", True, False, 33),
    ("Karve Road, Kothrud", "Kothrud", "URB", 1500, 31000, 14, 18.5070, 73.8130, 5.5, 11, "fair", "high", False, True, 27),
    ("FC Road, Shivajinagar", "Shivajinagar", "URB", 900, 24000, 9, 18.5220, 73.8410, 4.0, 6, "good", "moderate", False, True, 12),
    ("Solapur Road, Hadapsar", "Hadapsar", "SH", 2100, 29000, 31, 18.5010, 73.9260, 9.0, 16, "poor", "high", False, False, 38),
    ("Baner Road, Baner", "Baner", "URB", 1600, 26000, 12, 18.5590, 73.7770, 3.5, 7, "good", "moderate", False, True, 9),
    ("Sinhagad Road, Vadgaon", "Vadgaon", "MDR", 2000, 18000, 22, 18.4650, 73.8210, 8.0, 12, "poor", "high", False, False, 31),
    ("Airport Road, Lohegaon", "Lohegaon", "SH", 1400, 21000, 19, 18.5820, 73.9200, 5.0, 8, "fair", "moderate", True, False, 14),
    ("Satara Road, Bibwewadi", "Bibwewadi", "URB", 1700, 27000, 17, 18.4770, 73.8620, 6.5, 13, "fair", "high", False, False, 24),
    ("Paud Road, Kothrud", "Kothrud", "COL", 1100, 14000, 8, 18.5090, 73.8010, 7.0, 5, "fair", "moderate", False, True, 18),
    ("Alandi Road, Vishrantwadi", "Vishrantwadi", "MDR", 1900, 16000, 24, 18.5680, 73.8790, 9.5, 10, "poor", "high", False, False, 29),
    ("JM Road, Deccan", "Deccan", "URB", 800, 22000, 6, 18.5180, 73.8430, 2.5, 4, "good", "moderate", False, False, 6),
    ("Katraj–Kondhwa Link", "Kondhwa", "MDR", 2600, 19000, 27, 18.4560, 73.8730, 8.5, 15, "poor", "high", False, False, 35),
    ("Aundh–Ravet BRT Corridor", "Aundh", "URB", 2200, 25000, 15, 18.5620, 73.8070, 4.5, 9, "good", "moderate", False, False, 11),
    ("Wagholi Service Road", "Wagholi", "LOC", 1300, 6500, 18, 18.5800, 73.9800, 10.0, 6, "poor", "high", False, False, 22),
    ("Kalyani Nagar Internal", "Kalyani Nagar", "COL", 700, 9000, 5, 18.5480, 73.9010, 3.0, 2, "good", "low", False, True, 4),
    ("Hinjawadi Phase 2 Approach", "Hinjawadi", "MDR", 1800, 33000, 21, 18.5910, 73.7380, 5.5, 12, "fair", "high", False, False, 26),
    ("Dhankawadi Link Road", "Dhankawadi", "COL", 950, 11000, 11, 18.4640, 73.8530, 7.5, 4, "fair", "moderate", False, True, 15),
    ("Kharadi Bypass", "Kharadi", "SH", 2300, 28000, 29, 18.5510, 73.9430, 6.0, 13, "fair", "high", True, False, 20),
    ("Bhosari MIDC Road", "Bhosari", "MDR", 2000, 17000, 38, 18.6280, 73.8460, 9.0, 11, "poor", "moderate", False, False, 28),
    ("Pashan–Sus Road", "Pashan", "COL", 1500, 12000, 9, 18.5380, 73.7830, 6.5, 5, "fair", "high", False, False, 17),
    ("Market Yard Approach", "Market Yard", "COL", 600, 15000, 33, 18.4830, 73.8700, 8.0, 7, "poor", "moderate", False, False, 23),
    ("Undri Village Road", "Undri", "LOC", 1200, 4200, 14, 18.4530, 73.9080, 11.0, 3, "poor", "high", False, True, 19),
    ("Model Colony Loop", "Model Colony", "LOC", 550, 5200, 4, 18.5310, 73.8340, 4.0, 1, "good", "low", False, False, 3),
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

    for (name, ward, cls, length, aadt, comm, lat, lon, age, acc,
         drain, monsoon, emergency, school, reports) in NETWORK:
        seg_id = "SEG-" + name.upper().replace(" ", "-").replace(",", "")[:18].strip("-")
        seg = {
            "id": seg_id, "name": name, "ward": ward, "city": CITY,
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
