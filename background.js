// background.js  (ES module service worker, see "background.type" in manifest.json)
//
// Wiring between Chrome and the pure logic in engine.js. Design rules:
//
//  * Nothing here relies on the service worker staying alive. Every observation re-reads
//    state from chrome.storage, credits elapsed time using timestamps, writes it back, and
//    schedules the next wake-up with chrome.alarms.
//  * Two alarms: a one-shot "threshold" alarm set for the moment the distraction limit
//    would be reached (precise), and a 1-minute "tick" backstop (catches everything else).
//    Browser events (tab switch, navigation, window focus, idle change) also trigger an
//    observation, so the timer is correct even when an alarm fires late.
//  * All reads/writes of state go through one promise queue, so two events arriving at the
//    same moment can never interleave and lose or double-count time.
//  * Only the PUBLIC fields of a question are ever stored in state. Answers, accepted
//    variants and hints are looked up from data/questions.json at check time.
//  * Every message is checked: sender must be this extension, and content scripts may only
//    send the few message types an overlay needs.

import {
  HINT_UNLOCK_ATTEMPTS,
  REVEAL_UNLOCK_ATTEMPTS,
  DEFAULT_STATE,
  sanitizeSettings,
  sanitizeState,
  advanceTracking,
  nextThresholdAt,
  topHost,
  classify,
  freshTracking,
  snoozeCheck,
  applySnooze,
  selectQuestions,
  toPublicQuestion,
  isCorrectAnswer,
  canAttempt,
  isAuthorized,
  accessStatus,
  OVERLAY_SCRIPT_ID
} from "./engine.js";

const TICK_ALARM = "focus-alarm-tick";
const THRESHOLD_ALARM = "focus-alarm-threshold";
const SNOOZE_ALARM = "focus-alarm-snooze-end";
const CHANNELS_KEY = "ytChannels"; // chrome.storage.session: tabId -> channel name
const LAST_OBS_KEY = "lastObservation"; // chrome.storage.session, for the debug page only

// ---------------------------------------------------------------------------
// Serialisation: everything that touches state runs one at a time.
// ---------------------------------------------------------------------------

let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(() => fn());
  queue = run.catch(() => {}); // a failure must not block the next job
  return run;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
// "tracking" is stored under its own key. It changes on every observation, and content
// scripts in every tab listen to the "state" key, so keeping them apart means open tabs are
// only woken when something they care about (the alarm itself) actually changes.

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return sanitizeSettings(stored.settings);
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

async function loadState() {
  const stored = await chrome.storage.local.get(["state", "tracking"]);
  const base = stored.state && typeof stored.state === "object" ? stored.state : {};
  return sanitizeState({ ...base, tracking: stored.tracking });
}

async function saveState(state) {
  const { tracking, ...rest } = state;
  const current = await chrome.storage.local.get("state");
  const toSet = { tracking };
  if (JSON.stringify(current.state) !== JSON.stringify(rest)) toSet.state = rest;
  await chrome.storage.local.set(toSet);
}

async function loadChannels() {
  try {
    const stored = await chrome.storage.session.get(CHANNELS_KEY);
    return stored[CHANNELS_KEY] && typeof stored[CHANNELS_KEY] === "object" ? stored[CHANNELS_KEY] : {};
  } catch (e) {
    return {};
  }
}

async function saveChannels(map) {
  try {
    await chrome.storage.session.set({ [CHANNELS_KEY]: map });
  } catch (e) {
    /* session storage unavailable: classification simply falls back to "unknown channel" */
  }
}

let bankPromise = null;
function loadBank() {
  if (!bankPromise) {
    bankPromise = fetch(chrome.runtime.getURL("data/questions.json"))
      .then((res) => {
        if (!res.ok) throw new Error(`Question bank request failed (${res.status}).`);
        return res.json();
      })
      .then((bank) => {
        if (!Array.isArray(bank)) throw new Error("Question bank is not a list.");
        return bank;
      })
      .catch((e) => {
        bankPromise = null; // allow a retry on the next alarm
        throw e;
      });
  }
  return bankPromise;
}

