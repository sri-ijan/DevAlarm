// Integration tests: the REAL background.js running against an in-memory fake of chrome.*.
// Run with:  node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore, makeChrome, sendMessage, senders } from "./helpers/fake-chrome.mjs";

const T0 = Date.UTC(2026, 5, 15, 10, 0, 0); // a fixed "now"
const REDDIT = { id: 1, url: "https://www.reddit.com/r/all", audible: false };
const DOCS = { id: 2, url: "https://developer.mozilla.org/en-US/docs/Web", audible: false };
const YOUTUBE_WATCH = { id: 7, url: "https://www.youtube.com/watch?v=abc", audible: false };

const BANK = [
  { id: 1, topic: "arrays", type: "concept", difficulty: "easy", format: "blank", question: "Fill the gap: first greek letter is ____.", answer: "alpha", accept: ["a-l-p-h-a"], hint: "HINT-ONE-TEXT" },
  { id: 2, topic: "arrays", type: "concept", difficulty: "easy", format: "mcq", question: "Pick the second letter of the greek alphabet.", options: ["beta", "gamma", "delta", "kappa"], answer: "beta", hint: "HINT-TWO-TEXT" },
  { id: 3, topic: "trees", type: "concept", difficulty: "hard", format: "blank", question: "Traversal that visits root first is called ____ order.", answer: "pre", hint: "HINT-THREE-TEXT" }
];

let bootCounter = 0;

/** Starts a fresh service worker on top of the given storage (like Chrome waking it up). */
async function bootWorker({ local, session, bank = BANK, fetchFails = false } = {}) {
  local = local || makeStore();
  session = session || makeStore();
  const fake = makeChrome({ local, session, now: () => Date.now() });
  globalThis.chrome = fake.chrome;
  globalThis.fetch = async () => {
    if (fetchFails) throw new Error("network down");
    return { ok: true, status: 200, json: async () => structuredClone(bank) };
  };
  await import(`../background.js?boot=${++bootCounter}`);
  const w = {
    ...fake,
    local,
    session,
    bank,
    send: (type, payload = {}, sender = senders.popup) => sendMessage(fake.chrome, { type, ...payload }, sender),
    async fire(listenerSlot, ...args) {
      for (const fn of listenerSlot.listeners) fn(...args);
      await w.send("GET_STATE"); // resolves only after every queued job has finished
    },
    startup: () => w.fire(fake.chrome.runtime.onStartup),
    alarmFires: (name) => w.fire(fake.chrome.alarms.onAlarm, { name }),
    state: () => w.send("GET_STATE"),
    debug: () => w.send("GET_DEBUG_INFO"),
    async restart(opts = {}) {
      return bootWorker({ local, session, bank, ...opts });
    }
  };
  await w.send("GET_STATE");
  return w;
}

function useClock(t, start = T0) {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  return (ms) => t.mock.timers.tick(ms);
}

async function configure(w, settings) {
  const res = await w.send("SET_SETTINGS", { settings });
  assert.equal(res.ok, true);
}

const answerOf = (w, id) => w.bank.find((q) => q.id === id).answer;

// ---------------------------------------------------------------------------
// Timer behaviour
// ---------------------------------------------------------------------------

test("accumulates distraction time and rings exactly at the threshold", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 1, numQuestions: 1 });
  w.env.activeTab = REDDIT;
  await w.startup();

  const alarm = await w.chrome.alarms.get("focus-alarm-threshold");
  assert.equal(alarm.scheduledTime, T0 + 60_000, "threshold alarm is scheduled for the exact crossing time");

  advance(30_000);
  await w.send("FORCE_TICK");
  let s = await w.state();
  assert.equal(s.tracking.accumulatedMs, 30_000);
  assert.equal(s.alarmStatus, "INACTIVE");

  advance(30_000);
  await w.send("FORCE_TICK");
  s = await w.state();
  assert.equal(s.alarmStatus, "ACTIVE");
  assert.equal(s.trigger.hostname, "reddit.com");
  assert.equal(s.trigger.minutes, 1);
  assert.equal(s.stats.alarmsTriggered, 1);
  assert.equal(s.tracking.accumulatedMs, 0, "tracking restarts after the alarm");
});

test("the one-shot threshold alarm callback rings the alarm even with no other event", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 1 });
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(60_000);
  await w.alarmFires("focus-alarm-threshold");
  assert.equal((await w.state()).alarmStatus, "ACTIVE");
});

test("duplicate events at the same instant do not double count", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 10 });
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(30_000);
  await Promise.all([w.send("FORCE_TICK"), w.send("FORCE_TICK"), w.alarmFires("focus-alarm-tick"), w.fire(w.chrome.tabs.onActivated, {})]);
  assert.equal((await w.state()).tracking.accumulatedMs, 30_000);
});

test("service worker restart keeps progress and keeps counting", async (t) => {
  const advance = useClock(t);
  let w = await bootWorker();
  await configure(w, { thresholdMinutes: 10 });
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(30_000);
  await w.send("FORCE_TICK");

  const env = w.env;
  w = await w.restart(); // worker was killed and woken by an event; NO onStartup
  w.env.activeTab = env.activeTab;
  advance(30_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 60_000);
});

