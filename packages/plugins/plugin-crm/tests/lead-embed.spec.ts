import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { curlExample, DEFAULT_CONSENT_TEXT, embedUrls, installSteps, leadSnippet, signedCurlExample } from "../src/lead-embed.js";
import { parseSubmission, verifyLeadSignature } from "../src/lead-form.js";
import { handleLeadWebhook } from "../src/lead-capture.js";
import { bootLeads, delivery, makeSource } from "./helpers/leads.js";

const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const UI_BASE = `/_plugins/${UUID}/ui/`;
const KEY = "pibl_abcdefghijklmnopqrstuvwx";
const read = (name: string) => readFileSync(new URL(`../static/${name}`, import.meta.url), "utf8");

describe("the snippet and the examples", () => {
  const urls = embedUrls(null, UI_BASE)!;
  const source = { publicKey: KEY, label: "Contact form", consentText: null, privacyUrl: null, successMessage: null, turnstileSiteKey: null };

  it("builds the addresses from the installation uuid, only for the exact shape the host serves", () => {
    expect(urls).toEqual({
      scriptUrl: `https://paperclip.partnersinbiz.online${UI_BASE}lead.js`,
      formUrl: `https://paperclip.partnersinbiz.online${UI_BASE}lead-form.html`,
      endpointUrl: "https://paperclip.partnersinbiz.online/api/plugins/partnersinbiz.crm/webhooks/lead",
      exampleUrl: `https://paperclip.partnersinbiz.online${UI_BASE}lead-example.html`,
    });
    expect(embedUrls("https://paperclip.example.org:8443/x?y", UI_BASE)!.scriptUrl).toBe(`https://paperclip.example.org:8443${UI_BASE}lead.js`);
    expect(embedUrls("not a url", UI_BASE)!.scriptUrl).toContain("paperclip.partnersinbiz.online");
    // The plugin-key form of the static path is refused by the host, so it is never offered.
    for (const bad of [null, undefined, "", "/_plugins/partnersinbiz.crm/ui/", `/_plugins/${UUID}/ui`, `/other/${UUID}/ui/`]) expect(embedUrls(null, bad as string)).toBeNull();
  });

  it("is two lines: a comment and one script tag", () => {
    expect(leadSnippet(source, urls)).toBe(`<!-- PiB lead form: Contact form -->\n<script async src="${urls.scriptUrl}" data-pib-lead="${KEY}"></script>`);
  });

  it("escapes what goes into attributes and the comment, and takes only a real colour", () => {
    const snippet = leadSnippet({ ...source, label: "A -- B <script>", consentText: 'Yes "email" me <b>', privacyUrl: "https://x.test/p?a=1&b=2", successMessage: "Thanks & bye", turnstileSiteKey: "0x4AAA", accent: "#0A7A3D" }, urls);
    expect(snippet).toContain("<!-- PiB lead form: A - - B &lt;script&gt; -->");
    expect(snippet).toContain('data-consent="Yes &quot;email&quot; me &lt;b&gt;"');
    expect(snippet).toContain('data-privacy="https://x.test/p?a=1&amp;b=2"');
    expect(snippet).toContain('data-success="Thanks &amp; bye"');
    expect(snippet).toContain('data-turnstile="0x4AAA"');
    expect(snippet).toContain('data-accent="#0A7A3D"');
    expect(snippet.split("\n")).toHaveLength(2);
    expect(leadSnippet({ ...source, accent: "red\" onload=\"x" }, urls)).not.toContain("data-accent");
  });

  it("has a curl example that names the endpoint and the key and sends JSON", () => {
    const curl = curlExample(source, urls);
    expect(curl).toContain(`curl -sS -X POST '${urls.endpointUrl}'`);
    expect(curl).toContain("content-type: application/json");
    const body = /-d '(.*)'/.exec(curl)![1]!;
    expect(JSON.parse(body)).toMatchObject({ key: KEY, email: "jane@example.com" });
    // The example's address passes the form's own checks.
    expect(parseSubmission(JSON.parse(body)).ok).toBe(true);
  });

  it("has a signed example whose shell recipe produces exactly the signature the server checks", () => {
    const example = signedCurlExample(source, urls);
    // Run the recipe with a stand-in `curl` that prints its arguments, then verify them the way the endpoint does.
    const secret = "pibs_example_secret";
    const script = `curl() { printf '%s\\n' "$@"; }\n${example}`;
    let printed: string;
    try {
      printed = execFileSync("bash", ["-c", script], { env: { ...process.env, PIB_LEAD_SECRET: secret }, encoding: "utf8" });
    } catch {
      // No bash or openssl on this machine: the recipe cannot be run here.
      return;
    }
    const args = printed.split("\n");
    const header = (name: string) => args.find((arg) => arg.startsWith(`${name}: `))!.slice(name.length + 2);
    const rawBody = args[args.indexOf("-d") + 1]!;
    const timestamp = header("X-PiB-Timestamp");
    expect(verifyLeadSignature({ secret, timestamp, signature: header("X-PiB-Signature"), rawBody, now: Number(timestamp) })).toEqual({ ok: true });
    expect(JSON.parse(rawBody)).toMatchObject({ key: KEY, visitorIp: "203.0.113.7" });
  });

  it("lists install steps that put the snippet first and say it is a change to the client's site", () => {
    const steps = installSteps(source, urls, "https://www.acme.co.za");
    expect(steps[0]).toContain("on https://www.acme.co.za");
    expect(steps[0]).toContain(leadSnippet(source, urls));
    expect(steps.join("\n")).toMatch(/repo project/);
    expect(steps.join("\n")).toContain(urls.exampleUrl);
    expect(DEFAULT_CONSENT_TEXT).toMatch(/unsubscribe/);
  });
});

