// Builds the Chrome Web Store upload zip.   Usage:  node scripts/package.mjs
// Pure Node (no zip binary needed), so it works the same on Windows, macOS and Linux.
// It refuses to build if a basic release check fails, and prints what it checked.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const problems = [];
const fail = (m) => problems.push(m);

// ---- what ships ----
const SHIP_DIRS = ["data", "icons"];
const SHIP_EXT = new Set([".js", ".html", ".css", ".json", ".png"]);
const SHIP_TOP = new Set(readdirSync(root).filter((f) => {
  const full = join(root, f);
  return statSync(full).isFile() && SHIP_EXT.has(f.slice(f.lastIndexOf("."))) && f !== "package.json" && f !== "package-lock.json";
}));
const files = [];
for (const f of [...SHIP_TOP].sort()) files.push(f);
for (const d of SHIP_DIRS) {
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(root, full).split(sep).join("/"));
    }
  };
  if (existsSync(join(root, d))) walk(join(root, d));
}

// ---- checks ----
// Files that must never ship. Named explicitly on purpose: a generic "nothing imports this" scan would
// wrongly flag legitimate entry points (the manifest, popup, welcome and debug pages are opened by URL,
// not imported). offscreen.* is the v0.2 keepalive page; v0.3 has no offscreen permission or document.
const PROHIBITED = {
  "offscreen.html": "obsolete v0.2 keepalive page; v0.3 has no offscreen document",
  "offscreen.js": "obsolete v0.2 keepalive script; v0.3 has no offscreen document"
};
for (const f of files) if (PROHIBITED[f]) fail(`${f} must not be in the release (${PROHIBITED[f]}); delete it with: git rm ${f}`);
if ((manifest.permissions || []).includes("offscreen")) fail("the offscreen permission must not come back (nothing in v0.3 uses it)");

const referenced = new Set(["manifest.json"]);
const add = (p) => p && referenced.add(p);
add(manifest.background && manifest.background.service_worker);
add(manifest.action && manifest.action.default_popup);
Object.values(manifest.icons || {}).forEach(add);
Object.values((manifest.action && manifest.action.default_icon) || {}).forEach(add);
for (const p of referenced) if (!existsSync(join(root, p))) fail(`manifest references a missing file: ${p}`);

for (const size of ["16", "32", "48", "128"]) if (!(manifest.icons && manifest.icons[size])) fail(`manifest.icons is missing ${size}px`);
if (manifest.host_permissions && manifest.host_permissions.length) fail("host_permissions must stay empty (use optional_host_permissions)");
if (manifest.content_scripts) fail("static content_scripts would force a broad install-time warning");
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || "")) fail("manifest.version is not a valid Chrome version");
if (manifest.content_security_policy) fail("custom content_security_policy found; review it by hand");

const readText = (f) => readFileSync(join(root, f), "utf8");
for (const f of files.filter((x) => x.endsWith(".html"))) {
  const html = readText(f);
  if (/<script[^>]+src=["']https?:/i.test(html)) fail(`${f} loads a remote script`);
  if (/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(html)) fail(`${f} has an inline script (blocked by MV3 CSP)`);
  for (const m of html.matchAll(/(?:src|href)=["']([^"'#:]+)["']/g)) {
    if (!existsSync(join(root, dirname(f), m[1]))) fail(`${f} points to a missing file: ${m[1]}`);
  }
}
for (const f of files.filter((x) => x.endsWith(".js"))) {
  const js = readText(f);
  if (/\beval\s*\(|new Function\s*\(/.test(js)) fail(`${f} uses eval or new Function`);
  if (/import\s*\(\s*["']https?:/.test(js) || /from\s+["']https?:/.test(js)) fail(`${f} imports remote code`);
}
const bank = JSON.parse(readText("data/questions.json"));
if (!Array.isArray(bank) || bank.length < 100) fail("question bank looks wrong");

if (process.argv.includes("--skip-tests") === false) {
  const r = spawnSync(process.execPath, ["--test"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) { fail("node --test failed"); console.error(r.stdout + r.stderr); }
}

if (problems.length) {
  console.error("\nNOT packaged. Fix these first:\n - " + problems.join("\n - "));
  process.exit(1);
}

// ---- zip writer (store/deflate, no extras) ----
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const parts = [], central = [];
let offset = 0;
const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed stamp => reproducible zip
for (const name of files) {
  const data = readFileSync(join(root, name));
  const comp = deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name);
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
  parts.push(lh, nameBuf, comp);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);
  offset += lh.length + nameBuf.length + comp.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", `focus-alarm-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...parts, centralBuf, end]));

console.log(`Checks passed. ${files.length} files packaged:\n  ` + files.join("\n  "));
console.log(`\nWrote ${relative(root, out)} (${statSync(out).size} bytes)`);
console.log("This only proves the zip is well-formed and passes static checks. It does NOT prove Chrome accepts it: load the unzipped folder and follow docs/TESTING.md section C.");
