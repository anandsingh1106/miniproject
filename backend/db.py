"""SQLite persistence.

Chosen over an ORM on purpose: the schema is small, the queries are simple, and
sqlite3 is in the standard library, so the whole system installs with one
`pip install -r requirements.txt` and no database server.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS segments (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    ward                TEXT,
    city                TEXT,
    road_class          TEXT NOT NULL DEFAULT 'URB',
    surface_type        TEXT NOT NULL DEFAULT 'BC',
    length_m            REAL NOT NULL DEFAULT 500,
    lat                 REAL,
    lon                 REAL,
    aadt                INTEGER NOT NULL DEFAULT 8000,
    commercial_pct      REAL NOT NULL DEFAULT 12,
    last_resurfaced_years REAL NOT NULL DEFAULT 6,
    accidents_3yr       INTEGER NOT NULL DEFAULT 0,
    drainage_quality    TEXT NOT NULL DEFAULT 'fair',
    monsoon_exposure    TEXT NOT NULL DEFAULT 'moderate',
    is_emergency_route  INTEGER NOT NULL DEFAULT 0,
    has_school_zone     INTEGER NOT NULL DEFAULT 0,
    public_reports      INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inspections (
    id              TEXT PRIMARY KEY,
    segment_id      TEXT REFERENCES segments(id) ON DELETE CASCADE,
    created_at      TEXT NOT NULL,
    image_path      TEXT,
    image_name      TEXT,
    engine          TEXT,
    engine_label    TEXT,
    engine_kind     TEXT,
    inference_ms    REAL,
    pavement_fraction REAL,
    detections_json TEXT NOT NULL,
    rpi             REAL NOT NULL,
    band_code       TEXT NOT NULL,
    band_label      TEXT,
    pci             REAL,
    distress_score  REAL,
    dominant_damage TEXT,
    scoring_json    TEXT NOT NULL,
    treatment       TEXT,
    treatment_name  TEXT,
    total_cost      REAL,
    life_years      INTEGER,
    cost_json       TEXT,
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_insp_segment ON inspections(segment_id);
CREATE INDEX IF NOT EXISTS idx_insp_created ON inspections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_insp_rpi     ON inspections(rpi DESC);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect():
    conn = sqlite3.connect(config.DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with connect() as c:
        c.executescript(SCHEMA)


def row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


# ----------------------------------------------------------------------
# Segments
# ----------------------------------------------------------------------
SEGMENT_FIELDS = (
    "id", "name", "ward", "city", "road_class", "surface_type", "length_m", "lat", "lon",
    "aadt", "commercial_pct", "last_resurfaced_years", "accidents_3yr", "drainage_quality",
    "monsoon_exposure", "is_emergency_route", "has_school_zone", "public_reports",
)


def upsert_segment(data: dict) -> None:
    payload = {k: data.get(k) for k in SEGMENT_FIELDS}
    payload["created_at"] = data.get("created_at") or now_iso()
    cols = ", ".join(payload.keys())
    ph = ", ".join(f":{k}" for k in payload)
    updates = ", ".join(f"{k}=excluded.{k}" for k in payload if k != "id")
    with connect() as c:
        c.execute(
            f"INSERT INTO segments ({cols}) VALUES ({ph}) "
            f"ON CONFLICT(id) DO UPDATE SET {updates}",
            payload,
        )


def get_segment(seg_id: str) -> dict | None:
    with connect() as c:
        r = c.execute("SELECT * FROM segments WHERE id = ?", (seg_id,)).fetchone()
    return row_to_dict(r) if r else None


def list_segments() -> list[dict]:
    """Every segment with its most recent inspection joined on.

    The correlated subquery picks the latest inspection per segment in one
    round trip, which keeps the dashboard to a single query.
    """
    q = """
    SELECT s.*,
           i.id            AS inspection_id,
           i.created_at    AS inspected_at,
           i.rpi           AS rpi,
           i.band_code     AS band_code,
           i.band_label    AS band_label,
           i.pci           AS pci,
           i.dominant_damage AS dominant_damage,
           i.treatment     AS treatment,
           i.treatment_name AS treatment_name,
           i.total_cost    AS total_cost,
           i.life_years    AS life_years,
           i.engine        AS engine,
           i.detections_json AS detections_json,
           (SELECT COUNT(*) FROM inspections x WHERE x.segment_id = s.id) AS inspection_count
    FROM segments s
    LEFT JOIN inspections i
           ON i.id = (SELECT id FROM inspections
                       WHERE segment_id = s.id
                       ORDER BY created_at DESC, rowid DESC LIMIT 1)
    ORDER BY COALESCE(i.rpi, -1) DESC, s.name ASC
    """
    with connect() as c:
        rows = [row_to_dict(r) for r in c.execute(q).fetchall()]
    for r in rows:
        raw = r.pop("detections_json", None)
        dets = json.loads(raw) if raw else []
        r["detection_count"] = len(dets)
        r["is_emergency_route"] = bool(r["is_emergency_route"])
        r["has_school_zone"] = bool(r["has_school_zone"])
    return rows


def delete_segment(seg_id: str) -> bool:
    with connect() as c:
        cur = c.execute("DELETE FROM segments WHERE id = ?", (seg_id,))
        return cur.rowcount > 0


# ----------------------------------------------------------------------
# Inspections
# ----------------------------------------------------------------------
def insert_inspection(rec: dict) -> None:
    cols = ", ".join(rec.keys())
    ph = ", ".join(f":{k}" for k in rec)
    with connect() as c:
        c.execute(f"INSERT INTO inspections ({cols}) VALUES ({ph})", rec)


def get_inspection(insp_id: str) -> dict | None:
    with connect() as c:
        r = c.execute("SELECT * FROM inspections WHERE id = ?", (insp_id,)).fetchone()
    if not r:
        return None
    d = row_to_dict(r)
    return _hydrate(d)


def list_inspections(segment_id: str | None = None, limit: int = 200) -> list[dict]:
    q = "SELECT * FROM inspections"
    args: tuple = ()
    if segment_id:
        q += " WHERE segment_id = ?"
        args = (segment_id,)
    q += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
    args += (limit,)
    with connect() as c:
        rows = [row_to_dict(r) for r in c.execute(q, args).fetchall()]
    return [_hydrate(r) for r in rows]


def latest_inspection(segment_id: str) -> dict | None:
    rows = list_inspections(segment_id, limit=1)
    return rows[0] if rows else None


def _hydrate(d: dict) -> dict:
    d["detections"] = json.loads(d.pop("detections_json") or "[]")
    d["scoring"] = json.loads(d.pop("scoring_json") or "{}")
    d["cost"] = json.loads(d.pop("cost_json") or "{}")
    return d


def counts() -> dict:
    with connect() as c:
        seg = c.execute("SELECT COUNT(*) AS n FROM segments").fetchone()["n"]
        insp = c.execute("SELECT COUNT(*) AS n FROM inspections").fetchone()["n"]
    return {"segments": seg, "inspections": insp}


def reset() -> None:
    with connect() as c:
        c.executescript("DROP TABLE IF EXISTS inspections; DROP TABLE IF EXISTS segments;")
        c.executescript(SCHEMA)
