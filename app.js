'use strict';

/* =========================================================
   NanoTreinoCld — app.js
   Estructura: SESIÓN → BLOQUES → TIMERS (concurrentes).
   Flujo de sesión en tres estados:
     1. active  — sesión en curso, bloques y timers operables
     2. review  — "entrenamiento terminado", en revisión, sólo
                  notas finales editables, sin límite de tiempo
     3. closed  — cerrada, se archiva en el historial (máx. 3)
   Todo el estado vive en localStorage. Sin backend, sin login.
   ========================================================= */

const STORAGE_KEY = 'nanotreino:v3';
const MAX_HISTORY = 3;

/* ---------- Utilidades de tiempo ---------- */

function pad2(n) { return String(Math.max(0, Math.floor(n))).padStart(2, '0'); }

function formatClock(totalMs) {
  const totalSec = Math.max(0, Math.round(totalMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

function formatHHMM(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatDateShort(ts) {
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

let uidCounter = 0;
function uid() {
  uidCounter += 1;
  return `${Date.now().toString(36)}-${uidCounter}`;
}

/* ---------- Estado por defecto ---------- */

function createTimer(mode) {
  return {
    id: uid(),
    mode: mode || 'stopwatch', // 'stopwatch' | 'countdown' | 'interval'
    running: false,
    elapsedBeforeAnchor: 0,
    anchor: null,
    countdown: { durationMs: 60000 },
    interval: { warmupMs: 10000, workMs: 40000, restMs: 20000, rounds: 8 },
    laps: [],
    lastAnnouncedKey: null,
    archived: false,
    finishedAt: null
  };
}

function createBlock(n) {
  return {
    n,
    status: 'active', // 'active' | 'paused' | 'finished'
    startedAt: Date.now(),
    finishedAt: null,
    pauses: [], // { start, end }  — end null mientras está abierta
    seriesCount: 0,
    notes: [], // { t, text }
    timers: []
  };
}

function createSession() {
  return {
    startedAt: Date.now(),
    status: 'active', // 'active' | 'review' | 'closed'
    finishedAt: null,
    closedAt: null,
    finalNotes: '',
    blocks: [createBlock(1)]
  };
}

function defaultState() {
  return {
    session: null,
    history: [], // sesiones cerradas, más reciente primero, máx MAX_HISTORY
    settings: { vibration: true }
  };
}

/* ---------- Storage ---------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      settings: { ...base.settings, ...(parsed.settings || {}) }
    };
  } catch (e) {
    console.warn('No se pudo leer la sesión guardada:', e);
    return null;
  }
}

let saveTimeout = null;
function saveStateNow() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('No se pudo guardar la sesión:', e);
  }
}
function saveStateDebounced() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveStateNow, 250);
}

let state = loadState() || defaultState();

/* ---------- Helpers de sesión / bloque activos ---------- */

function currentBlock() {
  if (!state.session) return null;
  const blocks = state.session.blocks;
  return blocks.length ? blocks[blocks.length - 1] : null;
}

function findBlock(n) {
  if (!state.session) return null;
  return state.session.blocks.find(b => b.n === n) || null;
}

function findTimer(blockN, timerId) {
  const b = findBlock(blockN);
  if (!b) return null;
  return b.timers.find(t => t.id === timerId) || null;
}

function anyTimerRunningAnywhere() {
  if (!state.session) return false;
  return state.session.blocks.some(b => b.timers.some(t => t.running));
}

/* ---------- Audio ---------- */

let audioCtx = null;
function primeAudio() {
  if (audioCtx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.01);
  } catch (e) {
    console.warn('Audio no disponible:', e);
  }
}
window.addEventListener('pointerdown', primeAudio, { once: true });

function beep(pattern) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  let t = audioCtx.currentTime + 0.02;
  pattern.forEach(({ freq, dur }) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur / 1000 + 0.02);
    t += dur / 1000 + 0.08;
  });
}

const SOUND_TAP = [{ freq: 720, dur: 40 }];
const SOUND_WARMUP_START = [{ freq: 740, dur: 110 }, { freq: 740, dur: 110 }];
const SOUND_WORK_START = [{ freq: 520, dur: 100 }, { freq: 960, dur: 160 }];
const SOUND_REST_START = [{ freq: 760, dur: 120 }, { freq: 440, dur: 180 }];
const SOUND_FINISH = [{ freq: 660, dur: 140 }, { freq: 990, dur: 220 }];

function vibrate(pattern) {
  if (!state.settings.vibration) return;
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (e) { /* noop */ }
  }
}

function playTap() { beep(SOUND_TAP); }

// Sonido distinto según a qué fase se entra, para que se note claramente
// el cambio (preparación / trabajo / descanso) sin mirar la pantalla.
function alertPhaseChange(phaseType) {
  vibrate(phaseType === 'work' ? [120, 60, 120] : [120]);
  if (phaseType === 'work') beep(SOUND_WORK_START);
  else if (phaseType === 'rest') beep(SOUND_REST_START);
  else beep(SOUND_WARMUP_START);
}
function alertFinish() { beep(SOUND_FINISH); vibrate([150, 90, 150, 90, 300]); }

/* ---------- Wake Lock ---------- */

