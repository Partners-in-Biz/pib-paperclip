/*! PiB site events (Partners in Biz CRM), under 2 KB minified. Counts page views, clicks to other sites and a few named
 * actions; sends no name, email, phone, form content or visitor id. Put in the head of every page:
 *   <script async src=".../ev.js" data-pib-ev="pibe_..." [data-consent="required"]></script>
 * It does nothing when the browser says Do Not Track or Global Privacy Control. With data-consent="required" it sends nothing until
 * the site's own cookie banner calls pibEvents.consent(true), which also lets it remember the first and last campaign for 90 days.
 * The events go through a hidden frame on the Paperclip host (same origin as the endpoint, so no CORS).
 * pibEvents.track("name") records an action of your own.
 */
(function (w, d, n, L) {
  var s = d.currentScript, k = s && s.getAttribute("data-pib-ev"), V = "pib_v", F = "pib_ft", T = "pib_lt";
  if (!/^pibe_[a-z2-7]{24}$/.test(k || "") || n.doNotTrack == "1" || n.globalPrivacyControl) return;
  var base = s.src.replace(/ev\.js(\?.*)?$/, ""), need = s.getAttribute("data-consent") == "required", go = !need, q = [], f, ready, vis, ent, ft, lt, ok;
  function get(a, b) { try { return JSON.parse(a.getItem(b)) } catch (e) {} }
  function put(a, b, v) { try { a.setItem(b, JSON.stringify(v)) } catch (e) {} }
  function qp(x) { return new URLSearchParams(L.search).get(x) || "" }
  function flush() {
    if (!go || !q.length || !d.body) return;
    if (!f) {
      f = d.createElement("iframe");
      f.src = base + "ev-frame.html#k=" + k;
      f.hidden = 1;
      f.onload = function () { ready = 1; flush() };
      d.body.appendChild(f);
    }
    // The first and last touch (only once the visitor's consent is given) go on every event at the moment it is handed over.
    if (ready) f.contentWindow.postMessage({ pibEv: 1, ev: q.splice(0, 10).map(function (e) { if (ft) { e.ft = ft; e.lt = lt } return e }) }, new URL(base).origin);
  }
  function send(t, nm) {
    var e = { t: t, p: L.pathname, v: vis };
    if (nm) e.n = nm;
    if (ent && t == "pv") e.e = 1;
    if (q.length < 20) q.push(e);
    flush();
  }
  function keep() {
    if (!ok) return;
    ft = get(localStorage, F);
    lt = get(localStorage, T);
    if (ent) {
      if (!ft) put(localStorage, F, ft = vis);
      if (!lt || vis.s || vis.m || vis.c || vis.r || vis.k) put(localStorage, T, lt = vis);
    }
  }
  vis = get(sessionStorage, V);
  if (!vis) {
    ent = 1;
    try { vis = new URL(d.referrer).hostname } catch (e) { vis = "" }
    vis = { s: qp("utm_source"), m: qp("utm_medium"), c: qp("utm_campaign"), r: vis, k: qp("gclid") ? "g" : qp("msclkid") ? "m" : qp("fbclid") ? "f" : "" };
    put(sessionStorage, V, vis);
  }
  w.pibEvents = {
    track: function (nm) { send("cv", nm) },
    consent: function (yes) {
      ok = !!yes;
      if (ok) { go = 1; keep(); flush() }
      else { try { localStorage.removeItem(F); localStorage.removeItem(T) } catch (e) {} ft = lt = 0; if (need) { go = 0; q.length = 0 } }
    }
  };
  d.addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest("a[href]"), h, u;
    if (!a) return;
    h = a.getAttribute("href") || "";
    if (/^tel:/i.test(h)) send("cv", "call_clicked");
    else if (/^whatsapp:|^https?:\/\/(wa\.me|api\.whatsapp\.com)\//i.test(h)) send("cv", "whatsapp_clicked");
    else if (/^https?:/i.test(h)) { try { u = new URL(h, L.href).hostname } catch (e) {} if (u && u != L.hostname) send("out", u) }
  }, 1);
  d.addEventListener("submit", function () { send("cv", "form_submitted") }, 1);
  d.addEventListener("DOMContentLoaded", flush);
  send("pv");
})(window, document, navigator, location);
