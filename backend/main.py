"""
D.A.R.S — Drowsiness Alert & Recognition System
FastAPI Backend  |  YOLOv8 Inference Engine
"""

import io
import os
import base64
import time
from pathlib import Path
from collections import deque

import cv2
import numpy as np
from PIL import Image
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from ultralytics import YOLO

# ──────────────────────────────────────────────
# App setup
# ──────────────────────────────────────────────
app = FastAPI(
    title="D.A.R.S API",
    description="Drowsiness Alert & Recognition System — YOLOv8 Inference",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────
# Model loading
# ──────────────────────────────────────────────
# Resolve model path relative to this file — works on any OS
MODEL_PATH = Path(__file__).parent / "model" / "best.pt"
CLASS_NAMES = ["awake", "drowsy"]

model = None


print(f"[DARS] Checking model at: {MODEL_PATH}")

if not MODEL_PATH.exists():
    raise RuntimeError(
        f"[DARS ERROR] Model not found at {MODEL_PATH}. "
        "Make sure best.pt exists inside backend/model/ and is committed to GitHub."
    )

try:
    model = YOLO(str(MODEL_PATH))
    model.to("cpu")  # force CPU for Railway stability
    print("[DARS] Model loaded successfully.")
except Exception as e:
    print("[DARS ERROR] Model loading failed:", e)
    raise e

@app.on_event("startup")
async def startup_event():
    print("[DARS] Backend starting...")


# ──────────────────────────────────────────────
# Rolling state tracker (per session in memory)
# ──────────────────────────────────────────────
WINDOW_SIZE = 10          # frames in rolling window
DROWSY_THRESHOLD = 0.6    # 60 % of last N frames must be "drowsy" to raise alert

frame_history: deque = deque(maxlen=WINDOW_SIZE)
session_stats = {
    "total_frames": 0,
    "drowsy_frames": 0,
    "awake_frames": 0,
    "start_time": time.time(),
}


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────
COLORS = {
    "awake":  (34, 197, 94),    # green
    "drowsy": (239, 68, 68),    # red
}


def annotate_frame(frame: np.ndarray, results) -> np.ndarray:
    """Draw bounding boxes and labels on the frame."""
    annotated = frame.copy()
    for box in results[0].boxes:
        cls_id = int(box.cls[0])
        conf   = float(box.conf[0])
        label  = CLASS_NAMES[cls_id] if cls_id < len(CLASS_NAMES) else str(cls_id)
        color  = COLORS.get(label, (255, 255, 255))

        x1, y1, x2, y2 = map(int, box.xyxy[0])
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)

        tag = f"{label.upper()}  {conf:.0%}"
        (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        cv2.rectangle(annotated, (x1, y1 - th - 10), (x1 + tw + 8, y1), color, -1)
        cv2.putText(annotated, tag, (x1 + 4, y1 - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    return annotated


def frame_to_b64(frame: np.ndarray) -> str:
    """Convert an OpenCV BGR frame to a base64-encoded JPEG string."""
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return base64.b64encode(buf).decode("utf-8")


def compute_alert(dominant: str) -> dict:
    """Use rolling window to decide whether to raise a DANGER alert."""
    frame_history.append(dominant)
    drowsy_ratio = frame_history.count("drowsy") / max(len(frame_history), 1)
    alert = drowsy_ratio >= DROWSY_THRESHOLD
    return {
        "alert": alert,
        "drowsy_ratio": round(drowsy_ratio, 3),
        "window_size": len(frame_history),
    }


# ──────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────
@app.get("/", tags=["Health"])
async def root():
    return {"status": "online", "system": "D.A.R.S", "version": "1.0.0"}


@app.get("/health", tags=["Health"])
def health():
    return {"status": "ok"}


@app.post("/predict", tags=["Inference"])
async def predict(
    file: UploadFile = File(...),
    annotate: bool = Query(default=False, description="Set true to return base64 annotated frame (slower)"),
):
    """
    Accept a single image frame (JPEG/PNG) from the frontend webcam capture,
    run YOLOv8 inference, and return lightweight JSON detection data.
    Pass ?annotate=true to also receive a base64-encoded annotated frame.
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet.")

    try:
        contents = await file.read()
        pil_img  = Image.open(io.BytesIO(contents)).convert("RGB")
        frame    = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    # ── Inference ──
    results = model(frame, conf=0.35, verbose=False)

    # ── Parse detections ──
    detections = []
    class_votes = {"awake": 0, "drowsy": 0}

    for box in results[0].boxes:
        cls_id = int(box.cls[0])
        conf   = float(box.conf[0])
        label  = CLASS_NAMES[cls_id] if cls_id < len(CLASS_NAMES) else "unknown"
        x1, y1, x2, y2 = [round(v, 1) for v in box.xyxy[0].tolist()]

        detections.append({
            "label":      label,
            "confidence": round(conf, 4),
            "bbox":       {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
        })
        if label in class_votes:
            class_votes[label] += 1

    # ── Dominant class ──
    if class_votes["drowsy"] > 0:
        dominant = "drowsy"
    elif class_votes["awake"] > 0:
        dominant = "awake"
    else:
        dominant = "none"

    # ── Rolling alert ──
    alert_info = compute_alert(dominant)

    # ── Update session stats ──
    session_stats["total_frames"] += 1
    if dominant == "drowsy":
        session_stats["drowsy_frames"] += 1
    elif dominant == "awake":
        session_stats["awake_frames"] += 1

    # ── Annotate & encode (only when requested) ──
    b64_frame = ""
    if annotate:
        annotated = annotate_frame(frame, results)
        b64_frame = frame_to_b64(annotated)

    return JSONResponse({
        "annotated_frame": b64_frame,
        "detections":      detections,
        "dominant":        dominant,
        "alert":           alert_info["alert"],
        "drowsy_ratio":    alert_info["drowsy_ratio"],
        "class_votes":     class_votes,
    })


@app.get("/stats", tags=["Session"])
async def stats():
    """Return session-level statistics."""
    elapsed = time.time() - session_stats["start_time"]
    total   = max(session_stats["total_frames"], 1)
    return {
        "elapsed_seconds":  round(elapsed, 1),
        "total_frames":     session_stats["total_frames"],
        "awake_frames":     session_stats["awake_frames"],
        "drowsy_frames":    session_stats["drowsy_frames"],
        "awake_percent":    round(session_stats["awake_frames"] / total * 100, 1),
        "drowsy_percent":   round(session_stats["drowsy_frames"] / total * 100, 1),
    }


@app.post("/reset", tags=["Session"])
async def reset_session():
    """Clear rolling window and reset session statistics."""
    frame_history.clear()
    session_stats.update({
        "total_frames":  0,
        "drowsy_frames": 0,
        "awake_frames":  0,
        "start_time":    time.time(),
    })
    return {"status": "reset", "message": "Session cleared."}
