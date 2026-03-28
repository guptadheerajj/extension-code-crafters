// ============================================================
// background.js — CogniSense Service Worker
// Handles: state aggregation, tab tracking, env data,
//          30-second snapshot sync, offline buffer, HUD broadcast
// ============================================================

// ----------------------------------------------------------------
// STATE
// ----------------------------------------------------------------
let config = null;
let state = null;

function initState(sessionId) {
  state = {
    session_id: sessionId,
    session_start: Date.now(),
    tab: {
      url: null,
      domain: null,
      time_on_page_s: 0,
      tab_count: 1,
      switch_freq_per_min: 0,
      page_visible: true,
      tab_start_time: Date.now(),
      switch_timestamps: [] // rolling 60s window
    },
    keyboard: {
      wpm_estimate: 0,
      inter_key_delay_ms_avg: 0,
      error_rate: 0,
      pause_detected: false,
      pause_count: 0,
      burst_typing: false,
      keydown_count: 0
    },
    mouse: {
      speed_avg: 0,
      acceleration_variance: 0,
      cursor_idle_ms: 0,
      click_rate_per_min: 0,
      click_interval_ms_avg: 0
    },
    scroll: {
      depth_pct: 0,
      velocity_avg: 0,
      direction_changes: 0
    },
    page: {
      form_active: false,
      video_playing: false,
      video_watch_duration_s: 0,
      engagement_score: 0
    },
    environment: {},
    pending_snapshots: [],
    last_sync: null,
    last_feedback: null,
    focus_streak_start: Date.now(),
    break_count: 0,
    hud_status: 'active' // 'active' | 'offline' | 'idle'
  };
}

// ----------------------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------------------
async function initialize() {
  const stored = await chrome.storage.local.get(null);
  if (!stored.onboarding_complete) return;

  config = stored;

  // Session ID (resets on browser close via storage.session)
  let { session_id } = await chrome.storage.session.get('session_id');
  if (!session_id) {
    session_id = crypto.randomUUID();
    await chrome.storage.session.set({ session_id });
  }

  initState(session_id);

  // Restore any buffered pending snapshots from storage
  const { pending_snapshots } = await chrome.storage.local.get('pending_snapshots');
  state.pending_snapshots = pending_snapshots || [];

  await updateCurrentTab();
  await collectEnvironment();
  registerAlarm();

  console.log('[CogniSense] Initialized. Session:', session_id);
}

// ----------------------------------------------------------------
// TAB TRACKING
// ----------------------------------------------------------------
function extractDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function updateCurrentTab() {
  if (!state) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    state.tab.url = tab.url || '';
    state.tab.domain = extractDomain(tab.url || '');
    state.tab.tab_start_time = Date.now();
  }
  const allTabs = await chrome.tabs.query({ currentWindow: true });
  state.tab.tab_count = allTabs.length;
}

function recordTabSwitch(newUrl) {
  if (!state) return;
  const now = Date.now();

  // Compute time spent on previous tab
  if (state.tab.tab_start_time) {
    state.tab.time_on_page_s = Math.round((now - state.tab.tab_start_time) / 1000);
  }

  // Rolling 60s switch frequency window
  state.tab.switch_timestamps.push(now);
  state.tab.switch_timestamps = state.tab.switch_timestamps.filter(t => now - t <= 60000);
  state.tab.switch_freq_per_min = state.tab.switch_timestamps.length;

  // Update to newly active tab
  state.tab.tab_start_time = now;
  state.tab.url = newUrl || '';
  state.tab.domain = extractDomain(newUrl || '');
  state.tab.page_visible = true;
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!state) return;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    recordTabSwitch(tab.url || '');
    const allTabs = await chrome.tabs.query({ currentWindow: true });
    state.tab.tab_count = allTabs.length;
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!state || !changeInfo.url) return;
  // Only care about the active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && activeTab.id === tabId) {
    recordTabSwitch(changeInfo.url);
  }
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (!state || details.frameId !== 0) return; // main frame only
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && activeTab.id === details.tabId) {
    state.tab.page_visible = true;
    state.tab.url = details.url;
    state.tab.domain = extractDomain(details.url);
  }
});

chrome.idle.onStateChanged.addListener((newState) => {
  if (!state) return;
  if (newState === 'idle' || newState === 'locked') {
    state.break_count++;
    state.hud_status = 'idle';
  } else if (newState === 'active') {
    state.focus_streak_start = Date.now();
    if (state.hud_status === 'idle') state.hud_status = 'active';
  }
  broadcastHudUpdate();
});

// ----------------------------------------------------------------
// ENVIRONMENTAL DATA
// ----------------------------------------------------------------
async function collectEnvironment() {
  if (!state) return;
  const now = new Date();

  let battery_level = null;
  let is_charging = null;
  try {
    const bat = await navigator.getBattery();
    battery_level = Math.round(bat.level * 100) / 100;
    is_charging = bat.charging;
  } catch (_) {}

  const chrome_idle_state = await chrome.idle.queryState(60);

  state.environment = {
    battery_level,
    is_charging,
    hour_of_day: now.getHours(),
    day_of_week: now.getDay(),
    is_late_night: now.getHours() >= 23 || now.getHours() <= 4,
    session_duration_s: Math.round((Date.now() - state.session_start) / 1000),
    chrome_idle_state
  };
}

