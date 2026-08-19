"""Classical computer-vision detector — the zero-download baseline.

This engine is deliberately *not* a neural network. It is a hand-built distress
detector using morphology and contour analysis, and it exists so the system is
useful the moment it is installed, without a 2.5 GB PyTorch download or a
trained checkpoint. The UI always states which engine produced a result.

Pipeline
    1. Segment the pavement region (asphalt is low-saturation, mid-dark and
       textured, and occupies the lower part of a forward-facing frame).
    2. Potholes  — dark, compact, closed blobs that are markedly darker than
       their immediate surround.
    3. Cracks    — thin dark linear structures recovered with oriented black-hat
       morphology, then classified longitudinal / transverse by orientation.
    4. Alligator — cells where crack energy is high in *several* orientations
       at once, which is what fatigue cracking looks like.

What it deliberately does NOT detect
    Ravelling, rutting and edge break. A texture-variance ravelling detector was
    built and then removed: measured across controlled test imagery, the local
    texture statistics of sound and ravelled pavement were indistinguishable
    (25th-percentile sigma 3.2 vs 3.1, maxima 15.0 vs 12.8). Any threshold that
    caught real ravelling also flagged sound road, and the failure mode is the
    expensive direction — recommending resurfacing for a pavement that does not
    need it. These three classes stay in the taxonomy and are reported by the
    trained neural engine, which learns them from labelled examples rather than
    from a hand-picked statistic.

Accuracy is well below a model trained on RDD2022; it is a baseline, and
`training/` exists to replace it.
"""
from __future__ import annotations

import time

import cv2
import numpy as np

from .base import Detection, DetectionResult, clamp, nms, severity_from

# Longest edge the analysis runs at. Keeps a phone photo under ~150 ms.
WORK_SIZE = 900


class CVDetector:
    name = "cv-morphology"
    label = "Morphological CV baseline"
    kind = "heuristic"

    def available(self) -> bool:
        return True

    # ------------------------------------------------------------------
    def detect(self, image_bgr: np.ndarray, conf_threshold: float = 0.25) -> DetectionResult:
        t0 = time.perf_counter()
        h0, w0 = image_bgr.shape[:2]

        img = _fit(image_bgr, WORK_SIZE)
        h, w = img.shape[:2]

        pavement = _pavement_mask(img)
        pav_frac = float(pavement.mean() / 255.0)

        # Two grayscale views, because the two defect families need opposite
        # preprocessing.
        #
        #   raw — denoised only. A pothole is defined by being *absolutely*
        #         darker than the road around it, and CLAHE destroys exactly
        #         that: its tiles land at roughly pothole scale, so it
        #         normalises each pothole up to mid-grey and the cavity
        #         vanishes before the detector ever sees it.
        #   eq  — gently equalised. Cracks are thin and low-contrast, and do
        #         need the local boost to survive thresholding.
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray_raw = cv2.bilateralFilter(cv2.medianBlur(gray, 3), 7, 40, 40)
        gray_eq = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8)).apply(gray)
        gray_eq = cv2.bilateralFilter(cv2.medianBlur(gray_eq, 3), 7, 40, 40)

        dets: list[Detection] = []
        warnings: list[str] = []

        if pav_frac < 0.06:
            warnings.append(
                "Very little road surface was found in this frame. Point the camera at the "
                "carriageway for a reliable reading."
            )
        else:
            dets += _find_potholes(gray_raw, pavement, (w, h))
            crack_map, dets_cracks = _find_cracks(gray_eq, pavement, (w, h))
            dets += dets_cracks
            dets += _find_alligator(crack_map, pavement, (w, h))
            # Ravelling is deliberately NOT detected here — see the module
            # docstring. It is reported only by the trained neural engine.

        pav_px = max(1.0, float(pavement.sum()) / 255.0)
        for d in dets:
            d.area_ratio = clamp((d.w * w) * (d.h * h) / pav_px, 0.0, 1.0)
            d.severity = severity_from(d.area_ratio, d.confidence, d.code)

        dets = [d for d in nms(dets) if d.confidence >= conf_threshold]
        dets.sort(key=lambda d: d.confidence, reverse=True)
        dets = dets[:40]

        return DetectionResult(
            detections=dets,
            engine=self.name,
            engine_label=self.label,
            engine_kind=self.kind,
            inference_ms=(time.perf_counter() - t0) * 1000.0,
            image_width=w0,
            image_height=h0,
            pavement_fraction=pav_frac,
            warnings=warnings,
        )