let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    console.warn('Wake lock no disponible:', e);
  }
}
function releaseWakeLockIfIdle() {
  if (anyTimerRunningAnywhere()) return;
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && anyTimerRunningAnywhere()) {
    acquireWakeLock();
  }
  if (document.visibilityState === 'visible') {
    tick();
  }
  if (document.visibilityState === 'hidden') saveStateNow();
});

/* ---------- Motor de timer (basado en timestamps absolutos) ---------- */

function timerTotalElapsedMs(timer) {
  const running = timer.running && timer.anchor != null;
  return timer.elapsedBeforeAnchor + (running ? (Date.now() - timer.anchor) : 0);
}

function buildIntervalPhases(timer) {
  const cfg = timer.interval;
  const phases = [];
  if (cfg.warmupMs > 0) phases.push({ type: 'warmup', ms: cfg.warmupMs, round: 0 });
  for (let r = 1; r <= cfg.rounds; r++) {
    phases.push({ type: 'work', ms: cfg.workMs, round: r });
    if (cfg.restMs > 0 && r < cfg.rounds) {
      phases.push({ type: 'rest', ms: cfg.restMs, round: r });
    }
  }
  return phases;
}

function resolveIntervalState(timer, totalElapsedMs) {
  const phases = buildIntervalPhases(timer);
  const totalMs = phases.reduce((sum, p) => sum + p.ms, 0);
  if (totalMs === 0) {
    return { finished: true, phaseIndex: -1, phase: null, remainingMs: 0, totalPhases: phases.length };
  }
  if (totalElapsedMs >= totalMs) {
    return { finished: true, phaseIndex: phases.length, phase: null, remainingMs: 0, totalPhases: phases.length, totalMs };
  }
  let acc = 0;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (totalElapsedMs < acc + p.ms) {
      return { finished: false, phaseIndex: i, phase: p, remainingMs: (acc + p.ms) - totalElapsedMs, totalPhases: phases.length, totalMs };
    }
    acc += p.ms;
  }
  return { finished: true, phaseIndex: phases.length, phase: null, remainingMs: 0, totalPhases: phases.length, totalMs };
}

function isTimerAtCompletion(timer) {
  if (timer.running) return false; // sólo tiene sentido cuando está pausado
  const totalElapsed = timer.elapsedBeforeAnchor;
  if (timer.mode === 'countdown') return totalElapsed >= timer.countdown.durationMs;
  if (timer.mode === 'interval') {
    const r = resolveIntervalState(timer, totalElapsed);
    return r.finished && r.totalPhases > 0;
  }
  return false;
}

function startTimerObj(timer) {
  if (timer.archived || timer.running) return;
  if (isTimerAtCompletion(timer)) {
    timer.elapsedBeforeAnchor = 0;
    timer.lastAnnouncedKey = null;
  }
  timer.running = true;
  timer.anchor = Date.now();
  acquireWakeLock();
  saveStateDebounced();
  render();
}

function pauseTimerObj(timer) {
  if (!timer.running) return;
  timer.elapsedBeforeAnchor = timerTotalElapsedMs(timer);
  timer.running = false;
  timer.anchor = null;
  releaseWakeLockIfIdle();
  saveStateDebounced();
}

function resetTimerObj(timer) {
  if (timer.archived) return;
  timer.running = false;
  timer.anchor = null;
  timer.elapsedBeforeAnchor = 0;
  timer.lastAnnouncedKey = null;
  timer.laps = [];
  releaseWakeLockIfIdle();
  saveStateDebounced();
  render();
}

function addLap(timer) {
  if (timer.mode !== 'stopwatch' || timer.archived) return;
  timer.laps.push(timerTotalElapsedMs(timer));
  saveStateDebounced();
  render();
}

/* ---------- Ciclo de vida de bloques ---------- */

function pauseBlock(block) {
  if (!block || block.status !== 'active') return;
  block.pauses.push({ start: Date.now(), end: null });
  block.status = 'paused';
  block.timers.forEach(t => { if (t.running) pauseTimerObj(t); });
  saveStateNow();
  render();
}

function resumeBlock(block) {
  if (!block || block.status !== 'paused') return;
  const open = block.pauses[block.pauses.length - 1];
  if (open && open.end == null) open.end = Date.now();
  block.status = 'active';
  saveStateNow();
  render();
}

function finalizeBlock(block) {
  if (!block || block.status === 'finished') return;
  if (block.status === 'paused') {
    const open = block.pauses[block.pauses.length - 1];
    if (open && open.end == null) open.end = Date.now();
  }
  block.timers.forEach(t => {
    if (t.running) pauseTimerObj(t);
    t.archived = true;
    t.finishedAt = Date.now();
  });
  block.status = 'finished';
  block.finishedAt = Date.now();
  releaseWakeLockIfIdle();
  saveStateNow();
  render();
}

function blockEffectiveMs(block) {
  const end = block.finishedAt || Date.now();
  const span = Math.max(0, end - block.startedAt);
  const pausedMs = block.pauses.reduce((sum, p) => sum + Math.max(0, (p.end || Date.now()) - p.start), 0);
  return Math.max(0, span - pausedMs);
}

function nextBlock() {
  const cur = currentBlock();
  if (!state.session || state.session.status !== 'active') return;
  if (cur && cur.status !== 'finished') return; // hay que finalizar el actual primero
  const n = state.session.blocks.length + 1;
  state.session.blocks.push(createBlock(n));
  saveStateNow();
  render();
  showToast(`Bloque ${n} iniciado`);
}

