"""Tests for the detection layer.

Detector *accuracy* cannot be asserted without a labelled dataset, so these
test the properties that must hold regardless: bounded normalised output,
correct suppression of duplicates, and the specific failure modes that were
found and fixed during development. Each of those was a silent wrong answer
rather than a crash, which is exactly the kind of regression a test suite is
for.
"""
from __future__ import annotations

import cv2
import numpy as np
import pytest

from backend.detection.base import Detection, nms, severity_from
from backend.detection.cv_detector import CVDetector, _pavement_mask, _fit
from backend.detection.registry import detect, engine_status

W, H = 640, 480
HORIZON = 150


# ----------------------------------------------------------------------
# Fixtures — synthetic scenes with known ground truth
# ----------------------------------------------------------------------
def _base_scene(rng):
    """Textured asphalt below a smooth bright sky."""
    img = np.zeros((H, W, 3), np.uint8)
    img[:HORIZON] = (205, 198, 186)                     # smooth sky
    road = np.full((H - HORIZON, W, 3), 92, np.float32)
    road += rng.normal(0, 9, road.shape)                # aggregate texture
    img[HORIZON:] = np.clip(road, 0, 255).astype(np.uint8)
    return img


@pytest.fixture
def clean_road():
    return _base_scene(np.random.default_rng(1))


@pytest.fixture
def road_with_pothole():
    rng = np.random.default_rng(2)
    img = _base_scene(rng)
    cx, cy = W // 2, 360
    pts = np.array([[cx + int(52 * np.cos(t)) + rng.integers(-7, 7),
                     cy + int(34 * np.sin(t)) + rng.integers(-6, 6)]
                    for t in np.linspace(0, 2 * np.pi, 18, endpoint=False)], np.int32)
    cv2.fillPoly(img, [pts], (38, 36, 35))
    cv2.polylines(img, [pts], True, (66, 64, 60), 3)
    return img, (cx / W, cy / H)


