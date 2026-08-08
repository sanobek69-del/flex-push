/* ============================================================
   PUSH-UP SURVIVAL — game engine + MediaPipe Pose detection
   ============================================================
   Flow: idle -> loading model -> calibrate -> playing
         -> (levelup) -> ... -> gameover
   Controls are button-only. No page scroll (app-like).
   ============================================================ */

'use strict';

/* ---------------- DOM refs ---------------- */
const $ = (id) => document.getElementById(id);

const video      = $('camera');
const overlay    = $('overlay');
const octx       = overlay.getContext('2d');
const fxCanvas   = $('fx');
const fxctx      = fxCanvas.getContext('2d');

const levelValue = $('levelValue');
const scoreValue = $('scoreValue');
const bestValue  = $('bestValue');
const heartsEl   = $('hearts');
const comboEl    = $('combo');
const comboValue = $('comboValue');
const arenaEl    = $('arena');
const statusText = $('statusText');
const depthFill  = $('depthFill');
const repHint    = $('repHint');
const popupsEl   = $('popups');

const btnStart   = $('btnStart');
const btnPause   = $('btnPause');
const btnRestart = $('btnRestart');
const btnSound   = $('btnSound');

const screens = {
  start:     $('overlayStart'),
  loading:   $('overlayLoading'),
  calibrate: $('overlayCalibrate'),
  level:     $('overlayLevel'),
  pause:     $('overlayPause'),
  gameover:  $('overlayGameOver'),
  error:     $('overlayError'),
};

/* ---------------- Constants / tuning ---------------- */
const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const MAX_HEALTH = 5;
const REP_COOLDOWN = 600;        // ms — ignore faster-than-human reps
const DOWN_ANGLE = 95;           // elbow angle to be considered "down"
const UP_ANGLE = 155;            // elbow angle to be considered "up"
const BODY_STRAIGHT_MIN = 150;   // hip angle (shoulder-hip-ankle) for straight body
const BEST_KEY = 'pus_best_score';

/* ---------------- Game state ---------------- */
const state = {
  phase: 'idle',           // idle | calibrate | playing | paused | levelup | gameover
  level: 1,
  score: 0,
  combo: 0,
  health: MAX_HEALTH,
  creatures: [],
  best: Number(localStorage.getItem(BEST_KEY) || 0),
  soundOn: true,
};

/* pose rep state machine */
let repState = 'up';       // up | down
let repFormOk = true;
let lastRepTime = 0;
let frameCount = 0;
let poseReady = false;
let cameraStream = null;
let rafId = null;

/* ============================================================
   AUDIO — tiny WebAudio beeps (no asset files needed)
   ============================================================ */
let audioCtx = null;
function beep(freq, dur = 0.08, type = 'sine', vol = 0.15) {
  if (!state.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* ignore */ }
}
const sfx = {
  hit:      () => beep(520, 0.09, 'square', 0.12),
  miss:     () => { beep(160, 0.18, 'sawtooth', 0.14); },
  kill:     () => { beep(680, 0.12, 'square'); setTimeout(() => beep(880, 0.14, 'square'), 90); },
  levelup:  () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.12, 'triangle'), i * 90)); },
  gameover: () => { [400, 300, 200].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'sawtooth', 0.16), i * 180)); },
  countdown:() => beep(440, 0.1, 'sine'),
};

/* ============================================================
   UI HELPERS
   ============================================================ */
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('screen--show'));
  if (name && screens[name]) screens[name].classList.add('screen--show');
}

function renderHearts() {
  heartsEl.innerHTML = '';
  for (let i = 0; i < MAX_HEALTH; i++) {
    const h = document.createElement('span');
    h.className = 'heart' + (i >= state.health ? ' lost' : '');
    heartsEl.appendChild(h);
  }
}

function updateHUD() {
  levelValue.textContent = state.level;
  scoreValue.textContent = state.score;
  bestValue.textContent = state.best;
  comboValue.textContent = state.combo;
}

function setStatus(text, kind = '') {
  statusText.textContent = text;
  statusText.className = 'status-text' + (kind ? ' ' + kind : '');
}

function floatingPopup(text, kind, xPct = 50, yPct = 40) {
  const p = document.createElement('div');
  p.className = 'pop ' + kind;
  p.textContent = text;
  p.style.left = xPct + '%';
  p.style.top = yPct + '%';
  popupsEl.appendChild(p);
  setTimeout(() => p.remove(), 1000);
}