/** A browser-ish world for lead.js: a script tag, a page address, a referrer, session storage and listeners. */
function loaderWorld(options: { attrs: Record<string, string>; search?: string; href?: string; referrer?: string; storage?: Record<string, string>; target?: boolean; blockStorage?: boolean }) {
  const frames: Array<Record<string, any>> = [];
  const listeners: Record<string, (event: any) => void> = {};
  const dispatched: Array<{ type: string; detail: unknown }> = [];
  const storage = options.storage ?? {};
  const placed: unknown[] = [];
  const targetNode = { appendChild: (node: unknown) => placed.push(node) };
  const script = {
    getAttribute: (name: string) => options.attrs[name] ?? null,
    parentNode: { insertBefore: (node: unknown) => placed.push(node) },
    nextSibling: null,
  };
  const document = {
    currentScript: script,
    referrer: options.referrer ?? "",
    getElementsByTagName: () => [script],
    createElement: (tag: string) => {
      const node: Record<string, any> = { tag, style: {}, attrs: {}, contentWindow: { id: "frame-window" }, setAttribute(name: string, value: string) { this.attrs[name] = value; } };
      frames.push(node);
      return node;
    },
    querySelector: (selector: string) => (options.target && selector === "#form-here" ? targetNode : null),
  };
  const window = {
    location: { search: options.search ?? "", href: options.href ?? "https://acme.co.za/contact" },
    sessionStorage: options.blockStorage
      ? { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }
      : { getItem: (name: string) => storage[name] ?? null, setItem: (name: string, value: string) => { storage[name] = value; } },
    addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; },
    dispatchEvent: (event: { type: string; detail: unknown }) => dispatched.push(event),
  };
  class CustomEvent { constructor(readonly type: string, init: { detail: unknown }) { this.detail = init.detail; } detail: unknown; }
  runInNewContext(read("lead.js"), { document, window, CustomEvent, encodeURIComponent, decodeURIComponent, isFinite, Object, Math, String, JSON });
  return { frames, listeners, dispatched, storage, placed };
}

const fragment = (src: string) => Object.fromEntries(src.split("#")[1]!.split("&").map((pair) => pair.split("=").map(decodeURIComponent) as [string, string]));

