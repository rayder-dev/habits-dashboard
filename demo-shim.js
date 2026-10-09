/* demo-shim.js: stand-in for Drift, ONLY for demo.html.
 *
 * Gives the page and the real background.js a fake `window.driftPlugin`
 * backed by synthetic history, so the dashboard can be opened in an ordinary
 * browser. It mimics plugin_history_search: substring query over url + title,
 * newest first, at most 1000 per call. Nothing here is used inside Drift.
 *
 * URL options: ?lang=ru|en  ?theme=dark|light  ?n=4000 (history size)
 */
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var lang = params.get("lang") || (navigator.language || "en");
  var theme = params.get("theme") || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  var N = Math.min(5000, Math.max(0, parseInt(params.get("n") || "4200", 10) || 0));

  // ---- seeded random so the demo looks the same every time
  var seed = 20251009;
  function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  // domain, weight, preferred hours (weights per hour group), weekend factor
  var SITES = [
    ["youtube.com", 22, "evening", 1.6], ["github.com", 18, "work", 0.4], ["google.com", 14, "work", 0.8],
    ["vk.com", 12, "evening", 1.3], ["habr.com", 8, "work", 0.5], ["docs.google.com", 8, "work", 0.3],
    ["ozon.ru", 6, "evening", 1.5], ["rbc.ru", 5, "morning", 1.0], ["stackoverflow.com", 7, "work", 0.3],
    ["twitch.tv", 5, "night", 1.8], ["wikipedia.org", 4, "any", 1.0], ["telegram.org", 4, "evening", 1.2],
    ["kinopoisk.ru", 3, "night", 1.7], ["avito.ru", 2, "evening", 1.4], ["news.ycombinator.com", 3, "morning", 0.9],
    ["example-blog.dev", 1, "any", 1.0], ["localhost", 5, "work", 0.4],
  ];
  var HOURS = {
    morning: [0, 0, 0, 0, 0, 0, 1, 4, 8, 6, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    work: [0, 0, 0, 0, 0, 0, 0, 1, 4, 9, 10, 9, 5, 7, 10, 10, 8, 6, 3, 1, 1, 0, 0, 0],
    evening: [1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 4, 6, 9, 10, 10, 7, 3],
    night: [6, 4, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 5, 7, 9, 10, 9],
    any: [1, 0, 0, 0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 1],
  };
  var TITLES = {
    "youtube.com": ["Lo-fi beats to focus", "How browsers work", "Rust in 100 seconds", "Evening news digest", "<img src=x onerror=alert(1)> Not a real tag"],
    "github.com": ["Pull request #412", "Issues · drift", "tauri-apps/tauri", "Actions · build"],
    "google.com": ["how to center a div", "weather tomorrow", "курс доллара", "best pizza near me"],
    "vk.com": ["Лента", "Сообщения", "Музыка"],
    "habr.com": ["Как устроен WebView2", "Rust и безопасность памяти", "Хабр · Лучшее за сутки"],
    "docs.google.com": ["Roadmap Q4 — Google Docs", "Budget 2025 — Sheets"],
    "ozon.ru": ["Наушники беспроводные", "Корзина", "Заказы"],
    "rbc.ru": ["Главные новости", "Экономика"],
    "stackoverflow.com": ["javascript - Intl.DateTimeFormat timezone", "rust - borrow checker"],
  };

  var now = Date.now();
  var DAYS = 120;
  var weights = SITES.map(function (s) { return s[1]; });
  var total = weights.reduce(function (a, b) { return a + b; }, 0);
  function pickSite() {
    var r = rnd() * total;
    for (var i = 0; i < SITES.length; i++) { r -= weights[i]; if (r <= 0) return SITES[i]; }
    return SITES[0];
  }
  function pickHour(group) {
    var w = HOURS[group];
    var sum = w.reduce(function (a, b) { return a + b; }, 0);
    var r = rnd() * sum;
    for (var h = 0; h < 24; h++) { r -= w[h]; if (r <= 0) return h; }
    return 12;
  }

  var entries = [];
  var guard = 0;
  while (entries.length < N && guard++ < N * 20) {
    var site = pickSite();
    // recent days are more likely than old ones
    var daysAgo = Math.floor(Math.pow(rnd(), 1.7) * DAYS);
    var d = new Date(now - daysAgo * 86400000);
    var weekend = d.getDay() === 0 || d.getDay() === 6;
    if (rnd() > (weekend ? Math.min(1, site[3]) : 1) * (weekend ? 1 : 1) && weekend && site[3] < 1) continue;
    d.setHours(pickHour(site[2]), Math.floor(rnd() * 60), Math.floor(rnd() * 60), 0);
    var ts = d.getTime();
    if (ts > now) continue;
    var host = (rnd() < 0.5 ? "www." : "") + site[0];
    var titles = TITLES[site[0]] || [site[0]];
    var title = titles[Math.floor(rnd() * titles.length)];
    entries.push({ url: "https://" + host + "/p/" + Math.floor(rnd() * 400), title: title, visitedAt: ts });
  }
  // a site first seen very recently, so "new sites" has something to show
  for (var k = 0; k < 4; k++) entries.push({ url: "https://new-discovery.example/post/" + k, title: "A brand-new find #" + k, visitedAt: now - (k + 1) * 3600000 * 5 });
  entries.sort(function (a, b) { return b.visitedAt - a.visitedAt; });
  if (entries.length > 5000) entries.length = 5000; // Drift keeps at most ~5000 visits

  // ---- fake driftPlugin
  var store = {};
  try { store = JSON.parse(sessionStorage.getItem("habits-demo-store") || "{}"); } catch (e) { store = {}; }
  function persist() { try { sessionStorage.setItem("habits-demo-store", JSON.stringify(store)); } catch (e) { /* ignore */ } }
  delete store.cache; // the demo history changes with ?n=, so never reuse an old result
  var pageHandler = null;
  var themeHandlers = [];

  window.driftPlugin = {
    // background side
    storage: {
      get: function (key) { return Promise.resolve(key in store ? JSON.parse(JSON.stringify(store[key])) : null); },
      set: function (key, value) { store[key] = JSON.parse(JSON.stringify(value)); persist(); return Promise.resolve(); },
    },
    history: {
      search: function (o) {
        o = o || {};
        var limit = Math.min(Math.max(o.limit || 100, 1), 1000);
        var q = o.query ? String(o.query).trim().slice(0, 200).toLowerCase() : "";
        var out = entries.filter(function (e) { return !q || e.url.toLowerCase().indexOf(q) >= 0 || e.title.toLowerCase().indexOf(q) >= 0; });
        return Promise.resolve(out.slice(0, limit).map(function (e) { return { url: e.url, title: e.title, visitedAt: e.visitedAt }; }));
      },
    },
    notifications: { show: function (o) { console.log("[demo] notification:", o); return Promise.resolve(true); } },
    ui: { openPage: function () { return Promise.resolve(); } },
    // both sides
    runtime: {
      onPageMessage: function (fn) { pageHandler = fn; },
      onCommand: function () {},
      sendMessage: function (message) {
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            if (!pageHandler) return reject(new Error("background not ready"));
            Promise.resolve(pageHandler(JSON.parse(JSON.stringify(message)))).then(function (r) { resolve(JSON.parse(JSON.stringify(r))); }, reject);
          }, 120);
        });
      },
    },
    // page side
    onStorageChanged: function () {},
    onTheme: function (fn) { themeHandlers.push(fn); setTimeout(function () { fn({ theme: theme, lang: lang }); }, 0); },
    ready: Promise.resolve(),
  };

  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
  document.documentElement.lang = lang;

  var bar = document.createElement("div");
  bar.className = "demo-bar";
  bar.textContent = "DEMO: synthetic history (" + entries.length + " visits), not your data. ";
  [["lang=ru", "RU"], ["lang=en", "EN"], ["theme=dark", "dark"], ["theme=light", "light"], ["n=600", "short history"], ["n=4200", "long history"]].forEach(function (pair) {
    var a = document.createElement("a");
    var p = new URLSearchParams(location.search);
    p.set(pair[0].split("=")[0], pair[0].split("=")[1]);
    a.href = "?" + p.toString();
    a.textContent = pair[1];
    bar.appendChild(a);
  });
  document.addEventListener("DOMContentLoaded", function () { document.body.insertBefore(bar, document.body.firstChild); });
})();
