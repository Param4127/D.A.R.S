'use strict';

// ── Config ───────────────────────────────────────────
const API_BASE        = 'https://dars-backend-production.up.railway.app';
const FRAME_INTERVAL  = 200;   // faster: ~5 frames/sec
const CAPTURE_W       = 416;
const CAPTURE_H       = 234;
const CAPTURE_QUALITY = 0.5;
const LOG_MAX         = 60;
const WARN_AFTER      = 1200;  // warn after 1.2s of drowsiness
const ALERT_AFTER     = 2500;  // alert after 2.5s
const CRITICAL_AFTER  = 4000;  // critical after 4s
const ALERT_COOLDOWN  = 3500;
const GRACE_FRAMES    = 6;     // slightly faster recovery
const FRONT_WINDOW    = 10;    // smaller window = faster risk updates

// ── Detection quality filters ──
// Balanced: low enough to detect normal faces, high enough to ignore
// tiny far-away / very uncertain detections.
const MIN_CONFIDENCE  = 0.42;  // accept detections above 42% confidence
const MIN_FACE_AREA   = 0.022; // face must cover 2.2% of frame (close enough)

// ── DOM ──────────────────────────────────────────────
const video           = document.getElementById('webcamVideo');
const overlayCanvas   = document.getElementById('overlayCanvas');
const alertBanner     = document.getElementById('alertBanner');
const alertTitle      = document.getElementById('alertTitle');
const alertMsg        = document.getElementById('alertMsg');
const alertIcon       = document.getElementById('alertIcon');
const statePill       = document.getElementById('statePill');
const liveBadge       = document.getElementById('liveBadge');
const statusDot       = document.getElementById('statusDot');
const statusLabel     = document.getElementById('statusLabel');
const ringFill        = document.getElementById('ringFill');
const riskPercent     = document.getElementById('riskPercent');
const riskSub         = document.getElementById('riskSub');
const tileFrames      = document.getElementById('tileFrames');
const tileAwake       = document.getElementById('tileAwake');
const tileDrowsy      = document.getElementById('tileDrowsy');
const tileElapsed     = document.getElementById('tileElapsed');
const fpsFill         = document.getElementById('fpsFill');
const fpsVal          = document.getElementById('fpsVal');
const logList         = document.getElementById('logList');
const btnStart        = document.getElementById('btnStart');
const btnStop         = document.getElementById('btnStop');
const btnReset        = document.getElementById('btnReset');
const btnClearLog     = document.getElementById('btnClearLog');
const btnSound        = document.getElementById('btnSound');
const soundIcon       = document.getElementById('soundIcon');
const cameraContainer = document.getElementById('cameraContainer');
const cameraLoader    = document.getElementById('cameraLoader');
const panelCamera     = document.getElementById('panelCamera');
const header          = document.querySelector('.header');
const statusMsgBar    = document.getElementById('statusMsgBar');
const statusMsgIcon   = document.getElementById('statusMsgIcon');
const statusMsgText   = document.getElementById('statusMsgText');
const lvlSafe         = document.getElementById('lvlSafe');
const lvlWarning      = document.getElementById('lvlWarning');
const lvlCritical     = document.getElementById('lvlCritical');

// ── Runtime state ────────────────────────────────────
let isRunning       = false;
let isFetching      = false;
let stream          = null;
let loopTimeout     = null;
let statsTimer      = null;
let captureCanvas   = document.createElement('canvas');
let captureCtx      = captureCanvas.getContext('2d');
let fpsHistory      = [];
let lastDetections  = [];

// Detection state
let soundEnabled    = true;
let drowsyStartTime = null;
let currentLevel    = 'none';
let graceCount      = 0;

// Per-tier sound cooldown timers (independent so high alert never blocked by low)
const SOUND_COOLDOWNS = { low: 8000, mid: 5000, high: 3000 };
const lastSoundTime   = { low: 0,    mid: 0,    high: 0    };
let lastAlertTime     = 0;  // kept for checkDrowsiness compatibility

// ─────────────────────────────────────────────────────
//  FIX 1: Frontend rolling window — tracks actual frames
//  correctly so the percentage is always 0–100 and
//  updates in real time instead of staying stuck.
// ─────────────────────────────────────────────────────
let frontHistory = [];

