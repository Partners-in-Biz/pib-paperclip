import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HostedUsageListed } from "../src/hosted-usage.js";
import { HostedView, formatUsd, monthLabel, monthOptions } from "../src/ui/hosted.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const row = (over: Partial<HostedUsageListed> = {}): HostedUsageListed => ({
  hostedCompanyId: "h1", companyName: "Acme Hosting", month: "2026-10-01", runs: 12, notionalUsd: 1234.5, doneIssues: 3, agents: 4, computedAt: "2026-10-25T02:00:00.000Z", ...over,
});
const render = (state: Parameters<typeof HostedView>[0]["state"]) => renderToStaticMarkup(createElement(HostedView, { state, now: NOW, onRetry: () => {} }));

describe("Hosted clients view", () => {
  it("formats months and money", () => {
    expect(monthOptions(NOW)).toEqual(["2026-10-01", "2026-09-01", "2026-08-01", "2026-07-01", "2026-06-01", "2026-05-01"]);
    expect(monthOptions(new Date("2026-01-31T23:30:00.000Z"))[0]).toBe("2026-02-01");
    expect(monthLabel("2026-10-01")).toBe("October 2026");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("renders the table with the notional and snapshot notes when allowed", () => {
    const html = render({ status: "ready", list: { allowed: true, rows: [row(), row({ hostedCompanyId: "h2", companyName: "Older", month: "2026-09-01" })] } });
    expect(html).toContain("Acme Hosting");
    expect(html).toContain("$1,234.50");
    expect(html).not.toContain("Older");
    expect(html).toContain("notional USD");
    expect(html).toContain("snapshot from the last recompute");
  });

  it("renders the empty state when allowed with no rows", () => {
    expect(render({ status: "ready", list: { allowed: true, rows: [] } })).toContain("No hosted usage recorded for October 2026");
  });

  it("renders only 'not available' when not allowed", () => {
    const html = render({ status: "ready", list: { allowed: false, rows: [] } });
    expect(html).toContain("Not available");
    expect(html).not.toContain("<table");
  });
});

describe("hosted-usage.load", () => {
  it("answers allowed: false for a company that is not the owner", async () => {
    const fake = fakeCtx({});
    registerCockpit(fake.ctx, createEnv(fake.ctx, fixedClock(NOW.toISOString()).now));
    const out = (await fake.actions.get("hosted-usage.load")!({}, { companyId: "company-a", actor: { type: "user", userId: "u" } })) as { allowed: boolean; rows: unknown[] };
    expect(out).toEqual({ allowed: false, rows: [] });
  });
});
