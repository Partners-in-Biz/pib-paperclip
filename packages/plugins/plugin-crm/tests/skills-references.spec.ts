import { describe, expect, it } from "vitest";
import { skillVersion } from "@partnersinbiz/pib-plugin-kit";
import { RATE } from "../src/lead-capture.js";
import { KEY_GRACE_DAYS, MAX_LINKS, MIN_FILL_MS } from "../src/lead-form.js";
import { SERVICES, SERVICE_KEYS } from "../src/services.js";
import { MAX_REMINDERS, DEFAULT_REMIND_AFTER_DAYS } from "../src/client-actions.js";
import { ERASE_DUE_DAYS } from "../src/privacy.js";
import { AT_RISK_BELOW, HEALTH_WEIGHTS, SHARP_DROP, WATCH_BELOW } from "../src/health-score.js";
import { DOMAIN_WARN_DAYS, DOWN_AFTER_MINUTES, TLS_WARN_DAYS } from "../src/monitor-net.js";
import { CANARY_REFERENCE, LEAD_CAPTURE_REFERENCE, NEW_CLIENT_REFERENCE, SERVICES_REFERENCE } from "../src/skills-references.js";
import { CARE_REFERENCE_FILES, CLIENT_CARE_SECTION, CLIENT_REPORT_REFERENCE, CLIENT_REQUESTS_REFERENCE, PRIVACY_POLICY_TEMPLATE, PRIVACY_REFERENCE, SUPPORT_AND_HEALTH_REFERENCE, TERMS_TEMPLATE, COOKIE_NOTICE_TEMPLATE } from "../src/skills-care.js";
import { CARE_TOOLS } from "../src/care-tools.js";
import { NPS_COOLDOWN_DAYS, SLA_HOURS } from "../src/support.js";
import { SKILLS } from "../src/skills.js";
import { CRM_TOOLS } from "../src/tools.js";
import { MAX_NEW_STEPS_PER_RUN } from "../src/service-onboarding.js";
import { ATTRIBUTION_REFERENCE, ESIGN_REFERENCE, GROWTH_REFERENCE_FILES, GROWTH_SECTION, SITE_EVENTS_REFERENCE } from "../src/skills-growth.js";
import { ESIGN_TOOLS } from "../src/esign-tools.js";
import { GROWTH_TOOLS } from "../src/growth-tools.js";
import { DEFAULT_VALID_DAYS, ESIGN_REMIND_AFTER_DAYS, MAX_ESIGN_REMINDERS, MAX_VALID_DAYS, MIN_SIGN_MS, SIGNED_PAGE_DAYS, TEMPLATE_VERSION } from "../src/esign-templates.js";
import { EVENT_KEY_GRACE_DAYS, EVENT_LIMITS, EVENT_RATE, ROLLUP_KEEP_DAYS } from "../src/site-events-form.js";

const records = SKILLS.find((skill) => skill.skillKey === "crm-records")!;
const outbound = SKILLS.find((skill) => skill.skillKey === "crm-outbound")!;
const inbound = SKILLS.find((skill) => skill.skillKey === "inbound-qualify")!;
const NEW_TOOLS = ["create-lead-endpoint", "rotate-lead-key", "list-lead-sources", "update-lead-source", "start-new-client", "create-canary-client", "cleanup-canary"];
const toolNames = new Set(CRM_TOOLS.map((tool) => tool.name));

