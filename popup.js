// popup.js
// Runs when the user clicks the extension icon. Deliberately small: the master switch, one status
// line, a break button and a link to the Settings page. Every setting lives in welcome.html.
//
// The big power button is the master switch (settings.enabled, owned by background.js).
// When it is off, #main-content is hidden and only the switch and a short "paused" note remain.

const powerBtn = document.getElementById("power-btn");
const powerTitle = document.getElementById("power-title");
const powerSub = document.getElementById("power-sub");
const offPanel = document.getElementById("off-panel");
const mainContent = document.getElementById("main-content");

const statusText = document.getElementById("status-text");
const statsText = document.getElementById("stats-text");
const focusDurationEl = document.getElementById("focus-duration");
const startFocusBtn = document.getElementById("start-focus-btn");
const setupCard = document.getElementById("setup-card");
const setupText = document.getElementById("setup-text");
const setupBtn = document.getElementById("setup-btn");
const setupLink = document.getElementById("setup-link");

let enabled = true;

const getSettings = () => chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
const getState = () => chrome.runtime.sendMessage({ type: "GET_STATE" });

// ---------- rendering ----------
function renderPower(state) {
  powerBtn.classList.toggle("off", !enabled);
  powerBtn.setAttribute("aria-checked", String(enabled));

  if (enabled) {
    powerTitle.textContent = "Alarm is ON";
    powerSub.textContent =
      state && state.alarmStatus === "ACTIVE"
        ? "Alarm is ringing. Tap to turn off"
        : "Tap to turn off";
  } else {
    powerTitle.textContent = "Alarm is OFF";
    powerSub.textContent = "Tap to turn on";
  }

  mainContent.hidden = !enabled;
  offPanel.hidden = enabled;
}

function studyActive(state) {
  return !!(state.studyMode && state.studyMode.until && state.studyMode.until > Date.now());
}

function renderStatus(settings, state) {
  if (state.alarmStatus === "ACTIVE") {
    statusText.textContent = "Alarm is ringing on your open tabs.";
  } else if (state.snooze.snoozeUntil && Date.now() < state.snooze.snoozeUntil) {
    const mins = Math.ceil((state.snooze.snoozeUntil - Date.now()) / 60000);
    statusText.textContent = `Snoozed. ${mins} min left.`;
  } else if (studyActive(state)) {
    const mins = Math.ceil((state.studyMode.until - Date.now()) / 60000);
    statusText.textContent = `On a break. ${mins} min left. Nothing is being tracked.`;
  } else {
    const accMin = Math.floor(state.tracking.accumulatedMs / 60000);
    statusText.textContent = `Watching. ${accMin} of ${settings.thresholdMinutes} distracted minutes used.`;
  }

  statsText.textContent =
    `Alarms: ${state.stats.alarmsTriggered}  ·  Solved: ${state.stats.problemsSolved}  ·  Snoozes: ${state.stats.snoozes}`;
  startFocusBtn.textContent = studyActive(state) ? "Stop break" : "Start break";
  focusDurationEl.disabled = studyActive(state);
  if (state.lastError) statsText.textContent += `  ·  Note: ${state.lastError}`;
}

// The setup card only appears when something needs doing: site access missing, or first run not finished.
function renderAccess(access, onboarding) {
  let text = "";
  if (access.scope === "none") {
    text = "Focus Alarm cannot see which site you are on yet, so nothing is tracked. Choose what to allow.";
  } else if (access.scope === "partial") {
    text = `Not allowed yet, so not tracked: ${access.missingSites.join(", ")}.`;
  } else if (!onboarding.done) {
    text = "Take a minute to set your list, limit and site access.";
  }
  setupCard.hidden = text === "";
  setupText.textContent = text;
}

async function refresh() {
  const [settings, state] = await Promise.all([getSettings(), getState()]);
  enabled = settings.enabled !== false;

  renderPower(state);

  if (enabled) {
    renderStatus(settings, state);
    const [access, onboarding] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_ACCESS" }),
      chrome.runtime.sendMessage({ type: "GET_ONBOARDING" })
    ]);
    renderAccess(access, onboarding);
  }
}

// ---------- master switch ----------
powerBtn.addEventListener("click", async () => {
  powerBtn.disabled = true;
  try {
    // Turning it off also clears a ringing alarm (background.js wipes it and every open
    // tab's overlay removes itself), so this works even while the alarm is going off.
    await chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: !enabled });
  } finally {
    powerBtn.disabled = false;
  }
  await refresh();
});

// ---------- break ----------
startFocusBtn.addEventListener("click", async () => {
  const state = await getState();
  if (studyActive(state)) {
    await chrome.runtime.sendMessage({ type: "STOP_STUDY_MODE" });
  } else {
    const minutes = parseInt(focusDurationEl.value, 10);
    await chrome.runtime.sendMessage({ type: "START_STUDY_MODE", minutes });
  }
  refresh();
});

// ---------- settings ----------
function openSetup(event) {
  if (event) event.preventDefault();
  // Permission prompts need a full tab: a popup can close the moment Chrome shows its dialog.
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html#access") });
}
setupBtn.addEventListener("click", openSetup);

setupLink.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});

refresh();
setInterval(refresh, 2000); // keeps the status line and the "ringing" label current while the popup is open