function errMsg(e) {
  return String((e && e.message) || e).slice(0, 300);
}

// ---------------------------------------------------------------------------
// Alarms and idle detection (idempotent: safe to call on every worker start)
// ---------------------------------------------------------------------------

async function ensureBackstopAlarm() {
  const existing = await chrome.alarms.get(TICK_ALARM);
  if (!existing) chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
}

async function applyIdleInterval(settings) {
  try {
    chrome.idle.setDetectionInterval(settings.idleSeconds);
  } catch (e) {
    /* value out of range: Chrome keeps its previous interval */
  }
}

async function scheduleThresholdAlarm(state, settings, now) {
  const when = nextThresholdAt(state.tracking, now, settings);
  if (when == null || state.alarmStatus === "ACTIVE" || !settings.enabled) {
    await chrome.alarms.clear(THRESHOLD_ALARM);
  } else {
    chrome.alarms.create(THRESHOLD_ALARM, { when }); // same name replaces: never duplicated
  }
}

// ---------------------------------------------------------------------------
// Host access and the overlay script
// ---------------------------------------------------------------------------
// The manifest has no static content script and no required host permission. The user
// grants access (all sites, or just their blocklist) from the welcome page or the popup, and
// this function makes the registered overlay script match exactly what was granted.

async function grantedOrigins() {
  try {
    const all = await chrome.permissions.getAll();
    return (all && all.origins) || [];
  } catch (e) {
    return [];
  }
}

function overlayScriptDef(matches) {
  return { id: OVERLAY_SCRIPT_ID, js: ["content-script.js"], matches, runAt: "document_idle", allFrames: false, persistAcrossSessions: true };
}

/** One-shot wake-up at the end of a snooze, so tracking resumes without waiting for another event. */
async function scheduleSnoozeEndAlarm(state, now) {
  if (state.snooze.snoozeUntil && state.snooze.snoozeUntil > now && state.alarmStatus !== "ACTIVE") {
    chrome.alarms.create(SNOOZE_ALARM, { when: state.snooze.snoozeUntil }); // same name replaces: never duplicated
  } else {
    await chrome.alarms.clear(SNOOZE_ALARM);
  }
}

/** Must run inside the queue. Idempotent. `inject` also loads the script into tabs that are already open. */
async function syncOverlayScriptLocked(inject) {
  const settings = await loadSettings();
  const access = accessStatus(await grantedOrigins(), settings.distractingSites);
  let error = null;

  let current = null;
  try {
    [current] = await chrome.scripting.getRegisteredContentScripts({ ids: [OVERLAY_SCRIPT_ID] });
  } catch (e) {
    current = null;
  }

  try {
    if (access.matches.length === 0) {
      if (current) await chrome.scripting.unregisterContentScripts({ ids: [OVERLAY_SCRIPT_ID] });
      return { ...access, error };
    }
    const sameMatches = current && JSON.stringify([...current.matches].sort()) === JSON.stringify([...access.matches].sort());
    if (!current) await chrome.scripting.registerContentScripts([overlayScriptDef(access.matches)]);
    else if (!sameMatches) await chrome.scripting.updateContentScripts([overlayScriptDef(access.matches)]);

    if (inject || !current || !sameMatches) {
      // The content script guards against being loaded twice, so re-injecting is harmless.
      const tabs = await chrome.tabs.query({ url: access.matches });
      for (const tab of tabs) {
        if (tab.id == null) continue;
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] });
        } catch (e) {
          /* tab navigated away, is discarded, or is a page Chrome does not allow scripts in */
        }
      }
    }
  } catch (e) {
    error = errMsg(e);
    console.log("[FocusAlarm] overlay script sync failed:", error);
  }
  return { ...access, error };
}

// ---------------------------------------------------------------------------
// Observation: "what is the user doing right now?"
// ---------------------------------------------------------------------------

