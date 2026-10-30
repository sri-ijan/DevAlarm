import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SETTINGS, TOPICS, MAX_CREDIT_GAP_MS,
  normalizeSite, hostMatchesSite, hostOnList, channelOnList, getHostname, isInternalUrl,
  classify, advanceTracking, freshTracking, nextThresholdAt, topHost,
  sanitizeSettings, sanitizeState, snoozeCheck, applySnooze, dayKey,
  isValidQuestion, isCorrectAnswer, normalizeBlank, selectQuestions, toPublicQuestion, canAttempt,
  isAuthorized, originsGrantAll, accessStatus, ALL_HOST_PATTERNS, siteToOriginPatterns
} from "../engine.js";

const BANK = JSON.parse(readFileSync(new URL("../data/questions.json", import.meta.url), "utf8"));
const settings = { ...DEFAULT_SETTINGS, thresholdMinutes: 10, awayResetMinutes: 5 };

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

test("normalizeSite accepts hostnames and URLs, rejects junk", () => {
  assert.equal(normalizeSite("https://www.YouTube.com/watch?v=1"), "youtube.com");
  assert.equal(normalizeSite("  reddit.com  "), "reddit.com");
  assert.equal(normalizeSite("m.x.com:8080/path"), "m.x.com");
  for (const bad of ["", "localhost", "not a site", "a..b", "<script>", 5, null, undefined, "javascript:alert(1)"]) {
    assert.equal(normalizeSite(bad), null, String(bad));
  }
});

test("hostMatchesSite is exact-or-subdomain, never a substring", () => {
  assert.equal(hostMatchesSite("x.com", "x.com"), true);
  assert.equal(hostMatchesSite("m.x.com", "x.com"), true);
  assert.equal(hostMatchesSite("www.reddit.com", "reddit.com"), true);
  assert.equal(hostMatchesSite("dropbox.com", "x.com"), false);
  assert.equal(hostMatchesSite("netflix.com", "x.com"), false);
  assert.equal(hostMatchesSite("notreddit.com", "reddit.com"), false);
  assert.equal(hostMatchesSite("reddit.com.evil.io", "reddit.com"), false);
  assert.equal(hostOnList("old.reddit.com", ["twitter.com", "reddit.com"]), true);
  assert.equal(hostOnList("a.com", null), false);
});

test("study channel allowlist: case-insensitive substring, minimum 3 characters", () => {
  assert.equal(channelOnList("Fireship", ["fireship"]), true);
  assert.equal(channelOnList("Traversy Media", ["Traversy"]), true);
  assert.equal(channelOnList("Some Channel", ["ab"]), false, "too short to be meaningful");
  assert.equal(channelOnList("", ["fireship"]), false);
  assert.equal(channelOnList(null, ["fireship"]), false);
  assert.equal(channelOnList("x", []), false);
});

test("url helpers", () => {
  assert.equal(getHostname("https://www.Reddit.com/r/x"), "reddit.com");
  assert.equal(getHostname("not a url"), null);
  assert.equal(isInternalUrl("chrome://extensions"), true);
  assert.equal(isInternalUrl("chrome-extension://abc/debug.html"), true);
  assert.equal(isInternalUrl("https://reddit.com"), false);
});

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

const base = { tab: { url: "https://www.reddit.com/", audible: false }, windowFocused: true, idleState: "active", channel: null, settings, now: 1000, snoozeUntil: null, studyUntil: null };
const c = (over) => classify({ ...base, ...over });

test("classify: the decision table", () => {
  assert.deepEqual(c({}), { kind: "countable", hostname: "reddit.com", reason: "on-blocklist" });
  assert.equal(c({ tab: null }).kind, "away");
  assert.equal(c({ tab: { url: "" } }).kind, "away");
  assert.equal(c({ tab: { url: "chrome://settings" } }).kind, "paused");
  assert.equal(c({ tab: { url: "file:///home/me/a.html" } }).kind, "away");
  assert.equal(c({ tab: { url: "https://github.com/" } }).reason, "not-on-blocklist");
  assert.equal(c({ windowFocused: false }).reason, "browser-not-focused");
  assert.equal(c({ idleState: "idle" }).reason, "idle");
  assert.equal(c({ idleState: "locked", tab: { url: "https://www.reddit.com/", audible: true } }).kind, "away");
  assert.equal(c({ idleState: "idle", tab: { url: "https://www.reddit.com/", audible: true } }).kind, "countable");
  assert.equal(c({ snoozeUntil: 5000 }).reason, "snoozed");
  assert.equal(c({ snoozeUntil: 500 }).kind, "countable", "expired snooze is ignored");
  assert.equal(c({ studyUntil: 5000 }).reason, "study-mode");
});

