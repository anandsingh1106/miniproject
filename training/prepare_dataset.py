#!/usr/bin/env python
"""Convert RDD2022 (Pascal VOC XML) into the YOLO format ultralytics expects.

RDD2022 — the Road Damage Detection benchmark released for the IEEE BigData
Cup — ships one folder per country, each with `images/` and `annotations/xmls/`
in Pascal VOC format. This walks those folders, converts each XML to a YOLO
label file, and writes a train/val split plus the `data.yaml` that
`train_yolo.py` consumes.

    python training/prepare_dataset.py --source data/rdd2022 --out data/yolo

Download the dataset first — see training/README.md. It is ~12 GB across six
countries; `--countries India,Japan` restricts it to what you need.
"""
from __future__ import annotations

import argparse
import random
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.config import DAMAGE_TYPES  # noqa: E402

# Class index order baked into the trained model. Must match
# backend/detection/yolo_detector.py's DEFAULT_CLASS_MAP.
CLASSES = ["D00", "D10", "D20", "D40", "D43", "D44", "RAV", "RUT", "EDG"]
CLASS_INDEX = {c: i for i, c in enumerate(CLASSES)}

# RDD2022 uses a handful of spellings across countries.
ALIASES = {
    "D01": "D00", "D11": "D10", "D0w0": "D00",
    "D50": "D40", "D30": "D20",
}


