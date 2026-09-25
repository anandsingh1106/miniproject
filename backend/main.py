"""FastAPI application — API surface and static hosting for the dashboard."""
from __future__ import annotations

import json
import re
import uuid
from contextlib import asynccontextmanager
from collections import Counter, defaultdict
from datetime import datetime, timezone

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, costing, db, seed as seeder
from .detection import registry
from .priority import SegmentContext, compute_rpi, pci_label

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Prepare the database and seed the demo network before serving.

    A lifespan handler rather than the deprecated @app.on_event, which FastAPI
    warns about and will eventually remove.
    """
    db.init_db()
    seeder.seed()          # no-op once the network exists
    yield


app = FastAPI(
    title="RoadLens API",
    description="AI road-damage detection and reconstruction prioritisation.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ======================================================================
# Metadata
# ======================================================================
@app.get("/api/meta")
def meta():
    """Everything the frontend needs to render forms and labels."""
    return {
        "damage_types": {
            k: {**v, "code": k} for k, v in config.DAMAGE_TYPES.items()
        },
        "damage_order": config.DAMAGE_ORDER,
        "road_classes": {k: {**v, "code": k} for k, v in config.ROAD_CLASSES.items()},
        "surface_types": config.SURFACE_TYPES,
        "treatments": {k: {**v, "code": k} for k, v in config.TREATMENTS.items()},
        "bands": [
            {"min": b[0], "code": b[1], "label": b[2], "window": b[3], "status": b[4]}
            for b in config.PRIORITY_BANDS
        ],
        "weights": config.RPI_WEIGHTS,
        "currency": config.CURRENCY,
        "engine": registry.engine_status(),
    }


@app.get("/api/health")
def health():
    return {"status": "ok", "time": db.now_iso(), **db.counts(),
            "engine": registry.engine_status()["active"]}


# ======================================================================
# Analysis
# ======================================================================
@app.post("/api/analyze")
async def analyze(
    image: UploadFile = File(...),
    road_class: str = Form("URB"),
    aadt: int = Form(8000),
    commercial_pct: float = Form(12.0),
    length_m: float = Form(500.0),
    surface_type: str = Form("BC"),
    last_resurfaced_years: float = Form(6.0),
    accidents_3yr: int = Form(0),
    drainage_quality: str = Form("fair"),
    monsoon_exposure: str = Form("moderate"),
    is_emergency_route: bool = Form(False),
    has_school_zone: bool = Form(False),
    public_reports: int = Form(0),
    conf_threshold: float = Form(0.25),
    engine: str | None = Form(None),
    segment_id: str | None = Form(None),
    segment_name: str | None = Form(None),
    ward: str | None = Form(None),
    lat: float | None = Form(None),
    lon: float | None = Form(None),
    save: bool = Form(True),
):
    """Detect damage in an uploaded image and score it for reconstruction priority."""
    raw = await image.read()
    if not raw:
        raise HTTPException(400, "Empty upload.")
    if len(raw) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Image exceeds {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")

    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Could not decode that file as an image.")

    if road_class not in config.ROAD_CLASSES:
        raise HTTPException(400, f"Unknown road class '{road_class}'.")

    # A caller who names a segment but supplies no id still expects the
    # inspection to land on that segment rather than being orphaned, so derive
    # the id the same way the frontend does.
    if not segment_id and segment_name:
        segment_id = "SEG-" + re.sub(r"[^A-Z0-9]+", "-",
                                     segment_name.upper())[:22].strip("-")

    try:
        result = registry.detect(img, conf_threshold=conf_threshold, prefer=engine)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc

    dets = [d.to_dict() for d in result.detections]

    # If this segment has been inspected before, hand the previous distress
    # score to the scorer so it can measure the deterioration rate.
    prev_score, days_since = None, None
    if segment_id:
        prev = db.latest_inspection(segment_id)
        if prev:
            prev_score = prev.get("distress_score")
            try:
                then = datetime.fromisoformat(prev["created_at"])
                days_since = max(1, (datetime.now(timezone.utc) - then).days)
            except (ValueError, TypeError):
                days_since = None

    ctx = SegmentContext(
        road_class=road_class, aadt=aadt, commercial_pct=commercial_pct,
        length_m=length_m, surface_type=surface_type,
        last_resurfaced_years=last_resurfaced_years, accidents_3yr=accidents_3yr,
        drainage_quality=drainage_quality, monsoon_exposure=monsoon_exposure,
        is_emergency_route=is_emergency_route, has_school_zone=has_school_zone,
        public_reports=public_reports,
        prev_distress_score=prev_score, days_since_prev=days_since,
    )

    scoring = compute_rpi(dets, ctx, pavement_fraction=result.pavement_fraction)
    treatment, why = costing.recommend_treatment(scoring.pci, dets, ctx)
    est = costing.estimate_cost(treatment, ctx, dets, scoring.pci)

    insp_id = str(uuid.uuid4())
    stored_path = None
    ext = {"image/png": ".png", "image/webp": ".webp",
           "image/bmp": ".bmp"}.get(image.content_type or "", ".jpg")
    detection_info = {
        "image_name": image.filename,
        "engine": result.engine, "engine_label": result.engine_label,
        "engine_kind": result.engine_kind,
        "inference_ms": result.inference_ms,
        "pavement_fraction": result.pavement_fraction,
        "detections": dets,
    }

    if save:
        # Persist the image so the inspection record stays auditable.
        stored_path = f"{insp_id}{ext}"
        (config.UPLOAD_DIR / stored_path).write_bytes(raw)
        if segment_id:
            _ensure_segment(segment_id, segment_name, ward, lat, lon, ctx,
                            update_location=False)
        _store_inspection(insp_id, segment_id, stored_path, detection_info,
                          scoring, ctx, treatment, why, est)
    else:
        # Held back until the user presses Save, so a trial run never lands in
        # the register. The stash carries everything needed to store it later
        # without running detection again.
        _prune_pending()
        pdir = _pending_dir()
        (pdir / f"{insp_id}{ext}").write_bytes(raw)
        (pdir / f"{insp_id}.json").write_text(json.dumps({
            "image_file": f"{insp_id}{ext}",
            "segment_id": segment_id, "segment_name": segment_name,
            "ward": ward, "lat": lat, "lon": lon,
            "context": ctx.__dict__,
            **detection_info,
        }))

    return {
        "id": insp_id,
        "saved": save,
        "segment_id": segment_id,
        "image_url": f"/api/image/{stored_path}" if stored_path else None,
        "detection": {
            **result.to_dict(),
            "detections": dets,
        },
        "scoring": scoring.to_dict(),
        "treatment": {**est.to_dict(), "reason": why},
    }


PENDING_TTL_S = 24 * 3600
_PENDING_ID = re.compile(r"^[0-9a-f-]{36}$")


def _pending_dir():
    # Resolved per call rather than at import, so a redirected DATA_DIR (the
    # test suite does this) is honoured.
    d = config.DATA_DIR / "pending"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _prune_pending() -> None:
    """Drop analyses that were never saved, so the stash cannot grow forever."""
    cutoff = datetime.now().timestamp() - PENDING_TTL_S
    for f in _pending_dir().iterdir():
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except OSError:
            pass


def _ensure_segment(segment_id: str, name: str | None, ward: str | None,
                    lat: float | None, lon: float | None, ctx: SegmentContext,
                    update_location: bool) -> None:
    """Create the segment if it is new; optionally move an existing one's pin."""
    existing = db.get_segment(segment_id)
    if existing:
        if update_location and lat is not None and lon is not None:
            existing.update(lat=lat, lon=lon)
            if ward:
                existing["ward"] = ward
            db.upsert_segment(existing)
        return
    db.upsert_segment({
        "id": segment_id,
        "name": name or segment_id,
        "ward": ward, "city": seeder.CITY,
        "road_class": ctx.road_class, "surface_type": ctx.surface_type,
        "length_m": ctx.length_m, "lat": lat, "lon": lon,
        "aadt": ctx.aadt, "commercial_pct": ctx.commercial_pct,
        "last_resurfaced_years": ctx.last_resurfaced_years,
        "accidents_3yr": ctx.accidents_3yr,
        "drainage_quality": ctx.drainage_quality,
        "monsoon_exposure": ctx.monsoon_exposure,
        "is_emergency_route": int(ctx.is_emergency_route),
        "has_school_zone": int(ctx.has_school_zone),
        "public_reports": ctx.public_reports,
    })


