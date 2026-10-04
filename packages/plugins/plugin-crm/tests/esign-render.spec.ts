import { describe, expect, it } from "vitest";
import { formatMoneyMinor } from "@partnersinbiz/pib-plugin-kit";
import { renderTemplate, TEMPLATE_KEYS, TEMPLATE_NOTICE, TEMPLATE_VERSION, TEMPLATES, templateSource, type TemplateContext } from "../src/esign-templates.js";
import {
  brandOf,
  consentTextFor,
  dateLabel,
  dateTimeLabel,
  markdownToHtml,
  markdownToText,
  normaliseContent,
  renderSignedHtml,
  renderSignedMarkdown,
  renderSignPage,
  safeColor,
  sha256Hex,
  SIGNATURE_TYPE,
} from "../src/esign-render.js";

const money = (minor: number, currency: string) => formatMoneyMinor(minor, currency);

function ctx(vars: Record<string, unknown>, extra: Partial<TemplateContext> = {}): TemplateContext {
  return { title: "SEO retainer", clientName: "Acme Plumbing", companyName: "Partners in Biz", currency: "ZAR", validLine: "Valid until 17 Oct 2026.", vars, money, ...extra };
}

describe("the document templates", () => {
  it("are drafts that say so only to the people who approve them, never in the text a client reads", () => {
    expect(TEMPLATE_NOTICE).toMatch(/not legal advice/i);
    expect(TEMPLATE_NOTICE).toMatch(/not an advanced electronic signature/i);
    for (const key of TEMPLATE_KEYS) expect(templateSource(key)!, key).not.toMatch(/legal advice|draft/i);
    expect(TEMPLATE_VERSION).toMatch(/^\d{4}-\d{2}-v\d+$/);
  });

  it("use only placeholders the renderer knows, and leave none behind", () => {
    const given = { scope: "Monthly SEO work.", lines: [{ description: "Audit", unitMinor: 150_000 }], total: 150_000 };
    for (const info of TEMPLATES) {
      const out = renderTemplate(info.key, ctx(given));
      expect(out.markdown, info.key).not.toMatch(/\{\{|\}\}/);
      expect(out.markdown, info.key).toContain("Acme Plumbing");
      expect(out.markdown, info.key).toContain("Partners in Biz");
      expect(out.markdown.startsWith("# "), info.key).toBe(true);
      expect(out.kind).toBe(info.kind);
    }
  });

  it("asks for what is missing in plain words", () => {
    expect(() => renderTemplate("proposal", ctx({}))).toThrow(/needs: scope/);
    expect(() => renderTemplate("service-agreement", ctx({}))).toThrow(/needs: scope/);
    expect(() => renderTemplate("quote", ctx({}))).toThrow(/lines .* or a total/);
    expect(() => renderTemplate("nope", ctx({ scope: "x" }))).toThrow(/template must be one of/);
  });

  it("works out a quote from its lines, with and without VAT, and rounds to the cent", () => {
    const plain = renderTemplate("quote", ctx({ quote_number: "Q-0007", lines: [{ description: "Site audit", quantity: 2, unitMinor: 150_000 }, { description: "Hours", quantity: 1.5, unitMinor: 33_333 }] }));
    expect(plain.totalMinor).toBe(300_000 + 50_000);
    expect(plain.markdown).toContain("# Quote Q-0007");
    expect(plain.markdown).toContain("| Site audit | 2 | R 1,500.00 | R 3,000.00 |");
    const vat = renderTemplate("quote", ctx({ lines: [{ description: "Work", unitMinor: 100_000 }], vat_percent: 15 }));
    expect(vat.totalMinor).toBe(115_000);
    expect(vat.markdown).toContain("plus VAT at 15%");
    expect(() => renderTemplate("quote", ctx({ lines: [{ description: "x", unitMinor: -1 }] }))).toThrow(/whole number of cents/);
    expect(() => renderTemplate("quote", ctx({ lines: [{ description: "x", unitMinor: 5, quantity: 0 }] }))).toThrow(/quantity/);
    expect(() => renderTemplate("quote", ctx({ lines: [{ description: "x", unitMinor: 5 }], vat_percent: 400 }))).toThrow(/vat_percent/);
  });

  it("a quote from a Billing total alone still carries the total", () => {
    const out = renderTemplate("quote", ctx({ total: 250_000, quote_number: "Q-1" }));
    expect(out.totalMinor).toBe(250_000);
    expect(out.markdown).toContain("R 2,500.00");
  });

  it("states a proposal's price and an agreement's fee when given in cents", () => {
    expect(renderTemplate("proposal", ctx({ scope: "x", priceMinor: 450_000, price: "Monthly fee" })).markdown).toContain("Monthly fee: **R 4,500.00**");
    expect(renderTemplate("service-agreement", ctx({ scope: "x", feesMinor: 99_900, notice_days: "60" })).markdown).toContain("**R 999.00**");
    expect(renderTemplate("service-agreement", ctx({ scope: "x", notice_days: "60" })).markdown).toContain("60 days' written notice");
  });

  it("cannot be bent by a value: a one-line value cannot start a heading, and {{ }} text is refused", () => {
    const out = renderTemplate("proposal", ctx({ scope: "Work." }, { clientName: "Acme\n\n# Fake heading\n- item" }));
    expect(out.markdown).toContain("**Acme # Fake heading - item**");
    expect(out.markdown).not.toMatch(/^# Fake heading/m);
    expect(() => renderTemplate("proposal", ctx({ scope: "Hello {{client_name}}" }))).toThrow(/reserved/);
  });
});

describe("markdown to HTML", () => {
  it("renders the subset the templates use", () => {
    const html = markdownToHtml("# Title\n\nSome **bold** and *soft* text with `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> note\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>soft</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<blockquote><p>note</p></blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
  });

  it("escapes everything: markup in a value is shown as text, never run", () => {
    const html = markdownToHtml('Hello <script>alert(1)</script> & "quotes" <img src=x onerror=alert(1)>\n\n# <b>x</b>');
    expect(html).not.toMatch(/<script|<img|<b>/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("links only to https or mailto, and escapes the address and the text", () => {
    const html = markdownToHtml("[ok](https://example.com/a?x=1&y=2) [mail](mailto:hi@example.com) [bad](javascript:alert(1)) [data](data:text/html;base64,AAAA) [quote](https://example.com/\"onmouseover=\"x)");
    expect(html).toContain('<a href="https://example.com/a?x=1&amp;y=2" rel="noopener noreferrer" target="_blank">ok</a>');
    expect(html).toContain('href="mailto:hi@example.com"');
    expect(html).not.toMatch(/href="javascript|href="data:/i);
    expect(html).not.toMatch(/onmouseover=\s*"/);
  });

  it("does not let a control character smuggle a link marker in", () => {
    const html = markdownToHtml("text \u00000\u0000 [a](https://example.com)");
    expect(html.match(/<a /g)?.length).toBe(1);
  });

  it("gives plain text for the email copy", () => {
    const text = markdownToText("# T\n\nSee [the site](https://x.co.za) **now**.\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(text).toBe("T\n\nSee the site (https://x.co.za) now.\n\nA   B\n\n1   2");
  });
});

describe("the content hash", () => {
  it("is the SHA-256 of the exact text, and the same text always gives the same one", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(normaliseContent("a  \r\n\r\n\r\n\r\nb\r\n")).toBe("a\n\nb\n");
    expect(sha256Hex(normaliseContent("# T\r\ntext  "))).toBe(sha256Hex("# T\ntext\n"));
    expect(sha256Hex("a")).not.toBe(sha256Hex("a "));
  });
});

describe("brand and dates", () => {
  it("accepts a hex colour and an https logo, and falls back otherwise", () => {
    expect(safeColor("#ABCDEF", "#000000")).toBe("#abcdef");
    expect(safeColor("red; background:url(x)", "#14304f")).toBe("#14304f");
    const brand = brandOf({ name: "Partners in Biz", primary: "#112233", accent: "javascript:1", logoUrl: "http://insecure.example/logo.png", footer: "Reg 2020/123456/07" });
    expect(brand).toMatchObject({ primary: "#112233", accent: "#2a9d8f", logoUrl: null, footer: "Reg 2020/123456/07" });
    expect(brandOf({ name: "X", logoUrl: "https://cdn.example.com/logo.png" }).logoUrl).toBe("https://cdn.example.com/logo.png");
    expect(brandOf({ name: "X", logoUrl: 'https://cdn.example.com/"onload="x' }).logoUrl).toBeNull();
  });

  it("shows South African dates", () => {
    expect(dateLabel("2026-10-03T22:30:00Z")).toBe("4 Oct 2026");
    expect(dateTimeLabel("2026-10-03T12:05:00Z")).toBe("3 Oct 2026, 14:05 (South African time)");
    expect(dateLabel("nonsense")).toBe("");
  });

  it("words the consent so it names the document and the sender, once", () => {
    const text = consentTextFor({ title: "Proposal: SEO", companyName: "Partners in Biz" });
    expect(text).toBe('I have read "Proposal: SEO" from Partners in Biz and I agree to it. I understand that typing my name below is my electronic signature.');
  });
});

const brand = brandOf({ name: "Partners in Biz", primary: "#112233" });
const base = {
  title: "Proposal: SEO",
  brand,
  recipientName: 'Ada <b>Lovelace</b>',
  bodyHtml: markdownToHtml("# Proposal: SEO\n\nWork."),
  contentSha256: sha256Hex("x"),
  consentText: consentTextFor({ title: "Proposal: SEO", companyName: "Partners in Biz" }),
  consentSha256: sha256Hex("consent"),
  validUntil: "2026-10-17T10:00:00Z",
};

describe("the signing page", () => {
  it("carries the facts the script needs, the consent wording and the fingerprint, and no inline script", () => {
    const html = renderSignPage({ ...base, pageId: "abcdefghijklmnopqrstuvwx", state: "open" });
    expect(html).toContain('data-state="open"');
    expect(html).toContain('data-page="abcdefghijklmnopqrstuvwx"');
    expect(html).toContain(`data-sha="${base.contentSha256}"`);
    expect(html).toContain(`data-consent-sha="${base.consentSha256}"`);
    expect(html).toContain(base.consentText.replace(/"/g, "&quot;"));
    expect(html).toContain("Sign this document");
    expect(html).toContain("open until 17 Oct 2026");
    // Scripts: one external file, none inline.
    expect(html.match(/<script/g)?.length).toBe(1);
    expect(html).toContain('<script src="../sign.js"></script>');
    // The policy sits in an attribute, so its quotes are entities: the browser reads them back as plain quotes.
    expect(html).toContain("script-src &#39;self&#39;");
    expect(html).toContain("default-src &#39;none&#39;");
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).toContain("noindex");
  });

  it("escapes the recipient's name and never prints markup from a value", () => {
    const html = renderSignPage({ ...base, pageId: "abcdefghijklmnopqrstuvwx", state: "open" });
    expect(html).not.toContain("<b>Lovelace</b>");
    expect(html).toContain("Ada &lt;b&gt;Lovelace&lt;/b&gt;");
  });

  it("shows the document and the evidence once signed, and says it is a basic signature", () => {
    const html = renderSignPage({ ...base, pageId: "abcdefghijklmnopqrstuvwx", state: "signed", signed: { signerName: "Ada Lovelace", signedAt: "2026-10-04T08:00:00Z", reference: "doc-1", auditHead: "f".repeat(64) } });
    expect(html).toContain("Signed by <strong>Ada Lovelace</strong>");
    expect(html).toContain(SIGNATURE_TYPE.replace(/'/g, "&#39;"));
    expect(html).toContain("not an advanced electronic signature");
    expect(html).toContain('id="print-button"');
    expect(html).not.toContain('id="sign-button"');
  });

  it("shows no document once declined, expired or withdrawn", () => {
    for (const state of ["declined", "expired", "void"] as const) {
      const html = renderSignPage({ ...base, pageId: "abcdefghijklmnopqrstuvwx", state, declinedAt: "2026-10-04T08:00:00Z" });
      expect(html, state).not.toContain("Work.");
      expect(html, state).not.toContain('id="sign-button"');
    }
    expect(renderSignPage({ ...base, pageId: "abcdefghijklmnopqrstuvwx", state: "expired" })).toContain("This link has expired");
  });

  it("the stored signed copy is a standalone page with no form and no script", () => {
    const html = renderSignedHtml({ ...base, signed: { signerName: "Ada", signedAt: "2026-10-04T08:00:00Z", reference: "doc-1", auditHead: null } });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("sign-button");
    expect(html).toContain("Signed electronically");
  });

  it("the signed Markdown keeps the exact signed text first and the evidence after the rule", () => {
    const content = "# Proposal: SEO\n\nWork.\n";
    const md = renderSignedMarkdown({ content, contentSha256: sha256Hex(content), signed: { signerName: "Ada Lovelace", signedAt: "2026-10-04T08:00:00Z", reference: "doc-1", auditHead: "a".repeat(64) }, companyName: "Partners in Biz", consentText: base.consentText });
    expect(md.startsWith(content.trimEnd())).toBe(true);
    expect(md).toContain(sha256Hex(content));
    expect(md).toContain("Basic electronic signature");
    expect(md).toContain("Audit trail fingerprint: " + "a".repeat(64));
    // The text before the rule hashes to the recorded fingerprint, so a reader can check the copy.
    const before = md.split("\n---\n")[0]!;
    expect(sha256Hex(`${before.trimEnd()}\n`)).toBe(sha256Hex(content));
  });
});