test("classify: YouTube study channels", () => {
  const yt = { tab: { url: "https://www.youtube.com/watch?v=1", audible: false } };
  const s = { ...settings, studyChannels: ["Fireship"] };
  assert.equal(c({ ...yt, settings: s, channel: "Fireship" }).reason, "study-channel");
  assert.equal(c({ ...yt, settings: s, channel: "MrBeast" }).kind, "countable");
  assert.equal(c({ ...yt, settings: s, channel: null }).kind, "countable", "unknown channel is not assumed to be study");
  assert.equal(c({ tab: { url: "https://www.reddit.com/" }, settings: s, channel: "Fireship" }).kind, "countable", "allowlist only applies on YouTube");
});

// ---------------------------------------------------------------------------
// advanceTracking
// ---------------------------------------------------------------------------

const step = (tr, kind, now, host = "reddit.com") => advanceTracking(tr, { kind, hostname: kind === "countable" ? host : null }, now, settings);

test("advanceTracking credits time to the PREVIOUS state", () => {
  let { tracking } = step(freshTracking(0, "away"), "countable", 0);
  ({ tracking } = step(tracking, "away", 40_000));
  assert.equal(tracking.accumulatedMs, 40_000);
  assert.equal(tracking.byHost["reddit.com"], 40_000);
  ({ tracking } = step(tracking, "away", 100_000));
  assert.equal(tracking.accumulatedMs, 40_000);
});

test("advanceTracking: threshold crossing, remaining time", () => {
  let r = step(freshTracking(0, "countable"), "countable", 0);
  for (let t = 60_000; t < 600_000; t += 60_000) r = step(r.tracking, "countable", t);
  assert.equal(r.crossed, false);
  assert.equal(r.remainingMs, 60_000);
  r = step(r.tracking, "countable", 599_999);
  assert.equal(r.crossed, false);
  assert.equal(r.remainingMs, 1);
  r = step(r.tracking, "countable", 600_000);
  assert.equal(r.crossed, true);
  assert.equal(r.remainingMs, 0);
});

test("advanceTracking: gap cap, clock moving backwards, paused", () => {
  let r = step({ ...freshTracking(0, "countable") }, "countable", 10 * 3600_000);
  assert.equal(r.tracking.accumulatedMs, MAX_CREDIT_GAP_MS);

  r = step({ ...freshTracking(100_000, "countable") }, "countable", 50_000); // clock went back
  assert.equal(r.tracking.accumulatedMs, 0);

  r = step({ ...freshTracking(0, "paused"), accumulatedMs: 12_345 }, "countable", 60_000);
  assert.equal(r.tracking.accumulatedMs, 12_345, "paused time is credited to nothing and does not reset");
});