/* ============================================================
   CREATURES / LEVEL SETUP
   ============================================================ */
const CREATURE_SPRITES = ['assets/creature-1.png', 'assets/creature-2.png'];
const BOSS_SPRITE = 'assets/creature-boss.png';

function buildLevel(level) {
  // Difficulty scaling
  const isBoss = level % 5 === 0;
  const count = isBoss ? 1 : Math.min(3, 1 + Math.floor((level - 1) / 2));
  const hpEach = isBoss ? 12 + level * 2 : 4 + level * 2;

  state.creatures = [];
  arenaEl.innerHTML = '';

  for (let i = 0; i < count; i++) {
    const sprite = isBoss ? BOSS_SPRITE : CREATURE_SPRITES[(level + i) % CREATURE_SPRITES.length];
    const creature = { hp: hpEach, maxHp: hpEach, dead: false };

    const el = document.createElement('div');
    el.className = 'creature';
    el.innerHTML = `
      <img src="${sprite}" alt="Enemy creature" />
      <div class="hpbar"><div class="hpbar-fill"></div></div>
      <div class="hp-text">${hpEach} / ${hpEach}</div>`;
    arenaEl.appendChild(el);

    creature.el = el;
    creature.fill = el.querySelector('.hpbar-fill');
    creature.text = el.querySelector('.hp-text');
    if (isBoss) el.style.width = 'clamp(150px, 55vw, 230px)';
    state.creatures.push(creature);
  }
}

function activeCreature() {
  return state.creatures.find((c) => !c.dead);
}

/* Deal damage to the current front creature */
function damageCreature(amount) {
  const c = activeCreature();
  if (!c) return;
  c.hp = Math.max(0, c.hp - amount);
  c.fill.style.width = (c.hp / c.maxHp * 100) + '%';
  c.text.textContent = `${c.hp} / ${c.maxHp}`;
  c.el.classList.remove('hit');
  void c.el.offsetWidth;           // restart animation
  c.el.classList.add('hit');

  const rect = c.el.getBoundingClientRect();
  const stageRect = arenaEl.parentElement.getBoundingClientRect();
  const xPct = ((rect.left + rect.width / 2 - stageRect.left) / stageRect.width) * 100;
  const yPct = ((rect.top - stageRect.top) / stageRect.height) * 100;
  floatingPopup('-' + amount, 'dmg', xPct, Math.max(12, yPct));

  if (c.hp <= 0) killCreature(c);
}

function killCreature(c) {
  c.dead = true;
  c.el.classList.add('dead');
  sfx.kill();
  explode();
  setTimeout(() => { if (c.el) c.el.style.visibility = 'hidden'; }, 500);

  // All dead -> level up
  if (state.creatures.every((cr) => cr.dead)) {
    setTimeout(levelUp, 600);
  }
}

/* ============================================================
   HEALTH / SCORE
   ============================================================ */
function loseHealth() {
  state.health = Math.max(0, state.health - 1);
  renderHearts();
  const hearts = heartsEl.querySelectorAll('.heart');
  const lost = hearts[state.health];
  if (lost) { lost.classList.add('pop'); setTimeout(() => lost.classList.remove('pop'), 400); }
  navigator.vibrate && navigator.vibrate(120);
  if (state.health <= 0) gameOver();
}

function goodRep() {
  state.combo += 1;
  const dmg = 1 + Math.floor(state.combo / 5);   // combo boosts damage
  const gained = 10 * (1 + Math.floor(state.combo / 3));
  state.score += gained;

  comboEl.classList.add('bump');
  setTimeout(() => comboEl.classList.remove('bump'), 150);

  setStatus('Zo\u2018r! +' + gained, '');
  repHint.textContent = 'Combo x' + state.combo;
  sfx.hit();
  damageCreature(dmg);
  updateHUD();
}

function badRep() {
  state.combo = 0;
  setStatus('Miss! Formani to\u2018g\u2018rilang', 'bad');
  repHint.textContent = 'Tanani tekis tuting';
  floatingPopup('MISS', 'miss', 50, 34);
  sfx.miss();
  loseHealth();
  updateHUD();
}

/* ============================================================
   PHASES: level up, game over, pause, restart
   ============================================================ */