test("browser restart after a short closure keeps progress and credits nothing for the closed time", async (t) => {
  const advance = useClock(t);
  let w = await bootWorker();
  await configure(w, { thresholdMinutes: 10, awayResetMinutes: 5 });
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(30_000);
  await w.send("FORCE_TICK");

  advance(2 * 60_000); // browser closed for two minutes
  w = await w.restart();
  w.env.activeTab = REDDIT;
  await w.startup();
  assert.equal((await w.state()).tracking.accumulatedMs, 30_000, "progress kept");
  advance(20_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 50_000, "30s before + 20s after, nothing for the two closed minutes");
});

test("browser restart after a long closure starts from zero (same rule as being away)", async (t) => {
  const advance = useClock(t);
  let w = await bootWorker();
  await configure(w, { thresholdMinutes: 10 });
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(30_000);
  await w.send("FORCE_TICK");

  advance(3 * 3600_000); // browser closed for three hours
  w = await w.restart();
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(20_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 20_000, "only the 20s after reopening");
});

test("a long gap (sleep) credits at most the capped amount", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60 });
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(2 * 3600_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 150_000);
});

test("tab switching: elapsed time goes to the tab that was actually open", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60, awayResetMinutes: 5 });
  w.env.activeTab = REDDIT;
  await w.startup();

  advance(40_000);
  w.env.activeTab = DOCS; // the user switched; the event arrives afterwards
  await w.fire(w.chrome.tabs.onActivated, {});
  assert.equal((await w.state()).tracking.accumulatedMs, 40_000, "40s on reddit credited");

  advance(100_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 40_000, "100s on docs credited to nothing");

  advance(150_000);
  await w.send("FORCE_TICK");
  advance(100_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 0, "5+ minutes away resets the counter");
});

test("a short glance at another tab does not erase progress", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60 });
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(60_000);
  w.env.activeTab = DOCS;
  await w.fire(w.chrome.tabs.onActivated, {});
  advance(20_000);
  w.env.activeTab = REDDIT;
  await w.fire(w.chrome.tabs.onActivated, {});
  assert.equal((await w.state()).tracking.accumulatedMs, 60_000);
});

test("idle without sound does not count; idle with audio playing does", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60, idleSeconds: 15 });
  w.env.activeTab = REDDIT;
  await w.startup();

  advance(60_000);
  await w.send("FORCE_TICK"); // 60s of real activity
  w.env.idleState = "idle";
  advance(15_000); // Chrome reports idle only after idleSeconds without input
  await w.send("FORCE_TICK"); // those 15s were idle, not active: they are taken back
  advance(30_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 60_000);
  assert.equal((await w.debug()).lastObservation.reason, "idle");

  w.env.activeTab = { ...REDDIT, audible: true };
  await w.send("FORCE_TICK"); // now counting again (idle but audible)
  advance(30_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 90_000);

  w.env.idleState = "locked";
  await w.send("FORCE_TICK");
  advance(30_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 90_000, "a locked screen never counts");
});

test("going idle takes back the idleSeconds that were credited as active, and cannot ring the alarm", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 5, idleSeconds: 180 });
  w.env.activeTab = REDDIT;
  await w.startup();

  advance(2 * 60_000);
  await w.send("FORCE_TICK"); // 2 min active
  advance(3 * 60_000); // user walked away right after; Chrome says idle only now
  w.env.idleState = "idle";
  await w.alarmFires("focus-alarm-threshold"); // threshold alarm was set for 5 min of "activity"
  const s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE", "idle time must not ring the alarm");
  assert.equal(s.tracking.accumulatedMs, 2 * 60_000);

  // A short run cannot be refunded more than it actually credited.
  const w2 = await bootWorker();
  await configure(w2, { thresholdMinutes: 60, idleSeconds: 180 });
  w2.env.activeTab = REDDIT;
  await w2.startup();
  advance(30_000);
  w2.env.idleState = "idle";
  await w2.send("FORCE_TICK");
  assert.equal((await w2.state()).tracking.accumulatedMs, 0);
});

test("idle refund: happens once, not for a locked screen, and does not shorten the away-reset time", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60, idleSeconds: 60, awayResetMinutes: 5 });
  w.env.activeTab = REDDIT;
  await w.startup();
  const tickMinute = async () => { advance(60_000); await w.send("FORCE_TICK"); };

  for (let i = 0; i < 10; i++) await tickMinute(); // 10 min active (one tick per minute)
  w.env.idleState = "idle";
  await tickMinute(); // this tick discovers idle: the last 60s are credited, then taken back
  assert.equal((await w.state()).tracking.accumulatedMs, 10 * 60_000);
  assert.equal((await w.state()).tracking.awayMs, 0, "the refund does not start the away clock");

  await tickMinute(); // still idle: nothing more is taken back
  assert.equal((await w.state()).tracking.accumulatedMs, 10 * 60_000, "refunded once only");

  // Progress is erased awayResetMinutes after the idle observation, exactly as before the refund existed.
  await tickMinute(); await tickMinute(); await tickMinute();
  assert.equal((await w.state()).tracking.accumulatedMs, 10 * 60_000, "4 min away: kept");
  await tickMinute();
  assert.equal((await w.state()).tracking.accumulatedMs, 0, "5 min away: reset");

  // Locking the screen is an action, not a quiet stretch: nothing to refund.
  const w2 = await bootWorker();
  await configure(w2, { thresholdMinutes: 60, idleSeconds: 60 });
  w2.env.activeTab = REDDIT;
  await w2.startup();
  for (let i = 0; i < 5; i++) { advance(60_000); await w2.send("FORCE_TICK"); }
  w2.env.idleState = "locked";
  advance(60_000);
  await w2.send("FORCE_TICK");
  assert.equal((await w2.state()).tracking.accumulatedMs, 6 * 60_000);
});

