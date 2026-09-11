// popup.js
// Runs when the user clicks the extension icon.

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

const statusText = document.getElementById("status-text");
const focusDurationEl = document.getElementById("focus-duration");
const startFocusBtn = document.getElementById("start-focus-btn");
const sitesInputEl = document.getElementById("sites-input");
const channelsInputEl = document.getElementById("channels-input");
const thresholdInputEl = document.getElementById("threshold-input");
const numqInputEl = document.getElementById("numq-input");
const difficultyInputEl = document.getElementById("difficulty-input");
const topicsListEl = document.getElementById("topics-list");
const snoozesInputEl = document.getElementById("snoozes-input");
const saveBtn = document.getElementById("save-btn");
const saveConfirm = document.getElementById("save-confirm");
const statsText = document.getElementById("stats-text");
const testLockBtn = document.getElementById("test-lock-btn");
const modeButtons = document.querySelectorAll(".mode-btn");

// Build topic checkboxes
ALL_TOPICS.forEach((topic) => {
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = topic.id;
  checkbox.id = `topic-${topic.id}`;
  label.appendChild(checkbox);
  label.append(" " + topic.label);
  topicsListEl.appendChild(label);
});

function getSettings() {
  return chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
}
function getState() {
  return chrome.runtime.sendMessage({ type: "GET_STATE" });
}

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

async function loadIntoForm() {
  const settings = await getSettings();

  ALL_TOPICS.forEach((topic) => {
    document.getElementById(`topic-${topic.id}`).checked = settings.topics.includes(topic.id);
  });

  sitesInputEl.value = settings.distractingSites.join("\n");
  channelsInputEl.value = settings.studyChannels.join("\n");
  thresholdInputEl.value = settings.thresholdMinutes;
  numqInputEl.value = settings.numQuestions;
  difficultyInputEl.value = settings.difficulty;
  snoozesInputEl.value = settings.maxSnoozes;
  highlightModeButton(settings.numQuestions);

  const state = await getState();

  if (state.alarmStatus === "ACTIVE") {
    statusText.textContent = "🔒 Alarm is currently active.";
  } else if (state.snooze.snoozeUntil && Date.now() < state.snooze.snoozeUntil) {
    const mins = Math.ceil((state.snooze.snoozeUntil - Date.now()) / 60000);
    statusText.textContent = `😴 Snoozed for ${mins} more minute(s).`;
  } else if (state.focusSession.active && state.focusSession.endsAt > Date.now()) {
    const mins = Math.ceil((state.focusSession.endsAt - Date.now()) / 60000);
    statusText.textContent = `🎯 Focus session running (${mins} min left).`;
  } else {
    const accMin = Math.floor(state.distraction.accumulatedMs / 60000);
    statusText.textContent = `Tracking. ${accMin}/${settings.thresholdMinutes} distracted minutes so far.`;
  }

  statsText.textContent = `Alarms triggered: ${state.stats.alarmsTriggered} · Problems solved: ${state.stats.problemsSolved}`;
}

startFocusBtn.addEventListener("click", async () => {
  const minutes = parseInt(focusDurationEl.value, 10);
  await chrome.runtime.sendMessage({ type: "START_FOCUS_SESSION", minutes });
  loadIntoForm();
});

saveBtn.addEventListener("click", async () => {
  const selectedTopics = ALL_TOPICS
    .filter((topic) => document.getElementById(`topic-${topic.id}`).checked)
    .map((topic) => topic.id);

  const distractingSites = sitesInputEl.value
    .split("\n").map((s) => s.trim()).filter(Boolean);

  const studyChannels = channelsInputEl.value
    .split("\n").map((s) => s.trim()).filter(Boolean);

  const newSettings = {
    topics: selectedTopics, // empty = allow all
    distractingSites,
    studyChannels,
    thresholdMinutes: Math.max(1, parseInt(thresholdInputEl.value, 10) || 20),
    numQuestions: Math.max(1, parseInt(numqInputEl.value, 10) || 1),
    difficulty: difficultyInputEl.value,
    maxSnoozes: Math.max(0, parseInt(snoozesInputEl.value, 10) || 0)
  };

  await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: newSettings });

  saveConfirm.style.display = "block";
  setTimeout(() => (saveConfirm.style.display = "none"), 1500);
});

testLockBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "FORCE_TRIGGER_ALARM" });
  window.close(); // so the user sees the overlay on their current tab immediately
});

document.getElementById("debug-btn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
});

loadIntoForm();
