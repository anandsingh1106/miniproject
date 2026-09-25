"""End-to-end tests of the HTTP surface.

Each test runs against a throwaway database so the suite never touches the
developer's real data and the order of tests can never matter.
"""
from __future__ import annotations

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    """A fully isolated app instance.

    The config module resolves its paths at import time, so they are redirected
    *before* anything that depends on them is imported. Otherwise the suite
    would seed and mutate data/roadai.db — the database a developer is
    simultaneously looking at in the browser.
    """
    tmp = tmp_path_factory.mktemp("roadlens")
    from backend import config
    config.DATA_DIR = tmp
    config.UPLOAD_DIR = tmp / "uploads"
    config.MODEL_DIR = tmp / "models"
    config.DB_PATH = tmp / "test.db"
    config.YOLO_WEIGHTS = config.MODEL_DIR / "road_damage.pt"
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    config.MODEL_DIR.mkdir(parents=True, exist_ok=True)

    from backend import db, main
    db.init_db()
    with TestClient(main.app) as c:
        yield c


def road_image(with_pothole: bool = True) -> bytes:
    rng = np.random.default_rng(11)
    h, w = 480, 640
    img = np.zeros((h, w, 3), np.uint8)
    img[:150] = (205, 198, 186)
    road = np.clip(np.full((h - 150, w, 3), 92, np.float32)
                   + rng.normal(0, 9, (h - 150, w, 3)), 0, 255)
    img[150:] = road.astype(np.uint8)
    if with_pothole:
        pts = np.array([[320 + int(52 * np.cos(t)), 360 + int(34 * np.sin(t))]
                        for t in np.linspace(0, 2 * np.pi, 18, endpoint=False)], np.int32)
        cv2.fillPoly(img, [pts], (38, 36, 35))
    return cv2.imencode(".jpg", img)[1].tobytes()


# ======================================================================
# Metadata
# ======================================================================
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_meta_describes_the_whole_domain(client):
    m = client.get("/api/meta").json()
    for key in ("damage_types", "damage_order", "road_classes",
                "treatments", "bands", "weights", "engine"):
        assert key in m and m[key]
    assert sum(m["weights"].values()) == pytest.approx(1.0)


def test_meta_reports_the_active_engine(client):
    engine = client.get("/api/meta").json()["engine"]
    assert engine["active"] in ("cv-morphology", "yolo")
    assert len(engine["engines"]) == 2


# ======================================================================
# Seeding
# ======================================================================
def test_demo_network_is_seeded(client):
    """An empty prioritisation tool demonstrates nothing — the whole point is
    the ranking across a network."""
    segs = client.get("/api/segments").json()
    assert segs["count"] >= 20
    assert all(s["lat"] and s["lon"] for s in segs["segments"])


def test_seeded_network_spans_several_priority_bands(client):
    """If everything is critical, nothing is ranked."""
    bands = {s["band_code"] for s in client.get("/api/segments").json()["segments"]}
    assert len(bands) >= 3


def test_segments_are_returned_worst_first(client):
    rpis = [s["rpi"] for s in client.get("/api/segments").json()["segments"]
            if s["rpi"] is not None]
    assert rpis == sorted(rpis, reverse=True)


