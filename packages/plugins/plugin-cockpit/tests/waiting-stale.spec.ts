import { describe, expect, it } from "vitest";
import type { CockpitSnapshot, WaitingItem } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { pruneStaleWaiting } from "../src/brief.js";

const w = (key: string, issueId?: string): WaitingItem => ({ key, title: key, why: "why", kind: "review", issueId });
const snap = (waiting: WaitingItem[]): CockpitSnapshot => ({ plugin: "partnersinbiz.social", waiting } as unknown as CockpitSnapshot);
const keys = (s: CockpitSnapshot[]) => s.flatMap((x) => x.waiting.map((i) => i.key));

describe("pruneStaleWaiting", () => {
  const statuses = new Map([["open", "in_review"], ["done", "done"], ["gone", "cancelled"]]);

  it("drops rows linked to done, cancelled or missing issues", () => {
    const out = pruneStaleWaiting([snap([w("a", "open"), w("b", "done"), w("c", "gone"), w("d", "missing"), w("e")])], statuses);
    expect(keys(out)).toEqual(["a", "e"]);
  });

  it("drops a task row that duplicates its review row", () => {
    const out = pruneStaleWaiting([snap([w("review:t1"), w("task:t1"), w("task:t2")])], statuses);
    expect(keys(out)).toEqual(["review:t1", "task:t2"]);
  });

  it("keeps everything linked when the status lookup failed", () => {
    const out = pruneStaleWaiting([snap([w("a", "missing"), w("review:t1"), w("task:t1")])], null);
    expect(keys(out)).toEqual(["a", "review:t1"]);
  });
});