// ----------------------------------------------------------------
// SNAPSHOT ASSEMBLY
// ----------------------------------------------------------------
function assembleSnapshot() {
  const now = Date.now();
  const privacyMode = config?.privacy_mode;

  return {
    session_id: state.session_id,
    timestamp: now,
    tab: {
      url: privacyMode ? state.tab.domain : (state.tab.url || ''),
      domain: state.tab.domain || '',
      time_on_page_s: state.tab.time_on_page_s,
      tab_count: state.tab.tab_count,
      switch_freq_per_min: state.tab.switch_freq_per_min,
      page_visible: state.tab.page_visible
    },
    keyboard: { ...state.keyboard },
    mouse: { ...state.mouse },
    scroll: { ...state.scroll },
    page: { ...state.page },
    environment: { ...state.environment }
  };
}

// ----------------------------------------------------------------
// BACKEND SYNC
// ----------------------------------------------------------------
async function syncToBackend() {
  if (!config?.api_url || !state) return;

  await collectEnvironment();
  const snapshot = assembleSnapshot();
  const toSend = [...state.pending_snapshots, snapshot];

  try {
    for (const s of toSend) {
      const resp = await fetch(config.api_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
        signal: AbortSignal.timeout(10000)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      // Parse backend response for cognitive state label
      let data = null;
      try { data = await resp.json(); } catch (_) {}
      if (data?.cognitive_state) {
        state.last_feedback = data;
      }
    }

    // All sent successfully
    state.pending_snapshots = [];
    state.last_sync = Date.now();
    if (state.hud_status !== 'idle') state.hud_status = 'active';
    await chrome.storage.local.set({ pending_snapshots: [] });

  } catch (err) {
    console.warn('[CogniSense] Sync failed:', err.message);
    state.pending_snapshots.push(snapshot);
    // Cap buffer at 20 (≈10 min of data)
    if (state.pending_snapshots.length > 20) {
      state.pending_snapshots = state.pending_snapshots.slice(-20);
    }
    state.hud_status = 'offline';
    await chrome.storage.local.set({ pending_snapshots: state.pending_snapshots });
  }

  broadcastHudUpdate();
}

// ----------------------------------------------------------------
// ALARM-BASED SYNC TIMER (survives SW termination)
// ----------------------------------------------------------------
function registerAlarm() {
  chrome.alarms.get('cogni_sync', (existing) => {
    if (!existing) {
      // 0.5 minutes = 30 seconds (Chrome minimum)
      chrome.alarms.create('cogni_sync', { periodInMinutes: 0.5 });
    }
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'cogni_sync') {
    if (!state) await initialize();
    if (state) await syncToBackend();
  }
});

// ----------------------------------------------------------------
// HUD BROADCAST
// ----------------------------------------------------------------
async function broadcastHudUpdate() {
  if (!state) return;
  const payload = buildStatusPayload();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
    }
  }
}

function buildStatusPayload() {
  return {
    type: 'HUD_UPDATE',
    status: state.hud_status,
    pending_count: state.pending_snapshots.length,
    last_sync: state.last_sync,
    session_start: state.session_start,
    session_id: state.session_id,
    cognitive_state: state.last_feedback?.cognitive_state || null,
    break_count: state.break_count,
    initialized: true
  };
}

// ----------------------------------------------------------------
// MESSAGE BUS
// ----------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!state && message.type !== 'INIT') {
      sendResponse({ ok: false, reason: 'not_initialized' });
      return;
    }

    switch (message.type) {
      case 'KEYBOARD_BATCH':
        if (config?.keyboard_enabled !== false) Object.assign(state.keyboard, message.data);
        sendResponse({ ok: true });
        break;

      case 'MOUSE_BATCH':
        if (config?.mouse_enabled !== false) Object.assign(state.mouse, message.data);
        sendResponse({ ok: true });
        break;

      case 'SCROLL_BATCH':
        if (config?.scroll_enabled !== false) Object.assign(state.scroll, message.data);
        sendResponse({ ok: true });
        break;

      case 'PAGE_BATCH':
        Object.assign(state.page, message.data);
        sendResponse({ ok: true });
        break;

      case 'PAGE_HIDDEN':
        state.tab.page_visible = false;
        sendResponse({ ok: true });
        break;

      case 'PAGE_VISIBLE':
        state.tab.page_visible = true;
        sendResponse({ ok: true });
        break;

      case 'INIT':
        await initialize();
        await broadcastHudUpdate();
        sendResponse({ ok: true });
        break;

      case 'GET_STATUS':
        if (state) {
          sendResponse(buildStatusPayload());
        } else {
          sendResponse({ ok: false, initialized: false });
        }
        break;

      case 'OPEN_SIDEPANEL':
        // chrome.sidePanel.open() requires a direct user gesture.
        // That context is lost when relayed through the message bus from a
        // content script, so the call silently fails. Opening the side panel
        // page as a normal tab is the reliable fallback.
        chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: true });
    }
  })();
  return true; // keep port open for async response
});

// ----------------------------------------------------------------
// EXTENSION ICON CLICK → OPEN SIDE PANEL
// ----------------------------------------------------------------
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// ----------------------------------------------------------------
// STARTUP
// ----------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => initialize());
chrome.runtime.onStartup.addListener(() => initialize());
// Initialize immediately when SW wakes up
initialize();
