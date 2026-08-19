"""Shared types for the detection layer.

Both engines (classical CV and YOLO) return the same `Detection` shape, so the
scoring engine downstream never needs to know which one produced it.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Protocol, Sequence


@dataclass
class Detection:
    """One detected distress instance in image space."""

    code: str                 # key into config.DAMAGE_TYPES
    confidence: float         # 0..1
    # Bounding box in *normalised* coordinates so it survives any resize.
    x: float
    y: float
    w: float
    h: float
    severity: str = "low"     # low | medium | high
    area_ratio: float = 0.0   # box area as a fraction of the analysed pavement
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class DetectionResult:
    detections: list[Detection] = field(default_factory=list)
    engine: str = "unknown"
    engine_label: str = "Unknown engine"
    engine_kind: str = "heuristic"      # heuristic | neural
    inference_ms: float = 0.0
    image_width: int = 0
    image_height: int = 0
    # Fraction of the frame the engine treated as pavement. Density is measured
    # against this rather than the whole image, so a photo that is mostly sky
    # does not dilute the distress count.
    pavement_fraction: float = 1.0
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["detections"] = [x.to_dict() for x in self.detections]
        return d


class DetectorEngine(Protocol):
    """What every engine must provide."""

    name: str
    label: str
    kind: str

    def available(self) -> bool: ...

    def detect(self, image_bgr, conf_threshold: float = 0.25) -> DetectionResult: ...


def severity_from(area_ratio: float, confidence: float, code: str) -> str:
    """Bucket a detection into low/medium/high.

    Severity is driven mostly by how much pavement the defect covers, nudged by
    detector confidence. Potholes escalate faster than cracks because a small
    pothole is already a hazard while a hairline crack is not.
    """
    scale = 2.0 if code in ("D40", "RUT") else 1.0
    s = area_ratio * scale * (0.6 + 0.4 * confidence)
    if s >= 0.055:
        return "high"
    if s >= 0.018:
        return "medium"
    return "low"


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def nms(dets: Sequence[Detection], iou_thresh: float = 0.45) -> list[Detection]:
    """Greedy non-maximum suppression across all classes.

    Applied class-agnostically on purpose: a pothole and an alligator-crack box
    over the same patch of road are one defect to a road engineer, and counting
    both would double-weight it in the score.
    """
    out: list[Detection] = []
    for d in sorted(dets, key=lambda x: x.confidence, reverse=True):
        keep = True
        for k in out:
            if _iou(d, k) > iou_thresh:
                keep = False
                break
        if keep:
            out.append(d)
    return out


def _iou(a: Detection, b: Detection) -> float:
    ax2, ay2 = a.x + a.w, a.y + a.h
    bx2, by2 = b.x + b.w, b.y + b.h
    ix = max(0.0, min(ax2, bx2) - max(a.x, b.x))
    iy = max(0.0, min(ay2, by2) - max(a.y, b.y))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0