/* ---------- Ciclo de vida de sesión ---------- */

function archiveSessionToHistory(session) {
  const snapshot = JSON.parse(JSON.stringify(session));
  state.history.unshift(snapshot);
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
}

function iniciarSesion() {
  if (state.session && state.session.status === 'review') {
    // se cierra sola, sin aviso
    state.session.status = 'closed';
    state.session.closedAt = Date.now();
    archiveSessionToHistory(state.session);
  }
  state.session = createSession();
  saveStateNow();
  render();
  showToast('Sesión iniciada — Bloque 1');
}

function terminarEntrenamiento() {
  if (!state.session || state.session.status !== 'active') return;
  const cur = currentBlock();
  if (cur && cur.status !== 'finished') finalizeBlock(cur);
  state.session.finishedAt = Date.now();
  state.session.status = 'review';
  releaseWakeLockIfIdle();
  saveStateNow();
  render();
  showToast('Entrenamiento terminado — revisá y cerrá cuando quieras');
}

function cerrarSesion() {
  if (!state.session || state.session.status !== 'review') return;
  state.session.status = 'closed';
  state.session.closedAt = Date.now();
  archiveSessionToHistory(state.session);
  state.session = null;
  saveStateNow();
  render();
  showToast('Sesión cerrada');
}

/* ---------- Notas ---------- */

function commitBlockNote() {
  const block = currentBlock();
  if (!block || !state.session || state.session.status !== 'active') return;
  const text = el.noteInput.value.trim();
  if (!text) return;
  block.notes.push({ t: Date.now(), text });
  el.noteInput.value = '';
  saveStateNow();
  renderBlocks();
}

function commitFinalNotes() {
  if (!state.session) return;
  state.session.finalNotes = el.finalNoteInput.value;
  saveStateNow();
}

/* ---------- Generar texto de exportación ---------- */

function describeTimer(timer) {
  const unfinished = !timer.archived && (timer.running || timer.elapsedBeforeAnchor > 0 || timer.laps.length > 0);
  const tag = unfinished ? ' [EN CURSO]' : '';
  if (timer.mode === 'stopwatch') {
    const total = timerTotalElapsedMs(timer);
    let line = `Cronómetro: ${formatClock(total)}${tag}`;
    if (timer.laps.length > 0) {
      line += ` — vueltas: ${timer.laps.map(l => formatClock(l)).join(', ')}`;
    }
    return line;
  }
  if (timer.mode === 'countdown') {
    const dur = timer.countdown.durationMs;
    const elapsed = Math.min(dur, timerTotalElapsedMs(timer));
    const completed = isTimerAtCompletion(timer);
    const status = completed ? 'completado' : `interrumpido en ${formatClock(elapsed)}`;
    return `Regresivo (${formatClock(dur)}): ${status}${tag}`;
  }
  if (timer.mode === 'interval') {
    const iv = timer.interval;
    const totalElapsed = timerTotalElapsedMs(timer);
    const r = resolveIntervalState(timer, totalElapsed);
    const cfgStr = `prep ${formatClock(iv.warmupMs)} / trabajo ${formatClock(iv.workMs)} / descanso ${formatClock(iv.restMs)} x${iv.rounds} rondas`;
    let status;
    if (r.finished && r.totalPhases > 0) status = 'completado';
    else if (r.phase) status = `ronda ${r.phase.round}/${iv.rounds}, fase ${r.phase.type}`;
    else status = 'sin iniciar';
    return `Intervalos (${cfgStr}): ${status}${tag}`;
  }
  return '';
}

function describeBlock(block) {
  const lines = [];
  const tag = block.status !== 'finished' ? ' [EN CURSO]' : '';
  lines.push(`BLOQUE ${block.n}${tag}`);
  lines.push(`Duración efectiva: ${formatClock(blockEffectiveMs(block))}`);
  if (block.pauses.length > 0) {
    const pausedMs = block.pauses.reduce((sum, p) => sum + Math.max(0, (p.end || Date.now()) - p.start), 0);
    lines.push(`Pausas: ${block.pauses.length} (${formatClock(pausedMs)})`);
  }
  if (block.timers.length === 0) {
    lines.push('(sin timers registrados)');
  } else {
    block.timers.forEach(t => lines.push(describeTimer(t)));
  }
  lines.push(`Series: ${block.seriesCount}`);
  if (block.notes.length > 0) {
    lines.push('Notas:');
    block.notes.forEach(n => lines.push(`${formatHHMM(n.t)} — ${n.text}`));
  }
  return lines.join('\n');
}

function describeSession(session) {
  const lines = [];
  lines.push(`SESIÓN — ${formatDateShort(session.startedAt)}`);
  lines.push(`Inicio del entrenamiento: ${formatHHMM(session.startedAt)}`);
  lines.push(`Fin del entrenamiento: ${session.finishedAt ? formatHHMM(session.finishedAt) : 'en curso'}`);
  const end = session.finishedAt || Date.now();
  const elapsedMs = Math.max(0, end - session.startedAt);
  const effectiveMs = session.blocks.reduce((sum, b) => sum + blockEffectiveMs(b), 0);
  const pausesMs = Math.max(0, elapsedMs - effectiveMs);
  lines.push(`Tiempo efectivo: ${formatClock(effectiveMs)}`);
  lines.push(`Tiempo transcurrido: ${formatClock(elapsedMs)}`);
  lines.push(`Pausas: ${formatClock(pausesMs)}`);
  lines.push('');
  session.blocks.forEach(b => {
    lines.push(describeBlock(b));
    lines.push('');
  });
  lines.push('NOTAS FINALES DE LA SESIÓN');
  lines.push(session.finalNotes && session.finalNotes.trim() ? session.finalNotes.trim() : '(sin notas finales)');
  return lines.join('\n');
}

