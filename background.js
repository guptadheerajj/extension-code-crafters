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
		backend_session_id: null,
		user_id: null,
		next_client_seq: 1,
		session_start: Date.now(),
		tab: {
			url: null,
			domain: null,
			time_on_page_s: 0,
			tab_count: 1,
			switch_freq_per_min: 0,
			page_visible: true,
			tab_start_time: Date.now(),
			switch_timestamps: [], // rolling 60s window
		},
		keyboard: {
			wpm_estimate: 0,
			inter_key_delay_ms_avg: 0,
			error_rate: 0,
			pause_detected: false,
			pause_count: 0,
			burst_typing: false,
			keydown_count: 0,
		},
		mouse: {
			speed_avg: 0,
			acceleration_variance: 0,
			cursor_idle_ms: 0,
			click_rate_per_min: 0,
			click_interval_ms_avg: 0,
		},
		scroll: {
			depth_pct: 0,
			velocity_avg: 0,
			direction_changes: 0,
		},
		page: {
			form_active: false,
			video_playing: false,
			video_watch_duration_s: 0,
			engagement_score: 0,
		},
		environment: {},
		pending_snapshots: [],
		last_sync: null,
		last_feedback: null,
		focus_streak_start: Date.now(),
		break_count: 0,
		hud_status: "active", // 'active' | 'offline' | 'idle'
		paused: false,
	};
}

// ----------------------------------------------------------------
// INITIALIZATION
// ----------------------------------------------------------------
async function initialize() {
	const stored = await chrome.storage.local.get(null);
	if (!stored.onboarding_complete) return;
	if (stored.monitoring_enabled === false) return; // user explicitly stopped monitoring

	config = stored;

	// Session ID (resets on browser close via storage.session)
	let { session_id } = await chrome.storage.session.get("session_id");
	if (!session_id) {
		session_id = crypto.randomUUID();
		await chrome.storage.session.set({ session_id });
	}

	initState(session_id);

	// Restore pending snapshots and paused state from storage
	const {
		pending_snapshots,
		monitoring_paused,
		backend_session_id,
		next_client_seq,
		user_id,
	} = await chrome.storage.local.get([
		"pending_snapshots",
		"monitoring_paused",
		"backend_session_id",
		"next_client_seq",
		"user_id",
	]);
	state.pending_snapshots = pending_snapshots || [];
	state.paused = monitoring_paused || false;
	state.backend_session_id = backend_session_id || null;
	state.next_client_seq =
		Number.isFinite(next_client_seq) && next_client_seq > 0
			? next_client_seq
			: 1;
	state.user_id = user_id || crypto.randomUUID();

	await chrome.storage.local.set({
		user_id: state.user_id,
		next_client_seq: state.next_client_seq,
	});

	await updateCurrentTab();
	await collectEnvironment();
	registerAlarm();

	console.log(
		"[CogniSense] Initialized. Session:",
		session_id,
		"| Paused:",
		state.paused,
	);
}

// ----------------------------------------------------------------
// TAB TRACKING
// ----------------------------------------------------------------
function extractDomain(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

async function updateCurrentTab() {
	if (!state) return;
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (tab) {
		state.tab.url = tab.url || "";
		state.tab.domain = extractDomain(tab.url || "");
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
		state.tab.time_on_page_s = Math.round(
			(now - state.tab.tab_start_time) / 1000,
		);
	}

	// Rolling 60s switch frequency window
	state.tab.switch_timestamps.push(now);
	state.tab.switch_timestamps = state.tab.switch_timestamps.filter(
		(t) => now - t <= 60000,
	);
	state.tab.switch_freq_per_min = state.tab.switch_timestamps.length;

	// Update to newly active tab
	state.tab.tab_start_time = now;
	state.tab.url = newUrl || "";
	state.tab.domain = extractDomain(newUrl || "");
	state.tab.page_visible = true;
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
	if (!state) return;
	try {
		const tab = await chrome.tabs.get(activeInfo.tabId);
		recordTabSwitch(tab.url || "");
		const allTabs = await chrome.tabs.query({ currentWindow: true });
		state.tab.tab_count = allTabs.length;
	} catch (_) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
	if (!state || !changeInfo.url) return;
	// Only care about the active tab
	const [activeTab] = await chrome.tabs.query({
		active: true,
		currentWindow: true,
	});
	if (activeTab && activeTab.id === tabId) {
		recordTabSwitch(changeInfo.url);
	}
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
	if (!state || details.frameId !== 0) return; // main frame only
	const [activeTab] = await chrome.tabs.query({
		active: true,
		currentWindow: true,
	});
	if (activeTab && activeTab.id === details.tabId) {
		state.tab.page_visible = true;
		state.tab.url = details.url;
		state.tab.domain = extractDomain(details.url);
	}
});