def _store_inspection(insp_id, segment_id, image_path, info: dict, scoring,
                      ctx: SegmentContext, treatment, why, est) -> None:
    scoring_payload = scoring.to_dict()
    scoring_payload["treatment_reason"] = why
    scoring_payload["context"] = ctx.__dict__
    db.insert_inspection({
        "id": insp_id,
        "segment_id": segment_id,
        "created_at": db.now_iso(),
        "image_path": image_path,
        "image_name": info["image_name"],
        "engine": info["engine"], "engine_label": info["engine_label"],
        "engine_kind": info["engine_kind"],
        "inference_ms": info["inference_ms"],
        "pavement_fraction": info["pavement_fraction"],
        "detections_json": json.dumps(info["detections"]),
        "rpi": scoring.rpi, "band_code": scoring.band_code,
        "band_label": scoring.band_label, "pci": scoring.pci,
        "distress_score": scoring.components["distress"],
        "dominant_damage": scoring.dominant_damage,
        "scoring_json": json.dumps(scoring_payload),
        "treatment": treatment, "treatment_name": est.treatment_name,
        "total_cost": est.total_cost, "life_years": est.life_years,
        "cost_json": json.dumps(est.to_dict()),
        "notes": None,
    })


@app.post("/api/analyze/{insp_id}/save")
def save_analysis(insp_id: str, payload: dict):
    """Store an analysis that was run with save=false, pinned to a map location.

    The score is recomputed against the chosen segment's history, because the
    segment can be renamed here — and a road that has been inspected before
    carries a deterioration rate the preview could not know about.
    """
    if not _PENDING_ID.match(insp_id):
        raise HTTPException(404, "Analysis not found.")
    meta_path = _pending_dir() / f"{insp_id}.json"
    if not meta_path.is_file():
        raise HTTPException(404, "Analysis not found or already saved. Run it again.")
    pending = json.loads(meta_path.read_text())

    name = (payload.get("segment_name") or pending.get("segment_name") or "").strip()
    if not name:
        raise HTTPException(400, "A segment name is required to save.")
    try:
        lat = float(payload["lat"])
        lon = float(payload["lon"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "A map location (lat and lon) is required to save.")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "That location is out of range.")
    ward = (payload.get("ward") or pending.get("ward") or "").strip() or None
    segment_id = "SEG-" + re.sub(r"[^A-Z0-9]+", "-", name.upper())[:22].strip("-")

    ctx_in = dict(pending["context"])
    ctx_in["prev_distress_score"], ctx_in["days_since_prev"] = None, None
    prev = db.latest_inspection(segment_id)
    if prev:
        ctx_in["prev_distress_score"] = prev.get("distress_score")
        try:
            then = datetime.fromisoformat(prev["created_at"])
            ctx_in["days_since_prev"] = max(1, (datetime.now(timezone.utc) - then).days)
        except (ValueError, TypeError):
            pass
    ctx = SegmentContext(**ctx_in)
    dets = pending["detections"]
    scoring = compute_rpi(dets, ctx, pavement_fraction=pending["pavement_fraction"])
    treatment, why = costing.recommend_treatment(scoring.pci, dets, ctx)
    est = costing.estimate_cost(treatment, ctx, dets, scoring.pci)

    image_file = pending["image_file"]
    src = _pending_dir() / image_file
    if src.is_file():
        src.replace(config.UPLOAD_DIR / image_file)
    else:
        image_file = None

    _ensure_segment(segment_id, name, ward, lat, lon, ctx, update_location=True)
    _store_inspection(insp_id, segment_id, image_file, pending, scoring,
                      ctx, treatment, why, est)
    meta_path.unlink(missing_ok=True)

    return {
        "id": insp_id,
        "saved": True,
        "segment_id": segment_id,
        "segment_name": name,
        "lat": lat, "lon": lon,
        "image_url": f"/api/image/{image_file}" if image_file else None,
        "scoring": scoring.to_dict(),
        "treatment": {**est.to_dict(), "reason": why},
    }