function queryIdle(seconds) {
  return new Promise((resolve) => {
    try {
      chrome.idle.queryState(seconds, (state) => resolve(state || "active"));
    } catch (e) {
      resolve("active");
    }
  });
}

async function readBrowserContext(settings) {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (e) {
    tab = null;
  }
  let windowFocused = false;
  try {
    const win = await chrome.windows.getLastFocused();
    windowFocused = !!(win && win.focused);
  } catch (e) {
    windowFocused = false;
  }
  const idleState = await queryIdle(settings.idleSeconds);
  const channels = tab ? await loadChannels() : {};
  return {
    tab: tab ? { url: tab.url || "", audible: tab.audible === true } : null,
    tabId: tab ? tab.id : null,
    windowFocused,
    idleState,
    channel: tab && channels[tab.id] ? channels[tab.id] : null
  };
}

/** Must run inside the queue. */
async function observeLocked(reason) {
  const settings = await loadSettings();
  const state = await loadState();
  const now = Date.now();

  if (!settings.enabled || state.alarmStatus === "ACTIVE") {
    await chrome.alarms.clear(THRESHOLD_ALARM);
    await chrome.alarms.clear(SNOOZE_ALARM);
    return state;
  }

  if (state.studyMode.until && state.studyMode.until <= now) state.studyMode.until = null;
  if (state.snooze.snoozeUntil && state.snooze.snoozeUntil <= now) state.snooze.snoozeUntil = null;

  const ctx = await readBrowserContext(settings);
  const verdict = classify({
    tab: ctx.tab,
    windowFocused: ctx.windowFocused,
    idleState: ctx.idleState,
    channel: ctx.channel,
    settings,
    now,
    snoozeUntil: state.snooze.snoozeUntil,
    studyUntil: state.studyMode.until
  });

  try {
    await chrome.storage.session.set({
      [LAST_OBS_KEY]: { at: now, why: reason, kind: verdict.kind, reason: verdict.reason, hostname: verdict.hostname, channel: ctx.channel, idleState: ctx.idleState, windowFocused: ctx.windowFocused, url: ctx.tab ? ctx.tab.url : null }
    });
  } catch (e) { /* debug info only */ }

  // Chrome reports "idle" only after idleSeconds without input; hand that stretch back.
  // A locked screen is not refunded: locking is an action, so there was no idle lead-in.
  const idleRefundMs = verdict.reason === "idle" && ctx.idleState === "idle" ? settings.idleSeconds * 1000 : 0;
  const { tracking, crossed } = advanceTracking(state.tracking, { ...verdict, idleRefundMs }, now, settings);
  state.tracking = tracking;

  if (crossed) {
    await ringAlarmLocked(state, settings, now);
    return state;
  }

  await saveState(state);
  await scheduleThresholdAlarm(state, settings, now);
  await scheduleSnoozeEndAlarm(state, now);
  return state;
}

let observePending = false;
/** Coalesces bursts of browser events into one observation. */
function observe(reason) {
  if (observePending) return Promise.resolve();
  observePending = true;
  return serialize(() => {
    observePending = false;
    return observeLocked(reason);
  }).catch((e) => console.log("[FocusAlarm] observe failed:", errMsg(e)));
}

// ---------------------------------------------------------------------------
// Alarm lifecycle
// ---------------------------------------------------------------------------