test("idle refund cannot reach back past a browser restart", async (t) => {
  const advance = useClock(t);
  let w = await bootWorker();
  await configure(w, { thresholdMinutes: 60, idleSeconds: 180 });
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(2 * 60_000);
  await w.send("FORCE_TICK"); // 2 min credited before the browser closed

  advance(60_000); // browser closed for 1 min (under awayResetMinutes): progress kept
  w = await w.restart();
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(30_000);
  w.env.idleState = "idle";
  await w.send("FORCE_TICK"); // the idle lead-in is 180s, but only 30s of this run exists
  assert.equal((await w.state()).tracking.accumulatedMs, 2 * 60_000, "the run before the restart is untouched");
});

test("browser in the background (user is in another app) does not count", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60 });
  w.env.activeTab = REDDIT;
  w.env.windowFocused = false;
  await w.startup();
  advance(60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 0);
  assert.equal((await w.debug()).lastObservation.reason, "browser-not-focused");
});

test("internal pages pause tracking instead of resetting it", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60 });
  w.env.activeTab = REDDIT;
  await w.startup();
  advance(60_000);
  w.env.activeTab = { id: 3, url: "chrome-extension://abc/debug.html" };
  await w.send("FORCE_TICK");
  advance(30 * 60_000);
  await w.send("FORCE_TICK");
  w.env.activeTab = REDDIT;
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 60_000);
});

test("sites match by real hostname: x.com must not match dropbox.com", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60, distractingSites: ["x.com"] });
  w.env.activeTab = { id: 1, url: "https://www.dropbox.com/home" };
  await w.startup();
  advance(60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 0);

  w.env.activeTab = { id: 1, url: "https://m.x.com/home" };
  await w.send("FORCE_TICK");
  advance(60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 60_000, "real subdomains still match");
});

test("study mode pauses tracking and can be stopped; bad durations are rejected", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60 });
  w.env.activeTab = REDDIT;
  await w.startup();

  for (const minutes of [0, -5, 9999, "abc", null]) {
    assert.equal((await w.send("START_STUDY_MODE", { minutes })).ok, false, `rejects ${minutes}`);
  }
  assert.equal((await w.send("START_STUDY_MODE", { minutes: 30 })).ok, true);
  advance(10 * 60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 0);

  advance(21 * 60_000); // study mode expired
  await w.send("FORCE_TICK");
  advance(30_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 30_000);
  assert.equal((await w.state()).studyMode.until, null);

  await w.send("START_STUDY_MODE", { minutes: 30 });
  await w.send("STOP_STUDY_MODE");
  assert.equal((await w.state()).studyMode.until, null);
});

test("master switch off: nothing is tracked, nothing rings, and turning it off clears a ringing alarm", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 1 });
  w.env.activeTab = REDDIT;
  await w.startup();
  assert.equal((await w.send("FORCE_TRIGGER_ALARM")).ok, true);
  assert.equal((await w.state()).alarmStatus, "ACTIVE");

  await w.send("SET_ENABLED", { enabled: false });
  let s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE");
  assert.equal(s.currentChallenge, null);
  assert.equal(await w.chrome.alarms.get("focus-alarm-threshold"), undefined);

  advance(10 * 60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 0);
  assert.equal((await w.send("FORCE_TRIGGER_ALARM")).ok, false);
  assert.match((await w.debug()).alarmStatus, /DISABLED/);

  await w.send("SET_ENABLED", { enabled: true }); // starts counting immediately
  advance(60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).alarmStatus, "ACTIVE", "works again after re-enabling");
});

test("SET_SETTINGS can never flip the master switch", async () => {
  const w = await bootWorker();
  await w.send("SET_ENABLED", { enabled: false });
  await w.send("SET_SETTINGS", { settings: { enabled: true, thresholdMinutes: 5 } });
  assert.equal((await w.send("GET_SETTINGS")).enabled, false);
});

test("no duplicate alarms are created across many worker starts", async () => {
  let w = await bootWorker();
  for (let i = 0; i < 3; i++) {
    await w.startup();
    w = await w.restart();
  }
  const all = await w.chrome.alarms.getAll();
  assert.equal(all.filter((a) => a.name === "focus-alarm-tick").length, 1);
  assert.equal(all.find((a) => a.name === "focus-alarm-tick").periodInMinutes, 1);
  assert.ok(all.length <= 2);
});

// ---------------------------------------------------------------------------
// Challenge, answers and recovery
// ---------------------------------------------------------------------------

async function ringWith(w, settings = {}) {
  await configure(w, { numQuestions: 1, topics: ["arrays"], ...settings });
  const res = await w.send("FORCE_TRIGGER_ALARM");
  assert.equal(res.ok, true);
  const ch = await w.send("GET_PUBLIC_CHALLENGE", {}, senders.content());
  assert.ok(ch, "challenge available");
  return ch;
}

