#!/usr/bin/env python
"""Train the road-damage detector, then install it for the web app.

    python training/train_yolo.py --data data/yolo/data.yaml --epochs 100

On finishing it copies the best checkpoint to `data/models/road_damage.pt`,
which is the path the running server checks. The neural engine takes over on
the next request — no restart, no config change.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.config import MODEL_DIR, YOLO_WEIGHTS  # noqa: E402


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
    ap.add_argument("--data", type=Path, default=Path("data/yolo/data.yaml"))
    ap.add_argument("--model", default="yolov8s.pt",
                    help="starting checkpoint: yolov8n/s/m/l.pt (default: s)")
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16,
                    help="-1 lets ultralytics auto-size to available VRAM")
    ap.add_argument("--device", default=None, help="'0' for GPU 0, 'cpu' to force CPU")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--patience", type=int, default=25,
                    help="early-stopping patience in epochs")
    ap.add_argument("--name", default="road_damage")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--no-install", action="store_true",
                    help="do not copy the result to data/models/")
    args = ap.parse_args()

    try:
        import torch
        from ultralytics import YOLO
    except ImportError:
        print("Training needs the optional extras:\n"
              "    pip install -r requirements-yolo.txt", file=sys.stderr)
        return 1

    if not args.data.is_file():
        print(f"Dataset config not found: {args.data}\n"
              f"Run training/prepare_dataset.py first.", file=sys.stderr)
        return 1

    device = args.device
    if device is None:
        device = "0" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        print("\n  No GPU detected — training on CPU. Expect this to take many hours.\n"
              "  Consider --model yolov8n.pt --epochs 40 --imgsz 480 for a usable\n"
              "  baseline in a fraction of the time.\n")

    model = YOLO(args.model)
    results = model.train(
        data=str(args.data.resolve()),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        workers=args.workers,
        patience=args.patience,
        name=args.name,
        resume=args.resume,
        project="runs/detect",
        # Road imagery is captured from a moving vehicle in variable weather, so
        # photometric jitter and scale variation are the augmentations that pay.
        # Vertical flipping is off deliberately: an upside-down road is not a
        # thing the model will ever see, and longitudinal vs transverse cracks
        # are distinguished by orientation, so flipping would corrupt the label.
        hsv_h=0.015, hsv_s=0.7, hsv_v=0.4,
        degrees=0.0, translate=0.1, scale=0.5, shear=0.0,
        flipud=0.0, fliplr=0.5,
        mosaic=1.0, mixup=0.0,
        plots=True,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    if not best.is_file():
        print(f"Training finished but no checkpoint at {best}", file=sys.stderr)
        return 1

    print(f"\nBest checkpoint: {best}")
    try:
        metrics = results.results_dict
        print(f"  mAP50    {metrics.get('metrics/mAP50(B)', float('nan')):.3f}")
        print(f"  mAP50-95 {metrics.get('metrics/mAP50-95(B)', float('nan')):.3f}")
    except (AttributeError, TypeError):
        pass

    if not args.no_install:
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(best, YOLO_WEIGHTS)
        print(f"\nInstalled to {YOLO_WEIGHTS}")
        print("The running server picks this up on the next request — no restart needed.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