/** Must run inside the queue. `state` is the freshly loaded, already-advanced state. */
async function ringAlarmLocked(state, settings, now) {
  if (state.alarmStatus === "ACTIVE") return;

  // Empty host = the alarm was started manually (the popup's "Test alarm now").
  const host = topHost(state.tracking.byHost) || state.tracking.lastHost || "";
  const minutes = host ? Math.max(1, Math.round(state.tracking.accumulatedMs / 60000)) : 0;

  let picked = null;
  try {
    picked = selectQuestions(await loadBank(), settings);
  } catch (e) {
    state.lastError = `Could not load questions: ${errMsg(e)}`;
  }

  if (!picked || picked.questions.length === 0) {
    // Fail open: an alarm that cannot be solved must never lock the user's browser.
    state.lastError = state.lastError || "No usable question matched your settings, so the alarm was skipped.";
    state.stats.failOpen += 1;
    state.tracking = freshTracking(now);
    await saveState(state);
    await chrome.alarms.clear(THRESHOLD_ALARM);
    return;
  }

  state.alarmStatus = "ACTIVE";
  state.currentChallenge = {
    questions: picked.questions.map((q) => toPublicQuestion(q, Math.random, true)),
    currentIndex: 0,
    total: picked.questions.length,
    attempts: 0,
    revealedCount: 0,
    lastAttemptAt: null,
    relaxedDifficulty: picked.relaxedDifficulty
  };
  state.trigger = { hostname: host, minutes };
  state.tracking = freshTracking(now);
  state.snooze.snoozeUntil = null;
  state.stats.alarmsTriggered += 1;
  await saveState(state);
  await chrome.alarms.clear(THRESHOLD_ALARM);
}

/** Alarm finished (solved, revealed, skipped or disabled). */
function endAlarm(state, now, { resetSnoozes }) {
  state.alarmStatus = "INACTIVE";
  state.currentChallenge = null;
  state.trigger = null;
  state.tracking = freshTracking(now);
  state.snooze.snoozeUntil = null;
  if (resetSnoozes) state.snooze.usedThisEpisode = 0;
}

/** Moves to the next question, or ends the alarm after the last one. */
function advanceChallenge(state, now, how) {
  const ch = state.currentChallenge;
  if (how === "solved") state.stats.problemsSolved += 1;
  if (how === "revealed") state.stats.problemsRevealed += 1;

  const next = ch.currentIndex + 1;
  if (next >= ch.total) {
    endAlarm(state, now, { resetSnoozes: true });
    return { done: true };
  }
  state.currentChallenge = {
    ...ch,
    currentIndex: next,
    attempts: 0,
    revealedCount: ch.revealedCount + (how === "revealed" ? 1 : 0),
    lastAttemptAt: null
  };
  return { done: false };
}

