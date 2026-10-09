/* Habits Dashboard: page logic (runs in Drift's sandboxed frame).
 *
 * The page never touches history. It asks the background page for already
 * aggregated numbers (driftPlugin.runtime.sendMessage) and draws them.
 * Untrusted text (page titles, domains) is only ever put in with textContent.
 */
(function () {
  "use strict";

  var dp = window.driftPlugin;
  var C = window.Charts;

  var PERIODS = ["24h", "7d", "30d", "all"];
  var CATS = ["social", "video", "work", "news", "shopping", "other"];

  var I18N = {
    en: {
      title: "Habits Dashboard",
      subtitle: "Which sites you open most, and when. Computed locally.",
      period: "Period",
      p24h: "24 hours", p7d: "7 days", p30d: "30 days", pall: "All available",
      refresh: "Refresh", hide: "Hide numbers", show: "Show numbers", settings: "Settings", close: "Close",
      top_sites: "Top sites", top_hint: "Click a site for details.",
      categories: "Categories", cat_hint: "Built-in domain list; change a site's category in its details or in Settings.",
      by_hour: "Activity by hour of day", by_weekday: "Activity by weekday", heatmap: "Weekday × hour",
      dynamics: "Trend", dyn_hour: "Trend by hour", dyn_day: "Trend by day", dyn_week: "Trend by week",
      site_hours: "By hour", site_days: "By weekday", site_recent: "Recent pages (titles only)",
      excluded: "Excluded sites", excluded_hint: "Not counted anywhere in the statistics. A domain also covers its subdomains.",
      add: "Add", exclude_ph: "example.com", category: "Category",
      cat_rules: "Category rules", cat_rules_hint: "Your own category for a domain overrides the built-in list.",
      notify: "Notifications", weekly_toggle: "Show a weekly summary once a week",
      weekly_hint: "The palette command \"Weekly summary\" shows it right away.",
      privacy: "All numbers are computed on this device from your browsing history. Nothing is sent anywhere.",
      c_visits: "Visits", c_sites: "Unique sites", c_hour: "Busiest hour", c_day: "Busiest weekday", c_new: "New sites",
      approx: "approximate: history is cut", was: "was", new_vs_zero: "new", na_all: "no comparison for \"all\"", visits_n: "visits",
      vs: "vs previous", vs_24h: "previous 24 hours", vs_7d: "previous 7 days", vs_30d: "previous 30 days",
      less: "less", more: "more",
      cov: "Analysis of the {n} most recent visits loaded, since {date}",
      cov_full: "This is your whole stored history.",
      cov_partial: "History is larger than one call can return ({limit}). Everything since {from} is complete; before that only sites already known from the top were queried, so older numbers may be too low.",
      cov_period: "The selected period starts before that point: its figures are partial.",
      cov_trunc: "{n} site(s) hit the per-call limit, so their older visits are cut off.",
      cov_none: "No visits found in history.",
      cached: "from cache, {time}",
      empty: "No visits in this period (or all sites are excluded).",
      loading: "Loading…", error: "Could not load data: {msg}",
      site_share: "{share} of period", prev_site: "previous: {n}",
      wd: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      wds: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      cat: { social: "Social", video: "Video", work: "Work", news: "News", shopping: "Shopping", other: "Other" },
    },
    ru: {
      title: "Дашборд привычек",
      subtitle: "Какие сайты вы открываете чаще всего и в какое время. Всё считается локально.",
      period: "Период",
      p24h: "24 часа", p7d: "7 дней", p30d: "30 дней", pall: "Всё доступное",
      refresh: "Обновить", hide: "Скрыть цифры", show: "Показать цифры", settings: "Настройки", close: "Закрыть",
      top_sites: "Топ сайтов", top_hint: "Нажмите на сайт, чтобы увидеть подробности.",
      categories: "Категории", cat_hint: "Встроенный список доменов; категорию сайта можно менять в его подробностях или в настройках.",
      by_hour: "Активность по часам суток", by_weekday: "Активность по дням недели", heatmap: "День недели × час",
      dynamics: "Динамика", dyn_hour: "Динамика по часам", dyn_day: "Динамика по дням", dyn_week: "Динамика по неделям",
      site_hours: "По часам", site_days: "По дням недели", site_recent: "Последние страницы (только заголовки)",
      excluded: "Сайты-исключения", excluded_hint: "Не учитываются нигде в статистике. Домен захватывает и свои поддомены.",
      add: "Добавить", exclude_ph: "example.com", category: "Категория",
      cat_rules: "Правила категорий", cat_rules_hint: "Ваша категория для домена важнее встроенного списка.",
      notify: "Уведомления", weekly_toggle: "Показывать итоги недели раз в неделю",
      weekly_hint: "Команда «Итоги недели» в палитре показывает их сразу.",
      privacy: "Все числа считаются на этом устройстве по вашей истории. Ничего никуда не отправляется.",
      c_visits: "Посещений", c_sites: "Уникальных сайтов", c_hour: "Самый активный час", c_day: "Самый активный день", c_new: "Новых сайтов",
      approx: "приблизительно: история обрезана", was: "было", new_vs_zero: "новое", na_all: "для «всё» сравнения нет", visits_n: "посещений",
      vs: "к предыдущему", vs_24h: "предыдущие 24 часа", vs_7d: "предыдущие 7 дней", vs_30d: "предыдущие 30 дней",
      less: "меньше", more: "больше",
      cov: "Анализ по {n} последним посещениям, с {date}",
      cov_full: "Это вся хранящаяся история.",
      cov_partial: "История больше лимита одного запроса ({limit}). Всё, что новее {from}, полностью; до этого момента запрашивались только уже известные сайты, поэтому старые цифры могут быть занижены.",
      cov_period: "Выбранный период начинается раньше этого момента: цифры по нему неполные.",
      cov_trunc: "У сайтов ({n}) достигнут лимит одного запроса, их более старые посещения обрезаны.",
      cov_none: "В истории нет посещений.",
      cached: "из кэша, {time}",
      empty: "За этот период посещений нет (или все сайты в исключениях).",
      loading: "Загрузка…", error: "Не удалось загрузить данные: {msg}",
      site_share: "{share} от периода", prev_site: "ранее: {n}",
      wd: ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"],
      wds: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
      cat: { social: "Соцсети", video: "Видео", work: "Работа", news: "Новости", shopping: "Покупки", other: "Прочее" },
    },
  };

  var state = {
    lang: detectLang(typeof navigator !== "undefined" ? navigator.language : "en"),
    period: "7d",
    data: null,
    settings: { excluded: [], categories: {}, blur: false, weeklyNotify: false },
    site: null,
    reqId: 0,
  };

  function detectLang(l) {
    return String(l || "").toLowerCase().indexOf("ru") === 0 ? "ru" : "en";
  }
  function dict() { return I18N[state.lang]; }
  function t(key, vars) {
    var s = dict()[key];
    if (s === undefined) s = I18N.en[key];
    if (Array.isArray(s)) return s;
    if (typeof s !== "string") return key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split("{" + k + "}").join(String(vars[k])); });
    return s;
  }
  function $(id) { return document.getElementById(id); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(n) { return Number(n).toLocaleString(state.lang); }
  function pct(share) { return (Math.round(share * 1000) / 10).toLocaleString(state.lang) + "%"; }
  function fmtDate(ts) { return new Date(ts).toLocaleDateString(state.lang, { day: "numeric", month: "long", year: "numeric" }); }
  function fmtShortDate(ts) { return new Date(ts).toLocaleDateString(state.lang, { day: "numeric", month: "short" }); }
  function fmtDateTime(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString(state.lang, { day: "numeric", month: "short" }) + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function visitsText(n) {
    if (state.lang === "ru") {
      var m10 = n % 10;
      var m100 = n % 100;
      var w = m10 === 1 && m100 !== 11 ? "посещение" : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? "посещения" : "посещений";
      return fmt(n) + " " + w;
    }
    return fmt(n) + (n === 1 ? " visit" : " visits");
  }

  // --------------------------------------------------------------------- i18n

  function applyI18n() {
    document.documentElement.lang = state.lang;
    document.title = t("title");
    document.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    document.querySelectorAll("[data-i18n-ph]").forEach(function (el) { el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph"))); });
    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria"))); });
    buildPeriods();
    buildCategorySelect();
    updateBlurButton();
  }

  function buildPeriods() {
    var box = $("periods");
    C.clear(box);
    PERIODS.forEach(function (p) {
      var b = C.html("button", "", t("p" + p), box);
      b.type = "button";
      b.setAttribute("aria-pressed", String(p === state.period));
      b.addEventListener("click", function () {
        if (state.period === p) return;
        state.period = p;
        buildPeriods();
        load(false, true);
      });
    });
  }

  function buildCategorySelect() {
    var sel = $("in-cat-id");
    var keep = sel.value;
    C.clear(sel);
    CATS.forEach(function (c) {
      var o = C.html("option", "", t_cat(c), sel);
      o.value = c;
    });
    if (keep) sel.value = keep;
  }
  function t_cat(c) { return dict().cat[c] || c; }

  // --------------------------------------------------------------------- load

  function setBusy(on) { $("app").setAttribute("aria-busy", String(on)); }

  function showError(msg) {
    var box = $("error");
    box.textContent = t("error", { msg: msg });
    box.hidden = false;
  }

  function load(refresh, reuse) {
    var id = ++state.reqId;
    setBusy(true);
    $("error").hidden = true;
    return Promise.resolve(dp.runtime.sendMessage({ type: "getStats", period: state.period, refresh: !!refresh, reuse: !!reuse, lang: state.lang }))
      .then(function (res) {
        if (id !== state.reqId) return;
        if (!res || !res.ok) throw new Error((res && res.error) || "no answer");
        state.data = res;
        state.settings = res.settings;
        syncBlurFromSettings();
        render();
        // A stored result is only for a fast first paint: history may have changed
        // (or been cleared) since, so recompute right away.
        if (res.fromCache && !refresh) setTimeout(function () { load(true); }, 0);
      })
      .catch(function (e) {
        if (id === state.reqId) showError(String((e && e.message) || e));
      })
      .then(function () {
        if (id === state.reqId) setBusy(false);
      });
  }

  function save(patch, reload) {
    return Promise.resolve(dp.runtime.sendMessage({ type: "saveSettings", settings: patch }))
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || "no answer");
        state.settings = res.settings;
        renderSettings();
        return reload ? load(false) : undefined;
      })
      .catch(function (e) { showError(String((e && e.message) || e)); });
  }

  // ------------------------------------------------------------------- render

  function render() {
    var d = state.data;
    if (!d) return;
    var stats = d.stats;
    renderCoverage(d);
    renderCards(stats);
    var empty = !stats.cards.visits;
    $("empty").hidden = !empty;
    $("empty").textContent = empty ? t("empty") : "";
    $("content").hidden = empty;
    if (!empty) {
      renderTop(stats);
      renderCategories(stats);
      renderCharts(stats);
      renderSite(stats);
    }
    renderSettings();
  }

  function renderCoverage(d) {
    var box = $("coverage");
    C.clear(box);
    var s = d.sample;
    box.className = "banner" + (s.complete ? "" : " warn");
    if (!s.count) {
      C.html("p", "", t("cov_none"), box);
      return;
    }
    var line = t("cov", { n: fmt(s.count), date: fmtDate(s.oldest) });
    if (d.fromCache) line += " (" + t("cached", { time: pad(new Date(d.generatedAt).getHours()) + ":" + pad(new Date(d.generatedAt).getMinutes()) }) + ")";
    C.html("p", "", line, box);
    if (s.complete) {
      C.html("p", "", t("cov_full"), box);
    } else {
      C.html("p", "", t("cov_partial", { limit: fmt(s.callLimit), from: fmtDate(s.fullFrom) }), box);
      if (s.partialPeriod) C.html("p", "", t("cov_period"), box);
      if (s.truncatedDomains && s.truncatedDomains.length) C.html("p", "", t("cov_trunc", { n: s.truncatedDomains.length }), box);
    }
  }

  function delta(cur, prev) {
    if (prev === null || prev === undefined) return null;
    if (prev === 0) return cur === 0 ? { text: "0%", cls: "flat" } : { text: t("new_vs_zero"), cls: "up" };
    var p = Math.round(((cur - prev) / prev) * 100);
    return { text: (p > 0 ? "+" : "") + p + "%", cls: p > 0 ? "up" : p < 0 ? "down" : "flat" };
  }

  function card(parent, label, value, noteParts) {
    var el = C.html("div", "card", null, parent);
    C.html("div", "label", label, el);
    C.html("div", "value", value, el);
    var note = C.html("div", "note", null, el);
    (noteParts || []).forEach(function (part, i) {
      if (i) note.appendChild(document.createTextNode(" · "));
      C.html("span", part.cls || "", part.text, note);
    });
    return el;
  }

  function renderCards(stats) {
    var box = $("cards");
    C.clear(box);
    var c = stats.cards;
    var prev = stats.prev;
    function cmp(cur, prevVal) {
      if (!prev) return [{ text: t("na_all"), cls: "flat" }];
      var dl = delta(cur, prevVal);
      return [{ text: t("was") + " " + fmt(prevVal) }, dl];
    }
    card(box, t("c_visits"), fmt(c.visits), cmp(c.visits, prev && prev.visits));
    card(box, t("c_sites"), fmt(c.uniqueSites), cmp(c.uniqueSites, prev && prev.uniqueSites));
    card(box, t("c_hour"), c.peakHour ? pad(c.peakHour.hour) + ":00" : "—", c.peakHour ? [{ text: visitsText(c.peakHour.count) }] : []);
    card(box, t("c_day"), c.peakWeekday ? t("wd")[c.peakWeekday.weekday] : "—", c.peakWeekday ? [{ text: visitsText(c.peakWeekday.count) }] : []);
    var approx = c.newSitesApprox && c.newSites !== null;
    var newNote = c.newSites === null ? [{ text: t("na_all"), cls: "flat" }] : cmp(c.newSites, prev && prev.newSites);
    if (approx) newNote.push({ text: t("approx"), cls: "flat" });
    card(box, t("c_new"), c.newSites === null ? "—" : (approx ? "≈" : "") + fmt(c.newSites), newNote);
  }

  function renderTop(stats) {
    var items = stats.topSites.map(function (s) {
      return { key: s.domain, label: s.domain, value: s.visits, valueText: fmt(s.visits), shareText: pct(s.share), cat: s.category, avatar: true };
    });
    C.hbars($("top-sites"), items, {
      selectedKey: state.site,
      onClick: function (it) {
        state.site = state.site === it.key ? null : it.key;
        renderTop(stats);
        renderSite(stats);
        if (state.site) $("site-detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
      },
    });
  }

  function renderCategories(stats) {
    var items = stats.categories.filter(function (c) { return c.visits > 0; }).map(function (c) {
      return { key: c.id, label: t_cat(c.id), value: c.visits, valueText: fmt(c.visits), shareText: pct(c.share), cat: c.id, avatar: false };
    });
    C.hbars($("categories"), items, {});
  }

  function hourTip(h) { return pad(h) + ":00–" + pad(h) + ":59"; }

  function renderCharts(stats) {
    C.columns($("hours"), {
      values: stats.hours, every: 3, highlightMax: true,
      label: function (i) { return String(i); },
      tipLines: function (i) { return [hourTip(i), visitsText(stats.hours[i])]; },
      ariaLabel: t("by_hour"),
    });
    C.columns($("weekdays"), {
      values: stats.weekdays, every: 1, highlightMax: true,
      label: function (i) { return t("wds")[i]; },
      tipLines: function (i) { return [t("wd")[i], visitsText(stats.weekdays[i])]; },
      ariaLabel: t("by_weekday"),
    });
    C.heatmap($("heatmap"), {
      matrix: stats.heat,
      rowLabels: t("wds"),
      colLabel: function (h) { return String(h); },
      tipLines: function (r, c, v) { return [t("wd")[r] + ", " + hourTip(c), visitsText(v)]; },
      legend: { less: t("less"), more: t("more") },
      ariaLabel: t("heatmap"),
    });
    var step = stats.series.step;
    $("series-title").textContent = t(step === "hour" ? "dyn_hour" : step === "week" ? "dyn_week" : "dyn_day");
    C.area($("series"), {
      points: stats.series.points.map(function (p) {
        var d = new Date(p.start);
        var label = step === "hour" ? pad(d.getHours()) + ":00" : fmtShortDate(p.start);
        var title = step === "hour" ? fmtDateTime(p.start) : step === "week" ? t("dyn_week") + " " + fmtShortDate(p.start) : t("wd")[(d.getDay() + 6) % 7] + ", " + fmtDate(p.start);
        return { label: label, value: p.count, tipLines: [title, visitsText(p.count)] };
      }),
      ariaLabel: $("series-title").textContent,
    });
  }

  function renderSite(stats) {
    var panel = $("site-detail");
    var site = null;
    for (var i = 0; i < stats.topSites.length; i++) if (stats.topSites[i].domain === state.site) site = stats.topSites[i];
    if (!site) {
      if (state.site) state.site = null;
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    var head = $("site-head");
    C.clear(head);
    head.appendChild(C.avatar(site.domain, 34));
    var text = C.html("div", "", null, head);
    C.html("div", "name sens", site.domain, text);
    var meta = C.html("div", "meta sens", visitsText(site.visits) + " · " + t("site_share", { share: pct(site.share) }), text);
    if (site.prevVisits !== null) meta.textContent += " · " + t("prev_site", { n: fmt(site.prevVisits) });
    var sel = C.html("select", "", null, head);
    sel.setAttribute("aria-label", t("category"));
    CATS.forEach(function (c) {
      var o = C.html("option", "", t_cat(c), sel);
      o.value = c;
    });
    sel.value = site.category;
    sel.addEventListener("change", function () {
      var rules = Object.assign({}, state.settings.categories);
      rules[site.domain] = sel.value;
      save({ categories: rules }, true);
    });

    C.columns($("site-hours"), {
      values: site.hours, every: 3, highlightMax: true, height: 160,
      label: function (i) { return String(i); },
      tipLines: function (i) { return [hourTip(i), visitsText(site.hours[i])]; },
      ariaLabel: t("site_hours"),
    });
    C.columns($("site-days"), {
      values: site.weekdays, every: 1, highlightMax: true, height: 160,
      label: function (i) { return t("wds")[i]; },
      tipLines: function (i) { return [t("wd")[i], visitsText(site.weekdays[i])]; },
      ariaLabel: t("site_days"),
    });
    var list = $("site-recent");
    C.clear(list);
    (site.recent || []).forEach(function (r) {
      var li = C.html("li", "", null, list);
      C.html("span", "when", fmtDateTime(r.at), li);
      var ttl = C.html("span", "ttl", r.title, li);
      ttl.title = r.title;
    });
  }

  // ----------------------------------------------------------------- settings

  function chip(list, text, onRemove) {
    var li = C.html("li", "chip", null, list);
    C.html("span", "", text, li);
    var b = C.html("button", "", "×", li);
    b.type = "button";
    b.setAttribute("aria-label", "Remove " + text);
    b.addEventListener("click", onRemove);
  }

  function renderSettings() {
    var s = state.settings;
    var ex = $("excluded-list");
    C.clear(ex);
    s.excluded.forEach(function (d) {
      chip(ex, d, function () { save({ excluded: s.excluded.filter(function (x) { return x !== d; }) }, true); });
    });
    var rules = $("cat-rules");
    C.clear(rules);
    Object.keys(s.categories).sort().forEach(function (d) {
      chip(rules, d + " → " + t_cat(s.categories[d]), function () {
        var next = Object.assign({}, s.categories);
        delete next[d];
        save({ categories: next }, true);
      });
    });
    $("in-weekly").checked = !!s.weeklyNotify;
  }

  // -------------------------------------------------------------------- blur

  function setBlur(on) {
    document.body.classList.toggle("blur", on);
    C.setTipDisabled(on);
    updateBlurButton();
  }
  function updateBlurButton() {
    var on = document.body.classList.contains("blur");
    var b = $("btn-blur");
    b.setAttribute("aria-pressed", String(on));
    b.textContent = on ? t("show") : t("hide");
  }
  function syncBlurFromSettings() {
    if (state.settings.blur !== document.body.classList.contains("blur")) setBlur(state.settings.blur);
  }

  // --------------------------------------------------------------------- init

  function wire() {
    $("btn-refresh").addEventListener("click", function () { load(true); });
    $("btn-blur").addEventListener("click", function () {
      var on = !document.body.classList.contains("blur");
      setBlur(on);
      save({ blur: on }, false);
    });
    $("btn-settings").addEventListener("click", function () {
      var panel = $("settings-panel");
      panel.hidden = !panel.hidden;
      $("btn-settings").setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    $("btn-close-site").addEventListener("click", function () {
      state.site = null;
      if (state.data) { renderTop(state.data.stats); renderSite(state.data.stats); }
    });
    $("form-exclude").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = $("in-exclude").value.trim();
      if (!v) return;
      $("in-exclude").value = "";
      save({ excluded: state.settings.excluded.concat([v]) }, true);
    });
    $("form-cat").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = $("in-cat-domain").value.trim();
      if (!v) return;
      $("in-cat-domain").value = "";
      var rules = Object.assign({}, state.settings.categories);
      rules[v] = $("in-cat-id").value;
      save({ categories: rules }, true);
    });
    $("in-weekly").addEventListener("change", function () {
      save({ weeklyNotify: $("in-weekly").checked }, false);
    });
  }

  function init() {
    wire();
    dp.onTheme(function (info) {
      if (info && info.lang) {
        state.lang = detectLang(info.lang);
        applyI18n();
        if (state.data) render();
      }
    });
    applyI18n();
    // The "hide numbers" choice is applied before any number is on screen.
    Promise.resolve()
      .then(function () { return dp.storage.get("settings"); })
      .then(function (s) { if (s && s.blur === true) setBlur(true); })
      .catch(function () {});
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 1500); });
    Promise.race([Promise.resolve(dp.ready), timeout]).then(function () {
      applyI18n();
      return load(false);
    });
  }

  init();
})();