describe("the CRM skills and their references", () => {
  it("stay within 18,000 characters, with the long material in references", () => {
    for (const skill of SKILLS) expect(skill.markdown!.length, skill.skillKey).toBeLessThanOrEqual(18_000);
    expect(records.files!.map((file) => file.path)).toEqual(["references/services.md", "references/new-client.md", "references/canary.md", ...CARE_REFERENCE_FILES.map((file) => file.path), ...GROWTH_REFERENCE_FILES.map((file) => file.path)]);
    expect(outbound.files!.map((file) => file.path)).toEqual(["references/lead-capture.md"]);
    for (const skill of [records, outbound]) for (const file of skill.files!) expect(file.content.length, file.path).toBeGreaterThan(1_000);
    // Each skill points at its references by the path it ships them under.
    for (const file of records.files!) expect(records.markdown).toContain(file.path);
    expect(outbound.markdown).toContain("references/lead-capture.md");
  });

  it("name every new tool, and every tool they name exists", () => {
    const text = [records.markdown, outbound.markdown, inbound.markdown, SERVICES_REFERENCE, NEW_CLIENT_REFERENCE, CANARY_REFERENCE, LEAD_CAPTURE_REFERENCE, ...CARE_REFERENCE_FILES.map((file) => file.content), ...GROWTH_REFERENCE_FILES.map((file) => file.content)].join("\n");
    for (const name of NEW_TOOLS) {
      expect(toolNames.has(name), name).toBe(true);
      expect(text, name).toContain(`\`${name}\``);
    }
    // Every hyphenated word in backticks is a CRM tool, a job, an HTML attribute of the snippet, or one of the other modules' known names.
    const elsewhere = new Set(["pib-mailbox-draft", "pib-invoice-draft", "pib-crm-records", "pib-crm-outbound", "mailbox-draft", "ask-owner", "get-site-link", "link-site", "create-sprint", "new-client-project", "lead-capture", "services-check", "get-sprint", "list-keywords", "keyword-history", "gsc-query", "audit-summary", "list-ga4-summary", "list-posts", "account-analytics", "post-analytics", "performance-review", "list-campaigns", "campaign-stats", "list-open-invoices", "billing-report", "invoice-detail", "list-threads", "mail-status", "signed-copy"]);
    const tokens = [...text.matchAll(/`([a-z][a-z]*(?:-[a-z]+)+)`/g)].map((match) => match[1]!);
    const unknown = [...new Set(tokens)].filter((token) => !toolNames.has(token) && !elsewhere.has(token) && !token.startsWith("data-") && !SERVICE_KEYS.includes(token as never));
    expect(unknown).toEqual([]);
  });

  it("the Inbound Qualifier is told what a form lead carries and whose a client's form lead is", () => {
    expect(inbound.markdown).toContain("## Website form leads");
    expect(inbound.markdown).toMatch(/marketing box starts unticked/);
    expect(inbound.markdown).toMatch(/Never add that person to our CRM/);
  });

  it("say the same numbers as the code, so the guide cannot drift from the limits", () => {
    expect(LEAD_CAPTURE_REFERENCE).toContain(`${RATE.ipPerMinute} a minute and ${RATE.ipPerHour} an hour per visitor, ${RATE.sourcePerMinute} a minute and 120 an hour per form`);
    expect(LEAD_CAPTURE_REFERENCE).toContain(`under ${MIN_FILL_MS / 1000} seconds`);
    expect(LEAD_CAPTURE_REFERENCE).toContain(`more than three links`);
    expect(MAX_LINKS).toBe(3);
    expect(LEAD_CAPTURE_REFERENCE).toContain(`the old one works ${KEY_GRACE_DAYS} days`);
    expect(SERVICES_REFERENCE).toContain(`up to ${MAX_NEW_STEPS_PER_RUN} new steps per company a day`);
    expect(LEAD_CAPTURE_REFERENCE).toContain("X-PiB-Signature: sha256=");
    expect(NEW_CLIENT_REFERENCE).toContain("POST /api/plugins/partnersinbiz.crm/actions/crm.link-client-project");
  });

  it("list every service in the services table, with its owner role", () => {
    for (const service of SERVICES) {
      expect(SERVICES_REFERENCE).toContain(`| \`${service.key}\` | ${service.label} | ${service.role} |`);
      expect(records.markdown).toContain(service.key);
    }
  });

  it("carry the rules that must not be lost: client leads are the client's, no real send for the canary, work in the client's project", () => {
    expect(LEAD_CAPTURE_REFERENCE).toMatch(/THE CLIENT'S leads/);
    expect(LEAD_CAPTURE_REFERENCE).toMatch(/never added to our contacts, sequences or campaigns/);
    expect(LEAD_CAPTURE_REFERENCE).toMatch(/Never edit the live site by hand/);
    expect(CANARY_REFERENCE).toMatch(/draft or a dry run/);
    expect(CANARY_REFERENCE).toMatch(/@canary\.invalid/);
    expect(NEW_CLIENT_REFERENCE).toMatch(/main only changes with Peet's approval/);
    expect(NEW_CLIENT_REFERENCE).toMatch(/never one per item/);
    // E-sign now exists, and what it is not is said in the guide: a basic electronic signature, never an advanced one.
    expect(records.markdown).not.toMatch(/no e-sign/i);
    expect(ESIGN_REFERENCE).toMatch(/not an advanced electronic signature/);
  });

  it("a change to a reference changes the skill's hash, so every company's copy is refreshed", () => {
    const before = skillVersion(records);
    const changed = { ...records, files: records.files!.map((file) => (file.path === "references/canary.md" ? { ...file, content: `${file.content}\nOne more rule.` } : file)) };
    expect(skillVersion(changed)).not.toBe(before);
    expect(skillVersion(records)).toBe(before);
  });

  it("the client care guidance names every care tool, and says the same numbers as the code", () => {
    const text = [records.markdown, ...CARE_REFERENCE_FILES.map((file) => file.content)].join("\n");
    for (const tool of CARE_TOOLS) expect(text, tool.name).toContain(`\`${tool.name}\``);
    // The skill itself points at each care reference by the path it ships under.
    for (const file of CARE_REFERENCE_FILES) expect(records.markdown, file.path).toContain(file.path);
    expect(CLIENT_CARE_SECTION.length).toBeLessThan(3_500);
    expect(SUPPORT_AND_HEALTH_REFERENCE).toContain(`urgent ${SLA_HOURS.urgent.firstResponse} / ${SLA_HOURS.urgent.resolution}, high ${SLA_HOURS.high.firstResponse} / ${SLA_HOURS.high.resolution}, normal ${SLA_HOURS.normal.firstResponse} / ${SLA_HOURS.normal.resolution}, low ${SLA_HOURS.low.firstResponse} / ${SLA_HOURS.low.resolution}`);
    expect(SUPPORT_AND_HEALTH_REFERENCE).toContain(`once in ${NPS_COOLDOWN_DAYS} days per person`);
    expect(SUPPORT_AND_HEALTH_REFERENCE).toContain(`support load ${HEALTH_WEIGHTS.support}, reply speed ${HEALTH_WEIGHTS.replyLatency}, overdue invoices ${HEALTH_WEIGHTS.billing}, SEO health ${HEALTH_WEIGHTS.seo}, website uptime ${HEALTH_WEIGHTS.uptime}, answers to our requests ${HEALTH_WEIGHTS.responsiveness}, last contact ${HEALTH_WEIGHTS.recency}`);
    expect(SUPPORT_AND_HEALTH_REFERENCE).toContain(`${WATCH_BELOW} and over healthy, ${AT_RISK_BELOW} to ${WATCH_BELOW - 1} watch, under ${AT_RISK_BELOW} at risk`);
    expect(SUPPORT_AND_HEALTH_REFERENCE).toContain(`a fall of ${SHARP_DROP} points`);
    expect(SUPPORT_AND_HEALTH_REFERENCE).toContain(`Down for ${DOWN_AFTER_MINUTES} minutes, a certificate under ${TLS_WARN_DAYS} days or a domain under ${DOMAIN_WARN_DAYS} days`);
    expect(CLIENT_REQUESTS_REFERENCE).toContain(`(default ${DEFAULT_REMIND_AFTER_DAYS})`);
    expect(CLIENT_REQUESTS_REFERENCE).toContain(`After two reminders`);
    expect(MAX_REMINDERS).toBe(2);
    expect(CLIENT_CARE_SECTION).toContain(`after ${DEFAULT_REMIND_AFTER_DAYS} days`);
    expect(PRIVACY_REFERENCE).toContain(`Our target is an answer within ${ERASE_DUE_DAYS} days`);
  });

  it("keep the rules that must not be lost: a person approves every email and every erasure, links the client can open, internal numbers never reach the client", () => {
    expect(CLIENT_REQUESTS_REFERENCE).toMatch(/Nothing is sent until a person marks it done/);
    expect(CLIENT_REQUESTS_REFERENCE).toMatch(/Never a page on our Paperclip board/);
    expect(CLIENT_REPORT_REFERENCE).toMatch(/Internal only, never in the client's copy/);
    expect(CLIENT_REPORT_REFERENCE).toMatch(/Never paste ticket titles, costs or agent names/);
    expect(CLIENT_REPORT_REFERENCE).toMatch(/A report that was sent is never rewritten/);
    expect(PRIVACY_REFERENCE).toMatch(/Irreversible, so a person decides/);
    expect(PRIVACY_REFERENCE).toMatch(/never erase anything yourself|Never to a different address/);
    expect(records.markdown).toMatch(/never erase anything yourself/);
    expect(PRIVACY_REFERENCE).toMatch(/not a yes/);
  });

  it("tell the agent what the code now does about documents, quiet months, withdrawn reminders and .co.za domains", () => {
    expect(CLIENT_REPORT_REFERENCE).toMatch(/\*\*replaced\*\* from them each time you build, so never edit it/);
    expect(CLIENT_REPORT_REFERENCE).toMatch(/documentSaved\` false and a \`documentNote\`/);
    expect(CLIENT_REPORT_REFERENCE).toMatch(/only when the month has something in it/);
    expect(CLIENT_REPORT_REFERENCE).toMatch(/sending company's own name/);
    expect(CLIENT_REQUESTS_REFERENCE).toMatch(/one already waiting for approval is withdrawn/);
    expect(CLIENT_REQUESTS_REFERENCE).toMatch(/could not be sent, the request is cancelled/);
    expect(SUPPORT_AND_HEALTH_REFERENCE).toMatch(/no data for \`\.co\.za\`/);
  });

  it("the privacy policy, terms and cookie notice are templates with placeholders and a plain warning, never finished legal text", () => {
    for (const template of [PRIVACY_POLICY_TEMPLATE, TERMS_TEMPLATE, COOKIE_NOTICE_TEMPLATE]) {
      expect(template).toMatch(/A template, not legal advice/);
      expect(template).toMatch(/approves it/);
      expect(template.match(/\{\{[a-z_ ]+/gi)!.length).toBeGreaterThan(5);
    }
    // POPIA's own headings are in the policy: who, what, why and basis, operators, cross-border, retention, security, rights, the Regulator.
    for (const heading of ["Who we are", "What we collect", "Why we use it, and on what basis", "Who we share it with", "Sending information out of South Africa", "How long we keep it", "How we protect it", "Your rights", "Complaints"]) expect(PRIVACY_POLICY_TEMPLATE, heading).toContain(`## ${heading}`);
    expect(PRIVACY_POLICY_TEMPLATE).toContain("Information Regulator");
    // Nothing legal is asserted as fact where the client must decide it.
    expect(PRIVACY_POLICY_TEMPLATE).not.toMatch(/within 30 days/);
    expect(PRIVACY_POLICY_TEMPLATE).not.toMatch(/\d+ years? as the law/i);
  });
});

describe("the guidance for documents to sign, attribution and site counters", () => {
  it("names every e-sign and growth tool, and the skill points at each reference by the path it ships under", () => {
    const text = [records.markdown, ...GROWTH_REFERENCE_FILES.map((file) => file.content)].join("\n");
    for (const tool of [...ESIGN_TOOLS, ...GROWTH_TOOLS]) expect(text, tool.name).toContain(`\`${tool.name}\``);
    for (const file of GROWTH_REFERENCE_FILES) expect(records.markdown, file.path).toContain(file.path);
    expect(GROWTH_SECTION.length).toBeLessThan(3_500);
    expect(records.markdown!.length).toBeLessThan(17_000);
  });

  it("says the same numbers as the code, so the guide cannot drift from the limits", () => {
    expect(ESIGN_REFERENCE).toContain(`A link is valid ${DEFAULT_VALID_DAYS} days by default (1 to ${MAX_VALID_DAYS})`);
    expect(ESIGN_REFERENCE).toContain(`after ${ESIGN_REMIND_AFTER_DAYS} days, up to ${MAX_ESIGN_REMINDERS}`);
    expect(ESIGN_REFERENCE).toContain(`After ${MAX_ESIGN_REMINDERS} reminders you get an issue`);
    expect(ESIGN_REFERENCE).toContain(`for ${SIGNED_PAGE_DAYS} days`);
    expect(ESIGN_REFERENCE).toContain(`at least ${MIN_SIGN_MS / 1000} seconds on the page`);
    expect(ESIGN_REFERENCE).toContain(`version ${TEMPLATE_VERSION}`);
    expect(SITE_EVENTS_REFERENCE).toContain(`counts older than ${ROLLUP_KEEP_DAYS} days go`);
    expect(SITE_EVENTS_REFERENCE).toContain(`the old one counts ${EVENT_KEY_GRACE_DAYS} more days`);
    expect(SITE_EVENTS_REFERENCE).toContain(`${EVENT_RATE.keyPerMinute} requests a minute per key, ${EVENT_RATE.ipPerMinute} a minute and ${EVENT_RATE.ipPerHour} an hour per visitor, ${EVENT_LIMITS.conversionNamesPerDay} different action names, ${EVENT_LIMITS.pathBucketsPerDay} page groups and ${EVENT_LIMITS.outboundHostsPerDay} outside hosts a day per site`);
  });

  it("keeps the rules that must not be lost: the link is never shown, a basic signature only, nothing is installed on a client's site, no number is made up", () => {
    expect(ESIGN_REFERENCE).toMatch(/Never ask for the link, paste a link, or put one in an issue or a comment/);
    expect(ESIGN_REFERENCE).toMatch(/typed name given with the signer's explicit consent/);
    expect(ESIGN_REFERENCE).toMatch(/drafts no lawyer has reviewed/);
    expect(ESIGN_REFERENCE).toMatch(/never sign, simulate or "test" on a real client's link/i);
    expect(ESIGN_REFERENCE).toMatch(/Outward email is always an approval/);
    expect(records.markdown).toMatch(/you \*\*never read, open, forward or sign from the signing email\*\*/);
    expect(records.markdown).not.toMatch(/you never see it/);
    expect(ESIGN_REFERENCE).toMatch(/never read, open, forward or sign from a signing email/);
    expect(ESIGN_REFERENCE).toMatch(/the email that goes out carries it \(the client's inbox, and the Mailbox's record of what it sent\)/);
    expect(ESIGN_REFERENCE).not.toMatch(/goes only to the client's inbox/);
    expect(records.markdown).toMatch(/you NEVER install it/);
    expect(SITE_EVENTS_REFERENCE).toMatch(/Never put it on a live site yourself/);
    expect(SITE_EVENTS_REFERENCE).toMatch(/no name, email, phone number, form content or visitor id/);
    // What is true of the whole system, not only of the plugin: the host's request log holds each visit's address for a few days.
    expect(SITE_EVENTS_REFERENCE).toMatch(/hosting server's own request log records every request .* IP address, browser and the page path/);
    expect(SITE_EVENTS_REFERENCE).toMatch(/up to 3 days/);
    expect(SITE_EVENTS_REFERENCE).toMatch(/Never tell a client or a visitor that no visitor identifier is kept/);
    expect(SITE_EVENTS_REFERENCE).not.toMatch(/no raw event is stored/);
    expect(records.markdown).toMatch(/the host's request log still holds each visit's address for up to 3 days/);
    // The privacy policy template a client pastes must not say the counter keeps no identifier at all.
    expect(PRIVACY_POLICY_TEMPLATE).toMatch(/the web server that runs the counter briefly records the internet address and browser of each visit \(for up to 3 days\)/);
    expect(PRIVACY_POLICY_TEMPLATE).not.toMatch(/without your name, email or any visitor identifier/);
    expect(SITE_EVENTS_REFERENCE).toMatch(/Counts are estimates/);
    expect(ATTRIBUTION_REFERENCE).toMatch(/never guessed/);
    expect(ATTRIBUTION_REFERENCE).toMatch(/Never estimate one/);
    expect(ATTRIBUTION_REFERENCE).toMatch(/Only record what the client said/);
    expect(ATTRIBUTION_REFERENCE).toMatch(/money is kept per currency and never converted/);
  });

  it("every growth reference is long enough to be worth a reference and short enough to read", () => {
    for (const file of GROWTH_REFERENCE_FILES) {
      expect(file.content.length, file.path).toBeGreaterThan(1_500);
      expect(file.content.length, file.path).toBeLessThan(9_000);
    }
  });

  it("a change to a growth reference changes the skill's hash, so every company's copy is refreshed", () => {
    const before = skillVersion(records);
    const changed = { ...records, files: records.files!.map((file) => (file.path === "references/esign.md" ? { ...file, content: `${file.content}\nOne more rule.` } : file)) };
    expect(skillVersion(changed)).not.toBe(before);
  });
});
