"use strict";
// Checks the package against the rules in Drift's manifest.rs / page.rs, and
// the "no innerHTML / eval / network" promises.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { build } = require("../build.js");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const manifest = JSON.parse(read("plugin.json"));

const KNOWN_PERMISSIONS = [
  "tabs", "active_tab", "storage", "network", "tabs_snapshot", "tabs_open", "tabs_close", "ui", "legacy_stashes",
  "bookmarks_read", "bookmarks_write", "history_read", "history_write", "downloads_read", "downloads_control",
  "notifications", "context_menu",
];
const plainFile = (n) => typeof n === "string" && n.length > 0 && !/[\\/:%]/.test(n) && !n.includes("..");

test("background.js is the up-to-date build of aggregate.js + background.src.js", () => {
  const current = read("background.js").replace(/\r\n/g, "\n");
  assert.equal(current, build(ROOT), "run `node build.js`");
});

test("plugin.json satisfies manifest.rs validate()", () => {
  assert.match(manifest.id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(manifest.id, "habits-dashboard");
    assert.ok(manifest.name.trim());
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.background && plainFile(manifest.background.script));
  assert.ok(plainFile(manifest.icon));
  for (const p of manifest.permissions) assert.ok(KNOWN_PERMISSIONS.includes(p), "unknown permission " + p);
  assert.ok(manifest.permissions.includes("ui"), "ui block needs the ui permission");

  const ui = manifest.ui;
  assert.ok(plainFile(ui.page) && ui.page.endsWith(".html"));
  assert.ok(ui.toolbarButton.title.trim() && [...ui.toolbarButton.title].length <= 80);
  assert.ok(plainFile(ui.toolbarButton.icon));
  assert.ok(ui.commands.length <= 8);
  const seen = new Set();
  for (const c of ui.commands) {
    assert.match(c.id, /^[a-z0-9-]{1,32}$/);
    assert.ok(!seen.has(c.id));
    seen.add(c.id);
    assert.ok(c.title.trim() && [...c.title].length <= 80);
    assert.ok(Object.keys(c.titles || {}).length <= 4);
    for (const [lang, title] of Object.entries(c.titles || {})) {
      assert.match(lang, /^[a-z-]{2,5}$/);
      assert.ok(title.trim() && [...title].length <= 80);
    }
  }
  for (const f of [manifest.background.script, manifest.icon, ui.page, ui.toolbarButton.icon]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + " is missing");
  }
});

test("permissions are minimal: read-only history, no network, no history_write", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["history_read", "notifications", "storage", "ui"]);
  assert.ok(!manifest.permissions.includes("network"));
  assert.ok(!manifest.permissions.includes("history_write"));
  const bg = read("background.src.js");
  assert.ok(!/history\.remove|tabs\.|bookmarks\.|downloads\./.test(bg));
});

test("page files are servable types and only reference own files", () => {
  const html = read("page.html");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(refs.sort(), ["charts.js", "drift-page.js", "page.css", "page.js"]);
  assert.ok(html.indexOf("drift-page.js") < html.indexOf("page.js"));
  for (const r of refs) if (r !== "drift-page.js") assert.ok(fs.existsSync(path.join(ROOT, r)), r);
});

test("CSP-safe page: no inline script/style, no style attributes, no external URLs, no eval", () => {
  const html = read("page.html");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "inline <script>");
  assert.ok(!/<style[\s>]/i.test(html), "inline <style>");
  assert.ok(!/\sstyle=/i.test(html), "style attribute");
  assert.ok(!/\son[a-z]+=/i.test(html), "inline handler");
  for (const f of ["page.html", "page.css", "page.js", "charts.js", "background.src.js", "aggregate.js"]) {
    const text = read(f).replace(/http:\/\/www\.w3\.org\/2000\/svg/g, "");
    assert.ok(!/https?:\/\//.test(text), f + " mentions an external URL");
    assert.ok(!/@import|url\(/.test(text) || f !== "page.css", f);
  }
  for (const f of ["page.js", "charts.js", "background.src.js", "aggregate.js"]) {
    const text = read(f);
    assert.ok(!/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/.test(text), f + " writes HTML");
    assert.ok(!/\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*["'`]/.test(text), f + " evaluates strings");
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(text), f + " uses the network");
    assert.ok(!/setAttribute\(\s*["']style["']/.test(text), f + " sets a style attribute");
  }
});

test("page.js only calls the page API Drift provides", () => {
  const js = read("page.js");
  const used = [...js.matchAll(/\bdp\.([a-zA-Z.]+)/g)].map((m) => m[1]);
  const allowed = new Set(["runtime.sendMessage", "storage.get", "onTheme", "ready"]);
  for (const u of used) assert.ok(allowed.has(u), "page uses unsupported driftPlugin." + u);
});

test("background uses only calls that exist in background_bridge.rs", () => {
  const js = read("background.src.js");
  const used = [...js.matchAll(/\bdp\.([a-zA-Z]+\.[a-zA-Z]+)/g)].map((m) => m[1]);
  const allowed = new Set([
    "storage.get", "storage.set", "history.search", "notifications.show", "ui.openPage", "runtime.onPageMessage", "runtime.onCommand",
  ]);
  for (const u of used) assert.ok(allowed.has(u), "background uses unsupported driftPlugin." + u);
});