test("the challenge handed to pages never contains answers, hints or accepted variants", async () => {
  const w = await bootWorker();
  const ch = await ringWith(w, { numQuestions: 2 });
  const publicJson = JSON.stringify(ch);
  assert.doesNotMatch(publicJson, /"answer"|"accept"|"hint"|\balpha\b|a-l-p-h-a|HINT-/);

  const stored = JSON.stringify(w.local.data);
  assert.doesNotMatch(stored, /"answer"|"accept"|HINT-|\balpha\b/, "answers never reach chrome.storage either");
  if (ch.question.format === "mcq") assert.equal(ch.question.options.length, 4);
});

test("wrong answers are rate limited by the background, hints unlock after 3, reveal after 5", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  const ch = await ringWith(w, { topics: ["arrays"], numQuestions: 1 });
  const id = ch.question.id;
  const wrong = "definitely-wrong";
  const sender = senders.content();

  let r = await w.send("SUBMIT_ANSWER", { answer: wrong }, sender);
  assert.equal(r.correct, false);
  assert.equal(r.attempts, 1);

  r = await w.send("SUBMIT_ANSWER", { answer: wrong }, sender); // instantly again: tampered client skipping its cooldown
  assert.equal(r.ok, false);
  assert.match(r.reason, /too fast/i);
  assert.equal((await w.state()).currentChallenge.attempts, 1, "blocked attempt is not counted");

  assert.equal((await w.send("GET_HINT", {}, sender)).ok, false, "hint locked");
  assert.equal((await w.send("REVEAL_ANSWER", {}, sender)).ok, false, "reveal locked");

  for (let i = 2; i <= 3; i++) {
    advance(2000);
    r = await w.send("SUBMIT_ANSWER", { answer: wrong }, sender);
    assert.equal(r.attempts, i);
  }
  assert.equal(r.hintUnlocked, true);
  assert.equal(r.revealUnlocked, false);
  const hint = await w.send("GET_HINT", {}, sender);
  assert.equal(hint.ok, true);
  assert.match(hint.hint, new RegExp(id === 1 ? "HINT-ONE-TEXT" : "HINT-TWO-TEXT"));

  for (let i = 4; i <= 5; i++) {
    advance(2000);
    r = await w.send("SUBMIT_ANSWER", { answer: wrong }, sender);
  }
  assert.equal(r.revealUnlocked, true);
  const reveal = await w.send("REVEAL_ANSWER", {}, sender);
  assert.equal(reveal.ok, true);
  assert.equal(reveal.answer, answerOf(w, id));
  assert.equal(reveal.done, true);

  const s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE");
  assert.equal(s.stats.problemsRevealed, 1);
  assert.equal(s.stats.problemsSolved, 0, "a revealed answer is not counted as solved");
});

test("fill-in-the-blank ignores case, spaces and punctuation; MCQ needs the exact option", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  const sender = senders.content();

  await configure(w, { numQuestions: 2, topics: ["arrays"] });
  await w.send("FORCE_TRIGGER_ALARM");
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const ch = await w.send("GET_PUBLIC_CHALLENGE", {}, sender);
    seen.push(ch.question.id);
    advance(2000);
    const submitted = ch.question.id === 1 ? "  A-L-P-H-A " : answerOf(w, 2);
    const r = await w.send("SUBMIT_ANSWER", { answer: submitted }, sender);
    assert.equal(r.correct, true, `question ${ch.question.id}`);
    assert.equal(r.done, i === 1);
  }
  assert.deepEqual(seen.sort(), [1, 2]);
  const s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE");
  assert.equal(s.stats.problemsSolved, 2);
});

test("a duplicated or concurrent completion is counted once", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  const sender = senders.content();
  const ch = await ringWith(w, { numQuestions: 1 });
  const correct = answerOf(w, ch.question.id);
  advance(2000);
  const [a, b] = await Promise.all([
    w.send("SUBMIT_ANSWER", { answer: correct }, sender),
    w.send("SUBMIT_ANSWER", { answer: correct }, sender)
  ]);
  assert.equal([a, b].filter((r) => r.correct === true).length, 1);
  assert.equal((await w.state()).stats.problemsSolved, 1);
  assert.equal((await w.send("SUBMIT_ANSWER", { answer: correct }, sender)).ok, false);
});

test("non-string answers are rejected", async () => {
  const w = await bootWorker();
  await ringWith(w);
  for (const answer of [undefined, null, 42, { a: 1 }, ["x"]]) {
    const r = await w.send("SUBMIT_ANSWER", { answer }, senders.content());
    assert.equal(r.ok, false);
  }
});

test("an active alarm survives a service worker restart", async () => {
  let w = await bootWorker();
  await ringWith(w);
  w = await w.restart();
  const ch = await w.send("GET_PUBLIC_CHALLENGE", {}, senders.content());
  assert.ok(ch && ch.question);
});

test("fail open: if the bank cannot be loaded the alarm is skipped instead of trapping the user", async () => {
  const w = await bootWorker({ fetchFails: true });
  await configure(w, { numQuestions: 1 });
  await w.send("FORCE_TRIGGER_ALARM");
  const s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE");
  assert.equal(s.stats.failOpen, 1);
  assert.match(s.lastError, /could not load questions/i);
});