@pytest.fixture
def road_with_markings():
    """Bright lane dashes — the surface between them is ordinary road, and
    must not be reported as a cavity."""
    rng = np.random.default_rng(3)
    img = _base_scene(rng)
    for y in range(HORIZON + 20, H, 44):
        cv2.rectangle(img, (W // 2 - 5, y), (W // 2 + 5, y + 22), (228, 228, 222), -1)
    return img


# ======================================================================
# Shared helpers
# ======================================================================
class TestSeverity:
    def test_larger_defects_are_more_severe(self):
        order = ["low", "medium", "high"]
        prev = -1
        for area in (0.001, 0.03, 0.20):
            idx = order.index(severity_from(area, 0.9, "D00"))
            assert idx >= prev
            prev = idx

    def test_potholes_escalate_faster_than_cracks(self):
        """A small pothole is already a hazard; a hairline crack is not."""
        area = 0.03
        pothole = severity_from(area, 0.9, "D40")
        crack = severity_from(area, 0.9, "D00")
        assert ["low", "medium", "high"].index(pothole) >= \
               ["low", "medium", "high"].index(crack)


class TestNMS:
    def test_removes_duplicate_boxes(self):
        a = Detection("D40", 0.9, 0.1, 0.1, 0.2, 0.2)
        b = Detection("D40", 0.5, 0.11, 0.11, 0.2, 0.2)
        assert len(nms([a, b])) == 1

    def test_keeps_the_more_confident_one(self):
        a = Detection("D40", 0.4, 0.1, 0.1, 0.2, 0.2)
        b = Detection("D40", 0.95, 0.11, 0.11, 0.2, 0.2)
        assert nms([a, b])[0].confidence == 0.95

    def test_keeps_separate_defects(self):
        a = Detection("D40", 0.9, 0.05, 0.05, 0.1, 0.1)
        b = Detection("D40", 0.9, 0.7, 0.7, 0.1, 0.1)
        assert len(nms([a, b])) == 2

    def test_is_class_agnostic(self):
        """A pothole and an alligator box over the same patch are one defect to
        an engineer; counting both double-weights it in the score."""
        a = Detection("D40", 0.9, 0.1, 0.1, 0.3, 0.3)
        b = Detection("D20", 0.6, 0.11, 0.11, 0.3, 0.3)
        assert len(nms([a, b])) == 1

    def test_empty_input(self):
        assert nms([]) == []


# ======================================================================
# Pavement segmentation
# ======================================================================
class TestPavementMask:
    def test_sky_is_excluded(self, clean_road):
        """Colour alone cannot separate grey road from grey sky. Getting this
        wrong inflates the density denominator and under-scores every photo
        taken with the horizon in frame."""
        work = _fit(clean_road, 900)
        mask = _pavement_mask(work)
        h = work.shape[0]
        assert mask[:h // 5].mean() / 255 < 0.10
        assert mask.mean() / 255 > 0.25

    def test_pothole_interior_stays_inside_the_mask(self, road_with_pothole):
        """The texture test rejects smooth regions, and a pothole interior is
        smooth. Unfilled, the mask cuts out the very defect being looked for."""
        img, (cx, cy) = road_with_pothole
        work = _fit(img, 900)
        mask = _pavement_mask(work)
        h, w = work.shape[:2]
        assert mask[int(cy * h), int(cx * w)] > 0

    def test_returns_a_binary_mask(self, clean_road):
        mask = _pavement_mask(_fit(clean_road, 900))
        assert set(np.unique(mask)).issubset({0, 255})


# ======================================================================
# The classical engine
# ======================================================================
class TestCVDetector:
    def test_is_always_available(self):
        assert CVDetector().available()

    def test_detects_a_pothole_in_roughly_the_right_place(self, road_with_pothole):
        img, (cx, cy) = road_with_pothole
        result = CVDetector().detect(img, conf_threshold=0.2)
        holes = [d for d in result.detections if d.code == "D40"]
        assert holes, "a clear dark cavity must be found"
        best = max(holes, key=lambda d: d.confidence)
        assert abs((best.x + best.w / 2) - cx) < 0.15
        assert abs((best.y + best.h / 2) - cy) < 0.15

    def test_lane_markings_are_not_potholes(self, road_with_markings):
        """Between bright dashes, ordinary road sits well below its own local
        background estimate. Without an absolute darkness gate the surface
        itself gets reported as a cavity."""
        result = CVDetector().detect(road_with_markings, conf_threshold=0.25)
        assert not [d for d in result.detections if d.code == "D40"]

    def test_clean_road_is_not_flagged_as_severely_damaged(self, clean_road):
        """A false 'reconstruct this' on a sound road is the expensive
        direction to be wrong in."""
        result = CVDetector().detect(clean_road, conf_threshold=0.25)
        severe = [d for d in result.detections if d.severity == "high"]
        assert not severe

    def test_all_output_is_normalised(self, road_with_pothole):
        img, _ = road_with_pothole
        for d in CVDetector().detect(img, conf_threshold=0.15).detections:
            assert 0.0 <= d.x <= 1.0 and 0.0 <= d.y <= 1.0
            assert 0.0 < d.w <= 1.0 and 0.0 < d.h <= 1.0
            assert 0.0 <= d.confidence <= 1.0
            assert 0.0 <= d.area_ratio <= 1.0
            assert d.severity in ("low", "medium", "high")

    def test_confidence_threshold_is_respected(self, road_with_pothole):
        img, _ = road_with_pothole
        loose = CVDetector().detect(img, conf_threshold=0.10)
        strict = CVDetector().detect(img, conf_threshold=0.80)
        assert len(strict.detections) <= len(loose.detections)
        assert all(d.confidence >= 0.80 for d in strict.detections)

    def test_reports_original_image_dimensions(self, clean_road):
        r = CVDetector().detect(clean_road)
        assert (r.image_width, r.image_height) == (W, H)

    def test_warns_when_no_road_is_visible(self):
        sky = np.full((H, W, 3), 210, np.uint8)          # smooth, featureless
        r = CVDetector().detect(sky)
        assert r.pavement_fraction < 0.2
        assert r.warnings

    def test_never_detects_ravelling(self, road_with_pothole):
        """Removed on purpose: sound and ravelled pavement were statistically
        indistinguishable, so every threshold that caught real ravelling also
        flagged good road. It is reported by the neural engine only."""
        img, _ = road_with_pothole
        codes = {d.code for d in CVDetector().detect(img, conf_threshold=0.05).detections}
        assert "RAV" not in codes

    @pytest.mark.parametrize("size", [(64, 48), (200, 150), (1600, 1200)])
    def test_handles_a_range_of_resolutions(self, size):
        rng = np.random.default_rng(9)
        img = np.clip(np.full((size[1], size[0], 3), 95, np.float32)
                      + rng.normal(0, 9, (size[1], size[0], 3)), 0, 255).astype(np.uint8)
        r = CVDetector().detect(img)
        assert r.image_width == size[0] and r.image_height == size[1]

    def test_is_deterministic(self, road_with_pothole):
        img, _ = road_with_pothole
        a = CVDetector().detect(img, conf_threshold=0.2).detections
        b = CVDetector().detect(img, conf_threshold=0.2).detections
        assert [(d.code, round(d.confidence, 4)) for d in a] == \
               [(d.code, round(d.confidence, 4)) for d in b]


# ======================================================================
# Registry
# ======================================================================
class TestRegistry:
    def test_falls_back_to_the_classical_engine(self):
        status = engine_status()
        assert status["active"] in ("cv-morphology", "yolo")
        assert len(status["engines"]) == 2

    def test_result_names_the_engine_that_produced_it(self, clean_road):
        """A score must never be ambiguous about its evidence."""
        r = detect(clean_road)
        assert r.engine and r.engine_label
        assert r.engine_kind in ("heuristic", "neural")

    def test_forcing_the_classical_engine_works(self, clean_road):
        assert detect(clean_road, prefer="cv").engine == "cv-morphology"

    def test_forcing_an_unavailable_engine_raises(self, clean_road):
        from backend import config
        if config.YOLO_WEIGHTS.exists():
            pytest.skip("a trained checkpoint is installed")
        with pytest.raises(RuntimeError):
            detect(clean_road, prefer="yolo")