function buildSessionText() {
  if (!state.session) return '';
  return describeSession(state.session);
}

/* ---------- Loop de render / tick ---------- */

let tickHandle = null;
function tick() { render(); }
function startTickLoop() {
  if (tickHandle) return;
  tickHandle = setInterval(tick, 250);
}

/* ---------- Render ---------- */

const el = {};

// IDs de timers cuyo panel de "Ajustar" está abierto. Vive solo en memoria
// (no se persiste): hay que consultarlo cada vez que se regenera el HTML
// de los bloques, porque el tick de reloj (cada 250ms) reconstruye todo
// el árbol y, si no se recuerda este estado, el panel se cierra solo.
const openConfigIds = new Set();

function timerCardHtml(block, timer) {
  const total = timerTotalElapsedMs(timer);
  let display = '00:00';
  let phaseLabel = '';
  let roundLabel = '';
  let phaseClass = '';

  if (timer.mode === 'stopwatch') {
    display = formatClock(total);
  } else if (timer.mode === 'countdown') {
    const remaining = timer.countdown.durationMs - total;
    display = formatClock(remaining);
    if (remaining <= 0 && timer.running) {
      const key = 'countdown-finish';
      if (timer.lastAnnouncedKey !== key) {
        timer.lastAnnouncedKey = key;
        alertFinish();
        pauseTimerObj(timer);
        timer.elapsedBeforeAnchor = timer.countdown.durationMs;
        saveStateDebounced();
      }
    }
  } else if (timer.mode === 'interval') {
    const r = resolveIntervalState(timer, total);
    if (r.finished) {
      display = '00:00';
      phaseLabel = r.totalPhases === 0 ? 'Configurá el intervalo' : 'Completado';
      if (timer.running && r.totalPhases > 0) {
        const key = 'interval-finish';
        if (timer.lastAnnouncedKey !== key) {
          timer.lastAnnouncedKey = key;
          alertFinish();
          pauseTimerObj(timer);
          saveStateDebounced();
        }
      }
    } else {
      display = formatClock(r.remainingMs);
      const labels = { warmup: 'Preparación', work: 'Trabajo', rest: 'Descanso' };
      phaseLabel = labels[r.phase.type];
      phaseClass = r.phase.type === 'work' ? 'is-work' : (r.phase.type === 'warmup' ? 'is-warmup' : '');
      roundLabel = r.phase.round > 0 ? `Ronda ${r.phase.round} / ${timer.interval.rounds}` : 'Preparate';
      const key = `phase-${r.phaseIndex}`;
      if (timer.running && timer.lastAnnouncedKey !== key) {
        if (timer.lastAnnouncedKey !== null) alertPhaseChange(r.phase.type);
        timer.lastAnnouncedKey = key;
      }
    }
  }

  const modeLabels = { stopwatch: 'Cronómetro', countdown: 'Regresivo', interval: 'Intervalos' };
  const interactive = block.status !== 'finished' && !timer.archived;
  const cardPhaseClass = timer.mode === 'interval' ? (phaseClass === 'is-work' ? 'phase-work' : (phaseClass === 'is-warmup' ? '' : (roundLabel && phaseLabel === 'Descanso' ? 'phase-rest' : ''))) : '';

  const configOpenClass = openConfigIds.has(timer.id) ? '' : 'hidden';
  let configHtml = '';
  if (timer.mode === 'countdown') {
    const cd = timer.countdown.durationMs;
    configHtml = `
      <div class="timer-config ${configOpenClass}" data-config-for="${timer.id}">
        <div class="time-input-row">
          <div class="time-field"><label>min</label><input type="number" min="0" max="180" value="${Math.floor(cd / 60000)}" data-cfg="cdMin" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}></div>
          <div class="time-field"><label>seg</label><input type="number" min="0" max="59" value="${Math.floor((cd % 60000) / 1000)}" data-cfg="cdSec" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}></div>
        </div>
        <div class="quick-row">
          <button class="chip" data-cd-quick="30" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}>+30s</button>
          <button class="chip" data-cd-quick="60" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}>+1min</button>
          <button class="chip" data-cd-quick="300" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}>+5min</button>
        </div>
      </div>`;
  } else if (timer.mode === 'interval') {
    const iv = timer.interval;
    configHtml = `
      <div class="timer-config ${configOpenClass}" data-config-for="${timer.id}">
        <p class="config-title">Preparación</p>
        <div class="time-input-row">
          <div class="time-field"><label>min</label><input type="number" min="0" max="59" value="${Math.floor(iv.warmupMs / 60000)}" data-cfg="ivWarmMin" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}></div>
          <div class="time-field"><label>seg</label><input type="number" min="0" max="59" value="${Math.floor((iv.warmupMs % 60000) / 1000)}" data-cfg="ivWarmSec" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}></div>
        </div>
        <p class="config-title">Trabajo</p>
        <div class="time-input-row">
          <div class="time-field"><label>min</label><input type="number" min="0" max="59" value="${Math.floor(iv.workMs / 60000)}" data-cfg="ivWorkMin" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}></div>
          <div class="time-field"><label>seg</label><input type="number" min="0" max="59" value="${Math.floor((iv.workMs % 60000) / 1000)}" data-cfg="ivWorkSec" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}></div>
        </div>
        <p class="config-title">Descanso</p>
        <div class="time-input-row">
          <div class="time-field"><label>min</label><input type="number" min="0" max="59" value="${Math.floor(iv.restMs / 60000)}" data-cfg="ivRestMin" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}></div>
          <div class="time-field"><label>seg</label><input type="number" min="0" max="59" value="${Math.floor((iv.restMs % 60000) / 1000)}" data-cfg="ivRestSec" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}></div>
        </div>
        <p class="config-title">Rondas</p>
        <div class="rounds-row">
          <button class="stepper-btn" data-rounds-step="-1" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}>−</button>
          <input type="number" min="1" max="99" value="${iv.rounds}" data-cfg="ivRounds" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}>
          <button class="stepper-btn" data-rounds-step="1" data-timer="${timer.id}" ${interactive ? '' : 'disabled'}>+</button>
        </div>
      </div>`;
  }

  const lapsHtml = (timer.mode === 'stopwatch' && timer.laps.length > 0)
    ? `<div class="laps-list">${timer.laps.map((l, i) => `<span class="lap-chip">V${i + 1} ${formatClock(l)}</span>`).join('')}</div>`
    : '';

  return `
    <div class="timer-card ${cardPhaseClass} ${timer.archived ? 'is-archived' : ''}" data-timer-id="${timer.id}" data-block-n="${block.n}">
      <div class="timer-card-head">
        <span class="timer-mode-tag">${modeLabels[timer.mode]}</span>
        ${interactive ? `<button class="link-btn link-btn-sm" data-action="toggle-config" data-timer="${timer.id}">Ajustar</button>` : ''}
      </div>
      <div class="timer-display-wrap timer-display-wrap-sm">
        ${phaseLabel ? `<div class="phase-label ${phaseClass}">${phaseLabel}</div>` : ''}
        <div class="timer-display timer-display-sm">${display}</div>
        ${roundLabel ? `<div class="round-label">${roundLabel}</div>` : ''}
      </div>
      ${configHtml}
      ${lapsHtml}
      ${interactive ? `
      <div class="timer-controls">
        <button class="btn btn-primary ${timer.running ? 'is-running' : ''}" data-action="toggle-timer" data-timer="${timer.id}">${timer.running ? 'Pausar' : 'Iniciar'}</button>
        ${timer.mode === 'stopwatch' && timer.running ? `<button class="btn btn-secondary" data-action="lap" data-timer="${timer.id}">Vuelta</button>` : ''}
        <button class="btn btn-secondary" data-action="reset-timer" data-timer="${timer.id}">Reset</button>
      </div>` : ''}
    </div>`;
}

