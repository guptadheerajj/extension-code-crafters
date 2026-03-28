// ============================================================
// sidepanel.js — CogniSense Side Panel Logic
// Screens: Welcome → Config → Active Status
// ============================================================

// ── Screen refs ─────────────────────────────────────────────
const screenWelcome = document.getElementById("screen-welcome");
const screenConfig = document.getElementById("screen-config");
const screenActive = document.getElementById("screen-active");

function showScreen(el) {
	[screenWelcome, screenConfig, screenActive].forEach((s) =>
		s.classList.remove("active"),
	);
	el.classList.add("active");
}

// ── Utility ─────────────────────────────────────────────────
function formatDuration(ms) {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(totalSeconds / 60);
	const s = totalSeconds % 60;
	return `${m}m ${s}s`;
}
function formatLastSync(ts) {
	if (!ts) return "—";
	const ago = Math.floor((Date.now() - ts) / 1000);
	if (ago < 10) return "just now";
	if (ago < 60) return `${ago}s ago`;
	return `${Math.floor(ago / 60)}m ago`;
}
function isValidUrl(str) {
	try {
		new URL(str);
		return true;
	} catch {
		return false;
	}
}

function normalizeEndpointInput(raw) {
	const trimmed = (raw || "").trim();
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed);
		if (url.pathname === "/docs") {
			url.pathname = "/api/v1";
			url.search = "";
			url.hash = "";
			return url.toString().replace(/\/$/, "");
		}
		return trimmed;
	} catch {
		return trimmed;
	}
}

function applyStoredConfigToForm(stored) {
	if (stored.api_url) {
		document.getElementById("api-url-input").value = stored.api_url;
	}
	document.getElementById("tog-keyboard").checked =
		stored.keyboard_enabled !== false;
	document.getElementById("tog-mouse").checked = stored.mouse_enabled !== false;
	document.getElementById("tog-scroll").checked =
		stored.scroll_enabled !== false;
	document.getElementById("tog-privacy").checked = !!stored.privacy_mode;
}

async function consumeRequestedView() {
	const urlView = new URL(window.location.href).searchParams.get("view");
	if (urlView === "config" || urlView === "active" || urlView === "welcome") {
		return urlView;
	}

	const { sidepanel_open_view } = await chrome.storage.session.get(
		"sidepanel_open_view",
	);
	if (sidepanel_open_view) {
		await chrome.storage.session.remove("sidepanel_open_view");
	}
	return sidepanel_open_view || null;
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

function setStoppedUI(stopped) {
	const actionRow = document.querySelector(".action-row");
	const stoppedBanner = document.getElementById("stopped-banner");
	const statsGrid = document.querySelector(".stats-grid");
	const statusRow = document.getElementById("sync-status-row");
	if (stopped) {
		if (actionRow) actionRow.style.display = "none";
		if (stoppedBanner) stoppedBanner.style.display = "flex";
		if (statsGrid) statsGrid.style.opacity = "0.35";
		if (statusRow) statusRow.style.display = "none";
	} else {
		if (actionRow) actionRow.style.display = "flex";
		if (stoppedBanner) stoppedBanner.style.display = "none";
		if (statsGrid) statsGrid.style.opacity = "1";
		if (statusRow) statusRow.style.display = "flex";
	}
}

function updateActiveScreen() {
	chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
		if (chrome.runtime.lastError || !resp) return;

		// Handle stopped state
		if (!resp.monitoring_enabled) {
			setStoppedUI(true);
			return;
		}
		setStoppedUI(false);

		const sessionEl = document.getElementById("stat-session");
		const syncEl = document.getElementById("stat-sync");
		const tabsEl = document.getElementById("stat-tabs");
		const idleEl = document.getElementById("stat-idle");
		const syncDotEl = document.getElementById("sync-dot");
		const syncLabel = document.getElementById("sync-label");
		const pauseBtn = document.getElementById("btn-pause");

		if (resp.session_start) {
			sessionEl.textContent = formatDuration(Date.now() - resp.session_start);
		}
		syncEl.textContent = resp.paused
			? "Paused"
			: formatLastSync(resp.last_sync);
		tabsEl.textContent = resp.tab_count ?? 0;
		idleEl.textContent = formatDuration(resp.idle_time_ms ?? 0);

		if (pauseBtn) {
			if (resp.paused) {
				pauseBtn.textContent = "▶️ Resume Monitoring";
				pauseBtn.classList.add("paused");
			} else {
				pauseBtn.textContent = "⏸️ Pause Monitoring";
				pauseBtn.classList.remove("paused");
			}
		}

		const status = resp.paused ? "idle" : resp.status || "active";
		syncDotEl.className = `status-dot ${status}`;
		syncLabel.textContent = resp.paused
			? "Monitoring paused"
			: {
					active: "Syncing normally",
					offline: `Offline — ${resp.pending_count || 0} snapshot${resp.pending_count !== 1 ? "s" : ""} buffered`,
					idle: "Idle state detected",
				}[resp.status] || "Connected";
	});
}

