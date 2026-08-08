/**
 * Push-Up Survival — main game logic
 * MediaPipe Pose + real push-up detection + creatures + health system
 */

(function () {
  "use strict";

  // ===================== CONFIG =====================
  const CONFIG = {
    maxHearts: 5,
    baseCreatureHp: 3,
    hpPerLevel: 1.4,
    maxCreatures: 3,
    comboTimeout: 3500,
    minRepInterval: 650,
    downAngle: 95,
    upAngle: 155,
    bodyStraightThreshold: 0.18,
    modelComplexity: 0,          // 0 = eng tez (mobil uchun)
  };

  // ===================== STATE =====================
  const state = {
    running: false,
    paused: false,
    level: 1,
    score: 0,
    best: Number(localStorage.getItem("pus_best") || 0),
    hearts: CONFIG.maxHearts,
    combo: 0,
    lastRepTime: 0,
    pushState: "up",
    creatures: [],
    soundOn: true,
    poseReady: false,
    cameraReady: false,
  };

  // ===================== DOM =====================
  const $ = (id) => document.getElementById(id);

  const dom = {
    video: $("camera"),
    canvas: $("overlay"),
    fx: $("fx"),
    arena: $("arena"),
    hearts: $("hearts"),
    levelValue: $("levelValue"),
    scoreValue: $("scoreValue"),
    bestValue: $("bestValue"),
    comboValue: $("comboValue"),
    combo: $("combo"),
    statusText: $("statusText"),
    depthFill: $("depthFill"),
    repHint: $("repHint"),
    popups: $("popups"),

    btnStart: $("btnStart"),
    btnPause: $("btnPause"),
    btnRestart: $("btnRestart"),
    btnSound: $("btnSound"),
    btnBegin: $("btnBegin"),
    btnResume: $("btnResume"),
    btnGameOverRestart: $("btnGameOverRestart"),
    btnErrorRetry: $("btnErrorRetry"),

    overlayStart: $("overlayStart"),
    overlayLoading: $("overlayLoading"),
    overlayCalibrate: $("overlayCalibrate"),
    overlayLevel: $("overlayLevel"),
    overlayPause: $("overlayPause"),
    overlayGameOver: $("overlayGameOver"),
    overlayError: $("overlayError"),

    levelUpNum: $("levelUpNum"),
    goLevel: $("goLevel"),
    goScore: $("goScore"),
    goBest: $("goBest"),
    goNewBest: $("goNewBest"),
    errorText: $("errorText"),
    loadingText: $("loadingText"),
    calibCountdown: $("calibCountdown"),
    calibHint: $("calibHint"),
  };

  const ctx = dom.canvas.getContext("2d");

  // ===================== AUDIO =====================
  let audioCtx = null;
  function beep(freq = 440, dur = 0.08, type = "square", vol = 0.08) {
    if (!state.soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = vol;
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  }

  // ===================== UI HELPERS =====================
  function showScreen(el) {
    [dom.overlayStart, dom.overlayLoading, dom.overlayCalibrate,
     dom.overlayLevel, dom.overlayPause, dom.overlayGameOver, dom.overlayError]
      .forEach(s => s && s.classList.remove("screen--show"));
    if (el) el.classList.add("screen--show");
  }

  function hideAllScreens() {
    showScreen(null);
  }

  function setStatus(text, type = "") {
    dom.statusText.textContent = text;
    dom.statusText.className = "status-text" + (type ? " " + type : "");
  }

  function updateHUD() {
    dom.levelValue.textContent = state.level;
    dom.scoreValue.textContent = state.score;
    dom.bestValue.textContent = state.best;
    dom.comboValue.textContent = state.combo;
    dom.combo.classList.toggle("bump", state.combo > 0);
  }

  function renderHearts() {
    dom.hearts.innerHTML = "";
    for (let i = 0; i < CONFIG.maxHearts; i++) {
      const h = document.createElement("span");
      h.className = "heart" + (i >= state.hearts ? " lost" : "");
      dom.hearts.appendChild(h);
    }
  }

  function popup(text, x, y, type = "dmg") {
    const el = document.createElement("div");
    el.className = "pop " + type;
    el.textContent = text;
    el.style.left = x + "px";
    el.style.top = y + "px";
    dom.popups.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }

  // ===================== CREATURES =====================
  const CREATURE_IMGS = [
    "assets/creature-1.png",
    "assets/creature-2.png",
    "assets/creature-boss.png",
  ];

  function createCreature(hp) {
    const img = CREATURE_IMGS[Math.min(state.level - 1, CREATURE_IMGS.length - 1)] || CREATURE_IMGS[0];
    return {
      id: Math.random().toString(36).slice(2),
      hp: hp,
      maxHp: hp,
      img: img,
      dead: false,
    };
  }

  function spawnCreatures() {
    state.creatures = [];
    const count = Math.min(1 + Math.floor((state.level - 1) / 2), CONFIG.maxCreatures);
    const baseHp = Math.round(CONFIG.baseCreatureHp + (state.level - 1) * CONFIG.hpPerLevel);

    for (let i = 0; i < count; i++) {
      state.creatures.push(createCreature(baseHp + i));
    }
    renderCreatures();
  }

  function renderCreatures() {
    dom.arena.innerHTML = "";
    state.creatures.forEach((c) => {
      if (c.dead) return;
      const card = document.createElement("div");
      card.className = "creature";
      card.dataset.id = c.id;
      card.innerHTML = `
        <img src="${c.img}" alt="creature" draggable="false" />
        <div class="hpbar"><div class="hpbar-fill" style="width:${(c.hp / c.maxHp) * 100}%"></div></div>
        <div class="hp-text">\( {c.hp}/ \){c.maxHp}</div>
      `;
      dom.arena.appendChild(card);
    });
  }

  function damageCreatures(amount = 1) {
    for (const c of state.creatures) {
      if (c.dead) continue;
      c.hp -= amount;
      const el = dom.arena.querySelector(`[data-id="${c.id}"]`);
      if (el) {
        el.classList.add("hit");
        setTimeout(() => el.classList.remove("hit"), 220);
        const fill = el.querySelector(".hpbar-fill");
        const txt = el.querySelector(".hp-text");
        if (fill) fill.style.width = Math.max(0, (c.hp / c.maxHp) * 100) + "%";
        if (txt) txt.textContent = Math.max(0, c.hp) + "/" + c.maxHp;
      }
      if (c.hp <= 0) {
        c.dead = true;
        if (el) {
          el.classList.add("dead");
          setTimeout(() => el.remove(), 500);
        }
        beep(220, 0.12, "sawtooth", 0.1);
      }
    }

    if (state.creatures.every(c => c.dead)) {
      levelUp();
    }
  }

  // ===================== GAME FLOW =====================
  function levelUp() {
    state.level++;
    state.hearts = Math.min(CONFIG.maxHearts, state.hearts + 1);
    renderHearts();
    updateHUD();

    dom.levelUpNum.textContent = state.level;
    showScreen(dom.overlayLevel);
    beep(660, 0.15);
    setTimeout(() => beep(880, 0.2), 120);

    setTimeout(() => {
      hideAllScreens();
      spawnCreatures();
      setStatus("Level " + state.level + " — Push!");
    }, 1600);
  }

  function loseHeart() {
    if (state.hearts <= 0) return;
    state.hearts--;
    renderHearts();
    beep(140, 0.15, "sawtooth", 0.12);
    setStatus("Xato forma! Jon yo'qoldi", "bad");

    if (state.hearts <= 0) {
      gameOver();
    }
  }

  function addScore(points) {
    state.score += points;
    if (state.score > state.best) {
      state.best = state.score;
      localStorage.setItem("pus_best", state.best);
    }
    updateHUD();
  }

  function registerRep(perfect = true) {
    const now = Date.now();
    if (now - state.lastRepTime < CONFIG.minRepInterval) return;
    state.lastRepTime = now;

    if (perfect) {
      state.combo++;
      const dmg = 1 + Math.floor(state.combo / 5);
      damageCreatures(dmg);
      addScore(10 + state.combo * 2);
      setStatus("Yaxshi! +" + (10 + state.combo * 2));
      dom.repHint.textContent = "To'liq push-up ✓";
      beep(520 + state.combo * 20, 0.07);

      const rect = dom.arena.getBoundingClientRect();
      popup("+" + (10 + state.combo * 2), rect.left + rect.width / 2, rect.top + 40, "dmg");
    } else {
      state.combo = 0;
      loseHeart();
      popup("MISS", window.innerWidth / 2, window.innerHeight * 0.45, "miss");
    }
    updateHUD();
  }

  function gameOver() {
    state.running = false;
    state.paused = false;
    dom.btnStart.disabled = false;
    dom.btnPause.disabled = true;
    dom.btnRestart.disabled = false;

    dom.goLevel.textContent = state.level;
    dom.goScore.textContent = state.score;
    dom.goBest.textContent = state.best;
    dom.goNewBest.hidden = !(state.score >= state.best && state.score > 0);

    showScreen(dom.overlayGameOver);
    beep(110, 0.3, "sawtooth", 0.15);
  }

  function resetGame() {
    state.level = 1;
    state.score = 0;
    state.hearts = CONFIG.maxHearts;
    state.combo = 0;
    state.pushState = "up";
    state.lastRepTime = 0;
    updateHUD();
    renderHearts();
    spawnCreatures();
    setStatus("Tayyor — push-up qiling!");
    dom.repHint.textContent = "Tayyor";
    dom.depthFill.style.width = "0%";
  }

  // ===================== POSE DETECTION =====================
  let pose = null;
  let cameraStream = null;
  let rafId = null;
  let lastVideoTime = -1;

  function angle(a, b, c) {
    const rad = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let deg = Math.abs((rad * 180) / Math.PI);
    if (deg > 180) deg = 360 - deg;
    return deg;
  }

  function processLandmarks(landmarks) {
    if (!state.running || state.paused) return;

    const ls = landmarks[11];
    const le = landmarks[13];
    const lw = landmarks[15];
    const rs = landmarks[12];
    const re = landmarks[14];
    const rw = landmarks[16];
    const lh = landmarks[23];
    const rh = landmarks[24];

    if (![ls, le, lw, rs, re, rw, lh, rh].every(p => p && p.visibility > 0.5)) {
      setStatus("Tana to'liq ko'rinsin", "warn");
      return;
    }

    const leftAngle = angle(ls, le, lw);
    const rightAngle = angle(rs, re, rw);
    const avgAngle = (leftAngle + rightAngle) / 2;

    const shoulderY = (ls.y + rs.y) / 2;
    const hipY = (lh.y + rh.y) / 2;
    const isStraight = Math.abs(shoulderY - hipY) < CONFIG.bodyStraightThreshold;

    const depth = Math.max(0, Math.min(100, ((180 - avgAngle) / (180 - 70)) * 100));
    dom.depthFill.style.width = depth + "%";

    if (state.pushState === "up") {
      if (avgAngle < CONFIG.downAngle && isStraight) {
        state.pushState = "down";
        dom.repHint.textContent = "Pastga...";
      }
    } else if (state.pushState === "down") {
      if (avgAngle > CONFIG.upAngle) {
        state.pushState = "up";
        registerRep(isStraight);
      }
    }
  }

  function onPoseResults(results) {
    const w = dom.canvas.width;
    const h = dom.canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (results.poseLandmarks) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,107,0,0.85)";
      ctx.fillStyle = "#FF6B00";

      const lm = results.poseLandmarks;
      const drawLine = (i, j) => {
        if (lm[i].visibility < 0.5 || lm[j].visibility < 0.5) return;
        ctx.beginPath();
        ctx.moveTo(lm[i].x * w, lm[i].y * h);
        ctx.lineTo(lm[j].x * w, lm[j].y * h);
        ctx.stroke();
      };

      drawLine(11, 13); drawLine(13, 15);
      drawLine(12, 14); drawLine(14, 16);
      drawLine(11, 12);
      drawLine(11, 23); drawLine(12, 24);
      drawLine(23, 24);

      lm.forEach((p) => {
        if (p.visibility < 0.5) return;
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
        ctx.fill();
      });

      processLandmarks(lm);
    }
  }

  async function initPose() {
    return new Promise((resolve, reject) => {
      try {
        pose = new Pose({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5/${file}`,
        });
        pose.setOptions({
          modelComplexity: CONFIG.modelComplexity,
          smoothLandmarks: true,
          enableSegmentation: false,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6,
          selfieMode: true,
        });
        pose.onResults(onPoseResults);
        state.poseReady = true;
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      cameraStream = stream;
      dom.video.srcObject = stream;
      await dom.video.play();

      const resize = () => {
        dom.canvas.width = dom.video.videoWidth || 640;
        dom.canvas.height = dom.video.videoHeight || 480;
        dom.fx.width = dom.canvas.width;
        dom.fx.height = dom.canvas.height;
      };
      dom.video.addEventListener("loadedmetadata", resize);
      resize();

      state.cameraReady = true;
      return true;
    } catch (err) {
      console.error(err);
      dom.errorText.textContent = "Kameraga ruxsat berilmadi yoki topilmadi.";
      showScreen(dom.overlayError);
      return false;
    }
  }

  function detectionLoop() {
    if (!state.running || state.paused) {
      rafId = requestAnimationFrame(detectionLoop);
      return;
    }
    if (dom.video.readyState >= 2 && pose) {
      const t = dom.video.currentTime;
      if (t !== lastVideoTime) {
        lastVideoTime = t;
        pose.send({ image: dom.video });
      }
    }
    rafId = requestAnimationFrame(detectionLoop);
  }

  // ===================== CONTROLS =====================
  async function beginGame() {
    showScreen(dom.overlayLoading);
    dom.loadingText.textContent = "Kamera va model yuklanmoqda...";

    try {
      if (!state.poseReady) await initPose();
      const ok = await startCamera();
      if (!ok) return;

      showScreen(dom.overlayCalibrate);
      let count = 3;
      dom.calibCountdown.textContent = count;

      await new Promise((res) => {
        const iv = setInterval(() => {
          count--;
          dom.calibCountdown.textContent = count;
          if (count <= 0) {
            clearInterval(iv);
            res();
          }
        }, 900);
      });

      hideAllScreens();
      resetGame();
      state.running = true;
      state.paused = false;
      dom.btnStart.disabled = true;
      dom.btnPause.disabled = false;
      dom.btnRestart.disabled = false;
      detectionLoop();
      setStatus("Push-up qiling!");
    } catch (err) {
      console.error(err);
      dom.errorText.textContent = "Model yuklanmadi. Internetni tekshiring.";
      showScreen(dom.overlayError);
    }
  }

  function pauseGame() {
    if (!state.running) return;
    state.paused = true;
    showScreen(dom.overlayPause);
    dom.btnPause.disabled = true;
  }

  function resumeGame() {
    state.paused = false;
    hideAllScreens();
    dom.btnPause.disabled = false;
    setStatus("Davom eting!");
  }

  function restartGame() {
    hideAllScreens();
    resetGame();
    state.running = true;
    state.paused = false;
    dom.btnStart.disabled = true;
    dom.btnPause.disabled = false;
    if (!rafId) detectionLoop();
  }

  // ===================== EVENTS =====================
  dom.btnBegin.addEventListener("click", beginGame);
  dom.btnStart.addEventListener("click", beginGame);
  dom.btnPause.addEventListener("click", pauseGame);
  dom.btnResume.addEventListener("click", resumeGame);
  dom.btnRestart.addEventListener("click", restartGame);
  dom.btnGameOverRestart.addEventListener("click", () => {
    hideAllScreens();
    beginGame();
  });
  dom.btnErrorRetry.addEventListener("click", beginGame);

  dom.btnSound.addEventListener("click", () => {
    state.soundOn = !state.soundOn;
    dom.btnSound.classList.toggle("muted", !state.soundOn);
    dom.btnSound.textContent = state.soundOn ? "SND" : "OFF";
  });

  // init
  updateHUD();
  renderHearts();
  dom.bestValue.textContent = state.best;

  document.addEventListener("gesturestart", e => e.preventDefault());
})();
