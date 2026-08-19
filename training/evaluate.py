#!/usr/bin/env python
"""Evaluate the installed detector on the validation split.

    python training/evaluate.py
    python training/evaluate.py --weights runs/detect/road_damage/weights/best.pt

Prints per-class precision, recall and mAP. Read the per-class rows rather than
the headline number: an overall mAP that looks respectable routinely hides a
class the model never learned, and if that class is D20 or D40 the
reconstruction recommendation downstream is the thing that breaks.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.config import DAMAGE_TYPES, YOLO_WEIGHTS  # noqa: E402


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


def main() -> int:
    _utf8_console()
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", type=Path, default=YOLO_WEIGHTS)
    ap.add_argument("--data", type=Path, default=Path("data/yolo/data.yaml"))
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--split", default="val", choices=["val", "test", "train"])
    args = ap.parse_args()

    try:
        from ultralytics import YOLO
    except ImportError:
        print("Needs the optional extras:  pip install -r requirements-yolo.txt",
              file=sys.stderr)
        return 1

    if not args.weights.is_file():
        print(f"No checkpoint at {args.weights}. Train one first.", file=sys.stderr)
        return 1
    if not args.data.is_file():
        print(f"No dataset config at {args.data}.", file=sys.stderr)
        return 1

    model = YOLO(str(args.weights))
    m = model.val(data=str(args.data.resolve()), imgsz=args.imgsz,
                  split=args.split, plots=True)

    print(f"\n{'class':<8}{'distress':<26}{'P':>8}{'R':>8}{'mAP50':>9}{'mAP50-95':>10}")
    print("-" * 69)

    names = model.names if isinstance(model.names, dict) else {}
    try:
        for i, ci in enumerate(m.box.ap_class_index):
            code = names.get(int(ci), str(ci))
            label = DAMAGE_TYPES.get(code, {}).get("name", "—")
            print(f"{code:<8}{label:<26}{m.box.p[i]:>8.3f}{m.box.r[i]:>8.3f}"
                  f"{m.box.ap50[i]:>9.3f}{m.box.ap[i]:>10.3f}")
    except (AttributeError, IndexError) as exc:
        print(f"(per-class breakdown unavailable: {exc})")

    print("-" * 69)
    print(f"{'all':<34}{m.box.mp:>8.3f}{m.box.mr:>8.3f}{m.box.map50:>9.3f}{m.box.map:>10.3f}")

    # The classes that drive the reconstruction decision, called out explicitly.
    try:
        weak = [names.get(int(ci), str(ci)) for i, ci in enumerate(m.box.ap_class_index)
                if m.box.ap50[i] < 0.30]
        critical = [c for c in weak if c in ("D20", "D40", "RUT")]
        if critical:
            print(f"\nWarning: {', '.join(critical)} scored below 0.30 mAP50. These drive "
                  f"the structural\nassessment, so the treatment recommendation will be "
                  f"unreliable until they improve.")
    except (AttributeError, IndexError):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
