import { describe, expect, it } from "vitest";
import { decodeEncodedWords, isBulkMail, headerMap, parseAddressList, parseMessageIds, toMailAddress } from "../src/gmail/headers.js";
import { base64Url, buildMime, encodeHeaderText, encodedWords, formatAddress, htmlToText, messageIdFor } from "../src/gmail/mime.js";

/** Split a MIME document into header block and body at the first blank line. */
function split(doc: string): { headers: string; body: string } {
  const at = doc.indexOf("\r\n\r\n");
  return { headers: doc.slice(0, at), body: doc.slice(at + 4) };
}

function unfold(headers: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of headers.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const at = line.indexOf(":");
    if (at > 0 && !map.has(line.slice(0, at).toLowerCase())) map.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  return map;
}

function partsOf(body: string, boundary: string): string[] {
  const pieces = body.split(`--${boundary}`);
  return pieces.slice(1, -1).map((p) => p.replace(/^\r\n/, "").replace(/\r\n$/, ""));
}

const boundary = (depth: number) => `b${depth}`;

describe("buildMime", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0, 255, 128]);

  it("nests text + html inside mixed with base64 attachments and correct names", () => {
    const doc = buildMime({
      from: { email: "peet@partnersinbiz.online", name: "Partners in Biz" },
      to: [{ email: "ann@client.co.za", name: "Ann Smith" }],
      cc: [{ email: "accounts@client.co.za" }],
      subject: "Invoice INV-0042",
      text: "Hi Ann,\nPlease find your invoice attached.",
      html: "<p>Hi Ann,</p><p>Please find your invoice attached.</p>",
      attachments: [
        { filename: "INV-0042.pdf", mime: "application/pdf", content: pdf },
        { filename: "Fáktuur ë.pdf", mime: "application/pdf", content: pdf },
      ],
      messageId: "<pib.abc@partnersinbiz.online>",
      date: new Date("2026-09-26T10:00:00Z"),
      boundary,
    });
    expect(doc).not.toMatch(/[^\r]\n/); // CRLF only
    const { headers, body } = split(doc);
    const h = unfold(headers);
    expect(h.get("from")).toBe("Partners in Biz <peet@partnersinbiz.online>");
    expect(h.get("to")).toBe("Ann Smith <ann@client.co.za>");
    expect(h.get("cc")).toBe("accounts@client.co.za");
    expect(h.get("subject")).toBe("Invoice INV-0042");
    expect(h.get("message-id")).toBe("<pib.abc@partnersinbiz.online>");
    expect(h.get("date")).toBe("Sat, 26 Sep 2026 10:00:00 +0000");
    expect(h.get("mime-version")).toBe("1.0");
    expect(h.get("content-type")).toBe('multipart/mixed; boundary="b0"');

    const mixed = partsOf(body, "b0");
    expect(mixed).toHaveLength(3);
    const alt = split(mixed[0]!);
    expect(unfold(alt.headers).get("content-type")).toBe('multipart/alternative; boundary="b1"');
    const [plain, html] = partsOf(alt.body, "b1");
    expect(unfold(split(plain!).headers).get("content-type")).toBe('text/plain; charset="UTF-8"');
    expect(Buffer.from(split(plain!).body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hi Ann,\nPlease find your invoice attached.");
    expect(Buffer.from(split(html!).body.replace(/\r\n/g, ""), "base64").toString("utf8")).toContain("<p>Hi Ann,</p>");

    const first = split(mixed[1]!);
    const firstHeaders = unfold(first.headers);
    expect(firstHeaders.get("content-type")).toBe('application/pdf; name="INV-0042.pdf"');
    expect(firstHeaders.get("content-disposition")).toBe('attachment; filename="INV-0042.pdf"');
    expect(firstHeaders.get("content-transfer-encoding")).toBe("base64");
    expect(new Uint8Array(Buffer.from(first.body.replace(/\r\n/g, ""), "base64"))).toEqual(pdf);

    const second = unfold(split(mixed[2]!).headers);
    expect(second.get("content-disposition")).toBe("attachment; filename*=UTF-8''F%C3%A1ktuur%20%C3%AB.pdf");
    expect(decodeEncodedWords(/name="([^"]+)"/.exec(second.get("content-type")!)![1]!)).toBe("Fáktuur ë.pdf");
  });

  it("encodes a UTF-8 subject and display name as RFC 2047 words of at most 75 chars", () => {
    const subject = "Faktuur vir Café Ünïcode — betaling ontvang, dankie! 🎉 ".repeat(3).trim();
    const doc = buildMime({
      from: { email: "peet@partnersinbiz.online", name: "Pieter Stândér" },
      to: [{ email: "x@y.co" }],
      subject,
      text: "hallo",
      boundary,
    });
    const { headers } = split(doc);
    const subjectLines = headers.split("\r\n").filter((line, i, all) => line.startsWith("Subject:") || (i > 0 && /^ /.test(line) && all.slice(0, i).reverse().find((l) => !/^ /.test(l))?.startsWith("Subject:")));
    for (const line of subjectLines) {
      for (const word of line.replace(/^Subject: /, "").trim().split(/\s+/)) expect(word.length).toBeLessThanOrEqual(75);
    }
    const h = unfold(headers);
    expect(h.get("subject")).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeEncodedWords(h.get("subject")!)).toBe(subject);
    expect(decodeEncodedWords(h.get("from")!)).toBe("Pieter Stândér <peet@partnersinbiz.online>");
    // Never split a multi-byte character across words.
    for (const word of encodedWords("é".repeat(100))) {
      const payload = /=\?UTF-8\?B\?(.+)\?=/.exec(word)![1]!;
      expect(Buffer.from(payload, "base64").toString("utf8")).toMatch(/^é+$/);
    }
  });

  it("builds a single text part without attachments or html, and a text alternative for html only", () => {
    const plainOnly = buildMime({ from: { email: "a@b.co" }, to: [{ email: "c@d.co" }], subject: "Hi", text: "Just text", boundary });
    expect(unfold(split(plainOnly).headers).get("content-type")).toBe('text/plain; charset="UTF-8"');
    const htmlOnly = buildMime({ from: { email: "a@b.co" }, to: [{ email: "c@d.co" }], subject: "Hi", html: "<p>Hello <b>there</b></p><p><a href=\"https://x.co\">Pay</a></p>", boundary });
    const parts = partsOf(split(htmlOnly).body, "b1");
    expect(parts).toHaveLength(2);
    expect(Buffer.from(split(parts[0]!).body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hello there\nPay (https://x.co)");
  });

  it("adds reply headers, strips header injection and needs a recipient", () => {
    const doc = buildMime({
      from: { email: "a@b.co" },
      to: [{ email: "c@d.co" }],
      subject: "Re: Quote\r\nBcc: evil@x.co",
      text: "ok",
      inReplyTo: "<orig@d.co>",
      references: ["<first@d.co>", "<orig@d.co>"],
      boundary,
    });
    const h = unfold(split(doc).headers);
    expect(h.get("subject")).toBe("Re: Quote Bcc: evil@x.co");
    expect(h.has("bcc")).toBe(false);
    expect(h.get("in-reply-to")).toBe("<orig@d.co>");
    expect(h.get("references")).toBe("<first@d.co> <orig@d.co>");
    expect(() => buildMime({ from: { email: "a@b.co" }, to: [], subject: "x", text: "y" })).toThrow(/recipient/);
  });

  it("quotes display names with specials and makes stable Message-IDs", () => {
    expect(formatAddress({ email: "a@b.co", name: 'Smith, "Jo"' })).toBe('"Smith, \\"Jo\\"" <a@b.co>');
    expect(encodeHeaderText("plain ascii")).toBe("plain ascii");
    expect(messageIdFor("billing:invoice:1:send", "peet@partnersinbiz.online")).toBe(messageIdFor("billing:invoice:1:send", "peet@partnersinbiz.online"));
    expect(messageIdFor("billing:invoice:1:send", "peet@partnersinbiz.online")).toMatch(/^<pib\.[0-9a-f]{32}@partnersinbiz\.online>$/);
    expect(base64Url("hi?>")).toBe("aGk_Pg");
    expect(htmlToText("<style>x{}</style><p>A&amp;B</p><ul><li>one</li></ul>")).toBe("A&B\n- one");
  });
});

describe("headers", () => {
  it("parses address lists with quoted commas and encoded names", () => {
    const list = parseAddressList('"Smith, Ann" <Ann@Client.co.za>, =?UTF-8?B?w4lsaXNl?= <elise@x.fr>, bob@y.com, not-an-address');
    expect(list).toEqual([
      { email: "ann@client.co.za", name: "Smith, Ann" },
      { email: "elise@x.fr", name: "Élise" },
      { email: "bob@y.com", name: null },
    ]);
    expect(toMailAddress("Ann <ann@x.co>")).toEqual({ email: "ann@x.co", name: "Ann" });
    expect(toMailAddress({ email: "bad address" })).toBeNull();
    expect(parseMessageIds("<a@x> <b@y>\r\n <a@x>")).toEqual(["<a@x>", "<b@y>"]);
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9_ol=E9?=")).toBe("Café olé");
  });

  it("flags list and automated mail as bulk", () => {
    expect(isBulkMail(headerMap([{ name: "List-Unsubscribe", value: "<mailto:x>" }]), { email: "news@shop.com" })).toBe(true);
    expect(isBulkMail(headerMap([]), { email: "no-reply@bank.co.za" })).toBe(true);
    expect(isBulkMail(headerMap([]), { email: "ann@client.co.za" })).toBe(false);
  });
});
