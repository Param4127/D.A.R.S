'use strict';

// ── Config ───────────────────────────────────────────
const API_BASE        = 'http://127.0.0.1:8000';
const FRAME_INTERVAL  = 350;
const CAPTURE_W       = 416;
const CAPTURE_H       = 234;
const CAPTURE_QUALITY = 0.5;
const LOG_MAX         = 60;
const WARN_AFTER      = 1500;
const ALERT_AFTER     = 3000;
const CRITICAL_AFTER  = 5000;
const ALERT_COOLDOWN  = 4000;
const GRACE_FRAMES    = 3;
const FRONT_WINDOW    = 10;  // rolling window for frontend risk %

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
let lastAlertTime   = 0;
let drowsyStartTime = null;
let currentLevel    = 'none';
let graceCount      = 0;

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
//  FIX 2: AudioContext — created ONCE on first user
//  gesture, then reused.  playAlert() always resumes
//  the context before scheduling tones so it works
//  even after Chrome auto-suspends it.
// ─────────────────────────────────────────────────────
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx || audioCtx.state === 'closed') {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('[DARS] AudioContext creation failed:', e);
      return null;
    }
  }
  return audioCtx;
}

// Call once inside a click handler so browsers allow it
function initAudio() {
  const ctx = ensureAudio();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────
//  FIX 3: playAlert — schedules 3 sharp beeps.
//  Always calls resume() first (required after Chrome
//  suspends the context), then schedules tones.
// ─────────────────────────────────────────────────────
function playAlert(level = 'alert') {
  if (!soundEnabled) return;

  const ctx = ensureAudio();
  if (!ctx) return;

  // Frequencies and patterns per severity
  const configs = {
    warning:  { freq: 660,  count: 2, interval: 0.3,  gainPeak: 0.25, dur: 0.2  },
    alert:    { freq: 900,  count: 3, interval: 0.25, gainPeak: 0.35, dur: 0.22 },
    critical: { freq: 1100, count: 5, interval: 0.18, gainPeak: 0.5,  dur: 0.16 },
  };
  const cfg = configs[level] || configs.alert;

  ctx.resume().then(() => {
    try {
      const now = ctx.currentTime;
      for (let i = 0; i < cfg.count; i++) {
        const t = now + i * cfg.interval;

        // Main oscillator
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(cfg.freq, t);
        // quick attack, fast decay
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(cfg.gainPeak, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t + cfg.dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + cfg.dur + 0.01);

        // Sub-tone for richness
        const osc2  = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(cfg.freq * 0.5, t);
        gain2.gain.setValueAtTime(0, t);
        gain2.gain.linearRampToValueAtTime(cfg.gainPeak * 0.4, t + 0.01);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + cfg.dur);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(t);
        osc2.stop(t + cfg.dur + 0.01);
      }
    } catch (e) {
      console.warn('[DARS] playAlert error:', e);
    }
  }).catch(e => console.warn('[DARS] AudioContext resume failed:', e));
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
    const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
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

// ── Handle prediction ────────────────────────────────
function handlePrediction(data) {
  const dominant   = data.dominant   || 'none';
  const detections = data.detections || [];

  // ── FIX: Compute risk ratio correctly (0.0–1.0) ──
  const drowsyRatio = computeFrontRatio(dominant);

  drawDetections(detections);

  statePill.textContent = dominant === 'none' ? 'NO FACE' : dominant.toUpperCase();
  statePill.className   = `state-pill ${dominant}`;

  // ── FIX: Pass the correct 0–1 ratio to the ring ──
  updateRiskRing(drowsyRatio);

  // Time-based drowsiness engine
  checkDrowsiness(dominant === 'drowsy');

  // Sound trigger when risk ratio crosses 60 %
  const now = Date.now();
  if (drowsyRatio > 0.6 && now - lastAlertTime > ALERT_COOLDOWN) {
    playAlert('alert');
    lastAlertTime = now;
  }

  if (dominant !== 'none') {
    addLog(dominant, `${dominant.toUpperCase()} detected — risk: ${Math.round(drowsyRatio * 100)}%`);
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
//  TIME-BASED DROWSINESS ENGINE WITH GRACE PERIOD
// ─────────────────────────────────────────────────────
function checkDrowsiness(isDrowsy) {
  const now = Date.now();

  if (isDrowsy) {
    graceCount = 0;
    if (!drowsyStartTime) drowsyStartTime = now;
    const dur = now - drowsyStartTime;

    if (dur > CRITICAL_AFTER) {
      if (currentLevel !== 'critical') {
        currentLevel = 'critical';
        activateCriticalUI();
        addLog('critical', '🚨 CRITICAL — 5s+ drowsiness detected!');
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
        addLog('drowsy', '⚠ ALERT — 3s drowsiness detected');
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
    graceCount++;
    if (graceCount >= GRACE_FRAMES && drowsyStartTime !== null) {
      drowsyStartTime = null; graceCount = 0;
      if (!['none','safe'].includes(currentLevel)) addLog('awake', '✓ Cleared — driver awake');
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
  // Clamp to [0, 1]
  ratio = Math.max(0, Math.min(1, ratio));

  const CIRC = 314; // circumference for r=50
  // offset 314 = empty, offset 0 = full
  const offset = CIRC - (ratio * CIRC);
  ringFill.style.strokeDashoffset = offset.toFixed(1);

  // Update percentage text
  riskPercent.textContent = `${Math.round(ratio * 100)}%`;

  // Color thresholds
  if (ratio < 0.35) {
    ringFill.className = 'ring-fill';
    riskSub.style.color = 'var(--green)';
    riskSub.textContent = 'safe';
  } else if (ratio < 0.6) {
    ringFill.className = 'ring-fill medium';
    riskSub.style.color = 'var(--amber)';
    riskSub.textContent = 'caution';
  } else {
    ringFill.className = 'ring-fill high';
    riskSub.style.color = 'var(--red)';
    riskSub.textContent = 'danger!';
  }
}

// ── Stats from backend ────────────────────────────────
async function pollStats() {
  try {
    const r = await fetch(`${API_BASE}/stats`, { signal: AbortSignal.timeout(2000) });
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
  try { await fetch(`${API_BASE}/reset`, { method: 'POST', signal: AbortSignal.timeout(3000) }); } catch (_) {}
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
