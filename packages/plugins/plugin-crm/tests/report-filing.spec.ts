import { describe, expect, it } from "vitest";
import { currentPeriod } from "../src/report-render.js";
import { answerSend, bootCare, careSeed, CO, decide, issuesWith, sentMail, tool, type Booted, type Route } from "./helpers/care.js";

const PERIOD = currentPeriod(new Date());
const WORK: Route = [/FROM public\.issues/, () => []];
const COST: Route = [/FROM public\.cost_events/, () => []];
const summary = "September was a strong month: more people found you on Google and every support request was answered on the day.";
const SEO = { client: "company:acme", module: "seo", period: PERIOD, headline: [{ label: "Clicks", value: "1,240" }], bullets: ["Moved to position 4."] };

function seed() {
  return careSeed({
    client_profiles: [{ id: "pr1", company_id: CO, client_kind: "company", client_ref: "acme", brand_voice: null, audience: null, services: ["seo"], website: null, booking_link: null, banned_words: [], tone_notes: null, human_owned: [], updated_by: null, updated_at: "2026-09-01T00:00:00Z", services_other: [], services_normalized_at: "2026-09-01T00:00:00Z" }],
    client_projects: [{ id: "cp1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "proj-acme", created_at: "2026-09-01T00:00:00Z" }],
  });
}

async function approveReport(booted: Booted, client: string) {
  await tool(booted.harness, "build-client-report", { client, period: PERIOD });
  if (client === "company:acme") await tool(booted.harness, "record-client-signal", SEO);
  await tool(booted.harness, "set-report-narrative", { client, period: PERIOD, summary });
  const sent = await tool<Record<string, any>>(booted.harness, "send-client-report", { client, period: PERIOD });
  await decide(booted.harness, sent.approvalIssueId, "done", "user");
  return sent;
}

describe("filing a sent monthly report to Drive", () => {
  it("opens one filing issue carrying the report body once it is really sent", async () => {
    const booted = await bootCare({ store: seed(), routes: [WORK, COST] });
    await approveReport(booted, "company:acme");
    const [mail] = sentMail(booted.emit);
    await answerSend(booted.harness, mail.key, "sent");
    const issues = await issuesWith(booted.harness, "crm:drive-file:report:");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.originId).toBe(`crm:drive-file:report:${booted.store.client_reports![0]!.id}`);
    expect(issues[0]!.description).toContain("Deliverables/");
    expect(booted.documents.bodyOf(issues[0]!.id, "report-to-file")).toContain("Clicks: 1,240");
  });

  it("opens none for a canary client's dry-run report", async () => {
    const booted = await bootCare({ store: seed(), routes: [WORK, COST] });
    const canary = await tool<Record<string, any>>(booted.harness, "create-canary-client", {});
    await approveReport(booted, canary.client);
    expect(booted.store.client_reports![0]).toMatchObject({ status: "dry_run" });
    expect(await issuesWith(booted.harness, "crm:drive-file:report:")).toHaveLength(0);
  });
});