test("fail open: a topic with no questions skips the alarm", async () => {
  const w = await bootWorker({ bank: BANK.filter((q) => q.topic === "arrays") });
  await configure(w, { topics: ["trees"] });
  await w.send("FORCE_TRIGGER_ALARM");
  const s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE");
  assert.equal(s.stats.failOpen, 1);
});

test("fail open: a question that disappeared from the bank is skipped, not a dead end", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await ringWith(w, { numQuestions: 1 });
  advance(2000);
  const smaller = await w.restart({ bank: [BANK[2]] }); // bank updated, old question ids are gone
  const r = await smaller.send("SUBMIT_ANSWER", { answer: "anything" }, senders.content());
  assert.equal(r.ok, true);
  assert.equal(r.done, true);
  assert.equal((await smaller.state()).alarmStatus, "INACTIVE");
});

// ---------------------------------------------------------------------------
// Snoozing
// ---------------------------------------------------------------------------

test("snooze: only valid lengths, only while ringing, pauses tracking, then resumes", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  const sender = senders.content();
  await configure(w, { maxSnoozes: 3, thresholdMinutes: 60 });
  w.env.activeTab = REDDIT;
  await w.startup();

  assert.equal((await w.send("SNOOZE", { minutes: 5 }, sender)).ok, false, "nothing to snooze yet");

  await w.send("FORCE_TRIGGER_ALARM");
  for (const minutes of [7, 0, -5, 1e9, "5; drop", null, undefined]) {
    assert.equal((await w.send("SNOOZE", { minutes }, sender)).ok, false, `rejects ${minutes}`);
  }
  assert.equal((await w.state()).alarmStatus, "ACTIVE");

  assert.equal((await w.send("SNOOZE", { minutes: 5 }, sender)).ok, true);
  let s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE");
  assert.equal(s.snooze.snoozeUntil, Date.now() + 5 * 60_000);

  advance(4 * 60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 0, "snoozed time is not counted");
  assert.equal((await w.debug()).lastObservation.reason, "snoozed");

  advance(2 * 60_000);
  await w.send("FORCE_TICK");
  advance(30_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 30_000, "tracking resumes after the snooze");
});

test("snooze: a one-shot alarm resumes tracking at the end of the snooze, with no other event", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  const sender = senders.content();
  await configure(w, { thresholdMinutes: 1, numQuestions: 1 });
  w.env.activeTab = REDDIT;
  await w.startup();
  await w.send("FORCE_TRIGGER_ALARM");
  assert.equal((await w.send("SNOOZE", { minutes: 5 }, sender)).ok, true);

  const wake = await w.chrome.alarms.get("focus-alarm-snooze-end");
  assert.equal(wake.scheduledTime, Date.now() + 5 * 60_000);

  advance(5 * 60_000);
  await w.alarmFires("focus-alarm-snooze-end"); // the only event: no tab switch, no tick
  assert.equal((await w.state()).snooze.snoozeUntil, null);
  assert.equal(await w.chrome.alarms.get("focus-alarm-snooze-end"), undefined);
  const threshold = await w.chrome.alarms.get("focus-alarm-threshold");
  assert.equal(threshold.scheduledTime, Date.now() + 60_000, "the threshold alarm is armed again");

  advance(60_000);
  await w.alarmFires("focus-alarm-threshold");
  assert.equal((await w.state()).alarmStatus, "ACTIVE", "the alarm reappears after the snooze");
});

test("snooze end alarm: re-armed if it fires early, re-created after a restart, removed by the master switch and reset", async (t) => {
  const advance = useClock(t);
  let w = await bootWorker();
  const sender = senders.content();
  await configure(w, { thresholdMinutes: 1, numQuestions: 1 });
  w.env.activeTab = REDDIT;
  await w.startup();
  await w.send("FORCE_TRIGGER_ALARM");
  await w.send("SNOOZE", { minutes: 10 }, sender);
  const until = (await w.state()).snooze.snoozeUntil;

  advance(10 * 60_000 - 1_000); // the wake-up arrives a second early
  await w.alarmFires("focus-alarm-snooze-end");
  assert.equal((await w.state()).snooze.snoozeUntil, until, "still snoozed");
  assert.equal((await w.chrome.alarms.get("focus-alarm-snooze-end")).scheduledTime, until, "armed again for the real end");

  w = await w.restart(); // new worker, Chrome kept no alarms
  w.env.activeTab = REDDIT;
  await w.startup();
  assert.equal((await w.chrome.alarms.get("focus-alarm-snooze-end")).scheduledTime, until, "re-created on startup");

  assert.equal((await w.send("SET_ENABLED", { enabled: false })).ok, true);
  assert.equal(await w.chrome.alarms.get("focus-alarm-snooze-end"), undefined, "switching off removes it");

  await w.send("SET_ENABLED", { enabled: true });
  await w.send("FORCE_TRIGGER_ALARM");
  await w.send("SNOOZE", { minutes: 5 }, sender);
  assert.ok(await w.chrome.alarms.get("focus-alarm-snooze-end"));
  await w.send("RESET_STATE");
  assert.equal(await w.chrome.alarms.get("focus-alarm-snooze-end"), undefined, "reset removes it");
});