function levelUp() {
  state.level += 1;
  state.phase = 'levelup';
  $('levelUpNum').textContent = state.level;
  showScreen('level');
  sfx.levelup();
  celebrate();
  updateHUD();

  setTimeout(() => {
    buildLevel(state.level);
    updateHUD();
    showScreen(null);
    state.phase = 'playing';
    setStatus('Level ' + state.level + ' — Jang!', 'warn');
  }, 1800);
}

function gameOver() {
  state.phase = 'gameover';
  const isBest = state.score > state.best;
  if (isBest) {
    state.best = state.score;
    localStorage.setItem(BEST_KEY, String(state.best));
  }
  $('goLevel').textContent = state.level;
  $('goScore').textContent = state.score;
  $('goBest').textContent = state.best;
  $('goNewBest').hidden = !isBest;
  showScreen('gameover');
  sfx.gameover();
  btnPause.disabled = true;
  updateHUD();
}

function pauseGame() {
  if (state.phase !== 'playing') return;
  state.phase = 'paused';
  showScreen('pause');
  btnPause.textContent = 'Pause';
}

function resumeGame() {
  if (state.phase !== 'paused') return;
  state.phase = 'playing';
  showScreen(null);
}

function resetGame() {
  state.level = 1;
  state.score = 0;
  state.combo = 0;
  state.health = MAX_HEALTH;
  repState = 'up';
  repFormOk = true;
  lastRepTime = 0;
  renderHearts();
  buildLevel(1);
  updateHUD();
  setStatus('Push-up qiling!', 'warn');
}

/* ============================================================
   CAMERA + MEDIAPIPE POSE
   ============================================================ */
let pose = null;