@app.get("/api/image/{name}")
def image(name: str):
    # Resolve and confine to the upload directory — never trust a path segment.
    path = (config.UPLOAD_DIR / name).resolve()
    if not str(path).startswith(str(config.UPLOAD_DIR.resolve())) or not path.is_file():
        raise HTTPException(404, "Not found.")
    return FileResponse(path)


# ======================================================================
# Segments and inspections
# ======================================================================
@app.get("/api/segments")
def segments(band: str | None = None, road_class: str | None = None,
             ward: str | None = None, q: str | None = None):
    rows = db.list_segments()
    if band:
        rows = [r for r in rows if r.get("band_code") == band]
    if road_class:
        rows = [r for r in rows if r.get("road_class") == road_class]
    if ward:
        rows = [r for r in rows if (r.get("ward") or "").lower() == ward.lower()]
    if q:
        needle = q.lower()
        rows = [r for r in rows
                if needle in (r.get("name") or "").lower()
                or needle in (r.get("ward") or "").lower()]
    return {"count": len(rows), "segments": rows}


@app.get("/api/segments/{seg_id}")
def segment_detail(seg_id: str):
    seg = db.get_segment(seg_id)
    if not seg:
        raise HTTPException(404, "Segment not found.")
    history = db.list_inspections(seg_id, limit=50)
    seg["is_emergency_route"] = bool(seg["is_emergency_route"])
    seg["has_school_zone"] = bool(seg["has_school_zone"])
    return {
        "segment": seg,
        "latest": history[0] if history else None,
        "history": history,
        "road_class_meta": config.ROAD_CLASSES.get(seg["road_class"]),
    }