test("a stale snooze end alarm does nothing while an alarm is ringing, and cleans itself up", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  const sender = senders.content();
  await configure(w, { thresholdMinutes: 1, numQuestions: 1 });
  w.env.activeTab = REDDIT;
  await w.startup();
  await w.send("FORCE_TRIGGER_ALARM");
  await w.send("SNOOZE", { minutes: 5 }, sender);
  await w.send("FORCE_TRIGGER_ALARM"); // the user starts a test alarm during the snooze
  assert.equal((await w.state()).alarmStatus, "ACTIVE");

  advance(5 * 60_000);
  await w.alarmFires("focus-alarm-snooze-end"); // the old wake-up still arrives
  const s = await w.state();
  assert.equal(s.alarmStatus, "ACTIVE", "the ringing alarm is not disturbed");
  assert.equal(await w.chrome.alarms.get("focus-alarm-snooze-end"), undefined);
});

test("snooze limits: per-episode limit holds until a challenge is solved; daily limit resets next day", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  const sender = senders.content();
  await configure(w, { maxSnoozes: 2, dailySnoozeLimit: 0, numQuestions: 1, topics: ["arrays"] });

  for (let i = 0; i < 2; i++) {
    await w.send("FORCE_TRIGGER_ALARM");
    assert.equal((await w.send("SNOOZE", { minutes: 5 }, sender)).ok, true, `snooze ${i + 1}`);
  }
  await w.send("FORCE_TRIGGER_ALARM");
  let r = await w.send("SNOOZE", { minutes: 5 }, sender);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no snoozes left/i);
  assert.equal((await w.send("GET_PUBLIC_CHALLENGE", {}, sender)).snoozesLeft, 0);

  const ch = await w.send("GET_PUBLIC_CHALLENGE", {}, sender);
  advance(2000);
  await w.send("SUBMIT_ANSWER", { answer: answerOf(w, ch.question.id) }, sender);
  await w.send("FORCE_TRIGGER_ALARM");
  assert.equal((await w.send("SNOOZE", { minutes: 5 }, sender)).ok, true, "solving resets the count");

  await configure(w, { maxSnoozes: 10, dailySnoozeLimit: 2 }); // already used 3 today
  await w.send("FORCE_TRIGGER_ALARM");
  r = await w.send("SNOOZE", { minutes: 5 }, sender);
  assert.equal(r.ok, false);
  assert.match(r.reason, /daily snooze limit/i);

  advance(26 * 3600_000);
  assert.equal((await w.send("SNOOZE", { minutes: 5 }, sender)).ok, true, "allowed again the next day");
});

// ---------------------------------------------------------------------------
// YouTube study channels, multiple tabs
// ---------------------------------------------------------------------------

test("study channel allowlist: survives worker restarts and is cleared when the page has no channel", async (t) => {
  const advance = useClock(t);
  let w = await bootWorker();
  await configure(w, { thresholdMinutes: 60, studyChannels: ["Fireship"] });
  w.env.activeTab = YOUTUBE_WATCH;
  await w.startup();

  assert.equal((await w.send("YOUTUBE_CHANNEL_INFO", { channel: "Fireship" }, senders.content(7))).ok, true);
  advance(60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 0);
  assert.equal((await w.debug()).lastObservation.reason, "study-channel");

  const env = w.env;
  w = await w.restart(); // the worker is killed all the time without the offscreen keepalive
  w.env.activeTab = env.activeTab;
  advance(60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.debug()).lastObservation.reason, "study-channel", "channel memory persisted");

  await w.send("YOUTUBE_CHANNEL_INFO", { channel: "" }, senders.content(7)); // user went to the home feed
  advance(60_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 60_000, "counts again once the study channel is gone");
});

test("channel reports from subframes or without a tab are ignored", async () => {
  const w = await bootWorker();
  assert.equal((await w.send("YOUTUBE_CHANNEL_INFO", { channel: "X" }, senders.contentSubframe())).ok, false);
  assert.equal((await w.send("YOUTUBE_CHANNEL_INFO", { channel: "X" }, senders.popup)).ok, false);
});

test("only the active tab counts when several distracting tabs are open", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  await configure(w, { thresholdMinutes: 60 });
  w.env.activeTab = REDDIT; // other tabs exist but chrome only reports the active one
  await w.startup();
  advance(30_000);
  await w.send("FORCE_TICK");
  advance(30_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 60_000, "not multiplied by the number of tabs");
});

// ---------------------------------------------------------------------------
// Overlay recovery
// ---------------------------------------------------------------------------

test("recover: refused while the question is available, so it cannot be used to skip questions", async () => {
  const w = await bootWorker();
  await configure(w, { numQuestions: 1 });
  await w.send("FORCE_TRIGGER_ALARM");
  assert.equal((await w.state()).alarmStatus, "ACTIVE");
  const r = await w.send("RECOVER_ALARM", {}, senders.content());
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot be dismissed/i);
  assert.equal((await w.state()).alarmStatus, "ACTIVE");
});

test("recover: dismisses the alarm only when its question can no longer be loaded", async () => {
  let w = await bootWorker();
  await configure(w, { numQuestions: 1 });
  await w.send("FORCE_TRIGGER_ALARM");
  const ringing = (await w.send("GET_PUBLIC_CHALLENGE", {}, senders.content())).question.id;
  // Restart with a bank that no longer contains the ringing question.
  w = await w.restart({ bank: BANK.filter((q) => q.id !== ringing) });
  const r = await w.send("RECOVER_ALARM", {}, senders.content());
  assert.equal(r.ok, true);
  assert.equal(r.recovered, true);
  const s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE");
  assert.equal(s.stats.failOpen, 1);
});

