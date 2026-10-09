"use strict";
// Runs the real, built background.js in a vm with a mocked window.driftPlugin
// that behaves like Drift's history.search (substring query, newest first, <= 1000).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CODE = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const MIN = 60000;

function makeHistory(spec, stepMin = 1) {
  // spec: [[domain, count], ...] -> entries interleaved over time, newest first
  const entries = [];
  const pools = spec.map(([domain, count]) => ({ domain, left: count, n: 0 }));
  let i = 0;
  const now = Date.now();
  while (pools.some((p) => p.left > 0)) {
    for (const p of pools) {
      if (p.left <= 0) continue;
      // heavy domains take turns more often
      if (p.left > 0 && (i + p.n) % 1 === 0) {
        entries.push({ url: `https://${p.domain}/page/${p.n}`, title: `${p.domain} page ${p.n}`, visitedAt: now - (10 + i * stepMin) * MIN });
        p.left--;
        p.n++;
        i++;
      }
    }
  }
  return entries; // already newest first
}

function load(history, { storage = {}, lang = "en-US" } = {}) {
  const queries = [];
  const shown = [];
  let pageHandler = null;
  let commandHandler = null;
  const store = new Map(Object.entries(storage));
  const sandbox = {
    console,
    URL,
    Date,
    navigator: { language: lang },
    setTimeout: () => 0,
    setInterval: () => 0,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.driftPlugin = {
    storage: {
      get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
      set: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))),
    },
    history: {
      search: async (o) => {
        queries.push(o.query || null);
        const limit = Math.min(Math.max(o.limit || 100, 1), 1000);
        const q = o.query ? o.query.toLowerCase() : null;
        return history
          .filter((e) => !q || e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q))
          .slice(0, limit);
      },
    },
    notifications: { show: async (o) => void shown.push(o) },
    ui: { openPage: async () => {} },
    runtime: {
      onPageMessage: (fn) => (pageHandler = fn),
      onCommand: (fn) => (commandHandler = fn),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return {
    queries,
    shown,
    store,
    // JSON round trip: results come from another vm realm (different prototypes)
    send: async (m) => JSON.parse(JSON.stringify(await pageHandler(m))),
    command: (id, ctx) => commandHandler(id, ctx || {}),
  };
}

test("history under the call limit: one unfiltered call, marked complete", async () => {
  const h = load(makeHistory([["a.com", 40], ["b.org", 10]]));
  const r = await h.send({ type: "getStats", period: "7d" });
  assert.equal(r.ok, true);
  assert.equal(h.queries.length, 1);
  assert.equal(r.sample.complete, true);
  assert.equal(r.sample.count, 50);
  assert.equal(r.stats.cards.visits, 50);
  assert.equal(r.sample.partialPeriod, false);
});

test("history over the limit: per-domain and TLD probes deepen the sample, honestly flagged", async () => {
  const hist = makeHistory([["a.com", 1500], ["b.com", 700], ["c.net", 300], ["d.com", 40]]);
  // a rare, old site that no unfiltered call can see
  const oldest = hist[hist.length - 1].visitedAt;
  for (let k = 0; k < 3; k++) hist.push({ url: `https://rare.org/${k}`, title: "rare", visitedAt: oldest - (k + 1) * MIN });
  assert.ok(hist.length > 2500);

  const h = load(hist);
  const r = await h.send({ type: "getStats", period: "all" });
  assert.equal(r.ok, true);
  assert.equal(r.sample.complete, false);
  assert.equal(r.sample.callLimit, 1000);
  assert.ok(r.sample.count > 1000, "sample must go beyond one call: " + r.sample.count);
  assert.ok(h.queries.length > 1 && h.queries.length <= 60, "calls: " + h.queries.length);
  // everything newer than fullFrom is complete: the 1000 newest entries are all there
  const newest1000 = hist.slice(0, 1000);
  assert.equal(r.sample.fullFrom, newest1000[999].visitedAt);
  // the old rare site was found through the ".org" probe
  assert.equal(r.stats.topSites.find((s) => s.domain === "rare.org").visits, 3);
  // the busiest site hit the cap and is reported as possibly cut
  assert.ok(r.sample.truncatedDomains.includes("a.com"));
  assert.equal(r.sample.partialPeriod, true);
  // the newest 1000 entries span ~17 h here, so a 24 h period still starts before fullFrom
  const day = await h.send({ type: "getStats", period: "24h" });
  assert.equal(day.sample.partialPeriod, true);
});

