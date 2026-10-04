/*! PiB signing page (Partners in Biz CRM): the script every signing page loads.
 *
 * The page is a static file the CRM wrote for one document (see esign-link.ts). The facts this script needs are in
 * `data-` attributes on <main id="sign">: the page id, the SHA-256 of the document text and of the consent wording. The
 * private token is the address fragment of the link (#pibt_...): a fragment is never sent to a server, and it is only sent
 * from here, in the body of the sign or decline request, to the CRM's public endpoint on this same host.
 *
 * What it does: tells the CRM the page was opened, enables Sign once there is a name and a tick, posts the signature, and
 * shows the answer. Everything it shows from the server is text (textContent), never markup.
 */
(function () {
  "use strict";

  var API = "/api/plugins/partnersinbiz.crm/webhooks/sign";
  var TOKEN_RE = /^pibt_[a-z2-7]{40}$/;

  /** The token in the address fragment, or "" when the link is incomplete. */
  function readToken(hash) {
    var text = String(hash || "").replace(/^#/, "");
    return TOKEN_RE.test(text) ? text : "";
  }

  /** The facts the page was written with. */
  function readFacts(root) {
    return {
      pageId: root.getAttribute("data-page") || "",
      docSha256: root.getAttribute("data-sha") || "",
      consentSha256: root.getAttribute("data-consent-sha") || "",
      state: root.getAttribute("data-state") || "",
    };
  }

  /** The request body for a signature. `elapsed` is how long the page has been open, in milliseconds. */
  function buildSign(facts, token, typedName, elapsed) {
    return {
      action: "sign",
      pageId: facts.pageId,
      token: token,
      typedName: String(typedName || "").trim(),
      consent: true,
      docSha256: facts.docSha256,
      consentSha256: facts.consentSha256,
      t: Math.max(0, Math.round(elapsed)),
    };
  }

  function buildDecline(facts, token, reason) {
    return { action: "decline", pageId: facts.pageId, token: token, reason: String(reason || "").trim().slice(0, 500) };
  }

  /** Whether Sign may be pressed: a name, and the box ticked. */
  function canSign(typedName, ticked) {
    return String(typedName || "").trim().length >= 2 && ticked === true;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { readToken: readToken, readFacts: readFacts, buildSign: buildSign, buildDecline: buildDecline, canSign: canSign };
  }
  if (typeof document === "undefined" || !document.getElementById) return;

  var root = document.getElementById("sign");
  if (!root) return;
  var facts = readFacts(root);
  var printButton = document.getElementById("print-button");
  if (printButton) {
    printButton.addEventListener("click", function () {
      window.print();
    });
  }
  if (facts.state !== "open") return;

  var token = readToken(window.location.hash);
  var openedAt = Date.now();
  var nameInput = document.getElementById("name");
  var consentBox = document.getElementById("consent");
  var signButton = document.getElementById("sign-button");
  var declineButton = document.getElementById("decline-button");
  var message = document.getElementById("msg");
  var done = document.getElementById("done");
  var box = document.getElementById("sign-box");
  var busy = false;

  function say(text, kind) {
    message.textContent = text;
    message.className = "msg" + (kind ? " " + kind : "");
  }

  function send(payload) {
    return fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          return { ok: response.ok, body: body };
        });
    });
  }

  function problem(result) {
    var text = result && result.body && typeof result.body.error === "string" && result.body.error.length <= 200 ? result.body.error : "";
    return text || "We could not save that. Please try again in a moment.";
  }

  function refresh() {
    signButton.disabled = busy || !token || !canSign(nameInput.value, consentBox.checked);
  }

  // Tell the CRM the page was opened. The answer is not needed, and a failure must never get in the way of reading.
  send({ action: "view", pageId: facts.pageId }).catch(function () {});

  if (!token) {
    var link = document.getElementById("link-problem");
    if (link) link.hidden = false;
    signButton.disabled = true;
    declineButton.disabled = true;
    return;
  }

  nameInput.addEventListener("input", refresh);
  consentBox.addEventListener("change", refresh);

  signButton.addEventListener("click", function () {
    if (busy || !canSign(nameInput.value, consentBox.checked)) return;
    busy = true;
    refresh();
    say("Saving your signature...", "");
    send(buildSign(facts, token, nameInput.value, Date.now() - openedAt))
      .then(function (result) {
        if (result.ok) {
          box.hidden = true;
          done.hidden = false;
          done.textContent = "Thank you. Your signature was saved. This page now shows your signed copy.";
          // The CRM has written the signed page: show it.
          setTimeout(function () {
            window.location.reload();
          }, 1500);
          return;
        }
        busy = false;
        say(problem(result), "bad");
        refresh();
      })
      .catch(function () {
        busy = false;
        say("We could not reach the server. Check your connection and try again.", "bad");
        refresh();
      });
  });

  declineButton.addEventListener("click", function () {
    if (busy) return;
    if (typeof window.confirm === "function" && !window.confirm("Decline this document? Nothing will be signed.")) return;
    busy = true;
    refresh();
    send(buildDecline(facts, token, ""))
      .then(function (result) {
        if (result.ok) {
          window.location.reload();
          return;
        }
        busy = false;
        say(problem(result), "bad");
        refresh();
      })
      .catch(function () {
        busy = false;
        say("We could not reach the server. Check your connection and try again.", "bad");
        refresh();
      });
  });

  refresh();
})();
