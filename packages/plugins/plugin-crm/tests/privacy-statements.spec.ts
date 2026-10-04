/**
 * What the plugin tells people about privacy and about where a signing link lives must be true of the live system, not only of the plugin.
 * Two facts the first version of the 0.14.0 text got wrong, found by review:
 * - the hosting server keeps every public request (body and headers, so the visitor's IP address and browser) for a few days in its
 *   own request log, outside the plugin's control, so "no visitor identifier is kept" is false for a client's site counter;
 * - the finished signing email carries the link, so it sits in the CRM's outbox and in the Mailbox's own record, not "nowhere else".
 * These checks keep the words and the register honest.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eventInstallSteps, eventSnippet, PRIVACY_NOTES } from "../src/events-embed.js";
import { REGISTER } from "../src/register.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const bullet = (start: string): string => {
  const at = readme.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  const end = readme.indexOf("\n", at);
  return readme.slice(at, end);
};

describe("the site counter's privacy text says what the whole system keeps", () => {
  it("the notes for the client's privacy policy name the host's request log and say what must not be written", () => {
    const text = PRIVACY_NOTES.join("\n");
    expect(text).toMatch(/hosting server's request log also records each request, with the visitor's IP address, browser and the page path, for up to 3 days/);
    expect(text).toMatch(/'we keep no visitor identifier at all' is not true and must not be written/);
    expect(text).toMatch(/keyed hash of the visitor's address for 2 days/);
    // The install steps a developer reads carry the same notes.
    const steps = eventInstallSteps({ writeKey: "pibe_abcdefghijklmnopqrstuvwx", label: "Acme", consentMode: "anonymous" }, { scriptUrl: "https://h/ev.js", frameUrl: "https://h/f.html", endpointUrl: "https://h/ev" }, "acme.co.za").join("\n");
    expect(steps).toContain("request log");
  });

  it("the snippet's comment on the client's site does not claim 'no personal data'", () => {
    const snippet = eventSnippet({ writeKey: "pibe_abcdefghijklmnopqrstuvwx", label: "Acme", consentMode: "anonymous" }, { scriptUrl: "https://h/ev.js", frameUrl: "https://h/f.html", endpointUrl: "https://h/ev" });
    expect(snippet).not.toMatch(/no personal data/);
    expect(snippet).toMatch(/no names or visitor ids/);
  });

  it("the README separates what the plugin keeps from what the host keeps", () => {
    const text = bullet("- **Privacy: what the plugin keeps, and what the system keeps.**");
    expect(text).toContain("plugin_webhook_deliveries");
    expect(text).toMatch(/x-real-ip/);
    expect(text).toMatch(/up to 3 days/);
    expect(text).toMatch(/a client's privacy notice must say that/);
    expect(text).not.toMatch(/nothing is kept beyond a day's count/);
  });

  it("the data-processing register records the request log on the hosting row", () => {
    const hetzner = REGISTER.rows.find((row) => row.id === "hetzner")!;
    expect(hetzner.dataClasses.join(", ")).toMatch(/request log of every public form and signing and counter request \(`plugin_webhook_deliveries`/);
    expect(hetzner.retention).toMatch(/request log until ops purge it \(3 days at the time of writing/);
    expect(hetzner.retention).toMatch(/Mailbox's own send record/);
  });
});

describe("the README says where a signing link lives, truthfully", () => {
  it("names the outbox, the blanking, the Mailbox's own copy and the uuid-only address", () => {
    const text = bullet("- `send-for-signature` opens the **usual client-email approval**");
    expect(text).toMatch(/queued in the CRM's own outbox/);
    expect(text).toMatch(/scrubSettledBody/);
    expect(text).toMatch(/blanks the email's `text` and `html` in the settled outbox row/);
    expect(text).toMatch(/The Mailbox keeps the message it sent/);
    expect(text).toMatch(/must not give an agent read access to the sending mailbox before e-sign is on for a real client/);
    expect(text).not.toMatch(/exists only in the Mailbox request/);
    expect(text).not.toMatch(/the database hold no link/);
    const page = bullet("**The public page**");
    expect(page).toMatch(/uuid only/);
    expect(page).toMatch(/HTTP 500/);
    expect(page).not.toMatch(/plugin key address works too/);
  });
});