# ----------------------------------------------------------------------
# Stage 1 — pavement segmentation
# ----------------------------------------------------------------------
def _pavement_mask(img: np.ndarray) -> np.ndarray:
    """Rough asphalt mask: weakly coloured, mid-tone, and *textured*.

    The texture test is what makes this work. Sky, water, blank walls and blown
    highlights are all smooth; asphalt is grainy at the aggregate scale. Colour
    alone cannot separate a grey road from a grey sky, and getting that wrong
    inflates the denominator for distress density, which quietly under-scores
    every photo taken with the horizon in frame.

    Not semantic segmentation — just enough to stop sky, foliage and parked
    cars from contributing.
    """
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    sat, val = hsv[:, :, 1], hsv[:, :, 2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    colour_ok = (sat < 80) & (val > 25) & (val < 215)

    f = gray.astype(np.float32)
    mean = cv2.blur(f, (7, 7))
    var = cv2.blur(f * f, (7, 7)) - mean * mean
    std = np.sqrt(np.maximum(var, 0))
    texture_ok = std > 2.6

    base = (colour_ok & texture_ok).astype(np.uint8) * 255

    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))

    def finish(m):
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        if n > 1:
            biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            if stats[biggest, cv2.CC_STAT_AREA] > 0.04 * h * w:
                m = (labels == biggest).astype(np.uint8) * 255

        # Fill interior holes. The texture test rejects smooth regions, and the
        # inside of a pothole — deep shadow, standing water, or fresh tar — is
        # exactly that. Left unfilled, the mask cuts out the very defect the
        # detector exists to find, and the pothole stage never sees it. A
        # smooth patch fully enclosed by carriageway is carriageway.
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if cnts:
            filled = np.zeros_like(m)
            cv2.drawContours(filled, cnts, -1, 255, cv2.FILLED)
            m = filled
        return m

    # A forward-facing road photo puts the carriageway in the lower frame, so
    # ramp a positional prior in rather than hard-cropping.
    ramp = np.linspace(0.15, 1.0, h, dtype=np.float32)[:, None]
    ramped = finish(((base.astype(np.float32) * ramp) > 110).astype(np.uint8) * 255)

    # If the prior leaves almost nothing, the frame is probably top-down (drone
    # or trolley-mounted) and the road fills it. Fall back to the flat mask
    # rather than reporting an empty carriageway.
    if ramped.mean() / 255.0 < 0.10:
        flat = finish(base)
        if flat.mean() > ramped.mean():
            return flat
    return ramped


