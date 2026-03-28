// ============================================================
// content.js — CogniSense Content Script
// Injected into every page. Collects: keyboard, mouse, scroll,
// page-content signals, and injects the floating HUD.
// ============================================================

// Guard: prevent double-injection
if (window.__cogniSenseInjected) {
  throw new Error('[CogniSense] Already injected.');
}
window.__cogniSenseInjected = true;

// ----------------------------------------------------------------
// SAFE RUNTIME BRIDGE
// Prevents "Extension context invalidated" crashes after an extension
// reload/disable while old content scripts are still alive in open tabs.
// ----------------------------------------------------------------
let _contextAlive = true;
const _intervalIds = [];

/** Remove HUD from DOM and kill all intervals. Called on extension disable or reload. */
function teardown() {
  if (!_contextAlive) return; // already torn down
  _contextAlive = false;
  _intervalIds.forEach(clearInterval);
  // Remove the injected HUD element immediately so it doesn't linger
  const hudRoot = document.getElementById('__cogni-sense-hud-root__');
  if (hudRoot) hudRoot.remove();
  // Clear the injection guard so a fresh content script can inject after re-enable
  delete window.__cogniSenseInjected;
}

function safeSendMessage(msg, callback) {
  if (!_contextAlive) return;
  if (!chrome.runtime?.id) { teardown(); return; }
  try {
    const p = chrome.runtime.sendMessage(msg, callback);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    teardown();
  }
}

function safeInterval(fn, ms) {
  const id = setInterval(() => {
    if (!_contextAlive) { clearInterval(id); return; }
    fn();
  }, ms);
  _intervalIds.push(id);
  return id;
}

// ================================================================
// EXTENSION LIFECYCLE
//
// WHY NOT chrome.runtime.connect?
// In MV3, Chrome terminates the service worker after ~30s of idle.
// A port opened to the SW via connect() fires onDisconnect EVERY
// TIME the SW sleeps — not just when the extension is disabled.
// Using connect() for teardown detection causes false positives
// that remove the HUD while the extension is still active.
//
// CORRECT APPROACH:
// 1. Poll chrome.runtime.id every second (it becomes undefined only
//    when the extension is truly disabled, not when SW sleeps).
// 2. Listen for an explicit FORCE_TEARDOWN message broadcast by
//    the background when the user clicks "Stop Monitoring".
// ================================================================

// 1-second context watcher: detects real extension disable
;(function startContextWatcher() {
  const watcherId = setInterval(() => {
    if (!_contextAlive) { clearInterval(watcherId); return; }
    if (!chrome.runtime?.id) teardown();
  }, 1000);
})();

// Top-level FORCE_TEARDOWN listener (works even before HUD is injected)
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'FORCE_TEARDOWN') teardown();
    return false;
  });
} catch (_) {}

// ----------------------------------------------------------------
// THROTTLE UTILITY
// ----------------------------------------------------------------
function throttle(fn, delay) {
  let lastCall = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      fn.apply(this, args);
    }
  };
}

// ----------------------------------------------------------------
// STREAM A — KEYBOARD
// ----------------------------------------------------------------
const kb = {
  keydown_count: 0,
  backspace_count: 0,
  pause_count: 0,
  pause_detected: false,
  last_key_time: null,
  inter_key_delays: [],
  recent_keydowns: [], // timestamps for rolling WPM
};

document.addEventListener('keydown', (e) => {
  const now = Date.now();

  if (e.key === 'Backspace') kb.backspace_count++;

  if (kb.last_key_time !== null) {
    const delay = now - kb.last_key_time;
    if (delay > 2000) {
      kb.pause_detected = true;
      kb.pause_count++;
    }
    kb.inter_key_delays.push(delay);
  }

  kb.keydown_count++;
  kb.recent_keydowns.push(now);
  kb.last_key_time = now;
}, { passive: true });

