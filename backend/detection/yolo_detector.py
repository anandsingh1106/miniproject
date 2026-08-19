"""YOLO detection engine — used automatically when a trained checkpoint exists.

Drop a checkpoint at `data/models/road_damage.pt` and install the optional
extras (`pip install -r requirements-yolo.txt`). The registry picks this engine
up on the next request; nothing else changes.

`training/` contains the pipeline that produces such a checkpoint from RDD2022.
"""
from __future__ import annotations

import time

import numpy as np

from .. import config
from .base import Detection, DetectionResult, clamp, nms, severity_from

# Ultralytics class index -> our taxonomy. RDD2022 ships the first six; a model
# trained with the extended set in training/prepare_dataset.py adds the rest.
DEFAULT_CLASS_MAP = {
    0: "D00", 1: "D10", 2: "D20", 3: "D40", 4: "D43", 5: "D44",
    6: "RAV", 7: "RUT", 8: "EDG",
}


class YoloDetector:
    name = "yolo"
    label = "YOLOv8 (trained on RDD2022)"
    kind = "neural"

    def __init__(self) -> None:
        self._model = None
        self._load_error: str | None = None
        self._tried = False

    # ------------------------------------------------------------------
    def available(self) -> bool:
        if not config.YOLO_WEIGHTS.exists():
            return False
        self._ensure_loaded()
        return self._model is not None

    def status(self) -> dict:
        return {
            "weights_present": config.YOLO_WEIGHTS.exists(),
            "weights_path": str(config.YOLO_WEIGHTS),
            "loaded": self._model is not None,
            "error": self._load_error,
        }

    def _ensure_loaded(self) -> None:
        if self._tried:
            return
        self._tried = True
        try:
            from ultralytics import YOLO  # noqa: PLC0415 — optional dependency
            self._model = YOLO(str(config.YOLO_WEIGHTS))
        except ImportError:
            self._load_error = (
                "ultralytics is not installed. Run: pip install -r requirements-yolo.txt"
            )
        except Exception as exc:                      # corrupt or incompatible weights
            self._load_error = f"Could not load {config.YOLO_WEIGHTS.name}: {exc}"

    # ------------------------------------------------------------------
    def detect(self, image_bgr: np.ndarray, conf_threshold: float = 0.25) -> DetectionResult:
        self._ensure_loaded()
        if self._model is None:
            raise RuntimeError(self._load_error or "YOLO engine unavailable")

        t0 = time.perf_counter()
        h, w = image_bgr.shape[:2]
        res = self._model.predict(image_bgr, conf=conf_threshold, verbose=False)[0]

        # Prefer the names baked into the checkpoint; fall back to our map.
        names = getattr(res, "names", None) or {}

        dets: list[Detection] = []
        boxes = getattr(res, "boxes", None)
        if boxes is not None:
            for b in boxes:
                cls = int(b.cls.item())
                conf = float(b.conf.item())
                code = _resolve(cls, names)
                if code is None:
                    continue
                x1, y1, x2, y2 = (float(v) for v in b.xyxy[0].tolist())
                bw, bh = max(0.0, x2 - x1), max(0.0, y2 - y1)
                if bw <= 0 or bh <= 0:
                    continue
                dets.append(Detection(
                    code=code, confidence=round(conf, 3),
                    x=clamp(x1 / w), y=clamp(y1 / h),
                    w=clamp(bw / w), h=clamp(bh / h),
                ))

        # The neural engine has no pavement mask, so density is measured
        # against the whole frame. Stated here so the score stays comparable.
        for d in dets:
            d.area_ratio = clamp(d.w * d.h)
            d.severity = severity_from(d.area_ratio, d.confidence, d.code)

        dets = nms(dets)
        dets.sort(key=lambda d: d.confidence, reverse=True)

        return DetectionResult(
            detections=dets,
            engine=self.name,
            engine_label=self.label,
            engine_kind=self.kind,
            inference_ms=(time.perf_counter() - t0) * 1000.0,
            image_width=w, image_height=h,
            pavement_fraction=1.0,
        )


def _resolve(cls_idx: int, names: dict) -> str | None:
    raw = names.get(cls_idx) if isinstance(names, dict) else None
    if isinstance(raw, str):
        key = raw.strip().upper()
        if key in config.DAMAGE_TYPES:
            return key
        # Tolerate checkpoints that use descriptive names instead of codes.
        for code, meta in config.DAMAGE_TYPES.items():
            if meta["name"].lower() == raw.strip().lower():
                return code
    return DEFAULT_CLASS_MAP.get(cls_idx)
