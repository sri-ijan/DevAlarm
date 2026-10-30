// Pins two question-bank hints that once contained their own answer. Kept in its own file so it
// does not depend on the other bank tests. Reads the real data/questions.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeBlank } from "../engine.js";

const BANK = JSON.parse(readFileSync(new URL("../data/questions.json", import.meta.url), "utf8"));

// Q29 and Q44 once shipped hints that contained their own answer ("it stays 'open' to other slots",
// "merges two sorted halves"). The generic bank checks do not read hints, so these two are pinned.
// Looked up by id, not index, so reordering the bank cannot make them pass vacuously.
test("question bank: Q29 and Q44 hints do not give the answer away", () => {
  const byId = (id) => BANK.find((q) => q.id === id);
  const q29 = byId(29), q44 = byId(44);
  assert.ok(q29 && q44, "Q29 and Q44 must exist (if they were renumbered, update this test)");
  assert.equal(q29.answer, "open", "Q29 is the open-addressing question");
  assert.equal(q44.answer, "merge", "Q44 is the merge-sort question");
  // Protects against the word itself, in any form ("open", "opens", "'open'"), as a whole word stem.
  assert.doesNotMatch(q29.hint, /\bopen/i, "Q29 hint must not contain 'open'");
  // Protects against "merge", "merges", "merged", "merging" and "mergesort".
  assert.doesNotMatch(q44.hint, /\bmerg/i, "Q44 hint must not contain 'merge'");
  // Also covers every accepted spelling, not just the headline answer (e.g. 'open addressing', 'merge sort').
  for (const q of [q29, q44]) {
    for (const a of [q.answer, ...(q.accept || [])]) {
      assert.ok(!normalizeBlank(q.hint).includes(normalizeBlank(a)), `Q${q.id} hint contains accepted answer "${a}"`);
    }
  }
});