def _utf8_console() -> None:
    """Make console output safe on a legacy Windows code page.

    A default Windows console runs cp1252 and raises UnicodeEncodeError on any
    character outside it — an arrow in a startup banner is enough to abort the
    process before the server ever starts. Reconfiguring to UTF-8 with a
    replacing error handler makes output degrade instead of crash.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def parse_voc(xml_path: Path):
    """Yield (code, xmin, ymin, xmax, ymax, img_w, img_h) from one VOC file."""
    try:
        root = ET.parse(xml_path).getroot()
    except ET.ParseError:
        return

    size = root.find("size")
    if size is None:
        return
    try:
        iw = int(float(size.findtext("width", "0")))
        ih = int(float(size.findtext("height", "0")))
    except ValueError:
        return
    if iw <= 0 or ih <= 0:
        return

    for obj in root.findall("object"):
        name = (obj.findtext("name") or "").strip().upper()
        code = ALIASES.get(name, name)
        if code not in CLASS_INDEX:
            continue
        box = obj.find("bndbox")
        if box is None:
            continue
        try:
            x1 = float(box.findtext("xmin", "0"))
            y1 = float(box.findtext("ymin", "0"))
            x2 = float(box.findtext("xmax", "0"))
            y2 = float(box.findtext("ymax", "0"))
        except ValueError:
            continue
        if x2 <= x1 or y2 <= y1:
            continue
        yield code, x1, y1, x2, y2, iw, ih


def to_yolo(code, x1, y1, x2, y2, iw, ih) -> str | None:
    """VOC corners -> YOLO centre/size, normalised and clamped to the frame."""
    x1, x2 = max(0.0, x1), min(float(iw), x2)
    y1, y2 = max(0.0, y1), min(float(ih), y2)
    if x2 <= x1 or y2 <= y1:
        return None
    cx = (x1 + x2) / 2 / iw
    cy = (y1 + y2) / 2 / ih
    bw = (x2 - x1) / iw
    bh = (y2 - y1) / ih
    if bw <= 0 or bh <= 0:
        return None
    return f"{CLASS_INDEX[code]} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}"


def main() -> int:
    _utf8_console()
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=Path, default=Path("data/rdd2022"),
                    help="RDD2022 root (contains one folder per country)")
    ap.add_argument("--out", type=Path, default=Path("data/yolo"))
    ap.add_argument("--countries", default="",
                    help="comma-separated subset, e.g. India,Japan (default: all)")
    ap.add_argument("--val-split", type=float, default=0.15)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--copy", action="store_true",
                    help="copy images instead of symlinking (uses more disk)")
    args = ap.parse_args()

    if not args.source.is_dir():
        print(f"Source not found: {args.source}\n"
              f"Download RDD2022 first — see training/README.md", file=sys.stderr)
        return 1

    wanted = {c.strip().lower() for c in args.countries.split(",") if c.strip()}

    pairs: list[tuple[Path, Path]] = []
    for country_dir in sorted(p for p in args.source.iterdir() if p.is_dir()):
        if wanted and country_dir.name.lower() not in wanted:
            continue
        # Layout varies slightly between releases.
        img_dir = next((d for d in (country_dir / "train" / "images",
                                    country_dir / "images") if d.is_dir()), None)
        xml_dir = next((d for d in (country_dir / "train" / "annotations" / "xmls",
                                    country_dir / "annotations" / "xmls") if d.is_dir()), None)
        if not img_dir or not xml_dir:
            print(f"  skipping {country_dir.name}: no images/annotations found")
            continue

        found = 0
        for xml in sorted(xml_dir.glob("*.xml")):
            for ext in (".jpg", ".jpeg", ".png", ".JPG"):
                img = img_dir / (xml.stem + ext)
                if img.exists():
                    pairs.append((img, xml))
                    found += 1
                    break
        print(f"  {country_dir.name}: {found} annotated images")

    if not pairs:
        print("No annotated images found. Check --source and --countries.", file=sys.stderr)
        return 1

    rng = random.Random(args.seed)
    rng.shuffle(pairs)
    cut = int(len(pairs) * (1 - args.val_split))
    splits = {"train": pairs[:cut], "val": pairs[cut:]}

    for split in splits:
        (args.out / "images" / split).mkdir(parents=True, exist_ok=True)
        (args.out / "labels" / split).mkdir(parents=True, exist_ok=True)

    counts = {c: 0 for c in CLASSES}
    empty = 0

    for split, items in splits.items():
        for img, xml in items:
            lines = []
            for rec in parse_voc(xml):
                line = to_yolo(*rec)
                if line:
                    lines.append(line)
                    counts[rec[0]] += 1
            # Images with no boxes are kept: YOLO learns from negatives too,
            # and a survey set is full of undamaged road.
            if not lines:
                empty += 1

            dest_img = args.out / "images" / split / img.name
            if not dest_img.exists():
                if args.copy:
                    shutil.copy2(img, dest_img)
                else:
                    try:
                        dest_img.symlink_to(img.resolve())
                    except OSError:
                        shutil.copy2(img, dest_img)     # Windows without dev mode
            (args.out / "labels" / split / f"{img.stem}.txt").write_text(
                "\n".join(lines), encoding="utf-8")

    yaml_path = args.out / "data.yaml"
    yaml_path.write_text(
        f"# RDD2022 prepared for ultralytics YOLO\n"
        f"path: {args.out.resolve().as_posix()}\n"
        f"train: images/train\n"
        f"val: images/val\n\n"
        f"nc: {len(CLASSES)}\n"
        f"names:\n" + "".join(
            f"  {i}: {c}   # {DAMAGE_TYPES[c]['name']}\n" for i, c in enumerate(CLASSES)
        ), encoding="utf-8")

    print(f"\nPrepared {len(pairs)} images "
          f"({len(splits['train'])} train / {len(splits['val'])} val, {empty} with no boxes)")
    print("Instances per class:")
    for c in CLASSES:
        bar = "#" * min(40, counts[c] // max(1, max(counts.values()) // 40 or 1))
        print(f"  {c}  {DAMAGE_TYPES[c]['name']:<24} {counts[c]:>6}  {bar}")
    print(f"\nWrote {yaml_path}")
    print(f"Next:  python training/train_yolo.py --data {yaml_path}")

    if any(counts[c] == 0 for c in CLASSES):
        missing = [c for c in CLASSES if counts[c] == 0]
        print(f"\nNote: no instances of {', '.join(missing)} in this subset. "
              f"The model cannot learn a class it never sees — either add the "
              f"countries that annotate them, or drop them from CLASSES.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
