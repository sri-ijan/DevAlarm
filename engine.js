// engine.js
//
// Pure logic for Focus Alarm. NOTHING in here touches chrome.* APIs, the DOM or the clock
// (callers pass `now`), so every function can be unit tested in plain Node:
//   node --test
//
// background.js imports this as an ES module and wires it to the real browser.

export const TOPICS = [
  "arrays", "strings", "linkedlist", "stacks-queues", "sorting", "recursion",
  "hashmaps", "two-pointers", "binary-search", "trees", "dp", "graphs",
  "complexity", "oop", "os", "dbms", "networking", "language-concepts"
];

export const SNOOZE_MINUTES = [5, 10, 30, 60];
export const HINT_UNLOCK_ATTEMPTS = 3;
export const REVEAL_UNLOCK_ATTEMPTS = 5;

// Time between two observations that we are willing to credit to the earlier state.
// The periodic alarm fires every minute, so anything longer than this means the machine
// slept or the browser was suspended, and we must not credit that whole gap.
export const MAX_CREDIT_GAP_MS = 150 * 1000;
// Minimum spacing between two answer submissions (enforced in the background, so a
// modified content script cannot skip it).
export const MIN_ATTEMPT_SPACING_MS = 1500;

export const DEFAULT_SETTINGS = {
  enabled: true,
  distractingSites: ["youtube.com", "instagram.com", "twitter.com", "x.com", "reddit.com", "facebook.com", "tiktok.com"],
  studyChannels: [],
  thresholdMinutes: 20,
  difficulty: "mixed",
  numQuestions: 1,
  topics: [],
  maxSnoozes: 2,
  dailySnoozeLimit: 0, // 0 = no daily limit
  idleSeconds: 180, // no input for this long (and nothing audible) = not actively distracted
  awayResetMinutes: 5 // accumulated distraction only resets after this long away from distractions
};

export const DEFAULT_STATE = {
  alarmStatus: "INACTIVE",
  tracking: {
    accumulatedMs: 0,
    lastObservedAt: null,
    lastKind: "away", // "countable" | "away" | "paused"
    lastHost: null,
    awayMs: 0,
    runMs: 0, // length of the current uninterrupted countable run (caps an idle refund)
    byHost: {}
  },
  snooze: { snoozeUntil: null, usedThisEpisode: 0, usedDay: null, usedToday: 0 },
  studyMode: { until: null },
  currentChallenge: null,
  trigger: null, // { hostname, minutes } - why the alarm appeared
  stats: { alarmsTriggered: 0, problemsSolved: 0, problemsRevealed: 0, snoozes: 0, failOpen: 0 },
  lastError: null
};

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v, fallback, min, max) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const int = (v, fallback, min, max) => Math.round(num(v, fallback, min, max));
const nonNegInt = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** "https://www.YouTube.com/watch?v=1" -> "youtube.com". Returns null if it is not a hostname. */
export function normalizeSite(input) {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

/** Exact host or a real subdomain. "x.com" matches "x.com" and "m.x.com" but NOT "dropbox.com". */
export function hostMatchesSite(hostname, site) {
  if (!hostname || !site) return false;
  const h = hostname.toLowerCase().replace(/^www\./, "");
  const s = site.toLowerCase().replace(/^www\./, "");
  return h === s || h.endsWith("." + s);
}

export function hostOnList(hostname, sites) {
  return Array.isArray(sites) && sites.some((s) => hostMatchesSite(hostname, s));
}

/** Study-channel allowlist: case-insensitive substring of the channel name (min 3 chars). */
export function channelOnList(channel, list) {
  if (typeof channel !== "string" || !channel.trim() || !Array.isArray(list)) return false;
  const c = channel.toLowerCase();
  return list.some((entry) => {
    const e = String(entry).trim().toLowerCase();
    return e.length >= 3 && c.includes(e);
  });
}

export function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch (e) {
    return null;
  }
}

/** chrome://, extension pages, devtools... Looking at these PAUSES tracking instead of resetting it. */
export function isInternalUrl(url) {
  return typeof url === "string" && /^(chrome|chrome-extension|chrome-untrusted|edge|about|devtools|view-source):/i.test(url);
}

export function isYouTubeHost(hostname) {
  return hostMatchesSite(hostname, "youtube.com") || hostname === "youtu.be";
}