function computeFrontRatio(dominant) {
  // Push latest result into fixed-size window
  frontHistory.push(dominant === 'drowsy' ? 1 : 0);
  if (frontHistory.length > FRONT_WINDOW) frontHistory.shift();

  // Use actual window length (< FRONT_WINDOW during warm-up)
  const len = frontHistory.length;
  if (len === 0) return 0;
  const drowsyCount = frontHistory.reduce((a, b) => a + b, 0);
  return drowsyCount / len;   // 0.0 → 1.0
}

// ─────────────────────────────────────────────────────
//  AUDIO SYSTEM
//  Creates a FRESH AudioContext for every beep.
//  This is the most reliable method — no suspend/resume
//  issues, no stale context, works every time after
//  the user has clicked anything on the page.
// ─────────────────────────────────────────────────────

// Tracks whether user has interacted (required for AudioContext creation)
let userHasInteracted = false;
document.addEventListener('click', () => { userHasInteracted = true; }, { once: true });

// initAudio — call on Start button click to mark interaction
function initAudio() { userHasInteracted = true; }

// playBeeps — creates a fresh AudioContext each call (100% reliable)
function playBeeps(freq, count, intervalSec, gain, durSec) {
  if (!soundEnabled || !userHasInteracted) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    for (let i = 0; i < count; i++) {
      const t = now + i * intervalSec;
      // main tone
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + durSec);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + durSec + 0.05);
      // sub-tone (half freq, softer)
      const osc2 = ctx.createOscillator();
      const g2   = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(freq / 2, t);
      g2.gain.setValueAtTime(0.001, t);
      g2.gain.linearRampToValueAtTime(gain * 0.3, t + 0.01);
      g2.gain.exponentialRampToValueAtTime(0.001, t + durSec);
      osc2.connect(g2); g2.connect(ctx.destination);
      osc2.start(t); osc2.stop(t + durSec + 0.05);
    }
    // auto-close context after all beeps finish
    setTimeout(() => ctx.close(), (count * intervalSec + durSec + 0.2) * 1000);
  } catch (e) { console.warn('[DARS] Audio error:', e); }
}

// playAlert — maps tier name to beep parameters
function playAlert(tier = 'mid') {
  if (!soundEnabled) return;
  //       freq  count interval  gain   dur
  const T = {
    low:      [520,  1, 0.40, 0.15, 0.25],
    mid:      [820,  3, 0.28, 0.30, 0.22],
    high:     [1100, 5, 0.18, 0.55, 0.18],
    warning:  [660,  2, 0.30, 0.25, 0.20],
    alert:    [820,  3, 0.28, 0.35, 0.22],
    critical: [1100, 5, 0.18, 0.55, 0.16],
  };
  const p = T[tier] || T.mid;
  playBeeps(...p);
}


function speakAlert(msg) {
  if (!soundEnabled) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(msg);
    u.volume = 1; u.rate = 1.05; u.pitch = 1;
    setTimeout(() => window.speechSynthesis.speak(u), 300);
  } catch (_) {}
}

function stopAllAlerts() {
  try { window.speechSynthesis.cancel(); } catch (_) {}
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  btnSound.classList.toggle('muted', !soundEnabled);
  // Update text node inside button
  const t = [...btnSound.childNodes].find(n => n.nodeType === 3);
  if (t) t.textContent = soundEnabled ? ' Sound ON' : ' Sound OFF';
  soundIcon.innerHTML = soundEnabled
    ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'
    : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';
}

// ── Particles ────────────────────────────────────────
(function () {
  const c = document.getElementById('bgParticles');
  for (let i = 0; i < 22; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const s = Math.random() * 5 + 2;
    p.style.cssText = `width:${s}px;height:${s}px;left:${Math.random()*100}%;bottom:${Math.random()*-20}%;--dur:${Math.random()*14+9}s;--delay:${Math.random()*12}s;`;
    c.appendChild(p);
  }
})();

