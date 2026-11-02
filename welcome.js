// welcome.js: first-run setup. Opens automatically after install; also reachable from the popup.
//
// Permission requests (chrome.permissions.request) must be made from a user click, so each
// grant button computes everything it needs synchronously and calls request() first, before
// any other await.

import { normalizeSite, siteToOriginPatterns, ALL_SITES_REQUEST } from "./engine.js";

const $ = (id) => document.getElementById(id);
const sitesEl = $("sites");
const thresholdEl = $("threshold");
const numqEl = $("numq");
const countEl = $("sites-count");
const statusEl = $("access-status");
const msgEl = $("access-msg");
const finishBtn = $("finish");
const finishMsg = $("finish-msg");
const grantAllBtn = $("grant-all");
const grantSitesBtn = $("grant-sites");

const channelsEl = $("channels");
const difficultyEl = $("difficulty");
const snoozesEl = $("snoozes");
const dailySnoozeEl = $("daily-snooze");
const topicsListEl = $("topics-list");
const testLockBtn = $("test-lock-btn");
const debugBtn = $("debug-btn");
const toolsMsg = $("tools-msg");

const send = (message) => chrome.runtime.sendMessage(message);

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

const toLines = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean);

function parsedSites() {
  const seen = new Set();
  const valid = [];
  let ignored = 0;
  for (const line of sitesEl.value.split("\n")) {
    if (!line.trim()) continue;
    const site = normalizeSite(line);
    if (!site) ignored += 1;
    else if (!seen.has(site)) {
      seen.add(site);
      valid.push(site);
    }
  }
  return { valid, ignored };
}

function renderCount() {
  const { valid, ignored } = parsedSites();
  countEl.textContent =
    `${valid.length} site${valid.length === 1 ? "" : "s"} on your list.` +
    (ignored ? ` ${ignored} line${ignored === 1 ? "" : "s"} ignored (not a site address).` : "");
}

async function renderAccess() {
  const access = await send({ type: "GET_ACCESS" });
  if (!access) return;
  const text = {
    all: "Current access: all sites. The alarm will appear on whichever tab you are on.",
    sites: "Current access: your list only. The alarm appears on those sites.",
    partial: `Current access: part of your list. Not yet allowed: ${access.missingSites.join(", ")}.`,
    none: "Current access: none yet. Focus Alarm cannot see which site you are on, so nothing can be tracked until you choose one of the options above."
  }[access.scope];
  statusEl.textContent = text;
}

async function afterGrant(result, label) {
  if (result) {
    await send({ type: "SYNC_ACCESS" });
    msgEl.textContent = `${label} allowed.`;
  } else {
    msgEl.textContent = "Chrome did not grant access. You can try again, or change it later at chrome://extensions.";
  }
  await renderAccess();
}

grantAllBtn.addEventListener("click", async () => {
  // First await in the handler: keeps the user gesture that Chrome requires.
  const granted = await chrome.permissions.request({ origins: ALL_SITES_REQUEST }).catch(() => false);
  await afterGrant(granted, "All sites");
});

grantSitesBtn.addEventListener("click", async () => {
  const { valid } = parsedSites();
  if (valid.length === 0) {
    msgEl.textContent = "Add at least one site to your list first.";
    sitesEl.focus();
    return;
  }
  const origins = valid.flatMap(siteToOriginPatterns);
  const granted = await chrome.permissions.request({ origins }).catch(() => false);
  if (granted) {
    // Choosing "only my list" means giving up broad access if it was granted before.
    await chrome.permissions.remove({ origins: ALL_SITES_REQUEST }).catch(() => {});
  }
  await afterGrant(granted, "Your list");
});

finishBtn.addEventListener("click", async () => {
  const { valid } = parsedSites();
  if (valid.length === 0) {
    finishMsg.textContent = "Your list is empty, so nothing would ever be counted. Add at least one site.";
    sitesEl.focus();
    return;
  }
  finishBtn.disabled = true;
  const saved = await send({
    type: "SET_SETTINGS",
    settings: {
      distractingSites: valid,
      thresholdMinutes: Math.max(1, parseInt(thresholdEl.value, 10) || 20),
      numQuestions: Math.max(1, parseInt(numqEl.value, 10) || 1),
      topics: ALL_TOPICS.filter((t) => $(`topic-${t.id}`).checked).map((t) => t.id), // empty = every topic
      studyChannels: toLines(channelsEl.value),
      difficulty: difficultyEl.value,
      maxSnoozes: Math.max(0, parseInt(snoozesEl.value, 10) || 0),
      dailySnoozeLimit: Math.max(0, parseInt(dailySnoozeEl.value, 10) || 0)
    }
  });
  await send({ type: "FINISH_ONBOARDING" });
  const access = await send({ type: "GET_ACCESS" });
  finishBtn.disabled = false;

  if (!saved || saved.ok === false) {
    finishMsg.textContent = "Could not save. Please try again.";
  } else if (access.scope === "none") {
    finishMsg.textContent = "Saved. Nothing will be tracked until you allow site access in step 4.";
  } else if (access.scope === "partial") {
    finishMsg.textContent = `Saved. These sites are not allowed yet, so they will not be tracked: ${access.missingSites.join(", ")}.`;
  } else {
    finishMsg.textContent = "All set. You can close this tab. To change anything later, click the Focus Alarm icon, then Settings.";
  }
  await renderAccess();
});

testLockBtn.addEventListener("click", async () => {
  await send({ type: "FORCE_TRIGGER_ALARM" });
  toolsMsg.textContent = "Test alarm started. Switch to another tab to see it (it does not appear on this page).";
});

debugBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("debug.html") });
});

sitesEl.addEventListener("input", renderCount);
chrome.permissions.onAdded.addListener(renderAccess);
chrome.permissions.onRemoved.addListener(renderAccess);

(async function init() {
  const settings = await send({ type: "GET_SETTINGS" });
  sitesEl.value = settings.distractingSites.join("\n");
  thresholdEl.value = settings.thresholdMinutes;
  numqEl.value = settings.numQuestions;
  channelsEl.value = settings.studyChannels.join("\n");
  difficultyEl.value = settings.difficulty;
  snoozesEl.value = settings.maxSnoozes;
  dailySnoozeEl.value = settings.dailySnoozeLimit;
  ALL_TOPICS.forEach((t) => { $(`topic-${t.id}`).checked = settings.topics.includes(t.id); });
  renderCount();
  await renderAccess();
  if (location.hash === "#access") $("h-access").scrollIntoView();
})();