chrome.idle.onStateChanged.addListener((newState) => {
	if (!state) return;
	if (newState === "idle" || newState === "locked") {
		state.break_count++;
		state.hud_status = "idle";
	} else if (newState === "active") {
		state.focus_streak_start = Date.now();
		if (state.hud_status === "idle") state.hud_status = "active";
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
		chrome_idle_state,
	};
}

// ----------------------------------------------------------------
// SNAPSHOT ASSEMBLY
// ----------------------------------------------------------------
function assembleSnapshot() {
	const now = Date.now();
	const privacyMode = config?.privacy_mode;
	const clientSeq = state.next_client_seq;
	state.next_client_seq += 1;
	chrome.storage.local
		.set({ next_client_seq: state.next_client_seq })
		.catch(() => {});

	return {
		session_id: state.session_id,
		client_seq: clientSeq,
		idempotency_key: `${state.session_id}-${clientSeq}`,
		timestamp: now,
		tab: {
			url: privacyMode ? state.tab.domain : state.tab.url || "",
			domain: state.tab.domain || "",
			time_on_page_s: state.tab.time_on_page_s,
			tab_count: state.tab.tab_count,
			switch_freq_per_min: state.tab.switch_freq_per_min,
			page_visible: state.tab.page_visible,
		},
		keyboard: { ...state.keyboard },
		mouse: { ...state.mouse },
		scroll: { ...state.scroll },
		page: { ...state.page },
		environment: { ...state.environment },
	};
}

// ----------------------------------------------------------------
// BACKEND SYNC
// ----------------------------------------------------------------
function resolveApiMode(rawUrl) {
	if (!rawUrl) return null;

	try {
		const u = new URL(rawUrl);
		const path = (u.pathname || "/").replace(/\/$/, "");

		// Legacy single-endpoint mode
		if (path.endsWith("/api/snapshot")) {
			return { mode: "legacy", snapshotUrl: u.toString() };
		}

		// Cognitive API mode
		// Accept either /api/v1, /api/v1/*, /docs, or bare origin.
		let basePath = "/api/v1";
		if (path === "/docs" || path === "") {
			basePath = "/api/v1";
		} else if (path.startsWith("/api/v1")) {
			basePath = "/api/v1";
		}

		const baseUrl = `${u.origin}${basePath}`;
		return {
			mode: "cognitive",
			sessionsUrl: `${baseUrl}/sessions`,
		};
	} catch {
		return null;
	}
}

function buildSnapshotEnvelope(s) {
	const stress = Math.max(
		0,
		Math.min(
			1,
			s.keyboard.error_rate * 1.8 +
				(s.mouse.acceleration_variance > 600 ? 0.2 : 0) +
				(s.tab.switch_freq_per_min > 6 ? 0.2 : 0),
		),
	);
	const fatigue = Math.max(
		0,
		Math.min(
			1,
			(s.environment.is_late_night ? 0.35 : 0) +
				(s.mouse.cursor_idle_ms > 4000 ? 0.25 : 0) +
				(s.keyboard.pause_detected ? 0.2 : 0),
		),
	);

	return {
		captured_at: new Date(s.timestamp).toISOString(),
		client_seq: s.client_seq,
		idempotency_key: s.idempotency_key,
		payload: {
			tab: s.tab,
			keyboard: s.keyboard,
			mouse: s.mouse,
			scroll: s.scroll,
			page: s.page,
			environment: s.environment,
			derived: {
				stress_index: Number(stress.toFixed(3)),
				fatigue_index: Number(fatigue.toFixed(3)),
			},
		},
	};
}

function extractCognitiveStateLabel(data) {
	if (!data || typeof data !== "object") return null;
	return (
		data.cognitive_state ||
		data.state_label ||
		data.latest_state_label ||
		data?.prediction?.state_label ||
		data?.prediction?.label ||
		data?.state?.label ||
		null
	);
}

async function ensureBackendSession(apiSpec) {
	if (!state || !apiSpec || apiSpec.mode !== "cognitive") return;
	if (state.backend_session_id) return;

	const payload = {
		user_id: state.user_id,
		device_id: `chrome-${chrome.runtime.id.slice(0, 8)}`,
		external_ref: state.session_id,
		meta: {
			source: "cognisense-extension",
			extension_version: chrome.runtime.getManifest().version,
		},
	};

	const resp = await fetch(apiSpec.sessionsUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(10000),
	});

	if (!resp.ok) {
		throw new Error(`Session create failed: HTTP ${resp.status}`);
	}

	const data = await resp.json();
	const sessionId = data?.id || data?.session_id;
	if (!sessionId) {
		throw new Error("Session create failed: missing session id");
	}

	state.backend_session_id = sessionId;
	await chrome.storage.local.set({ backend_session_id: sessionId });
}

