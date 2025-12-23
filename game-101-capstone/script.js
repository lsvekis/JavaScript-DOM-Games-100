/**
 * Game 101 — Neon Drift: Survival Sprint
 * DOM-only capstone game.
 *
 * BIG IDEA:
 * - Keep game state in JavaScript (single source of truth).
 * - Use requestAnimationFrame as the game loop.
 * - Render DOM from state (not the other way around).
 * - Keep input separate from logic (input sets "intent").
 * - Persist best score + settings in localStorage.
 * - Support keyboard-only play and ARIA announcements.
 */

/* -----------------------------
   DOM references
------------------------------ */
const el = {
  playfield: document.getElementById('playfield'),
  player: document.getElementById('player'),
  orb: document.getElementById('orb'),
  enemies: document.getElementById('enemies'),

  score: document.getElementById('score'),
  best: document.getElementById('best'),
  level: document.getElementById('level'),
  lives: document.getElementById('lives'),

  srStatus: document.getElementById('srStatus'),

  overlay: document.getElementById('overlay'),
  screenStart: document.getElementById('screenStart'),
  screenHow: document.getElementById('screenHow'),
  screenPause: document.getElementById('screenPause'),
  screenSettings: document.getElementById('screenSettings'),
  screenOver: document.getElementById('screenOver'),

  btnStart: document.getElementById('btnStart'),
  btnHow: document.getElementById('btnHow'),
  btnBackFromHow: document.getElementById('btnBackFromHow'),

  btnPause: document.getElementById('btnPause'),
  btnResume: document.getElementById('btnResume'),
  btnRestart: document.getElementById('btnRestart'),
  btnSettings: document.getElementById('btnSettings'),
  btnBackFromSettings: document.getElementById('btnBackFromSettings'),

  btnPlayAgain: document.getElementById('btnPlayAgain'),
  btnOverSettings: document.getElementById('btnOverSettings'),

  finalScore: document.getElementById('finalScore'),
  newBest: document.getElementById('newBest'),

  toggleSound: document.getElementById('toggleSound'),
  toggleReducedMotion: document.getElementById('toggleReducedMotion'),
  toggleMouseFollow: document.getElementById('toggleMouseFollow'),
};

/* -----------------------------
   Persistence helpers
------------------------------ */
const STORAGE_KEYS = {
  best: 'game101_bestScore',
  settings: 'game101_settings',
};

// Safe JSON parse: avoids crashes if storage is corrupted.
function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* -----------------------------
   Audio (no external files)
   We generate tones using Web Audio API.

   Why this approach?
   - No mp3 files required.
   - Works offline.
   - Simple "beep" feedback.
------------------------------ */
let audioCtx = null;