describe("static/lead.js (the loader on the client's page)", () => {
  const SRC = `https://paperclip.partnersinbiz.online${UI_BASE}lead.js`;

  it("adds an iframe next to the script, with the key, the page, the referrer and the campaign tags (no fragment, no extra)", () => {
    const world = loaderWorld({ attrs: { "data-pib-lead": KEY, src: SRC }, search: "?utm_source=google&utm_medium=cpc&utm_campaign=spring+sale&other=1", href: "https://acme.co.za/contact?utm_source=google#top", referrer: "https://www.google.com/search?q=x#frag" });
    expect(world.frames).toHaveLength(1);
    const frame = world.frames[0]!;
    expect(frame.src.startsWith(`https://paperclip.partnersinbiz.online${UI_BASE}lead-form.html#`)).toBe(true);
    expect(fragment(frame.src)).toEqual({
      k: KEY,
      pg: "https://acme.co.za/contact?utm_source=google",
      r: "https://www.google.com/search?q=x",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "spring sale",
    });
    expect(frame.title).toBe("Contact form");
    expect(frame.style.cssText).toContain("width:100%");
    expect(world.placed).toEqual([frame]);
  });

  it("does nothing without a well-formed key", () => {
    for (const key of [undefined, "", "pibl_short", "PIBL_ABCDEFGHIJKLMNOPQRSTUVWX", "x"]) {
      const world = loaderWorld({ attrs: { ...(key === undefined ? {} : { "data-pib-lead": key }), src: SRC } });
      expect(world.frames).toHaveLength(0);
    }
  });

  it("passes the options the snippet carries, capped, and can place the form in a chosen element", () => {
    const world = loaderWorld({
      attrs: { "data-pib-lead": KEY, src: SRC, "data-consent": "Yes email me", "data-privacy": "https://acme.co.za/privacy", "data-success": "Thanks!", "data-turnstile": "0x4AAA", "data-accent": "#0A7A3D", "data-fields": "name,email,phone,message", "data-title": "Get a quote", "data-target": "#form-here" },
      target: true,
    });
    const frame = world.frames[0]!;
    expect(fragment(frame.src)).toMatchObject({ c: "Yes email me", p: "https://acme.co.za/privacy", s: "Thanks!", t: "0x4AAA", a: "#0A7A3D", f: "name,email,phone,message" });
    expect(frame.title).toBe("Get a quote");
    expect(world.placed).toHaveLength(1);
    const long = loaderWorld({ attrs: { "data-pib-lead": KEY, src: SRC, "data-consent": "x".repeat(2000) } });
    expect(fragment(long.frames[0]!.src).c).toHaveLength(500);
  });

  it("remembers the first page and campaign tags of the visit, so a form on a later page still knows where the visit started", () => {
    const storage: Record<string, string> = {};
    loaderWorld({ attrs: { "data-pib-lead": KEY, src: SRC }, search: "?utm_source=google", href: "https://acme.co.za/?utm_source=google", referrer: "https://www.google.com/", storage });
    expect(JSON.parse(storage.pib_lead_touch!)).toEqual({ utm: { utm_source: "google" }, landing: "https://acme.co.za/?utm_source=google", referrer: "https://www.google.com/" });
    const later = loaderWorld({ attrs: { "data-pib-lead": KEY, src: SRC }, href: "https://acme.co.za/contact", referrer: "https://acme.co.za/", storage });
    expect(fragment(later.frames[0]!.src)).toMatchObject({ pg: "https://acme.co.za/contact", l: "https://acme.co.za/?utm_source=google", r: "https://www.google.com/", utm_source: "google" });
  });

  it("a visit that had no tags takes the tags of a later page that has them", () => {
    const storage: Record<string, string> = {};
    loaderWorld({ attrs: { "data-pib-lead": KEY, src: SRC }, href: "https://acme.co.za/", storage });
    const later = loaderWorld({ attrs: { "data-pib-lead": KEY, src: SRC }, search: "?utm_source=newsletter", href: "https://acme.co.za/offer?utm_source=newsletter", storage });
    expect(fragment(later.frames[0]!.src)).toMatchObject({ utm_source: "newsletter" });
  });

  it("works when storage is blocked", () => {
    const world = loaderWorld({ attrs: { "data-pib-lead": KEY, src: SRC }, search: "?utm_source=google", blockStorage: true });
    expect(fragment(world.frames[0]!.src)).toMatchObject({ utm_source: "google" });
  });

  it("resizes the frame from its own messages only, within limits, and announces a sent form", () => {
    const world = loaderWorld({ attrs: { "data-pib-lead": KEY, src: SRC } });
    const frame = world.frames[0]!;
    const message = world.listeners.message!;
    message({ source: frame.contentWindow, data: { source: "pib-lead", type: "resize", height: 480.4 } });
    expect(frame.style.height).toBe("480px");
    message({ source: frame.contentWindow, data: { source: "pib-lead", type: "resize", height: 5 } });
    expect(frame.style.height).toBe("120px");
    message({ source: frame.contentWindow, data: { source: "pib-lead", type: "resize", height: 99999 } });
    expect(frame.style.height).toBe("2000px");
    // Another window, another source, or a bad height is ignored.
    message({ source: { id: "someone else" }, data: { source: "pib-lead", type: "resize", height: 300 } });
    message({ source: frame.contentWindow, data: { source: "other", type: "resize", height: 300 } });
    message({ source: frame.contentWindow, data: { source: "pib-lead", type: "resize", height: "tall" } });
    expect(frame.style.height).toBe("2000px");
    message({ source: frame.contentWindow, data: { source: "pib-lead", type: "submitted" } });
    expect(world.dispatched).toEqual([expect.objectContaining({ type: "pib-lead-submitted", detail: { form: KEY } })]);
  });
});

