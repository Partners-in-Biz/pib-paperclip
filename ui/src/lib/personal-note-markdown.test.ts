import { describe, expect, it } from "vitest";
import type { PersonalNote } from "@paperclipai/shared";
import {
  extractWikiLinks,
  findBacklinks,
  formatNoteAsAgentBrief,
  parseChecklistItems,
  toggleChecklistLine,
} from "./personal-note-markdown";

describe("personal-note-markdown helpers", () => {
  it("parses and toggles markdown checklist items", () => {
    const md = [
      "## Plan",
      "- [ ] Draft Q4 launch post",
      "- [x] Review pricing sheet",
      "- [ ] Email key partners",
    ].join("\n");

    const items = parseChecklistItems(md);
    expect(items).toEqual([
      { lineIndex: 1, checked: false, text: "Draft Q4 launch post" },
      { lineIndex: 2, checked: true, text: "Review pricing sheet" },
      { lineIndex: 3, checked: false, text: "Email key partners" },
    ]);

    const toggled = toggleChecklistLine(md, 1);
    expect(parseChecklistItems(toggled)[0]?.checked).toBe(true);
  });

  it("extracts unique [[Wiki Links]] and finds incoming backlinks", () => {
    const links = extractWikiLinks("See [[Q4 Plan]] and [[Weekly Priorities]] and [[q4 plan]].");
    expect(links).toEqual(["Q4 Plan", "Weekly Priorities"]);

    const base: PersonalNote = {
      id: "n1",
      companyId: "c1",
      userId: "u1",
      title: "Q4 Plan",
      body: "",
      tags: [],
      color: "default",
      pinned: false,
      archived: false,
      projectId: null,
      dailyDate: null,
      scheduledFor: null,
      scheduledAgentId: null,
      scheduledProjectId: null,
      scheduledPriority: "medium",
      scheduledIssueStatus: "todo",
      scheduledInstructions: null,
      scheduledRecurrence: "none",
      scheduledStatus: "none",
      scheduledError: null,
      handedOffIssueId: null,
      handedOffIssueIdentifier: null,
      handedOffIssueTitle: null,
      handedOffAt: null,
      linkedTasks: [],
      createdAt: "2026-11-21T00:00:00.000Z",
      updatedAt: "2026-11-21T00:00:00.000Z",
    };
    const referrer: PersonalNote = {
      ...base,
      id: "n2",
      title: "Daily Note",
      body: "Follow up on [[Q4 Plan]] before Friday.",
    };
    const archivedReferrer: PersonalNote = {
      ...base,
      id: "n3",
      title: "Old Note",
      archived: true,
      body: "References [[Q4 Plan]].",
    };

    const backlinks = findBacklinks(base, [base, referrer, archivedReferrer]);
    expect(backlinks.map((n) => n.id)).toEqual(["n2"]);
  });

  it("formats rough notes into a structured Agent Brief", () => {
    const brief = formatNoteAsAgentBrief(
      "Launch landing page",
      "Need fresh copy before Monday.\n- Update hero headline\n- [ ] Check mobile spacing",
      ["marketing"],
    );

    expect(brief).toContain("## Goal");
    expect(brief).toContain("Launch landing page");
    expect(brief).toContain("## Context");
    expect(brief).toContain("Need fresh copy before Monday.");
    expect(brief).toContain("## Deliverables & Action Items");
    expect(brief).toContain("- [ ] Update hero headline");
    expect(brief).toContain("- [ ] Check mobile spacing");
    expect(brief).toContain("## Done Criteria");
    expect(brief).toContain("#marketing");
  });
});