function ensureAudio() {
  // Creating AudioContext must happen after a user gesture in many browsers.
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

// Short beep with frequency + duration.
function beep(freq = 440, ms = 60, type = 'sine', gain = 0.05) {
  if (!state.settings.sound) return;
  ensureAudio();
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();

  osc.type = type;
  osc.frequency.value = freq;

  // Very short envelope to avoid clicks
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(gain, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);

  osc.connect(g);
  g.connect(audioCtx.destination);

  osc.start(now);
  osc.stop(now + ms / 1000);
}

/* -----------------------------
   State (single source of truth)
------------------------------ */
const state = {
  phase: 'start', // 'start' | 'play' | 'pause' | 'settings' | 'over' | 'how'
  running: false,

  // Playfield dimensions (updated on resize)
  bounds: { w: 0, h: 0 },

  // Player physics
  player: {
    x: 200,
    y: 200,
    vx: 0,
    vy: 0,
    size: 24,
    speed: 0.55,      // acceleration force per frame (scaled by dt)
    maxSpeed: 5.2,    // clamp speed for fairness
    friction: 0.88,   // damping (higher = more slide)
    dash: {
      ready: true,
      cooldownMs: 900,
      burst: 9.0,
      lastDashAt: 0,
    },
  },

  // Orb (collectible)
  orb: {
    x: 320,
    y: 180,
    size: 18,
  },

  // Enemy pool (performance-friendly)
  enemies: [],
  enemyPoolSize: 22, // cap entity count (performance + balance)

  // Spawning and difficulty
  difficulty: {
    level: 1,
    score: 0,
    lives: 3,
    combo: 0,
    best: 0,

    // Spawn pacing: lower means more frequent spawns
    spawnIntervalMs: 950,
    lastSpawnAt: 0,

    // Enemy speed baseline
    enemyBaseSpeed: 1.7,

    // Level-up thresholds
    nextLevelAt: 200, // score target for next level; increases over time
  },

  // Input intent (separate from physics)
  input: {
    up: false,
    down: false,
    left: false,
    right: false,
    dash: false,
    mouseX: 0,
    mouseY: 0,
    hasMouse: false,
  },

  // Settings (persisted)
  settings: {
    sound: true,
    reducedMotion: false,
    mouseFollow: false,
  },

  // Rendering throttles
  ui: {
    lastScoreText: '',
    lastBestText: '',
    lastLevelText: '',
    lastLivesText: '',
  },

  // Time
  time: {
    lastFrame: 0,
    rafId: 0,
  },
};

/* -----------------------------
   Enemy representation
   Each enemy uses JS position and a single DOM element.
------------------------------ */
function createEnemyElement() {
  const div = document.createElement('div');
  div.className = 'enemy';
  el.enemies.appendChild(div);
  return div;
}

function initEnemyPool() {
  el.enemies.innerHTML = '';
  state.enemies = [];
  for (let i = 0; i < state.enemyPoolSize; i++) {
    state.enemies.push({
      active: false,
      x: -999,
      y: -999,
      vx: 0,
      vy: 0,
      size: 18,
      type: 'normal', // 'normal' | 'fast' | 'heavy'
      el: createEnemyElement(),
    });
  }
}

/* -----------------------------
   Utility: clamp and random
------------------------------ */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function distSq(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/* -----------------------------
   Bounds + positioning helpers
------------------------------ */
function updateBounds() {
  const rect = el.playfield.getBoundingClientRect();
  state.bounds.w = rect.width;
  state.bounds.h = rect.height;
}

// Place orb away from player for fairness.
function placeOrb() {
  const margin = 24;
  const { w, h } = state.bounds;
  const p = state.player;
  const minDist = 130;

  let tries = 0;
  while (tries < 50) {
    const x = rand(margin, w - margin);
    const y = rand(margin, h - margin);
    if (distSq(x, y, p.x, p.y) >= minDist * minDist) {
      state.orb.x = x;
      state.orb.y = y;
      return;
    }
    tries++;
  }
  // fallback (rare)
  state.orb.x = clamp(p.x + 150, margin, w - margin);
  state.orb.y = clamp(p.y + 80, margin, h - margin);
}

/* -----------------------------
   Collision (AABB)
   Why AABB?
   - Fast, simple, perfect for DOM rectangles.
------------------------------ */
function aabbCollide(ax, ay, as, bx, by, bs) {
  return !(
    ax + as < bx ||
    ax > bx + bs ||
    ay + as < by ||
    ay > by + bs
  );
}

/* -----------------------------
   Difficulty scaling
   Goal: "fair but harder over time"
------------------------------ */
function scaleDifficultyOnScore() {
  const d = state.difficulty;

  // Level up when reaching threshold.
  if (d.score >= d.nextLevelAt) {
    d.level += 1;
    d.nextLevelAt = Math.floor(d.nextLevelAt * 1.35 + 120);

    // Increase enemy speed slightly
    d.enemyBaseSpeed = Math.min(4.2, d.enemyBaseSpeed + 0.15);

    // Spawn a bit faster (lower interval)
    d.spawnIntervalMs = Math.max(420, d.spawnIntervalMs - 40);

    announce(`Level ${d.level}`);
    beep(660, 90, 'triangle', 0.06);
  }
}

/* -----------------------------
   Enemy spawning
   Uses pool: activate an inactive enemy.
------------------------------ */
function spawnEnemy(now) {
  const d = state.difficulty;
  const { w, h } = state.bounds;
  const margin = 20;

  // Find an inactive enemy
  const enemy = state.enemies.find(e => !e.active);
  if (!enemy) return; // pool full

  // Choose type based on level
  const roll = Math.random();
  let type = 'normal';
  if (d.level >= 4 && roll < 0.25) type = 'fast';
  if (d.level >= 6 && roll > 0.86) type = 'heavy';

  enemy.type = type;

  // Size varies by type (not color-only feedback)
  enemy.size = type === 'heavy' ? 24 : 18;

  // Spawn from a random edge to feel “incoming”
  const edge = Math.floor(rand(0, 4)); // 0 top, 1 right, 2 bottom, 3 left
  if (edge === 0) { enemy.x = rand(margin, w - margin); enemy.y = -margin; }
  if (edge === 1) { enemy.x = w + margin; enemy.y = rand(margin, h - margin); }
  if (edge === 2) { enemy.x = rand(margin, w - margin); enemy.y = h + margin; }
  if (edge === 3) { enemy.x = -margin; enemy.y = rand(margin, h - margin); }

  // Direction: roughly toward player (adds “intent”)
  const p = state.player;
  const dx = p.x - enemy.x;
  const dy = p.y - enemy.y;
  const len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));

  // Speed by type + difficulty
  let speed = d.enemyBaseSpeed + rand(-0.2, 0.2);
  if (type === 'fast') speed *= 1.35;
  if (type === 'heavy') speed *= 0.85;

  enemy.vx = (dx / len) * speed;
  enemy.vy = (dy / len) * speed;

  enemy.active = true;

  // Update DOM class once (not every frame)
  enemy.el.className = 'enemy' + (type === 'fast' ? ' fast' : '') + (type === 'heavy' ? ' heavy' : '');
  d.lastSpawnAt = now;
}