/**
 * Decides what the current browser situation means for tracking. Pure: the caller gathers
 * the inputs from chrome.* and passes `now`.
 *
 * input = { tab: {url, audible} | null, windowFocused, idleState: "active"|"idle"|"locked",
 *           channel: string | null (YouTube channel reported for this tab),
 *           settings, now, snoozeUntil, studyUntil }
 * returns { kind: "countable" | "away" | "paused", hostname, reason }
 */
export function classify(input) {
  const { tab, windowFocused, idleState, channel, settings, now, snoozeUntil, studyUntil } = input;

  if (snoozeUntil && snoozeUntil > now) return { kind: "paused", hostname: null, reason: "snoozed" };
  if (studyUntil && studyUntil > now) return { kind: "paused", hostname: null, reason: "study-mode" };
  if (!tab || !tab.url) return { kind: "away", hostname: null, reason: "no-tab" };
  if (isInternalUrl(tab.url)) return { kind: "paused", hostname: null, reason: "internal-page" };

  const hostname = getHostname(tab.url);
  if (!hostname || !/^https?:/i.test(tab.url)) return { kind: "away", hostname: null, reason: "not-a-website" };
  if (!windowFocused) return { kind: "away", hostname, reason: "browser-not-focused" };
  if (!hostOnList(hostname, settings.distractingSites)) return { kind: "away", hostname, reason: "not-on-blocklist" };
  if (isYouTubeHost(hostname) && channelOnList(channel, settings.studyChannels)) {
    return { kind: "away", hostname, reason: "study-channel" };
  }
  // A video playing with sound counts as active even without keyboard/mouse input.
  const inputActive = idleState === "active";
  const passiveButAudible = idleState === "idle" && tab.audible === true;
  if (!inputActive && !passiveButAudible) return { kind: "away", hostname, reason: "idle" };
  return { kind: "countable", hostname, reason: "on-blocklist" };
}

export function freshTracking(now, kind = "paused") {
  return { accumulatedMs: 0, lastObservedAt: now, lastKind: kind, lastHost: null, awayMs: 0, runMs: 0, byHost: {} };
}

/** Origin match patterns Chrome needs for a site (covers the bare domain and subdomains). */
export function siteToOriginPatterns(site) {
  return [`*://*.${site}/*`];
}

// ---------------------------------------------------------------------------
// Host access. The manifest declares <all_urls> only as OPTIONAL. What the user actually
// granted decides where the overlay script is registered:
//   "all"     every http(s) page      -> the alarm overlay shows on whatever tab you switch to
//   "sites"   every blocklisted site  -> overlay only on those sites
//   "partial" some blocklisted sites  -> overlay only on those; the rest are invisible to us
//   "none"    nothing                 -> Chrome hides tab URLs from us, so nothing can be tracked
// ---------------------------------------------------------------------------

export const OVERLAY_SCRIPT_ID = "focus-alarm-overlay";
export const ALL_HOST_PATTERNS = ["http://*/*", "https://*/*"];
export const ALL_SITES_REQUEST = ["<all_urls>"];

export function originsGrantAll(origins) {
  if (!Array.isArray(origins)) return false;
  const set = new Set(origins);
  return set.has("<all_urls>") || set.has("*://*/*") || (set.has("http://*/*") && set.has("https://*/*"));
}

export function accessStatus(grantedOrigins, sites) {
  const granted = new Set(Array.isArray(grantedOrigins) ? grantedOrigins : []);
  const all = originsGrantAll(grantedOrigins);
  const wanted = (Array.isArray(sites) ? sites : []).map((site) => ({ site, pattern: siteToOriginPatterns(site)[0] }));
  const have = all ? wanted : wanted.filter((w) => granted.has(w.pattern));
  const missing = all ? [] : wanted.filter((w) => !granted.has(w.pattern));

  let scope = "none";
  if (all) scope = "all";
  else if (wanted.length > 0 && missing.length === 0) scope = "sites";
  else if (have.length > 0) scope = "partial";

  return {
    scope,
    matches: all ? [...ALL_HOST_PATTERNS] : have.map((w) => w.pattern),
    missingSites: missing.map((w) => w.site),
    missingPatterns: missing.map((w) => w.pattern)
  };
}