test("advanceTracking idle refund: takes back the idle lead-in, bounded by what was credited and by the current run", () => {
  const idleObs = (ms) => ({ kind: "away", hostname: null, idleRefundMs: ms });
  const run = (tr, obs, now) => advanceTracking(tr, obs, now, settings).tracking;
  // 100 s credited in earlier observations, then a 60 s gap that ends in idle: 180 s lead-in covers all of it.
  let tr = freshTracking(0, "countable");
  tr = run(tr, { kind: "countable", hostname: "reddit.com" }, 0);
  tr = run(tr, { kind: "countable", hostname: "reddit.com" }, 100_000);
  tr = run(tr, idleObs(180_000), 160_000);
  assert.equal(tr.accumulatedMs, 0, "refund is capped by the run (160 s), so everything is taken back");
  assert.equal(tr.awayMs, 0, "the away clock is not pre-loaded");
  assert.deepEqual(tr.byHost, {});
  assert.equal(tr.runMs, 0);

  // A smaller lead-in only takes back its own length.
  tr = run(freshTracking(0, "countable"), { kind: "countable", hostname: "reddit.com" }, 0);
  tr = run(tr, { kind: "countable", hostname: "reddit.com" }, 120_000);
  tr = run(tr, idleObs(60_000), 180_000);
  assert.equal(tr.accumulatedMs, 120_000 + 60_000 - 60_000);
  assert.equal(tr.byHost["reddit.com"], 120_000);

  // Gap longer than MAX_CREDIT_GAP_MS: the idle window is the END of the gap. 200 s gap, 150 s credited,
  // 50 s never credited, so only 130 s of a 180 s lead-in overlap credited time.
  tr = { ...freshTracking(0, "countable"), accumulatedMs: 0 };
  tr = run(tr, idleObs(180_000), 200_000);
  assert.equal(tr.accumulatedMs, 20_000, "150 s credited minus 130 s refund");
  // A 10-minute gap: the lead-in lies entirely in the part that was never credited.
  tr = run(freshTracking(0, "countable"), idleObs(180_000), 600_000);
  assert.equal(tr.accumulatedMs, MAX_CREDIT_GAP_MS, "nothing to refund");

  // Only an away observation refunds; staying countable or being paused does not.
  const stay = advanceTracking(freshTracking(0, "countable"), { kind: "countable", hostname: "reddit.com", idleRefundMs: 60_000 }, 60_000, settings).tracking;
  assert.equal(stay.accumulatedMs, 60_000);
  const paused = advanceTracking(freshTracking(0, "countable"), { kind: "paused", hostname: null, idleRefundMs: 60_000 }, 60_000, settings).tracking;
  assert.equal(paused.accumulatedMs, 60_000);
  assert.equal(paused.runMs, 0, "a pause ends the run");
  // Away, then idle observed again later: nothing left to refund.
  const again = advanceTracking({ ...freshTracking(0, "away"), accumulatedMs: 50_000 }, idleObs(60_000), 30_000, settings).tracking;
  assert.equal(again.accumulatedMs, 50_000);
});

test("tracking.runMs is validated and defaults to 0", () => {
  assert.equal(freshTracking(5).runMs, 0);
  assert.equal(sanitizeState({ tracking: { runMs: -5 } }).tracking.runMs, 0);
  assert.equal(sanitizeState({ tracking: { runMs: "x" } }).tracking.runMs, 0);
  assert.equal(sanitizeState({ tracking: { runMs: 4_500.7 } }).tracking.runMs, 4_500);
  assert.equal(sanitizeState(undefined).tracking.runMs, 0, "old stored tracking without runMs is fine");
});

test("advanceTracking: away reset only after awayResetMinutes", () => {
  let t = { ...freshTracking(0, "away"), accumulatedMs: 100_000, byHost: { "reddit.com": 100_000 } };
  let r = step(t, "away", 100_000);
  assert.equal(r.tracking.accumulatedMs, 100_000);
  r = step(r.tracking, "away", 200_000);
  r = step(r.tracking, "away", 300_000);
  assert.equal(r.tracking.accumulatedMs, 0);
  assert.deepEqual(r.tracking.byHost, {});
});

test("advanceTracking does not mutate its input", () => {
  const t = freshTracking(0, "countable");
  const copy = JSON.stringify(t);
  step(t, "countable", 5000);
  assert.equal(JSON.stringify(t), copy);
});

test("nextThresholdAt / topHost", () => {
  assert.equal(nextThresholdAt({ ...freshTracking(0, "countable"), accumulatedMs: 100_000 }, 1000, settings), 1000 + 500_000);
  assert.equal(nextThresholdAt(freshTracking(0, "away"), 1000, settings), null);
  assert.equal(nextThresholdAt({ ...freshTracking(0, "countable"), accumulatedMs: 9e9 }, 1000, settings), 2000, "never in the past");
  assert.equal(topHost({ a: 1, b: 5, c: 3 }), "b");
  assert.equal(topHost({}), null);
});

// ---------------------------------------------------------------------------
// Sanitising stored data
// ---------------------------------------------------------------------------