/* -----------------------------
   Input handling (intent)
   - Keyboard sets direction flags
   - Optional mouse-follow sets a target
------------------------------ */
function setKey(e, isDown) {
  const k = e.key.toLowerCase();

  // Pause toggle works globally (except start screen)
  if (k === 'p' && isDown) {
    togglePause();
    return;
  }

  // Only process movement input during play
  if (state.phase !== 'play') return;

  if (k === 'arrowup' || k === 'w') state.input.up = isDown;
  if (k === 'arrowdown' || k === 's') state.input.down = isDown;
  if (k === 'arrowleft' || k === 'a') state.input.left = isDown;
  if (k === 'arrowright' || k === 'd') state.input.right = isDown;

  if (k === ' ' && isDown) state.input.dash = true;
}

document.addEventListener('keydown', (e) => setKey(e, true));
document.addEventListener('keyup', (e) => setKey(e, false));

// Mouse follow (optional)
el.playfield.addEventListener('mousemove', (e) => {
  const rect = el.playfield.getBoundingClientRect();
  state.input.mouseX = e.clientX - rect.left;
  state.input.mouseY = e.clientY - rect.top;
  state.input.hasMouse = true;
});

// Keep keyboard play reliable: focus playfield on click
el.playfield.addEventListener('mousedown', () => el.playfield.focus());

/* -----------------------------
   Overlay / screen control
   Focus management matters for accessibility.
------------------------------ */
function hideAllScreens() {
  el.screenStart.classList.add('hidden');
  el.screenHow.classList.add('hidden');
  el.screenPause.classList.add('hidden');
  el.screenSettings.classList.add('hidden');
  el.screenOver.classList.add('hidden');
}

function showOverlayScreen(name) {
  hideAllScreens();
  el.overlay.classList.remove('hidden');
  el.overlay.setAttribute('aria-hidden', 'false');

  if (name === 'start') el.screenStart.classList.remove('hidden');
  if (name === 'how') el.screenHow.classList.remove('hidden');
  if (name === 'pause') el.screenPause.classList.remove('hidden');
  if (name === 'settings') el.screenSettings.classList.remove('hidden');
  if (name === 'over') el.screenOver.classList.remove('hidden');

  // Lock gameplay input when overlay visible
  state.running = false;

  // Focus the first button on that screen for keyboard users
  const screen = (
    name === 'start' ? el.screenStart :
    name === 'how' ? el.screenHow :
    name === 'pause' ? el.screenPause :
    name === 'settings' ? el.screenSettings :
    el.screenOver
  );

  const firstBtn = screen.querySelector('button, input, summary');
  if (firstBtn) firstBtn.focus();

  // Announce phase change for screen readers
  announce(
    name === 'start' ? 'Start screen' :
    name === 'how' ? 'How it works' :
    name === 'pause' ? 'Paused' :
    name === 'settings' ? 'Settings' :
    'Game over'
  );
}