describe("static/lead-form.js (the form inside the frame)", () => {
  // The page script exports its pure functions when it finds a `module` (and no `document`): run it that way.
  const sandbox = { module: { exports: {} as Record<string, unknown> } };
  runInNewContext(read("lead-form.js"), sandbox);
  const form = sandbox.module.exports as {
    parseHash: (hash: string) => Record<string, any>;
    validate: (values: Record<string, unknown>, config: Record<string, any>) => Record<string, string>;
    buildPayload: (values: Record<string, unknown>, config: Record<string, any>, elapsed: number) => Record<string, any>;
    EMAIL_RE: RegExp;
  };

  it("reads its settings from the fragment, with defaults, and never trusts a link or colour that is not one", () => {
    const config = form.parseHash(`#k=${KEY}&c=Yes%20email%20me&p=https%3A%2F%2Facme.co.za%2Fprivacy&s=Thanks%21&t=0x4AAA&a=%230a7a3d&f=name,phone,message&pg=https%3A%2F%2Facme.co.za%2Fcontact&r=https%3A%2F%2Fgoogle.com%2F&l=https%3A%2F%2Facme.co.za%2F&utm_source=google&utm_medium=cpc&evil=1`);
    expect(config).toEqual({
      key: KEY,
      consentText: "Yes email me",
      privacyUrl: "https://acme.co.za/privacy",
      successText: "Thanks!",
      turnstile: "0x4AAA",
      accent: "#0a7a3d",
      // Email is always there; it goes in after the name.
      fields: ["name", "email", "phone", "message"],
      pageUrl: "https://acme.co.za/contact",
      referrer: "https://google.com/",
      landingUrl: "https://acme.co.za/",
      utm: { utm_source: "google", utm_medium: "cpc" },
    });
    const plain = form.parseHash("");
    expect(plain).toMatchObject({ key: "", fields: ["name", "email", "message"], privacyUrl: "", accent: "", turnstile: "" });
    expect(plain.consentText).toMatch(/unsubscribe/);
    const bad = form.parseHash("#k=x&p=javascript%3Aalert(1)&a=red&f=name,drop,email,name");
    expect(bad).toMatchObject({ privacyUrl: "", accent: "", fields: ["name", "email"] });
  });

  it("asks for an email, a name when it asks for one, and the spam check when it is on", () => {
    const config = form.parseHash(`#k=${KEY}&f=name,email,message`);
    expect(form.validate({ name: "Jane", email: "jane@acme.co.za" }, config)).toEqual({});
    expect(form.validate({ name: "", email: "" }, config)).toEqual({ name: "Please tell us your name.", email: "Please enter your email address." });
    expect(form.validate({ name: "J", email: "jane@" }, config)).toEqual({ email: "That email address does not look right." });
    const noName = form.parseHash(`#k=${KEY}&f=email`);
    expect(form.validate({ email: "jane@acme.co.za" }, noName)).toEqual({});
    const withTurnstile = form.parseHash(`#k=${KEY}&t=0x4AAA`);
    expect(form.validate({ name: "J", email: "jane@acme.co.za" }, withTurnstile)).toEqual({ turnstile: "Please complete the spam check." });
    expect(form.validate({ name: "J", email: "jane@acme.co.za", turnstileToken: "tok" }, withTurnstile)).toEqual({});
  });

  it("builds the request the endpoint reads: nested campaign tags, the consent wording only when ticked, the honeypot and the elapsed time", () => {
    const config = form.parseHash(`#k=${KEY}&c=Yes%20email%20me&f=name,email,phone,message&pg=https%3A%2F%2Facme.co.za%2Fcontact&r=https%3A%2F%2Fgoogle.com%2F&utm_source=google`);
    const ticked = form.buildPayload({ name: " Jane ", email: " jane@acme.co.za ", phone: "082 123 4567", message: "Hi", consent: true, hp_website: "", turnstileToken: "tok" }, config, 8123.6);
    expect(ticked).toMatchObject({ key: KEY, name: "Jane", email: "jane@acme.co.za", phone: "082 123 4567", message: "Hi", consent: true, consentText: "Yes email me", pageUrl: "https://acme.co.za/contact", referrer: "https://google.com/", utm: { utm_source: "google" }, hp_website: "", t: 8124, turnstileToken: "tok" });
    const unticked = form.buildPayload({ name: "Jane", email: "jane@acme.co.za", consent: false }, config, 100);
    expect(unticked).toMatchObject({ consent: false, consentText: "" });
    expect(form.buildPayload({ email: "a@b.co" }, config, -5).t).toBe(0);
    // A field the form did not ask for is not sent.
    expect(form.buildPayload({ email: "a@b.co", company: "Acme" }, config, 1)).not.toHaveProperty("company");
  });

  it("what the form sends is what the endpoint accepts and stores: the whole path from the fragment to the contact", async () => {
    const booted = await bootLeads();
    const made = await makeSource(booted, { client: "company:acme", label: "Contact form", consentText: "Yes Acme may email me" });
    const config = form.parseHash(`#k=${made.source.key}&c=${encodeURIComponent("Yes Acme may email me")}&f=name,email,phone,message&pg=${encodeURIComponent("https://acme.co.za/contact")}&r=${encodeURIComponent("https://www.google.com/")}&l=${encodeURIComponent("https://acme.co.za/")}&utm_source=google&utm_medium=cpc&utm_campaign=spring&gclid=abc123`);
    const body = form.buildPayload({ name: "Jane Smith", email: "jane@smith-plumbing.test", phone: "082 123 4567", message: "Please quote", consent: true, hp_website: "" }, config, 9000);
    expect(await handleLeadWebhook(booted.harness.ctx, delivery(body))).toMatchObject({ status: "stored", client: "company:acme" });
    expect(booted.store.client_leads[0]).toMatchObject({ name: "Jane Smith", phone: "082 123 4567", message: "Please quote" });
    expect(booted.store.client_leads[0]!.meta.attribution).toMatchObject({ utmSource: "google", utmMedium: "cpc", utmCampaign: "spring", gclid: "abc123", pageUrl: "https://acme.co.za/contact", referrer: "https://www.google.com/", landingUrl: "https://acme.co.za/" });
    expect(booted.store.consent_records[0]).toMatchObject({ wording: "Yes Acme may email me", sender_key: "company:acme" });
  });
});

