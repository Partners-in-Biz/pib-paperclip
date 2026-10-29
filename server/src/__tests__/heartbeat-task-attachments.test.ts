import { describe, expect, it, vi } from "vitest";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";

vi.mock("../services/cloud-runtime-identity.js", () => ({
  runtimeCanonicalOrigin: vi.fn(() => null),
}));
vi.mock("../config-file.js", () => ({ readConfigFile: vi.fn(() => null) }));

describe("task-level attachments in task markdown", () => {
  const voiceNote = {
    id: "att-1",
    filename: "WhatsApp Audio 2026-10-14 at 13.14.28.opus",
    contentType: "audio/ogg",
    byteSize: 114212,
    contentPath: "/api/attachments/att-1/content",
  };

  it("lists files attached to a title-only task so the agent does not treat it as empty", () => {
    const md = buildPaperclipTaskMarkdown({
      issue: { id: "i1", identifier: "PAR-1", title: "Categories questions", description: null, attachments: [voiceNote] },
    })!;
    expect(md).toContain("Files attached to this task");
    expect(md).toContain("WhatsApp Audio 2026-10-14 at 13.14.28.opus");
    expect(md).toContain("/api/attachments/att-1/content");
    expect(md).toContain("handle-attachments");
  });

  it("adds nothing when the task has no attachments", () => {
    const md = buildPaperclipTaskMarkdown({
      issue: { id: "i1", identifier: "PAR-1", title: "t", description: "d" },
    })!;
    expect(md).not.toContain("Files attached to this task");
  });

  it("does not list task attachments for chat conversations", () => {
    const md = buildPaperclipTaskMarkdown({
      issue: { id: "i1", identifier: "PAR-1", title: "t", conversationAgentId: "a1", attachments: [voiceNote] },
    })!;
    expect(md).not.toContain("Files attached to this task");
  });
});