function blockCardHtml(block, isCurrent) {
  const statusLabel = { active: 'En curso', paused: 'Pausado', finished: 'Finalizado' }[block.status];
  const interactive = block.status !== 'finished' && state.session.status === 'active';
  const notesHtml = block.notes.length
    ? block.notes.map(n => `<div class="note-item"><span class="note-time">${formatHHMM(n.t)}</span><span class="note-text">${escapeHtml(n.text)}</span></div>`).join('')
    : '<p class="note-empty">Sin notas en este bloque.</p>';

  const addTimerRow = interactive ? `
    <div class="add-timer-row">
      <button class="chip" data-action="add-timer" data-mode="stopwatch" data-block="${block.n}">+ Cronómetro</button>
      <button class="chip" data-action="add-timer" data-mode="countdown" data-block="${block.n}">+ Regresivo</button>
      <button class="chip" data-action="add-timer" data-mode="interval" data-block="${block.n}">+ Intervalos</button>
    </div>` : '';

  const blockActions = interactive ? `
    <div class="block-actions">
      ${block.status === 'active'
        ? `<button class="btn btn-secondary" data-action="pause-block" data-block="${block.n}">Pausar bloque</button>`
        : `<button class="btn btn-secondary" data-action="resume-block" data-block="${block.n}">Reanudar bloque</button>`}
      <button class="btn btn-danger-outline hold-btn hold-btn-sm" data-hold-finalize-block="${block.n}">
        <span class="hold-fill"></span>
        <span class="hold-label">Mantener para finalizar bloque</span>
      </button>
    </div>` : '';

  const seriesHtml = `
    <div class="series-row">
      <span class="series-title">Series</span>
      <div class="series-controls">
        <button class="stepper-btn stepper-lg" data-action="series-minus" data-block="${block.n}" ${interactive ? '' : 'disabled'}>−</button>
        <span class="series-count">${block.seriesCount}</span>
        <button class="stepper-btn stepper-lg" data-action="series-plus" data-block="${block.n}" ${interactive ? '' : 'disabled'}>+</button>
      </div>
    </div>`;

  return `
    <section class="card block-card ${block.status} ${isCurrent ? 'is-current' : ''}" data-block-n="${block.n}">
      <div class="block-head">
        <span class="block-title">Bloque ${block.n}</span>
        <span class="block-status-tag status-${block.status}">${statusLabel}</span>
      </div>
      <div class="block-time">Efectivo: ${formatClock(blockEffectiveMs(block))}${block.pauses.length ? ` · ${block.pauses.length} pausa(s)` : ''}</div>
      <div class="timers-grid">${block.timers.map(t => timerCardHtml(block, t)).join('')}</div>
      ${addTimerRow}
      ${seriesHtml}
      ${blockActions}
      <div class="block-notes">
        <p class="card-title">Notas del bloque</p>
        ${notesHtml}
      </div>
    </section>`;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderBlocks() {
  if (!state.session) return;

  // El tick del reloj llama a render() cada 250ms y reconstruye todo este
  // HTML. Si en ese momento el usuario está escribiendo en un campo de
  // configuración (min/seg/rondas), hay que restaurar el foco y la
  // posición del cursor después de reconstruir, si no, cada tecla que
  // toca se pierde y el campo nunca llega a completarse.
  const active = document.activeElement;
  let focusInfo = null;
  if (active && el.blocksContainer.contains(active) && active.dataset && active.dataset.cfg) {
    focusInfo = {
      timer: active.dataset.timer,
      cfg: active.dataset.cfg,
      value: active.value,
      selStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      selEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
    };
  }

  const blocks = state.session.blocks;
  el.blocksContainer.innerHTML = blocks
    .slice()
    .reverse()
    .map(b => blockCardHtml(b, b.n === blocks.length))
    .join('');
  attachHoldFinalizeHandlers();

  if (focusInfo) {
    const restored = el.blocksContainer.querySelector(`[data-timer="${focusInfo.timer}"][data-cfg="${focusInfo.cfg}"]`);
    if (restored) {
      restored.value = focusInfo.value;
      restored.focus();
      if (focusInfo.selStart != null) {
        try { restored.setSelectionRange(focusInfo.selStart, focusInfo.selEnd); } catch (e) { /* noop */ }
      }
    }
  }
}

function renderSummary() {
  if (!state.session) return;
  const s = state.session;
  const end = s.finishedAt || Date.now();
  const elapsedMs = Math.max(0, end - s.startedAt);
  const effectiveMs = s.blocks.reduce((sum, b) => sum + blockEffectiveMs(b), 0);
  el.sessionStart.textContent = formatHHMM(s.startedAt);
  el.sessionEffective.textContent = formatClock(effectiveMs);
  el.sessionElapsed.textContent = formatClock(elapsedMs);
}

function renderFooterActions() {
  if (!state.session) return;
  const cur = currentBlock();
  const canNext = cur && cur.status === 'finished';
  el.btnNextBlock.classList.toggle('hidden', !canNext);
  el.btnTerminar.classList.toggle('hidden', false);
}

function render() {
  if (!state.session) {
    el.startScreen.classList.remove('hidden');
    el.sessionView.classList.add('hidden');
    renderHistoryList();
    return;
  }
  el.startScreen.classList.add('hidden');
  el.sessionView.classList.remove('hidden');

  const isReview = state.session.status === 'review';
  el.reviewBanner.classList.toggle('hidden', !isReview);
  el.app.classList.toggle('is-review', isReview);
  el.activeFooter.classList.toggle('hidden', isReview);
  el.reviewFooter.classList.toggle('hidden', !isReview);

  renderSummary();
  renderBlocks();
  if (!isReview) renderFooterActions();

  if (isReview) {
    el.finalNoteInput.value = state.session.finalNotes || '';
    el.reviewFinishedAt.textContent = state.session.finishedAt ? formatHHMM(state.session.finishedAt) : '—';
  }
}

function renderHistoryList() {
  if (!el.historyList) return;
  if (state.history.length === 0) {
    el.historyList.innerHTML = '<p class="note-empty">Todavía no hay sesiones cerradas.</p>';
    return;
  }
  el.historyList.innerHTML = state.history.map((s, i) => `
    <div class="history-item">
      <div>
        <p class="history-date">${formatDateShort(s.startedAt)} · ${formatHHMM(s.startedAt)}–${s.finishedAt ? formatHHMM(s.finishedAt) : '?'}</p>
        <p class="history-meta">${s.blocks.length} bloque(s)</p>
      </div>
      <button class="btn btn-secondary" data-action="copy-history" data-idx="${i}">Copiar</button>
    </div>`).join('');
}

/* ---------- Copiar ---------- */

async function copyText(text) {
  el.copyText.value = text;
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (e) {
    copied = false;
  }
  el.copyStatus.textContent = copied
    ? 'Copiado al portapapeles. Ya podés pegarlo en tu proyecto Treino.'
    : 'No se pudo copiar automáticamente. Seleccioná el texto de abajo y copialo manualmente.';
  el.copyOverlay.classList.remove('hidden');
  if (!copied) {
    el.copyText.focus();
    el.copyText.select();
  }
}

/* ---------- Hold-to-confirm genérico ---------- */

function setupHoldToConfirm(button, onComplete) {
  const HOLD_MS = 2000;
  const fillEl = button.querySelector('.hold-fill');
  let holdTimer = null;
  let startTs = null;
  let raf = null;

  function step() {
    const elapsed = Date.now() - startTs;
    const pct = Math.min(100, (elapsed / HOLD_MS) * 100);
    if (fillEl) fillEl.style.width = pct + '%';
    if (pct < 100) raf = requestAnimationFrame(step);
  }
  function start(e) {
    e.preventDefault();
    startTs = Date.now();
    raf = requestAnimationFrame(step);
    holdTimer = setTimeout(() => {
      if (fillEl) fillEl.style.width = '100%';
      cancel();
      onComplete();
    }, HOLD_MS);
  }
  function cancelVisual() {
    if (raf) cancelAnimationFrame(raf);
    if (fillEl) fillEl.style.width = '0%';
  }
  function cancel() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    setTimeout(cancelVisual, 150);
  }
  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', cancel);
  button.addEventListener('pointerleave', cancel);
  button.addEventListener('pointercancel', cancel);
}