# ======================================================================
# Analysis
# ======================================================================
class TestAnalyze:
    def test_scores_an_uploaded_image(self, client):
        r = client.post("/api/analyze",
                        files={"image": ("road.jpg", road_image(), "image/jpeg")},
                        data={"road_class": "NH", "aadt": "30000", "save": "false"})
        assert r.status_code == 200
        body = r.json()
        assert 0 <= body["scoring"]["rpi"] <= 100
        assert body["scoring"]["band"]["code"] in ("P1", "P2", "P3", "P4")
        assert body["treatment"]["treatment"] in client.get("/api/meta").json()["treatments"]

    def test_every_score_is_explained(self, client):
        r = client.post("/api/analyze",
                        files={"image": ("road.jpg", road_image(), "image/jpeg")},
                        data={"save": "false"})
        assert r.json()["scoring"]["rationale"]

    def test_result_names_its_engine(self, client):
        r = client.post("/api/analyze",
                        files={"image": ("road.jpg", road_image(), "image/jpeg")},
                        data={"save": "false"})
        d = r.json()["detection"]
        assert d["engine"] and d["engine_label"]

    def test_busier_road_scores_higher_on_the_same_image(self, client):
        img = road_image()
        common = {"save": "false", "drainage_quality": "good", "monsoon_exposure": "low",
                  "last_resurfaced_years": "2"}
        quiet = client.post("/api/analyze", files={"image": ("r.jpg", img, "image/jpeg")},
                            data={**common, "road_class": "LOC", "aadt": "500"}).json()
        busy = client.post("/api/analyze", files={"image": ("r.jpg", img, "image/jpeg")},
                           data={**common, "road_class": "NH", "aadt": "45000"}).json()
        assert busy["scoring"]["rpi"] > quiet["scoring"]["rpi"]
        assert busy["scoring"]["pci"] == pytest.approx(quiet["scoring"]["pci"])

    def test_saving_creates_a_retrievable_segment(self, client):
        r = client.post("/api/analyze",
                        files={"image": ("road.jpg", road_image(), "image/jpeg")},
                        data={"segment_name": "Test Road Alpha", "save": "true"}).json()
        assert r["saved"] and r["segment_id"]
        detail = client.get(f"/api/segments/{r['segment_id']}")
        assert detail.status_code == 200
        assert detail.json()["latest"]

    def test_naming_without_an_id_still_files_the_inspection(self, client):
        """An inspection that lands on no segment is invisible in the register."""
        r = client.post("/api/analyze",
                        files={"image": ("road.jpg", road_image(), "image/jpeg")},
                        data={"segment_name": "Derived Id Road", "save": "true"}).json()
        assert r["segment_id"]

    def test_stored_image_is_served_back(self, client):
        r = client.post("/api/analyze",
                        files={"image": ("road.jpg", road_image(), "image/jpeg")},
                        data={"save": "true"}).json()
        assert client.get(r["image_url"]).status_code == 200

    def test_preview_does_not_touch_the_register(self, client):
        before = client.get("/api/health").json()["inspections"]
        client.post("/api/analyze",
                    files={"image": ("road.jpg", road_image(), "image/jpeg")},
                    data={"segment_name": "Preview Only Road", "save": "false"})
        assert client.get("/api/health").json()["inspections"] == before
        assert client.get("/api/segments/SEG-PREVIEW-ONLY-ROAD").status_code == 404

    def test_saving_a_preview_pins_it_on_the_map(self, client):
        prev = client.post("/api/analyze",
                           files={"image": ("road.jpg", road_image(), "image/jpeg")},
                           data={"road_class": "NH", "save": "false"}).json()
        r = client.post(f"/api/analyze/{prev['id']}/save",
                        json={"segment_name": "Saved Later Road", "ward": "Rohini",
                              "lat": 28.7041, "lon": 77.1025})
        assert r.status_code == 200
        body = r.json()
        assert body["saved"] and body["segment_id"] == "SEG-SAVED-LATER-ROAD"
        assert body["scoring"]["rpi"] == pytest.approx(prev["scoring"]["rpi"])
        assert client.get(body["image_url"]).status_code == 200

        seg = next(s for s in client.get("/api/segments").json()["segments"]
                   if s["id"] == body["segment_id"])
        assert (seg["lat"], seg["lon"]) == (28.7041, 77.1025)
        assert seg["ward"] == "Rohini" and seg["road_class"] == "NH"
        assert seg["inspection_id"] == prev["id"]

    def test_a_preview_saves_only_once(self, client):
        prev = client.post("/api/analyze",
                           files={"image": ("road.jpg", road_image(), "image/jpeg")},
                           data={"save": "false"}).json()
        payload = {"segment_name": "Once Only Road", "lat": 28.6, "lon": 77.2}
        assert client.post(f"/api/analyze/{prev['id']}/save", json=payload).status_code == 200
        assert client.post(f"/api/analyze/{prev['id']}/save", json=payload).status_code == 404

    def test_saving_needs_a_name_and_a_location(self, client):
        prev = client.post("/api/analyze",
                           files={"image": ("road.jpg", road_image(), "image/jpeg")},
                           data={"save": "false"}).json()
        url = f"/api/analyze/{prev['id']}/save"
        assert client.post(url, json={"lat": 28.6, "lon": 77.2}).status_code == 400
        assert client.post(url, json={"segment_name": "No Pin Road"}).status_code == 400
        assert client.post(url, json={"segment_name": "Bad Pin Road",
                                      "lat": 200, "lon": 77.2}).status_code == 400

    def test_saving_an_unknown_analysis_is_404(self, client):
        for bad in ("00000000-0000-0000-0000-000000000000", "not-an-id", "..%2F..%2Fsecret"):
            r = client.post(f"/api/analyze/{bad}/save",
                            json={"segment_name": "X", "lat": 1, "lon": 1})
            # A traversal attempt may not even reach the route (405 from the
            # static mount); what matters is that nothing is saved.
            assert r.status_code in (404, 405)

    def test_rejects_a_non_image(self, client):
        r = client.post("/api/analyze",
                        files={"image": ("notes.txt", b"this is not an image", "text/plain")},
                        data={"save": "false"})
        assert r.status_code == 400

    def test_rejects_an_empty_upload(self, client):
        r = client.post("/api/analyze",
                        files={"image": ("empty.jpg", b"", "image/jpeg")},
                        data={"save": "false"})
        assert r.status_code == 400

    def test_rejects_an_unknown_road_class(self, client):
        r = client.post("/api/analyze",
                        files={"image": ("road.jpg", road_image(), "image/jpeg")},
                        data={"road_class": "MOON", "save": "false"})
        assert r.status_code == 400