export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;

  let sites = d.distractingSites;
  if (Array.isArray(r.distractingSites)) {
    sites = [...new Set(r.distractingSites.map(normalizeSite).filter(Boolean))].slice(0, 100);
  }

  let channels = d.studyChannels;
  if (Array.isArray(r.studyChannels)) {
    channels = [...new Set(r.studyChannels.filter((c) => typeof c === "string").map((c) => c.trim().slice(0, 100)).filter(Boolean))].slice(0, 100);
  }

  let topics = d.topics;
  if (Array.isArray(r.topics)) topics = [...new Set(r.topics.filter((t) => TOPICS.includes(t)))];

  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    distractingSites: sites,
    studyChannels: channels,
    thresholdMinutes: num(r.thresholdMinutes, d.thresholdMinutes, 0.1, 240),
    difficulty: ["mixed", "easy", "medium", "hard"].includes(r.difficulty) ? r.difficulty : d.difficulty,
    numQuestions: int(r.numQuestions, d.numQuestions, 1, 10),
    topics,
    maxSnoozes: int(r.maxSnoozes, d.maxSnoozes, 0, 10),
    dailySnoozeLimit: int(r.dailySnoozeLimit, d.dailySnoozeLimit, 0, 50),
    idleSeconds: int(r.idleSeconds, d.idleSeconds, 15, 1800),
    awayResetMinutes: num(r.awayResetMinutes, d.awayResetMinutes, 0.1, 60)
  };
}

function isUsableChallenge(ch) {
  return (
    isObj(ch) &&
    Array.isArray(ch.questions) &&
    ch.questions.length > 0 &&
    ch.questions.every((q) => isObj(q) && q.id != null && typeof q.question === "string") &&
    Number.isInteger(ch.currentIndex) &&
    ch.currentIndex >= 0 &&
    ch.currentIndex < ch.questions.length
  );
}

/** Validates whatever came out of storage. Never throws; self-heals impossible combinations. */
export function sanitizeState(raw) {
  const r = isObj(raw) ? raw : {};
  const d = DEFAULT_STATE;
  const t = isObj(r.tracking) ? r.tracking : {};
  const s = isObj(r.snooze) ? r.snooze : {};
  const st = isObj(r.stats) ? r.stats : {};
  const sm = isObj(r.studyMode) ? r.studyMode : {};

  const byHost = {};
  if (isObj(t.byHost)) {
    for (const [k, v] of Object.entries(t.byHost)) if (Number.isFinite(v) && v > 0) byHost[k] = v;
  }

  const state = {
    alarmStatus: r.alarmStatus === "ACTIVE" ? "ACTIVE" : "INACTIVE",
    tracking: {
      accumulatedMs: nonNegInt(t.accumulatedMs),
      lastObservedAt: Number.isFinite(t.lastObservedAt) ? t.lastObservedAt : null,
      lastKind: ["countable", "away", "paused"].includes(t.lastKind) ? t.lastKind : d.tracking.lastKind,
      lastHost: typeof t.lastHost === "string" ? t.lastHost : null,
      awayMs: nonNegInt(t.awayMs),
      runMs: nonNegInt(t.runMs),
      byHost
    },
    snooze: {
      snoozeUntil: Number.isFinite(s.snoozeUntil) ? s.snoozeUntil : null,
      usedThisEpisode: nonNegInt(s.usedThisEpisode),
      usedDay: typeof s.usedDay === "string" ? s.usedDay : null,
      usedToday: nonNegInt(s.usedToday)
    },
    studyMode: { until: Number.isFinite(sm.until) ? sm.until : null },
    currentChallenge: isUsableChallenge(r.currentChallenge) ? r.currentChallenge : null,
    trigger:
      isObj(r.trigger) && typeof r.trigger.hostname === "string" && Number.isFinite(r.trigger.minutes)
        ? { hostname: r.trigger.hostname, minutes: r.trigger.minutes }
        : null,
    stats: {
      alarmsTriggered: nonNegInt(st.alarmsTriggered),
      problemsSolved: nonNegInt(st.problemsSolved),
      problemsRevealed: nonNegInt(st.problemsRevealed),
      snoozes: nonNegInt(st.snoozes),
      failOpen: nonNegInt(st.failOpen)
    },
    lastError: typeof r.lastError === "string" ? r.lastError.slice(0, 300) : null
  };

  // An ACTIVE alarm with no usable challenge could never be dismissed. Fail open.
  if (state.alarmStatus === "ACTIVE" && !state.currentChallenge) {
    state.alarmStatus = "INACTIVE";
    state.lastError = "Recovered from an alarm that had no usable question.";
    state.stats.failOpen += 1;
  }
  if (state.alarmStatus === "INACTIVE") state.currentChallenge = null;
  return state;
}