function attachHoldFinalizeHandlers() {
  el.blocksContainer.querySelectorAll('[data-hold-finalize-block]').forEach(btn => {
    setupHoldToConfirm(btn, () => {
      const n = parseInt(btn.dataset.holdFinalizeBlock, 10);
      const block = findBlock(n);
      finalizeBlock(block);
      showToast(`Bloque ${n} finalizado`);
    });
  });
}

/* ---------- Toast ---------- */

let toastTimeout = null;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.toast.classList.add('hidden'), 2200);
}

/* ---------- Config helpers ---------- */

function msFromMinSec(minVal, secVal) {
  const m = Math.max(0, parseInt(minVal, 10) || 0);
  const s = Math.max(0, Math.min(59, parseInt(secVal, 10) || 0));
  return (m * 60 + s) * 1000;
}

/* ---------- Delegación de eventos sobre bloques/timers ---------- */

function handleBlocksClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === 'add-timer') {
    const block = findBlock(parseInt(btn.dataset.block, 10));
    if (!block) return;
    block.timers.push(createTimer(btn.dataset.mode));
    saveStateNow();
    renderBlocks();
    return;
  }
  if (action === 'toggle-timer') {
    const card = btn.closest('[data-timer-id]');
    const timer = findTimer(parseInt(card.dataset.blockN, 10), btn.dataset.timer);
    if (!timer) return;
    if (timer.running) pauseTimerObj(timer); else startTimerObj(timer);
    renderBlocks();
    return;
  }
  if (action === 'reset-timer') {
    const card = btn.closest('[data-timer-id]');
    const timer = findTimer(parseInt(card.dataset.blockN, 10), btn.dataset.timer);
    if (timer) resetTimerObj(timer);
    return;
  }
  if (action === 'lap') {
    const card = btn.closest('[data-timer-id]');
    const timer = findTimer(parseInt(card.dataset.blockN, 10), btn.dataset.timer);
    if (timer) addLap(timer);
    return;
  }
  if (action === 'toggle-config') {
    const id = btn.dataset.timer;
    if (openConfigIds.has(id)) openConfigIds.delete(id); else openConfigIds.add(id);
    renderBlocks();
    return;
  }
  if (action === 'pause-block') {
    pauseBlock(findBlock(parseInt(btn.dataset.block, 10)));
    return;
  }
  if (action === 'resume-block') {
    resumeBlock(findBlock(parseInt(btn.dataset.block, 10)));
    return;
  }
  if (action === 'series-plus') {
    const block = findBlock(parseInt(btn.dataset.block, 10));
    if (block) { block.seriesCount++; saveStateDebounced(); renderBlocks(); }
    return;
  }
  if (action === 'series-minus') {
    const block = findBlock(parseInt(btn.dataset.block, 10));
    if (block) { block.seriesCount = Math.max(0, block.seriesCount - 1); saveStateDebounced(); renderBlocks(); }
    return;
  }

  // quick countdown chips por timer
  if (btn.dataset.cdQuick) {
    const card = btn.closest('[data-timer-id]');
    const timer = findTimer(parseInt(card.dataset.blockN, 10), btn.dataset.timer);
    if (!timer) return;
    const extraSec = parseInt(btn.dataset.cdQuick, 10);
    const total = timer.countdown.durationMs + extraSec * 1000;
    timer.countdown.durationMs = Math.max(1000, total);
    saveStateDebounced();
    renderBlocks();
    return;
  }
  if (btn.dataset.roundsStep) {
    const card = btn.closest('[data-timer-id]');
    const timer = findTimer(parseInt(card.dataset.blockN, 10), btn.dataset.timer);
    if (!timer) return;
    const delta = parseInt(btn.dataset.roundsStep, 10);
    timer.interval.rounds = Math.max(1, Math.min(99, timer.interval.rounds + delta));
    saveStateDebounced();
    renderBlocks();
    return;
  }
}

