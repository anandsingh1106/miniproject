# Training the neural detector

The app ships with a classical CV detector so it works immediately. That engine
is a **baseline** — it will miss cracks in poor light and report shadows, tar
patches and wet marks as damage. This directory replaces it with a model trained
on real road imagery.

Nothing in the app needs reconfiguring. Drop a checkpoint at
`data/models/road_damage.pt` and the neural engine takes over on the next
request; the UI switches its badge from "CV baseline" to "Neural model".

---

## 1. Install the extras

```bash
pip install -r requirements-yolo.txt
```

This pulls in PyTorch (~2.5 GB). A CUDA GPU is strongly recommended — CPU
training works but takes many hours.

## 2. Get RDD2022

RDD2022 is the Road Damage Detection benchmark from the IEEE BigData Cup:
**47,420 images across six countries**, annotated in Pascal VOC format.

- Paper / dataset: <https://arxiv.org/abs/2209.08538>
- Download: <https://github.com/sekilab/RoadDamageDetector>

Extract so each country is a folder under one root:

```
data/rdd2022/
├── India/
│   └── train/
│       ├── images/                *.jpg
│       └── annotations/xmls/      *.xml
├── Japan/
├── Norway/
└── ...
```

The full set is ~12 GB. **India and Japan together are enough** for a solid
model and a much faster download.

## 3. Convert to YOLO format

```bash
python training/prepare_dataset.py --source data/rdd2022 --out data/yolo \
                                   --countries India,Japan
```

Writes images, labels, a train/val split and `data.yaml`. It prints the
instance count per class — read it. RDD2022 is heavily imbalanced, and a class
with a few dozen instances will not be learned no matter how long you train.

## 4. Train

```bash
python training/train_yolo.py --data data/yolo/data.yaml --epochs 100
```

| Flag | Default | Notes |
|---|---|---|
| `--model` | `yolov8s.pt` | `yolov8n.pt` is ~3× faster and noticeably weaker |
| `--epochs` | 100 | 40 is enough to see whether the pipeline works |
| `--imgsz` | 640 | Cracks are thin — going below 480 loses them |
| `--batch` | 16 | `-1` auto-sizes to available VRAM |
| `--device` | auto | `0` for GPU, `cpu` to force |

Vertical flip augmentation is disabled on purpose: longitudinal and transverse
cracks are distinguished by orientation, so flipping the image would corrupt
the label rather than augment it.

On completion the best checkpoint is copied to `data/models/road_damage.pt`
automatically.

## 5. Evaluate

```bash
python training/evaluate.py
```

Prints per-class precision, recall and mAP.

**Read the per-class rows, not the headline.** An overall mAP around 0.55 is
competitive on this benchmark, but that number routinely hides a class the
model never learned. If the weak class is D20 (alligator) or D40 (pothole),
the treatment recommendation downstream is what breaks — those two drive the
decision between sealing a road and rebuilding it. The script flags this case
explicitly.

---

## Class mapping

The index order is fixed and must match `backend/detection/yolo_detector.py`:

| idx | code | distress | in RDD2022? |
|-----|------|----------|-------------|
| 0 | D00 | Longitudinal crack | yes |
| 1 | D10 | Transverse crack | yes |
| 2 | D20 | Alligator crack | yes |
| 3 | D40 | Pothole | yes |
| 4 | D43 | Faded crosswalk | yes |
| 5 | D44 | Faded lane line | yes |
| 6 | RAV | Ravelling | no — needs your own labels |
| 7 | RUT | Rutting | no — needs your own labels |
| 8 | EDG | Edge break | no — needs your own labels |

The last three are not in RDD2022. They are included because they matter for
reconstruction decisions — rutting and edge break both indicate structural
rather than surface failure. To use them, label your own data (the YOLO `.txt`
format is one line per box: `class cx cy w h`, all normalised 0–1) and merge it
into `data/yolo/`. Until then the model simply never predicts those three, and
the scoring engine handles their absence without complaint.

## Using a different architecture

The app only requires that the engine return boxes with class indices matching
the table above. `backend/detection/yolo_detector.py` is ~100 lines; swapping in
Faster R-CNN, DETR or a custom model means implementing the same `detect()`
signature and registering it in `backend/detection/registry.py`.
