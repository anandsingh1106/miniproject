"""Engine selection.

Prefers the trained neural detector, falls back to the classical one. The
active engine is reported on every response so a result is never ambiguous
about how it was produced.
"""
from __future__ import annotations

import numpy as np

from .base import DetectionResult
from .cv_detector import CVDetector
from .yolo_detector import YoloDetector

_cv = CVDetector()
_yolo = YoloDetector()


def active_engine():
    return _yolo if _yolo.available() else _cv


def engine_status() -> dict:
    y = _yolo.status()
    active = active_engine()
    return {
        "active": active.name,
        "active_label": active.label,
        "active_kind": active.kind,
        "engines": [
            {
                "name": _yolo.name, "label": _yolo.label, "kind": _yolo.kind,
                "available": _yolo.available(),
                "detail": (
                    "Trained checkpoint loaded." if y["loaded"]
                    else y["error"] or "No checkpoint at data/models/road_damage.pt. "
                                       "See training/ to produce one."
                ),
            },
            {
                "name": _cv.name, "label": _cv.label, "kind": _cv.kind,
                "available": True,
                "detail": "Always available. Morphology and contour analysis, no training required.",
            },
        ],
    }


def detect(image_bgr: np.ndarray, conf_threshold: float = 0.25,
           prefer: str | None = None) -> DetectionResult:
    """Run detection. `prefer` forces an engine for side-by-side comparison."""
    engine = active_engine()
    if prefer == "cv":
        engine = _cv
    elif prefer == "yolo":
        if not _yolo.available():
            raise RuntimeError(_yolo.status()["error"] or "YOLO engine unavailable")
        engine = _yolo

    result = engine.detect(image_bgr, conf_threshold=conf_threshold)
    if engine is _cv and _yolo.status()["weights_present"] is False:
        result.warnings.append(
            "Running the morphological baseline. Install the optional extras and train a "
            "checkpoint for materially better accuracy — see training/README."
        )
    return result