async function currentFullQuestion(state) {
  const ch = state.currentChallenge;
  const pub = ch.questions[ch.currentIndex];
  const bank = await loadBank();
  return bank.find((q) => q.id === pub.id) || null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function publicChallenge(state, settings, now) {
  const ch = state.currentChallenge;
  const attempts = ch.attempts;
  return {
    question: ch.questions[ch.currentIndex],
    index: ch.currentIndex,
    total: ch.total,
    attempts,
    hintUnlocked: attempts >= HINT_UNLOCK_ATTEMPTS,
    revealUnlocked: attempts >= REVEAL_UNLOCK_ATTEMPTS,
    hintUnlockAt: HINT_UNLOCK_ATTEMPTS,
    revealUnlockAt: REVEAL_UNLOCK_ATTEMPTS,
    trigger: state.trigger,
    snoozesLeft: Math.max(0, settings.maxSnoozes - state.snooze.usedThisEpisode)
  };
}

async function handle(message, sender) {
  const now = Date.now();

  switch (message.type) {
    case "GET_SETTINGS":
      return loadSettings();

    case "GET_STATE":
      return loadState();

    case "SET_SETTINGS": {
      const current = await loadSettings();
      const incoming = message.settings && typeof message.settings === "object" ? message.settings : {};
      // The master switch only changes through SET_ENABLED.
      const next = sanitizeSettings({ ...current, ...incoming, enabled: current.enabled });
      await saveSettings(next);
      await applyIdleInterval(next);
      const access = await syncOverlayScriptLocked(false);
      await observeLocked("settings-changed");
      return { ok: true, settings: next, access };
    }

    case "SET_ENABLED": {
      const settings = await loadSettings();
      const enabled = message.enabled === true;
      await saveSettings({ ...settings, enabled });
      const state = await loadState();
      if (!enabled) {
        // Works even while an alarm is ringing: every open tab's overlay removes itself
        // through storage.onChanged. This is deliberate (see README "Turning it off").
        endAlarm(state, now, { resetSnoozes: true });
        state.studyMode.until = null;
        await saveState(state);
        await chrome.alarms.clear(THRESHOLD_ALARM);
        await chrome.alarms.clear(SNOOZE_ALARM);
      } else {
        state.tracking = freshTracking(now);
        await saveState(state);
        await observeLocked("enabled"); // start counting right away if the user is on a listed site
      }
      return { ok: true, enabled };
    }

    case "START_FOCUS_SESSION": // kept for popup compatibility: starts study mode
    case "START_STUDY_MODE": {
      const minutes = Number(message.minutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) return { ok: false, reason: "Minutes must be between 1 and 240." };
      const state = await loadState();
      state.studyMode.until = now + Math.round(minutes) * 60000;
      await saveState(state);
      await observeLocked("study-mode-started");
      return { ok: true, until: state.studyMode.until };
    }

    case "STOP_STUDY_MODE": {
      const state = await loadState();
      state.studyMode.until = null;
      await saveState(state);
      await observeLocked("study-mode-stopped");
      return { ok: true };
    }

    case "GET_ACCESS": {
      const settings = await loadSettings();
      return accessStatus(await grantedOrigins(), settings.distractingSites);
    }

    case "SYNC_ACCESS":
      return syncOverlayScriptLocked(true);

    case "GET_ONBOARDING": {
      const stored = await chrome.storage.local.get("onboarding");
      return { done: !!(stored.onboarding && stored.onboarding.done === true) };
    }

    case "FINISH_ONBOARDING":
      await chrome.storage.local.set({ onboarding: { done: true, at: now } });
      return { ok: true };

    case "GET_PUBLIC_CHALLENGE": {
      const state = await loadState();
      if (state.alarmStatus !== "ACTIVE" || !state.currentChallenge) return null;
      return publicChallenge(state, await loadSettings(), now);
    }

    case "SUBMIT_ANSWER": {
      const state = await loadState();
      const ch = state.currentChallenge;
      if (state.alarmStatus !== "ACTIVE" || !ch) return { ok: false, reason: "No active challenge." };
      if (typeof message.answer !== "string") return { ok: false, reason: "Invalid answer." };
      if (!canAttempt(ch, now)) return { ok: false, reason: "Too fast. Wait a second and try again." };

      let fullQ = null;
      try {
        fullQ = await currentFullQuestion(state);
      } catch (e) {
        state.lastError = `Could not load questions: ${errMsg(e)}`;
      }

      if (!fullQ) {
        // The question can no longer be checked (bank changed or failed to load). Never trap the user.
        state.stats.failOpen += 1;
        state.lastError = state.lastError || "A question was missing from the bank, so it was skipped.";
        const res = advanceChallenge(state, now, "skipped");
        await saveState(state);
        return { ok: true, correct: true, done: res.done, skipped: true };
      }

      if (isCorrectAnswer(fullQ, message.answer)) {
        const res = advanceChallenge(state, now, "solved");
        await saveState(state);
        return { ok: true, correct: true, done: res.done };
      }

      state.currentChallenge = { ...ch, attempts: ch.attempts + 1, lastAttemptAt: now };
      await saveState(state);
      const attempts = state.currentChallenge.attempts;
      return {
        ok: true,
        correct: false,
        attempts,
        hintUnlocked: attempts >= HINT_UNLOCK_ATTEMPTS,
        revealUnlocked: attempts >= REVEAL_UNLOCK_ATTEMPTS
      };
    }

    case "GET_HINT": {
      const state = await loadState();
      const ch = state.currentChallenge;
      if (state.alarmStatus !== "ACTIVE" || !ch) return { ok: false, reason: "No active challenge." };
      if (ch.attempts < HINT_UNLOCK_ATTEMPTS) return { ok: false, reason: "Hint is still locked." };
      const fullQ = await currentFullQuestion(state).catch(() => null);
      return { ok: true, hint: (fullQ && fullQ.hint) || "No hint for this one. Take your best guess." };
    }

    case "REVEAL_ANSWER": {
      const state = await loadState();
      const ch = state.currentChallenge;
      if (state.alarmStatus !== "ACTIVE" || !ch) return { ok: false, reason: "No active challenge." };
      if (ch.attempts < REVEAL_UNLOCK_ATTEMPTS) return { ok: false, reason: "Reveal is still locked." };
      const fullQ = await currentFullQuestion(state).catch(() => null);
      const answer = fullQ ? fullQ.answer : "";
      const res = advanceChallenge(state, now, "revealed");
      await saveState(state);
      return { ok: true, answer, done: res.done };
    }

    case "SNOOZE": {
      const state = await loadState();
      if (state.alarmStatus !== "ACTIVE") return { ok: false, reason: "There is no alarm to snooze." };
      const settings = await loadSettings();
      const minutes = Number(message.minutes);
      const check = snoozeCheck(state.snooze, settings, minutes, now);
      if (!check.ok) return { ok: false, reason: check.reason };

      endAlarm(state, now, { resetSnoozes: false }); // clears the alarm, keeps usage counters
      state.snooze = applySnooze(state.snooze, minutes, now); // then starts the snooze
      state.stats.snoozes += 1;
      await saveState(state);
      await scheduleSnoozeEndAlarm(state, now);
      return { ok: true };
    }

    case "RECOVER_ALARM": {
      // Escape hatch for a broken overlay (question cannot be shown or checked). It only works
      // when the current question is genuinely unavailable, so it cannot be used to skip a
      // working question.
      const state = await loadState();
      if (state.alarmStatus !== "ACTIVE") return { ok: true, nothingToDo: true };
      let available = false;
      try {
        available = !!state.currentChallenge && !!(await currentFullQuestion(state));
      } catch (e) {
        available = false;
      }
      if (available) {
        return {
          ok: false,
          reason: "The question is available, so this alarm cannot be dismissed that way. Solve it, snooze it, or use the switch in the Focus Alarm popup."
        };
      }
      endAlarm(state, now, { resetSnoozes: true });
      state.stats.failOpen += 1;
      state.lastError = "The alarm was dismissed because its question could not be loaded.";
      await saveState(state);
      await chrome.alarms.clear(THRESHOLD_ALARM);
      return { ok: true, recovered: true };
    }

    case "YOUTUBE_CHANNEL_INFO": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) return { ok: false };
      const channels = await loadChannels();
      const channel = typeof message.channel === "string" ? message.channel.trim().slice(0, 100) : "";
      if (channel) channels[tabId] = channel;
      else delete channels[tabId];
      await saveChannels(channels);
      await observeLocked("youtube-channel");
      return { ok: true };
    }

    case "FORCE_TRIGGER_ALARM": {
      const settings = await loadSettings();
      if (!settings.enabled) return { ok: false, reason: "The alarm is switched off." };
      const state = await loadState();
      if (state.alarmStatus === "ACTIVE") return { ok: true };
      await ringAlarmLocked(state, settings, now);
      return { ok: true };
    }

    case "FORCE_TICK":
      await observeLocked("manual");
      return { ok: true };

    case "RESET_STATE": {
      const fresh = sanitizeState({ ...DEFAULT_STATE, tracking: freshTracking(now) });
      await saveState(fresh);
      await chrome.alarms.clear(THRESHOLD_ALARM);
      await chrome.alarms.clear(SNOOZE_ALARM);
      return { ok: true };
    }

    case "GET_DEBUG_INFO": {
      const settings = await loadSettings();
      const state = await loadState();
      let lastObservation = null;
      try {
        lastObservation = (await chrome.storage.session.get(LAST_OBS_KEY))[LAST_OBS_KEY] || null;
      } catch (e) { /* none */ }
      let bank = { ok: true, count: 0, error: null };
      try {
        bank.count = (await loadBank()).length;
      } catch (e) {
        bank = { ok: false, count: 0, error: errMsg(e) };
      }
      const access = accessStatus(await grantedOrigins(), settings.distractingSites);
      const alarms = (await chrome.alarms.getAll()).map((a) => ({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes || null }));
      return {
        now,
        version: chrome.runtime.getManifest().version,
        enabled: settings.enabled,
        thresholdMinutes: settings.thresholdMinutes,
        alarmStatus: settings.enabled ? state.alarmStatus : "DISABLED (switch is off)",
        tracking: state.tracking,
        snooze: state.snooze,
        studyMode: state.studyMode,
        trigger: state.trigger,
        stats: state.stats,
        lastError: state.lastError,
        lastObservation,
        access,
        alarms,
        bank
      };
    }

    default:
      return { ok: false, reason: "Unknown message type." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    sendResponse({ ok: false, reason: "Malformed message." });
    return false;
  }
  if (!isAuthorized(message.type, sender, chrome.runtime.id, chrome.runtime.getURL(""))) {
    sendResponse({ ok: false, reason: "Not allowed." });
    return false;
  }
  serialize(() => handle(message, sender)).then(sendResponse, (e) => {
    console.log("[FocusAlarm] handler failed:", message.type, errMsg(e));
    sendResponse({ ok: false, reason: errMsg(e) });
  });
  return true; // async response
});

