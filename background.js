// background.js
//
// This is the extension's "brain" — a Manifest V3 service worker. It has NO visible UI.
// Its jobs:
//   1. Every ~1 minute, check whether the user is currently on a distracting site,
//      and whether they're idle (idle time doesn't count).
//   2. Accumulate distracted time. When it crosses the threshold, set the GLOBAL
//      alarm state to ACTIVE. This state lives in chrome.storage.local, so it survives
//      the service worker being suspended/restarted by Chrome (which happens often in MV3).
//   3. Pick a set of challenge questions from the local question bank and store them
//      WITHOUT their answers — the content script (which runs inside web pages) never
//      sees correct answers. Answer-checking happens only here, in the background.
//   4. Handle messages from the popup and the content script: start focus session,
//      snooze, submit answer, report YouTube channel info, etc.
//
// Because alarm state is global (not tied to a tab), every content script on every
// open tab watches chrome.storage.onChanged and shows/hides the overlay accordingly.

const TICK_ALARM_NAME = "focus-alarm-tick";
const TICK_INTERVAL_MINUTES = 1;
const IDLE_THRESHOLD_SECONDS = 60; // user must be inactive this long to count as "idle"
const MAX_TICK_GAP_MS = 60 * 1000; // cap elapsed time per tick (now that heartbeat runs every ~10s, this only matters for genuine gaps like laptop sleep)
const HINT_UNLOCK_ATTEMPTS = 3; // wrong attempts needed before the hint button unlocks
const REVEAL_UNLOCK_ATTEMPTS = 5; // wrong attempts needed before "reveal answer" unlocks

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  distractingSites: [
    "youtube.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "reddit.com",
    "facebook.com",
    "tiktok.com"
  ],
  studyChannels: [], // YouTube channel names the user considers educational (case-insensitive substring match)
  thresholdMinutes: 20,
  difficulty: "mixed", // "easy" | "medium" | "hard" | "mixed"
  numQuestions: 1, // Light=1, Normal=2, Hard=3, or any custom number
  topics: [], // empty = all topics allowed
  maxSnoozes: 2
};

const DEFAULT_STATE = {
  alarmStatus: "INACTIVE", // "INACTIVE" | "ACTIVE"
  distraction: {
    accumulatedMs: 0,
    lastTickAt: null
  },
  snooze: {
    snoozeUntil: null,
    snoozesUsedThisAlarm: 0
  },
  focusSession: {
    active: false,
    endsAt: null
  },
  currentChallenge: null, // { questions: [{id, topic, type, difficulty, question, code}], currentIndex, total }
  stats: {
    alarmsTriggered: 0,
    problemsSolved: 0
  }
};

// In-memory map of tabId -> last known YouTube channel name reported by the content
// script. This is intentionally NOT persisted to storage — it's cheap to rebuild and
// doesn't need to survive a service worker restart (the content script re-reports on load).
const youtubeChannelByTab = {};

// Cache of the question bank so we don't re-fetch on every single tick.
let questionBankCache = null;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function setSettings(newSettings) {
  await chrome.storage.local.set({ settings: newSettings });
}

async function getState() {
  const stored = await chrome.storage.local.get("state");
  const state = stored.state || {};
  // Deep-merge one level so we don't lose defaults for nested objects that were
  // saved before a new field was added.
  return {
    ...DEFAULT_STATE,
    ...state,
    distraction: { ...DEFAULT_STATE.distraction, ...(state.distraction || {}) },
    snooze: { ...DEFAULT_STATE.snooze, ...(state.snooze || {}) },
    focusSession: { ...DEFAULT_STATE.focusSession, ...(state.focusSession || {}) },
    stats: { ...DEFAULT_STATE.stats, ...(state.stats || {}) }
  };
}

async function setState(patch) {
  const current = await getState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ state: next });
  return next;
}

async function getQuestionBank() {
  if (questionBankCache) return questionBankCache;
  const res = await fetch(chrome.runtime.getURL("data/questions.json"));
  questionBankCache = await res.json();
  return questionBankCache;
}

// ---------------------------------------------------------------------------
// Offscreen document (keepalive) -- see offscreen.js for why this exists.
// ---------------------------------------------------------------------------

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingOffscreenPromise = null;
let lastOffscreenError = null; // surfaced in the debug panel so this is diagnosable, not a guessing game