test("a period that starts after fullFrom is not flagged partial", async () => {
  // 10 minutes between visits: the newest 1000 span ~7 days, so 24 h is covered completely
  const hist = makeHistory([["a.com", 1500], ["b.com", 700]], 10);
  const h = load(hist);
  const day = await h.send({ type: "getStats", period: "24h" });
  assert.equal(day.sample.complete, false);
  assert.equal(day.sample.partialPeriod, false);
  const all = await h.send({ type: "getStats", period: "all" });
  assert.equal(all.sample.partialPeriod, true);
});

test("excluded sites are never queried and never counted", async () => {
  const hist = makeHistory([["a.com", 1200], ["secret.com", 600], ["b.org", 50]]);
  const h = load(hist, { storage: { settings: { excluded: ["secret.com"] } } });
  const r = await h.send({ type: "getStats", period: "all" });
  assert.ok(!h.queries.some((q) => q && q.includes("secret")));
  assert.ok(!r.stats.topSites.some((s) => s.domain === "secret.com"));
  assert.ok(r.stats.topSites.some((s) => s.domain === "a.com"));
});

test("saveSettings sanitises input and invalidates the loaded history", async () => {
  const h = load(makeHistory([["a.com", 10], ["b.com", 10]]));
  const before = await h.send({ type: "getStats", period: "7d" });
  assert.equal(before.stats.cards.uniqueSites, 2);
  const saved = await h.send({
    type: "saveSettings",
    settings: {
      excluded: [" https://WWW.B.com/x ", "", 5, "b.com"],
      categories: { "A.com": "video", "x.com": "bogus" },
      blur: "yes",
      weeklyNotify: true,
      lastWeeklyAt: 42,
    },
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.settings.excluded, ["b.com", "5"]);
  assert.deepEqual(saved.settings.categories, { "a.com": "video" });
  assert.equal(saved.settings.blur, false);
  assert.equal(saved.settings.weeklyNotify, true);
  assert.ok(saved.settings.lastWeeklyAt > 42, "turning the weekly summary on restarts the week; the page cannot set it");
  const after = await h.send({ type: "getStats", period: "7d", refresh: true });
  assert.equal(after.stats.cards.uniqueSites, 1);
  assert.equal(after.stats.categories.find((c) => c.id === "video").visits, 10);
});

test("results are cached in storage with a timestamp and reused after a restart", async () => {
  const hist = makeHistory([["a.com", 30]]);
  const first = load(hist);
  await first.send({ type: "getStats", period: "7d" });
  const cache = first.store.get("cache");
  assert.ok(cache && cache.results["7d"] && typeof cache.results["7d"].at === "number");
  const second = load(hist, { storage: { cache } });
  const r = await second.send({ type: "getStats", period: "7d" });
  assert.equal(r.fromCache, true);
  assert.equal(second.queries.length, 0);
  const forced = await second.send({ type: "getStats", period: "7d", refresh: true });
  assert.equal(forced.fromCache, false);
  assert.ok(second.queries.length >= 1);
});

test("weekly command shows a notification of at most 300 chars", async () => {
  const h = load(makeHistory([["a.com", 30], ["b.com", 20]]), { lang: "ru-RU" });
  h.command("weekly");
  for (let i = 0; i < 20 && !h.shown.length; i++) await new Promise((r) => setImmediate(r));
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].title, "Итоги недели");
  assert.ok(h.shown[0].body.length <= 300 && h.shown[0].body.length > 0);
});