function hideOverlay() {
  el.overlay.classList.add('hidden');
  el.overlay.setAttribute('aria-hidden', 'true');
  // Return focus to playfield for keyboard play
  el.playfield.focus();
}

/* -----------------------------
   Announcements (screen readers)
------------------------------ */
function announce(text) {
  el.srStatus.textContent = text;
}

/* -----------------------------
   Game lifecycle
------------------------------ */
function resetRunState() {
  const d = state.difficulty;
  const p = state.player;

  d.score = 0;
  d.lives = 3;
  d.combo = 0;
  d.level = 1;
  d.enemyBaseSpeed = 1.7;
  d.spawnIntervalMs = 950;
  d.lastSpawnAt = 0;
  d.nextLevelAt = 200;

  // player centered
  p.x = state.bounds.w / 2;
  p.y = state.bounds.h / 2;
  p.vx = 0;
  p.vy = 0;
  p.dash.ready = true;
  p.dash.lastDashAt = 0;

  // deactivate enemies
  state.enemies.forEach(e => {
    e.active = false;
    e.x = -999;
    e.y = -999;
    e.vx = 0;
    e.vy = 0;
    e.el.style.transform = `translate(-999px, -999px)`;
  });

  placeOrb();
  renderAll(true);
}

function startGame() {
  state.phase = 'play';
  state.running = true;
  hideOverlay();
  resetRunState();
  announce('Game started');
  beep(520, 90, 'sine', 0.06);
  loop(performance.now());
}

function endGame() {
  state.phase = 'over';
  state.running = false;

  // Best score persistence
  const d = state.difficulty;
  const wasNewBest = d.score > d.best;
  if (wasNewBest) {
    d.best = d.score;
    localStorage.setItem(STORAGE_KEYS.best, String(d.best));
  }

  el.finalScore.textContent = String(d.score);
  el.newBest.classList.toggle('hidden', !wasNewBest);

  announce(`Game over. Final score ${d.score}`);
  beep(220, 140, 'sawtooth', 0.05);

  showOverlayScreen('over');
}

function togglePause() {
  if (state.phase === 'play') {
    state.phase = 'pause';
    state.running = false;
    showOverlayScreen('pause');
    beep(300, 70, 'triangle', 0.04);
    return;
  }
  if (state.phase === 'pause') {
    state.phase = 'play';
    state.running = true;
    hideOverlay();
    announce('Resumed');
    beep(520, 70, 'triangle', 0.04);
    loop(performance.now());
  }
}