safeInterval(() => {
  const now = Date.now();

  // Rolling 60s keydowns for WPM
  kb.recent_keydowns = kb.recent_keydowns.filter(t => now - t >= now - 60000);
  // WPM ≈ keydowns in 60s / 5  (avg word ≈ 5 chars)
  const wpm_estimate = Math.round(kb.recent_keydowns.length / 5);

  const error_rate = kb.keydown_count > 0
    ? parseFloat((kb.backspace_count / kb.keydown_count).toFixed(3))
    : 0;

  const inter_key_delay_ms_avg = kb.inter_key_delays.length > 0
    ? Math.round(kb.inter_key_delays.reduce((a, b) => a + b, 0) / kb.inter_key_delays.length)
    : 0;

  const burst_typing = wpm_estimate > 60;

  safeSendMessage({
    type: 'KEYBOARD_BATCH',
    data: {
      wpm_estimate,
      inter_key_delay_ms_avg,
      error_rate,
      pause_detected: kb.pause_detected,
      pause_count: kb.pause_count,
      burst_typing,
      keydown_count: kb.keydown_count
    }
  });

  // Reset per-window counters (keep recent_keydowns for rolling WPM)
  kb.backspace_count = 0;
  kb.pause_detected = false;
  kb.pause_count = 0;
  kb.inter_key_delays = [];
}, 5000);

// ----------------------------------------------------------------
// STREAM B — MOUSE
// ----------------------------------------------------------------
const mouse = {
  last_x: null,
  last_y: null,
  last_move_time: null,
  last_mousemove_time: Date.now(),
  speed_samples: [],
  click_count: 0,
  click_timestamps: [],
};

document.addEventListener('mousemove', throttle((e) => {
  const now = Date.now();
  mouse.last_mousemove_time = now;

  if (mouse.last_x !== null && mouse.last_move_time !== null) {
    const dx = e.clientX - mouse.last_x;
    const dy = e.clientY - mouse.last_y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const dt = (now - mouse.last_move_time) / 1000;
    if (dt > 0) mouse.speed_samples.push(distance / dt);
  }

  mouse.last_x = e.clientX;
  mouse.last_y = e.clientY;
  mouse.last_move_time = now;
}, 50), { passive: true });

document.addEventListener('click', () => {
  const now = Date.now();
  mouse.click_count++;
  mouse.click_timestamps.push(now);
}, { passive: true });

safeInterval(() => {
  const now = Date.now();
  const samples = mouse.speed_samples;

  const speed_avg = samples.length > 0
    ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
    : 0;

  let acceleration_variance = 0;
  if (samples.length > 1) {
    const variance = samples.reduce((acc, s) => acc + (s - speed_avg) ** 2, 0) / samples.length;
    acceleration_variance = Math.round(variance);
  }

  const cursor_idle_ms = now - mouse.last_mousemove_time;
  const click_rate_per_min = mouse.click_count * 12; // extrapolate 5s → 60s

  const clickIntervals = [];
  for (let i = 1; i < mouse.click_timestamps.length; i++) {
    clickIntervals.push(mouse.click_timestamps[i] - mouse.click_timestamps[i - 1]);
  }
  const click_interval_ms_avg = clickIntervals.length > 0
    ? Math.round(clickIntervals.reduce((a, b) => a + b, 0) / clickIntervals.length)
    : 0;

  safeSendMessage({
    type: 'MOUSE_BATCH',
    data: { speed_avg, acceleration_variance, cursor_idle_ms, click_rate_per_min, click_interval_ms_avg }
  });

  // Reset
  mouse.speed_samples = [];
  mouse.click_count = 0;
  mouse.click_timestamps = [];
}, 5000);

// ----------------------------------------------------------------
// STREAM C — SCROLL
// ----------------------------------------------------------------
const scrl = {
  last_scrollY: window.scrollY,
  last_scroll_time: Date.now(),
  last_direction: 0,
  direction_changes: 0,
  velocity_samples: [],
};

document.addEventListener('scroll', throttle(() => {
  const now = Date.now();
  const currentScrollY = window.scrollY;
  const dt = (now - scrl.last_scroll_time) / 1000;
  const delta = currentScrollY - scrl.last_scrollY;

  if (dt > 0 && delta !== 0) {
    scrl.velocity_samples.push(Math.abs(delta) / dt);
    const direction = delta > 0 ? 1 : -1;
    if (scrl.last_direction !== 0 && direction !== scrl.last_direction) {
      scrl.direction_changes++;
    }
    scrl.last_direction = direction;
  }

  scrl.last_scrollY = currentScrollY;
  scrl.last_scroll_time = now;
}, 100), { passive: true });

