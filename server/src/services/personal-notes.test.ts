import { describe, expect, it } from "vitest";
import {
  createPersonalNoteSchema,
  openDailyPersonalNoteSchema,
  schedulePersonalNoteHandoffSchema,
  splitPersonalNoteChecklistSchema,
  updatePersonalNoteSchema,
} from "@paperclipai/shared";
import {
  buildPersonalNoteHandoffDescription,
  computeNextRecurrence,
} from "./personal-notes.js";

describe("personal notes handoff and schemas", () => {
  it("formats instructions, body, and tags into the handoff description", () => {
    const desc = buildPersonalNoteHandoffDescription({
      body: "Draft the Q4 launch checklist.",
      tags: ["launch", "q4"],
      scheduledInstructions: "Assign subtasks to SEO and Social.",
    });

    expect(desc).toContain("## Instructions");
    expect(desc).toContain("Assign subtasks to SEO and Social.");
    expect(desc).toContain("Draft the Q4 launch checklist.");
    expect(desc).toContain("_Tags: #launch #q4_");
  });

  it("deduplicates tags and applies defaults in createPersonalNoteSchema", () => {
    const parsed = createPersonalNoteSchema.parse({
      title: "  Weekly priorities  ",
      tags: ["ops", "ops", "  sales "],
    });
    expect(parsed.title).toBe("Weekly priorities");
    expect(parsed.body).toBe("");
    expect(parsed.tags).toEqual(["ops", "sales"]);
    expect(parsed.color).toBe("default");
    expect(parsed.pinned).toBe(false);
    expect(parsed.projectId).toBeNull();
    expect(parsed.dailyDate).toBeNull();
  });

  it("validates schedulePersonalNoteHandoffSchema with ISO timestamps and recurrence", () => {
    const parsed = schedulePersonalNoteHandoffSchema.parse({
      scheduledFor: "2026-11-22T09:00:00.000Z",
      priority: "high",
      issueStatus: "todo",
      instructions: "Run first thing Monday",
      recurrence: "weekly",
    });
    expect(parsed.scheduledFor).toBe("2026-11-22T09:00:00.000Z");
    expect(parsed.priority).toBe("high");
    expect(parsed.issueStatus).toBe("todo");
    expect(parsed.recurrence).toBe("weekly");
    expect(parsed.agentId).toBeNull();
  });

  it("computes next recurrence dates accurately including weekdays skipping weekends", () => {
    // 2026-11-20 is a Friday
    const friday = new Date("2026-11-20T09:00:00.000Z");
    expect(computeNextRecurrence(friday, "none")).toBeNull();
    expect(computeNextRecurrence(friday, "daily")?.toISOString()).toBe("2026-11-21T09:00:00.000Z");
    expect(computeNextRecurrence(friday, "weekdays")?.toISOString()).toBe("2026-11-23T09:00:00.000Z");
    expect(computeNextRecurrence(friday, "weekly")?.toISOString()).toBe("2026-11-27T09:00:00.000Z");
    expect(computeNextRecurrence(friday, "monthly")?.toISOString()).toBe("2026-12-20T09:00:00.000Z");
  });

  it("validates split checklist and daily note schemas", () => {
    const split = splitPersonalNoteChecklistSchema.parse({
      items: ["Audit homepage SEO", "Draft newsletter"],
      priority: "high",
    });
    expect(split.items).toHaveLength(2);
    expect(split.priority).toBe("high");
    expect(split.issueStatus).toBe("todo");

    const daily = openDailyPersonalNoteSchema.parse({ date: "2026-11-21" });
    expect(daily.date).toBe("2026-11-21");
  });

  it("allows partial updates in updatePersonalNoteSchema", () => {
    const parsed = updatePersonalNoteSchema.parse({ pinned: true, color: "amber" });
    expect(parsed).toEqual({ pinned: true, color: "amber" });
  });
});