// ── Backend health ───────────────────────────────────
async function checkBackend() {
  try {
    const r = await fetch(`${API_BASE}/health`, { 
      signal: AbortSignal.timeout(3000),
      headers: { "Bypass-Tunnel-Reminder": "true" }
    });
    if (r.ok) { setStatus('online', 'ONLINE'); return true; }
  } catch (_) {}
  setStatus('offline', 'OFFLINE');
  return false;
}
function setStatus(s, l) {
  statusDot.className = `status-dot ${s}`;
  statusLabel.textContent = l;
}
checkBackend();
setInterval(checkBackend, 5000);

// ── Start monitoring ──────────────────────────────────
async function startMonitoring() {
  const ok = await checkBackend();
  if (!ok) {
    alert('⚠️  Backend not reachable.\n\nRun:\n  cd backend\n  uvicorn main:app --reload --port 8000');
    return;
  }

  // Must call initAudio() inside user-gesture handler
  initAudio();

  cameraLoader.classList.add('visible');
  btnStart.disabled = true;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
  } catch (_) {
    cameraLoader.classList.remove('visible');
    btnStart.disabled = false;
    alert('Camera access denied.');
    return;
  }

  video.srcObject = stream;
  await new Promise(r => { video.onloadedmetadata = r; });
  video.play();

  captureCanvas.width  = CAPTURE_W;
  captureCanvas.height = CAPTURE_H;

  video.style.display = 'block';
  cameraLoader.classList.remove('visible');

  isRunning = true;
  btnStop.disabled = false;
  setBadge('live', 'LIVE');
  setStatusMsg('safe', '🟢', 'MONITORING ACTIVE — Stay alert.');
  scheduleNextFrame();
  statsTimer = setInterval(pollStats, 2000);
  addLog('system', 'Monitoring started');
}

// ── Stop monitoring ───────────────────────────────────
function stopMonitoring() {
  isRunning = false; isFetching = false;
  drowsyStartTime = null; graceCount = 0;
  frontHistory = [];
  clearTimeout(loopTimeout);
  clearInterval(statsTimer);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  stopAllAlerts();
  resetUIState();
  clearOverlay();
  btnStart.disabled = false; btnStop.disabled = true;
  setBadge('', 'STANDBY');
  video.style.display = 'none';
  statePill.textContent = '––'; statePill.className = 'state-pill';
  setStatusMsg('', '⚫', 'MONITORING STOPPED.');
  addLog('system', 'Monitoring stopped');
}

// ── Recursive frame loop (no overlap) ────────────────
function scheduleNextFrame() {
  if (!isRunning) return;
  loopTimeout = setTimeout(async () => { await sendFrame(); scheduleNextFrame(); }, FRAME_INTERVAL);
}