# ----------------------------------------------------------------------
# Stage 2 — potholes
# ----------------------------------------------------------------------
def _find_potholes(gray: np.ndarray, pavement: np.ndarray, wh) -> list[Detection]:
    w, h = wh
    out: list[Detection] = []

    # A pothole is darker than the road *around it*, so the test is against a
    # local background estimate rather than a global threshold — that is what
    # survives shadows and uneven exposure.
    #
    # The estimate comes from a morphological closing, not a blur. A blur wide
    # enough to span a pothole is dragged down by the pothole's own darkness,
    # so the difference collapses toward zero at the centre — the deepest part
    # of the defect goes undetected. Closing with a kernel larger than the
    # defect erases it outright, leaving a clean picture of what the road would
    # look like intact. It runs on a quarter-scale copy to keep a kernel that
    # wide affordable.
    # The kernel has to be *wider than the defect*, or it fits inside the
    # pothole, fails to close over it, and the centre of the cavity reports
    # zero contrast — the deepest part of the defect goes missing. Sizing it to
    # a fraction of the frame keeps that true at any resolution; running at
    # eighth scale keeps a kernel that wide cheap.
    sw, sh = max(24, w // 8), max(24, h // 8)
    small = cv2.resize(gray, (sw, sh), interpolation=cv2.INTER_AREA)
    ksz = max(9, int(0.20 * sw) | 1)
    kbg = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz))
    bg = cv2.resize(cv2.morphologyEx(small, cv2.MORPH_CLOSE, kbg), (w, h),
                    interpolation=cv2.INTER_LINEAR)
    bg = cv2.GaussianBlur(bg, (0, 0), sigmaX=max(4, w // 180))   # soften upscale steps
    diff = cv2.subtract(bg, gray)                       # positive where darker
    diff = cv2.bitwise_and(diff, diff, mask=pavement)

    # Adaptive, but bounded at both ends. A bare percentile is set by whatever
    # the darkest few percent of the frame happens to be: one crack network or
    # a shadowed kerb pushes it above the contrast of a genuine pothole, and
    # every real cavity then falls below the threshold and is never seen. The
    # cap keeps the test anchored to what "meaningfully darker than the road
    # around it" actually means in grey levels.
    pct = float(np.percentile(diff[pavement > 0], 96.0)) if np.any(pavement) else 20.0
    thr = int(clamp(pct, 16.0, 46.0))
    dark = (diff >= thr).astype(np.uint8) * 255

    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, k, iterations=2)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, k)

    cnts, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = float(w * h)

    # The local test alone is not sufficient. Between bright lane markings the
    # ordinary road surface sits well below its own local background estimate,
    # so plain asphalt reads as a cavity. Requiring the candidate to also be
    # darker than the road as a whole removes that class of false positive
    # without touching real potholes, which are far darker than the median.
    road_median = float(np.median(gray[pavement > 0])) if np.any(pavement) else 128.0

    for c in cnts:
        area = cv2.contourArea(c)
        if area < frame_area * 0.0009 or area > frame_area * 0.30:
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        if bw < 8 or bh < 8:
            continue

        ar = bw / float(bh)
        if not (0.35 <= ar <= 3.0):
            continue

        hull = cv2.convexHull(c)
        hull_area = cv2.contourArea(hull)
        solidity = area / hull_area if hull_area > 0 else 0.0
        if solidity < 0.62:                     # a crack network, not a cavity
            continue

        extent = area / float(bw * bh)
        if extent < 0.38:
            continue

        mask_roi = dark[y:y + bh, x:x + bw] > 0
        if not mask_roi.any():
            continue

        # Absolute darkness gate — see road_median above.
        inner = float(np.mean(gray[y:y + bh, x:x + bw][mask_roi]))
        if inner > road_median - 10.0:
            continue

        # How much darker is the blob than the ring just outside it?
        depth = float(np.mean(diff[y:y + bh, x:x + bw][mask_roi]) or 0)
        contrast = clamp((depth - 12.0) / 45.0)

        # Rounded and solid reads as a cavity; ragged reads as staining.
        shape = clamp((solidity - 0.62) / 0.32) * 0.5 + clamp((extent - 0.38) / 0.42) * 0.5
        size = clamp((area / frame_area) / 0.045)

        conf = clamp(0.26 + 0.40 * contrast + 0.26 * shape + 0.10 * size)
        if conf < 0.22:
            continue

        out.append(Detection(
            code="D40", confidence=round(conf, 3),
            x=x / w, y=y / h, w=bw / w, h=bh / h,
            notes=f"depth contrast {depth:.0f}/255, solidity {solidity:.2f}",
        ))
    return out


# ----------------------------------------------------------------------
# Stage 3 — cracks
# ----------------------------------------------------------------------
_ANGLES = (0, 45, 90, 135)


def _oriented_blackhat(gray: np.ndarray, length: int) -> dict[int, np.ndarray]:
    """Black-hat with a *line* kernel per orientation.

    A black-hat response is strong where a thin dark structure fits inside the
    kernel, so a line kernel at angle θ lights up cracks running at θ and
    ignores everything else. Four orientations give both the crack map and the
    orientation evidence the alligator test needs.
    """
    res: dict[int, np.ndarray] = {}
    for ang in _ANGLES:
        k = np.zeros((length, length), np.uint8)
        k[length // 2, :] = 1
        if ang:
            m = cv2.getRotationMatrix2D((length / 2 - 0.5, length / 2 - 0.5), ang, 1.0)
            k = cv2.warpAffine(k, m, (length, length), flags=cv2.INTER_NEAREST)
        res[ang] = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, k)
    return res


