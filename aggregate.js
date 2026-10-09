/* Habits Dashboard: aggregation of browsing history.
 *
 * Pure functions, no browser APIs: the same file runs in the background page
 * (build.js inlines it into background.js), in the demo and under `node --test`.
 *
 * Time model: everything is computed in the LOCAL time zone. Ranges are
 * half-open [start, end). Weekdays are 0 = Monday ... 6 = Sunday.
 * For tests a fixed zone can be passed as `tz: { offsetMin: 180 }`.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HabitsAgg = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var HOUR = 3600000;
  var DAY = 24 * HOUR;

  var CATEGORY_IDS = ["social", "video", "work", "news", "shopping", "other"];

  var DEFAULT_CATEGORY_DOMAINS = {
    social: [
      "facebook.com", "instagram.com", "twitter.com", "x.com", "vk.com", "vk.ru", "ok.ru", "t.me", "telegram.org",
      "web.telegram.org", "reddit.com", "linkedin.com", "tiktok.com", "discord.com", "pinterest.com", "threads.net",
      "whatsapp.com", "snapchat.com", "tumblr.com", "mastodon.social", "bsky.app",
    ],
    video: [
      "youtube.com", "youtu.be", "twitch.tv", "netflix.com", "rutube.ru", "kinopoisk.ru", "ivi.ru", "vimeo.com",
      "dailymotion.com", "okko.tv", "wink.ru", "disneyplus.com", "primevideo.com", "hbomax.com", "crunchyroll.com",
      "smotrim.ru", "start.ru",
    ],
    work: [
      "github.com", "gitlab.com", "bitbucket.org", "stackoverflow.com", "stackexchange.com", "notion.so", "slack.com",
      "atlassian.net", "atlassian.com", "jira.com", "trello.com", "figma.com", "docs.google.com", "drive.google.com",
      "mail.google.com", "calendar.google.com", "office.com", "microsoft.com", "live.com", "outlook.com", "zoom.us",
      "linear.app", "asana.com", "miro.com", "habr.com", "developer.mozilla.org", "npmjs.com",
      "docker.com", "yandex.ru", "mail.ru", "claude.ai", "openai.com", "chatgpt.com", "anthropic.com", "localhost",
    ],
    news: [
      "bbc.com", "bbc.co.uk", "cnn.com", "nytimes.com", "theguardian.com", "reuters.com", "bloomberg.com", "rbc.ru",
      "lenta.ru", "ria.ru", "tass.ru", "meduza.io", "kommersant.ru", "vedomosti.ru", "gazeta.ru", "iz.ru", "dzen.ru",
      "news.ycombinator.com", "washingtonpost.com", "apnews.com", "dw.com", "interfax.ru", "kp.ru", "mk.ru",
    ],
    shopping: [
      "amazon.com", "ebay.com", "aliexpress.com", "aliexpress.ru", "ozon.ru", "wildberries.ru", "avito.ru",
      "market.yandex.ru", "etsy.com", "temu.com", "lamoda.ru", "dns-shop.ru", "citilink.ru", "mvideo.ru",
      "sbermegamarket.ru", "megamarket.ru", "walmart.com", "shein.com", "kaspi.kz", "olx.com",
    ],
  };

  // ---------------------------------------------------------------- time zone

  function makeTz(opt) {
    if (opt && typeof opt.offsetMin === "number") {
      var off = opt.offsetMin * 60000;
      var parts = function (ts) {
        var d = new Date(ts + off);
        return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), wd: (d.getUTCDay() + 6) % 7 };
      };
      return {
        parts: parts,
        dayStart: function (ts) {
          var p = parts(ts);
          return Date.UTC(p.y, p.m, p.d) - off;
        },
        addDays: function (dayStartTs, n) {
          var p = parts(dayStartTs);
          return Date.UTC(p.y, p.m, p.d + n) - off;
        },
      };
    }
    return {
      parts: function (ts) {
        var d = new Date(ts);
        return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), wd: (d.getDay() + 6) % 7 };
      },
      dayStart: function (ts) {
        var d = new Date(ts);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      },
      addDays: function (dayStartTs, n) {
        var d = new Date(dayStartTs);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
      },
    };
  }

  // ------------------------------------------------------------------ domains

  var SECOND_LEVEL = { co: 1, com: 1, org: 1, net: 1, gov: 1, edu: 1, ac: 1, ne: 1, or: 1, go: 1 };

  function hostOf(url) {
    if (typeof url !== "string") return "";
    var host = "";
    try {
      host = new URL(url).hostname;
    } catch (e) {
      var m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(url);
      host = m ? m[1] : "";
    }
    host = host.toLowerCase();
    if (host.charAt(host.length - 1) === ".") host = host.slice(0, -1);
    return host;
  }

  /** Approximation of the registrable domain without a public-suffix list. */
  function registrable(host) {
    if (!host) return "";
    if (host.charAt(0) === "[" || /^\d+(\.\d+){3}$/.test(host)) return host;
    if (host.indexOf("www.") === 0 && host.indexOf(".", 4) < 0) host = host.slice(4); // www.localhost
    var labels = host.split(".");
    var n = labels.length;
    if (n <= 2) return host;
    var tld = labels[n - 1];
    if (tld.length === 2 && SECOND_LEVEL[labels[n - 2]]) return labels.slice(-3).join(".");
    return labels.slice(-2).join(".");
  }

  function normalizeDomainInput(text) {
    var s = String(text == null ? "" : text).trim().toLowerCase();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    s = s.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./, "");
    if (s.charAt(s.length - 1) === ".") s = s.slice(0, -1);
    return s;
  }

  /** `host` is `entry` or a subdomain of it. */
  function hostMatches(host, entry) {
    return host === entry || (host.length > entry.length && host.slice(-entry.length - 1) === "." + entry);
  }

  function isExcluded(host, domain, excluded) {
    for (var i = 0; i < excluded.length; i++) {
      var e = excluded[i];
      if (hostMatches(host, e) || domain === e) return true;
    }
    return false;
  }

  function categoryOf(host, domain, overrides) {
    var o = overrides || {};
    if (o[domain] && CATEGORY_IDS.indexOf(o[domain]) >= 0) return o[domain];
    if (o[host] && CATEGORY_IDS.indexOf(o[host]) >= 0) return o[host];
    for (var i = 0; i < CATEGORY_IDS.length; i++) {
      var list = DEFAULT_CATEGORY_DOMAINS[CATEGORY_IDS[i]];
      if (!list) continue;
      for (var j = 0; j < list.length; j++) {
        if (hostMatches(host, list[j]) || domain === list[j]) return CATEGORY_IDS[i];
      }
    }
    return "other";
  }

  // ------------------------------------------------------------------ periods

  var PERIODS = ["24h", "7d", "30d", "all"];

  /**
   * 24h: rolling last 24 hours, previous = the 24 hours before.
   * 7d / 30d: the last N local calendar days including today; previous = the N days before.
   * all: from the day of `firstTs` (earliest visit) to now; no previous period.
   * `end` is exclusive and equals now + 1, so a visit exactly at `now` counts.
   */
  function periodRange(now, period, tz, firstTs) {
    var end = now + 1;
    if (period === "24h") {
      return { start: now - DAY, end: end, prevStart: now - 2 * DAY, prevEnd: now - DAY, bucket: "hour" };
    }
    var n = period === "7d" ? 7 : period === "30d" ? 30 : 0;
    if (n) {
      var today = tz.dayStart(now);
      var start = tz.addDays(today, -(n - 1));
      return { start: start, end: end, prevStart: tz.addDays(start, -n), prevEnd: start, bucket: "day" };
    }
    var first = typeof firstTs === "number" && isFinite(firstTs) ? tz.dayStart(firstTs) : tz.dayStart(now);
    return { start: first, end: end, prevStart: null, prevEnd: null, bucket: "day" };
  }

  function buildBuckets(range, tz) {
    var starts = [];
    var i;
    if (range.bucket === "hour") {
      for (i = 0; i < 24; i++) starts.push(range.start + i * HOUR);
      return { step: "hour", starts: starts };
    }
    var days = 0;
    var cur = range.start;
    while (cur < range.end && days < 100000) {
      days++;
      cur = tz.addDays(cur, 1);
    }
    var stepDays = days > 180 ? 7 : 1;
    cur = range.start;
    while (cur < range.end) {
      starts.push(cur);
      cur = tz.addDays(cur, stepDays);
    }
    return { step: stepDays === 7 ? "week" : "day", starts: starts };
  }

  // -------------------------------------------------------------------- merge

  /** Merges several lists of {url,title,visitedAt}; one visit = one (url, visitedAt). */
  function mergeEntries(lists) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < lists.length; i++) {
      var list = lists[i] || [];
      for (var j = 0; j < list.length; j++) {
        var e = list[j];
        if (!e || typeof e.url !== "string" || typeof e.visitedAt !== "number") continue;
        var key = e.visitedAt + "|" + e.url;
        if (seen[key]) continue;
        seen[key] = 1;
        out.push(e);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ compute

  function zeros(n) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = 0;
    return a;
  }

  function argmax(values) {
    var best = -1;
    var bestValue = 0;
    for (var i = 0; i < values.length; i++) {
      if (values[i] > bestValue) {
        bestValue = values[i];
        best = i;
      }
    }
    return best < 0 ? null : { index: best, count: bestValue };
  }

  /**
   * @param {Array<{url:string,title:string,visitedAt:number}>} entries
   * @param {{now:number, period:string, tz?:object, excluded?:string[], categories?:object, topN?:number, recentN?:number}} opts
   */
  function compute(entries, opts) {
    var now = opts.now;
    var period = PERIODS.indexOf(opts.period) >= 0 ? opts.period : "7d";
    var tz = makeTz(opts.tz);
    var excluded = (opts.excluded || []).map(normalizeDomainInput).filter(Boolean);
    var overrides = opts.categories || {};
    var topN = opts.topN || 15;
    var recentN = opts.recentN || 8;

    // Normalise once; drop what cannot be analysed.
    var rows = [];
    var firstSeen = Object.create(null);
    var firstTs = Infinity;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || typeof e.visitedAt !== "number" || !isFinite(e.visitedAt) || e.visitedAt > now) continue;
      var host = hostOf(e.url);
      if (!host) continue;
      var domain = registrable(host);
      if (isExcluded(host, domain, excluded)) continue;
      rows.push({ ts: e.visitedAt, host: host, domain: domain, title: typeof e.title === "string" ? e.title : "" });
      if (firstSeen[domain] === undefined || e.visitedAt < firstSeen[domain]) firstSeen[domain] = e.visitedAt;
      if (e.visitedAt < firstTs) firstTs = e.visitedAt;
    }

    var range = periodRange(now, period, tz, firstTs === Infinity ? null : firstTs);
    var hasPrev = range.prevStart !== null;

    var hours = zeros(24);
    var weekdays = zeros(7);
    var heat = [];
    for (var d = 0; d < 7; d++) heat.push(zeros(24));
    var buckets = buildBuckets(range, tz);
    var series = buckets.starts.map(function (s) {
      return { start: s, count: 0 };
    });
    var bySite = Object.create(null);
    var catCount = Object.create(null);
    CATEGORY_IDS.forEach(function (c) {
      catCount[c] = 0;
    });
    var visits = 0;
    var prevVisits = 0;
    var prevBySite = Object.create(null);

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var ts = row.ts;
      if (ts >= range.start && ts < range.end) {
        var p = tz.parts(ts);
        visits++;
        hours[p.h]++;
        weekdays[p.wd]++;
        heat[p.wd][p.h]++;
        // last bucket whose start <= ts
        var lo = 0;
        var hi = series.length - 1;
        while (lo < hi) {
          var mid = (lo + hi + 1) >> 1;
          if (series[mid].start <= ts) lo = mid;
          else hi = mid - 1;
        }
        if (series.length) series[lo].count++;
        var site = bySite[row.domain];
        if (!site) {
          site = bySite[row.domain] = { domain: row.domain, visits: 0, hours: zeros(24), weekdays: zeros(7), recent: [] };
        }
        site.visits++;
        site.hours[p.h]++;
        site.weekdays[p.wd]++;
        site.recent.push({ at: ts, title: row.title || row.host });
        catCount[categoryOf(row.host, row.domain, overrides)]++;
      } else if (hasPrev && ts >= range.prevStart && ts < range.prevEnd) {
        prevVisits++;
        prevBySite[row.domain] = (prevBySite[row.domain] || 0) + 1;
      }
    }

    var sites = Object.keys(bySite).map(function (k) {
      return bySite[k];
    });
    sites.sort(function (a, b) {
      return b.visits - a.visits || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
    });

    var newSites = null;
    var prevNewSites = null;
    if (hasPrev) {
      newSites = 0;
      sites.forEach(function (s) {
        if (firstSeen[s.domain] >= range.start) newSites++;
      });
      prevNewSites = 0;
      Object.keys(prevBySite).forEach(function (dom) {
        if (firstSeen[dom] >= range.prevStart) prevNewSites++;
      });
    }

    var top = sites.slice(0, topN).map(function (s) {
      var recent = s.recent
        .sort(function (a, b) {
          return b.at - a.at;
        })
        .slice(0, recentN);
      return {
        domain: s.domain,
        visits: s.visits,
        share: visits ? s.visits / visits : 0,
        prevVisits: hasPrev ? prevBySite[s.domain] || 0 : null,
        category: categoryOf(s.domain, s.domain, overrides),
        isNew: hasPrev ? firstSeen[s.domain] >= range.start : null,
        hours: s.hours,
        weekdays: s.weekdays,
        recent: recent,
      };
    });

    var categories = CATEGORY_IDS.map(function (id) {
      return { id: id, visits: catCount[id], share: visits ? catCount[id] / visits : 0 };
    }).sort(function (a, b) {
      return b.visits - a.visits || CATEGORY_IDS.indexOf(a.id) - CATEGORY_IDS.indexOf(b.id);
    });

    var peakHour = argmax(hours);
    var peakWeekday = argmax(weekdays);

    return {
      period: period,
      range: { start: range.start, end: range.end, prevStart: range.prevStart, prevEnd: range.prevEnd },
      cards: {
        visits: visits,
        uniqueSites: sites.length,
        peakHour: peakHour && { hour: peakHour.index, count: peakHour.count },
        peakWeekday: peakWeekday && { weekday: peakWeekday.index, count: peakWeekday.count },
        newSites: newSites,
      },
      prev: hasPrev
        ? { visits: prevVisits, uniqueSites: Object.keys(prevBySite).length, newSites: prevNewSites }
        : null,
      topSites: top,
      hours: hours,
      weekdays: weekdays,
      heat: heat,
      series: { step: buckets.step, points: series },
      categories: categories,
    };
  }

  // ------------------------------------------------------------------ summary

  var WEEKDAYS = {
    ru: ["пн", "вт", "ср", "чт", "пт", "сб", "вс"],
    en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  };

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** One short text (<= 300 chars) for the weekly notification. */
  function summaryText(stats, lang) {
    var ru = lang === "ru";
    var c = stats.cards;
    if (!c.visits) return ru ? "За 7 дней посещений нет." : "No visits in the last 7 days.";
    var parts = [];
    parts.push(ru ? c.visits + " посещений, " + c.uniqueSites + " сайтов" : c.visits + " visits, " + c.uniqueSites + " sites");
    if (stats.prev && stats.prev.visits > 0) {
      var pct = Math.round(((c.visits - stats.prev.visits) / stats.prev.visits) * 100);
      parts.push((pct >= 0 ? "+" : "") + pct + "% " + (ru ? "к прошлой неделе" : "vs last week"));
    }
    if (stats.topSites.length) {
      var names = stats.topSites.slice(0, 3).map(function (s) {
        return s.domain;
      });
      parts.push((ru ? "топ: " : "top: ") + names.join(", "));
    }
    if (c.peakHour) parts.push((ru ? "пик: " : "peak: ") + pad2(c.peakHour.hour) + ":00");
    if (c.peakWeekday) parts.push(WEEKDAYS[ru ? "ru" : "en"][c.peakWeekday.weekday]);
    return parts.join(" · ").slice(0, 300);
  }

  return {
    CATEGORY_IDS: CATEGORY_IDS,
    DEFAULT_CATEGORY_DOMAINS: DEFAULT_CATEGORY_DOMAINS,
    PERIODS: PERIODS,
    HOUR: HOUR,
    DAY: DAY,
    makeTz: makeTz,
    hostOf: hostOf,
    registrable: registrable,
    normalizeDomainInput: normalizeDomainInput,
    hostMatches: hostMatches,
    isExcluded: isExcluded,
    categoryOf: categoryOf,
    periodRange: periodRange,
    mergeEntries: mergeEntries,
    compute: compute,
    summaryText: summaryText,
  };
});
