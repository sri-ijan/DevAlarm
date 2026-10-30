// The packaging gate (scripts/package.mjs) must refuse a release that contains the obsolete
// offscreen files, and must still accept the real tree. Each case runs the real script on a
// throwaway copy of the project, so nothing here touches the real dist/ folder or deletes anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP = new Set(["dist", "node_modules", ".git"]);

function copyOfProject() {
  const dir = mkdtempSync(join(tmpdir(), "focus-alarm-gate-"));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !SKIP.has(src.slice(ROOT.length + 1).split(/[\\/]/)[0]) });
  return dir;
}
// --skip-tests: the gate would otherwise run the whole suite again, recursively.
const runGate = (dir) => spawnSync(process.execPath, ["scripts/package.mjs", "--skip-tests"], { cwd: dir, encoding: "utf8" });
function withCopy(fn) {
  const dir = copyOfProject();
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("packaging gate: the real tree passes and ships neither offscreen file", () => {
  withCopy((dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!/offscreen/.test(r.stdout), "the packaged file list must not mention offscreen");
    assert.ok(existsSync(join(dir, "dist", "focus-alarm-0.3.0.zip")));
  });
});

for (const [file, body] of [["offscreen.html", "<!doctype html><script src=\"offscreen.js\"></script>"], ["offscreen.js", "// stale v0.2 keepalive\n"]]) {
  test(`packaging gate: refuses a release that contains ${file}`, () => {
    withCopy((dir) => {
      writeFileSync(join(dir, file), body);
      const r = runGate(dir);
      assert.notEqual(r.status, 0, "the gate must fail");
      assert.match(r.stderr, new RegExp(`${file.replace(".", "\\.")} must not be in the release`));
      assert.match(r.stderr, /NOT packaged/);
      assert.ok(!existsSync(join(dir, "dist")), "no zip is written when the gate fails");
    });
  });
}

test("packaging gate: refuses the offscreen permission coming back", () => {
  withCopy((dir) => {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    m.permissions = [...m.permissions, "offscreen"];
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
    const r = runGate(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /offscreen permission must not come back/);
  });
});

test("packaging gate: legitimate entry points that nothing imports are still accepted (no naive dependency scan)", () => {
  withCopy((dir) => {
    // debug.html, welcome.html and popup.html are opened by URL, and content-script.js is injected by
    // chrome.scripting; none of them is imported by another file. They must keep shipping.
    const r = runGate(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const f of ["debug.html", "debug.js", "welcome.html", "welcome.js", "popup.html", "content-script.js", "background.js", "engine.js"]) {
      assert.ok(r.stdout.includes(`  ${f}`) || r.stdout.includes(`\n  ${f}\n`), `${f} should be packaged`);
    }
  });
});