// ---------------------------------------------------------------------------
// Lifecycle and event wiring. All listeners are registered synchronously, at top level,
// as MV3 requires, so Chrome can wake a stopped worker for them.
// ---------------------------------------------------------------------------

/** Time the browser was closed or the machine slept is never credited to anything. */
async function startupLocked(reason) {
  const settings = await loadSettings();
  await saveSettings(settings); // writes back sanitised values (repairs malformed storage)
  const state = await loadState();
  const now = Date.now();
  const closedForMs = state.tracking.lastObservedAt == null ? Infinity : now - state.tracking.lastObservedAt;
  if (closedForMs >= settings.awayResetMinutes * 60000) {
    state.tracking = freshTracking(now); // away long enough: same rule as leaving the distracting site
  } else {
    // Short gap: keep the progress, but credit nothing for the time nobody was observing.
    state.tracking = { ...state.tracking, lastObservedAt: now, lastKind: "paused", lastHost: null, runMs: 0 };
  }
  await saveState(state);
  await ensureBackstopAlarm();
  await applyIdleInterval(settings);
  await syncOverlayScriptLocked(reason === "installed");
  await observeLocked(reason);
}

chrome.runtime.onInstalled.addListener((details) => {
  serialize(() => startupLocked("installed")).catch((e) => console.log("[FocusAlarm] install failed:", errMsg(e)));
  if (details && details.reason === "install") {
    // First run: explain the extension and ask for site access in a full tab.
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  serialize(() => startupLocked("browser-startup")).catch((e) => console.log("[FocusAlarm] startup failed:", errMsg(e)));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM || alarm.name === THRESHOLD_ALARM || alarm.name === SNOOZE_ALARM) observe(alarm.name);
});

chrome.tabs.onActivated.addListener(() => observe("tab-activated"));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.audible !== undefined) observe("tab-updated");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(async () => {
    const channels = await loadChannels();
    if (channels[tabId] !== undefined) {
      delete channels[tabId];
      await saveChannels(channels);
    }
  }).catch(() => {});
  observe("tab-removed");
});

// The user may grant or revoke access from chrome://extensions at any time.
const resync = () => serialize(() => syncOverlayScriptLocked(true)).catch(() => {});
chrome.permissions.onAdded.addListener(resync);
chrome.permissions.onRemoved.addListener(resync);

chrome.windows.onFocusChanged.addListener(() => observe("window-focus"));

chrome.idle.onStateChanged.addListener(() => observe("idle-changed"));

// Every time the worker starts, make sure the backstop alarm exists (cheap and idempotent).
ensureBackstopAlarm().catch(() => {});
serialize(() => syncOverlayScriptLocked(false)).catch(() => {});