@app.delete("/api/segments/{seg_id}")
def remove_segment(seg_id: str):
    if not db.delete_segment(seg_id):
        raise HTTPException(404, "Segment not found.")
    return {"deleted": seg_id}


@app.get("/api/inspections")
def inspections(segment_id: str | None = None, limit: int = Query(100, le=500)):
    return {"inspections": db.list_inspections(segment_id, limit)}


@app.get("/api/inspections/{insp_id}")
def inspection_detail(insp_id: str):
    rec = db.get_inspection(insp_id)
    if not rec:
        raise HTTPException(404, "Inspection not found.")
    return rec


# ======================================================================
# Rescoring — what-if analysis
# ======================================================================
@app.post("/api/rescore")
def rescore(payload: dict):
    """Re-run the score against modified context, without re-running detection.

    Powers the what-if panel: change the traffic count or drainage rating and
    watch the priority move, which is how you build trust in a scoring model.
    """
    dets = payload.get("detections") or []
    ctx_in = payload.get("context") or {}
    valid = SegmentContext.__dataclass_fields__.keys()
    ctx = SegmentContext(**{k: v for k, v in ctx_in.items() if k in valid})

    scoring = compute_rpi(dets, ctx, pavement_fraction=payload.get("pavement_fraction", 1.0))
    treatment, why = costing.recommend_treatment(scoring.pci, dets, ctx)
    est = costing.estimate_cost(treatment, ctx, dets, scoring.pci)
    return {"scoring": scoring.to_dict(), "treatment": {**est.to_dict(), "reason": why}}


# ======================================================================
# Budget allocation
# ======================================================================
@app.get("/api/budget")
def budget(amount: float = Query(50_000_000, gt=0)):
    rows = [r for r in db.list_segments() if r.get("rpi") is not None]
    plan = costing.allocate_budget(rows, amount)

    # Trim the payload — the frontend already holds the full segment list.
    def slim(s: dict) -> dict:
        return {
            "id": s["id"], "name": s["name"], "ward": s.get("ward"),
            "road_class": s.get("road_class"), "rpi": s.get("rpi"),
            "band_code": s.get("band_code"), "band_label": s.get("band_label"),
            "pci": s.get("pci"), "treatment": s.get("treatment"),
            "treatment_name": s.get("treatment_name"),
            "total_cost": s.get("total_cost"), "life_years": s.get("life_years"),
            "ratio": round(s.get("ratio", 0.0), 6),
        }

    plan["funded"] = [slim(s) for s in plan["funded"]]
    plan["deferred"] = [slim(s) for s in plan["deferred"]]
    return plan