function handleBlocksChange(e) {
  const input = e.target.closest('[data-cfg]');
  if (!input) return;
  const card = input.closest('[data-timer-id]');
  const timer = findTimer(parseInt(card.dataset.blockN, 10), input.dataset.timer);
  if (!timer) return;
  const cfg = input.dataset.cfg;
  if (cfg === 'cdMin' || cfg === 'cdSec') {
    const min = card.querySelector('[data-cfg="cdMin"]').value;
    const sec = card.querySelector('[data-cfg="cdSec"]').value;
    timer.countdown.durationMs = Math.max(1000, msFromMinSec(min, sec));
  } else if (cfg.startsWith('iv')) {
    const iv = timer.interval;
    iv.warmupMs = msFromMinSec(card.querySelector('[data-cfg="ivWarmMin"]').value, card.querySelector('[data-cfg="ivWarmSec"]').value);
    iv.workMs = Math.max(1000, msFromMinSec(card.querySelector('[data-cfg="ivWorkMin"]').value, card.querySelector('[data-cfg="ivWorkSec"]').value));
    iv.restMs = msFromMinSec(card.querySelector('[data-cfg="ivRestMin"]').value, card.querySelector('[data-cfg="ivRestSec"]').value);
    iv.rounds = Math.max(1, Math.min(99, parseInt(card.querySelector('[data-cfg="ivRounds"]').value, 10) || 1));
  }
  saveStateDebounced();
  renderBlocks();
}