describe("the files that are served", () => {
  it("the form page loads its script and has a honeypot, with no outside resource but Cloudflare's check", () => {
    const html = read("lead-form.html");
    expect(html).toContain('<script src="lead-form.js"></script>');
    expect(html).toContain('<form id="f" novalidate></form>');
    expect(html).toContain("noindex");
    expect(html).toMatch(/\.hp \{ position: absolute; left: -5000px/);
    expect(html).not.toMatch(/https?:\/\//);
    const js = read("lead-form.js");
    expect(js.match(/https?:\/\/[^"'\s)]+/g)!.filter((url) => !url.includes("challenges.cloudflare.com")).filter((url) => !/^https?:\\/.test(url))).toEqual([]);
    expect(js).toContain('hp_website');
    expect(js).toContain("/api/plugins/partnersinbiz.crm/webhooks/lead");
  });

  it("the example page shows the snippet, the curl call and why a browser cannot post to the endpoint directly", () => {
    const html = read("lead-example.html");
    expect(html).toContain('data-pib-lead="pibl_');
    expect(html).toContain("/webhooks/lead");
    expect(html).toMatch(/no CORS headers/);
    // The signing secret is made by a person on the card: the page for agents and developers never tells anyone to ask for it in a tool call.
    expect(html).toMatch(/A person makes that secret/);
    expect(html).not.toContain("serverSecret");
  });

  it("the build copies the static folder next to the page", () => {
    const config = readFileSync(new URL("../esbuild.config.mjs", import.meta.url), "utf8");
    expect(config).toContain("./static/");
    expect(config).toContain("readdirSync(staticDir)");
    expect(config).toMatch(/dist\/ui\//);
  });
});