test("recover: nothing to do when no alarm is ringing, and works from content scripts only via the allowlist", async () => {
  const w = await bootWorker();
  const r = await w.send("RECOVER_ALARM", {}, senders.content());
  assert.equal(r.ok, true);
  assert.equal(r.nothingToDo, true);
  assert.equal((await w.send("RECOVER_ALARM", {}, senders.otherExtension)).ok, false);
});

// ---------------------------------------------------------------------------
// Security: who may send what
// ---------------------------------------------------------------------------

test("messages from other extensions, or with no sender, are rejected", async () => {
  const w = await bootWorker();
  for (const type of ["GET_STATE", "SET_ENABLED", "FORCE_TRIGGER_ALARM", "SNOOZE"]) {
    const r = await w.send(type, { enabled: false }, senders.otherExtension);
    assert.equal(r.ok, false, type);
  }
  assert.equal((await w.send("GET_STATE", {}, null)).ok, false);
  assert.equal((await w.send(undefined, {}, senders.popup)).ok, false);
});

test("content scripts cannot use privileged messages", async () => {
  const w = await bootWorker();
  for (const type of ["SET_ENABLED", "SET_SETTINGS", "FORCE_TRIGGER_ALARM", "FORCE_TICK", "RESET_STATE", "GET_STATE", "GET_SETTINGS", "GET_DEBUG_INFO", "START_STUDY_MODE", "STOP_STUDY_MODE", "GET_ACCESS", "SYNC_ACCESS", "GET_ONBOARDING", "FINISH_ONBOARDING"]) {
    const r = await w.send(type, { enabled: false, minutes: 30, settings: {} }, senders.content());
    assert.equal(r.ok, false, `${type} must be refused for content scripts`);
  }
  assert.equal((await w.send("GET_SETTINGS")).enabled, true, "settings untouched");
});

test("an unknown message type from the popup is refused", async () => {
  const w = await bootWorker();
  assert.equal((await w.send("DO_SOMETHING_ELSE")).ok, false);
});

// ---------------------------------------------------------------------------
// Corrupted storage
// ---------------------------------------------------------------------------

test("malformed stored settings and state are repaired, never thrown on", async () => {
  const local = makeStore({
    settings: { thresholdMinutes: "abc", distractingSites: "reddit.com", numQuestions: 9999, topics: ["nope"], difficulty: "extreme", maxSnoozes: -3, enabled: "yes" },
    state: "garbage",
    tracking: { accumulatedMs: -50, lastObservedAt: "yesterday", lastKind: "dancing", byHost: { "a.com": "lots" } }
  });
  const w = await bootWorker({ local });
  const settings = await w.send("GET_SETTINGS");
  assert.equal(settings.thresholdMinutes, 20);
  assert.ok(Array.isArray(settings.distractingSites) && settings.distractingSites.includes("youtube.com"));
  assert.equal(settings.numQuestions, 10);
  assert.deepEqual(settings.topics, []);
  assert.equal(settings.difficulty, "mixed");
  assert.equal(settings.maxSnoozes, 0);
  assert.equal(settings.enabled, true);

  const s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE");
  assert.equal(s.tracking.accumulatedMs, 0);
  assert.equal(s.tracking.lastKind, "away");
});

test("an ACTIVE alarm with a missing or broken challenge is recovered instead of trapping the user", async () => {
  for (const challenge of [null, { questions: [], currentIndex: 0 }, { questions: [{ id: 1 }], currentIndex: 5 }, "oops"]) {
    const local = makeStore({ state: { alarmStatus: "ACTIVE", currentChallenge: challenge } });
    const w = await bootWorker({ local });
    const s = await w.state();
    assert.equal(s.alarmStatus, "INACTIVE");
    assert.equal(s.stats.failOpen, 1);
    assert.match(s.lastError, /recovered/i);
  }
});

test("RESET_STATE returns to a clean slate", async () => {
  const w = await bootWorker();
  await ringWith(w);
  await w.send("RESET_STATE");
  const s = await w.state();
  assert.equal(s.alarmStatus, "INACTIVE");
  assert.equal(s.stats.alarmsTriggered, 0);
});

// ---------------------------------------------------------------------------
// Host access and the dynamically registered overlay script
// ---------------------------------------------------------------------------

const SCRIPT_ID = "focus-alarm-overlay";
const pat = (site) => `*://*.${site}/*`;

test("no access: nothing is registered, the scope is 'none', and nothing can be tracked", async (t) => {
  const advance = useClock(t);
  const w = await bootWorker();
  w.env.grantedOrigins = [];
  w.env.activeTab = { id: 1, url: undefined }; // Chrome hides the URL without host access
  await configure(w, { thresholdMinutes: 1 });
  await w.startup();
  assert.equal(w.env.registered.size, 0);
  assert.equal((await w.send("GET_ACCESS")).scope, "none");
  advance(90_000);
  await w.send("FORCE_TICK");
  assert.equal((await w.state()).tracking.accumulatedMs, 0);
});