def _find_cracks(gray: np.ndarray, pavement: np.ndarray, wh):
    """Recover cracks as *anisotropic* dark linear structure.

    The key step is the difference between the strongest and weakest oriented
    black-hat response. A crack answers strongly to the kernel aligned across
    it and weakly to the one along it, so the difference is large. Aggregate
    speckle, tar spots and grit are isotropic — they answer about the same to
    all four orientations, so the difference collapses to nothing.

    Thresholding the raw response instead lets surface texture dominate: on a
    normal asphalt photo the noise floor sits above the crack signal, and every
    real crack is lost below it.
    """
    w, h = wh
    length = max(15, (w // 30) | 1)
    responses = _oriented_blackhat(gray, length)

    stack = np.stack([responses[a] for a in _ANGLES]).astype(np.int16)
    linear = np.clip(stack.max(axis=0) - stack.min(axis=0), 0, 255).astype(np.uint8)
    linear = cv2.bitwise_and(linear, linear, mask=pavement)

    vals = linear[pavement > 0]
    if vals.size == 0:
        return np.zeros_like(linear), []

    thr = max(9, int(np.percentile(vals, 99.0)))
    binm = (linear >= thr).astype(np.uint8) * 255
    # Close along the crack to bridge the gaps a dashed crack leaves behind.
    binm = cv2.morphologyEx(binm, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))

    n, labels, stats, _ = cv2.connectedComponentsWithStats(binm, 8)
    clean = np.zeros_like(binm)
    out: list[Detection] = []
    frame_area = float(w * h)

    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        x, y, bw, bh = (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
                        stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT])
        span = max(bw, bh)
        if area < 40 or span < w * 0.04:
            continue

        thickness = area / float(span)
        elongation = span / max(1.0, float(min(bw, bh)))
        if thickness > 16 or elongation < 2.0:      # a blob, not a crack
            continue

        clean[labels == i] = 255

        # Orientation from the bounding box: a tall box runs along the road
        # (longitudinal), a wide one runs across it (transverse). This matches
        # how a forward-facing phone or dashcam sees the two families.
        code = "D00" if bh >= bw else "D10"

        strength = float(np.mean(linear[labels == i]))
        conf = clamp(0.22
                     + 0.34 * clamp((strength - thr) / 35.0)
                     + 0.28 * clamp((span / w - 0.04) / 0.42)
                     + 0.16 * clamp((elongation - 2.0) / 8.0))
        if conf < 0.22 or area > frame_area * 0.2:
            continue

        pad = 3
        out.append(Detection(
            code=code, confidence=round(conf, 3),
            x=max(0, x - pad) / w, y=max(0, y - pad) / h,
            w=min(w, bw + 2 * pad) / w, h=min(h, bh + 2 * pad) / h,
            notes=f"length {span}px, mean width {thickness:.1f}px",
        ))

    return clean, out


# ----------------------------------------------------------------------
# Stage 4 — alligator / fatigue cracking
# ----------------------------------------------------------------------
def _find_alligator(crack_map: np.ndarray, pavement: np.ndarray, wh) -> list[Detection]:
    """Fatigue cracking = lots of crack length, in several directions, in one place.

    Scanned on a coarse grid: any cell whose crack density is high gets merged
    with its neighbours into one region, because alligator cracking is reported
    as an *area* of distress rather than as individual cracks.
    """
    w, h = wh
    cell = max(24, w // 16)
    gh, gw = h // cell, w // cell
    if gh < 2 or gw < 2:
        return []

    density = np.zeros((gh, gw), np.float32)
    for gy in range(gh):
        for gx in range(gw):
            sl = (slice(gy * cell, (gy + 1) * cell), slice(gx * cell, (gx + 1) * cell))
            if pavement[sl].mean() < 140:
                continue
            density[gy, gx] = crack_map[sl].mean() / 255.0

    hot = (density > 0.055).astype(np.uint8)
    if hot.sum() < 2:
        return []

    # Must be an odd kernel. An even-sized structuring element has no true
    # centre, so OpenCV's anchor offsets the result by a cell — the labelled
    # components then no longer line up with the cells whose density produced
    # them, and every region reports zero density and is discarded.
    hot = cv2.morphologyEx(hot, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(hot, 8)

    out: list[Detection] = []
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 2:          # needs to be a patch
            continue
        x, y, bw, bh = (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
                        stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT])
        # Measured over the genuinely cracked cells only. The closing above
        # pulls in empty neighbours to join the patch, and averaging those in
        # drags the reported density to zero.
        member = (labels == i) & (density > 0)
        if not member.any():
            continue
        mean_density = float(density[member].mean())
        cells = int(member.sum())

        conf = clamp(0.30 + 0.42 * clamp((mean_density - 0.055) / 0.16)
                     + 0.28 * clamp((cells - 2) / 12.0))
        if conf < 0.28:
            continue

        out.append(Detection(
            code="D20", confidence=round(conf, 3),
            x=(x * cell) / w, y=(y * cell) / h,
            w=(bw * cell) / w, h=(bh * cell) / h,
            notes=f"{cells} cells, crack density {mean_density * 100:.1f}%",
        ))
    return out


# ----------------------------------------------------------------------
def _fit(img: np.ndarray, longest: int) -> np.ndarray:
    h, w = img.shape[:2]
    s = longest / float(max(h, w))
    if s >= 1.0:
        return img.copy()
    return cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
