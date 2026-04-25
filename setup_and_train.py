"""
D.A.R.S — Automated Setup & Training Script
Run this once from the project root to train the model and deploy it.

Usage:
    python setup_and_train.py
"""

import subprocess
import sys
import shutil
import yaml
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT_DIR      = Path(__file__).parent.resolve()
TRAINED_MODEL = ROOT_DIR / "runs" / "detect" / "dars_drowsiness" / "weights" / "best.pt"
DEST_MODEL    = ROOT_DIR / "backend" / "model" / "best.pt"
REQUIREMENTS  = ROOT_DIR / "backend" / "requirements.txt"
TEMP_YAML     = ROOT_DIR / "_dars_data.yaml"


# ── Step 1: Install dependencies ──────────────────────────────────────────────
def install_dependencies():
    print("\n[DARS] Installing required dependencies...")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    print("[DARS] Dependencies installed successfully.")


# ── Step 2: Locate dataset folder ─────────────────────────────────────────────
def find_dataset() -> Path:
    """
    Searches every subfolder of the project root for one that contains
    train/images/ — works regardless of what the folder is named.
    """
    for candidate in ROOT_DIR.iterdir():
        if candidate.is_dir() and (candidate / "train" / "images").exists():
            print(f"[DARS] Dataset found at: {candidate}")
            return candidate

    print("\n[DARS] ERROR — Could not find the dataset folder.")
    print("  Make sure the Roboflow dataset is extracted inside the project root.")
    print("  Expected structure:")
    print("    D.A.R.S/")
    print("    └── <dataset-folder>/")
    print("        ├── train/images/")
    print("        ├── valid/images/")
    print("        └── data.yaml")
    sys.exit(1)


# ── Step 3: Write corrected data.yaml with absolute paths ─────────────────────
def write_corrected_yaml(dataset_dir: Path) -> Path:
    """
    Ultralytics resolves relative paths in data.yaml from its own internal
    'datasets' directory, not from the project root. Writing absolute paths
    prevents this mismatch on all platforms.
    """
    corrected = {
        "train": str(dataset_dir / "train" / "images"),
        "val":   str(dataset_dir / "valid" / "images"),
        "test":  str(dataset_dir / "test"  / "images"),
        "nc":    2,
        "names": ["awake", "drowsy"],
    }
    with open(TEMP_YAML, "w") as f:
        yaml.dump(corrected, f, default_flow_style=False)
    print(f"[DARS] Corrected data config written to: {TEMP_YAML}")
    return TEMP_YAML


# ── Step 4: Train the model ───────────────────────────────────────────────────
def train_model(yaml_path: Path):
    from ultralytics import YOLO

    print("\n[DARS] Training started...")
    print("       Model  : yolov8n.pt")
    print("       Epochs : 50  |  Image size: 640  |  Batch: 16")
    print(f"       Data   : {yaml_path}\n")

    model = YOLO("yolov8n.pt")
    model.train(
        data=str(yaml_path),
        epochs=50,
        imgsz=640,
        batch=16,
        name="dars_drowsiness",
    )
    print("\n[DARS] Training completed.")


# ── Step 5: Copy best.pt to backend/model/ ────────────────────────────────────
def deploy_model():
    if not TRAINED_MODEL.exists():
        print(f"\n[DARS] ERROR — Trained model not found at: {TRAINED_MODEL}")
        print("  Training may have failed or used a different output directory.")
        print("  Check runs/detect/ and copy best.pt to backend/model/ manually.")
        sys.exit(1)

    DEST_MODEL.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src=TRAINED_MODEL, dst=DEST_MODEL)
    print(f"[DARS] Model copied to: {DEST_MODEL}")


# ── Step 6: Cleanup temp yaml ─────────────────────────────────────────────────
def cleanup():
    TEMP_YAML.unlink(missing_ok=True)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 55)
    print("  D.A.R.S — Automated Setup & Training")
    print("  Drowsiness Alert & Recognition System")
    print("=" * 55)

    install_dependencies()
    dataset_dir = find_dataset()
    yaml_path   = write_corrected_yaml(dataset_dir)

    try:
        train_model(yaml_path)
        deploy_model()
    finally:
        cleanup()

    print("\n" + "=" * 55)
    print("  Setup complete! Next steps:")
    print()
    print("  1. Start the backend:")
    print("     cd backend")
    print("     uvicorn main:app --reload --port 8000")
    print()
    print("  2. Open frontend/index.html in your browser")
    print("=" * 55 + "\n")
