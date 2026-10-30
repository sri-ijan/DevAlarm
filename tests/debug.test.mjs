// The debug page is a plain script that reads whatever background.js answers to GET_DEBUG_INFO.
// Nothing used to tie the two together, so a debug.js left over from v0.2 (it reads
// info.distraction, info.focusSession, info.offscreenActive) kept shipping next to a v0.3
// background.js and threw "Cannot read properties of undefined (reading 'lastTickAt')".
// These tests run the REAL background.js and the REAL debug.js together against a stub DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { makeStore, makeChrome, sendMessage, senders } from "./helpers/fake-chrome.mjs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const DEBUG_HTML = read("../debug.html");
const DEBUG_JS = read("../debug.js");
const HTML_IDS = [...DEBUG_HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const REDDIT = { id: 1, url: "https://www.reddit.com/r/all", audible: false };
const BANK = [{ id: 1, topic: "arrays", type: "concept", difficulty: "easy", format: "blank", question: "Fill the gap: first greek letter is ____.", answer: "alpha", hint: "h" }];

let boots = 0;
async function bootBackground({ fetchFails = false } = {}) {
  const fake = makeChrome({ local: makeStore(), session: makeStore(), now: () => Date.now() });
  globalThis.chrome = fake.chrome;
  globalThis.fetch = async () => {
    if (fetchFails) throw new Error("network down");
    return { ok: true, status: 200, json: async () => structuredClone(BANK) };
  };
  await import(`../background.js?debugpage=${++boots}`);
  const send = (message, sender = senders.popup) => sendMessage(fake.chrome, message, sender);
  await send({ type: "GET_STATE" });
  return { fake, send };
}

/** Runs debug.js (or another source) in a vm with a stub document built from debug.html's ids. */
function loadPage(send, source = DEBUG_JS) {
  const els = new Map(HTML_IDS.map((id) => [id, { id, textContent: "-", className: "value", style: {}, addEventListener() {} }]));
  const errors = [];
  const sandbox = {
    document: { getElementById: (id) => els.get(id) || null }, // unknown id -> null, like a real page
    chrome: { runtime: { sendMessage: send } },
    console: { error: (...a) => errors.push(a.map(String).join(" ")), log() {} },
    setInterval: () => 0
  };
  vm.runInNewContext(source, sandbox);
  return { text: (id) => els.get(id).textContent, cls: (id) => els.get(id).className, errors, refresh: () => sandbox.refresh() };
}

test("debug page renders every row from the real GET_DEBUG_INFO reply and raises no error", async () => {
  const { fake, send } = await bootBackground();
  fake.env.activeTab = REDDIT;
  for (const fn of fake.chrome.runtime.onStartup.listeners) fn();
  await send({ type: "GET_STATE" }); // resolves after the queued startup work

  const page = loadPage(send);
  await page.refresh();

  assert.deepEqual(page.errors, []);
  assert.equal(page.text("alarm-status"), "INACTIVE");
  assert.match(page.text("bank-status"), /^1 questions loaded$/);
  assert.equal(page.text("last-error"), "none");
  assert.match(page.text("alarms-list"), /focus-alarm-tick in \d+m \d+s/);
  assert.match(page.text("last-tick"), /^\d+s ago \(.+\)$/);
  assert.equal(page.text("active-tab"), "reddit.com");
  assert.match(page.text("is-distracting"), /^YES, counting \(on-blocklist\)$/);
  assert.equal(page.text("is-idle"), "no (active)");
  assert.match(page.text("accumulated"), /^0m 0s \/ 20m \(0%\)$/);
  assert.equal(page.text("snooze-status"), "not snoozed");
  assert.equal(page.text("snoozes-used"), "0");
  assert.equal(page.text("focus-session"), "off");
  assert.notEqual(page.cls("alarm-status"), "value bad");
});

test("every element id that debug.js looks up exists in debug.html", () => {
  const wanted = new Set([...DEBUG_JS.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
  const wantedViaSetValue = [...DEBUG_JS.matchAll(/setValue\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  for (const id of [...wanted, ...wantedViaSetValue]) assert.ok(HTML_IDS.includes(id), `debug.html has no element #${id}`);
});

test("a refused request or a mismatching reply is shown on the page, not swallowed", async () => {
  const refused = loadPage(async () => ({ ok: false, reason: "Not allowed." }));
  await refused.refresh();
  assert.match(refused.text("alarm-status"), /Background did not return debug info: Not allowed\./);
  assert.equal(refused.cls("alarm-status"), "value bad");

  // The v0.2 reply shape (what the old background.js sent). The page must fail loudly, not stay blank.
  const v02 = loadPage(async () => ({
    now: Date.now(), alarmStatus: "INACTIVE", thresholdMinutes: 2, distraction: { accumulatedMs: 0, lastTickAt: null },
    snooze: { snoozesUsedThisAlarm: 0 }, focusSession: { active: false }, offscreenActive: false
  }));
  await v02.refresh();
  assert.match(v02.text("alarm-status"), /^Debug page error: /);
  assert.equal(v02.cls("alarm-status"), "value bad");
  assert.equal(v02.errors.length >= 1, true, "the error is also logged to the console");
});

test("the debug page has no offscreen diagnostic, and nothing in the extension uses the offscreen API", async () => {
  const manifest = JSON.parse(read("../manifest.json"));
  assert.ok(!(manifest.permissions || []).includes("offscreen"), "no offscreen permission");
  assert.ok(!/offscreen/i.test(DEBUG_HTML) && !/offscreen/i.test(DEBUG_JS), "no stale offscreen status row");
  for (const f of ["background.js", "engine.js", "content-script.js", "popup.js", "welcome.js", "debug.js"]) {
    const src = read(`../${f}`);
    assert.ok(!/chrome\.offscreen|createDocument|offscreen\.html|HEARTBEAT/i.test(src), `${f} must not create or talk to an offscreen document`);
  }
  const { send } = await bootBackground();
  const info = await send({ type: "GET_DEBUG_INFO" });
  assert.deepEqual(Object.keys(info).filter((k) => /offscreen/i.test(k)), []);
});

test("debug page renders without error in every state the worker can be in", async () => {
  // Before any observation: no lastObservation yet.
  let { send } = await bootBackground();
  let page = loadPage(send);
  await page.refresh();
  assert.deepEqual(page.errors, []);
  assert.match(page.text("last-tick"), /^none yet\./);
  assert.equal(page.text("active-tab"), "-", "rows that need an observation stay untouched, with no error");

  // Study mode, a ringing alarm, and an active snooze.
  ({ send } = await bootBackground());
  await send({ type: "START_STUDY_MODE", minutes: 15 });
  await send({ type: "FORCE_TRIGGER_ALARM" });
  page = loadPage(send);
  await page.refresh();
  assert.deepEqual(page.errors, []);
  assert.match(page.text("focus-session"), /^on, \d+m \d+s left$/);
  assert.equal(page.text("alarm-status"), "ACTIVE");
  assert.equal(page.cls("alarm-status"), "value bad");

  assert.equal((await send({ type: "SNOOZE", minutes: 5 }, senders.content())).ok, true);
  await page.refresh();
  assert.deepEqual(page.errors, []);
  assert.match(page.text("snooze-status"), /^active, \d+m \d+s left$/);
  assert.equal(page.text("snoozes-used"), "1");

  // The question bank cannot be loaded: shown as a failure, not hidden and not a page error.
  ({ send } = await bootBackground({ fetchFails: true }));
  page = loadPage(send);
  await page.refresh();
  assert.deepEqual(page.errors, []);
  assert.match(page.text("bank-status"), /^FAILED: .*network down/);
  assert.equal(page.cls("bank-status"), "value bad");
});

test("an old v0.2 offscreen page would be inert: its heartbeat is refused and changes nothing", async () => {
  // chrome.offscreen is not granted and no page references offscreen.*. Should an old copy of the
  // v0.2 page still be loaded somewhere, the message it sent must not drive tracking.
  // offscreen.js is deleted in v0.3; the message it used to send is kept here as a literal so the
  // worker keeps refusing it if an old copy of the page is ever loaded again.
  const { fake, send } = await bootBackground();
  fake.env.activeTab = REDDIT;
  for (const fn of fake.chrome.runtime.onStartup.listeners) fn();
  await send({ type: "GET_STATE" });
  const before = JSON.stringify(await send({ type: "GET_STATE" }));
  const reply = await send({ type: "HEARTBEAT_TICK" });
  assert.deepEqual(reply, { ok: false, reason: "Unknown message type." });
  assert.equal(JSON.stringify(await send({ type: "GET_STATE" })), before);
  // And from a content script (a web page's context) it is refused earlier still.
  assert.deepEqual(await send({ type: "HEARTBEAT_TICK" }, senders.content()), { ok: false, reason: "Not allowed." });
});