/* =========================================================
   Push-Up Game — Logic
   - Counter, timer, start/pause/reset
   - Level system (level up every 20 reps) + progress bar
   - Records, stats, streak — all persisted in localStorage
   - Beep sound (WebAudio) + confetti on level up
   ========================================================= */

(function () {
  "use strict";

  var LEVEL_STEP = 20; // reps needed per level
  var STORE_KEY = "pushup-game-v1";

  /* ----------------- Persistent data ----------------- */
  // Model saved to localStorage
  var data = {
    total: 0,          // lifetime push-ups
    todayCount: 0,     // push-ups done today
    today: "",         // YYYY-MM-DD for todayCount
    bestDay: 0,        // best single-day total ever
    todayRecord: 0,    // best single session today
    allTimeRecord: 0,  // best single session ever
    streak: 0,         // consecutive active days
    lastActiveDate: "",// last day the user did >=1 push-up
    soundOn: true,
  };

  /* ----------------- Session state ----------------- */
  var count = 0;         // current session count
  var running = false;   // timer running?
  var seconds = 0;       // elapsed session seconds
  var timerId = null;
  var audioCtx = null;

  /* ----------------- DOM refs ----------------- */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    heroTotal: $("heroTotal"), heroStreak: $("heroStreak"), heroBest: $("heroBest"),
    level: $("levelValue"), timer: $("timerValue"), count: $("countValue"),
    progressLevel: $("progressLevel"), progressCurrent: $("progressCurrent"),
    progressFill: $("progressFill"), progressAria: $("progressBarAria"),
    pushBtn: $("pushBtn"), startBtn: $("startBtn"), pauseBtn: $("pauseBtn"),
    resetBtn: $("resetBtn"), soundBtn: $("soundBtn"),
    soundOnIcon: $("soundOnIcon"), soundOffIcon: $("soundOffIcon"),
    todayRecord: $("todayRecord"), allTimeRecord: $("allTimeRecord"), streakRecord: $("streakRecord"),
    statToday: $("statToday"), statTotal: $("statTotal"), statBestDay: $("statBestDay"), statStreak: $("statStreak"),
    levelUp: $("levelUp"), levelUpNum: $("levelUpNum"), year: $("year"),
    confetti: $("confetti"),
  };

  /* ----------------- Helpers ----------------- */
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function yesterdayStr() {
    var d = new Date(); d.setDate(d.getDate() - 1);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function levelForCount(c) { return Math.floor(c / LEVEL_STEP) + 1; }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var k in data) { if (saved[k] !== undefined) data[k] = saved[k]; }
      }
    } catch (e) { console.log("[v0] load failed", e); }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
    catch (e) { console.log("[v0] save failed", e); }
  }

  // Roll over the daily counter if the stored day is not today.
  function normalizeDay() {
    var t = todayStr();
    if (data.today !== t) {
      // finalize previous day into bestDay
      if (data.todayCount > data.bestDay) data.bestDay = data.todayCount;
      data.today = t;
      data.todayCount = 0;
      data.todayRecord = 0;
    }
  }

  // Register that the user was active today (for streak calculation).
  function registerActivity() {
    var t = todayStr();
    if (data.lastActiveDate === t) return; // already counted today
    if (data.lastActiveDate === yesterdayStr()) data.streak += 1;
    else data.streak = 1;
    data.lastActiveDate = t;
  }

  /* ----------------- Rendering ----------------- */
  function renderStats() {
    el.heroTotal.textContent = data.total;
    el.heroStreak.textContent = data.streak;
    el.heroBest.textContent = data.bestDay;
    el.todayRecord.textContent = data.todayRecord;
    el.allTimeRecord.textContent = data.allTimeRecord;
    el.streakRecord.innerHTML = data.streak + ' <small>days</small>';
    el.statToday.textContent = data.todayCount;
    el.statTotal.textContent = data.total;
    el.statBestDay.textContent = data.bestDay;
    el.statStreak.textContent = data.streak;
  }

  function renderSession(bump) {
    var lvl = levelForCount(count);
    var within = count % LEVEL_STEP;
    var pct = (within / LEVEL_STEP) * 100;

    el.count.textContent = count;
    el.level.textContent = lvl;
    el.progressLevel.textContent = lvl;
    el.progressCurrent.textContent = within;
    el.progressFill.style.width = pct + "%";
    el.progressAria.setAttribute("aria-valuenow", within);

    if (bump) {
      el.count.classList.remove("bump");
      // force reflow so the animation restarts every rep
      void el.count.offsetWidth;
      el.count.classList.add("bump");
    }
  }

  function renderTimer() {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    el.timer.textContent = pad(m) + ":" + pad(s);
  }

  /* ----------------- Core actions ----------------- */
  function addPushUp() {
    if (!running) start(); // first rep auto-starts the session/timer

    var prevLevel = levelForCount(count);
    count += 1;
    data.total += 1;

    normalizeDay();
    data.todayCount += 1;
    registerActivity();

    // records
    if (count > data.todayRecord) data.todayRecord = count;
    if (count > data.allTimeRecord) data.allTimeRecord = count;
    if (data.todayCount > data.bestDay) data.bestDay = data.todayCount;

    var newLevel = levelForCount(count);
    renderSession(true);
    renderStats();
    save();
    beep(660, 0.05);

    if (newLevel > prevLevel) levelUp(newLevel);
  }

  function start() {
    if (running) return;
    running = true;
    el.startBtn.disabled = true;
    el.pauseBtn.disabled = false;
    timerId = setInterval(function () {
      seconds += 1;
      renderTimer();
    }, 1000);
  }

  function pause() {
    if (!running) return;
    running = false;
    el.startBtn.disabled = false;
    el.pauseBtn.disabled = true;
    clearInterval(timerId);
  }

  function reset() {
    pause();
    count = 0;
    seconds = 0;
    renderSession(false);
    renderTimer();
    el.startBtn.disabled = false;
  }

  /* ----------------- Level up: animation + confetti ----------------- */
  function levelUp(newLevel) {
    el.levelUpNum.textContent = newLevel;
    el.levelUp.classList.add("show");
    beep(880, 0.12);
    setTimeout(function () { beep(1046, 0.14); }, 130);
    fireConfetti();
    setTimeout(function () { el.levelUp.classList.remove("show"); }, 1600);
  }

  /* ----------------- Sound (WebAudio beep) ----------------- */
  function beep(freq, dur) {
    if (!data.soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur + 0.02);
    } catch (e) { /* audio not available */ }
  }

  function toggleSound() {
    data.soundOn = !data.soundOn;
    el.soundBtn.setAttribute("aria-pressed", String(data.soundOn));
    el.soundOnIcon.style.display = data.soundOn ? "" : "none";
    el.soundOffIcon.style.display = data.soundOn ? "none" : "";
    save();
    if (data.soundOn) beep(660, 0.05);
  }

  /* ----------------- Confetti (canvas) ----------------- */
  var confettiCtx, confettiPieces = [], confettiRaf = null;
  function fireConfetti() {
    var canvas = el.confetti;
    canvas.classList.add("show");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    confettiCtx = canvas.getContext("2d");

    var colors = ["#FF6B00", "#FF8C3A", "#FFFFFF", "#A0AEC0", "#FFB877"];
    confettiPieces = [];
    for (var i = 0; i < 160; i++) {
      confettiPieces.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 220,
        y: canvas.height / 2 + (Math.random() - 0.5) * 60,
        vx: (Math.random() - 0.5) * 14,
        vy: Math.random() * -15 - 4,
        size: Math.random() * 8 + 4,
        color: colors[(Math.random() * colors.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        life: 0,
      });
    }
    if (confettiRaf) cancelAnimationFrame(confettiRaf);
    animateConfetti();
  }

  function animateConfetti() {
    var canvas = el.confetti;
    confettiCtx.clearRect(0, 0, canvas.width, canvas.height);
    var alive = false;
    for (var i = 0; i < confettiPieces.length; i++) {
      var p = confettiPieces[i];
      p.life += 1;
      p.vy += 0.35;       // gravity
      p.vx *= 0.99;       // drag
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y < canvas.height + 20 && p.life < 200) alive = true;
      confettiCtx.save();
      confettiCtx.translate(p.x, p.y);
      confettiCtx.rotate(p.rot);
      confettiCtx.fillStyle = p.color;
      confettiCtx.globalAlpha = Math.max(0, 1 - p.life / 180);
      confettiCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      confettiCtx.restore();
    }
    if (alive) {
      confettiRaf = requestAnimationFrame(animateConfetti);
    } else {
      confettiCtx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.classList.remove("show");
    }
  }

  /* ----------------- Events ----------------- */
  el.pushBtn.addEventListener("click", function () {
    addPushUp();
    el.pushBtn.classList.add("pressed");
    setTimeout(function () { el.pushBtn.classList.remove("pressed"); }, 120);
  });
  el.startBtn.addEventListener("click", start);
  el.pauseBtn.addEventListener("click", pause);
  el.resetBtn.addEventListener("click", reset);
  el.soundBtn.addEventListener("click", toggleSound);

  // Space bar = one push-up (ignore when typing / when repeating)
  document.addEventListener("keydown", function (e) {
    if (e.code === "Space" || e.key === " ") {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.repeat) return;
      e.preventDefault();
      addPushUp();
      el.pushBtn.classList.add("pressed");
      setTimeout(function () { el.pushBtn.classList.remove("pressed"); }, 120);
    }
  });

  window.addEventListener("resize", function () {
    if (el.confetti.classList.contains("show")) {
      el.confetti.width = window.innerWidth;
      el.confetti.height = window.innerHeight;
    }
  });

  /* ----------------- Init ----------------- */
  function init() {
    load();
    normalizeDay();
    // if streak's last active day is older than yesterday, it's broken
    if (data.lastActiveDate && data.lastActiveDate !== todayStr() && data.lastActiveDate !== yesterdayStr()) {
      data.streak = 0;
    }
    // reflect saved sound state
    el.soundBtn.setAttribute("aria-pressed", String(data.soundOn));
    el.soundOnIcon.style.display = data.soundOn ? "" : "none";
    el.soundOffIcon.style.display = data.soundOn ? "none" : "";

    el.year.textContent = new Date().getFullYear();
    el.pauseBtn.disabled = true;

    renderSession(false);
    renderTimer();
    renderStats();
    save();
  }

  init();
})();
