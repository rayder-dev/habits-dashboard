"use strict";
// Aggregation tests on synthetic history. Run: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../aggregate.js");

const MSK = { offsetMin: 180 }; // UTC+3, fixed zone so results do not depend on the machine
const UTC = { offsetMin: 0 };

/** Local wall-clock time in a fixed zone -> epoch ms. */
function at(tz, y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - tz.offsetMin * 60000;
}
function visit(url, ts, title = "") {
  return { url, title, visitedAt: ts };
}
// Wednesday 2025-03-12 15:00 Moscow time.
const NOW = at(MSK, 2025, 3, 12, 15, 0);
const base = { now: NOW, tz: MSK };

test("hostOf / registrable: www, subdomains, two-part TLDs, IPs, junk", () => {
  assert.equal(A.hostOf("https://WWW.Example.com:8080/a?b#c"), "www.example.com");
  assert.equal(A.registrable("www.example.com"), "example.com");
  assert.equal(A.registrable("a.b.c.example.com"), "example.com");
  assert.equal(A.registrable("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(A.registrable("example.com"), "example.com");
  assert.equal(A.registrable("localhost"), "localhost");
  assert.equal(A.registrable("192.168.0.1"), "192.168.0.1");
  assert.equal(A.hostOf("not a url"), "");
  assert.equal(A.hostOf(null), "");
});

test("empty history: zeros everywhere, no peaks, no crash", () => {
  for (const period of A.PERIODS) {
    const r = A.compute([], { ...base, period });
    assert.equal(r.cards.visits, 0);
    assert.equal(r.cards.uniqueSites, 0);
    assert.equal(r.cards.peakHour, null);
    assert.equal(r.cards.peakWeekday, null);
    assert.deepEqual(r.topSites, []);
    assert.equal(r.hours.length, 24);
    assert.equal(r.heat.length, 7);
    assert.ok(r.series.points.every((p) => p.count === 0));
    assert.ok(r.categories.every((c) => c.visits === 0 && c.share === 0));
  }
});

test("garbage entries are skipped, not counted", () => {
  const r = A.compute(
    [null, {}, { url: "https://a.com/", visitedAt: "x" }, { url: "nope", visitedAt: NOW - 1000 }, visit("https://a.com/", NOW - 1000)],
    { ...base, period: "7d" }
  );
  assert.equal(r.cards.visits, 1);
});

test("one site: share is 100%, one unique site, peak hour and weekday", () => {
  const entries = [
    visit("https://www.example.com/a", at(MSK, 2025, 3, 12, 9, 10), "A"),
    visit("https://example.com/b", at(MSK, 2025, 3, 12, 9, 50), "B"),
    visit("https://sub.example.com/c", at(MSK, 2025, 3, 12, 14, 0), "C"),
  ];
  const r = A.compute(entries, { ...base, period: "7d" });
  assert.equal(r.cards.visits, 3);
  assert.equal(r.cards.uniqueSites, 1);
  assert.equal(r.topSites.length, 1);
  assert.equal(r.topSites[0].domain, "example.com");
  assert.equal(r.topSites[0].share, 1);
  assert.deepEqual(r.cards.peakHour, { hour: 9, count: 2 });
  assert.deepEqual(r.cards.peakWeekday, { weekday: 2, count: 3 }); // Wednesday, Monday = 0
  assert.equal(r.topSites[0].recent[0].title, "C"); // newest first
});

test("midnight: 23:59:59.999 is the old day, 00:00:00.000 the new one", () => {
  const late = at(MSK, 2025, 3, 10, 23, 59, 59, 999); // Monday
  const early = at(MSK, 2025, 3, 11, 0, 0, 0, 0); // Tuesday
  const r = A.compute([visit("https://a.com/", late), visit("https://a.com/", early)], { ...base, period: "7d" });
  assert.equal(r.hours[23], 1);
  assert.equal(r.hours[0], 1);
  assert.equal(r.weekdays[0], 1); // Monday
  assert.equal(r.weekdays[1], 1); // Tuesday
  assert.equal(r.heat[0][23], 1);
  assert.equal(r.heat[1][0], 1);
  const day = (ts) => r.series.points.find((p) => p.start === at(MSK, 2025, 3, ts));
  assert.equal(day(10).count, 1);
  assert.equal(day(11).count, 1);
});

test("time zone: the same instant lands in different local hours and days", () => {
  const ts = Date.UTC(2025, 2, 10, 22, 30); // Mon 22:30 UTC = Tue 01:30 in UTC+3
  const utc = A.compute([visit("https://a.com/", ts)], { now: NOW, tz: UTC, period: "30d" });
  const msk = A.compute([visit("https://a.com/", ts)], { now: NOW, tz: MSK, period: "30d" });
  assert.deepEqual(utc.cards.peakHour, { hour: 22, count: 1 });
  assert.deepEqual(msk.cards.peakHour, { hour: 1, count: 1 });
  assert.equal(utc.cards.peakWeekday.weekday, 0);
  assert.equal(msk.cards.peakWeekday.weekday, 1);
  // a negative offset too (UTC-5): Mon 22:30 UTC = Mon 17:30
  const ny = A.compute([visit("https://a.com/", ts)], { now: NOW, tz: { offsetMin: -300 }, period: "30d" });
  assert.deepEqual(ny.cards.peakHour, { hour: 17, count: 1 });
});

test("7d: today plus 6 calendar days; boundary at local midnight", () => {
  const start = at(MSK, 2025, 3, 6, 0, 0); // Thursday, 6 days before Wednesday the 12th
  const entries = [
    visit("https://in.com/", start), // exactly the start: inside
    visit("https://prev.com/", start - 1), // 1 ms earlier: previous period
    visit("https://future.com/", NOW + 1), // in the future: ignored
    visit("https://now.com/", NOW), // exactly now: inside
  ];
  const r = A.compute(entries, { ...base, period: "7d" });
  assert.equal(r.range.start, start);
  assert.equal(r.cards.visits, 2);
  assert.deepEqual(r.topSites.map((s) => s.domain).sort(), ["in.com", "now.com"]);
  assert.equal(r.prev.visits, 1);
  assert.equal(r.range.prevStart, at(MSK, 2025, 2, 27, 0, 0));
  assert.equal(r.range.prevEnd, start);
  assert.equal(r.series.points.length, 7);
  assert.equal(r.series.step, "day");
});

test("prev period starts exactly at its boundary and excludes the older one", () => {
  const prevStart = at(MSK, 2025, 2, 27, 0, 0);
  const r = A.compute(
    [visit("https://a.com/", prevStart), visit("https://a.com/", prevStart - 1), visit("https://a.com/", at(MSK, 2025, 3, 7, 12))],
    { ...base, period: "7d" }
  );
  assert.equal(r.prev.visits, 1);
  assert.equal(r.cards.visits, 1);
});

test("24h is rolling: now-24h inclusive, 1 ms earlier belongs to the previous 24h", () => {
  const r = A.compute(
    [visit("https://a.com/", NOW - 86400000), visit("https://b.com/", NOW - 86400000 - 1), visit("https://c.com/", NOW - 2 * 86400000 - 1)],
    { ...base, period: "24h" }
  );
  assert.equal(r.cards.visits, 1);
  assert.equal(r.prev.visits, 1);
  assert.equal(r.series.step, "hour");
  assert.equal(r.series.points.length, 24);
  assert.equal(r.series.points.reduce((s, p) => s + p.count, 0), 1);
});

test("30d has 30 day buckets summing to the visit count", () => {
  const entries = [];
  for (let i = 0; i < 30; i++) entries.push(visit("https://a.com/", at(MSK, 2025, 3, 12 - i, 10)));
  const r = A.compute(entries, { ...base, period: "30d" });
  assert.equal(r.series.points.length, 30);
  assert.ok(r.series.points.every((p) => p.count === 1));
  assert.equal(r.cards.visits, 30);
});

test("all: no previous period, starts at the first visit's day", () => {
  const first = at(MSK, 2025, 1, 5, 18, 30);
  const r = A.compute([visit("https://a.com/", first), visit("https://a.com/", NOW - 1000)], { ...base, period: "all" });
  assert.equal(r.prev, null);
  assert.equal(r.range.start, at(MSK, 2025, 1, 5, 0, 0));
  assert.equal(r.cards.newSites, null);
  assert.equal(r.cards.visits, 2);
  assert.equal(r.topSites[0].prevVisits, null);
});

test("long history is bucketed by week", () => {
  const first = at(MSK, 2023, 1, 2, 12);
  const r = A.compute([visit("https://a.com/", first), visit("https://a.com/", NOW - 1000)], { ...base, period: "all" });
  assert.equal(r.series.step, "week");
  assert.equal(r.series.points.reduce((s, p) => s + p.count, 0), 2);
});

test("comparison with the previous period: visits, unique sites, new sites", () => {
  const entries = [
    // previous period (Feb 27 .. Mar 5)
    visit("https://old.com/", at(MSK, 2025, 3, 1, 10)),
    visit("https://old.com/", at(MSK, 2025, 3, 2, 10)),
    visit("https://gone.com/", at(MSK, 2025, 3, 3, 10)),
    // current period (Mar 6 .. Mar 12)
    visit("https://old.com/", at(MSK, 2025, 3, 7, 10)),
    visit("https://fresh.com/", at(MSK, 2025, 3, 8, 10)),
    visit("https://fresh.com/", at(MSK, 2025, 3, 9, 10)),
    visit("https://fresh2.com/", at(MSK, 2025, 3, 9, 11)),
  ];
  const r = A.compute(entries, { ...base, period: "7d" });
  assert.equal(r.cards.visits, 4);
  assert.equal(r.prev.visits, 3);
  assert.equal(r.cards.uniqueSites, 3);
  assert.equal(r.prev.uniqueSites, 2);
  assert.equal(r.cards.newSites, 2); // fresh.com, fresh2.com were never seen before this period
  assert.equal(r.prev.newSites, 2); // old.com and gone.com first appeared in the previous period
  const old = r.topSites.find((s) => s.domain === "old.com");
  assert.equal(old.prevVisits, 2);
  assert.equal(old.isNew, false);
  assert.equal(r.topSites.find((s) => s.domain === "fresh.com").isNew, true);
});

test("exclusions: exact domain, subdomains, input forms; also dropped from comparison and new-sites", () => {
  const entries = [
    visit("https://bank.com/x", at(MSK, 2025, 3, 10, 10)),
    visit("https://my.bank.com/y", at(MSK, 2025, 3, 10, 11)),
    visit("https://notbank.com/z", at(MSK, 2025, 3, 10, 12)),
    visit("https://bank.com/old", at(MSK, 2025, 3, 1, 12)),
    visit("https://ok.com/", at(MSK, 2025, 3, 11, 12)),
  ];
  const r = A.compute(entries, { ...base, period: "7d", excluded: ["  https://WWW.Bank.com/path  "] });
  assert.deepEqual(r.topSites.map((s) => s.domain).sort(), ["notbank.com", "ok.com"]);
  assert.equal(r.cards.visits, 2);
  assert.equal(r.prev.visits, 0);
  assert.equal(r.hours.reduce((a, b) => a + b, 0), 2);
  const all = A.compute(entries, { ...base, period: "7d", excluded: ["bank.com", "notbank.com", "ok.com"] });
  assert.equal(all.cards.visits, 0);
  assert.equal(all.cards.peakHour, null);
});

test("categories: built-in list, subdomains, user override, 'other'", () => {
  const entries = [
    visit("https://www.youtube.com/watch", at(MSK, 2025, 3, 10, 10)),
    visit("https://m.youtube.com/watch", at(MSK, 2025, 3, 10, 11)),
    visit("https://github.com/x", at(MSK, 2025, 3, 10, 12)),
    visit("https://vk.com/feed", at(MSK, 2025, 3, 10, 13)),
    visit("https://unknown.example/", at(MSK, 2025, 3, 10, 14)),
    visit("https://docs.google.com/d", at(MSK, 2025, 3, 10, 15)),
  ];
  const r = A.compute(entries, { ...base, period: "7d" });
  const cat = (id) => r.categories.find((c) => c.id === id).visits;
  assert.equal(cat("video"), 2);
  assert.equal(cat("work"), 2); // github.com and docs.google.com (matched by full host)
  assert.equal(cat("social"), 1);
  assert.equal(cat("other"), 1); // unknown.example
  assert.equal(r.categories.reduce((s, c) => s + c.visits, 0), 6);
  assert.ok(Math.abs(r.categories.reduce((s, c) => s + c.share, 0) - 1) < 1e-9);
  // google.com itself is not in the list, only its docs/mail/drive/calendar hosts
  assert.equal(A.categoryOf("www.google.com", "google.com", {}), "other");

  const o = A.compute(entries, { ...base, period: "7d", categories: { "youtube.com": "work", "unknown.example": "news", "bad.com": "nonsense" } });
  assert.equal(o.categories.find((c) => c.id === "work").visits, 4);
  assert.equal(o.categories.find((c) => c.id === "news").visits, 1);
  assert.equal(A.categoryOf("bad.com", "bad.com", { "bad.com": "nonsense" }), "other");
  assert.equal(o.topSites.find((s) => s.domain === "youtube.com").category, "work");
});

test("top sites: sorted by visits, ties by name; shares add up; topN respected", () => {
  const entries = [];
  const sites = { "c.com": 3, "a.com": 3, "b.com": 5, "d.com": 1 };
  let i = 0;
  for (const [d, n] of Object.entries(sites)) for (let k = 0; k < n; k++) entries.push(visit(`https://${d}/`, at(MSK, 2025, 3, 10, 8) + i++ * 1000));
  const r = A.compute(entries, { ...base, period: "7d", topN: 3 });
  assert.deepEqual(r.topSites.map((s) => s.domain), ["b.com", "a.com", "c.com"]);
  assert.equal(r.cards.uniqueSites, 4); // topN limits the list, not the count
  const full = A.compute(entries, { ...base, period: "7d" });
  assert.ok(Math.abs(full.topSites.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
});

test("site detail: per-hour and per-weekday arrays and recent titles (max 8, newest first)", () => {
  const entries = [];
  for (let k = 0; k < 12; k++) entries.push(visit("https://a.com/p" + k, at(MSK, 2025, 3, 10, 10, k), "T" + k));
  const r = A.compute(entries, { ...base, period: "7d" });
  const s = r.topSites[0];
  assert.equal(s.hours[10], 12);
  assert.equal(s.weekdays[0], 12);
  assert.equal(s.recent.length, 8);
  assert.equal(s.recent[0].title, "T11");
  assert.ok(s.recent.every((x, i, a) => i === 0 || a[i - 1].at >= x.at));
});

test("heat map equals hours and weekdays when summed", () => {
  const entries = [];
  for (let d = 6; d <= 12; d++) for (let h = 0; h < 24; h += 5) entries.push(visit("https://a.com/", at(MSK, 2025, 3, d, h, 5)));
  const r = A.compute(entries, { ...base, period: "7d" });
  for (let h = 0; h < 24; h++) assert.equal(r.heat.reduce((s, row) => s + row[h], 0), r.hours[h]);
  for (let d = 0; d < 7; d++) assert.equal(r.heat[d].reduce((s, v) => s + v, 0), r.weekdays[d]);
});

test("default (machine) time zone path works and conserves counts", () => {
  const now = Date.now();
  const entries = [visit("https://a.com/", now - 3600000), visit("https://a.com/", now - 5 * 3600000)];
  const r = A.compute(entries, { now, period: "24h" });
  assert.equal(r.cards.visits, 2);
  assert.equal(r.hours.reduce((a, b) => a + b, 0), 2);
  assert.equal(A.makeTz().dayStart(now) <= now, true);
});

test("mergeEntries: one visit = (url, visitedAt); order of first sight kept", () => {
  const a = { url: "https://a.com/", title: "A", visitedAt: 1 };
  const merged = A.mergeEntries([[a, { ...a }], [{ url: "https://a.com/", title: "x", visitedAt: 2 }, a], null, [{ url: 5 }]]);
  assert.equal(merged.length, 2);
});

test("summaryText: short, localised, empty case", () => {
  const entries = [visit("https://a.com/", at(MSK, 2025, 3, 11, 21)), visit("https://b.com/", at(MSK, 2025, 3, 4, 21))];
  const r = A.compute(entries, { ...base, period: "7d" });
  const ru = A.summaryText(r, "ru");
  const en = A.summaryText(r, "en");
  assert.match(ru, /посещений/);
  assert.match(en, /visits/);
  assert.ok(ru.length <= 300 && en.length <= 300);
  assert.match(A.summaryText(A.compute([], { ...base, period: "7d" }), "en"), /No visits/);
});

test("normalizeDomainInput", () => {
  assert.equal(A.normalizeDomainInput(" HTTPS://www.Example.com:443/a?b "), "example.com");
  assert.equal(A.normalizeDomainInput("example.com."), "example.com");
  assert.equal(A.normalizeDomainInput(null), "");
});
