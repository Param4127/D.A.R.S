# D.A.R.S — Drowsiness Alert & Recognition System

> **Real-time driver drowsiness detection powered by YOLOv8 + FastAPI + Vanilla JS**

---

## 📁 Project Structure

```
D.A.R.S/
├── setup_and_train.py     ← Run this once to train & deploy the model
├── train.py               ← Standalone training script (optional)
├── data.yaml              ← Place your dataset config here
│
├── backend/
│   ├── main.py            ← FastAPI server (YOLOv8 inference)
│   ├── model/
│   │   └── best.pt        ← Auto-placed by setup_and_train.py
│   └── requirements.txt
│
├── frontend/
│   ├── index.html         ← Premium dark-mode UI
│   ├── style.css
│   └── script.js
│
└── README.md
```

---

## 🚀 Quick Start

### Step 1 — Prepare dataset config

Copy `data.yaml` from your dataset folder into the **project root** (same folder as `setup_and_train.py`):

```
D.A.R.S/
├── data.yaml    ← must be here
├── setup_and_train.py
...
```

### Step 2 — Run the automated setup

```bash
python setup_and_train.py
```

This single command will:
- ✅ Install all required dependencies
- ✅ Train the YOLOv8 nano model for 50 epochs
- ✅ Automatically copy `best.pt` → `backend/model/best.pt`

### Step 3 — Start the backend server

```bash
cd backend
uvicorn main:app --reload --port 8000
```

### Step 4 — Open the frontend

Open `frontend/index.html` in your browser, **or** serve locally:

```bash
cd frontend
python -m http.server 5500
# Visit: http://localhost:5500
```

---

## ⚙️ How It Works

| Step | Description |
|------|-------------|
| 1 | Browser accesses your **webcam** at up to 6 FPS |
| 2 | Each frame is **JPEG-compressed** and POSTed to `/predict` |
| 3 | FastAPI runs **YOLOv8** inference on the frame |
| 4 | Backend returns annotated frame + dominant class |
| 5 | A **rolling 10-frame window** triggers alert when ≥60% frames are `drowsy` |
| 6 | Frontend shows annotated video, updates stats, and plays a **beep alert** |

---

## 🎯 Model Classes

| Class ID | Name     | Color    |
|----------|----------|----------|
| 0        | `awake`  | 🟢 Green |
| 1        | `drowsy` | 🔴 Red   |

---

## 🔌 API Endpoints

| Method | Endpoint   | Description            |
|--------|------------|------------------------|
| `GET`  | `/`        | Health check           |
| `GET`  | `/health`  | Model load status      |
| `POST` | `/predict` | Run inference on frame |
| `GET`  | `/stats`   | Session statistics     |
| `POST` | `/reset`   | Reset session          |

---

## 🛡️ Alert Logic

Uses a **rolling 10-frame window** to prevent false alarms:

- `drowsy_ratio` = fraction of last 10 frames classified as drowsy
- If `drowsy_ratio ≥ 0.60` → **DANGER** alert fires (banner + audio beep)

---

## 📦 Requirements

- Python ≥ 3.9
- Webcam-equipped device
- Modern browser (Chrome, Edge, Firefox)
- Works on **Windows, macOS, and Linux**

---

## 📄 License

Dataset: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — Roboflow / Augmented Startups