async function ensureOffscreenDocument() {
  try {
    // getContexts is the modern way to check for an existing offscreen document.
    if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"]
      });
      if (existing && existing.length > 0) {
        lastOffscreenError = null;
        return;
      }
    }

    if (creatingOffscreenPromise) {
      await creatingOffscreenPromise;
      return;
    }

    creatingOffscreenPromise = chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
      reasons: ["BLOBS"], // required by the API; our actual purpose is the keepalive heartbeat
      justification:
        "Keeps the background timer responsive so distraction detection keeps working even when no extension page is open."
    });
    await creatingOffscreenPromise;
    creatingOffscreenPromise = null;
    lastOffscreenError = null;
    console.log("[FocusAlarm] offscreen document created successfully.");
  } catch (e) {
    // "Only a single offscreen document may be created" just means one already exists -- fine,
    // clear the error in that specific case. Anything else is a real failure worth surfacing.
    const msg = (e && e.message) || String(e);
    if (msg.includes("Only a single offscreen")) {
      lastOffscreenError = null;
    } else {
      lastOffscreenError = msg;
      console.log("[FocusAlarm] ensureOffscreenDocument FAILED:", msg);
    }
    creatingOffscreenPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get("settings");
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  chrome.alarms.create(TICK_ALARM_NAME, { periodInMinutes: TICK_INTERVAL_MINUTES });
  await ensureOffscreenDocument();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create(TICK_ALARM_NAME, { periodInMinutes: TICK_INTERVAL_MINUTES });
  await ensureOffscreenDocument();
});

// Also try immediately when this script file itself first runs (covers the service
// worker being woken by something other than onInstalled/onStartup, e.g. an alarm
// firing after Chrome discarded an older offscreen document for some reason).
ensureOffscreenDocument();

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return null;
  }
}

function isYouTubeHost(hostname) {
  return hostname === "youtube.com" || hostname === "youtu.be" || hostname === "m.youtube.com";
}

// Internal pages (our own extension's popup/debug page, chrome:// settings, etc.) should
// PAUSE tracking, not reset it. Otherwise simply glancing at the debug panel -- which
// briefly makes itself the "active tab" -- would wipe out accumulated progress.
function isInternalUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://")
  );
}

function matchesList(hostname, list) {
  return list.some((entry) => hostname.includes(entry.replace(/^www\./, "")));
}