async function sendFrame() {
  if (!isRunning || video.readyState < 2) return;
  const t0 = performance.now();
  try {
    captureCtx.drawImage(video, 0, 0, CAPTURE_W, CAPTURE_H);
    const blob = await new Promise(r => captureCanvas.toBlob(r, 'image/jpeg', CAPTURE_QUALITY));
    if (!blob) return;
    const form = new FormData();
    form.append('file', blob, 'frame.jpg');
    const res = await fetch(`${API_BASE}/predict?annotate=false`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(5000),
      headers: { "Bypass-Tunnel-Reminder": "true" }
    });
    if (res.ok) {
      const data = await res.json();
      handlePrediction(data);
      const fps = Math.round(1000 / (performance.now() - t0));
      fpsHistory.push(fps);
      if (fpsHistory.length > 10) fpsHistory.shift();
      updateFPS(Math.round(fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length));
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────────────
//  GRADUATED SOUND SYSTEM
//  Each tier has its own independent cooldown so a high
//  alert is NEVER blocked by a recent low alert.
//
//  30–49% → LOW  : 1 soft beep  (once every 8 s)
//  50–79% → MID  : 3 beeps      (once every 5 s)
//  80–100% → HIGH : 5 loud beeps + voice (once every 3 s)
// ─────────────────────────────────────────────────────
function triggerGraduatedSound(ratio) {
  if (!soundEnabled) return;
  const now = Date.now();
  const pct  = Math.round(ratio * 100);

  // ── TIER 3 — HIGH (70%+): 5 urgent beeps + voice every 3s ──
  if (pct >= 70) {
    if (now - lastSoundTime.high > SOUND_COOLDOWNS.high) {
      playAlert('high');
      speakAlert('Danger! High drowsiness detected. Stop the vehicle now!');
      lastSoundTime.high = now;
      lastAlertTime = now;
    }

  // ── TIER 2 — MID (50–69%): 3 beeps + voice every 5s ──
  } else if (pct >= 50) {
    if (now - lastSoundTime.mid > SOUND_COOLDOWNS.mid) {
      playAlert('mid');
      speakAlert('Warning! You are getting drowsy. Please stay alert.');
      lastSoundTime.mid = now;
      lastAlertTime = now;
    }

  // ── TIER 1 — LOW (40–49%): 1 soft beep every 8s, no voice ──
  } else if (pct >= 40) {
    if (now - lastSoundTime.low > SOUND_COOLDOWNS.low) {
      playAlert('low');
      lastSoundTime.low = now;
    }
  }
}

// ── Handle prediction ────────────────────────────────
// ──────────────────────────────────────────────────────
//  getValidDominant — filters out far/small/uncertain
//  detections before feeding the rolling window.
//  Returns 'drowsy' | 'awake' | 'none'
// ──────────────────────────────────────────────────────
// Face memory: if no valid face found, reuse last known state
// for up to FACE_MEMORY_FRAMES frames before resetting to 'none'
const FACE_MEMORY_FRAMES = 4;
let lastValidDominant = 'none';
let noFaceCount = 0;

function getValidDominant(detections) {
  const valid = detections.filter(det => {
    if (det.confidence < MIN_CONFIDENCE) return false;
    const bw   = (det.bbox.x2 - det.bbox.x1) / CAPTURE_W;
    const bh   = (det.bbox.y2 - det.bbox.y1) / CAPTURE_H;
    return (bw * bh) >= MIN_FACE_AREA;
  });

  if (valid.length > 0) {
    // Good detection — update memory and reset miss counter
    const drowsyCount = valid.filter(d => d.label === 'drowsy').length;
    lastValidDominant = drowsyCount > valid.length / 2 ? 'drowsy' : 'awake';
    noFaceCount = 0;
    return lastValidDominant;
  }

  // No valid detection this frame — use face memory for a few frames
  noFaceCount++;
  if (noFaceCount <= FACE_MEMORY_FRAMES && lastValidDominant !== 'none') {
    return lastValidDominant;  // hold last known state
  }

  // Too many consecutive misses — genuinely no face
  lastValidDominant = 'none';
  return 'none';
}

function handlePrediction(data) {
  const rawDetections = data.detections || [];

  // Use filtered dominant (ignores far/small/low-confidence faces)
  const dominant    = getValidDominant(rawDetections);
  const drowsyRatio = computeFrontRatio(dominant);

  // Draw all detected boxes (visual feedback even for filtered ones)
  drawDetections(rawDetections);

  // State pill: show raw dominant for display, but logic uses filtered
  // State pill: show raw dominant for display
  const rawDominant = data.dominant || 'none';
  statePill.textContent = rawDominant === 'none' ? 'NO FACE' : rawDominant.toUpperCase();
  statePill.className   = `state-pill ${dominant}`;

  updateRiskRing(drowsyRatio);
  checkDrowsiness(drowsyRatio);   // pass ratio, not per-frame boolean
  triggerGraduatedSound(drowsyRatio);

  if (dominant !== 'none') {
    addLog(dominant, `${dominant.toUpperCase()} — risk: ${Math.round(drowsyRatio * 100)}%`);
  }
}

// ── Canvas bbox drawing ──────────────────────────────
const BBOX_COLORS = { awake: '#00ff88', drowsy: '#ff2244' };

function drawDetections(detections) {
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  const sx = overlayCanvas.width  / CAPTURE_W;
  const sy = overlayCanvas.height / CAPTURE_H;
  detections.forEach(det => {
    const { x1, y1, x2, y2 } = det.bbox;
    const color = BBOX_COLORS[det.label] || '#fff';
    const dx = x1*sx, dy = y1*sy, dw = (x2-x1)*sx, dh = (y2-y1)*sy;
    ctx.shadowColor = color; ctx.shadowBlur = 14;
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.strokeRect(dx, dy, dw, dh);
    ctx.shadowBlur = 0;
    const tag = `${det.label.toUpperCase()} ${(det.confidence*100).toFixed(0)}%`;
    ctx.font = 'bold 12px "Share Tech Mono", monospace';
    const tw = ctx.measureText(tag).width;
    ctx.fillStyle = color + 'cc'; ctx.fillRect(dx, dy - 22, tw + 10, 22);
    ctx.fillStyle = '#fff'; ctx.fillText(tag, dx + 5, dy - 7);
  });
}

function clearOverlay() {
  const c = overlayCanvas.getContext('2d');
  c.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// ─────────────────────────────────────────────────────
//  TIME-BASED DROWSINESS ENGINE (ratio-driven)
//
//  isDrowsy = ratio > 0.40 (40%+ of recent frames drowsy)
//  isClear  = ratio < 0.20 (clearly awake → instant reset)
//
//  Prevents CRITICAL banner getting STUCK when occasional
//  single drowsy frames keep resetting graceCount.
// ─────────────────────────────────────────────────────
function checkDrowsiness(drowsyRatio) {
  const now      = Date.now();
  const isDrowsy = drowsyRatio > 0.40;
  const isClear  = drowsyRatio < 0.20;

  // Instant clear: ratio well below danger zone → reset immediately
  if (isClear && !['none', 'safe'].includes(currentLevel)) {
    drowsyStartTime = null; graceCount = 0;
    addLog('awake', '✔ Cleared — driver is awake');
    currentLevel = 'safe';
    resetUIState(); showSafeUI();
    stopAllAlerts();
    return;
  }

  if (isDrowsy) {
    graceCount = 0;
    if (!drowsyStartTime) drowsyStartTime = now;
    const dur = now - drowsyStartTime;

    if (dur > CRITICAL_AFTER) {
      if (currentLevel !== 'critical') {
        currentLevel = 'critical';
        activateCriticalUI();
        addLog('critical', '🚨 CRITICAL — 5s+ drowsiness!');
      }
      if (now - lastAlertTime > ALERT_COOLDOWN) {
        playAlert('critical');
        speakAlert('Wake up immediately! You are falling asleep!');
        lastAlertTime = now;
      }
    } else if (dur > ALERT_AFTER) {
      if (currentLevel !== 'alert') {
        currentLevel = 'alert';
        activateAlertUI();
        addLog('drowsy', '⚠ ALERT — 3s drowsiness');
      }
      if (now - lastAlertTime > ALERT_COOLDOWN) {
        playAlert('alert');
        speakAlert('Warning! You are getting drowsy. Please stay alert.');
        lastAlertTime = now;
      }
    } else if (dur > WARN_AFTER) {
      if (currentLevel !== 'warning') {
        currentLevel = 'warning';
        showWarningUI();
        addLog('warning', '⚡ WARNING — drowsiness starting');
      }
      if (now - lastAlertTime > ALERT_COOLDOWN * 1.5) {
        playAlert('warning');
        lastAlertTime = now;
      }
    }

  } else {
    // Ratio 20–40%: use grace period to avoid flicker
    graceCount++;
    if (graceCount >= GRACE_FRAMES && drowsyStartTime !== null) {
      drowsyStartTime = null; graceCount = 0;
      if (!['none', 'safe'].includes(currentLevel)) addLog('awake', '✔ Cleared — driver awake');
      currentLevel = 'safe';
      resetUIState(); showSafeUI();
    } else if (currentLevel === 'none') {
      currentLevel = 'safe'; showSafeUI();
    }
  }
}


// ── UI states ─────────────────────────────────────────
function showSafeUI() {
  document.body.className = '';
  header.className = 'header';
  panelCamera.className = 'panel panel-camera state-safe';
  cameraContainer.className = 'camera-container safe';
  alertBanner.className = 'alert-banner';
  setBadge('live', 'LIVE'); setLevelPills('safe');
  setStatusMsg('safe', '🟢', 'ALL CLEAR — Stay alert. Drive safe.');
  setStatus('online', 'ONLINE');
}
function showWarningUI() {
  document.body.className = 'state-warning';
  header.className = 'header warning';
  panelCamera.className = 'panel panel-camera state-warning';
  cameraContainer.className = 'camera-container warning';
  alertBanner.className = 'alert-banner visible level-warning';
  alertIcon.textContent = '⚡'; alertTitle.textContent = 'STAY ALERT'; alertMsg.textContent = 'Take a break soon.';
  setBadge('warning', 'WARNING'); setLevelPills('warning');
  setStatusMsg('warning', '🟡', 'TAKE A BREAK — You look drowsy.');
  setStatus('warning', '⚡ WARNING');
}
function activateAlertUI() {
  document.body.className = 'state-critical';
  header.className = 'header critical';
  panelCamera.className = 'panel panel-camera state-critical';
  cameraContainer.className = 'camera-container critical';
  alertBanner.className = 'alert-banner visible';
  alertIcon.textContent = '⚠'; alertTitle.textContent = 'DROWSINESS DETECTED'; alertMsg.textContent = 'Please pull over safely.';
  setBadge('danger', 'ALERT'); setLevelPills('alert');
  setStatusMsg('critical', '🔴', 'PULL OVER SAFELY NOW!');
  setStatus('alert', '⚠ ALERT!');
}
function activateCriticalUI() {
  document.body.className = 'state-critical';
  header.className = 'header critical';
  panelCamera.className = 'panel panel-camera state-critical';
  cameraContainer.className = 'camera-container critical';
  alertBanner.className = 'alert-banner visible level-critical';
  alertIcon.textContent = '🚨'; alertTitle.textContent = 'CRITICAL — WAKE UP!'; alertMsg.textContent = 'Stop the vehicle immediately!';
  setBadge('danger', 'CRITICAL'); setLevelPills('critical');
  setStatusMsg('critical', '🚨', 'WAKE UP! STOP THE VEHICLE!');
  setStatus('alert', '🚨 CRITICAL!');
}
function resetUIState() {
  document.body.className = '';
  header.className = 'header';
  panelCamera.className = 'panel panel-camera';
  cameraContainer.className = 'camera-container';
  alertBanner.className = 'alert-banner';
  setLevelPills('none'); stopAllAlerts();
}
function setBadge(cls, txt) {
  liveBadge.className = `panel-badge${cls ? ' ' + cls : ''}`;
  liveBadge.innerHTML = `<span class="badge-dot"></span>${txt}`;
}
function setLevelPills(l) {
  lvlSafe.classList.toggle('active',     l === 'safe');
  lvlWarning.classList.toggle('active',  l === 'warning' || l === 'alert');
  lvlCritical.classList.toggle('active', l === 'critical');
}
function setStatusMsg(cls, icon, txt) {
  statusMsgBar.className = `status-msg-bar${cls ? ' msg-' + cls : ''}`;
  statusMsgIcon.textContent = icon;
  statusMsgText.textContent = txt;
}

// ─────────────────────────────────────────────────────
//  FIX 4: Risk ring — correctly maps 0.0–1.0 ratio to
//  the SVG stroke-dashoffset.
//  circumference = 2 * π * r = 2 * π * 50 ≈ 314.16
// ─────────────────────────────────────────────────────
function updateRiskRing(ratio) {
  ratio = Math.max(0, Math.min(1, ratio));
  ringFill.style.strokeDashoffset = (314 - ratio * 314).toFixed(1);
  riskPercent.textContent = `${Math.round(ratio * 100)}%`;

  // Direct style assignment — guaranteed to work on SVG elements
  if (ratio < 0.35) {
    ringFill.style.stroke = '#00ff88';
    ringFill.style.filter = 'drop-shadow(0 0 8px rgba(0,255,136,0.6))';
    riskSub.style.color   = '#00ff88';
    riskSub.textContent   = 'safe';
  } else if (ratio < 0.6) {
    ringFill.style.stroke = '#ffb800';
    ringFill.style.filter = 'drop-shadow(0 0 8px rgba(255,184,0,0.7))';
    riskSub.style.color   = '#ffb800';
    riskSub.textContent   = 'caution';
  } else {
    ringFill.style.stroke = '#ff2244';
    ringFill.style.filter = 'drop-shadow(0 0 12px rgba(255,34,68,0.8))';
    riskSub.style.color   = '#ff2244';
    riskSub.textContent   = 'danger!';
  }
}

// ── Stats from backend ────────────────────────────────
async function pollStats() {
  try {
    const r = await fetch(`${API_BASE}/stats`, { 
      signal: AbortSignal.timeout(2000),
      headers: { "Bypass-Tunnel-Reminder": "true" }
    });
    const d = await r.json();
    tileFrames.textContent  = d.total_frames;
    tileAwake.textContent   = `${d.awake_percent}%`;
    tileDrowsy.textContent  = `${d.drowsy_percent}%`;
    tileElapsed.textContent = formatTime(d.elapsed_seconds);
  } catch (_) {}
}

function updateFPS(fps) {
  fpsVal.textContent  = fps;
  fpsFill.style.width = `${Math.min((fps / 8) * 100, 100)}%`;
}

// ── Log ───────────────────────────────────────────────
let lastLogState = null, logThrottle = 0;
function addLog(state, message) {
  const now = Date.now();
  if (!['system', 'warning', 'critical'].includes(state)) {
    if (state === lastLogState && now - logThrottle < 2000) return;
    lastLogState = state; logThrottle = now;
  }
  const e = logList.querySelector('.log-empty'); if (e) e.remove();
  const li = document.createElement('li');
  li.className = `log-item ${state}`;
  li.innerHTML = `${state !== 'system' ? '<span class="log-dot"></span>' : ''}<span>${message}</span><span class="log-time">${formatClock()}</span>`;
  logList.prepend(li);
  while (logList.children.length > LOG_MAX) logList.removeChild(logList.lastChild);
}

// ── Reset session ─────────────────────────────────────
async function resetSession() {
  try { 
    await fetch(`${API_BASE}/reset`, { 
      method: 'POST', 
      signal: AbortSignal.timeout(3000),
      headers: { "Bypass-Tunnel-Reminder": "true" }
    }); 
  } catch (_) {}
  drowsyStartTime = null; currentLevel = 'none'; graceCount = 0;
  fpsHistory = []; lastAlertTime = 0; frontHistory = [];
  updateFPS(0); updateRiskRing(0);
  tileFrames.textContent = '0'; tileAwake.textContent = '0%';
  tileDrowsy.textContent = '0%'; tileElapsed.textContent = '0s';
  statePill.textContent = '––'; statePill.className = 'state-pill';
  resetUIState(); clearOverlay();
  setStatusMsg('', '⚫', 'SESSION RESET.');
  stopAllAlerts();
  addLog('system', 'Session reset');
}

// ── Helpers ───────────────────────────────────────────
function formatTime(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return m > 0 ? `${m}m ${ss}s` : `${ss}s`;
}
function formatClock() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function resizeOverlay() {
  overlayCanvas.width  = overlayCanvas.offsetWidth;
  overlayCanvas.height = overlayCanvas.offsetHeight;
  drawDetections(lastDetections);
}
window.addEventListener('resize', resizeOverlay);
resizeOverlay();

// ── Events ────────────────────────────────────────────
// IMPORTANT: initAudio() must be called inside click handler (user gesture)
btnStart.addEventListener('click', () => { initAudio(); startMonitoring(); });
btnStop.addEventListener('click', stopMonitoring);
btnReset.addEventListener('click', resetSession);
btnSound.addEventListener('click', () => { initAudio(); toggleSound(); });

// Test sound — directly calls playAlert() inside click → browser allows it
document.getElementById('btnTestSound').addEventListener('click', () => {
  initAudio();
  playAlert('alert');
});

btnClearLog.addEventListener('click', () => {
  logList.innerHTML = '<li class="log-item log-empty">Log cleared…</li>';
  lastLogState = null;
});

window.addEventListener('pagehide', stopMonitoring);