async function syncToBackend() {
	if (!config?.api_url || !state) return;
	if (state.paused) return; // monitoring is paused by user

	await collectEnvironment();
	const snapshot = assembleSnapshot();
	const toSend = [...state.pending_snapshots, snapshot];
	const apiSpec = resolveApiMode(config.api_url);

	if (!apiSpec) {
		console.warn("[CogniSense] Invalid API URL:", config.api_url);
		state.hud_status = "offline";
		broadcastHudUpdate();
		return;
	}

	try {
		if (apiSpec.mode === "cognitive") {
			await ensureBackendSession(apiSpec);
		}

		for (const s of toSend) {
			let resp;
			if (apiSpec.mode === "legacy") {
				resp = await fetch(apiSpec.snapshotUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(s),
					signal: AbortSignal.timeout(10000),
				});
			} else {
				const snapshotUrl = `${apiSpec.sessionsUrl}/${state.backend_session_id}/snapshots`;
				resp = await fetch(snapshotUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(buildSnapshotEnvelope(s)),
					signal: AbortSignal.timeout(10000),
				});
			}
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

			// Parse backend response for cognitive state label
			let data = null;
			try {
				data = await resp.json();
			} catch (_) {}
			const stateLabel = extractCognitiveStateLabel(data);
			if (stateLabel) {
				state.last_feedback = { cognitive_state: stateLabel, raw: data };
			}
		}

		// All sent successfully
		state.pending_snapshots = [];
		state.last_sync = Date.now();
		if (state.hud_status !== "idle") state.hud_status = "active";
		await chrome.storage.local.set({ pending_snapshots: [] });
	} catch (err) {
		console.warn("[CogniSense] Sync failed:", err.message);
		state.pending_snapshots.push(snapshot);
		// Cap buffer at 20 (≈10 min of data)
		if (state.pending_snapshots.length > 20) {
			state.pending_snapshots = state.pending_snapshots.slice(-20);
		}
		state.hud_status = "offline";
		await chrome.storage.local.set({
			pending_snapshots: state.pending_snapshots,
		});
	}

	broadcastHudUpdate();
}

// ----------------------------------------------------------------
// ALARM-BASED SYNC TIMER (survives SW termination)
// ----------------------------------------------------------------
function registerAlarm() {
	chrome.alarms.get("cogni_sync", (existing) => {
		if (!existing) {
			// 0.5 minutes = 30 seconds (Chrome minimum)
			chrome.alarms.create("cogni_sync", { periodInMinutes: 0.5 });
		}
	});
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
	if (alarm.name === "cogni_sync") {
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
		type: "HUD_UPDATE",
		status: state.hud_status,
		paused: state.paused,
		pending_count: state.pending_snapshots.length,
		last_sync: state.last_sync,
		session_start: state.session_start,
		session_id: state.session_id,
		cognitive_state: state.last_feedback?.cognitive_state || null,
		break_count: state.break_count,
		initialized: true,
	};
}

