"""
D.A.R.S — Training Script
Automatically locates the dataset and trains YOLOv8n.

Run from the project root:
    python train.py
"""

import yaml
from pathlib import Path
from ultralytics import YOLO

# ── Locate the dataset folder ─────────────────────────────────────────────────
# Searches for the Roboflow dataset directory anywhere inside the project root.
ROOT = Path(__file__).parent.resolve()

DATASET_DIR = None
for candidate in ROOT.iterdir():
    if candidate.is_dir() and (candidate / "data.yaml").exists():
        if (candidate / "train" / "images").exists():
            DATASET_DIR = candidate
            break

if DATASET_DIR is None:
    print("\n[DARS] ERROR — Could not find the dataset folder.")
    print("  Make sure the Roboflow dataset is extracted inside the project root.")
    print("  Expected structure:")
    print("    D.A.R.S/")
    print("    └── <dataset-folder>/")
    print("        ├── train/images/")
    print("        ├── valid/images/")
    print("        └── data.yaml")
    raise SystemExit(1)

print(f"[DARS] Dataset found at: {DATASET_DIR}")

# ── Build a corrected data.yaml with absolute paths ───────────────────────────
# Ultralytics resolves relative paths from its internal 'datasets' dir,
# so we generate a temporary yaml with guaranteed absolute paths.
corrected_yaml = {
    "train": str(DATASET_DIR / "train" / "images"),
    "val":   str(DATASET_DIR / "valid" / "images"),
    "test":  str(DATASET_DIR / "test"  / "images"),
    "nc":    2,
    "names": ["awake", "drowsy"],
}

TEMP_YAML = ROOT / "_dars_data.yaml"
with open(TEMP_YAML, "w") as f:
    yaml.dump(corrected_yaml, f, default_flow_style=False)

print(f"[DARS] Corrected data config written to: {TEMP_YAML}")

# ── Train ─────────────────────────────────────────────────────────────────────
print("\n[DARS] Training started...")
model = YOLO("yolov8n.pt")
model.train(
    data=str(TEMP_YAML),
    epochs=50,
    imgsz=640,
    batch=16,
    name="dars_drowsiness",
)
print("\n[DARS] Training completed.")

# ── Cleanup temp yaml ─────────────────────────────────────────────────────────
TEMP_YAML.unlink(missing_ok=True)
