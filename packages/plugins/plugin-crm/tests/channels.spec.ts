import { describe, expect, it } from "vitest";
import { channelOfSource, CHANNELS, classifyChannel, hostOf, isChannel, leadTouches, touchFromAttribution } from "../src/channels.js";

describe("hostOf", () => {
  it("gives the bare host of an address or a host, and null for nonsense", () => {
    expect(hostOf("https://www.Acme.co.za/services?x=1")).toBe("acme.co.za");
    expect(hostOf("ACME.co.za")).toBe("acme.co.za");
    expect(hostOf("l.facebook.com")).toBe("l.facebook.com");
    expect(hostOf("")).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(hostOf("not a host")).toBeNull();
    expect(hostOf("localhost")).toBeNull();
  });
});

describe("classifyChannel", () => {
  it("lets the campaign medium say what it is, before anything else", () => {
    expect(classifyChannel({ medium: "cpc", source: "google" })).toBe("paid");
    expect(classifyChannel({ medium: "paid-social", source: "facebook" })).toBe("paid");
    expect(classifyChannel({ medium: "email", source: "mailchimp" })).toBe("email");
    expect(classifyChannel({ medium: "social", source: "linkedin" })).toBe("social");
    expect(classifyChannel({ medium: "organic", source: "google" })).toBe("organic_search");
    expect(classifyChannel({ medium: "referral" })).toBe("referral");
    // The medium beats the referrer: an email link opened from a webmail is still the email campaign, and a paid click from Google is paid.
    expect(classifyChannel({ medium: "cpc", referrerHost: "www.google.com" })).toBe("paid");
  });

  it("treats an ad click id as paid, whatever the referrer says", () => {
    expect(classifyChannel({ click: "g", referrerHost: "www.google.com" })).toBe("paid");
    expect(classifyChannel({ click: "m" })).toBe("paid");
  });

  it("knows search engines, social networks and webmail by the referring host", () => {
    expect(classifyChannel({ referrerHost: "www.google.com" })).toBe("organic_search");
    expect(classifyChannel({ referrerHost: "www.google.co.za" })).toBe("organic_search");
    expect(classifyChannel({ referrerHost: "duckduckgo.com" })).toBe("organic_search");
    expect(classifyChannel({ referrerHost: "search.brave.com" })).toBe("organic_search");
    expect(classifyChannel({ referrerHost: "l.facebook.com" })).toBe("social");
    expect(classifyChannel({ referrerHost: "lnkd.in" })).toBe("social");
    expect(classifyChannel({ referrerHost: "t.co" })).toBe("social");
    expect(classifyChannel({ referrerHost: "mail.google.com" })).toBe("email");
    expect(classifyChannel({ referrerHost: "outlook.office.com" })).toBe("email");
    // Google's tools are not search.
    expect(classifyChannel({ referrerHost: "docs.google.com" })).toBe("referral");
  });

  it("calls any other referring site a referral, but not the client's own site", () => {
    expect(classifyChannel({ referrerHost: "blog.partner.co.za" })).toBe("referral");
    expect(classifyChannel({ referrerHost: "www.acme.co.za" }, ["acme.co.za"])).toBe("direct");
    expect(classifyChannel({ referrerHost: "shop.acme.co.za" }, ["acme.co.za"])).toBe("direct");
    // notacme.co.za is not a subdomain of acme.co.za.
    expect(classifyChannel({ referrerHost: "notacme.co.za" }, ["acme.co.za"])).toBe("referral");
  });

  it("names the source when there is no medium", () => {
    expect(classifyChannel({ source: "google" })).toBe("organic_search");
    expect(classifyChannel({ source: "Facebook" })).toBe("social");
    expect(classifyChannel({ source: "newsletter" })).toBe("email");
  });

  it("calls a bare Facebook click id social, an unknown tag other, and nothing direct", () => {
    expect(classifyChannel({ click: "f" })).toBe("social");
    expect(classifyChannel({ source: "qr-poster" })).toBe("other");
    expect(classifyChannel({ campaign: "spring" })).toBe("other");
    expect(classifyChannel({})).toBe("direct");
  });

  it("only ever returns a known channel", () => {
    for (const touch of [{}, { source: "x" }, { medium: "weird" }, { referrerHost: "a.b" }, { click: "f" as const }]) expect(isChannel(classifyChannel(touch))).toBe(true);
    expect(CHANNELS).toContain("direct");
    expect(isChannel("unattributed")).toBe(false);
  });
});

describe("what a stored lead says about where it came from", () => {
  it("reads the visit's tags and referrer", () => {
    expect(touchFromAttribution({ utmSource: "google", utmMedium: "cpc", referrer: "https://www.google.com/" })).toEqual({ source: "google", medium: "cpc", campaign: null, referrerHost: "google.com", click: null });
    expect(touchFromAttribution({ gclid: "abc" })?.click).toBe("g");
    expect(touchFromAttribution({})).toBeNull();
  });

  it("uses the one visit for first and last touch when the visitor did not allow remembering", () => {
    const touches = leadTouches({ utmSource: "facebook", utmMedium: "social", utmCampaign: "launch", pageUrl: "https://acme.co.za/contact" });
    expect(touches).toEqual({ first: "social", last: "social", basis: "visit", campaign: "launch" });
  });

  it("uses the remembered first and last touch when there are some, and they may differ", () => {
    const touches = leadTouches({ pageUrl: "https://acme.co.za/", ftSource: "google", ftMedium: "organic", ltSource: "newsletter", ltMedium: "email", ltCampaign: "october" });
    expect(touches.basis).toBe("persisted");
    expect(touches.first).toBe("organic_search");
    expect(touches.last).toBe("email");
  });

  it("calls a visit with a landing page but no tags direct, and a lead with nothing at all unattributed", () => {
    expect(leadTouches({ pageUrl: "https://acme.co.za/" })).toMatchObject({ first: "direct", last: "direct", basis: "visit" });
    expect(leadTouches({})).toEqual({ first: null, last: null, basis: "none", campaign: null });
  });

  it("maps a lead from another source", () => {
    expect(channelOfSource("social")).toBe("social");
    expect(channelOfSource("email")).toBe("direct");
    expect(channelOfSource("form")).toBeNull();
  });
});