test("sanitizeSettings clamps, filters and defaults", () => {
  const s = sanitizeSettings({ thresholdMinutes: -5, numQuestions: 500, maxSnoozes: 99, difficulty: "x", topics: ["arrays", "bogus", "arrays"], distractingSites: ["https://A.com/x", "bad host", "a.com"], studyChannels: ["  Fireship ", 5, ""], idleSeconds: 1 });
  assert.equal(s.thresholdMinutes, 0.1);
  assert.equal(s.numQuestions, 10);
  assert.equal(s.maxSnoozes, 10);
  assert.equal(s.difficulty, "mixed");
  assert.deepEqual(s.topics, ["arrays"]);
  assert.deepEqual(s.distractingSites, ["a.com"]);
  assert.deepEqual(s.studyChannels, ["Fireship"]);
  assert.equal(s.idleSeconds, 15);
  for (const junk of [null, undefined, 5, "x", [], () => 1]) assert.deepEqual(sanitizeSettings(junk), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings(sanitizeSettings({ thresholdMinutes: 7 })), sanitizeSettings({ thresholdMinutes: 7 }), "idempotent");
});

test("sanitizeState never throws and always yields a coherent state", () => {
  for (const junk of [null, undefined, 5, "x", [], { tracking: 5 }, { stats: { alarmsTriggered: "many" } }, { snooze: { snoozeUntil: "soon" } }]) {
    const s = sanitizeState(junk);
    assert.equal(s.alarmStatus, "INACTIVE");
    assert.equal(s.stats.alarmsTriggered, 0);
    assert.equal(s.snooze.snoozeUntil, null);
    assert.equal(s.currentChallenge, null);
  }
});

// ---------------------------------------------------------------------------
// Snoozing
// ---------------------------------------------------------------------------

test("snoozeCheck / applySnooze", () => {
  const now = Date.UTC(2026, 5, 15, 12);
  const snooze = { snoozeUntil: null, usedThisEpisode: 0, usedDay: null, usedToday: 0 };
  assert.equal(snoozeCheck(snooze, settings, 5, now).ok, true);
  for (const m of [0, 1, 7, 61, "5", NaN, Infinity]) assert.equal(snoozeCheck(snooze, settings, m, now).ok, false, String(m));

  const used = applySnooze(applySnooze(snooze, 5, now), 5, now);
  assert.equal(used.usedThisEpisode, 2);
  assert.equal(snoozeCheck(used, settings, 5, now).ok, false);

  const daily = { ...settings, maxSnoozes: 10, dailySnoozeLimit: 2 };
  assert.equal(snoozeCheck(used, daily, 5, now).ok, false);
  assert.equal(snoozeCheck(used, daily, 5, now + 36 * 3600_000).ok, true);
  assert.equal(dayKey(now), dayKey(now + 60_000));
});

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

test("normalizeBlank and isCorrectAnswer", () => {
  assert.equal(normalizeBlank("Pre-Order "), "preorder");
  const blank = { id: 1, format: "blank", question: "q", answer: "Pre-order", accept: ["pre order traversal"] };
  assert.equal(isCorrectAnswer(blank, "preorder"), true);
  assert.equal(isCorrectAnswer(blank, "PRE ORDER"), true);
  assert.equal(isCorrectAnswer(blank, "Pre-order traversal"), true);
  assert.equal(isCorrectAnswer(blank, "inorder"), false);
  assert.equal(isCorrectAnswer(blank, ""), false);
  assert.equal(isCorrectAnswer(blank, "---"), false, "punctuation only must not match an empty normalised answer");
  assert.equal(isCorrectAnswer(blank, "x".repeat(1000)), false);
  assert.equal(isCorrectAnswer(blank, 42), false);

  const mcq = { id: 2, format: "mcq", question: "q", options: ["O(1)", "O(n)"], answer: "O(1)" };
  assert.equal(isCorrectAnswer(mcq, "O(1)"), true);
  assert.equal(isCorrectAnswer(mcq, " O(1) "), true);
  assert.equal(isCorrectAnswer(mcq, "o(1)"), false, "MCQ is an exact option");
  assert.equal(isCorrectAnswer(mcq, "O(n)"), false);

  assert.equal(isCorrectAnswer({ id: 3, format: "mcq", question: "q", options: ["a", "b"], answer: "zzz" }, "zzz"), false, "broken question can never be 'solved' by accident");
  assert.equal(isCorrectAnswer(null, "x"), false);
});