safeInterval(() => {
  const bodyHeight = document.body.scrollHeight;
  const depth_pct = bodyHeight > 0
    ? Math.round((window.scrollY / bodyHeight) * 100)
    : 0;

  const velocity_avg = scrl.velocity_samples.length > 0
    ? Math.round(scrl.velocity_samples.reduce((a, b) => a + b, 0) / scrl.velocity_samples.length)
    : 0;

  safeSendMessage({
    type: 'SCROLL_BATCH',
    data: { depth_pct, velocity_avg, direction_changes: scrl.direction_changes }
  });

  scrl.velocity_samples = [];
  scrl.direction_changes = 0;
}, 5000);

// ----------------------------------------------------------------
// STREAM D — PAGE CONTENT
// ----------------------------------------------------------------
const pg = {
  form_active: false,
  video_playing: false,
  video_watch_duration_s: 0,
  last_video_check: Date.now(),
  // Engagement counters (reset every 5s)
  keydown_count: 0,
  click_count: 0,
  scroll_event_count: 0,
};

// Form focus tracking
function attachFormListeners() {
  document.querySelectorAll('input, textarea').forEach(el => {
    if (el.__cogniSenseAttached) return;
    el.__cogniSenseAttached = true;
    el.addEventListener('focus', () => { pg.form_active = true; }, { passive: true });
    el.addEventListener('blur', () => { pg.form_active = false; }, { passive: true });
  });
}
attachFormListeners();

// Re-attach when DOM changes (SPAs with dynamic forms)
const formObserver = new MutationObserver(throttle(attachFormListeners, 1000));
if (document.body) {
  formObserver.observe(document.body, { childList: true, subtree: true });
}

// Engagement event counters
document.addEventListener('keydown', () => { pg.keydown_count++; }, { passive: true });
document.addEventListener('click', () => { pg.click_count++; }, { passive: true });
document.addEventListener('scroll', () => { pg.scroll_event_count++; }, { passive: true });

// Page visibility
document.addEventListener('visibilitychange', () => {
  safeSendMessage({ type: document.hidden ? 'PAGE_HIDDEN' : 'PAGE_VISIBLE' });
});

function checkVideos() {
  const now = Date.now();
  const videos = document.querySelectorAll('video');
  let anyPlaying = false;
  videos.forEach(v => { if (!v.paused) anyPlaying = true; });

  const dt = (now - pg.last_video_check) / 1000;
  if (pg.video_playing && anyPlaying) pg.video_watch_duration_s += dt;

  pg.video_playing = anyPlaying;
  pg.last_video_check = now;
}

safeInterval(() => {
  checkVideos();

  const engagement_score =
    (pg.keydown_count * 2) + (pg.click_count * 3) + (pg.scroll_event_count * 1);

  safeSendMessage({
    type: 'PAGE_BATCH',
    data: {
      form_active: pg.form_active,
      video_playing: pg.video_playing,
      video_watch_duration_s: Math.round(pg.video_watch_duration_s),
      engagement_score
    }
  });

  // Reset engagement counters
  pg.keydown_count = 0;
  pg.click_count = 0;
  pg.scroll_event_count = 0;
}, 5000);