async function isIdle() {
  return new Promise((resolve) => {
    chrome.idle.queryState(IDLE_THRESHOLD_SECONDS, (state) => {
      resolve(state !== "active");
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// Decide whether the current active tab counts as "distracting" right now.
// This is where the YouTube study-channel allowlist is applied.
async function evaluateActiveTabDistraction(settings) {
  const tab = await getActiveTab();
  if (!tab || !tab.url) return { isDistracting: false, reason: "no-tab" };

  if (isInternalUrl(tab.url)) {
    // Our own popup/debug page, or a chrome:// page -- pause, don't count as "not distracting".
    return { isDistracting: false, reason: "internal" };
  }

  const hostname = getHostname(tab.url);
  if (!hostname) return { isDistracting: false, reason: "invalid-url" };

  const onBlocklist = matchesList(hostname, settings.distractingSites);
  if (!onBlocklist) return { isDistracting: false, reason: "off-blocklist" };

  if (isYouTubeHost(hostname) && settings.studyChannels.length > 0) {
    const channel = youtubeChannelByTab[tab.id];
    if (channel && matchesList(channel.toLowerCase(), settings.studyChannels.map((c) => c.toLowerCase()))) {
      // Recognized as a study channel -> not distracting.
      return { isDistracting: false, reason: "study-channel" };
    }
  }

  return { isDistracting: true, reason: "on-blocklist" };
}

// ---------------------------------------------------------------------------
// Challenge selection (background only — answers never leave this file)
// ---------------------------------------------------------------------------

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function selectChallengeQuestions(settings) {
  const bank = await getQuestionBank();

  let pool = bank;
  if (settings.difficulty !== "mixed") {
    pool = pool.filter((q) => q.difficulty === settings.difficulty);
  }
  if (settings.topics.length > 0) {
    pool = pool.filter((q) => settings.topics.includes(q.topic));
  }
  if (pool.length === 0) pool = bank; // fallback so we never get stuck with zero questions

  const shuffled = shuffle(pool);
  const count = Math.min(settings.numQuestions, shuffled.length);
  return shuffled.slice(0, count);
}

// Strip the answer field before this leaves the background context.
function toPublicQuestion(q) {
  const { answer, ...rest } = q;
  return rest;
}

function normalizeAnswer(str) {
  return String(str).trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Alarm lifecycle
// ---------------------------------------------------------------------------

async function triggerAlarm() {
  const state = await getState();
  if (state.alarmStatus === "ACTIVE") return; // already active, don't double-trigger

  const settings = await getSettings();
  const questions = await selectChallengeQuestions(settings);

  await setState({
    alarmStatus: "ACTIVE",
    currentChallenge: {
      questions,
      currentIndex: 0,
      total: questions.length,
      attempts: 0,
      revealedCount: 0
    },
    distraction: { accumulatedMs: 0, lastTickAt: null },
    snooze: { snoozeUntil: null, snoozesUsedThisAlarm: 0 },
    stats: { ...state.stats, alarmsTriggered: state.stats.alarmsTriggered + 1 }
  });
}

async function clearAlarm() {
  await setState({
    alarmStatus: "INACTIVE",
    currentChallenge: null,
    distraction: { accumulatedMs: 0, lastTickAt: null },
    snooze: { snoozeUntil: null, snoozesUsedThisAlarm: 0 }
  });
}

// ---------------------------------------------------------------------------
// Main tick — runs roughly every minute, but uses real timestamps so it's not
// artificially locked to whole-minute accuracy, and so it self-corrects after
// the service worker was suspended for a while.
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== TICK_ALARM_NAME) return;
  await tick();
});

async function tick() {
  // Self-heal: if the offscreen keepalive document was ever closed for any reason,
  // this recreates it. Cheap (existence check short-circuits) so safe to call every tick.
  await ensureOffscreenDocument();

  const settings = await getSettings();
  const state = await getState();

  // Alarm already ringing -- don't keep accumulating, wait for it to be solved/snoozed.
  if (state.alarmStatus === "ACTIVE") {
    console.log("[FocusAlarm] tick: alarm already ACTIVE, skipping.");
    return;
  }

  // Snoozed -- skip until the snooze period passes.
  if (state.snooze.snoozeUntil && Date.now() < state.snooze.snoozeUntil) {
    console.log("[FocusAlarm] tick: snoozed until", new Date(state.snooze.snoozeUntil).toLocaleTimeString());
    return;
  }

  const now = Date.now();
  const lastTickAt = state.distraction.lastTickAt || now;
  const elapsedMs = Math.min(now - lastTickAt, MAX_TICK_GAP_MS);

  const idle = await isIdle();
  const { isDistracting, reason } = await evaluateActiveTabDistraction(settings);
  const tab = await getActiveTab();

  console.log("[FocusAlarm] tick:", {
    url: tab ? tab.url : null,
    isDistracting,
    reason,
    idle,
    elapsedMs,
    accumulatedMsBefore: state.distraction.accumulatedMs
  });

  if (reason === "internal") {
    // User is looking at our own popup/debug page, or a chrome:// page.
    // PAUSE tracking (don't reset, don't accumulate) and don't advance lastTickAt,
    // so the "away" time isn't counted against them once they return to a real tab.
    console.log("[FocusAlarm] active tab is internal -- pausing (state preserved).");
    return;
  }

  if (isDistracting && !idle) {
    const newAccumulated = state.distraction.accumulatedMs + elapsedMs;
    const thresholdMs = settings.thresholdMinutes * 60 * 1000;

    console.log(`[FocusAlarm] accumulated ${Math.round(newAccumulated / 1000)}s / threshold ${Math.round(thresholdMs / 1000)}s`);

    if (newAccumulated >= thresholdMs) {
      console.log("[FocusAlarm] threshold reached -- triggering alarm.");
      await triggerAlarm();
      return;
    }

    await setState({ distraction: { accumulatedMs: newAccumulated, lastTickAt: now } });
  } else {
    // Not distracting right now (wrong site, studying a real channel, or idle) --
    // reset the counter. Simple v1 behavior: no partial credit/decay.
    if (state.distraction.accumulatedMs !== 0) {
      console.log("[FocusAlarm] not distracting/idle -- resetting accumulated time.");
    }
    await setState({ distraction: { accumulatedMs: 0, lastTickAt: now } });
  }
}

// ---------------------------------------------------------------------------
// Messages from popup.js and content-script.js
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_SETTINGS": {
        sendResponse(await getSettings());
        break;
      }

      case "SET_SETTINGS": {
        await setSettings(message.settings);
        sendResponse({ ok: true });
        break;
      }

      case "GET_STATE": {
        sendResponse(await getState());
        break;
      }

      case "START_FOCUS_SESSION": {
        const endsAt = Date.now() + message.minutes * 60 * 1000;
        await setState({ focusSession: { active: true, endsAt } });
        sendResponse({ ok: true, endsAt });
        break;
      }

      case "SUBMIT_ANSWER": {
        const state = await getState();
        if (!state.currentChallenge || state.alarmStatus !== "ACTIVE") {
          sendResponse({ ok: false, reason: "No active challenge." });
          break;
        }

        const bank = await getQuestionBank();
        const currentQ = state.currentChallenge.questions[state.currentChallenge.currentIndex];
        const fullQ = bank.find((q) => q.id === currentQ.id);

        const correct = !!fullQ && normalizeAnswer(fullQ.answer) === normalizeAnswer(message.answer);

        if (!correct) {
          const newAttempts = (state.currentChallenge.attempts || 0) + 1;
          await setState({
            currentChallenge: { ...state.currentChallenge, attempts: newAttempts }
          });
          sendResponse({
            correct: false,
            attempts: newAttempts,
            hintUnlocked: newAttempts >= HINT_UNLOCK_ATTEMPTS,
            revealUnlocked: newAttempts >= REVEAL_UNLOCK_ATTEMPTS
          });
          break;
        }

        const nextIndex = state.currentChallenge.currentIndex + 1;
        const isDone = nextIndex >= state.currentChallenge.total;

        if (isDone) {
          const solvedCount = state.currentChallenge.total;
          await clearAlarm();
          const latest = await getState();
          await setState({
            stats: { ...latest.stats, problemsSolved: latest.stats.problemsSolved + solvedCount }
          });
          sendResponse({ correct: true, done: true });
        } else {
          await setState({
            currentChallenge: { ...state.currentChallenge, currentIndex: nextIndex, attempts: 0 }
          });
          sendResponse({ correct: true, done: false });
        }
        break;
      }

      case "GET_HINT": {
        const state = await getState();
        if (!state.currentChallenge) {
          sendResponse({ ok: false, reason: "No active challenge." });
          break;
        }
        const attempts = state.currentChallenge.attempts || 0;
        if (attempts < HINT_UNLOCK_ATTEMPTS) {
          sendResponse({ ok: false, reason: "Hint is still locked." });
          break;
        }
        const bank = await getQuestionBank();
        const currentQ = state.currentChallenge.questions[state.currentChallenge.currentIndex];
        const fullQ = bank.find((q) => q.id === currentQ.id);
        sendResponse({ ok: true, hint: (fullQ && fullQ.hint) || "No hint available for this one -- take your best guess." });
        break;
      }

      case "REVEAL_ANSWER": {
        const state = await getState();
        if (!state.currentChallenge || state.alarmStatus !== "ACTIVE") {
          sendResponse({ ok: false, reason: "No active challenge." });
          break;
        }
        const attempts = state.currentChallenge.attempts || 0;
        if (attempts < REVEAL_UNLOCK_ATTEMPTS) {
          sendResponse({ ok: false, reason: "Reveal is still locked." });
          break;
        }

        const bank = await getQuestionBank();
        const currentQ = state.currentChallenge.questions[state.currentChallenge.currentIndex];
        const fullQ = bank.find((q) => q.id === currentQ.id);
        const revealedAnswer = fullQ ? fullQ.answer : "";

        const nextIndex = state.currentChallenge.currentIndex + 1;
        const isDone = nextIndex >= state.currentChallenge.total;
        const newRevealedCount = (state.currentChallenge.revealedCount || 0) + 1;

        if (isDone) {
          await clearAlarm();
          sendResponse({ ok: true, answer: revealedAnswer, done: true });
        } else {
          await setState({
            currentChallenge: {
              ...state.currentChallenge,
              currentIndex: nextIndex,
              attempts: 0,
              revealedCount: newRevealedCount
            }
          });
          sendResponse({ ok: true, answer: revealedAnswer, done: false });
        }
        break;
      }

      case "SNOOZE": {
        const settings = await getSettings();
        const state = await getState();

        if (state.snooze.snoozesUsedThisAlarm >= settings.maxSnoozes) {
          sendResponse({ ok: false, reason: "No snoozes left for this alarm." });
          break;
        }

        const snoozeUntil = Date.now() + message.minutes * 60 * 1000;
        await setState({
          alarmStatus: "INACTIVE",
          currentChallenge: null,
          distraction: { accumulatedMs: 0, lastTickAt: null },
          snooze: {
            snoozeUntil,
            snoozesUsedThisAlarm: state.snooze.snoozesUsedThisAlarm + 1
          }
        });
        sendResponse({ ok: true });
        break;
      }

      case "FORCE_TRIGGER_ALARM": {
        // Used by the "Test alarm now" button in the popup, for trying out the flow
        // without waiting for real distraction detection.
        await triggerAlarm();
        sendResponse({ ok: true });
        break;
      }

      case "FORCE_TICK": {
        // Used by the debug page's "Force tick now" button -- runs one real cycle of
        // the detection/timer logic immediately, instead of waiting up to 1 minute.
        await tick();
        sendResponse({ ok: true });
        break;
      }

      case "GET_DEBUG_INFO": {
        const settings = await getSettings();
        const state = await getState();
        const tab = await getActiveTab();
        const idle = await isIdle();
        const { isDistracting, reason } = await evaluateActiveTabDistraction(settings);

        let offscreenActive = false;
        try {
          if (chrome.runtime.getContexts) {
            const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
            offscreenActive = !!(contexts && contexts.length > 0);
          }
        } catch (e) {
          // leave offscreenActive false, lastOffscreenError already captures the real reason if any
        }

        sendResponse({
          now: Date.now(),
          activeTabUrl: tab ? tab.url : null,
          hostname: tab ? getHostname(tab.url) : null,
          isDistracting,
          distractionReason: reason || null,
          idle,
          thresholdMinutes: settings.thresholdMinutes,
          alarmStatus: state.alarmStatus,
          distraction: state.distraction,
          snooze: state.snooze,
          focusSession: state.focusSession,
          youtubeChannelForActiveTab: tab ? youtubeChannelByTab[tab.id] || null : null,
          offscreenActive,
          offscreenError: lastOffscreenError
        });
        break;
      }

      case "RESET_STATE": {
        // Wipes runtime state back to defaults -- handy for re-running tests from scratch.
        await chrome.storage.local.set({ state: DEFAULT_STATE });
        sendResponse({ ok: true });
        break;
      }

      case "HEARTBEAT_TICK": {
        // Sent every ~10s by offscreen.js. This is now the PRIMARY detection trigger --
        // it runs on a page-context timer that isn't subject to service-worker suspension,
        // so it works reliably even with zero extension pages open and zero tab switches.
        await tick();
        sendResponse({ ok: true });
        break;
      }

      case "YOUTUBE_CHANNEL_INFO": {
        if (sender.tab && sender.tab.id != null) {
          youtubeChannelByTab[sender.tab.id] = message.channel || "";
        }
        sendResponse({ ok: true });
        break;
      }

      case "GET_PUBLIC_CHALLENGE": {
        // Used by content-script to render questions WITHOUT ever seeing answers.
        const state = await getState();
        if (!state.currentChallenge) {
          sendResponse(null);
          break;
        }
        const q = state.currentChallenge.questions[state.currentChallenge.currentIndex];
        const attempts = state.currentChallenge.attempts || 0;
        sendResponse({
          question: toPublicQuestion(q),
          index: state.currentChallenge.currentIndex,
          total: state.currentChallenge.total,
          attempts,
          hintUnlocked: attempts >= HINT_UNLOCK_ATTEMPTS,
          revealUnlocked: attempts >= REVEAL_UNLOCK_ATTEMPTS,
          hintUnlockAt: HINT_UNLOCK_ATTEMPTS,
          revealUnlockAt: REVEAL_UNLOCK_ATTEMPTS
        });
        break;
      }

      default:
        sendResponse({ ok: false, reason: "Unknown message type." });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});

// Clean up per-tab channel cache when a tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  delete youtubeChannelByTab[tabId];
});

// ---------------------------------------------------------------------------
// Backup wake triggers -- don't rely on the periodic alarm alone.
// Chrome reliably delivers these core browsing events to a suspended service
// worker (that's the whole point of the MV3 event model), so hooking tick() to
// them means detection keeps working even in the rare case an alarm tick is late.
// tick() is cheap and already has early-return guards, so calling it more often
// than strictly necessary is harmless.
// ---------------------------------------------------------------------------

chrome.tabs.onActivated.addListener(() => {
  tick();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    tick();
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    tick();
  }
});

if (chrome.idle && chrome.idle.onStateChanged) {
  chrome.idle.onStateChanged.addListener(() => {
    tick();
  });
}