test("selectQuestions: topics are strict, difficulty is a preference, invalid questions are dropped", () => {
  const bank = [
    { id: 1, topic: "arrays", difficulty: "easy", format: "blank", question: "a", answer: "x" },
    { id: 2, topic: "arrays", difficulty: "hard", format: "blank", question: "b", answer: "x" },
    { id: 3, topic: "trees", difficulty: "easy", format: "blank", question: "c", answer: "x" },
    { id: 4, topic: "arrays", difficulty: "easy", format: "mcq", question: "d", options: ["only one"], answer: "only one" }, // invalid: needs 2+ options
    { id: 5, topic: "arrays", difficulty: "easy", format: "blank", question: "e" } // invalid: no answer
  ];
  const s = { ...settings, topics: ["arrays"], numQuestions: 5, difficulty: "mixed" };
  const r = selectQuestions(bank, s);
  assert.deepEqual(r.questions.map((q) => q.id).sort(), [1, 2]);

  const easy = selectQuestions(bank, { ...s, difficulty: "easy", numQuestions: 2 });
  assert.equal(easy.relaxedDifficulty, true, "only one easy arrays question exists, so one other difficulty fills in");
  assert.deepEqual(easy.questions.map((q) => q.id).sort(), [1, 2]);

  assert.deepEqual(selectQuestions(bank, { ...s, topics: ["graphs"] }), { questions: [], relaxedDifficulty: false });
  assert.deepEqual(selectQuestions("not a bank", s), { questions: [], relaxedDifficulty: false });
  assert.deepEqual(selectQuestions(bank, { ...s, topics: [], numQuestions: 1 }).questions.length, 1);
});

test("selectQuestions is deterministic with an injected rng", () => {
  const rng = () => 0;
  const a = selectQuestions(BANK, { ...settings, numQuestions: 3 }, rng).questions.map((q) => q.id);
  const b = selectQuestions(BANK, { ...settings, numQuestions: 3 }, rng).questions.map((q) => q.id);
  assert.deepEqual(a, b);
});

test("toPublicQuestion exposes only whitelisted fields", () => {
  const q = { id: 9, topic: "arrays", type: "concept", difficulty: "easy", format: "mcq", question: "q", code: "x=1", options: ["a", "b"], answer: "a", accept: ["z"], hint: "secret", secretField: 1 };
  const pub = toPublicQuestion(q);
  assert.deepEqual(Object.keys(pub).sort(), ["code", "difficulty", "format", "id", "options", "question", "topic", "type"]);
  assert.deepEqual([...toPublicQuestion(q, Math.random, true).options].sort(), ["a", "b"]);
  assert.equal(toPublicQuestion({ ...q, format: "blank" }).options, undefined);
});

test("canAttempt enforces the minimum spacing", () => {
  assert.equal(canAttempt({ lastAttemptAt: null }, 5), true);
  assert.equal(canAttempt({ lastAttemptAt: 1000 }, 1500), false);
  assert.equal(canAttempt({ lastAttemptAt: 1000 }, 2600), true);
});

// ---------------------------------------------------------------------------
// The real question bank
// ---------------------------------------------------------------------------

test("question bank: every question is valid, ids unique, MCQ answers are among their options", () => {
  assert.ok(BANK.length >= 100);
  const ids = new Set();
  for (const q of BANK) {
    assert.ok(isValidQuestion(q), `question ${q.id} must be valid`);
    assert.ok(!ids.has(q.id), `duplicate id ${q.id}`);
    ids.add(q.id);
    assert.ok(TOPICS.includes(q.topic), `question ${q.id}: unknown topic ${q.topic}`);
    assert.ok(["easy", "medium", "hard"].includes(q.difficulty), `question ${q.id}: difficulty`);
    assert.ok(typeof q.hint === "string" && q.hint.trim(), `question ${q.id}: needs a hint`);
    if (q.format === "mcq") {
      assert.equal(new Set(q.options.map((o) => o.trim())).size, q.options.length, `question ${q.id}: duplicate options`);
    }
  }
});

test("question bank: no duplicate question text, blank answers are short", () => {
  const seen = new Map();
  for (const q of BANK) {
    const key = normalizeBlank(q.question + (q.code || ""));
    assert.ok(!seen.has(key), `question ${q.id} duplicates ${seen.get(key)}`);
    seen.set(key, q.id);
    if (q.format === "blank") assert.ok(q.answer.trim().split(/\s+/).length <= 2, `blank question ${q.id} should have a one or two word answer`);
  }
});