// ----------------------------------------------------------------
// MESSAGE BUS
// ----------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	(async () => {
		const allowedWithoutState = new Set([
			"INIT",
			"GET_STATUS",
			"DISABLE_MONITORING",
			"ENABLE_MONITORING",
			"OPEN_SIDEPANEL",
		]);

		if (!state && !allowedWithoutState.has(message.type)) {
			sendResponse({ ok: false, reason: "not_initialized" });
			return;
		}

		switch (message.type) {
			case "KEYBOARD_BATCH":
				if (config?.keyboard_enabled !== false)
					Object.assign(state.keyboard, message.data);
				sendResponse({ ok: true });
				break;

			case "MOUSE_BATCH":
				if (config?.mouse_enabled !== false)
					Object.assign(state.mouse, message.data);
				sendResponse({ ok: true });
				break;

			case "SCROLL_BATCH":
				if (config?.scroll_enabled !== false)
					Object.assign(state.scroll, message.data);
				sendResponse({ ok: true });
				break;

			case "PAGE_BATCH":
				Object.assign(state.page, message.data);
				sendResponse({ ok: true });
				break;

			case "PAGE_HIDDEN":
				state.tab.page_visible = false;
				sendResponse({ ok: true });
				break;

			case "PAGE_VISIBLE":
				state.tab.page_visible = true;
				sendResponse({ ok: true });
				break;

			case "INIT":
				await initialize();
				await broadcastHudUpdate();
				sendResponse({ ok: true });
				break;

			case "GET_STATUS":
				if (state) {
					sendResponse({ ...buildStatusPayload(), monitoring_enabled: true });
				} else {
					// State is null: either not initialized or disabled
					const { monitoring_enabled } =
						await chrome.storage.local.get("monitoring_enabled");
					sendResponse({
						ok: false,
						initialized: false,
						monitoring_enabled: monitoring_enabled !== false,
					});
				}
				break;

			case "OPEN_SIDEPANEL":
				{
					const requestedView = message.view === "config" ? "config" : "active";
					const senderWindowId = sender?.tab?.windowId;

					try {
						// Keep this call as close as possible to the originating click so
						// Chrome preserves the user-gesture requirement for sidePanel.open().
						if (typeof senderWindowId === "number") {
							await chrome.sidePanel.open({ windowId: senderWindowId });
						} else {
							const [activeTab] = await chrome.tabs.query({
								active: true,
								currentWindow: true,
							});
							if (typeof activeTab?.windowId !== "number") {
								throw new Error("no_target_window");
							}
							await chrome.sidePanel.open({ windowId: activeTab.windowId });
						}

						if (requestedView === "config") {
							chrome.storage.session
								.set({ sidepanel_open_view: "config" })
								.catch(() => {});
						}

						sendResponse({
							ok: true,
							opened: "sidepanel",
							view: requestedView,
						});
					} catch (err) {
						sendResponse({
							ok: false,
							opened: "sidepanel",
							reason: String(err),
						});
					}
				}
				break;

			case "DISABLE_MONITORING": {
				// 1. Broadcast teardown to every open tab so all HUDs are removed
				const allTabs = await chrome.tabs.query({});
				for (const tab of allTabs) {
					if (tab.id)
						chrome.tabs
							.sendMessage(tab.id, { type: "FORCE_TEARDOWN" })
							.catch(() => {});
				}
				// 2. Kill the sync alarm
				chrome.alarms.clear("cogni_sync");
				// 3. Persist disabled state (keeps config so re-enable is instant)
				await chrome.storage.local.set({
					monitoring_enabled: false,
					monitoring_paused: false,
					backend_session_id: null,
				});
				// 4. Clear in-memory state
				state = null;
				sendResponse({ ok: true });
				break;
			}

			case "ENABLE_MONITORING": {
				await chrome.storage.local.set({ monitoring_enabled: true });
				await initialize();
				// Re-inject content.js into all open HTTP/HTTPS tabs so HUDs reappear
				// (Chrome only auto-injects on new page loads after re-enable)
				try {
					const httpTabs = await chrome.tabs.query({
						url: ["http://*/*", "https://*/*"],
					});
					for (const tab of httpTabs) {
						if (tab.id) {
							chrome.scripting
								.executeScript({
									target: { tabId: tab.id },
									files: ["content.js"],
								})
								.catch(() => {});
						}
					}
				} catch (_) {}
				await broadcastHudUpdate();
				sendResponse({ ok: true });
				break;
			}

			case "TOGGLE_PAUSE":
				state.paused = !state.paused;
				await chrome.storage.local.set({ monitoring_paused: state.paused });
				await broadcastHudUpdate();
				sendResponse({ ok: true, paused: state.paused });
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
