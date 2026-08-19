#!/usr/bin/env python
"""Generate the sample road images bundled with the app.

Without these, trying RoadLens requires the user to go and find a road
photograph first — which is enough friction that most people never see the
core feature work at all.

These are *procedurally generated*, not photographs. They are labelled as
synthetic everywhere they appear, and they exist to demonstrate the pipeline,
not to prove detector accuracy. Real survey imagery is what the training
pipeline is for.

    python scripts/make_samples.py

Writes frontend/samples/*.jpg plus a manifest.json describing each one.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "frontend" / "samples"
W, H = 1024, 768
HORIZON = 250


# ----------------------------------------------------------------------
# Surface
# ----------------------------------------------------------------------
def asphalt(rng: np.random.Generator) -> np.ndarray:
    """Multi-scale noise. Real asphalt has structure at several scales at once —
    a single noise octave reads as television static rather than aggregate."""
    base = np.zeros((H, W), np.float32)
    for octave, weight in ((4, 0.45), (8, 0.28), (24, 0.17), (64, 0.10)):
        small = rng.normal(0.5, 0.22, (max(2, H // octave), max(2, W // octave)))
        base += weight * cv2.resize(small.astype(np.float32), (W, H),
                                    interpolation=cv2.INTER_CUBIC)
    base = (base - base.min()) / (np.ptp(base) + 1e-6)   # ndarray.ptp() is gone in NumPy 2

    img = np.full((H, W, 3), 0.0, np.float32)
    tone = 78 + base * 46                                  # mid-grey bitumen
    for c, tint in enumerate((1.02, 1.0, 0.98)):           # faintly cool
        img[:, :, c] = tone * tint

    # Exposed aggregate: small bright chips scattered through the binder.
    chips = (rng.random((H, W)) > 0.982).astype(np.float32)
    chips = cv2.GaussianBlur(chips, (0, 0), 0.7)
    img += chips[..., None] * rng.uniform(28, 46)
    return img


def perspective_light(img: np.ndarray, rng) -> np.ndarray:
    """Distance haze plus a soft directional gradient.

    A flat-lit road looks like a texture swatch. Real frames are brighter and
    lower-contrast toward the horizon, and unevenly lit across the carriageway.
    """
    y = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    depth = np.clip((y - HORIZON / H) / (1 - HORIZON / H), 0, 1)

    # Far road: lifted and flattened by atmospheric haze.
    img = img * (0.80 + 0.20 * depth) + (1 - depth) * 26

    x = np.linspace(-1, 1, W, dtype=np.float32)[None, :, None]
    img *= 1.0 + rng.uniform(-0.09, 0.09) * x

    # Vignette.
    xx, yy = np.meshgrid(np.linspace(-1, 1, W), np.linspace(-1, 1, H))
    img *= (1 - 0.16 * np.sqrt(xx ** 2 + yy ** 2).astype(np.float32))[..., None]
    return img


def scene(rng) -> np.ndarray:
    """Road surface below the horizon, sky and a treeline above it."""
    img = perspective_light(asphalt(rng), rng)

    sky = np.zeros((HORIZON, W, 3), np.float32)
    for i, base in enumerate((196, 186, 172)):             # warm overcast
        sky[:, :, i] = base + np.linspace(26, 0, HORIZON, dtype=np.float32)[:, None]
    cloud = rng.normal(0, 1, (max(2, HORIZON // 18), max(2, W // 18))).astype(np.float32)
    cloud = cv2.GaussianBlur(cv2.resize(cloud, (W, HORIZON),
                                        interpolation=cv2.INTER_CUBIC), (0, 0), 7)
    sky += (cloud / (np.abs(cloud).max() + 1e-6) * 13)[..., None]
    img[:HORIZON] = sky

    # Treeline: a blurred vegetation band, so the pavement mask has something
    # non-road to reject. Drawn as a soft mass rather than per-column noise —
    # a comb of random colours reads as television interference, not foliage.
    band_h = 46
    y0 = HORIZON - band_h
    veg = np.zeros((band_h, W, 3), np.float32)
    veg[:, :, 0] = rng.normal(58, 11, (band_h, W))      # B
    veg[:, :, 1] = rng.normal(74, 13, (band_h, W))      # G — foliage is green
    veg[:, :, 2] = rng.normal(50, 10, (band_h, W))      # R
    veg = cv2.GaussianBlur(veg, (0, 0), 2.4)

    # Ragged upper edge where the canopy meets the sky.
    profile = cv2.GaussianBlur(rng.random((1, W)).astype(np.float32), (0, 0), 9)
    profile = (profile - profile.min()) / (np.ptp(profile) + 1e-6)
    top = (profile[0] * band_h * 0.75).astype(int)
    alpha = np.zeros((band_h, W), np.float32)
    for x in range(W):
        alpha[top[x]:, x] = 1.0
    alpha = cv2.GaussianBlur(alpha, (0, 0), 1.6)[..., None]

    img[y0:HORIZON] = img[y0:HORIZON] * (1 - alpha) + veg * alpha
    img[HORIZON - 2:HORIZON + 2] *= 0.7                  # kerb shadow line
    return img


def surface_character(img, rng) -> None:
    """The marks every real carriageway carries: old patches, oil staining and
    polished wheel paths. Without them the road reads as a clean texture swatch
    and the whole frame looks synthetic."""
    # Polished wheel paths — slightly darker and smoother than the lane centre.
    for lane_x in (W * 0.32, W * 0.68):
        for y in range(HORIZON + 30, H):
            t = (y - HORIZON) / (H - HORIZON)
            half = int(58 * (0.25 + 0.75 * t))
            x = int(W / 2 + (lane_x - W / 2) * (0.25 + 0.75 * t))
            x0, x1 = max(0, x - half), min(W, x + half)
            if x1 > x0:
                img[y, x0:x1] *= 0.955

    # Old reinstatement patches: rectangles of slightly different bitumen.
    for _ in range(rng.integers(1, 4)):
        pw, ph = rng.integers(90, 230), rng.integers(60, 140)
        cx = rng.integers(80, W - 80)
        cy = rng.integers(HORIZON + 120, H - 40)
        x0, y0 = max(0, cx - pw // 2), max(HORIZON, cy - ph // 2)
        x1, y1 = min(W, cx + pw // 2), min(H, cy + ph // 2)
        if x1 <= x0 or y1 <= y0:
            continue
        m = np.zeros((y1 - y0, x1 - x0), np.float32)
        m[:] = 1.0
        m = cv2.GaussianBlur(m, (0, 0), 4)
        img[y0:y1, x0:x1] *= (1 - m * rng.uniform(0.04, 0.11))[..., None]

    # Oil and diesel staining down the lane centre.
    for _ in range(rng.integers(2, 6)):
        cx, cy = rng.integers(120, W - 120), rng.integers(HORIZON + 90, H - 30)
        rx, ry = rng.integers(24, 80), rng.integers(12, 40)
        blob = np.zeros((H, W), np.float32)
        cv2.ellipse(blob, (int(cx), int(cy)), (int(rx), int(ry)),
                    float(rng.uniform(0, 180)), 0, 360, 1.0, -1)
        blob = cv2.GaussianBlur(blob, (0, 0), 11)
        img *= (1 - blob * rng.uniform(0.05, 0.13))[..., None]


def lane_markings(img: np.ndarray, rng, wear: float = 0.0) -> None:
    """Centre dashes and edge lines, converging on the vanishing point."""
    vp = (W // 2, HORIZON)

    def stripe(x_bottom, dash: bool, width: int):
        n = 26
        for i in range(n):
            t0, t1 = i / n, (i + 0.52 if dash else i + 1.0) / n
            if t1 > 1:
                continue
            p0 = (int(vp[0] + (x_bottom - vp[0]) * (t0 ** 1.7)),
                  int(vp[1] + (H - vp[1]) * (t0 ** 1.7)))
            p1 = (int(vp[0] + (x_bottom - vp[0]) * (t1 ** 1.7)),
                  int(vp[1] + (H - vp[1]) * (t1 ** 1.7)))
            fade = rng.uniform(0.35, 1.0) if rng.random() < wear else 1.0
            thick = max(1, int(width * (0.25 + 0.75 * t1)))
            cv2.line(img, p0, p1, (206 * fade, 208 * fade, 202 * fade), thick, cv2.LINE_AA)

    stripe(W // 2, dash=True, width=13)
    stripe(-90, dash=False, width=10)
    stripe(W + 90, dash=False, width=10)


# ----------------------------------------------------------------------
# Distress
# ----------------------------------------------------------------------
def crack(img, rng, start, angle, length, width=2.4, branch=2):
    """A random walk with slight drift and occasional branching.

    Real cracks wander and fork; a straight line reads as a cable or a joint.
    The pale lip either side is the raised, ravelled edge of a working crack —
    without it the crack looks painted on rather than opened up.
    """
    x, y = start
    pts = [(x, y)]
    for _ in range(int(length)):
        angle += rng.normal(0, 0.13)
        x += np.cos(angle) * 2.6
        y += np.sin(angle) * 2.6
        if not (0 <= x < W and HORIZON < y < H):
            break
        pts.append((x, y))
    if len(pts) < 4:
        return

    arr = np.array(pts, np.int32)
    for i in range(len(arr) - 1):
        t = i / max(1, len(arr) - 1)
        w = max(1, int(width * (0.5 + 0.7 * t)))            # wider toward camera
        p0, p1 = tuple(arr[i]), tuple(arr[i + 1])
        # Three passes: a soft dark halo (the ravelled lip), the crack itself,
        # and a faint bright edge where the broken aggregate catches light.
        cv2.line(img, p0, p1, (52, 50, 48), w + 4, cv2.LINE_AA)
        cv2.line(img, p0, p1, (30, 29, 28), w, cv2.LINE_AA)
        if rng.random() < 0.5:
            cv2.line(img, (p0[0] + 1, p0[1]), (p1[0] + 1, p1[1]),
                     (96, 94, 90), 1, cv2.LINE_AA)

    for _ in range(branch):
        if len(arr) < 8:
            break
        i = rng.integers(3, len(arr) - 3)
        crack(img, rng, tuple(arr[i]), angle + rng.uniform(-1.1, 1.1),
              length * rng.uniform(0.18, 0.42), width * 0.68, branch=0)


def alligator(img, rng, cx, cy, w, h):
    """Interlocking fatigue cracking inside an organic, feathered region.

    Drawn onto a separate layer and composited through a soft irregular mask.
    Cracking that stops dead on a rectangle boundary is the single clearest
    tell that an image was generated — real fatigue spreads out and fades at
    its margins.
    """
    # Irregular region mask.
    mask = np.zeros((H, W), np.float32)
    blob = []
    for a in np.linspace(0, 2 * np.pi, 18, endpoint=False):
        rr = 1 + rng.normal(0, 0.14)
        blob.append([cx + np.cos(a) * w / 2 * rr, cy + np.sin(a) * h / 2 * rr])
    cv2.fillPoly(mask, [np.array(blob, np.int32)], 1.0)
    mask = cv2.GaussianBlur(mask, (0, 0), min(w, h) / 7)
    mask = np.clip(mask / (mask.max() + 1e-6), 0, 1)
    mask[:HORIZON] = 0

    layer = img.copy()

    # Fatigued asphalt has lost binder — darker and greyer under the cracking.
    layer *= 0.88

    cols = max(3, int(w / 30))
    rows = max(3, int(h / 26))
    nodes = {}
    for r in range(rows + 1):
        for c in range(cols + 1):
            nodes[(r, c)] = (cx - w / 2 + c * w / cols + rng.normal(0, 7),
                             cy - h / 2 + r * h / rows + rng.normal(0, 6))

    for r in range(rows + 1):
        for c in range(cols + 1):
            for dr, dc in ((0, 1), (1, 0)):
                nb = (r + dr, c + dc)
                if nb not in nodes:
                    continue
                p0 = tuple(np.int32(nodes[(r, c)]))
                p1 = tuple(np.int32(nodes[nb]))
                # Not every cell edge is cracked through yet.
                if rng.random() < 0.12:
                    continue
                cv2.line(layer, p0, p1, (46, 44, 42), 3, cv2.LINE_AA)
                cv2.line(layer, p0, p1, (26, 25, 24), 1, cv2.LINE_AA)

    img[:] = img * (1 - mask[..., None]) + layer * mask[..., None]


def pothole(img, rng, cx, cy, rx, ry):
    """Irregular cavity showing the exposed base course inside.

    A pothole is not a black hole. Once the surface course is gone you are
    looking at broken stone in shadow — dark, but textured and clearly granular.
    Filling it with flat black is the fastest way to make a road image look
    fake, and it also hands the detector an unrealistically easy target.
    """
    pts = []
    for a in np.linspace(0, 2 * np.pi, 24, endpoint=False):
        rr = 1 + rng.normal(0, 0.17)
        pts.append([cx + np.cos(a) * rx * rr, cy + np.sin(a) * ry * rr])
    poly = np.array(pts, np.int32)

    mask = np.zeros((H, W), np.float32)
    cv2.fillPoly(mask, [poly], 1.0)
    mask[:HORIZON] = 0
    if mask.sum() < 4:
        return

    # Exposed base course: coarse broken aggregate, dark but not black.
    rubble = rng.normal(0, 1, (max(2, H // 4), max(2, W // 4))).astype(np.float32)
    rubble = cv2.resize(rubble, (W, H), interpolation=cv2.INTER_CUBIC)
    rubble = cv2.GaussianBlur(rubble, (0, 0), 1.0)
    rubble /= (np.abs(rubble).max() + 1e-6)
    interior = 46 + rubble * 20                       # mid-dark, granular

    # Depth shading: the far wall is in shadow, the near floor catches light.
    yy = np.arange(H, dtype=np.float32)[:, None]
    depth = np.clip((yy - (cy - ry)) / max(1.0, 2 * ry), 0, 1)
    interior = interior * (0.45 + 0.85 * depth)

    img[:] = img * (1 - mask[..., None]) + interior[..., None] * mask[..., None]

    # Ravelled lip: broken edge catching light on the near side.
    cv2.polylines(img, [poly], True, (86, 84, 80), 3, cv2.LINE_AA)
    cv2.polylines(img, [poly], True, (58, 56, 53), 1, cv2.LINE_AA)

    # Loose aggregate thrown out around the rim.
    for _ in range(int(rx * 2.2)):
        a = rng.uniform(0, 2 * np.pi)
        d = rng.uniform(1.02, 1.6)
        px, py = int(cx + np.cos(a) * rx * d), int(cy + np.sin(a) * ry * d)
        if 0 <= px < W and HORIZON < py < H:
            tone = float(rng.uniform(58, 104))
            cv2.circle(img, (px, py), int(rng.integers(1, 4)),
                       (tone, tone, tone * 0.97), -1, cv2.LINE_AA)


def rutting(img, rng, x_centre, width):
    """Wheel-path depression: a broad trough that holds water and shadow.

    Rendered as a smooth cross-sectional profile — darker at the shoulders
    where the surface curves away from the light, with a polished centre.
    """
    for y in range(HORIZON + 30, H):
        t = (y - HORIZON) / (H - HORIZON)
        half = int(width * (0.28 + 0.72 * t))
        x = int(W / 2 + (x_centre - W / 2) * (0.28 + 0.72 * t))
        x0, x1 = max(0, x - half), min(W, x + half)
        if x1 - x0 < 3:
            continue
        u = np.linspace(-1, 1, x1 - x0, dtype=np.float32)
        # Trough: shoulders in shadow, centre burnished slightly brighter.
        profile = 1 - 0.30 * (1 - u ** 2) + 0.10 * np.exp(-(u * 3.2) ** 2)
        img[y, x0:x1] *= profile[:, None]


def ravelling(img, rng, cx, cy, w, h):
    """Aggregate loss: the binder has gone and the stone is standing proud.

    Reads as a markedly coarser, higher-contrast patch — bright chip highlights
    with dark voids between them, feathered into the surrounding surface.
    """
    x0, y0 = max(0, int(cx - w / 2)), max(HORIZON, int(cy - h / 2))
    x1, y1 = min(W, int(cx + w / 2)), min(H, int(cy + h / 2))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return
    ph, pw = y1 - y0, x1 - x0

    # Coarse stone: blobby noise at aggregate scale, not per-pixel grain.
    coarse = rng.normal(0, 1, (max(2, ph // 3), max(2, pw // 3))).astype(np.float32)
    coarse = cv2.resize(coarse, (pw, ph), interpolation=cv2.INTER_CUBIC)
    coarse = cv2.GaussianBlur(coarse, (0, 0), 1.2)
    coarse /= (np.abs(coarse).max() + 1e-6)

    feather = np.zeros((ph, pw), np.float32)
    cv2.ellipse(feather, (pw // 2, ph // 2), (int(pw * 0.44), int(ph * 0.44)),
                0, 0, 360, 1.0, -1)
    feather = cv2.GaussianBlur(feather, (0, 0), min(ph, pw) / 6)
    feather /= feather.max() + 1e-6

    patch = img[y0:y1, x0:x1]
    # Lose some binder (darker overall) and gain contrast (exposed chips).
    img[y0:y1, x0:x1] = (patch * (1 - 0.10 * feather)[..., None]
                         + (coarse * 44 * feather)[..., None])


def finish(img, rng) -> np.ndarray:
    """Sensor noise and a slight blur — a phone photo is never pixel-crisp."""
    img = cv2.GaussianBlur(img, (0, 0), 0.6)
    img += rng.normal(0, 3.4, img.shape).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.uint8)


# ----------------------------------------------------------------------
# The samples
# ----------------------------------------------------------------------
def build(name: str, rng) -> np.ndarray:
    img = scene(rng)
    surface_character(img, rng)

    if name == "good":
        lane_markings(img, rng)
        crack(img, rng, (rng.uniform(200, 800), 700), -1.55, 26, 1.5, branch=0)

    elif name == "cracking":
        lane_markings(img, rng)
        crack(img, rng, (300, 760), -1.50, 130, 3.0, branch=3)
        crack(img, rng, (760, 740), -1.62, 105, 2.6, branch=2)
        for _ in range(3):
            y = rng.uniform(430, 720)
            crack(img, rng, (rng.uniform(120, 300), y), rng.uniform(-0.12, 0.12),
                  rng.uniform(55, 95), 2.3, branch=1)

    elif name == "potholes":
        lane_markings(img, rng, wear=0.3)
        pothole(img, rng, 340, 610, 76, 46)
        pothole(img, rng, 690, 690, 92, 54)
        pothole(img, rng, 520, 470, 38, 22)
        crack(img, rng, (400, 700), -1.4, 45, 2.2, branch=1)

    elif name == "alligator":
        lane_markings(img, rng, wear=0.5)
        alligator(img, rng, 380, 590, 300, 210)
        alligator(img, rng, 720, 690, 240, 170)
        crack(img, rng, (560, 760), -1.5, 70, 2.6, branch=1)

    elif name == "failed":
        lane_markings(img, rng, wear=0.85)
        rutting(img, rng, 330, 105)
        rutting(img, rng, 700, 105)
        alligator(img, rng, 350, 640, 330, 230)
        pothole(img, rng, 690, 660, 104, 60)
        pothole(img, rng, 300, 720, 74, 42)
        ravelling(img, rng, 800, 560, 240, 170)
        crack(img, rng, (540, 770), -1.52, 120, 3.4, branch=3)

    elif name == "ravelled":
        lane_markings(img, rng, wear=0.6)
        ravelling(img, rng, 400, 600, 420, 300)
        ravelling(img, rng, 760, 700, 300, 200)
        crack(img, rng, (620, 750), -1.48, 80, 2.4, branch=1)

    return finish(img, rng)


SAMPLES = [
    ("good", "Sound pavement", "Recently surfaced, one hairline crack.",
     {"road_class": "URB", "aadt": 14000, "last_resurfaced_years": 2}),
    ("cracking", "Longitudinal cracking", "Working cracks along the wheel paths.",
     {"road_class": "URB", "aadt": 22000, "last_resurfaced_years": 6}),
    ("potholes", "Potholes", "Discrete cavities on an otherwise sound surface.",
     {"road_class": "MDR", "aadt": 18000, "last_resurfaced_years": 8}),
    ("alligator", "Fatigue cracking", "Interconnected cracking — the base is failing.",
     {"road_class": "SH", "aadt": 28000, "last_resurfaced_years": 9}),
    ("ravelled", "Ravelling", "Aggregate loss and lost surface texture.",
     {"road_class": "COL", "aadt": 11000, "last_resurfaced_years": 7}),
    ("failed", "Failed carriageway", "Rutting, potholes and fatigue cracking together.",
     {"road_class": "NH", "aadt": 41000, "last_resurfaced_years": 11}),
]


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []

    for i, (key, title, desc, ctx) in enumerate(SAMPLES):
        rng = np.random.default_rng(4100 + i * 17)
        img = build(key, rng)
        fname = f"{key}.jpg"
        cv2.imwrite(str(OUT / fname), img, [cv2.IMWRITE_JPEG_QUALITY, 86])
        size_kb = (OUT / fname).stat().st_size / 1024
        manifest.append({"file": fname, "title": title, "description": desc, "context": ctx})
        print(f"  {fname:<16} {title:<24} {size_kb:6.1f} KB")

    (OUT / "manifest.json").write_text(
        json.dumps({
            "note": "Procedurally generated, not photographs. They demonstrate the "
                    "pipeline; they are not evidence of detector accuracy on real imagery.",
            "samples": manifest,
        }, indent=2), encoding="utf-8")

    print(f"\n{len(manifest)} samples written to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