test("all-sites access registers one script for every http(s) page", async () => {
  const w = await bootWorker();
  w.env.grantedOrigins = ["<all_urls>"];
  await w.send("SYNC_ACCESS");
  const script = w.env.registered.get(SCRIPT_ID);
  assert.deepEqual(script.matches.sort(), ["http://*/*", "https://*/*"]);
  assert.deepEqual(script.js, ["content-script.js"]);
  assert.equal(script.persistAcrossSessions, true);
  assert.equal(w.env.registered.size, 1);
  assert.equal((await w.send("GET_ACCESS")).scope, "all");
});

test("blocklist-only access registers just those sites, and follows blocklist edits", async () => {
  const w = await bootWorker();
  await configure(w, { distractingSites: ["reddit.com", "x.com"] });
  w.env.grantedOrigins = [pat("reddit.com"), pat("x.com")];
  await w.send("SYNC_ACCESS");
  assert.deepEqual(w.env.registered.get(SCRIPT_ID).matches.sort(), [pat("reddit.com"), pat("x.com")].sort());
  assert.equal((await w.send("GET_ACCESS")).scope, "sites");

  // The user adds a site they have not granted yet: the script must not claim access it lacks.
  await configure(w, { distractingSites: ["reddit.com", "x.com", "tiktok.com"] });
  assert.deepEqual(w.env.registered.get(SCRIPT_ID).matches.sort(), [pat("reddit.com"), pat("x.com")].sort());
  const access = await w.send("GET_ACCESS");
  assert.equal(access.scope, "partial");
  assert.deepEqual(access.missingSites, ["tiktok.com"]);
  assert.deepEqual(access.missingPatterns, [pat("tiktok.com")]);
});

test("revoking access unregisters the script; granting again re-registers it (no duplicate IDs)", async () => {
  const w = await bootWorker();
  w.env.grantedOrigins = ["<all_urls>"];
  await w.fire(w.chrome.permissions.onAdded, {});
  assert.equal(w.env.registered.size, 1);
  await w.fire(w.chrome.permissions.onAdded, {}); // duplicate event
  assert.equal(w.env.registered.size, 1);

  w.env.grantedOrigins = [];
  await w.fire(w.chrome.permissions.onRemoved, {});
  assert.equal(w.env.registered.size, 0);

  w.env.grantedOrigins = ["<all_urls>"];
  await w.fire(w.chrome.permissions.onAdded, {});
  assert.equal(w.env.registered.size, 1);
});

test("scope changes (all to narrow) update the script in place", async () => {
  const w = await bootWorker();
  await configure(w, { distractingSites: ["reddit.com"] });
  w.env.grantedOrigins = ["<all_urls>"];
  await w.send("SYNC_ACCESS");
  w.env.grantedOrigins = [pat("reddit.com")];
  await w.send("SYNC_ACCESS");
  assert.deepEqual(w.env.registered.get(SCRIPT_ID).matches, [pat("reddit.com")]);
  assert.equal(w.env.registered.size, 1);
});

test("granting access injects the overlay script into tabs that are already open", async () => {
  const w = await bootWorker();
  w.env.grantedOrigins = ["<all_urls>"];
  w.env.openTabs = [{ id: 11 }, { id: 12 }, { id: undefined }];
  await w.send("SYNC_ACCESS");
  assert.deepEqual(w.env.injected, [11, 12]);
});

test("a worker restart re-registers the script if Chrome dropped it (e.g. after an update)", async () => {
  let w = await bootWorker();
  w.env.grantedOrigins = ["<all_urls>"];
  await w.send("SYNC_ACCESS");
  const env = w.env;
  env.registered.clear(); // Chrome forgot the registration
  w = await w.restart();
  w.env.grantedOrigins = env.grantedOrigins;
  await w.startup();
  assert.equal(w.env.registered.size, 1);
});

test("a failure to register is reported, not thrown, and tracking keeps working", async () => {
  const w = await bootWorker();
  w.env.grantedOrigins = ["<all_urls>"];
  w.env.registered.clear(); // boot already registered it; force a fresh registration attempt
  w.chrome.scripting.registerContentScripts = async () => { throw new Error("boom"); };
  const res = await w.send("SYNC_ACCESS");
  assert.equal(res.scope, "all");
  assert.match(res.error, /boom/);
  assert.equal((await w.send("FORCE_TICK")).ok, true);
});

test("onboarding flag round-trips through the background", async () => {
  const w = await bootWorker();
  assert.deepEqual(await w.send("GET_ONBOARDING"), { done: false });
  assert.equal((await w.send("FINISH_ONBOARDING")).ok, true);
  assert.deepEqual(await w.send("GET_ONBOARDING"), { done: true });
  const w2 = await w.restart();
  assert.deepEqual(await w2.send("GET_ONBOARDING"), { done: true });
});

test("first install opens the welcome page once; updates and restarts do not", async () => {
  const w = await bootWorker();
  await w.fire(w.chrome.runtime.onInstalled, { reason: "update" });
  await w.startup();
  assert.deepEqual(w.env.createdTabs, []);
  await w.fire(w.chrome.runtime.onInstalled, { reason: "install" });
  assert.deepEqual(w.env.createdTabs, [`chrome-extension://testextensionid/welcome.html`]);
});