/* -----------------------------
   Settings persistence + application
------------------------------ */
function loadPersisted() {
  // Best score
  const best = Number(localStorage.getItem(STORAGE_KEYS.best)) || 0;
  state.difficulty.best = best;

  // Settings
  const saved = safeJsonParse(localStorage.getItem(STORAGE_KEYS.settings), null);
  if (saved) {
    state.settings.sound = !!saved.sound;
    state.settings.reducedMotion = !!saved.reducedMotion;
    state.settings.mouseFollow = !!saved.mouseFollow;
  }

  // Apply to UI + body class
  el.toggleSound.checked = state.settings.sound;
  el.toggleReducedMotion.checked = state.settings.reducedMotion;
  el.toggleMouseFollow.checked = state.settings.mouseFollow;

  document.body.classList.toggle('reduced-motion', state.settings.reducedMotion);
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

el.toggleSound.addEventListener('change', () => {
  state.settings.sound = el.toggleSound.checked;
  saveSettings();
  announce(state.settings.sound ? 'Sound on' : 'Sound off');
  beep(620, 50, 'sine', 0.04);
});

el.toggleReducedMotion.addEventListener('change', () => {
  state.settings.reducedMotion = el.toggleReducedMotion.checked;
  document.body.classList.toggle('reduced-motion', state.settings.reducedMotion);
  saveSettings();
  announce(state.settings.reducedMotion ? 'Reduced motion on' : 'Reduced motion off');
});

el.toggleMouseFollow.addEventListener('change', () => {
  state.settings.mouseFollow = el.toggleMouseFollow.checked;
  saveSettings();
  announce(state.settings.mouseFollow ? 'Mouse follow on' : 'Mouse follow off');
});

/* -----------------------------
   Buttons
------------------------------ */
el.btnStart.addEventListener('click', startGame);
el.btnHow.addEventListener('click', () => { state.phase = 'how'; showOverlayScreen('how'); });
el.btnBackFromHow.addEventListener('click', () => { state.phase = 'start'; showOverlayScreen('start'); });

el.btnPause.addEventListener('click', togglePause);
el.btnResume.addEventListener('click', togglePause);
el.btnRestart.addEventListener('click', startGame);

el.btnSettings.addEventListener('click', () => { state.phase = 'settings'; showOverlayScreen('settings'); });
el.btnBackFromSettings.addEventListener('click', () => { state.phase = 'pause'; showOverlayScreen('pause'); });

el.btnPlayAgain.addEventListener('click', startGame);
el.btnOverSettings.addEventListener('click', () => { state.phase = 'settings'; showOverlayScreen('settings'); });

/* -----------------------------
   Game update systems
------------------------------ */
function updatePlayer(dt, now) {
  const p = state.player;
  const i = state.input;

  // If mouse follow is on, convert mouse position into “intent”
  // (still keyboard-playable because toggle is optional)
  let ax = 0;
  let ay = 0;

  if (state.settings.mouseFollow && i.hasMouse) {
    const dx = i.mouseX - p.x;
    const dy = i.mouseY - p.y;

    // Normalize direction into intent-like acceleration
    const len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
    ax = (dx / len) * p.speed;
    ay = (dy / len) * p.speed;
  } else {
    // Keyboard intent
    if (i.left) ax -= p.speed;
    if (i.right) ax += p.speed;
    if (i.up) ay -= p.speed;
    if (i.down) ay += p.speed;
  }

  // Apply acceleration (scaled by dt so different frame rates behave similarly)
  const scale = dt / 16.67; // 16.67ms ~ 60fps baseline
  p.vx += ax * scale;
  p.vy += ay * scale;

  // Dash: short burst, with cooldown
  if (i.dash) {
    i.dash = false; // consume input
    const canDash = (now - p.dash.lastDashAt) >= p.dash.cooldownMs;
    if (canDash) {
      // Dash in current movement direction (or toward mouse if no movement)
      const dx = p.vx || 0.001;
      const dy = p.vy || 0.001;
      const len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
      p.vx = (dx / len) * p.dash.burst;
      p.vy = (dy / len) * p.dash.burst;
      p.dash.lastDashAt = now;
      beep(880, 40, 'square', 0.03);
      announce('Dash');
    } else {
      // Not color-only feedback: audio + announcement
      beep(180, 30, 'sine', 0.02);
      announce('Dash recharging');
    }
  }

  // Apply friction (damping)
  p.vx *= p.friction;
  p.vy *= p.friction;

  // Clamp speed so it stays fair
  p.vx = clamp(p.vx, -p.maxSpeed, p.maxSpeed);
  p.vy = clamp(p.vy, -p.maxSpeed, p.maxSpeed);

  // Move position
  p.x += p.vx * scale;
  p.y += p.vy * scale;

  // Boundary clamp so player stays inside playfield
  const margin = 2;
  p.x = clamp(p.x, margin, state.bounds.w - p.size - margin);
  p.y = clamp(p.y, margin, state.bounds.h - p.size - margin);
}

function updateEnemies(dt) {
  const scale = dt / 16.67;
  const { w, h } = state.bounds;

  for (const e of state.enemies) {
    if (!e.active) continue;

    e.x += e.vx * scale;
    e.y += e.vy * scale;

    // Deactivate if far outside bounds (keeps pool reusable)
    const pad = 60;
    if (e.x < -pad || e.x > w + pad || e.y < -pad || e.y > h + pad) {
      e.active = false;
      e.x = -999;
      e.y = -999;
    }
  }
}

function resolveOrbCollection() {
  const p = state.player;
  const o = state.orb;
  const d = state.difficulty;

  if (aabbCollide(p.x, p.y, p.size, o.x, o.y, o.size)) {
    // Score logic: combo rewards consistent play
    d.combo += 1;
    const gained = 20 + Math.min(30, d.combo * 2);
    d.score += gained;

    // Reposition orb
    placeOrb();

    // Feedback (not color-only)
    beep(740, 60, 'triangle', 0.05);
    announce(`Orb collected. +${gained} points`);
  }
}

function resolveEnemyCollisions() {
  const p = state.player;
  const d = state.difficulty;

  // Minimal collision checks (pool is capped)
  for (const e of state.enemies) {
    if (!e.active) continue;

    if (aabbCollide(p.x, p.y, p.size, e.x, e.y, e.size)) {
      // Hit!
      e.active = false; // remove enemy

      d.lives -= 1;
      d.combo = 0;

      // Feedback: sound + announcement
      beep(160, 110, 'sawtooth', 0.04);
      announce(`Hit! Lives remaining ${d.lives}`);

      // Small knockback for game feel (skipped in reduced motion mode)
      if (!state.settings.reducedMotion) {
        p.vx *= -0.7;
        p.vy *= -0.7;
      }

      if (d.lives <= 0) {
        endGame();
      }
      return; // only handle one hit per frame (prevents “insta-death” chains)
    }
  }
}

function maybeSpawnEnemies(now) {
  const d = state.difficulty;
  if (now - d.lastSpawnAt >= d.spawnIntervalMs) {
    spawnEnemy(now);

    // At higher levels, sometimes spawn a second enemy (controlled chaos)
    if (d.level >= 7 && Math.random() < 0.30) spawnEnemy(now);
    if (d.level >= 10 && Math.random() < 0.18) spawnEnemy(now);
  }
}

/* -----------------------------
   Rendering
   We update DOM transforms (fast) and throttle HUD text updates.
------------------------------ */
function renderAll(force = false) {
  // Player + orb always render (visual core)
  el.player.style.transform = `translate(${state.player.x}px, ${state.player.y}px)`;
  el.orb.style.transform = `translate(${state.orb.x}px, ${state.orb.y}px)`;

  // Enemies render
  for (const e of state.enemies) {
    if (!e.active) {
      // move offscreen (cheaper than removing)
      e.el.style.transform = `translate(-999px, -999px)`;
      continue;
    }
    e.el.style.transform = `translate(${e.x}px, ${e.y}px)`;
  }

  // HUD updates: only update when text actually changes
  const d = state.difficulty;

  const scoreText = String(d.score);
  if (force || scoreText !== state.ui.lastScoreText) {
    el.score.textContent = scoreText;
    state.ui.lastScoreText = scoreText;
  }

  const bestText = String(d.best);
  if (force || bestText !== state.ui.lastBestText) {
    el.best.textContent = bestText;
    state.ui.lastBestText = bestText;
  }

  const levelText = String(d.level);
  if (force || levelText !== state.ui.lastLevelText) {
    el.level.textContent = levelText;
    state.ui.lastLevelText = levelText;
  }

  const livesText = String(d.lives);
  if (force || livesText !== state.ui.lastLivesText) {
    el.lives.textContent = livesText;
    state.ui.lastLivesText = livesText;
  }
}

/* -----------------------------
   Main loop
------------------------------ */
function loop(now) {
  // If we’re not in play, don’t keep spinning the loop
  if (state.phase !== 'play' || !state.running) return;

  const t = state.time;
  const last = t.lastFrame || now;
  const dt = clamp(now - last, 0, 40); // clamp to avoid huge jumps when tab refocuses
  t.lastFrame = now;

  // Systems update
  updatePlayer(dt, now);
  maybeSpawnEnemies(now);
  updateEnemies(dt);
  resolveOrbCollection();
  resolveEnemyCollisions();
  scaleDifficultyOnScore();

  // Render from state
  renderAll(false);

  // Continue loop
  t.rafId = requestAnimationFrame(loop);
}

/* -----------------------------
   Initialization
------------------------------ */
function init() {
  updateBounds();
  initEnemyPool();
  loadPersisted();

  // Render best score at start
  renderAll(true);

  // Start screen visible
  state.phase = 'start';
  showOverlayScreen('start');

  // Resize handling
  window.addEventListener('resize', () => {
    updateBounds();
    placeOrb();
  });

  // Gentle instruction for keyboard users:
  // focus playfield once the game starts (we do in hideOverlay).
  el.playfield.addEventListener('focus', () => {
    // Small SR announcement helps accessibility
    announce('Playfield focused. Use arrow keys or WASD to move.');
  });
}

init();