// ----------------------------------------------------------------
// FLOATING HUD — SHADOW DOM INJECTION
// ----------------------------------------------------------------
function injectFloatingHUD() {
  // Skip extension pages and about: pages
  const proto = window.location.protocol;
  if (proto === 'chrome-extension:' || proto === 'chrome:' || proto === 'about:') return;
  if (document.getElementById('__cogni-sense-hud-root__')) return;

  const hostEl = document.createElement('div');
  hostEl.id = '__cogni-sense-hud-root__';
  // Must be in body for fixed positioning to work
  document.body.appendChild(hostEl);

  const shadow = hostEl.attachShadow({ mode: 'open' });

  // ----- CSS -----
  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    #cogni-hud {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      user-select: none;
    }

    #cogni-card {
      background: rgba(10, 10, 20, 0.88);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 18px;
      padding: 14px 16px;
      min-width: 228px;
      max-width: 260px;
      box-shadow:
        0 12px 40px rgba(0, 0, 0, 0.5),
        0 2px 8px rgba(0, 0, 0, 0.3),
        inset 0 1px 0 rgba(255, 255, 255, 0.05);
      color: #dde0f0;
      opacity: 0.65;
      transition: opacity 0.25s ease, transform 0.3s cubic-bezier(.4,0,.2,1), min-width 0.3s ease, border-radius 0.3s ease;
      cursor: default;
    }

    #cogni-card:hover { opacity: 1; }

    /* COLLAPSED STATE */
    #cogni-card.collapsed {
      min-width: 0;
      width: 44px;
      height: 44px;
      padding: 0;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      overflow: hidden;
    }
    #cogni-card.collapsed .cogni-header,
    #cogni-card.collapsed .cogni-status-row,
    #cogni-card.collapsed .cogni-divider,
    #cogni-card.collapsed .cogni-info,
    #cogni-card.collapsed .cogni-badge,
    #cogni-card.collapsed .cogni-footer,
    #cogni-card.collapsed .cogni-offline-msg {
      display: none !important;
    }
    #cogni-card.collapsed .cogni-collapsed-dot { display: block !important; }

    /* HEADER */
    .cogni-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 11px;
    }
    .cogni-title-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cogni-logo {
      width: 22px; height: 22px;
      border-radius: 7px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      display: flex; align-items: center; justify-content: center;
      font-size: 11px;
      box-shadow: 0 0 10px rgba(99, 102, 241, 0.4);
    }
    .cogni-title {
      font-size: 11px;
      font-weight: 600;
      color: #7c7ca8;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .cogni-collapse-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: #4a4a70;
      width: 22px; height: 22px;
      border-radius: 6px;
      font-size: 16px;
      line-height: 1;
      display: flex; align-items: center; justify-content: center;
      transition: color 0.15s, background 0.15s;
    }
    .cogni-collapse-btn:hover { color: #a0a0c8; background: rgba(255,255,255,0.06); }

    /* STATUS ROW */
    .cogni-status-row {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 6px;
    }
    .cogni-dot {
      width: 9px; height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
      position: relative;
    }
    .cogni-dot::after {
      content: '';
      position: absolute;
      inset: -3px;
      border-radius: 50%;
      animation: cogni-pulse 2.2s ease-in-out infinite;
    }
    .cogni-dot.active  { background: #22c55e; }
    .cogni-dot.active::after  { background: rgba(34,197,94,0.25); }
    .cogni-dot.offline { background: #ef4444; }
    .cogni-dot.offline::after { animation: none; background: rgba(239,68,68,0.2); }
    .cogni-dot.idle    { background: #f59e0b; }
    .cogni-dot.idle::after    { background: rgba(245,158,11,0.25); animation-duration: 3s; }

    @keyframes cogni-pulse {
      0%, 100% { opacity: 0.15; transform: scale(1); }
      50%       { opacity: 0.55; transform: scale(2); }
    }

    .cogni-status-text  { font-size: 13px; font-weight: 500; color: #dde0f0; }
    .cogni-offline-msg  { font-size: 11px; color: #f87171; margin-bottom: 6px; margin-left: 18px; }

    /* COLLAPSED DOT */
    .cogni-collapsed-dot {
      display: none;
      width: 14px; height: 14px;
      border-radius: 50%;
    }
    .cogni-collapsed-dot.active  { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,0.7); }
    .cogni-collapsed-dot.offline { background: #ef4444; box-shadow: 0 0 8px rgba(239,68,68,0.7); }
    .cogni-collapsed-dot.idle    { background: #f59e0b; box-shadow: 0 0 8px rgba(245,158,11,0.7); }

    /* DIVIDER */
    .cogni-divider { height: 1px; background: rgba(255,255,255,0.05); margin: 9px 0; }

    /* INFO GRID */
    .cogni-info { display: flex; flex-direction: column; gap: 5px; }
    .cogni-info-row { display: flex; justify-content: space-between; align-items: center; }
    .cogni-info-label { font-size: 11px; color: #4a4a70; }
    .cogni-info-value { font-size: 11px; color: #8888b0; font-variant-numeric: tabular-nums; }

    /* COGNITIVE STATE BADGE */
    .cogni-badge {
      margin-top: 10px;
      padding: 7px 12px;
      background: linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.15));
      border: 1px solid rgba(139,92,246,0.3);
      border-radius: 10px;
      text-align: center;
      font-size: 12px;
      font-weight: 600;
      color: #a78bfa;
      letter-spacing: 0.04em;
      text-transform: capitalize;
      animation: cogni-badge-glow 3s ease-in-out infinite alternate;
    }
    @keyframes cogni-badge-glow {
      from { box-shadow: 0 0 0px rgba(139,92,246,0); }
      to   { box-shadow: 0 0 12px rgba(139,92,246,0.25); }
    }

    /* FOOTER */
    .cogni-footer { margin-top: 10px; }
    .cogni-btn {
      width: 100%;
      padding: 6px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 9px;
      color: #6060a0;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
      font-family: inherit;
      text-align: center;
    }
    .cogni-btn:hover { background: rgba(255,255,255,0.09); color: #c0c0e0; border-color: rgba(255,255,255,0.12); }
    .cogni-btn.pause-active { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.25); color: #f87171; }
    .cogni-btn.pause-active:hover { background: rgba(239,68,68,0.2); }

    /* STOP button */
    .cogni-stop-btn { flex: 0 0 28px !important; padding: 0 !important; font-size: 13px; }
    .cogni-stop-btn:hover { background: rgba(239,68,68,0.15) !important; border-color: rgba(239,68,68,0.3) !important; }

    /* SETTINGS icon button */
    .cogni-icon-btn { flex: 0 0 28px !important; padding: 0 !important; font-size: 13px; }

    /* PAUSED state */
    .cogni-dot.paused { background: #6b7280; }
    .cogni-dot.paused::after { background: rgba(107,114,128,0.2); animation: none; }
    .cogni-collapsed-dot.paused { background: #6b7280; box-shadow: 0 0 6px rgba(107,114,128,0.5); }

    /* Three-button footer: [---Pause---][Stop][⚙] */
    .cogni-footer { margin-top: 10px; display: flex; gap: 5px; }
    .cogni-footer .cogni-btn { width: auto; flex: 1; }
  `;
  shadow.appendChild(style);

  // ----- HTML -----
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="cogni-hud">
      <div id="cogni-card">
        <!-- Collapsed pill view -->
        <div class="cogni-collapsed-dot active" id="cogni-collapsed-dot"></div>

        <!-- Header -->
        <div class="cogni-header">
          <div class="cogni-title-group">
            <div class="cogni-logo">🧠</div>
            <span class="cogni-title">CogniSense</span>
          </div>
          <button class="cogni-collapse-btn" id="cogni-collapse-btn" title="Minimize">−</button>
        </div>

        <!-- Status -->
        <div class="cogni-status-row">
          <div class="cogni-dot active" id="cogni-dot"></div>
          <span class="cogni-status-text" id="cogni-status-text">Monitoring Active</span>
        </div>
        <div class="cogni-offline-msg" id="cogni-offline-msg" style="display:none"></div>

        <div class="cogni-divider"></div>

        <!-- Info rows -->
        <div class="cogni-info">
          <div class="cogni-info-row">
            <span class="cogni-info-label">Session</span>
            <span class="cogni-info-value" id="cogni-session">—</span>
          </div>
          <div class="cogni-info-row">
            <span class="cogni-info-label">Last sync</span>
            <span class="cogni-info-value" id="cogni-sync">—</span>
          </div>
        </div>

        <!-- Cognitive state badge (shown only when backend returns state) -->
        <div class="cogni-badge" id="cogni-badge" style="display:none"></div>

        <!-- Footer: [Pause] [Stop] [⚙] -->
        <div class="cogni-footer">
          <button class="cogni-btn" id="cogni-pause-btn">⏸ Pause</button>
          <button class="cogni-btn cogni-stop-btn" id="cogni-stop-btn" title="Stop monitoring &amp; remove HUD from all tabs">⛔</button>
          <button class="cogni-btn cogni-icon-btn" id="cogni-settings-btn" title="Settings">⚙</button>
        </div>
      </div>
    </div>
  `;
  shadow.appendChild(wrap);

  // ----- BEHAVIOUR -----
  const card = shadow.getElementById('cogni-card');
  const collapseBtn = shadow.getElementById('cogni-collapse-btn');
  let collapsed = false;

  collapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    collapsed = true;
    card.classList.add('collapsed');
  });

  card.addEventListener('click', () => {
    if (collapsed) {
      collapsed = false;
      card.classList.remove('collapsed');
    }
  });

  shadow.getElementById('cogni-pause-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    safeSendMessage({ type: 'TOGGLE_PAUSE' }, (resp) => {
      if (resp) {
        const btn = shadow.getElementById('cogni-pause-btn');
        if (resp.paused) {
          btn.textContent = '▶ Resume';
          btn.classList.add('pause-active');
        } else {
          btn.textContent = '⏸ Pause';
          btn.classList.remove('pause-active');
        }
      }
    });
  });

  shadow.getElementById('cogni-stop-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    // Background will broadcast FORCE_TEARDOWN to ALL tabs, removing every HUD
    safeSendMessage({ type: 'DISABLE_MONITORING' });
    // Optimistically teardown this tab immediately (won't wait for broadcast)
    setTimeout(teardown, 100);
  });

  shadow.getElementById('cogni-settings-btn').addEventListener('click', () => {
    safeSendMessage({ type: 'OPEN_SIDEPANEL' });
  });

  // Listen for broadcast from background
  if (_contextAlive && chrome.runtime?.id) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'HUD_UPDATE') applyHudUpdate(shadow, msg);
    });
  }

  // Initial status fetch
  safeSendMessage({ type: 'GET_STATUS' }, (resp) => {
    if (resp && resp.initialized) applyHudUpdate(shadow, resp);
  });

  // Periodic refresh every 5s
  safeInterval(() => {
    safeSendMessage({ type: 'GET_STATUS' }, (resp) => {
      if (resp && resp.initialized) applyHudUpdate(shadow, resp);
    });
  }, 5000);
}