test("unknown messages and errors answer with ok:false instead of throwing", async () => {
  const h = load([]);
  assert.deepEqual(await h.send({ type: "nope" }), { ok: false, error: "unknown message" });
  assert.deepEqual(await h.send(null), { ok: false, error: "unknown message" });
  const empty = await h.send({ type: "getStats", period: "bogus" });
  assert.equal(empty.ok, true);
  assert.equal(empty.stats.period, "7d");
  assert.equal(empty.stats.cards.visits, 0);
  assert.equal(empty.sample.count, 0);
});

test("cache on disk holds no page titles and old entries are deleted at start", async () => {
  const hist = makeHistory([["a.com", 30]]);
  const h = load(hist);
  await h.send({ type: "getStats", period: "7d" });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const cache = h.store.get("cache");
  assert.ok(cache.results["7d"].stats.topSites.length > 0);
  assert.ok(cache.results["7d"].stats.topSites.every((s) => s.recent.length === 0), "titles must not be stored");
  assert.ok(!JSON.stringify(cache).includes("page 1"), "no title text anywhere in the cache");

  const stale = { key: cache.key, results: { "7d": { ...cache.results["7d"], at: Date.now() - 3600000 } } };
  const h2 = load(hist, { storage: { cache: stale } });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(h2.store.get("cache"), null, "stale cache is removed, not just ignored");
});

test("opening the page reads history again; a period switch may reuse it", async () => {
  const h = load(makeHistory([["a.com", 30]]));
  await h.send({ type: "getStats", period: "7d" });
  const n = h.queries.length;
  await h.send({ type: "getStats", period: "30d", reuse: true });
  assert.equal(h.queries.length, n, "reuse: no new history call");
  const opened = await h.send({ type: "getStats", period: "24h" }); // not cached yet
  assert.equal(opened.fromCache, false);
  assert.ok(h.queries.length > n, "no reuse flag: history is read again");
});

test("history cleared after loading is not shown when the page is opened again", async () => {
  const hist = makeHistory([["a.com", 30]]);
  const h = load(hist);
  const first = await h.send({ type: "getStats", period: "7d" });
  assert.equal(first.stats.cards.visits, 30);
  hist.length = 0; // user clears history
  const again = await h.send({ type: "getStats", period: "7d", refresh: true });
  assert.equal(again.stats.cards.visits, 0);
});

test("many domains: the TLD probes still run inside the 60-call budget and find an old site", async () => {
  const spec = [];
  for (let i = 0; i < 120; i++) spec.push([`site${i}.com`, 12]);
  const hist = makeHistory(spec);
  const oldest = hist[hist.length - 1].visitedAt;
  hist.push({ url: "https://old-gem.org/x", title: "gem", visitedAt: oldest - MIN });
  const h = load(hist);
  const r = await h.send({ type: "getStats", period: "all" });
  assert.ok(h.queries.length <= 60, "calls: " + h.queries.length);
  assert.ok(h.queries.includes(".org"), "probes were skipped");
  assert.equal(r.sample.complete, false);
  assert.equal(r.stats.cards.newSitesApprox, true);
});

test("weekly summary does not overwrite settings saved while it was running", async () => {
  const h = load(makeHistory([["a.com", 5]]), { storage: { settings: { weeklyNotify: true, lastWeeklyAt: 1 } } });
  // switch off exclusions etc. concurrently with the summary
  const saving = h.send({ type: "saveSettings", settings: { excluded: ["zzz.com"] } });
  h.command("weekly");
  await saving;
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.store.get("settings").excluded, ["zzz.com"]);
});

test("notification language follows the interface language the page reported, not the background window's", async () => {
  const h = load(makeHistory([["a.com", 10]]), { lang: "en-US" });
  await h.send({ type: "getStats", period: "7d", lang: "ru" });
  await h.command("weekly");
  for (let i = 0; i < 30 && !h.shown.length; i++) await new Promise((r) => setImmediate(r));
  assert.equal(h.shown[0].title, "Итоги недели");
  assert.match(h.shown[0].body, /посещений/);
});
