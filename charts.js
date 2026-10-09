/* Habits Dashboard: tiny dependency-free chart module (SVG + DOM).
 *
 * Page CSP: no inline styles, no eval, no network. Everything is built with
 * createElement / createElementNS and textContent; colours come from CSS
 * classes in page.css (which use the browser's theme variables).
 * Only element.style.x = ... (CSSOM) is used for geometry and hashed colours.
 *
 * Global: window.Charts
 */
(function (root) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svg(name, attrs, parent) {
    var node = document.createElementNS(SVG_NS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, String(attrs[k])); });
    if (parent) parent.appendChild(node);
    return node;
  }

  function html(name, className, text, parent) {
    var node = document.createElement(name);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (parent) parent.appendChild(node);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function reducedMotion() {
    return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  // ------------------------------------------------------------------ tooltip

  var tip = null;
  var tipDisabled = false; // set while "hide numbers" is on

  function ensureTip() {
    if (tip) return tip;
    tip = html("div", "tip", "", document.body);
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    return tip;
  }

  /** lines: array of strings (first one is the title). */
  function showTip(lines, clientX, clientY) {
    if (tipDisabled) return;
    var t = ensureTip();
    clear(t);
    lines.forEach(function (line, i) {
      html("div", i === 0 ? "tip-title" : "tip-line", line, t);
    });
    t.hidden = false;
    var w = t.offsetWidth;
    var h = t.offsetHeight;
    var x = clientX + 14;
    var y = clientY - h - 12;
    if (x + w > root.innerWidth - 8) x = clientX - w - 14;
    if (x < 8) x = 8;
    if (y < 8) y = clientY + 18;
    t.style.left = x + "px";
    t.style.top = y + "px";
  }

  function hideTip() {
    if (tip) tip.hidden = true;
  }

  function showTipAtNode(lines, node) {
    var r = node.getBoundingClientRect();
    showTip(lines, r.left + r.width / 2, r.top);
  }

  // -------------------------------------------------------------------- utils

  /** A "nice" axis maximum and tick step for values in 0..max. */
  function niceScale(max, ticks) {
    if (!(max > 0)) return { max: 1, step: 1 };
    var raw = max / (ticks || 4);
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / pow;
    var step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
    if (step < 1) step = 1;
    return { max: Math.ceil(max / step) * step, step: step };
  }

  /** Redraws `draw(width)` now and whenever `el` is resized. */
  function mount(el, draw) {
    var last = -1;
    var fresh = true; // animate only the first draw after new data, not every resize
    var run = function () {
      var w = Math.max(240, Math.floor(el.clientWidth));
      if (w === last) return;
      last = w;
      hideTip();
      var animate = fresh && !reducedMotion();
      fresh = false;
      draw(w, animate);
    };
    el._chartRedraw = function () { last = -1; run(); };
    if (typeof ResizeObserver === "function") {
      if (el._chartObserver) el._chartObserver.disconnect();
      el._chartObserver = new ResizeObserver(run);
      el._chartObserver.observe(el);
    }
    run();
  }

  function hashHue(text) {
    var h = 0;
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  /** Round label with the first letter, colour from the domain hash (no favicons offline). */
  function avatar(domain, size) {
    var s = html("span", "avatar", (domain.charAt(0) || "?").toUpperCase());
    s.setAttribute("aria-hidden", "true");
    s.style.background = "hsl(" + hashHue(domain) + " 52% 44%)";
    if (size) {
      s.style.width = size + "px";
      s.style.height = size + "px";
      s.style.fontSize = Math.round(size * 0.46) + "px";
    }
    return s;
  }

  function baseSvg(container, w, h, label) {
    clear(container);
    var s = svg("svg", { width: w, height: h, viewBox: "0 0 " + w + " " + h, role: "img", "aria-label": label || "" }, container);
    s.setAttribute("class", "chart-svg");
    return s;
  }

  function yAxis(s, left, right, top, bottom, scale, format) {
    for (var v = 0; v <= scale.max + 1e-9; v += scale.step) {
      var y = bottom - (v / scale.max) * (bottom - top);
      svg("line", { x1: left, x2: right, y1: y, y2: y, class: v === 0 ? "axis" : "gridline" }, s);
      var t = svg("text", { x: left - 6, y: y + 3.5, "text-anchor": "end", class: "tick" }, s);
      t.textContent = format ? format(v) : String(v);
    }
  }

  // ----------------------------------------------------------------- columns

  /**
   * opts: { values:[], label:(i)=>string (x tick), every:int, tipLines:(i)=>[], ariaLabel, highlightMax:bool, height }
   */
  function columns(container, opts) {
    container.setAttribute("data-chart", "");
    mount(container, function (W, animate) {
      var H = opts.height || 190;
      var m = { l: 34, r: 8, t: 10, b: 24 };
      var s = baseSvg(container, W, H, opts.ariaLabel);
      var max = Math.max.apply(null, opts.values.concat([0]));
      var scale = niceScale(max, 4);
      var iw = W - m.l - m.r;
      var ih = H - m.t - m.b;
      yAxis(s, m.l, W - m.r, m.t, H - m.b, scale, opts.formatY);
      var n = opts.values.length;
      var slot = iw / n;
      var bw = Math.max(2, slot * 0.7);
      var every = opts.every || 1;
      opts.values.forEach(function (v, i) {
        var bh = scale.max ? (v / scale.max) * ih : 0;
        var x = m.l + i * slot + (slot - bw) / 2;
        var rect = svg("rect", { x: x, y: H - m.b - bh, width: bw, height: Math.max(bh, 0), rx: Math.min(3, bw / 3), class: "bar" + (opts.highlightMax && v === max && v > 0 ? " peak" : "") }, s);
        if (animate) rect.style.animationDelay = Math.min(i * 12, 300) + "ms";
        else rect.classList.add("still");
        rect.setAttribute("tabindex", "0");
        var lines = opts.tipLines(i);
        rect.setAttribute("aria-label", lines.join(", "));
        rect.addEventListener("pointermove", function (e) { showTip(lines, e.clientX, e.clientY); });
        rect.addEventListener("pointerleave", hideTip);
        rect.addEventListener("focus", function () { showTipAtNode(lines, rect); });
        rect.addEventListener("blur", hideTip);
        if (i % every === 0) {
          var t = svg("text", { x: x + bw / 2, y: H - m.b + 15, "text-anchor": "middle", class: "tick" }, s);
          t.textContent = opts.label(i);
        }
      });
    });
  }

  // ----------------------------------------------------------------- heatmap

  /**
   * opts: { matrix:[7][24], rowLabels:[7], colLabel:(h)=>string, tipLines:(r,c,v)=>[], legend:{less,more}, ariaLabel }
   */
  function heatmap(container, opts) {
    container.setAttribute("data-chart", "");
    mount(container, function (W, animate) {
      var rows = opts.matrix.length;
      var cols = opts.matrix[0].length;
      var m = { l: 34, r: 4, t: 4, b: 40 };
      var cell = (W - m.l - m.r) / cols;
      var ch = Math.max(14, Math.min(cell, 30));
      var H = m.t + rows * ch + m.b;
      var s = baseSvg(container, W, H, opts.ariaLabel);
      var max = 0;
      opts.matrix.forEach(function (row) { row.forEach(function (v) { if (v > max) max = v; }); });
      opts.matrix.forEach(function (row, r) {
        var lt = svg("text", { x: m.l - 6, y: m.t + r * ch + ch / 2 + 3.5, "text-anchor": "end", class: "tick" }, s);
        lt.textContent = opts.rowLabels[r];
        row.forEach(function (v, c) {
          var rect = svg("rect", {
            x: m.l + c * cell + 1, y: m.t + r * ch + 1, width: Math.max(cell - 2, 1), height: ch - 2, rx: 3,
            class: v ? "heat" : "heat zero",
          }, s);
          if (v) {
            rect.setAttribute("fill-opacity", (0.14 + 0.86 * (v / max)).toFixed(3));
            if (animate) rect.style.animationDelay = Math.min((r * 24 + c) * 3, 500) + "ms";
            else rect.classList.add("still");
          }
          var lines = opts.tipLines(r, c, v);
          rect.addEventListener("pointermove", function (e) { showTip(lines, e.clientX, e.clientY); });
          rect.addEventListener("pointerleave", hideTip);
        });
      });
      for (var c = 0; c < cols; c += 3) {
        var ct = svg("text", { x: m.l + c * cell + cell / 2, y: m.t + rows * ch + 14, "text-anchor": "middle", class: "tick" }, s);
        ct.textContent = opts.colLabel(c);
      }
      if (opts.legend) {
        var ly = m.t + rows * ch + 24;
        var lx = W - m.r - 5 * 14 - 48;
        var lessT = svg("text", { x: lx - 6, y: ly + 8, "text-anchor": "end", class: "tick" }, s);
        lessT.textContent = opts.legend.less;
        for (var i = 0; i < 5; i++) {
          svg("rect", { x: lx + i * 14, y: ly, width: 12, height: 10, rx: 2, class: "heat", "fill-opacity": (0.14 + 0.86 * (i / 4)).toFixed(2) }, s);
        }
        var moreT = svg("text", { x: lx + 5 * 14 + 2, y: ly + 8, "text-anchor": "start", class: "tick" }, s);
        moreT.textContent = opts.legend.more;
      }
    });
  }

  // -------------------------------------------------------------------- area

  /**
   * opts: { points:[{label, value, tipLines:[]}], ariaLabel, height }
   */
  function area(container, opts) {
    container.setAttribute("data-chart", "");
    mount(container, function (W, animate) {
      var H = opts.height || 210;
      var m = { l: 34, r: 12, t: 10, b: 26 };
      var s = baseSvg(container, W, H, opts.ariaLabel);
      var pts = opts.points;
      var n = pts.length;
      var max = Math.max.apply(null, pts.map(function (p) { return p.value; }).concat([0]));
      var scale = niceScale(max, 4);
      var iw = W - m.l - m.r;
      var ih = H - m.t - m.b;
      yAxis(s, m.l, W - m.r, m.t, H - m.b, scale, opts.formatY);
      if (!n) return;
      var xs = pts.map(function (p, i) { return n === 1 ? m.l + iw / 2 : m.l + (i / (n - 1)) * iw; });
      var ys = pts.map(function (p) { return H - m.b - (scale.max ? (p.value / scale.max) * ih : 0); });

      var defs = svg("defs", null, s);
      var gid = "g" + Math.random().toString(36).slice(2, 8);
      var grad = svg("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      svg("stop", { offset: "0%", class: "stop-top" }, grad);
      svg("stop", { offset: "100%", class: "stop-bottom" }, grad);

      if (n > 1) {
        var line = "M" + xs[0].toFixed(1) + " " + ys[0].toFixed(1);
        for (var i = 1; i < n; i++) line += " L" + xs[i].toFixed(1) + " " + ys[i].toFixed(1);
        var fillPath = line + " L" + xs[n - 1].toFixed(1) + " " + (H - m.b) + " L" + xs[0].toFixed(1) + " " + (H - m.b) + " Z";
        var a = svg("path", { d: fillPath, fill: "url(#" + gid + ")", class: "area-fill" }, s);
        if (!animate) a.classList.add("still");
        var l = svg("path", { d: line, class: "area-line", pathLength: 1 }, s);
        if (!animate) l.classList.add("still");
      }
      xs.forEach(function (x, i) {
        svg("circle", { cx: x, cy: ys[i], r: n > 60 ? 0 : n === 1 ? 4 : 2.5, class: "area-dot" }, s);
      });

      var labelCount = Math.min(n, Math.max(2, Math.floor(iw / 80)));
      for (var k = 0; k < labelCount; k++) {
        var idx = labelCount === 1 ? 0 : Math.round((k / (labelCount - 1)) * (n - 1));
        var t = svg("text", { x: xs[idx], y: H - m.b + 16, "text-anchor": k === 0 ? "start" : k === labelCount - 1 ? "end" : "middle", class: "tick" }, s);
        t.textContent = pts[idx].label;
      }

      var guide = svg("line", { y1: m.t, y2: H - m.b, class: "guide" }, s);
      guide.style.display = "none";
      var hot = svg("circle", { r: 5, class: "area-hot" }, s);
      hot.style.display = "none";
      var overlay = svg("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, s);
      overlay.addEventListener("pointermove", function (e) {
        var box = s.getBoundingClientRect();
        var px = e.clientX - box.left;
        var best = 0;
        var bestD = Infinity;
        for (var j = 0; j < n; j++) {
          var dd = Math.abs(xs[j] - px);
          if (dd < bestD) { bestD = dd; best = j; }
        }
        guide.setAttribute("x1", xs[best]);
        guide.setAttribute("x2", xs[best]);
        guide.style.display = "";
        hot.setAttribute("cx", xs[best]);
        hot.setAttribute("cy", ys[best]);
        hot.style.display = "";
        showTip(pts[best].tipLines, e.clientX, e.clientY);
      });
      overlay.addEventListener("pointerleave", function () {
        guide.style.display = "none";
        hot.style.display = "none";
        hideTip();
      });
    });
  }

  // ------------------------------------------------------------------- hbars

  /**
   * Horizontal bars as DOM rows.
   * items: [{ key, label, value, valueText, shareText, cat, avatar:bool }]
   * opts: { onClick(item), selectedKey }
   */
  function hbars(container, items, opts) {
    clear(container);
    opts = opts || {};
    var max = items.reduce(function (m, it) { return it.value > m ? it.value : m; }, 0);
    var animate = !reducedMotion();
    items.forEach(function (it, i) {
      var row = html("div", "hrow" + (opts.selectedKey === it.key ? " selected" : ""));
      if (opts.onClick) {
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        row.addEventListener("click", function () { opts.onClick(it); });
        row.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onClick(it); }
        });
      }
      if (it.avatar) row.appendChild(avatar(it.label, 26));
      var main = html("div", "hmain", null, row);
      var top = html("div", "htop", null, main);
      html("span", "hlabel sens", it.label, top);
      var vals = html("span", "hvals sens", null, top);
      html("b", "", it.valueText, vals);
      if (it.shareText) html("span", "hshare", it.shareText, vals);
      var track = html("div", "htrack", null, main);
      var fill = html("div", "hfill" + (it.cat ? " cat-" + it.cat : ""), null, track);
      fill.style.width = (max ? Math.max(2, (it.value / max) * 100) : 0) + "%";
      if (animate) fill.style.animationDelay = Math.min(i * 40, 400) + "ms";
      else fill.classList.add("still");
      container.appendChild(row);
    });
  }

  root.Charts = {
    columns: columns,
    heatmap: heatmap,
    area: area,
    hbars: hbars,
    avatar: avatar,
    hideTip: hideTip,
    setTipDisabled: function (v) { tipDisabled = !!v; if (v) hideTip(); },
    html: html,
    clear: clear,
  };
})(typeof window !== "undefined" ? window : this);
