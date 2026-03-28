// ============================================================
// sidepanel.js — CogniSense Side Panel Logic
// Screens: Welcome → Config → Active Status
// ============================================================

// ── Screen refs ─────────────────────────────────────────────
const screenWelcome = document.getElementById('screen-welcome');
const screenConfig  = document.getElementById('screen-config');
const screenActive  = document.getElementById('screen-active');

function showScreen(el) {
  [screenWelcome, screenConfig, screenActive].forEach(s => s.classList.remove('active'));
  el.classList.add('active');
}

// ── Utility ─────────────────────────────────────────────────
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function formatLastSync(ts) {
  if (!ts) return '—';
  const ago = Math.floor((Date.now() - ts) / 1000);
  if (ago < 10)  return 'just now';
  if (ago < 60)  return `${ago}s ago`;
  return `${Math.floor(ago / 60)}m ago`;
}
function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

// ── Active screen auto-refresh ───────────────────────────────
let activeRefreshInterval = null;

function startActiveRefresh() {
  updateActiveScreen(); // immediate
  if (activeRefreshInterval) clearInterval(activeRefreshInterval);
  activeRefreshInterval = setInterval(updateActiveScreen, 5000);
}

function stopActiveRefresh() {
  if (activeRefreshInterval) {
    clearInterval(activeRefreshInterval);
    activeRefreshInterval = null;
  }
}

function updateActiveScreen() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;

    const sessionEl  = document.getElementById('stat-session');
    const syncEl     = document.getElementById('stat-sync');
    const bufferedEl = document.getElementById('stat-buffered');
    const stateEl    = document.getElementById('stat-state');
    const syncDotEl  = document.getElementById('sync-dot');
    const syncLabel  = document.getElementById('sync-label');
    const pauseBtn   = document.getElementById('btn-pause');

    if (resp.session_start) {
      sessionEl.textContent = formatDuration(Date.now() - resp.session_start);
    }
    syncEl.textContent     = resp.paused ? 'Paused' : formatLastSync(resp.last_sync);
    bufferedEl.textContent = resp.pending_count ?? 0;
    stateEl.textContent    = resp.paused ? 'Paused' :
      (resp.cognitive_state
        ? resp.cognitive_state.charAt(0).toUpperCase() + resp.cognitive_state.slice(1)
        : '—');

    // Sync pause button label
    if (pauseBtn) {
      if (resp.paused) {
        pauseBtn.textContent = '▶️ Resume Monitoring';
        pauseBtn.classList.add('paused');
      } else {
        pauseBtn.textContent = '⏸️ Pause Monitoring';
        pauseBtn.classList.remove('paused');
      }
    }

    const status = resp.paused ? 'idle' : (resp.status || 'active');
    syncDotEl.className = `status-dot ${status}`;
    syncLabel.textContent = resp.paused ? 'Monitoring paused' : {
      active:  'Syncing normally',
      offline: `Offline — ${resp.pending_count || 0} snapshot${resp.pending_count !== 1 ? 's' : ''} buffered`,
      idle:    'Idle state detected'
    }[resp.status] || 'Connected';
  });
}

// ── Boot: check existing config ──────────────────────────────
async function boot() {
  const stored = await chrome.storage.local.get(null);

  if (stored.onboarding_complete) {
    // Pre-fill endpoint badge
    const endpointEl = document.getElementById('endpoint-url');
    if (endpointEl && stored.api_url) {
      endpointEl.textContent = stored.api_url;
    }
    showScreen(screenActive);
    startActiveRefresh();
  } else {
    showScreen(screenWelcome);
  }
}

// ── SCREEN 1: WELCOME ────────────────────────────────────────
document.getElementById('btn-welcome-next').addEventListener('click', () => {
  showScreen(screenConfig);
  stopActiveRefresh();
});

// ── SCREEN 2: CONFIG ─────────────────────────────────────────
document.getElementById('btn-config-back').addEventListener('click', () => {
  showScreen(screenWelcome);
});

document.getElementById('btn-start-monitoring').addEventListener('click', async () => {
  const apiUrl      = document.getElementById('api-url-input').value.trim();
  const errorEl     = document.getElementById('api-url-error');
  const labelEl     = document.getElementById('btn-start-label');
  const spinnerEl   = document.getElementById('btn-start-spinner');

  // Validate URL
  errorEl.textContent = '';
  errorEl.classList.remove('visible');

  if (!isValidUrl(apiUrl)) {
    errorEl.textContent = 'Please enter a valid URL (e.g. http://localhost:8000/api/snapshot)';
    errorEl.classList.add('visible');
    return;
  }

  // Show loading state
  labelEl.style.display = 'none';
  spinnerEl.style.display = 'block';

  // Build config
  const config = {
    api_url:          apiUrl,
    keyboard_enabled: document.getElementById('tog-keyboard').checked,
    mouse_enabled:    document.getElementById('tog-mouse').checked,
    scroll_enabled:   document.getElementById('tog-scroll').checked,
    privacy_mode:     document.getElementById('tog-privacy').checked,
    onboarding_complete: true
  };

  // Generate session ID
  const session_id = crypto.randomUUID();

  await chrome.storage.local.set(config);
  await chrome.storage.session.set({ session_id });

  // Tell background to init
  chrome.runtime.sendMessage({ type: 'INIT' }, () => {
    labelEl.style.display = 'block';
    spinnerEl.style.display = 'none';

    // Show active screen
    const endpointEl = document.getElementById('endpoint-url');
    if (endpointEl) endpointEl.textContent = apiUrl;

    showScreen(screenActive);
    startActiveRefresh();
  });
});

// ── SCREEN 3: ACTIVE ─────────────────────────────────────────
document.getElementById('btn-pause').addEventListener('click', () => {
  const btn = document.getElementById('btn-pause');
  chrome.runtime.sendMessage({ type: 'TOGGLE_PAUSE' }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.paused) {
      btn.textContent = '▶️ Resume Monitoring';
      btn.classList.add('paused');
    } else {
      btn.textContent = '⏸️ Pause Monitoring';
      btn.classList.remove('paused');
    }
    // Refresh stats immediately after toggle
    updateActiveScreen();
  });
});

document.getElementById('btn-reconfigure').addEventListener('click', async () => {
  // Load existing config into form
  const stored = await chrome.storage.local.get(null);
  if (stored.api_url) {
    document.getElementById('api-url-input').value = stored.api_url;
  }
  document.getElementById('tog-keyboard').checked = stored.keyboard_enabled !== false;
  document.getElementById('tog-mouse').checked    = stored.mouse_enabled !== false;
  document.getElementById('tog-scroll').checked   = stored.scroll_enabled !== false;
  document.getElementById('tog-privacy').checked  = !!stored.privacy_mode;

  stopActiveRefresh();
  showScreen(screenConfig);
});

// Listen for background HUD_UPDATE messages (update active screen in real-time)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'HUD_UPDATE' && screenActive.classList.contains('active')) {
    updateActiveScreen();
  }
});

// ── Start ────────────────────────────────────────────────────
boot();