function applyHudUpdate(shadow, data) {
  const dotEl       = shadow.getElementById('cogni-dot');
  const collDotEl   = shadow.getElementById('cogni-collapsed-dot');
  const statusText  = shadow.getElementById('cogni-status-text');
  const offlineMsg  = shadow.getElementById('cogni-offline-msg');
  const sessionEl   = shadow.getElementById('cogni-session');
  const syncEl      = shadow.getElementById('cogni-sync');
  const badgeEl     = shadow.getElementById('cogni-badge');
  const pauseBtn    = shadow.getElementById('cogni-pause-btn');

  if (!dotEl) return;

  // Paused overrides all connection statuses
  if (data.paused) {
    dotEl.className = 'cogni-dot paused';
    collDotEl.className = 'cogni-collapsed-dot paused';
    statusText.textContent = 'Paused';
    offlineMsg.style.display = 'none';
    if (pauseBtn) { pauseBtn.textContent = '▶ Resume'; pauseBtn.classList.add('pause-active'); }
  } else {
    const statusClass = data.status || 'active';
    dotEl.className = `cogni-dot ${statusClass}`;
    collDotEl.className = `cogni-collapsed-dot ${statusClass}`;
    if (pauseBtn) { pauseBtn.textContent = '⏸ Pause'; pauseBtn.classList.remove('pause-active'); }

    if (data.status === 'offline') {
      statusText.textContent = 'Offline';
      const n = data.pending_count || 0;
      offlineMsg.textContent = `${n} snapshot${n !== 1 ? 's' : ''} buffered`;
      offlineMsg.style.display = 'block';
    } else if (data.status === 'idle') {
      statusText.textContent = 'Idle Detected';
      offlineMsg.style.display = 'none';
    } else {
      statusText.textContent = 'Monitoring Active';
      offlineMsg.style.display = 'none';
    }
  }

  if (data.session_start) {
    sessionEl.textContent = formatDuration(Date.now() - data.session_start);
  }

  syncEl.textContent = data.paused ? 'Paused' : formatLastSync(data.last_sync);

  if (data.cognitive_state && !data.paused) {
    badgeEl.textContent = `🧠 ${data.cognitive_state}`;
    badgeEl.style.display = 'block';
  } else {
    badgeEl.style.display = 'none';
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatLastSync(ts) {
  if (!ts) return '—';
  const ago = Math.floor((Date.now() - ts) / 1000);
  if (ago < 10) return 'just now';
  if (ago < 60) return `${ago}s ago`;
  return `${Math.floor(ago / 60)}m ago`;
}

// Inject HUD when DOM is ready
if (document.body) {
  injectFloatingHUD();
} else {
  document.addEventListener('DOMContentLoaded', injectFloatingHUD);
}
