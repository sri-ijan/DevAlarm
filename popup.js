// popup.js
// Runs when the user clicks the extension icon.
//
// The big power button is the master switch (settings.enabled, owned by background.js).
// When it is off, #main-content (timer, stats, every setting) is hidden and only the
// switch and a short "paused" note remain.

const ALL_TOPICS = [
  { id: "arrays", label: "Arrays" },
  { id: "strings", label: "Strings" },
  { id: "linkedlist", label: "Linked List" },
  { id: "stacks-queues", label: "Stacks & Queues" },
  { id: "sorting", label: "Sorting" },
  { id: "recursion", label: "Recursion" },
  { id: "hashmaps", label: "Hash Maps" },
  { id: "two-pointers", label: "Two Pointers" },
  { id: "binary-search", label: "Binary Search" },
  { id: "trees", label: "Trees" },
  { id: "dp", label: "Dynamic Programming" },
  { id: "graphs", label: "Graphs" },
  { id: "complexity", label: "Complexity" },
  { id: "oop", label: "OOP" },
  { id: "os", label: "Operating Systems" },
  { id: "dbms", label: "Databases" },
  { id: "networking", label: "Networking" },
  { id: "language-concepts", label: "Language Concepts" }
];

const powerBtn = document.getElementById("power-btn");
const powerTitle = document.getElementById("power-title");
const powerSub = document.getElementById("power-sub");
const offPanel = document.getElementById("off-panel");
const mainContent = document.getElementById("main-content");

const statusText = document.getElementById("status-text");
const statsText = document.getElementById("stats-text");
const focusDurationEl = document.getElementById("focus-duration");
const startFocusBtn = document.getElementById("start-focus-btn");
const sitesInputEl = document.getElementById("sites-input");
const channelsInputEl = document.getElementById("channels-input");
const thresholdInputEl = document.getElementById("threshold-input");
const numqInputEl = document.getElementById("numq-input");
const difficultyInputEl = document.getElementById("difficulty-input");
const topicsListEl = document.getElementById("topics-list");
const snoozesInputEl = document.getElementById("snoozes-input");
const dailySnoozeInputEl = document.getElementById("daily-snooze-input");
const saveBtn = document.getElementById("save-btn");
const saveConfirm = document.getElementById("save-confirm");
const testLockBtn = document.getElementById("test-lock-btn");
const debugBtn = document.getElementById("debug-btn");
const modeButtons = document.querySelectorAll(".mode-btn");
const accessLine = document.getElementById("access-line");
const setupCard = document.getElementById("setup-card");
const setupText = document.getElementById("setup-text");
const setupBtn = document.getElementById("setup-btn");
const setupLink = document.getElementById("setup-link");

let enabled = true;
let formLoaded = false; // fill the form once, so the periodic refresh never overwrites typing

// ---------- topic checkboxes ----------
ALL_TOPICS.forEach((topic) => {
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = topic.id;
  checkbox.id = `topic-${topic.id}`;
  label.appendChild(checkbox);
  label.append(topic.label);
  topicsListEl.appendChild(label);
});

const getSettings = () => chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
const getState = () => chrome.runtime.sendMessage({ type: "GET_STATE" });

// ---------- challenge-count presets ----------
function highlightModeButton(count) {
  modeButtons.forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.count, 10) === count);
  });
}

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    numqInputEl.value = btn.dataset.count;
    highlightModeButton(parseInt(btn.dataset.count, 10));
  });
});

numqInputEl.addEventListener("input", () => {
  highlightModeButton(parseInt(numqInputEl.value, 10));
});

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

function renderStatus(settings, state) {
  if (state.alarmStatus === "ACTIVE") {
    statusText.textContent = "Alarm is ringing on your open tabs.";
  } else if (state.snooze.snoozeUntil && Date.now() < state.snooze.snoozeUntil) {
    const mins = Math.ceil((state.snooze.snoozeUntil - Date.now()) / 60000);
    statusText.textContent = `Snoozed. ${mins} min left.`;
  } else if (studyActive(state)) {
    const mins = Math.ceil((state.studyMode.until - Date.now()) / 60000);
    statusText.textContent = `Study mode on. ${mins} min left. Nothing is being tracked.`;
  } else {
    const accMin = Math.floor(state.tracking.accumulatedMs / 60000);
    statusText.textContent = `Watching. ${accMin} of ${settings.thresholdMinutes} distracted minutes used.`;
  }

  statsText.textContent =
    `Alarms: ${state.stats.alarmsTriggered}  ·  Solved: ${state.stats.problemsSolved}  ·  Snoozes: ${state.stats.snoozes}`;
  startFocusBtn.textContent = studyActive(state) ? "Stop study mode" : "Start study mode";
  focusDurationEl.disabled = studyActive(state);
  if (state.lastError) statsText.textContent += `  ·  Note: ${state.lastError}`;
}

function studyActive(state) {
  return !!(state.studyMode && state.studyMode.until && state.studyMode.until > Date.now());
}

function fillForm(settings) {
  ALL_TOPICS.forEach((topic) => {
    document.getElementById(`topic-${topic.id}`).checked = settings.topics.includes(topic.id);
  });

  sitesInputEl.value = settings.distractingSites.join("\n");
  channelsInputEl.value = settings.studyChannels.join("\n");
  thresholdInputEl.value = settings.thresholdMinutes;
  numqInputEl.value = settings.numQuestions;
  difficultyInputEl.value = settings.difficulty;
  snoozesInputEl.value = settings.maxSnoozes;
  dailySnoozeInputEl.value = settings.dailySnoozeLimit;
  highlightModeButton(settings.numQuestions);
}

function renderAccess(access, onboarding) {
  const label = {
    all: "Overlay shows on: every tab",
    sites: "Overlay shows on: your listed sites only",
    partial: "Overlay shows on: part of your list",
    none: "Site access: not granted"
  }[access.scope];
  accessLine.textContent = label;

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
    if (!formLoaded) {
      fillForm(settings);
      formLoaded = true;
    }
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

// ---------- actions ----------
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

saveBtn.addEventListener("click", async () => {
  const selectedTopics = ALL_TOPICS
    .filter((topic) => document.getElementById(`topic-${topic.id}`).checked)
    .map((topic) => topic.id);

  const toLines = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean);

  const newSettings = {
    topics: selectedTopics, // empty = allow all
    distractingSites: toLines(sitesInputEl.value),
    studyChannels: toLines(channelsInputEl.value),
    thresholdMinutes: Math.max(1, parseInt(thresholdInputEl.value, 10) || 20),
    numQuestions: Math.max(1, parseInt(numqInputEl.value, 10) || 1),
    difficulty: difficultyInputEl.value,
    maxSnoozes: Math.max(0, parseInt(snoozesInputEl.value, 10) || 0),
    dailySnoozeLimit: Math.max(0, parseInt(dailySnoozeInputEl.value, 10) || 0)
  };

  // The master switch is deliberately not part of this payload (background.js ignores it here).
  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: newSettings });

  saveConfirm.hidden = false;
  setTimeout(() => (saveConfirm.hidden = true), 1500);
  refresh();
});

testLockBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "FORCE_TRIGGER_ALARM" });
  window.close(); // so the overlay is visible on the current tab straight away
});

function openSetup(event) {
  if (event) event.preventDefault();
  // Permission prompts need a full tab: a popup can close the moment Chrome shows its dialog.
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html#access") });
}
setupBtn.addEventListener("click", openSetup);
setupLink.addEventListener("click", openSetup);

debugBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
});

refresh();
setInterval(refresh, 2000); // keeps the status line and the "ringing" label current while the popup is open