// ---------------------------------------------------------------------------
// Distraction tracking (timestamp based; credit goes to the PREVIOUS segment's state)
// ---------------------------------------------------------------------------

/**
 * Called whenever something is observed (tab switch, navigation, idle change, alarm, ...).
 * The time since the last observation is credited to whatever state we were in THEN,
 * because any change of state produces an event and therefore a new observation.
 * That makes the result independent of how often or how late callbacks run.
 *
 * obs = { kind: "countable" | "away" | "paused", hostname: string | null, idleRefundMs?: number }
 *
 * `idleRefundMs` is set when this observation is the one that discovered the user went idle.
 * Chrome only reports "idle" after `idleSeconds` without input, so that stretch was already
 * credited as active. It is taken back, limited to what was really credited in the current
 * uninterrupted countable run. The refund does NOT start the "away" clock: how long idleness
 * takes to erase progress (awayResetMinutes) is unchanged by this.
 */
export function advanceTracking(tracking, obs, now, settings) {
  const t = { ...tracking, byHost: { ...tracking.byHost } };
  const prev = t.lastObservedAt;
  const raw = prev == null ? 0 : now - prev;
  const elapsed = raw > 0 ? Math.min(raw, MAX_CREDIT_GAP_MS) : 0; // clock moved backwards -> 0

  if (t.lastKind === "countable") {
    t.accumulatedMs += elapsed;
    t.runMs = (t.runMs || 0) + elapsed;
    t.awayMs = 0;
    if (t.lastHost) t.byHost[t.lastHost] = (t.byHost[t.lastHost] || 0) + elapsed;
    if (obs.kind === "away" && obs.idleRefundMs > 0) {
      // Part of a very long gap may never have been credited (MAX_CREDIT_GAP_MS). The idle
      // window is the END of the gap, so only the credited share that overlaps it is handed back.
      const uncredited = raw > elapsed ? raw - elapsed : 0;
      const refund = Math.min(Math.max(0, obs.idleRefundMs - uncredited), t.runMs, t.accumulatedMs);
      t.accumulatedMs -= refund;
      if (t.lastHost && t.byHost[t.lastHost] != null) {
        t.byHost[t.lastHost] = Math.max(0, t.byHost[t.lastHost] - refund);
        if (t.byHost[t.lastHost] === 0) delete t.byHost[t.lastHost];
      }
    }
  } else if (t.lastKind === "away") {
    t.awayMs += elapsed;
    if (t.awayMs >= settings.awayResetMinutes * 60000) {
      t.accumulatedMs = 0;
      t.byHost = {};
    }
  } // "paused": time is credited to nothing

  if (obs.kind !== "countable") t.runMs = 0;
  t.lastObservedAt = now;
  t.lastKind = obs.kind;
  t.lastHost = obs.kind === "countable" ? obs.hostname : null;
  if (obs.kind === "countable") t.awayMs = 0;

  const thresholdMs = settings.thresholdMinutes * 60000;
  return { tracking: t, crossed: t.accumulatedMs >= thresholdMs, remainingMs: Math.max(0, thresholdMs - t.accumulatedMs) };
}

/** When should the one-shot "threshold reached" alarm fire? null = nothing to schedule. */
export function nextThresholdAt(tracking, now, settings) {
  if (tracking.lastKind !== "countable") return null;
  const remaining = settings.thresholdMinutes * 60000 - tracking.accumulatedMs;
  return now + Math.max(remaining, 1000);
}