/* ---------- Init ---------- */

function init() {
  Object.assign(el, {
    app: document.getElementById('app'),
    startScreen: document.getElementById('startScreen'),
    sessionView: document.getElementById('sessionView'),
    btnStartSession: document.getElementById('btnStartSession'),
    historyList: document.getElementById('historyList'),

    reviewBanner: document.getElementById('reviewBanner'),
    reviewFinishedAt: document.getElementById('reviewFinishedAt'),

    sessionStart: document.getElementById('sessionStart'),
    sessionEffective: document.getElementById('sessionEffective'),
    sessionElapsed: document.getElementById('sessionElapsed'),

    blocksContainer: document.getElementById('blocksContainer'),
    noteInput: document.getElementById('noteInput'),

    activeFooter: document.getElementById('activeFooter'),
    reviewFooter: document.getElementById('reviewFooter'),
    btnNextBlock: document.getElementById('btnNextBlock'),
    btnTerminar: document.getElementById('btnTerminar'),
    btnCopy: document.getElementById('btnCopy'),
    btnCopyReview: document.getElementById('btnCopyReview'),
    btnCerrarSesion: document.getElementById('btnCerrarSesion'),
    btnIniciarDesdeRevision: document.getElementById('btnIniciarDesdeRevision'),
    finalNoteInput: document.getElementById('finalNoteInput'),

    btnSettings: document.getElementById('btnSettings'),
    settingsOverlay: document.getElementById('settingsOverlay'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    toggleVibration: document.getElementById('toggleVibration'),
    copyOverlay: document.getElementById('copyOverlay'),
    btnCloseCopy: document.getElementById('btnCloseCopy'),
    copyStatus: document.getElementById('copyStatus'),
    copyText: document.getElementById('copyText'),
    toast: document.getElementById('toast')
  });

  el.btnStartSession.addEventListener('click', () => iniciarSesion());

  el.blocksContainer.addEventListener('click', handleBlocksClick);
  el.blocksContainer.addEventListener('change', handleBlocksChange);

  el.noteInput.addEventListener('blur', commitBlockNote);
  el.noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitBlockNote();
      el.noteInput.blur();
    }
  });

  el.finalNoteInput.addEventListener('blur', commitFinalNotes);
  el.finalNoteInput.addEventListener('input', () => { saveStateDebounced(); state.session.finalNotes = el.finalNoteInput.value; });

  el.btnNextBlock.addEventListener('click', nextBlock);
  el.btnTerminar.addEventListener('click', terminarEntrenamiento);
  el.btnCerrarSesion.addEventListener('click', cerrarSesion);
  el.btnIniciarDesdeRevision.addEventListener('click', iniciarSesion);

  el.btnCopy.addEventListener('click', () => { commitBlockNote(); copyText(buildSessionText()); });
  el.btnCopyReview.addEventListener('click', () => copyText(buildSessionText()));
  el.btnCloseCopy.addEventListener('click', () => el.copyOverlay.classList.add('hidden'));
  el.copyOverlay.addEventListener('click', (e) => { if (e.target === el.copyOverlay) el.copyOverlay.classList.add('hidden'); });

  el.historyList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="copy-history"]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    const snap = state.history[idx];
    if (snap) copyText(describeSession(snap));
  });

  el.btnSettings.addEventListener('click', () => el.settingsOverlay.classList.remove('hidden'));
  el.btnCloseSettings.addEventListener('click', () => el.settingsOverlay.classList.add('hidden'));
  el.settingsOverlay.addEventListener('click', (e) => { if (e.target === el.settingsOverlay) el.settingsOverlay.classList.add('hidden'); });
  el.toggleVibration.setAttribute('aria-checked', String(state.settings.vibration));
  el.toggleVibration.addEventListener('click', () => {
    state.settings.vibration = !state.settings.vibration;
    el.toggleVibration.setAttribute('aria-checked', String(state.settings.vibration));
    saveStateNow();
    if (state.settings.vibration) vibrate([60]);
  });

  // Sonido corto en cualquier botón de la app (además de las alertas
  // propias de fases/finales de timer, que son más largas y distintas).
  document.addEventListener('click', (e) => {
    if (e.target.closest('button')) playTap();
  });

  render();
  startTickLoop();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('No se pudo registrar el service worker:', err);
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', init);

window.addEventListener('pagehide', saveStateNow);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveStateNow();
});
