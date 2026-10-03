import { describe, expect, it } from "vitest";
import { loadFormPage, settle } from "./helpers/mini-dom.js";

const KEY = "pibl_abcdefghijklmnopqrstuvwx";
const hash = (extra = "") => `#k=${KEY}&c=${encodeURIComponent("Yes, Acme may email me.")}&p=${encodeURIComponent("https://acme.co.za/privacy")}&a=%230a7a3d&f=name,email,phone,message&pg=${encodeURIComponent("https://acme.co.za/contact")}&utm_source=google${extra}`;
const sent = (world: ReturnType<typeof loadFormPage>) => JSON.parse((world.fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body) as Record<string, any>;

describe("the form page as a visitor sees it", () => {
  it("shows the asked-for fields, a honeypot nobody sees, the consent box with its wording, the privacy link and a Send button", () => {
    const page = loadFormPage(hash());
    const names = page.form.findAll((node) => Boolean(node.attrs.name)).map((node) => node.attrs.name);
    expect(names).toEqual(["name", "email", "phone", "message", "hp_website", "consent"]);
    expect(page.byName("email").attrs).toMatchObject({ type: "email", autocomplete: "email", required: "", maxlength: "254" });
    expect(page.byName("name").attrs).toMatchObject({ required: "", autocomplete: "name" });
    expect(page.byName("phone").attrs).toMatchObject({ type: "tel" });
    expect(page.byName("message").tag).toBe("textarea");
    const labels = page.form.findAll((node) => node.tag === "label" && Boolean(node.attrs.for)).map((node) => [node.attrs.for, node.textContent]);
    expect(labels).toEqual([["f-name", "Your name"], ["f-email", "Email address"], ["f-phone", "Phone (optional)"], ["f-message", "How can we help?"]]);
    // The honeypot sits in a container that is hidden from people and from screen readers.
    const honeypot = page.form.find((node) => node.attrs.class === "hp")!;
    expect(honeypot.attrs["aria-hidden"]).toBe("true");
    expect(honeypot.children[0]!.attrs).toMatchObject({ name: "hp_website", tabindex: "-1", autocomplete: "off" });
    // The consent box starts unticked and says who may email.
    expect(page.byName("consent").checked).toBe(false);
    expect(page.form.find((node) => node.tag === "span")!.textContent).toBe("Yes, Acme may email me.");
    const link = page.form.find((node) => node.tag === "a")!;
    expect(link.attrs).toMatchObject({ href: "https://acme.co.za/privacy", rel: "noreferrer noopener", target: "_blank" });
    expect(page.byId("send").textContent).toBe("Send");
    // The client's colour, and a first height for the page that holds the frame.
    expect(page.styles["--accent"]).toBe("#0a7a3d");
    expect(page.posted[0]).toEqual({ source: "pib-lead", type: "resize", height: 321 });
  });

  it("says plainly when the snippet has no key, and shows no form", () => {
    const page = loadFormPage("#c=hello");
    expect(page.form.findAll((node) => Boolean(node.attrs.name))).toEqual([]);
    expect(page.form.find((node) => node.attrs.class === "err")!.textContent).toMatch(/snippet is missing its key/);
  });

  it("does not post an empty form: each missing field gets its message under it", () => {
    const page = loadFormPage(hash());
    page.submit();
    expect(page.byId("f-name-err").textContent).toBe("Please tell us your name.");
    expect(page.byId("f-email-err").textContent).toBe("Please enter your email address.");
    expect(page.byId("f-phone-err").textContent).toBe("");
    expect(page.fetch).not.toHaveBeenCalled();
    // Fixing it clears the messages.
    page.type("name", "Jane");
    page.type("email", "jane@acme.co.za");
    page.submit();
    expect(page.byId("f-name-err").textContent).toBe("");
    expect(page.byId("f-email-err").textContent).toBe("");
    expect(page.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses an email that does not look right before sending", () => {
    const page = loadFormPage(hash());
    page.type("name", "Jane");
    page.type("email", "jane@acme");
    page.submit();
    expect(page.byId("f-email-err").textContent).toBe("That email address does not look right.");
    expect(page.fetch).not.toHaveBeenCalled();
  });

  it("sends one JSON request to the endpoint on this host, with the page, the campaign tags and what the person ticked", async () => {
    const page = loadFormPage(hash());
    page.type("name", "  Jane Smith ");
    page.type("email", "jane@acme.co.za");
    page.type("phone", "082 123 4567");
    page.type("message", "Please quote");
    page.tick(true);
    page.submit();
    expect(page.byId("send").disabled).toBe(true);
    await settle();
    const [url, init] = page.fetch.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("/api/plugins/partnersinbiz.crm/webhooks/lead");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(sent(page)).toMatchObject({ key: KEY, name: "Jane Smith", email: "jane@acme.co.za", phone: "082 123 4567", message: "Please quote", consent: true, consentText: "Yes, Acme may email me.", pageUrl: "https://acme.co.za/contact", utm: { utm_source: "google" }, hp_website: "", turnstileToken: "" });
    expect(typeof sent(page).t).toBe("number");
    // Success: the form goes, the thank-you shows, the page that holds the frame is told.
    expect(page.form.hidden).toBe(true);
    expect(page.done.hidden).toBe(false);
    expect(page.done.textContent).toMatch(/Thank you/);
    expect(page.posted.map((message) => message.type)).toEqual(expect.arrayContaining(["submitted", "resize"]));
  });

  it("does not claim consent that was not ticked", async () => {
    const page = loadFormPage(hash());
    page.type("name", "Jane");
    page.type("email", "jane@acme.co.za");
    page.submit();
    await settle();
    expect(sent(page)).toMatchObject({ consent: false, consentText: "" });
  });

  it("uses the client's thank-you wording", async () => {
    const page = loadFormPage(hash(`&s=${encodeURIComponent("Thanks, we will call you today.")}`));
    page.type("name", "Jane");
    page.type("email", "jane@acme.co.za");
    page.submit();
    await settle();
    expect(page.done.textContent).toBe("Thanks, we will call you today.");
  });

  it("sends only once when the button is pressed twice", async () => {
    const page = loadFormPage(hash());
    page.type("name", "Jane");
    page.type("email", "jane@acme.co.za");
    page.submit();
    page.submit();
    await settle();
    expect(page.fetch).toHaveBeenCalledTimes(1);
  });

  it("shows the server's plain message and lets the person try again", async () => {
    const page = loadFormPage(hash(), () => ({ ok: false, body: { deliveryId: "d", status: "failed", error: "Too many submissions. Please try again in a few minutes." } }));
    page.type("name", "Jane");
    page.type("email", "jane@acme.co.za");
    page.submit();
    await settle();
    expect(page.byId("form-err").textContent).toBe("Too many submissions. Please try again in a few minutes.");
    expect(page.byId("send").disabled).toBe(false);
    expect(page.form.hidden).toBe(false);
  });

  it("does not show a long or odd server error, only a plain line; the same for a lost connection", async () => {
    const odd = loadFormPage(hash(), () => ({ ok: false, body: { error: "x".repeat(300) } }));
    odd.type("name", "Jane");
    odd.type("email", "jane@acme.co.za");
    odd.submit();
    await settle();
    expect(odd.byId("form-err").textContent).toBe("We could not send that. Please try again in a moment.");
    const down = loadFormPage(hash(), () => Promise.reject(new Error("offline")));
    down.type("name", "Jane");
    down.type("email", "jane@acme.co.za");
    down.submit();
    await settle();
    expect(down.byId("form-err").textContent).toBe("We could not send that. Check your connection and try again.");
    expect(down.byId("send").disabled).toBe(false);
  });

  it("sends whatever a bot typed in the honeypot (the server drops it)", async () => {
    const page = loadFormPage(hash());
    page.type("name", "Bot");
    page.type("email", "bot@acme.co.za");
    page.type("hp_website", "http://spam.example");
    page.submit();
    await settle();
    expect(sent(page).hp_website).toBe("http://spam.example");
  });
});

describe("the form with the spam check on", () => {
  it("loads Cloudflare's script, will not send without a token, and sends the token once the widget gives one", async () => {
    const page = loadFormPage(hash("&t=0x4AAAAAAA"));
    const tag = page.head.children[0]!;
    expect(tag.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    expect(page.byId("turnstile")).toBeTruthy();
    page.type("name", "Jane");
    page.type("email", "jane@acme.co.za");
    page.submit();
    expect(page.byId("turnstile-err").textContent).toBe("Please complete the spam check.");
    expect(page.fetch).not.toHaveBeenCalled();

    // The widget loads and renders; its callback hands over a token.
    let options!: { sitekey: string; callback: (token?: string) => void; "expired-callback": () => void };
    page.window.turnstile = { render: (_selector, given) => { options = given as unknown as typeof options; } };
    tag.onload!();
    expect(options.sitekey).toBe("0x4AAAAAAA");
    options.callback("token-123");
    page.submit();
    await settle();
    expect(sent(page).turnstileToken).toBe("token-123");
    expect(page.byId("turnstile-err").textContent).toBe("");
  });

  it("an expired token has to be redone", () => {
    const page = loadFormPage(hash("&t=0x4AAAAAAA"));
    let options!: { callback: (token?: string) => void; "expired-callback": () => void };
    page.window.turnstile = { render: (_selector, given) => { options = given as unknown as typeof options; } };
    page.head.children[0]!.onload!();
    options.callback("token-123");
    options["expired-callback"]();
    page.type("name", "Jane");
    page.type("email", "jane@acme.co.za");
    page.submit();
    expect(page.fetch).not.toHaveBeenCalled();
    expect(page.byId("turnstile-err").textContent).toBe("Please complete the spam check.");
  });

  it("a form without a site key loads no outside script", () => {
    expect(loadFormPage(hash()).head.children).toEqual([]);
  });
});
