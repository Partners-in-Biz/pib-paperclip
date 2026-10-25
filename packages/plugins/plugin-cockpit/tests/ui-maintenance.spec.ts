import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MAINTENANCE_WINDOW, type MaintenanceView, type ReleaseNote } from "../src/maintenance.js";
import { MaintenanceBody, formatWindow } from "../src/ui/maintenance.js";

const note = (over: Partial<ReleaseNote> = {}): ReleaseNote => ({
  id: "d1", phase: "planned", plugin: "plugin-billing", version: "0.11.0", reason: "migration",
  windowStartUtc: "2026-10-26T01:00:00.000Z", windowEndUtc: "2026-10-26T04:00:00.000Z", downtimeMinutes: 5,
  postedAt: "2026-10-25T10:00:00.000Z", ...over,
});
const view = (over: Partial<MaintenanceView> = {}): MaintenanceView => ({ window: MAINTENANCE_WINDOW.stopFirst, weekly: MAINTENANCE_WINDOW.weekly, next: null, recent: [], ...over });

describe("Maintenance tab", () => {
  it("shows the window in UTC and SAST", () => {
    expect(formatWindow("2026-10-26T01:00:00.000Z", "2026-10-26T04:00:00.000Z")).toBe("26 Oct, 01:00–04:00 UTC (03:00–06:00 SAST)");
    expect(formatWindow("2026-10-26T23:00:00.000Z", "2026-10-27T02:00:00.000Z")).toContain("27 Oct, 01:00–04:00 SAST");
    expect(formatWindow("nope", "x")).toBe("–");
  });

  it("renders the empty state", () => {
    const html = renderToStaticMarkup(createElement(MaintenanceBody, { view: view() }));
    expect(html).toContain("01:00–04:00");
    expect(html).toContain("03:00–06:00");
    expect(html).toContain("Sundays 03:00 UTC, report only");
    expect(html).toContain("No stop-first release is planned");
    expect(html).toContain("No release notes yet");
  });

  it("renders the next release and phase pills", () => {
    const planned = note();
    const html = renderToStaticMarkup(createElement(MaintenanceBody, { view: view({ next: planned, recent: [note({ id: "d0", phase: "live" }), note({ id: "d2", phase: "cancelled" }), planned] }) }));
    expect(html).toContain("plugin-billing 0.11.0");
    expect(html).toContain("Database change");
    expect(html).toContain("5 minutes");
    for (const label of ["Planned", "Live", "Cancelled"]) expect(html).toContain(label);
  });
});
