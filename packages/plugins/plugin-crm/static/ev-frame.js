/*! PiB site events frame (Partners in Biz CRM): the page inside the hidden iframe ev.js adds.
 *
 * Takes the events the site's script hands it with postMessage and posts them, as one small JSON request, to the CRM's public
 * events endpoint on this same host (so no CORS). It reads the site's write key from its own address fragment, accepts messages
 * only from the page that embeds it, and forwards nothing but the fields the endpoint reads. The server checks everything again.
 */
(function () {
  "use strict";

  var API = "/api/plugins/partnersinbiz.crm/webhooks/ev";
  var KEY_RE = /^pibe_[a-z2-7]{24}$/;
  var MAX_EVENTS = 10;

  /** The write key in the address fragment (`#k=pibe_...`), or "". */
  function readKey(hash) {
    var m = /^#k=([a-z0-9_]+)$/.exec(String(hash || ""));
    return m && KEY_RE.test(m[1]) ? m[1] : "";
  }

  function str(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
  }

  function touch(value) {
    if (!value || typeof value !== "object") return undefined;
    return { s: str(value.s, 60), m: str(value.m, 60), c: str(value.c, 60), r: str(value.r, 100), k: value.k === "g" || value.k === "m" || value.k === "f" ? value.k : "" };
  }

  /** Cuts one event to the fields the endpoint reads. Anything else the page sent is dropped here. */
  function clean(event) {
    if (!event || typeof event !== "object") return null;
    if (event.t !== "pv" && event.t !== "out" && event.t !== "cv") return null;
    var out = { t: event.t, p: str(event.p, 120) };
    if (event.n) out.n = str(event.n, 100);
    if (event.e === 1) out.e = 1;
    var v = touch(event.v);
    if (v) out.v = v;
    var ft = touch(event.ft);
    var lt = touch(event.lt);
    if (ft) out.ft = ft;
    if (lt) out.lt = lt;
    return out;
  }

  /** The request body for a batch from the embedding page. `origin` is the embedding page's origin, taken from the message itself. */
  function buildBody(key, origin, events) {
    var list = [];
    for (var i = 0; i < events.length && list.length < MAX_EVENTS; i += 1) {
      var item = clean(events[i]);
      if (item) list.push(item);
    }
    return { k: key, o: str(origin, 200), ev: list };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { readKey: readKey, clean: clean, buildBody: buildBody };
  }
  if (typeof window === "undefined" || !window.addEventListener || !window.location) return;

  var key = readKey(window.location.hash);
  if (!key) return;

  window.addEventListener("message", function (event) {
    // Only the page that embeds this frame may hand it events.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.pibEv !== 1 || !Array.isArray(data.ev)) return;
    var body = buildBody(key, event.origin, data.ev);
    if (body.ev.length === 0) return;
    try {
      fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true, credentials: "omit" }).catch(function () {});
    } catch (error) {
      // a failed count is never worth an error on the client's page
    }
  });
})();