# ======================================================================
# Rescoring
# ======================================================================
def test_rescore_responds_to_context(client):
    dets = [{"code": "D40", "severity": "high", "area_ratio": 0.06, "confidence": 0.9}]
    quiet = client.post("/api/rescore", json={
        "detections": dets, "context": {"road_class": "LOC", "aadt": 400}}).json()
    busy = client.post("/api/rescore", json={
        "detections": dets, "context": {"road_class": "NH", "aadt": 40000}}).json()
    assert busy["scoring"]["rpi"] > quiet["scoring"]["rpi"]


def test_rescore_ignores_unknown_context_keys(client):
    r = client.post("/api/rescore", json={
        "detections": [], "context": {"aadt": 9000, "nonsense": "value"}})
    assert r.status_code == 200


def test_rescore_with_no_detections(client):
    r = client.post("/api/rescore", json={"detections": [], "context": {}})
    assert r.status_code == 200
    assert r.json()["scoring"]["pci"] == 100.0


# ======================================================================
# Budget
# ======================================================================
class TestBudget:
    def test_never_overspends(self, client):
        for amount in (10_000_000, 100_000_000, 900_000_000):
            plan = client.get(f"/api/budget?amount={amount}").json()
            assert plan["allocated"] <= amount

    def test_more_budget_funds_more(self, client):
        small = client.get("/api/budget?amount=20000000").json()
        large = client.get("/api/budget?amount=600000000").json()
        assert large["funded_count"] >= small["funded_count"]

    def test_deferred_cost_and_shortfall_are_distinct(self, client):
        plan = client.get("/api/budget?amount=30000000").json()
        assert "deferred_cost" in plan and "shortfall" in plan
        assert plan["deferred_cost"] >= plan["shortfall"]

    def test_rejects_a_non_positive_budget(self, client):
        assert client.get("/api/budget?amount=0").status_code == 422


# ======================================================================
# Analytics and segments
# ======================================================================
def test_analytics_shape(client):
    a = client.get("/api/analytics").json()
    for key in ("totals", "bands", "damage", "by_class", "by_treatment", "trend"):
        assert key in a
    assert a["totals"]["segments"] > 0
    assert 0 <= a["totals"]["avg_pci"] <= 100


def test_segment_detail_includes_history(client):
    seg_id = client.get("/api/segments").json()["segments"][0]["id"]
    d = client.get(f"/api/segments/{seg_id}").json()
    assert d["segment"]["id"] == seg_id
    assert len(d["history"]) >= 1
    assert d["latest"]["rpi"] is not None


def test_unknown_segment_is_404(client):
    assert client.get("/api/segments/NOPE").status_code == 404


def test_segment_filters(client):
    p1 = client.get("/api/segments?band=P1").json()
    assert all(s["band_code"] == "P1" for s in p1["segments"])
    nh = client.get("/api/segments?road_class=NH").json()
    assert all(s["road_class"] == "NH" for s in nh["segments"])


def test_image_endpoint_rejects_path_traversal(client):
    """A path segment from the network is never trusted."""
    for probe in ("../../roadai.db", "..%2f..%2ftest.db", "....//test.db"):
        assert client.get(f"/api/image/{probe}").status_code in (404, 400)
