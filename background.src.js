/* Habits Dashboard: background page logic.
 *
 * SOURCE FILE. Drift loads exactly one background script, so `node build.js`
 * inlines aggregate.js above this file and writes background.js. Edit this
 * file and aggregate.js, never background.js.
 *
 * Everything is computed here, locally. The page only receives aggregates.
 */
(function () {
  "use strict";

  var dp = window.driftPlugin;
  var Agg = window.HabitsAgg;

  var CALL_LIMIT = 1000; // plugin_history_search hard cap per call
  var MAX_CALLS = 60; // budget of history.search calls per refresh
  var DOMAINS_PER_ROUND = 25;
  var PROBE_RESERVE_AT = 35; // domain rounds before the probes stop at this many calls
  var TLD_PROBES = [".com", ".ru", ".org", ".net", ".io", ".dev", ".app", ".by", ".ua", ".de", ".uk"];
  var MEM_TTL = 60 * 1000; // loaded history reused while switching periods
  var DISK_TTL = 10 * 60 * 1000; // stored aggregates reused after a restart
  var WEEK = 7 * 24 * 3600 * 1000;
  var MAX_EXCLUDED = 200;
  var MAX_CATEGORY_RULES = 500;

  var DEFAULTS = { excluded: [], categories: {}, blur: false, weeklyNotify: false, lastWeeklyAt: 0 };

  var mem = null; // { at, key, entries, sample }
  var inflight = null;

  /** The browser's interface language, as the page last reported it (the page is
   *  told by Drift); this window's own navigator.language is only the fallback. */
  function getLang() {
    return Promise.resolve(dp.storage.get("lang")).then(function (stored) {
      if (stored === "ru" || stored === "en") return stored;
      var l = (typeof navigator !== "undefined" && navigator.language) || "en";
      return String(l).toLowerCase().indexOf("ru") === 0 ? "ru" : "en";
    });
  }

  var knownLang = null;
  function rememberLang(value) {
    var l = String(value || "").toLowerCase().indexOf("ru") === 0 ? "ru" : "en";
    if (!value || l === knownLang) return;
    knownLang = l;
    Promise.resolve(dp.storage.set("lang", l)).catch(function () {});
  }

  // ----------------------------------------------------------------- settings

  function sanitizeSettings(raw) {
    var s = raw && typeof raw === "object" ? raw : {};
    var excluded = [];
    var seen = {};
    (Array.isArray(s.excluded) ? s.excluded : []).forEach(function (item) {
      var d = Agg.normalizeDomainInput(item).slice(0, 100);
      if (d && !seen[d] && excluded.length < MAX_EXCLUDED) {
        seen[d] = 1;
        excluded.push(d);
      }
    });
    var categories = {};
    var n = 0;
    var cats = s.categories && typeof s.categories === "object" ? s.categories : {};
    Object.keys(cats).forEach(function (key) {
      var d = Agg.normalizeDomainInput(key).slice(0, 100);
      if (d && Agg.CATEGORY_IDS.indexOf(cats[key]) >= 0 && n < MAX_CATEGORY_RULES) {
        categories[d] = cats[key];
        n++;
      }
    });
    return {
      excluded: excluded,
      categories: categories,
      blur: s.blur === true,
      weeklyNotify: s.weeklyNotify === true,
      lastWeeklyAt: typeof s.lastWeeklyAt === "number" && isFinite(s.lastWeeklyAt) ? s.lastWeeklyAt : 0,
    };
  }

  function getSettings() {
    return Promise.resolve(dp.storage.get("settings")).then(function (raw) {
      return sanitizeSettings(raw || DEFAULTS);
    });
  }

  function saveSettings(patch) {
    return getSettings().then(function (current) {
      var p = patch && typeof patch === "object" ? patch : {};
      var next = {};
      Object.keys(current).forEach(function (k) {
        next[k] = p[k] !== undefined && k !== "lastWeeklyAt" ? p[k] : current[k];
      });
      next = sanitizeSettings(next);
      // Turning the weekly summary on starts the week from now, not "overdue".
      if (next.weeklyNotify && !current.weeklyNotify) next.lastWeeklyAt = Date.now();
      return Promise.resolve(dp.storage.set("settings", next)).then(function () {
        return next;
      });
    });
  }

  function settingsKey(s) {
    return JSON.stringify([s.excluded, s.categories]);
  }

  // ------------------------------------------------------------------ history

  function oldestOf(entries) {
    var min = Infinity;
    entries.forEach(function (e) {
      if (e.visitedAt < min) min = e.visitedAt;
    });
    return min === Infinity ? null : min;
  }

  function newestOf(entries) {
    var max = -Infinity;
    entries.forEach(function (e) {
      if (e.visitedAt > max) max = e.visitedAt;
    });
    return max === -Infinity ? null : max;
  }

  /** Registrable domains of `entries` by visit count, skipping those in `skip`. */
  function domainsByCount(entries, skip) {
    var counts = Object.create(null);
    entries.forEach(function (e) {
      var d = Agg.registrable(Agg.hostOf(e.url));
      if (!d || skip[d]) return;
      counts[d] = (counts[d] || 0) + 1;
    });
    return Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || (a < b ? -1 : 1);
    });
  }

  /**
   * One history.search returns at most 1000 newest visits, with no paging.
   * 1. One unfiltered call. Fewer than 1000 back = the whole history.
   * 2. Otherwise everything NEWER than the oldest entry of that call is
   *    complete (`fullFrom`). For older time we ask per domain (substring
   *    query, 1000 newest each) and with TLD probes to find more domains.
   *    That deepens known sites but cannot prove completeness, so the
   *    sample says so (`complete: false`) and lists domains that hit the cap.
   */
  function loadHistory(excludedList) {
    var calls = 0;
    var truncated = [];
    var queried = Object.create(null);
    excludedList.forEach(function (d) {
      queried[d] = 1; // never ask about hidden sites
    });

    function search(query) {
      calls++;
      var options = query ? { query: query, limit: CALL_LIMIT } : { limit: CALL_LIMIT };
      return Promise.resolve(dp.history.search(options)).then(function (r) {
        return Array.isArray(r) ? r : [];
      });
    }

    function finish(lists, complete, fullFrom) {
      var entries = Agg.mergeEntries(lists);
      return {
        entries: entries,
        sample: {
          count: entries.length,
          oldest: oldestOf(entries),
          newest: newestOf(entries),
          complete: complete,
          fullFrom: fullFrom,
          callLimit: CALL_LIMIT,
          calls: calls,
          truncatedDomains: truncated.slice(0, 20),
        },
      };
    }

    return search(null).then(function (base) {
      var lists = [base];
      var complete = base.length < CALL_LIMIT;
      if (complete) return finish(lists, true, null);
      var fullFrom = oldestOf(base);

      function domainRound(cap) {
        var pending = domainsByCount(Agg.mergeEntries(lists), queried).slice(0, DOMAINS_PER_ROUND);
        if (!pending.length || calls >= cap) return Promise.resolve(false);
        var chain = Promise.resolve();
        pending.forEach(function (domain) {
          chain = chain.then(function () {
            if (calls >= cap) return;
            queried[domain] = 1;
            return search(domain).then(function (r) {
              lists.push(r);
              if (r.length >= CALL_LIMIT) truncated.push(domain);
            });
          });
        });
        return chain.then(function () {
          return true;
        });
      }

      function rounds(left, cap) {
        if (left <= 0) return Promise.resolve();
        return domainRound(cap).then(function (didWork) {
          return didWork ? rounds(left - 1, cap) : undefined;
        });
      }

      function probes() {
        var chain = Promise.resolve();
        TLD_PROBES.forEach(function (probe) {
          chain = chain.then(function () {
            if (calls >= MAX_CALLS) return;
            return search(probe).then(function (r) {
              lists.push(r);
            });
          });
        });
        return chain;
      }

      // The first rounds stop early so the TLD probes (which find unknown older
      // domains) always get their calls; the rest of the budget goes to new domains.
      return rounds(3, PROBE_RESERVE_AT)
        .then(probes)
        .then(function () {
          return rounds(3, MAX_CALLS);
        })
        .then(function () {
          return finish(lists, false, fullFrom);
        });
    });
  }

  function loadCached(settings, refresh) {
    var key = settingsKey(settings);
    if (!refresh && mem && Date.now() - mem.at < MEM_TTL && mem.key === key) return Promise.resolve(mem);
    if (!refresh && inflight && inflight.key === key) return inflight.promise;
    var promise = loadHistory(settings.excluded).then(function (loaded) {
      mem = { at: Date.now(), key: key, entries: loaded.entries, sample: loaded.sample };
      return mem;
    });
    inflight = { key: key, promise: promise };
    var clear = function () {
      if (inflight && inflight.promise === promise) inflight = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  // -------------------------------------------------------------------- stats

  function buildStats(loaded, settings, period, now) {
    var stats = Agg.compute(loaded.entries, {
      now: now,
      period: period,
      excluded: settings.excluded,
      categories: settings.categories,
    });
    var sample = Object.assign({}, loaded.sample);
    // "new" = first seen in this period among the visits we could load
    stats.cards.newSitesApprox = !sample.complete;
    sample.partialPeriod = !sample.complete && sample.fullFrom !== null && stats.range.start < sample.fullFrom;
    return { stats: stats, sample: sample };
  }

  function readDiskCache(settings, period, now) {
    return Promise.resolve(dp.storage.get("cache")).then(function (c) {
      if (!c || typeof c !== "object" || c.key !== settingsKey(settings)) return null;
      var hit = c.results && c.results[period];
      if (!hit || typeof hit.at !== "number" || now - hit.at > DISK_TTL) return null;
      return hit;
    });
  }

  /** Page titles are never written to disk: they would outlive a "clear history". */
  function withoutTitles(stats) {
    var copy = Object.assign({}, stats);
    copy.topSites = stats.topSites.map(function (s) {
      return Object.assign({}, s, { recent: [] });
    });
    return copy;
  }

  var cacheChain = Promise.resolve();
  function writeDiskCache(settings, period, payload, now) {
    cacheChain = cacheChain
      .then(function () {
        return dp.storage.get("cache");
      })
      .then(function (c) {
        var keep = c && typeof c === "object" && c.key === settingsKey(settings) && c.results ? c.results : {};
        keep[period] = { at: now, stats: withoutTitles(payload.stats), sample: payload.sample };
        return dp.storage.set("cache", { key: settingsKey(settings), results: keep });
      })
      .catch(function () {});
    return cacheChain;
  }

  /** Cached results older than the TTL are deleted, not just ignored. */
  function purgeDiskCache() {
    return Promise.resolve(dp.storage.get("cache"))
      .then(function (c) {
        if (!c || typeof c !== "object" || !c.results) return null;
        var now = Date.now();
        var keep = {};
        var any = false;
        Object.keys(c.results).forEach(function (p) {
          var h = c.results[p];
          if (h && typeof h.at === "number" && now - h.at <= DISK_TTL) {
            keep[p] = h;
            any = true;
          }
        });
        return dp.storage.set("cache", any ? { key: c.key, results: keep } : null);
      })
      .catch(function () {});
  }

  /** `reuse`: a period switch inside an open page may reuse the history loaded moments ago.
   *  Opening the page and "Refresh" always read the history again. */
  function getStats(period, refresh, reuse) {
    var now = Date.now();
    if (Agg.PERIODS.indexOf(period) < 0) period = "7d";
    return getSettings().then(function (settings) {
      var useDisk = !refresh && !reuse;
      return (useDisk ? readDiskCache(settings, period, now) : Promise.resolve(null)).then(function (hit) {
        if (hit) {
          return { ok: true, stats: hit.stats, sample: hit.sample, settings: settings, generatedAt: hit.at, fromCache: true };
        }
        return loadCached(settings, refresh === true || !reuse).then(function (loaded) {
          var built = buildStats(loaded, settings, period, now);
          writeDiskCache(settings, period, built, now).catch(function () {});
          return { ok: true, stats: built.stats, sample: built.sample, settings: settings, generatedAt: now, fromCache: false };
        });
      });
    });
  }

  // ------------------------------------------------------------------- weekly

  /** `force`: the palette command. Without it: only when switched on and a week has passed. */
  function weeklySummary(force) {
    return getSettings().then(function (settings) {
      var now = Date.now();
      if (!force && (!settings.weeklyNotify || now - settings.lastWeeklyAt < WEEK)) return false;
      return loadCached(settings, true).then(function (loaded) {
        var built = buildStats(loaded, settings, "7d", now);
        return getLang().then(function (l) {
          return dp.notifications.show({
            title: l === "ru" ? "Итоги недели" : "Weekly summary",
            body: Agg.summaryText(built.stats, l),
          });
        }).then(function () {
          if (force) return true;
          return getSettings().then(function (current) {
            var next = sanitizeSettings(Object.assign({}, current, { lastWeeklyAt: now }));
            return Promise.resolve(dp.storage.set("settings", next)).then(function () {
              return true;
            });
          });
        });
      });
    });
  }

  // ---------------------------------------------------------------- messaging

  dp.runtime.onPageMessage(function (message) {
    var type = message && message.type;
    var work;
    if (message && message.lang) rememberLang(message.lang);
    if (type === "getStats") {
      work = getStats(message.period, message.refresh === true, message.reuse === true);
    } else if (type === "getSettings") {
      work = getSettings().then(function (s) {
        return { ok: true, settings: s };
      });
    } else if (type === "saveSettings") {
      work = saveSettings(message.settings).then(function (s) {
        mem = null; // exclusions / categories changed: re-read
        return { ok: true, settings: s };
      });
    } else {
      work = Promise.resolve({ ok: false, error: "unknown message" });
    }
    return work.catch(function (e) {
      return { ok: false, error: String((e && e.message) || e) };
    });
  });

  dp.runtime.onCommand(function (id, ctx) {
    try {
      if (id === "@toolbar" || id === "open") {
        Promise.resolve(dp.ui.openPage({ windowLabel: ctx && ctx.windowLabel })).catch(function (e) {
          console.error("[habits-dashboard] openPage", e);
        });
      } else if (id === "weekly") {
        weeklySummary(true).catch(function (e) {
          console.error("[habits-dashboard] weekly", e);
        });
      }
    } catch (e) {
      console.error("[habits-dashboard]", e);
    }
  });

  purgeDiskCache();

  // Hourly: has a week passed since the last summary (only if switched on)?
  function tick() {
    weeklySummary(false).catch(function () {});
  }
  if (typeof setTimeout === "function") {
    setTimeout(tick, 30 * 1000);
    setInterval(tick, 60 * 60 * 1000);
  }
})();