function initPose() {
  if (pose) return pose;
  pose = new Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5/${file}`,
  });
  pose.setOptions({
    modelComplexity: IS_MOBILE ? 0 : 1,   // Lite on mobile for FPS
    smoothLandmarks: true,
    enableSegmentation: false,             // off = faster
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
    selfieMode: true,
  });
  pose.onResults(onPoseResults);
  return pose;
}

async function startCamera() {
  const constraints = {
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
  };
  cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = cameraStream;
  await video.play();
  // Size canvases to the video's displayed area
  resizeCanvases();
}

function resizeCanvases() {
  const rect = video.getBoundingClientRect();
  [overlay, fxCanvas].forEach((c) => {
    c.width = rect.width;
    c.height = rect.height;
  });
}
window.addEventListener('resize', resizeCanvases);

/* Main frame loop — controls frame skipping for performance */
function loop() {
  rafId = requestAnimationFrame(loop);
  if (!poseReady) return;
  if (state.phase === 'paused' || state.phase === 'gameover' || state.phase === 'idle') return;
  if (video.readyState < 2) return;

  frameCount++;
  const skip = IS_MOBILE ? 2 : 1;        // process every 2nd frame on mobile
  if (frameCount % skip === 0) {
    pose.send({ image: video }).catch(() => {});
  }
}

/* ============================================================
   POSE ANALYSIS
   ============================================================ */
function calcAngle(a, b, c) {
  // angle at point b (in degrees)
  const rad = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let deg = Math.abs(rad * 180 / Math.PI);
  if (deg > 180) deg = 360 - deg;
  return deg;
}

function vis(lm, i) { return lm[i] && lm[i].visibility > 0.5; }

function onPoseResults(results) {
  drawSkeleton(results);

  const lm = results.poseLandmarks;
  if (!lm) { onPoseLost(); return; }

  // Landmark indices
  const L = { sh: 11, el: 13, wr: 15, hip: 23, ank: 27 };
  const R = { sh: 12, el: 14, wr: 16, hip: 24, ank: 28 };

  const haveLeft  = vis(lm, L.sh) && vis(lm, L.el) && vis(lm, L.wr);
  const haveRight = vis(lm, R.sh) && vis(lm, R.el) && vis(lm, R.wr);
  if (!haveLeft && !haveRight) { onPoseLost(); return; }

  // Elbow angle (average of visible arms)
  const angles = [];
  if (haveLeft)  angles.push(calcAngle(lm[L.sh], lm[L.el], lm[L.wr]));
  if (haveRight) angles.push(calcAngle(lm[R.sh], lm[R.el], lm[R.wr]));
  const elbow = angles.reduce((a, b) => a + b, 0) / angles.length;

  // Body straightness (shoulder-hip-ankle angle, ~180 = straight)
  const bodyAngles = [];
  if (vis(lm, L.sh) && vis(lm, L.hip) && vis(lm, L.ank)) bodyAngles.push(calcAngle(lm[L.sh], lm[L.hip], lm[L.ank]));
  if (vis(lm, R.sh) && vis(lm, R.hip) && vis(lm, R.ank)) bodyAngles.push(calcAngle(lm[R.sh], lm[R.hip], lm[R.ank]));
  const bodyStraight = bodyAngles.length
    ? (bodyAngles.reduce((a, b) => a + b, 0) / bodyAngles.length) > BODY_STRAIGHT_MIN
    : true;   // if legs not visible, don't punish

  // --- Calibration: wait for a valid pose then countdown ---
  if (state.phase === 'calibrate') {
    handleCalibration(elbow);
    return;
  }
  if (state.phase !== 'playing') return;

  // Depth meter (155 up -> 0%, 95 down -> 100%)
  const depth = Math.min(100, Math.max(0, (UP_ANGLE - elbow) / (UP_ANGLE - DOWN_ANGLE) * 100));
  depthFill.style.width = depth + '%';

  // --- Rep state machine ---
  if (repState === 'up' && elbow < DOWN_ANGLE) {
    repState = 'down';
    repFormOk = bodyStraight;        // capture form at descent
    if (!bodyStraight) setStatus('Tanani tekis tuting', 'warn');
  } else if (repState === 'down') {
    if (!bodyStraight) repFormOk = false;   // any sag during rep = bad
    if (elbow > UP_ANGLE) {
      repState = 'up';
      const now = performance.now();
      if (now - lastRepTime > REP_COOLDOWN) {
        lastRepTime = now;
        repFormOk ? goodRep() : badRep();
      }
    }
  }
}

let lostFrames = 0;
function onPoseLost() {
  if (state.phase === 'calibrate') {
    $('calibHint').textContent = 'Tana ko\u2018rinmayapti — kadrga to\u2018liq kiring';
    return;
  }
  if (state.phase !== 'playing') return;
  lostFrames++;
  if (lostFrames > 20) {
    setStatus('Tana ko\u2018rinmayapti', 'warn');
    depthFill.style.width = '0%';
  }
}

/* ---------------- Calibration ---------------- */
let calibValidFrames = 0;
let calibrating = false;
function handleCalibration(elbow) {
  // Need arms extended (up position) + person detected for a moment
  if (elbow > 120) {
    calibValidFrames++;
    $('calibHint').textContent = 'Tayyor! Push-up holatida qoling';
  } else {
    calibValidFrames = Math.max(0, calibValidFrames - 1);
    $('calibHint').textContent = 'Qo\u2018llaringizni to\u2018g\u2018rilab tayyor turing';
  }
  if (calibValidFrames > 12 && !calibrating) {
    calibrating = true;
    runCountdown();
  }
}

function runCountdown() {
  let n = 3;
  const el = $('calibCountdown');
  el.textContent = n;
  sfx.countdown();
  const iv = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(iv);
      startPlaying();
    } else {
      el.textContent = n;
      sfx.countdown();
    }
  }, 900);
}

function startPlaying() {
  calibrating = false;
  showScreen(null);
  state.phase = 'playing';
  btnPause.disabled = false;
  setStatus('Level 1 — Jang!', 'warn');
}

/* ============================================================
   DRAWING (skeleton overlay)
   ============================================================ */
const POSE_CONNECTIONS = [
  [11, 13], [13, 15], [12, 14], [14, 16],  // arms
  [11, 12], [11, 23], [12, 24], [23, 24],  // torso
  [23, 25], [25, 27], [24, 26], [26, 28],  // legs
];
function drawSkeleton(results) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const lm = results.poseLandmarks;
  if (!lm) return;
  const W = overlay.width, H = overlay.height;

  octx.lineWidth = 4;
  octx.strokeStyle = 'rgba(255,107,0,0.85)';
  octx.fillStyle = '#37d67a';

  POSE_CONNECTIONS.forEach(([a, b]) => {
    if (lm[a] && lm[b] && lm[a].visibility > 0.4 && lm[b].visibility > 0.4) {
      octx.beginPath();
      octx.moveTo(lm[a].x * W, lm[a].y * H);
      octx.lineTo(lm[b].x * W, lm[b].y * H);
      octx.stroke();
    }
  });
  lm.forEach((p) => {
    if (p.visibility > 0.4) {
      octx.beginPath();
      octx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
      octx.fill();
    }
  });
}

/* ============================================================
   PARTICLE FX (explosion + level-up confetti)
   ============================================================ */
let particles = [];
let fxRunning = false;

function spawnParticles(cx, cy, colors, count, speed) {
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = speed * (0.4 + Math.random() * 0.8);
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp - 2,
      life: 1,
      size: 4 + Math.random() * 6,
      color: colors[(Math.random() * colors.length) | 0],
    });
  }
  if (!fxRunning) { fxRunning = true; requestAnimationFrame(fxLoop); }
}

function explode() {
  spawnParticles(fxCanvas.width / 2, fxCanvas.height * 0.42, ['#FF6B00', '#ff8a33', '#ffffff'], 40, 7);
}
function celebrate() {
  spawnParticles(fxCanvas.width / 2, fxCanvas.height * 0.35, ['#FF6B00', '#ff8a33', '#37d67a', '#ffffff'], 90, 9);
}

function fxLoop() {
  fxctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  particles.forEach((p) => {
    p.vy += 0.25;               // gravity
    p.x += p.vx; p.y += p.vy;
    p.life -= 0.02;
    fxctx.globalAlpha = Math.max(0, p.life);
    fxctx.fillStyle = p.color;
    fxctx.fillRect(p.x, p.y, p.size, p.size);
  });
  fxctx.globalAlpha = 1;
  particles = particles.filter((p) => p.life > 0);
  if (particles.length) {
    requestAnimationFrame(fxLoop);
  } else {
    fxRunning = false;
    fxctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  }
}

/* ============================================================
   BOOT / BUTTON WIRING
   ============================================================ */
async function beginGame() {
  showScreen('loading');
  try {
    initPose();
    $('loadingText').textContent = 'Kamera ochilmoqda...';
    await startCamera();

    $('loadingText').textContent = 'Model ishga tushmoqda...';
    // warm up the model once
    await pose.send({ image: video });
    poseReady = true;

    // Prepare first level, go to calibration
    resetGame();
    calibValidFrames = 0;
    calibrating = false;
    state.phase = 'calibrate';
    showScreen('calibrate');
    $('calibCountdown').textContent = '3';

    btnStart.disabled = true;
    btnRestart.disabled = false;

    if (!rafId) loop();
  } catch (err) {
    console.log('[v0] camera/model error:', err && err.message);
    let msg = 'Kameraga kirish imkoni bo\u2018lmadi.';
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      msg = 'Kamera ruxsati rad etildi. Brauzer sozlamalaridan ruxsat bering.';
    } else if (err && err.name === 'NotFoundError') {
      msg = 'Kamera topilmadi. Qurilmangizda old kamera borligini tekshiring.';
    }
    $('errorText').textContent = msg;
    showScreen('error');
  }
}

function fullRestart() {
  if (state.phase === 'idle') return;
  resetGame();
  calibValidFrames = 0;
  calibrating = false;
  state.phase = 'calibrate';
  showScreen('calibrate');
  $('calibCountdown').textContent = '3';
  btnPause.disabled = false;
}

/* --- events --- */
btnStart.addEventListener('click', beginGame);
$('btnBegin').addEventListener('click', beginGame);
$('btnErrorRetry').addEventListener('click', beginGame);

btnPause.addEventListener('click', () => {
  if (state.phase === 'playing') pauseGame();
  else if (state.phase === 'paused') resumeGame();
});
$('btnResume').addEventListener('click', resumeGame);

btnRestart.addEventListener('click', fullRestart);
$('btnGameOverRestart').addEventListener('click', fullRestart);

btnSound.addEventListener('click', () => {
  state.soundOn = !state.soundOn;
  btnSound.classList.toggle('muted', !state.soundOn);
  btnSound.textContent = state.soundOn ? 'SND' : 'OFF';
});

// Clean up camera on unload
window.addEventListener('beforeunload', () => {
  if (pose) pose.close();
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
});

/* --- initial paint --- */
renderHearts();
buildLevel(1);
updateHUD();
showScreen('start');
