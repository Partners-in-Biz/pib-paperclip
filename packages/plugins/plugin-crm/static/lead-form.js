/*! PiB lead form (Partners in Biz CRM): the page inside the iframe lead.js adds.
 *
 * Reads its settings from the address fragment, shows the form, and posts one
 * JSON request to the CRM's public lead endpoint on this same host. The server
 * checks everything again; the checks here are only for the visitor's comfort.
 */
(function () {
  "use strict";

  var API = "/api/plugins/partnersinbiz.crm/webhooks/lead";
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
  var DEFAULT_CONSENT = "Yes, you may email me news and offers. I can unsubscribe at any time.";
  var DEFAULT_SUCCESS = "Thank you. We have your message and will be in touch soon.";
  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
  var KNOWN_FIELDS = ["name", "email", "phone", "company", "message"];

  /** The settings in the address fragment (`#k=pibl_...&c=...`). Unknown names are ignored. */
  function parseHash(hash) {
    var out = {};
    var text = String(hash || "").replace(/^#/, "");
    var pairs = text ? text.split("&") : [];
    for (var i = 0; i < pairs.length; i += 1) {
      var at = pairs[i].indexOf("=");
      if (at < 1) continue;
      try {
        out[pairs[i].slice(0, at)] = decodeURIComponent(pairs[i].slice(at + 1).replace(/\+/g, " "));
      } catch (error) {
        // a malformed value is skipped
      }
    }
    var fields = [];
    var wanted = (out.f || "name,email,message").split(",");
    for (var j = 0; j < wanted.length; j += 1) {
      var field = wanted[j].trim();
      if (KNOWN_FIELDS.indexOf(field) >= 0 && fields.indexOf(field) < 0) fields.push(field);
    }
    if (fields.indexOf("email") < 0) fields.splice(1, 0, "email");
    var utm = {};
    for (var k = 0; k < UTM_KEYS.length; k += 1) if (out[UTM_KEYS[k]]) utm[UTM_KEYS[k]] = out[UTM_KEYS[k]];
    return {
      key: out.k || "",
      consentText: out.c || DEFAULT_CONSENT,
      privacyUrl: /^https?:\/\//i.test(out.p || "") ? out.p : "",
      successText: out.s || DEFAULT_SUCCESS,
      turnstile: out.t || "",
      accent: /^#[0-9a-f]{6}$/i.test(out.a || "") ? out.a : "",
      fields: fields,
      pageUrl: out.pg || "",
      referrer: out.r || "",
      landingUrl: out.l || "",
      utm: utm,
    };
  }

  /** What the visitor must fix before sending: field name -> message. Empty when it is fine to send. */
  function validate(values, config) {
    var errors = {};
    var email = String(values.email || "").trim();
    if (!email) errors.email = "Please enter your email address.";
    else if (!EMAIL_RE.test(email) || email.length > 254) errors.email = "That email address does not look right.";
    if (config.fields.indexOf("name") >= 0 && !String(values.name || "").trim()) errors.name = "Please tell us your name.";
    if (config.turnstile && !values.turnstileToken) errors.turnstile = "Please complete the spam check.";
    return errors;
  }

  /** The request body for the endpoint. `elapsed` is how long the form was open, in milliseconds. */
  function buildPayload(values, config, elapsed) {
    var payload = {
      key: config.key,
      email: String(values.email || "").trim(),
      consent: values.consent === true,
      consentText: values.consent === true ? config.consentText : "",
      pageUrl: config.pageUrl,
      referrer: config.referrer,
      landingUrl: config.landingUrl,
      utm: config.utm,
      hp_website: String(values.hp_website || ""),
      t: Math.max(0, Math.round(elapsed)),
      turnstileToken: values.turnstileToken || "",
    };
    for (var i = 0; i < config.fields.length; i += 1) {
      var field = config.fields[i];
      if (field !== "email" && values[field]) payload[field] = String(values[field]).trim();
    }
    return payload;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseHash: parseHash, validate: validate, buildPayload: buildPayload, EMAIL_RE: EMAIL_RE };
  }
  if (typeof document === "undefined" || !document.getElementById) return;

  var config = parseHash(window.location.hash);
  var form = document.getElementById("f");
  var done = document.getElementById("done");
  var startedAt = Date.now();
  var state = { turnstileToken: "", sending: false };
  var LABELS = { name: "Your name", email: "Email address", phone: "Phone (optional)", company: "Company (optional)", message: "How can we help?" };

  function post(type, extra) {
    try {
      var message = { source: "pib-lead", type: type, height: document.documentElement.scrollHeight };
      if (extra) for (var name in extra) if (Object.prototype.hasOwnProperty.call(extra, name)) message[name] = extra[name];
      window.parent.postMessage(message, "*");
    } catch (error) {
      // not in a frame
    }
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var name in attrs || {}) {
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
      if (name === "text") node.textContent = attrs[name];
      else node.setAttribute(name, attrs[name]);
    }
    for (var i = 0; i < (children || []).length; i += 1) node.appendChild(children[i]);
    return node;
  }

  function build() {
    if (config.accent) document.documentElement.style.setProperty("--accent", config.accent);
    if (!config.key) {
      form.appendChild(el("p", { class: "err", text: "This form is not set up: the snippet is missing its key." }));
      return;
    }
    config.fields.forEach(function (field) {
      var id = "f-" + field;
      var multiline = field === "message";
      var input = el(multiline ? "textarea" : "input", Object.assign({ id: id, name: field, autocomplete: field === "email" ? "email" : field === "phone" ? "tel" : field === "name" ? "name" : "off" }, multiline ? { rows: "4", maxlength: "2000" } : { type: field === "email" ? "email" : field === "phone" ? "tel" : "text", maxlength: field === "email" ? "254" : "160" }));
      if (field === "email" || field === "name") input.setAttribute("required", "");
      form.appendChild(el("div", { class: "row" }, [el("label", { for: id, text: LABELS[field] }), input, el("p", { class: "err", id: id + "-err", role: "alert" })]));
    });
    // The honeypot: people never see it, scripts fill it in.
    form.appendChild(el("div", { class: "hp", "aria-hidden": "true" }, [el("input", { type: "text", name: "hp_website", tabindex: "-1", autocomplete: "off" })]));
    form.appendChild(el("label", { class: "consent" }, [el("input", { type: "checkbox", name: "consent", id: "f-consent" }), el("span", { text: config.consentText })]));
    if (config.privacyUrl) form.appendChild(el("p", { class: "small" }, [el("a", { href: config.privacyUrl, target: "_blank", rel: "noreferrer noopener", text: "Privacy policy" })]));
    if (config.turnstile) form.appendChild(el("div", { id: "turnstile", class: "row" }, [el("p", { class: "err", id: "turnstile-err", role: "alert" })]));
    form.appendChild(el("button", { type: "submit", id: "send", text: "Send" }));
    form.appendChild(el("p", { class: "err", id: "form-err", role: "alert" }));
    if (config.turnstile) loadTurnstile();
  }

  function loadTurnstile() {
    var tag = document.createElement("script");
    tag.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    tag.async = true;
    tag.onload = function () {
      if (!window.turnstile) return;
      window.turnstile.render("#turnstile", {
        sitekey: config.turnstile,
        callback: function (token) { state.turnstileToken = token; },
        "expired-callback": function () { state.turnstileToken = ""; },
        "error-callback": function () { state.turnstileToken = ""; },
      });
      post("resize");
    };
    document.head.appendChild(tag);
  }

  function values() {
    var out = {};
    var data = new FormData(form);
    data.forEach(function (value, name) { out[name] = value; });
    out.consent = document.getElementById("f-consent").checked === true;
    out.turnstileToken = state.turnstileToken;
    return out;
  }

  /** The line under a field where its message goes. */
  function errorSlot(field) {
    return document.getElementById(field === "turnstile" ? "turnstile-err" : "f-" + field + "-err");
  }

  function showErrors(errors) {
    config.fields.concat(["turnstile"]).forEach(function (field) {
      var slot = errorSlot(field);
      if (slot) slot.textContent = errors[field] || "";
    });
  }

  function fail(message) {
    document.getElementById("form-err").textContent = message;
    document.getElementById("send").disabled = false;
    state.sending = false;
    post("resize");
  }

  function submit(event) {
    event.preventDefault();
    if (state.sending) return;
    var current = values();
    var errors = validate(current, config);
    showErrors(errors);
    document.getElementById("form-err").textContent = "";
    if (Object.keys(errors).length) return post("resize");
    state.sending = true;
    document.getElementById("send").disabled = true;
    fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildPayload(current, config, Date.now() - startedAt)) })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) { return { ok: response.ok, body: body }; });
      })
      .then(function (result) {
        if (result.ok) {
          form.hidden = true;
          done.hidden = false;
          done.textContent = config.successText;
          post("submitted");
          post("resize");
          return;
        }
        var text = result.body && typeof result.body.error === "string" && result.body.error.length <= 200 ? result.body.error : "";
        fail(text || "We could not send that. Please try again in a moment.");
      })
      .catch(function () { fail("We could not send that. Check your connection and try again."); });
  }

  build();
  form.addEventListener("submit", submit);
  post("resize");
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(function () { post("resize"); }).observe(document.body);
})();
