// popup.js and welcome.js are plain scripts that look elements up by id. A renamed or removed id
// makes getElementById return null and the script throws on load, so the page silently does nothing.
// These tests tie each script to its html file, and keep the popup minimal: settings live in welcome.html.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const idsIn = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const idsLookedUp = (js) => [
  ...[...js.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/\$\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
];

for (const [name, html, js] of [["popup", "../popup.html", "../popup.js"], ["welcome", "../welcome.html", "../welcome.js"]]) {
  test(`${name}.js only looks up element ids that exist in ${name}.html`, () => {
    const have = idsIn(read(html));
    const wanted = idsLookedUp(read(js));
    assert.ok(wanted.length > 5, "the check found the id lookups");
    for (const id of wanted) assert.ok(have.has(id), `${name}.html has no element #${id}`);
  });
}

test("the popup stays minimal: no settings form, every setting is on the Settings page", () => {
  const popup = read("../popup.html");
  assert.ok(!/<textarea|type="number"|id="topics-list"|id="difficulty|id="save-btn"/.test(popup), "no settings form in the popup");
  assert.ok((popup.match(/<button/g) || []).length <= 3, "popup has the power switch, the break button and at most one setup button");
  assert.match(popup, /id="setup-link"/, "the popup links to the Settings page");
  const welcome = read("../welcome.html");
  for (const id of ["sites", "threshold", "numq", "channels", "difficulty", "snoozes", "daily-snooze", "topics-list"]) {
    assert.ok(idsIn(welcome).has(id), `the Settings page has #${id}`);
  }
});

test("welcome.js saves every setting that used to be in the popup", () => {
  const js = read("../welcome.js");
  for (const key of ["distractingSites", "thresholdMinutes", "numQuestions", "topics", "studyChannels", "difficulty", "maxSnoozes", "dailySnoozeLimit"]) {
    assert.match(js, new RegExp(`\\b${key}\\b`), `welcome.js sends ${key}`);
  }
  assert.ok(!/enabled/.test(js.split("SET_SETTINGS")[1].split("});")[0]), "the master switch is not part of the saved payload");
});