test("question bank: a blank question does not contain its own answer in the text unless offered as a choice", () => {
  // Questions that list the options inline ("mutable or immutable") are allowed, but a stem
  // that simply states the answer is a bug.
  for (const q of BANK.filter((x) => x.format === "blank")) {
    const answer = q.answer.toLowerCase();
    if (normalizeBlank(answer).length <= 3) continue;
    // Code identifiers such as arr[left] are not a giveaway, so ignore anything in [brackets].
    const stem = q.question.toLowerCase().replace(/\[[^\]]*\]/g, "");
    if (!stem.includes(answer)) continue;
    assert.match(q.question, /\bor\b/i, `question ${q.id} reveals its answer "${q.answer}" in the stem`);
  }
});

test("every topic has at least 4 questions so a topic filter always works", () => {
  for (const topic of TOPICS) assert.ok(BANK.filter((q) => q.topic === topic).length >= 4, topic);
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

test("isAuthorized", () => {
  const id = "abc";
  const origin = "chrome-extension://abc/";
  const popup = { id, url: "chrome-extension://abc/popup.html" };
  const content = { id, url: "https://example.com", tab: { id: 1 }, frameId: 0 };
  assert.equal(isAuthorized("SET_ENABLED", popup, id, origin), true);
  assert.equal(isAuthorized("SET_ENABLED", content, id, origin), false);
  assert.equal(isAuthorized("SUBMIT_ANSWER", content, id, origin), true);
  assert.equal(isAuthorized("SUBMIT_ANSWER", { ...content, tab: undefined }, id, origin), false, "content-script messages need a tab");
  assert.equal(isAuthorized("YOUTUBE_CHANNEL_INFO", { ...content, frameId: 2 }, id, origin), false);
  assert.equal(isAuthorized("GET_STATE", { ...popup, id: "other" }, id, origin), false);
  assert.equal(isAuthorized("GET_STATE", null, id, origin), false);
  assert.equal(isAuthorized("GET_STATE", { id, url: "chrome-extension://abcevil/x.html" }, id, origin), false, "origin prefix must match exactly");
});

// ---------------------------------------------------------------------------
// Host access scopes
// ---------------------------------------------------------------------------

test("originsGrantAll recognises every spelling of 'all sites'", () => {
  assert.equal(originsGrantAll(["<all_urls>"]), true);
  assert.equal(originsGrantAll(["*://*/*"]), true);
  assert.equal(originsGrantAll(["http://*/*", "https://*/*"]), true);
  assert.equal(originsGrantAll(["https://*/*"]), false);
  assert.equal(originsGrantAll(["*://*.reddit.com/*"]), false);
  assert.equal(originsGrantAll([]), false);
  assert.equal(originsGrantAll(null), false);
});

test("accessStatus: scope and the origin patterns to register", () => {
  const sites = ["reddit.com", "x.com"];
  const p = (s) => siteToOriginPatterns(s)[0];

  let a = accessStatus(["<all_urls>"], sites);
  assert.equal(a.scope, "all");
  assert.deepEqual(a.matches, ALL_HOST_PATTERNS);
  assert.deepEqual(a.missingSites, []);

  a = accessStatus([p("reddit.com"), p("x.com")], sites);
  assert.equal(a.scope, "sites");
  assert.deepEqual(a.matches.sort(), [p("reddit.com"), p("x.com")].sort());

  a = accessStatus([p("reddit.com")], sites);
  assert.equal(a.scope, "partial");
  assert.deepEqual(a.missingSites, ["x.com"]);
  assert.deepEqual(a.missingPatterns, [p("x.com")]);
  assert.deepEqual(a.matches, [p("reddit.com")]);

  a = accessStatus([], sites);
  assert.equal(a.scope, "none");
  assert.deepEqual(a.matches, []);

  assert.equal(accessStatus([p("other.com")], sites).scope, "none", "access to unrelated sites is not access to the blocklist");
  assert.equal(accessStatus([p("reddit.com")], []).scope, "none", "an empty blocklist never reads as full access");
  assert.equal(accessStatus(undefined, undefined).scope, "none");
});