export function topHost(byHost) {
  let best = null;
  let bestMs = -1;
  for (const [host, ms] of Object.entries(byHost || {})) {
    if (ms > bestMs) { best = host; bestMs = ms; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Snoozing
// ---------------------------------------------------------------------------

export function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function snoozeCheck(snooze, settings, minutes, now) {
  if (!SNOOZE_MINUTES.includes(minutes)) return { ok: false, reason: "Invalid snooze length." };
  if (snooze.usedThisEpisode >= settings.maxSnoozes) return { ok: false, reason: "No snoozes left for this alarm. Solve it to reset." };
  const usedToday = snooze.usedDay === dayKey(now) ? snooze.usedToday : 0;
  if (settings.dailySnoozeLimit > 0 && usedToday >= settings.dailySnoozeLimit) {
    return { ok: false, reason: `Daily snooze limit (${settings.dailySnoozeLimit}) reached.` };
  }
  return { ok: true };
}

export function applySnooze(snooze, minutes, now) {
  const today = dayKey(now);
  const usedToday = snooze.usedDay === today ? snooze.usedToday : 0;
  return {
    snoozeUntil: now + minutes * 60000,
    usedThisEpisode: snooze.usedThisEpisode + 1,
    usedDay: today,
    usedToday: usedToday + 1
  };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export function normalizeBlank(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isValidQuestion(q) {
  if (!isObj(q) || q.id == null || typeof q.question !== "string" || !q.question.trim()) return false;
  if (typeof q.answer !== "string" || !q.answer.trim()) return false;
  if (q.format === "mcq") {
    return Array.isArray(q.options) && q.options.length >= 2 && q.options.map((o) => String(o).trim()).includes(q.answer.trim());
  }
  return normalizeBlank(q.answer) !== "";
}

export function isCorrectAnswer(fullQ, submitted) {
  if (!isValidQuestion(fullQ) || typeof submitted !== "string" || submitted.length > 500) return false;
  if (fullQ.format === "mcq") return submitted.trim() === fullQ.answer.trim();
  const given = normalizeBlank(submitted);
  if (!given) return false;
  return [fullQ.answer, ...(Array.isArray(fullQ.accept) ? fullQ.accept : [])].map(normalizeBlank).includes(given);
}

export function shuffle(array, rng = Math.random) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Topics are strict. Difficulty is a preference: if a topic has too few questions of that
 *  difficulty, the rest are filled from other difficulties instead of ignoring the topic. */
export function selectQuestions(bank, settings, rng = Math.random) {
  const valid = Array.isArray(bank) ? bank.filter(isValidQuestion) : [];
  let pool = settings.topics.length ? valid.filter((q) => settings.topics.includes(q.topic)) : valid;
  if (pool.length === 0) return { questions: [], relaxedDifficulty: false };

  const count = Math.min(settings.numQuestions, pool.length);
  let picked = [];
  let relaxed = false;

  if (settings.difficulty !== "mixed") {
    const preferred = shuffle(pool.filter((q) => q.difficulty === settings.difficulty), rng);
    picked = preferred.slice(0, count);
    if (picked.length < count) {
      relaxed = true;
      const rest = shuffle(pool.filter((q) => q.difficulty !== settings.difficulty), rng);
      picked = picked.concat(rest.slice(0, count - picked.length));
    }
  } else {
    picked = shuffle(pool, rng).slice(0, count);
  }
  return { questions: picked, relaxedDifficulty: relaxed };
}

/** Whitelist of fields the content script may ever see (never answer, accept or hint). */
export function toPublicQuestion(q, rng = Math.random, shuffleOptions = false) {
  const pub = {
    id: q.id,
    topic: q.topic,
    type: q.type,
    difficulty: q.difficulty,
    format: q.format === "mcq" ? "mcq" : "blank",
    question: q.question
  };
  if (q.code) pub.code = q.code;
  if (pub.format === "mcq" && Array.isArray(q.options)) {
    pub.options = shuffleOptions ? shuffle(q.options, rng) : [...q.options];
  }
  return pub;
}

export function canAttempt(challenge, now) {
  return !challenge.lastAttemptAt || now - challenge.lastAttemptAt >= MIN_ATTEMPT_SPACING_MS;
}

// ---------------------------------------------------------------------------
// Message authorisation
// ---------------------------------------------------------------------------

// What a content script (code running inside web pages) may ask for.
export const CONTENT_SCRIPT_MESSAGES = new Set([
  "GET_PUBLIC_CHALLENGE", "SUBMIT_ANSWER", "GET_HINT", "REVEAL_ANSWER", "SNOOZE", "YOUTUBE_CHANNEL_INFO",
  "RECOVER_ALARM"
]);

/**
 * Extension pages (popup, debug, welcome) may send anything. Everything else, i.e. content
 * scripts, may only send CONTENT_SCRIPT_MESSAGES. `sender.id` must be this extension.
 */
export function isAuthorized(type, sender, extensionId, extensionOrigin) {
  if (!sender || sender.id !== extensionId) return false;
  const fromExtensionPage = typeof sender.url === "string" && sender.url.startsWith(extensionOrigin);
  if (fromExtensionPage) return true;
  if (!CONTENT_SCRIPT_MESSAGES.has(type)) return false;
  if (type === "YOUTUBE_CHANNEL_INFO") return !!(sender.tab && sender.frameId === 0);
  return !!sender.tab;
}