// ── Boot: check existing config ──────────────────────────────
async function boot() {
	const stored = await chrome.storage.local.get(null);
	const requestedView = await consumeRequestedView();

	if (requestedView === "config") {
		applyStoredConfigToForm(stored);
		showScreen(screenConfig);
		stopActiveRefresh();
		return;
	}

	if (requestedView === "welcome") {
		showScreen(screenWelcome);
		stopActiveRefresh();
		return;
	}

	if (requestedView === "active") {
		if (stored.onboarding_complete) {
			const endpointEl = document.getElementById("endpoint-url");
			if (endpointEl && stored.api_url) {
				endpointEl.textContent = stored.api_url;
			}
			showScreen(screenActive);
			startActiveRefresh();
			return;
		}

		showScreen(screenConfig);
		stopActiveRefresh();
		return;
	}

	if (stored.onboarding_complete) {
		// Pre-fill endpoint badge
		const endpointEl = document.getElementById("endpoint-url");
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
document.getElementById("btn-welcome-next").addEventListener("click", () => {
	showScreen(screenConfig);
	stopActiveRefresh();
});

// ── SCREEN 2: CONFIG ─────────────────────────────────────────
document.getElementById("btn-config-back").addEventListener("click", () => {
	showScreen(screenWelcome);
});

document
	.getElementById("btn-start-monitoring")
	.addEventListener("click", async () => {
		const rawApiUrl = document.getElementById("api-url-input").value;
		const apiUrl = normalizeEndpointInput(rawApiUrl);
		const errorEl = document.getElementById("api-url-error");
		const labelEl = document.getElementById("btn-start-label");
		const spinnerEl = document.getElementById("btn-start-spinner");

		// Validate URL
		errorEl.textContent = "";
		errorEl.classList.remove("visible");

		if (!isValidUrl(apiUrl)) {
			errorEl.textContent =
				"Please enter a valid URL (e.g. http://127.0.0.1:8000/api/v1 or http://127.0.0.1:8000/docs)";
			errorEl.classList.add("visible");
			return;
		}

		document.getElementById("api-url-input").value = apiUrl;

		// Show loading state
		labelEl.style.display = "none";
		spinnerEl.style.display = "block";

		// Build config
		const config = {
			api_url: apiUrl,
			keyboard_enabled: document.getElementById("tog-keyboard").checked,
			mouse_enabled: document.getElementById("tog-mouse").checked,
			scroll_enabled: document.getElementById("tog-scroll").checked,
			privacy_mode: document.getElementById("tog-privacy").checked,
			onboarding_complete: true,
		};

		// Generate session ID
		const session_id = crypto.randomUUID();

		await chrome.storage.local.set(config);
		await chrome.storage.session.set({ session_id });

		// Tell background to init
		chrome.runtime.sendMessage({ type: "INIT" }, () => {
			labelEl.style.display = "block";
			spinnerEl.style.display = "none";

			// Show active screen
			const endpointEl = document.getElementById("endpoint-url");
			if (endpointEl) endpointEl.textContent = apiUrl;

			showScreen(screenActive);
			startActiveRefresh();
		});
	});

// ── SCREEN 3: ACTIVE ─────────────────────────────────────────
const pauseButton = document.getElementById("btn-pause");
if (pauseButton) {
	pauseButton.addEventListener("click", () => {
		chrome.runtime.sendMessage({ type: "TOGGLE_PAUSE" }, (resp) => {
			if (chrome.runtime.lastError || !resp) return;
			if (resp.paused) {
				pauseButton.textContent = "▶️ Resume Monitoring";
				pauseButton.classList.add("paused");
			} else {
				pauseButton.textContent = "⏸️ Pause Monitoring";
				pauseButton.classList.remove("paused");
			}
			// Refresh stats immediately after toggle
			updateActiveScreen();
		});
	});
}

document
	.getElementById("btn-reconfigure")
	.addEventListener("click", async () => {
		// Load existing config into form
		const stored = await chrome.storage.local.get(null);
		applyStoredConfigToForm(stored);

		stopActiveRefresh();
		showScreen(screenConfig);
	});

document.getElementById("btn-stop").addEventListener("click", () => {
	chrome.runtime.sendMessage({ type: "DISABLE_MONITORING" }, (resp) => {
		if (chrome.runtime.lastError || !resp?.ok) return;
		setStoppedUI(true);
		stopActiveRefresh();
	});
});

document.getElementById("btn-reenable").addEventListener("click", async () => {
	chrome.runtime.sendMessage({ type: "ENABLE_MONITORING" }, async (resp) => {
		if (chrome.runtime.lastError || !resp?.ok) return;
		await updateActiveScreen();
		setStoppedUI(false);
		startActiveRefresh();
	});
});

// Listen for background HUD_UPDATE messages (update active screen in real-time)
chrome.runtime.onMessage.addListener((msg) => {
	if (msg.type === "HUD_UPDATE" && screenActive.classList.contains("active")) {
		updateActiveScreen();
	}
});

// ── Start ────────────────────────────────────────────────────
boot();