# ======================================================================
# Analytics
# ======================================================================
@app.get("/api/analytics")
def analytics():
    rows = db.list_segments()
    scored = [r for r in rows if r.get("rpi") is not None]

    bands = Counter(r["band_code"] for r in scored)
    band_meta = {b[1]: {"label": b[2], "status": b[4]} for b in config.PRIORITY_BANDS}
    band_series = [
        {"code": b[1], "label": b[2], "status": b[4], "count": bands.get(b[1], 0)}
        for b in config.PRIORITY_BANDS
    ]

    # Distress mix across the network, from the latest inspection of each segment.
    dmg = Counter()
    for insp in db.list_inspections(limit=1000):
        for d in insp["detections"]:
            dmg[d["code"]] += 1
    damage_series = [
        {"code": c, "name": config.DAMAGE_TYPES[c]["name"],
         "short": config.DAMAGE_TYPES[c]["short"], "count": dmg.get(c, 0)}
        for c in config.DAMAGE_ORDER if dmg.get(c, 0) > 0
    ]

    # Condition by road class — where the network is actually failing.
    by_class: dict[str, list] = defaultdict(list)
    for r in scored:
        by_class[r["road_class"]].append(r)
    class_series = []
    for code, meta in config.ROAD_CLASSES.items():
        items = by_class.get(code, [])
        if not items:
            continue
        class_series.append({
            "code": code, "name": meta["name"], "count": len(items),
            "avg_pci": round(sum(i["pci"] or 0 for i in items) / len(items), 1),
            "avg_rpi": round(sum(i["rpi"] or 0 for i in items) / len(items), 1),
            "cost": sum(i.get("total_cost") or 0 for i in items),
        })
    class_series.sort(key=lambda c: -c["avg_rpi"])

    # Cost by treatment type.
    by_treatment: dict[str, dict] = {}
    for r in scored:
        t = r.get("treatment")
        if not t or t == "monitor":
            continue
        slot = by_treatment.setdefault(t, {
            "code": t, "name": config.TREATMENTS[t]["name"], "count": 0, "cost": 0.0})
        slot["count"] += 1
        slot["cost"] += r.get("total_cost") or 0.0
    treatment_series = sorted(by_treatment.values(), key=lambda t: -t["cost"])

    # Network condition trend, from inspection history.
    trend: dict[str, list] = defaultdict(list)
    for insp in db.list_inspections(limit=1000):
        month = (insp["created_at"] or "")[:7]
        if month:
            trend[month].append(insp)
    trend_series = [
        {
            "month": m,
            "avg_pci": round(sum(i["pci"] or 0 for i in v) / len(v), 1),
            "avg_rpi": round(sum(i["rpi"] or 0 for i in v) / len(v), 1),
            "count": len(v),
        }
        for m, v in sorted(trend.items())
    ]

    total_cost = sum(r.get("total_cost") or 0 for r in scored)
    avg_pci = (sum(r["pci"] or 0 for r in scored) / len(scored)) if scored else 100.0
    network_km = sum((r.get("length_m") or 0) for r in rows) / 1000.0

    return {
        "totals": {
            "segments": len(rows),
            "scored": len(scored),
            "network_km": round(network_km, 1),
            "critical": bands.get("P1", 0),
            "high": bands.get("P2", 0),
            "avg_pci": round(avg_pci, 1),
            "avg_pci_label": pci_label(avg_pci),
            "total_cost": round(total_cost),
            "backlog_km": round(sum(
                (r.get("length_m") or 0) for r in scored
                if r.get("band_code") in ("P1", "P2")) / 1000.0, 1),
        },
        "bands": band_series,
        "band_meta": band_meta,
        "damage": damage_series,
        "by_class": class_series,
        "by_treatment": treatment_series,
        "trend": trend_series,
    }


# ======================================================================
# Admin
# ======================================================================
@app.post("/api/seed")
def reseed(force: bool = False):
    return seeder.seed(force=force)


# ======================================================================
# Static frontend — mounted last so /api/* wins
# ======================================================================
if config.FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR), html=True), name="site")


@app.exception_handler(HTTPException)
def http_error(_request, exc: HTTPException):
    return JSONResponse({"error": exc.detail, "status": exc.status_code}, status_code=exc.status_code)
