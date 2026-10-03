import { describe, expect, it } from "vitest";
import { parseRobots } from "../src/checks/parse.js";
import {
  AI_BOTS,
  aiBotAccess,
  aiRobotsFindings,
  analyseAnswerBlocks,
  answerFindings,
  botUserAgent,
  brandSection,
  confirmRefusals,
  crawlersSection,
  entityFromJsonLd,
  entityFindings,
  geoBand,
  geoScore,
  judgeProbe,
  judgeSameAs,
  llmsFindings,
  mentionsBrand,
  mentionsPhone,
  parseLlmsTxt,
  pickSamplePages,
  profileKind,
  runGeoAudit,
  snippetFindings,
  type SectionScore,
} from "../src/checks/geo.js";
import type { SiteFetcher } from "../src/checks/site.js";
import { FAQ_HTML, GOOD_HOME, ORG, page, reply, site } from "./helpers/geo-site.js";

describe("AI crawler access (robots.txt)", () => {
  it("reads the bot's own group first, then the wildcard group, then nothing", () => {
    const robots = parseRobots(`User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: *\nDisallow: /private/\n`);
    const access = aiBotAccess(robots, ["/", "/private/x"]);
    const by = (token: string) => access.find((a) => a.token === token)!;
    expect(by("GPTBot")).toMatchObject({ state: "blocked", via: "own-rule", kind: "training" });
    expect(by("OAI-SearchBot")).toMatchObject({ state: "allowed", via: "own-rule" });
    // No group of their own: the wildcard group keeps them out of /private/ only.
    expect(by("PerplexityBot")).toMatchObject({ state: "partial", via: "wildcard", blockedPaths: ["/private/x"] });
    expect(aiBotAccess(null).every((a) => a.state === "allowed" && a.via === "no-rule")).toBe(true);
  });

  it("matches a group's token exactly: a group for Googlebot does not govern Google-Extended", () => {
    const robots = parseRobots("User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n");
    const access = aiBotAccess(robots);
    expect(access.find((a) => a.token === "Googlebot")!.state).toBe("allowed");
    expect(access.find((a) => a.token === "Google-Extended")).toMatchObject({ state: "blocked", via: "wildcard" });
  });

  it("calls a blocked search bot a finding and a blocked training bot a client choice (info, never stored)", () => {
    const robots = parseRobots("User-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: Claude-User\nDisallow: /\n");
    const findings = aiRobotsFindings(aiBotAccess(robots), "https://acme.co.za/robots.txt");
    const sev = (needle: string) => findings.find((f) => f.finding.includes(needle))!.severity;
    expect(sev("PerplexityBot")).toBe("high");
    expect(sev("Claude-User")).toBe("low");
    expect(sev("GPTBot")).toBe("info");
    expect(findings.find((f) => f.finding.includes("GPTBot"))!.finding).toMatch(/the client decides/);
    expect(findings.every((f) => f.category === "geo")).toBe(true);
  });

  it("says a blanket block once, as critical, instead of once per bot", () => {
    const findings = aiRobotsFindings(aiBotAccess(parseRobots("User-agent: *\nDisallow: /\n")), "u");
    expect(findings.filter((f) => f.severity === "critical")).toHaveLength(1);
    expect(findings.filter((f) => f.severity === "high")).toHaveLength(0);
    expect(aiRobotsFindings(aiBotAccess(parseRobots("User-agent: *\nDisallow: /blog/\n"), ["/", "/blog/post"]), "u").map((f) => f.finding)).toEqual([expect.stringContaining("keeps every crawler out of part of the site")]);
  });

  it("lists every bot with a kind and a purpose", () => {
    expect(new Set(AI_BOTS.map((b) => b.token)).size).toBe(AI_BOTS.length);
    for (const token of ["GPTBot", "OAI-SearchBot", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"]) expect(AI_BOTS.map((b) => b.token)).toContain(token);
    expect(AI_BOTS.filter((b) => b.kind === "search").map((b) => b.token)).toEqual(expect.arrayContaining(["OAI-SearchBot", "PerplexityBot", "Googlebot"]));
    expect(AI_BOTS.every((b) => b.purpose.length > 10)).toBe(true);
  });
});

describe("server probes", () => {
  const ok = { status: 200, text: "<html>content</html>", headers: {} };
  const bot = { token: "PerplexityBot", kind: "search" as const };
  it("flags a refusal or a bot-check page only when a normal request worked", () => {
    expect(judgeProbe(bot, ok, { status: 403, text: "", headers: {} })).toMatchObject({ blocked: true, detail: "HTTP 403" });
    expect(judgeProbe(bot, ok, { status: 200, text: "<title>Just a moment...</title>", headers: {} })).toMatchObject({ blocked: true, detail: expect.stringContaining("bot-check") });
    expect(judgeProbe(bot, ok, { status: 200, text: "x", headers: { "cf-mitigated": "challenge" } })!.blocked).toBe(true);
    expect(judgeProbe(bot, ok, { status: 200, text: "<html>content</html>", headers: {} })!.blocked).toBe(false);
    // The site's own check page is on the normal request too: no verdict against the bot.
    expect(judgeProbe(bot, { ...ok, text: "Just a moment" }, { status: 200, text: "Just a moment", headers: {} })!.blocked).toBe(false);
    expect(judgeProbe(bot, { status: 500, text: "", headers: {} }, { status: 403, text: "", headers: {} })).toBeNull();
  });
  it("builds a user agent carrying the bot's token", () => {
    expect(botUserAgent("OAI-SearchBot")).toContain("OAI-SearchBot/1.0");
  });
});

describe("llms.txt", () => {
  const GOOD = `# Acme Accounting\n\n> Bookkeeping, VAT and payroll for Durban small businesses.\n\n## Services\n\n- [Bookkeeping](https://acme.co.za/bookkeeping): monthly books\n- [VAT returns](https://acme.co.za/vat): filed on time\n- [Payroll](/payroll): payslips and UIF\n`;
  it("scores a complete file good, a bare list basic and anything else by what is wrong", () => {
    const good = parseLlmsTxt(GOOD, 200, "https://acme.co.za/llms.txt", "https://acme.co.za");
    expect(good).toMatchObject({ quality: "good", title: "Acme Accounting", summary: true, sections: 1, problems: [] });
    expect(good.links.map((l) => l.url)).toContain("https://acme.co.za/payroll");
    expect(parseLlmsTxt("# Acme\n- [Home](https://acme.co.za/)\n", 200, "u", "https://acme.co.za").quality).toBe("basic");
    expect(parseLlmsTxt("just words", 200, "u", "https://acme.co.za").quality).toBe("invalid");
    expect(parseLlmsTxt("", 200, "u", "https://acme.co.za").quality).toBe("invalid");
    expect(parseLlmsTxt("", 404, "u", "https://acme.co.za")).toMatchObject({ present: false, quality: "missing" });
  });
  it("does not accept a single-page app's home page served at /llms.txt", () => {
    const spa = parseLlmsTxt("<!doctype html><html><head></head><body># Not markdown</body></html>", 200, "u", "https://acme.co.za");
    expect(spa).toMatchObject({ present: false, quality: "invalid" });
    expect(spa.problems[0]).toMatch(/web page, not a text file/);
  });
  it("calls a missing file low severity and says it is unproven", () => {
    const [f] = llmsFindings(parseLlmsTxt("", 404, "https://acme.co.za/llms.txt", "https://acme.co.za"), "acme.co.za");
    expect(f).toMatchObject({ severity: "low", category: "geo" });
    expect(f!.finding).toMatch(/optional, unproven/);
  });
  it("flags a file whose links mostly leave the site", () => {
    const text = "# A\n> s\n## L\n- [x](https://other.com/1)\n- [y](https://other.com/2)\n- [z](https://acme.co.za/3)\n";
    const findings = llmsFindings(parseLlmsTxt(text, 200, "u", "https://acme.co.za"), "acme.co.za");
    expect(findings.map((f) => f.finding).join(" ")).toMatch(/Most llms.txt links point to other sites/);
  });
});

describe("entity data", () => {
  it("scores a complete Organization graph at the top and names nothing missing", () => {
    const entity = entityFromJsonLd(GOOD_HOME, { siteUrl: "https://acme.co.za", needsAddress: true });
    expect(entity).toMatchObject({ found: true, score: 100, name: "Acme Accounting", id: "https://acme.co.za/#org" });
    expect(entity.sameAs).toHaveLength(3);
    expect(entityFindings(entity, "https://acme.co.za/")).toEqual([]);
  });
  it("finds nothing to score on a page without organisation data and says so", () => {
    const entity = entityFromJsonLd(page(""), { siteUrl: "https://acme.co.za", needsAddress: true });
    expect(entity).toMatchObject({ found: false, score: 0 });
    expect(entityFindings(entity, "u")[0]).toMatchObject({ severity: "medium" });
    // Product and WebSite nodes are not the business.
    const only = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Shoe"}</script>`;
    expect(entityFromJsonLd(page("", only), { siteUrl: "https://acme.co.za", needsAddress: false }).found).toBe(false);
  });
  it("weighs profile links most and reports each gap", () => {
    const thin = { "@context": "https://schema.org", "@type": "Organization", name: "Acme", url: "https://acme.co.za/" };
    const entity = entityFromJsonLd(page("", `<script type="application/ld+json">${JSON.stringify(thin)}</script>`), { siteUrl: "https://acme.co.za", needsAddress: false });
    expect(entity.score).toBeLessThan(40);
    const findings = entityFindings(entity, "https://acme.co.za/").map((f) => f.finding);
    expect(findings.some((f) => /real profiles \(sameAs\).* is missing \(0 profile links\)/.test(f))).toBe(true);
    expect(findings.some((f) => /phone or email is missing/.test(f))).toBe(true);
    // Software does not need an address, so it is not asked for one.
    expect(entity.checks.some((c) => c.key === "address")).toBe(false);
    const withSameAs = { ...thin, sameAs: ["https://www.linkedin.com/company/acme", "https://x.com/acme"] };
    expect(entityFromJsonLd(page("", `<script type="application/ld+json">${JSON.stringify(withSameAs)}</script>`), { siteUrl: "https://acme.co.za", needsAddress: false }).checks.find((c) => c.key === "sameAs")!.earned).toBeCloseTo(0.72);
  });
  it("tells the kind of a profile link", () => {
    expect(profileKind("https://www.linkedin.com/company/acme")).toBe("linkedin");
    expect(profileKind("https://x.com/acme")).toBe("x");
    expect(profileKind("https://www.wikidata.org/wiki/Q1")).toBe("wikidata");
    expect(profileKind("https://example.org/acme")).toBe("other");
  });
});

describe("answer blocks and FAQ coverage", () => {
  it("counts question headings that have a short direct answer under them", () => {
    const result = analyseAnswerBlocks(page(FAQ_HTML), "https://acme.co.za/");
    expect(result).toMatchObject({ questionHeadings: 2, directAnswers: 2, faqSchemaQuestions: 0, answerReady: true });
  });
  it("does not count a wall of text or a one-word reply as an answer", () => {
    const long = `<h2>Why choose us?</h2><p>${"word ".repeat(150)}</p><h2>How does it work?</h2><p>Easy.</p>`;
    const result = analyseAnswerBlocks(page(long), "u");
    expect(result).toMatchObject({ questionHeadings: 2, directAnswers: 0, answerReady: false });
    expect(answerFindings([result])[0]!.finding).toMatch(/fewer than 2 are followed by a short direct answer/);
    expect(answerFindings([analyseAnswerBlocks(page("<p>No questions at all here.</p>"), "u")])[0]!.finding).toMatch(/No question headings/);
  });
  it("accepts FAQ markup whose questions are on the page and rejects markup for hidden questions", () => {
    const faq = (names: string[]) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: names.map((name) => ({ "@type": "Question", name, acceptedAnswer: { "@type": "Answer", text: "Yes." } })) })}</script>`;
    const shown = page("<p>Do you do VAT? Where are you based? Can I pay monthly?</p>", faq(["Do you do VAT?", "Where are you based?", "Can I pay monthly?"]));
    expect(analyseAnswerBlocks(shown, "u")).toMatchObject({ faqSchemaQuestions: 3, faqMatchesPage: true, answerReady: true });
    const hidden = page("<p>Nothing about that.</p>", faq(["Do you do VAT?", "Where are you based?", "Can I pay monthly?"]));
    const hiddenResult = analyseAnswerBlocks(hidden, "u");
    expect(hiddenResult).toMatchObject({ faqMatchesPage: false, answerReady: false });
    expect(answerFindings([hiddenResult]).map((f) => f.severity)).toContain("medium");
  });
});

describe("snippet limits", () => {
  it("flags nosnippet and tiny max-snippet, and notes noai", () => {
    expect(snippetFindings("u", "index, nosnippet")).toMatchObject({ limited: "nosnippet" });
    expect(snippetFindings("u", "max-snippet:0")).toMatchObject({ limited: "nosnippet" });
    expect(snippetFindings("u", "max-snippet:-1, max-image-preview:large")).toMatchObject({ limited: "none", findings: [] });
    expect(snippetFindings("u", "noai, noimageai")).toMatchObject({ limited: "noai" });
    expect(snippetFindings("u", null).limited).toBe("none");
  });
});

describe("brand consistency", () => {
  it("matches the business name ignoring case, punctuation and the legal suffix", () => {
    expect(mentionsBrand("Welcome to ACME Accounting (Pty) Ltd, Durban", ["Acme Accounting"])).toBe(true);
    expect(mentionsBrand("Acme Accounting & Tax", ["Acme Accounting and Tax"])).toBe(true);
    expect(mentionsBrand("Acme Plumbing in Durban", ["Acme Accounting"])).toBe(false);
    expect(mentionsBrand("anything", ["", "ab"])).toBe(false);
  });
  it("compares phone numbers on their last digits, and says nothing without one", () => {
    expect(mentionsPhone("Call 031 555 0100 today", "+27 31 555 0100")).toBe(true);
    expect(mentionsPhone("Call 031 555 0199 today", "+27 31 555 0100")).toBe(false);
    expect(mentionsPhone("any", null)).toBeNull();
    expect(mentionsPhone("any", "12")).toBeNull();
  });
  it("judges a profile link: match, wrong page, guarded site, broken", () => {
    const names = ["Acme Accounting"];
    const html = (t: string) => `<html><head><title>${t}</title></head><body>${"About us. ".repeat(50)}</body></html>`;
    expect(judgeSameAs("https://example.org/acme", { status: 200, text: html("Acme Accounting - Durban") }, names).state).toBe("match");
    expect(judgeSameAs("https://example.org/acme", { status: 200, text: html("Some other firm") }, names).state).toBe("no-match");
    expect(judgeSameAs("https://www.linkedin.com/company/acme", { status: 999, text: "" }, names).state).toBe("unverifiable");
    expect(judgeSameAs("https://example.org/acme", { status: 404, text: "" }, names).state).toBe("broken");
    expect(judgeSameAs("https://www.linkedin.com/company/acme", null, names).state).toBe("unverifiable");
  });
  it("does not blame a profile for what a guarded site or a server error says", () => {
    const names = ["Acme Accounting"];
    const longPage = (t: string) => `<html><head><title>${t}</title></head><body>${"About us. ".repeat(50)}</body></html>`;
    // A guarded site (LinkedIn, Facebook ...) serves a short login wall: nothing to compare. An ordinary site serving the same short page is a wrong page.
    const wall = "<html><head><title>Log in</title></head><body>Sign in to continue</body></html>";
    expect(judgeSameAs("https://www.linkedin.com/company/acme", { status: 200, text: wall }, names).state).toBe("unverifiable");
    expect(judgeSameAs("https://example.org/acme", { status: 200, text: wall }, names).state).toBe("no-match");
    // A real page on a guarded site that does not show the name is a mismatch.
    expect(judgeSameAs("https://www.linkedin.com/company/acme", { status: 200, text: longPage("Another firm") }, names).state).toBe("no-match");
    // A refusal: guarded sites refuse bots, ordinary sites mean it; a server error says nothing either way.
    expect(judgeSameAs("https://www.linkedin.com/company/acme", { status: 403, text: "" }, names).state).toBe("unverifiable");
    expect(judgeSameAs("https://example.org/acme", { status: 403, text: "" }, names).state).toBe("broken");
    expect(judgeSameAs("https://example.org/acme", { status: 503, text: "" }, names).state).toBe("unverifiable");
    expect(judgeSameAs("https://example.org/acme", { status: 410, text: "" }, names).state).toBe("broken");
  });
  it("scores profiles and listings together and leaves out a part with nothing to check", () => {
    const sameAs = [
      { url: "a", kind: "other" as const, status: 200, state: "match" as const },
      { url: "b", kind: "other" as const, status: 200, state: "no-match" as const },
    ];
    expect(brandSection(sameAs, [])).toMatchObject({ earned: 3.5, possible: 7, evaluated: true });
    const dirs = [
      { url: "d1", source: "Yell", status: 200, nameFound: true, phoneFound: true },
      { url: "d2", source: "Brabys", status: 200, nameFound: true, phoneFound: false },
    ];
    expect(brandSection(sameAs, dirs)).toMatchObject({ earned: 7.5, possible: 15 });
    expect(brandSection([], [])).toMatchObject({ evaluated: false });
  });
});

describe("score", () => {
  const section = (earned: number, possible: number, evaluated = true): SectionScore => ({ earned, possible, evaluated });
  it("normalises over the sections that could be checked", () => {
    const all = geoScore({ crawlers: section(30, 30), entity: section(25, 25), answers: section(10, 20), brand: section(0, 15), llms: section(0, 5), snippets: section(5, 5) });
    expect(all).toMatchObject({ score: 70, band: "good", complete: true });
    const partial = geoScore({ crawlers: section(30, 30), entity: section(0, 25, false), answers: section(0, 20, false), brand: section(0, 15, false), llms: section(0, 5, false), snippets: section(5, 5) });
    expect(partial).toMatchObject({ score: 100, complete: false });
    expect(geoScore({ crawlers: section(0, 30, false), entity: section(0, 25, false), answers: section(0, 20, false), brand: section(0, 15, false), llms: section(0, 5, false), snippets: section(0, 5, false) }).score).toBe(0);
  });
  it("bands", () => {
    expect([90, 70, 50, 10].map(geoBand)).toEqual(["strong", "good", "fair", "weak"]);
    // Each band starts exactly on its boundary.
    expect([85, 84, 65, 64, 40, 39].map(geoBand)).toEqual(["strong", "good", "good", "fair", "fair", "weak"]);
  });
  it("crawler section ignores training bots and zeroes a bot the server refuses", () => {
    const robots = parseRobots("User-agent: GPTBot\nDisallow: /\n");
    const access = aiBotAccess(robots);
    expect(crawlersSection(access, [])).toMatchObject({ earned: 30, possible: 30 });
    const probes = [{ token: "PerplexityBot", kind: "search" as const, status: 403, blocked: true, detail: "HTTP 403" }];
    expect(crawlersSection(access, probes).earned).toBeCloseTo(26, 5);
    const search = AI_BOTS.filter((b) => b.kind === "search").length;
    expect(search).toBe(6);
  });
});

describe("sample pages", () => {
  it("takes the home page plus the pages customers read first, without repeats", () => {
    const sitemap = ["https://acme.co.za/", "https://acme.co.za/zzz", "https://acme.co.za/services/vat", "https://acme.co.za/about", "https://acme.co.za/blog/a", "https://acme.co.za/contact/", "https://acme.co.za/x1", "https://acme.co.za/x2"];
    const picked = pickSamplePages("https://acme.co.za/", sitemap);
    expect(picked).toHaveLength(6);
    expect(picked[0]).toBe("https://acme.co.za/");
    expect(new Set(picked).size).toBe(6);
    expect(picked.slice(1, 5)).toEqual(["https://acme.co.za/services/vat", "https://acme.co.za/about", "https://acme.co.za/blog/a", "https://acme.co.za/contact/"]);
  });
});

describe("runGeoAudit", () => {
  const input = { siteUrl: "https://acme.co.za", needsAddress: true, brandNames: ["Acme Accounting"] };

  it("audits a healthy site: nothing blocked, entity complete, one page without answers", async () => {
    const { fetcher, calls } = site();
    const result = await runGeoAudit(fetcher, input);
    expect(result.complete).toBe(true);
    expect(result.crawlers.filter((c) => c.kind === "search").every((c) => c.state === "allowed")).toBe(true);
    expect(result.serverProbes).toHaveLength(5);
    expect(result.serverProbes.every((p) => !p.blocked)).toBe(true);
    expect(result.llms).toMatchObject({ quality: "good" });
    expect(result.entity).toMatchObject({ found: true, score: 100 });
    expect(result.pagesChecked.sort()).toEqual(["https://acme.co.za/", "https://acme.co.za/about", "https://acme.co.za/contact"]);
    // The contact page has no answer block: one low finding on it. Nothing at high or critical.
    expect(result.findings.filter((f) => f.severity === "high" || f.severity === "critical")).toEqual([]);
    expect(result.findings.some((f) => f.url === "https://acme.co.za/contact" && /question headings/.test(f.finding))).toBe(true);
    // LinkedIn refuses bots (not a fault); the HelloPeter link is dead.
    expect(result.sameAs.map((s) => [s.kind, s.state])).toEqual([["linkedin", "unverifiable"], ["facebook", "match"], ["hellopeter", "broken"]]);
    expect(result.findings.some((f) => f.url === "https://www.hellopeter.com/acme")).toBe(true);
    expect(result.score).toBeGreaterThan(80);
    expect(result.band).not.toBe("weak");
    expect(calls.filter((c) => c.includes("robots.txt")).length).toBe(1);
    for (const f of result.covered) expect(f.category).toBe("geo");
  });

  it("finds a firewall that refuses an AI search bot although robots.txt allows it", async () => {
    const { fetcher } = site({ "https://acme.co.za/": (ua) => (/PerplexityBot/.test(ua) ? reply(403, "Forbidden") : reply(200, GOOD_HOME, {}, "https://acme.co.za/")) });
    const result = await runGeoAudit(fetcher, input);
    const blocked = result.serverProbes.filter((p) => p.blocked);
    expect(blocked.map((p) => p.token)).toEqual(["PerplexityBot"]);
    const finding = result.findings.find((f) => /refuses PerplexityBot/.test(f.finding))!;
    expect(finding).toMatchObject({ severity: "high", category: "geo", url: "https://acme.co.za/" });
    expect(finding.finding).toMatch(/Cloudflare/);
    const healthy = await runGeoAudit(site().fetcher, input);
    expect(result.breakdown.crawlers.earned).toBeLessThan(healthy.breakdown.crawlers.earned);
  });

  it("does not count robots.txt as checked when it fails with a server error, and says so", async () => {
    const { fetcher } = site({ "https://acme.co.za/robots.txt": () => reply(503) });
    const result = await runGeoAudit(fetcher, input);
    expect(result.breakdown.crawlers.evaluated).toBe(false);
    expect(result.crawlers).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.notes.join(" ")).toMatch(/robots.txt answers HTTP 503/);
  });

  it("scores a site that blocks AI search low and points at the file", async () => {
    const { fetcher } = site({
      "https://acme.co.za/robots.txt": () => reply(200, "User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n"),
      "https://acme.co.za/llms.txt": () => reply(404),
      "https://acme.co.za/": () => reply(200, page(""), {}, "https://acme.co.za/"),
    });
    const result = await runGeoAudit(fetcher, { ...input, pages: ["https://acme.co.za/about"] });
    const high = result.findings.filter((f) => f.severity === "high").map((f) => f.finding);
    expect(high.some((f) => f.includes("OAI-SearchBot"))).toBe(true);
    expect(high.some((f) => f.includes("PerplexityBot"))).toBe(true);
    expect(result.findings.find((f) => f.finding.includes("GPTBot"))!.severity).toBe("info");
    expect(result.llms).toMatchObject({ quality: "missing" });
    expect(result.entity).toMatchObject({ found: false });
    expect(result.score).toBeLessThan(70);
  });

  it("checks listings: a listing without the business name or the phone is a finding, a matching one is not", async () => {
    const { fetcher } = site({
      "https://yell.example/acme": () => reply(200, "<html><body>Acme Accounting. Phone 031 555 0100. " + "x ".repeat(100) + "</body></html>"),
      "https://brabys.example/acme": () => reply(200, "<html><body>Acme Acounting. Phone 031 555 0111. " + "x ".repeat(100) + "</body></html>"),
      "https://cylex.example/acme": () => reply(200, "<html><body>ACME ACCOUNTING (Pty) Ltd. Call 031 555 0111." + "x ".repeat(100) + "</body></html>"),
    });
    const result = await runGeoAudit(fetcher, {
      ...input,
      phone: "+27 31 555 0100",
      directories: [{ url: "https://yell.example/acme", source: "Yell" }, { url: "https://brabys.example/acme", source: "Brabys" }, { url: "https://cylex.example/acme", source: "Cylex" }],
    });
    expect(result.directories.map((d) => [d.source, d.nameFound, d.phoneFound])).toEqual([["Yell", true, true], ["Brabys", false, false], ["Cylex", true, false]]);
    const messages = result.findings.filter((f) => f.severity === "medium").map((f) => f.finding);
    expect(messages.some((m) => /Brabys listing does not show the business name/.test(m))).toBe(true);
    expect(messages.some((m) => /Cylex listing does not show the phone number/.test(m))).toBe(true);
    expect(messages.some((m) => /Yell/.test(m))).toBe(false);
    expect(result.breakdown.brand.possible).toBe(15);
  });

  it("survives a site that does not answer at all", async () => {
    const fetcher: SiteFetcher = async () => {
      throw new Error("connection refused");
    };
    const result = await runGeoAudit(fetcher, input);
    expect(result.score).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.findings).toEqual([]);
  });
});


describe("what an audit has checked (so a re-run only closes what it could judge)", () => {
  const input = { siteUrl: "https://acme.co.za", needsAddress: true, brandNames: ["Acme Accounting"] };
  const home = "https://acme.co.za/";
  const urlsOf = (result: Awaited<ReturnType<typeof runGeoAudit>>) => [...new Set(result.covered.map((c) => c.url))].sort();

  it("lists every resource that answered, and only those", async () => {
    const result = await runGeoAudit(site().fetcher, input);
    expect(urlsOf(result)).toEqual([
      "https://acme.co.za/", // the home page (its answers, schema, snippet rules and bot probes)
      "https://acme.co.za/about",
      "https://acme.co.za/contact",
      "https://acme.co.za/llms.txt",
      "https://acme.co.za/robots.txt",
      "https://www.facebook.com/acmeaccounting", // a profile that matched
      "https://www.hellopeter.com/acme", // a profile that is broken: a verdict
      // LinkedIn answered 999 (it refuses bots): no verdict, so it is not listed.
    ]);
    expect(result.covered.every((c) => c.category === "geo")).toBe(true);
  });

  it("does not list robots.txt or the home page when they fail with a server error, so what an earlier audit found there stays open", async () => {
    const { fetcher } = site({ "https://acme.co.za/robots.txt": () => reply(503), "https://acme.co.za/": () => reply(503) });
    const result = await runGeoAudit(fetcher, input);
    // The answers section still ran (the sitemap and two pages answered), so the audit is stored: the point is what it must not close.
    expect(result.breakdown.answers.evaluated).toBe(true);
    expect(urlsOf(result)).not.toContain("https://acme.co.za/robots.txt");
    expect(urlsOf(result)).not.toContain(home);
    expect(urlsOf(result)).toEqual(expect.arrayContaining(["https://acme.co.za/about", "https://acme.co.za/llms.txt"]));
    expect(result.notes.join(" ")).toMatch(/robots.txt answers HTTP 503/);
    expect(result.notes.join(" ")).toMatch(/The home page answers HTTP 503/);
  });

  it("does not list a file or page whose fetch threw", async () => {
    const { fetcher } = site({
      "https://acme.co.za/robots.txt": () => {
        throw new Error("timeout");
      },
      "https://acme.co.za/": () => {
        throw new Error("timeout");
      },
    });
    const result = await runGeoAudit(fetcher, input);
    expect(urlsOf(result)).not.toContain("https://acme.co.za/robots.txt");
    expect(urlsOf(result)).not.toContain(home);
  });

  it("does not judge llms.txt on a server error: no 'missing' finding, not scored, not listed", async () => {
    const { fetcher } = site({ "https://acme.co.za/llms.txt": () => reply(503) });
    const result = await runGeoAudit(fetcher, input);
    expect(result.llms).toBeNull();
    expect(result.breakdown.llms.evaluated).toBe(false);
    expect(result.findings.some((f) => /llms\.txt/.test(f.finding))).toBe(false);
    expect(urlsOf(result)).not.toContain("https://acme.co.za/llms.txt");
    expect(result.notes.join(" ")).toMatch(/llms.txt answers HTTP 503/);
    // A real 404 is a verdict: missing, listed.
    const missing = await runGeoAudit(site({ "https://acme.co.za/llms.txt": () => reply(404) }).fetcher, input);
    expect(missing.llms).toMatchObject({ quality: "missing" });
    expect(urlsOf(missing)).toContain("https://acme.co.za/llms.txt");
  });

  it("lists a page llms.txt points at only when it answered, and a 404 there is a finding", async () => {
    const { fetcher } = site({
      "https://acme.co.za/about": () => reply(503),
      "https://acme.co.za/contact": () => reply(404),
    });
    const result = await runGeoAudit(fetcher, input);
    // llms.txt lists home, about and contact. About is a server error (no verdict, no finding, not listed); contact is a 404 (a finding, listed).
    expect(result.findings.some((f) => f.url === "https://acme.co.za/contact" && /answers HTTP 404/.test(f.finding))).toBe(true);
    expect(result.findings.some((f) => f.url === "https://acme.co.za/about")).toBe(false);
    expect(urlsOf(result)).not.toContain("https://acme.co.za/about");
    expect(urlsOf(result)).toContain("https://acme.co.za/contact");
    // A redirect answer is not a broken page.
    const redirected = await runGeoAudit(site({ "https://acme.co.za/contact": () => reply(302) }).fetcher, input);
    expect(redirected.findings.some((f) => f.url === "https://acme.co.za/contact" && /answers HTTP/.test(f.finding))).toBe(false);
  });

  it("lists a profile or listing only when it gave a verdict, and leaves a listing that errored out of the score", async () => {
    const { fetcher } = site({
      "https://www.facebook.com/acmeaccounting": () => reply(503),
      "https://yell.example/acme": () => reply(503),
      "https://brabys.example/acme": () => reply(200, "<html><body>Acme Accounting. Phone 031 555 0100. " + "x ".repeat(100) + "</body></html>"),
    });
    const result = await runGeoAudit(fetcher, { ...input, phone: "+27 31 555 0100", directories: [{ url: "https://yell.example/acme", source: "Yell" }, { url: "https://brabys.example/acme", source: "Brabys" }] });
    expect(urlsOf(result)).not.toContain("https://www.facebook.com/acmeaccounting"); // 503: unverifiable
    expect(urlsOf(result)).not.toContain("https://yell.example/acme"); // 503: not counted
    expect(urlsOf(result)).toContain("https://brabys.example/acme");
    expect(result.directories.map((d) => d.source)).toEqual(["Brabys"]);
    expect(result.findings.some((f) => /Yell listing no longer loads/.test(f.finding))).toBe(false);
    expect(result.notes.join(" ")).toMatch(/1 listing did not answer/);
  });

  it("an audit of another site (probe off) sends no bot user agent", async () => {
    const { fetcher, calls } = site();
    const result = await runGeoAudit(fetcher, { ...input, probe: false });
    expect(calls.filter((c) => /\[(OAI-SearchBot|Claude-SearchBot|PerplexityBot|GPTBot|ClaudeBot)\]/.test(c))).toEqual([]);
    expect(result.serverProbes).toEqual([]);
    const probed = await runGeoAudit(site().fetcher, input);
    expect(probed.serverProbes).toHaveLength(5);
  });
});

describe("confirming a refusal before it is believed", () => {
  const input = { siteUrl: "https://acme.co.za", needsAddress: true, brandNames: ["Acme Accounting"] };
  const noLlms = { "https://acme.co.za/llms.txt": () => reply(404) };
  /** A home page that refuses the bots named, for the first `times` of their requests (all of them when omitted). */
  function refusing(tokens: string[], opts: { times?: number; plain?: (n: number) => ReturnType<typeof reply> | undefined } = {}) {
    const seen = new Map<string, number>();
    let plain = 0;
    return {
      ...noLlms,
      "https://acme.co.za/": (ua: string) => {
        const token = tokens.find((t) => ua.includes(t));
        if (token) {
          const n = (seen.get(token) ?? 0) + 1;
          seen.set(token, n);
          if (opts.times == null || n <= opts.times) return reply(403, "Forbidden");
        }
        if (!ua) {
          plain += 1;
          const custom = opts.plain?.(plain);
          if (custom) return custom;
        }
        return reply(200, GOOD_HOME, {}, "https://acme.co.za/");
      },
    };
  }

  it("keeps a refusal that repeats while an ordinary request works, after one extra request each", async () => {
    const { fetcher, calls } = site(refusing(["PerplexityBot"]));
    const result = await runGeoAudit(fetcher, input);
    expect(result.serverProbes.filter((p) => p.blocked).map((p) => p.token)).toEqual(["PerplexityBot"]);
    expect(calls.filter((c) => c.includes("[PerplexityBot]"))).toHaveLength(2); // the probe and its confirmation
    expect(calls.filter((c) => c.includes("[OAI-SearchBot]"))).toHaveLength(1); // a bot that got through is not asked again
    expect(result.findings.some((f) => /refuses PerplexityBot/.test(f.finding))).toBe(true);
    // Everything was judged: nothing is held back from a re-run.
    expect(result.covered.find((c) => c.url === "https://acme.co.za/")!.keepOpen).toBeUndefined();
  });

  it("does not count a refusal that is gone the second time (a blip), and says so", async () => {
    const { fetcher } = site(refusing(["PerplexityBot"], { times: 1 }));
    const result = await runGeoAudit(fetcher, input);
    expect(result.serverProbes.find((p) => p.token === "PerplexityBot")).toMatchObject({ blocked: false, status: 200 });
    expect(result.findings.some((f) => /refuses PerplexityBot/.test(f.finding))).toBe(false);
    expect(result.notes.join(" ")).toMatch(/PerplexityBot was refused once and got through the second time/);
  });

  it("does not count refusals while an ordinary request is refused too (rate limiting), and keeps earlier findings about those bots open", async () => {
    const { fetcher } = site(refusing(["PerplexityBot", "OAI-SearchBot"], { plain: (n) => (n >= 2 ? reply(429, "Too many requests") : undefined) }));
    const result = await runGeoAudit(fetcher, input);
    expect(result.serverProbes.map((p) => p.token).sort()).toEqual(["Claude-SearchBot", "ClaudeBot", "GPTBot"]);
    expect(result.findings.some((f) => /The server refuses/.test(f.finding))).toBe(false);
    expect(result.notes.join(" ")).toMatch(/OAI-SearchBot, PerplexityBot got refused, but an ordinary request a moment later answered HTTP 429 too: that looks like rate limiting/);
    // The home page is covered, but not what it said about the two bots this run could not judge.
    const keep = result.covered.find((c) => c.url === "https://acme.co.za/")!.keepOpen!;
    expect(keep("The server refuses PerplexityBot (HTTP 403) although robots.txt may allow it: AI search cannot read the site.")).toBe(true);
    expect(keep("The server refuses OAI-SearchBot (HTTP 403) although robots.txt may allow it: AI search cannot read the site.")).toBe(true);
    expect(keep("The server refuses Claude-SearchBot (HTTP 403) although robots.txt may allow it")).toBe(false);
    expect(keep("Organization data: logo is missing")).toBe(false);
    // The re-run does not flag the bots either.
    expect(result.breakdown.crawlers.earned).toBe(30);
  });

  it("never confirms, flags or scores a refused training crawler: that is the client's choice", async () => {
    const { fetcher, calls } = site(refusing(["GPTBot", "ClaudeBot"]));
    const result = await runGeoAudit(fetcher, input);
    expect(result.serverProbes.filter((p) => p.blocked).map((p) => p.token).sort()).toEqual(["ClaudeBot", "GPTBot"]);
    expect(calls.filter((c) => c.includes("[GPTBot]"))).toHaveLength(1);
    expect(result.findings.filter((f) => /GPTBot|ClaudeBot/.test(f.finding)).every((f) => f.severity === "info")).toBe(true);
    expect(result.findings.some((f) => f.severity === "high")).toBe(false);
    expect(result.breakdown.crawlers.earned).toBe(30);
  });

  it("confirmRefusals leaves a run with nothing refused alone, and a refusal it cannot re-check is not counted", async () => {
    const ok = { token: "PerplexityBot", kind: "search" as const, status: 200, blocked: false, detail: null };
    const calls: string[] = [];
    const fetcher: SiteFetcher = async (url) => {
      calls.push(url);
      return reply(200, "<html>fine</html>");
    };
    expect(await confirmRefusals(fetcher, "https://acme.co.za/", [ok], Date.now() + 5_000)).toEqual({ probes: [ok], undecided: [], notes: [] });
    expect(calls).toEqual([]);
    // The deadline has passed: nothing can be re-checked, so the refusal is undecided, not believed.
    const refused = { ...ok, status: 403, blocked: true, detail: "HTTP 403" };
    const late = await confirmRefusals(fetcher, "https://acme.co.za/", [refused], Date.now() - 1);
    expect(late.probes).toEqual([]);
    expect(late.undecided).toEqual(["PerplexityBot"]);
  });
});
