/*! PiB lead form loader (Partners in Biz CRM).
 *
 * Put this where the form should appear:
 *   <script async src=".../lead.js" data-pib-lead="pibl_..."></script>
 *
 * It adds an iframe with the form, which lives on the Paperclip host (so it can
 * post to the lead endpoint without CORS), and hands it the page address, the
 * referrer and the UTM tags so the lead says where it came from. Nothing is
 * stored on the visitor's device except, for the visit only, the first page and
 * campaign tags (sessionStorage), so a form on a later page still knows them.
 *
 * Options (attributes on the script tag): data-consent, data-privacy,
 * data-success, data-turnstile, data-accent (#RRGGBB), data-target (a CSS
 * selector to put the form into instead of next to the script), data-title.
 */
(function () {
  "use strict";

  var STORE_KEY = "pib_lead_touch";
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];

  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName("script");
    script = all[all.length - 1];
  }
  var key = script && script.getAttribute("data-pib-lead");
  if (!key || !/^pibl_[a-z2-7]{24}$/.test(key)) return;
  var base = (script.getAttribute("src") || "").replace(/lead\.js(\?.*)?$/, "");

  function clip(value, max) {
    return String(value == null ? "" : value).slice(0, max);
  }

  /** An address without its fragment, capped. */
  function clean(url) {
    return clip(String(url || "").split("#")[0], 500);
  }

  function parseQuery(search) {
    var out = {};
    var text = String(search || "").replace(/^\?/, "");
    if (!text) return out;
    var pairs = text.split("&");
    for (var i = 0; i < pairs.length; i += 1) {
      var at = pairs[i].indexOf("=");
      var name = at < 0 ? pairs[i] : pairs[i].slice(0, at);
      var raw = at < 0 ? "" : pairs[i].slice(at + 1);
      try {
        out[decodeURIComponent(name)] = decodeURIComponent(raw.replace(/\+/g, " "));
      } catch (error) {
        // a malformed value is skipped
      }
    }
    return out;
  }

  function readTouch() {
    try {
      var raw = window.sessionStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function writeTouch(touch) {
    try {
      window.sessionStorage.setItem(STORE_KEY, JSON.stringify(touch));
    } catch (error) {
      // storage blocked: the form still gets this page's own values
    }
  }

  /** This page's campaign tags and referrer, with the first page of the visit when there is one. */
  function collect() {
    var query = parseQuery(window.location.search);
    var tags = {};
    var found = false;
    for (var i = 0; i < UTM_KEYS.length; i += 1) {
      if (query[UTM_KEYS[i]]) {
        tags[UTM_KEYS[i]] = clip(query[UTM_KEYS[i]], 120);
        found = true;
      }
    }
    var stored = readTouch();
    var page = clean(window.location.href);
    var touch;
    // The first touch of the visit wins, unless it had no campaign tags and this page has some.
    if (stored && !(found && !Object.keys(stored.utm || {}).length)) {
      touch = stored;
    } else {
      touch = { utm: tags, landing: page, referrer: clean(document.referrer) };
      writeTouch(touch);
    }
    return { utm: touch.utm || {}, page: page, referrer: touch.referrer || "", landing: touch.landing || page };
  }

  /**
   * The first and last campaign touch the site events script (ev.js) remembered across visits. It stores them only when the site's own
   * cookie banner allowed it, so there is something here only for a visitor who agreed. Nothing is read from anywhere else.
   */
  function remembered(name) {
    try {
      var raw = window.localStorage.getItem(name);
      var value = raw ? JSON.parse(raw) : null;
      if (!value || typeof value !== "object") return null;
      return { s: clip(value.s, 60), m: clip(value.m, 60), c: clip(value.c, 60), r: clip(value.r, 100), k: value.k === "g" || value.k === "m" || value.k === "f" ? value.k : "" };
    } catch (error) {
      return null;
    }
  }

  function option(name, max) {
    var value = script.getAttribute("data-" + name);
    return value ? clip(value, max) : "";
  }

  function frameSrc(context) {
    var parts = ["k=" + encodeURIComponent(key)];
    var map = { c: option("consent", 500), p: option("privacy", 300), s: option("success", 200), t: option("turnstile", 100), a: option("accent", 7), f: option("fields", 80) };
    for (var name in map) {
      if (Object.prototype.hasOwnProperty.call(map, name) && map[name]) parts.push(name + "=" + encodeURIComponent(map[name]));
    }
    parts.push("pg=" + encodeURIComponent(context.page));
    if (context.referrer) parts.push("r=" + encodeURIComponent(context.referrer));
    if (context.landing && context.landing !== context.page) parts.push("l=" + encodeURIComponent(context.landing));
    for (var i = 0; i < UTM_KEYS.length; i += 1) {
      if (context.utm[UTM_KEYS[i]]) parts.push(UTM_KEYS[i] + "=" + encodeURIComponent(context.utm[UTM_KEYS[i]]));
    }
    var first = remembered("pib_ft");
    var last = remembered("pib_lt");
    if (first) parts.push("ft=" + encodeURIComponent(JSON.stringify(first)));
    if (last) parts.push("lt=" + encodeURIComponent(JSON.stringify(last)));
    return base + "lead-form.html#" + parts.join("&");
  }

  var context = collect();
  var frame = document.createElement("iframe");
  frame.src = frameSrc(context);
  frame.title = option("title", 80) || "Contact form";
  frame.setAttribute("scrolling", "no");
  frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  frame.style.cssText = "width:100%;border:0;display:block;min-height:360px;max-width:640px";

  var selector = script.getAttribute("data-target");
  var target = selector ? document.querySelector(selector) : null;
  if (target) target.appendChild(frame);
  else if (script.parentNode) script.parentNode.insertBefore(frame, script.nextSibling);

  window.addEventListener("message", function (event) {
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.source !== "pib-lead") return;
    if (data.type === "resize" && typeof data.height === "number" && isFinite(data.height)) {
      frame.style.height = Math.min(Math.max(Math.round(data.height), 120), 2000) + "px";
    }
    if (data.type === "submitted") {
      try {
        window.dispatchEvent(new CustomEvent("pib-lead-submitted", { detail: { form: key } }));
      } catch (error) {
        // old browsers: no event
      }
    }
  });
})();
