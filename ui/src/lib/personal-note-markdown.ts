import type { PersonalNote, PersonalNoteColor } from "@paperclipai/shared";

export interface ChecklistItem {
  lineIndex: number;
  checked: boolean;
  text: string;
}

const CHECKLIST_LINE_RE = /^(\s*[-*]\s+)\[([ xX])\]\s+(.*)$/;
const WIKI_LINK_RE = /\[\[([^\[\]]+)\]\]/g;

export function parseChecklistItems(body: string): ChecklistItem[] {
  const lines = body.split("\n");
  const items: ChecklistItem[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(CHECKLIST_LINE_RE);
    if (!match) continue;
    const text = match[3]!.trim();
    if (!text) continue;
    items.push({
      lineIndex: i,
      checked: match[2]!.toLowerCase() === "x",
      text,
    });
  }
  return items;
}

export function toggleChecklistLine(body: string, lineIndex: number): string {
  const lines = body.split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return body;
  const match = line.match(CHECKLIST_LINE_RE);
  if (!match) return body;
  const nextMark = match[2]!.toLowerCase() === "x" ? " " : "x";
  lines[lineIndex] = `${match[1]}[${nextMark}] ${match[3]}`;
  return lines.join("\n");
}

export function extractWikiLinks(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(WIKI_LINK_RE.source, "g");
  while ((match = re.exec(body)) !== null) {
    const title = match[1]!.trim();
    const key = title.toLowerCase();
    if (title && !seen.has(key)) {
      seen.add(key);
      found.push(title);
    }
  }
  return found;
}

export function findBacklinks(targetNote: PersonalNote, allNotes: PersonalNote[]): PersonalNote[] {
  const targetTitleLower = targetNote.title.trim().toLowerCase();
  if (!targetTitleLower) return [];
  return allNotes.filter((other) => {
    if (other.id === targetNote.id || other.archived) return false;
    const links = extractWikiLinks(other.body);
    return links.some((link) => link.toLowerCase() === targetTitleLower);
  });
}

/**
 * Turns rough bullets / brain-dump notes into a clean, agent-ready brief
 * (Goal, Context, Deliverables, Done Criteria) so agents can execute on the first run.
 */
export function formatNoteAsAgentBrief(title: string, body: string, tags: string[] = []): string {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const checklistItems: string[] = [];
  const contextLines: string[] = [];

  for (const line of lines) {
    const checkMatch = line.match(CHECKLIST_LINE_RE);
    if (checkMatch) {
      checklistItems.push(`- [${checkMatch[2]!.toLowerCase() === "x" ? "x" : " "}] ${checkMatch[3]!.trim()}`);
    } else if (/^[-*•]\s+/.test(line)) {
      checklistItems.push(`- [ ] ${line.replace(/^[-*•]\s+/, "").trim()}`);
    } else if (!/^#{1,6}\s+/.test(line)) {
      contextLines.push(line);
    }
  }

  const sections: string[] = [
    "## Goal",
    title.trim() || "Complete the work outlined below.",
    "",
    "## Context",
    contextLines.length > 0
      ? contextLines.join("\n\n")
      : "_Add any background, links, or constraints here._",
    "",
    "## Deliverables & Action Items",
    checklistItems.length > 0
      ? checklistItems.join("\n")
      : "- [ ] Produce the primary deliverable\n- [ ] Summarize findings and next steps",
    "",
    "## Done Criteria",
    "- [ ] All action items above are completed and verified",
    "- [ ] Summary with links/evidence posted back on the task",
  ];

  if (tags.length > 0) {
    sections.push("", `_Focus areas: ${tags.map((t) => `#${t}`).join(" ")}_`);
  }

  return sections.join("\n");
}

export interface PersonalNoteTemplate {
  id: string;
  label: string;
  description: string;
  defaultTitle: string;
  color: PersonalNoteColor;
  tags: string[];
  body: string;
}

export const PERSONAL_NOTE_TEMPLATES: PersonalNoteTemplate[] = [
  {
    id: "agent-brief",
    label: "Agent Brief",
    description: "Goal, context, deliverables & done criteria for clean delegation",
    defaultTitle: "Agent Brief: ",
    color: "violet",
    tags: ["brief"],
    body: [
      "## Goal",
      "",
      "",
      "## Context",
      "",
      "",
      "## Deliverables",
      "- [ ] ",
      "",
      "## Done Criteria",
      "- [ ] ",
    ].join("\n"),
  },
  {
    id: "meeting",
    label: "Meeting Notes",
    description: "Attendees, key decisions & action items to hand off",
    defaultTitle: `Meeting — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    color: "blue",
    tags: ["meeting"],
    body: [
      "## Attendees",
      "- ",
      "",
      "## Key Decisions",
      "- ",
      "",
      "## Action Items",
      "- [ ] ",
    ].join("\n"),
  },
  {
    id: "weekly-plan",
    label: "Weekly Plan",
    description: "Top outcomes, agent delegations & open questions",
    defaultTitle: "Weekly Plan",
    color: "emerald",
    tags: ["planning", "weekly"],
    body: [
      "## Top 3 Outcomes This Week",
      "1. ",
      "2. ",
      "3. ",
      "",
      "## Delegate to Agents",
      "- [ ] ",
      "",
      "## Decisions Needed",
      "- ",
    ].join("\n"),
  },
  {
    id: "decision-memo",
    label: "Decision Memo",
    description: "Options, tradeoffs, recommendation & next steps",
    defaultTitle: "Decision: ",
    color: "amber",
    tags: ["decision"],
    body: [
      "## Problem",
      "",
      "",
      "## Options",
      "1. **Option A**: ",
      "2. **Option B**: ",
      "",
      "## Recommendation",
      "",
      "",
      "## Next Steps",
      "- [ ] ",
    ].join("\n"),
  },
];

export interface NoteSlashCommand {
  id: string;
  command: string;
  label: string;
  description: string;
  insertText?: string;
  action?: "give" | "schedule" | "format-brief" | "wiki-link";
}

export const NOTE_SLASH_COMMANDS: NoteSlashCommand[] = [
  {
    id: "checklist",
    command: "/checklist",
    label: "Checklist item",
    description: "Insert a delegatable - [ ] action item",
    insertText: "- [ ] ",
  },
  {
    id: "brief",
    command: "/brief",
    label: "Format as Agent Brief",
    description: "Restructure this note into Goal / Context / Deliverables",
    action: "format-brief",
  },
  {
    id: "give",
    command: "/give",
    label: "Give to agent",
    description: "Open New Task popup prefilled from this note",
    action: "give",
  },
  {
    id: "schedule",
    command: "/schedule",
    label: "Schedule for agent",
    description: "Schedule one-off or recurring handoff to an agent",
    action: "schedule",
  },
  {
    id: "link",
    command: "/link",
    label: "Link another note",
    description: "Insert a [[Wiki Link]] to connect notes",
    action: "wiki-link",
  },
  {
    id: "callout",
    command: "/callout",
    label: "Callout",
    description: "Insert a highlighted note block",
    insertText: "> **Note:** ",
  },
  {
    id: "today",
    command: "/today",
    label: "Today's date",
    description: "Insert today's formatted date",
    insertText: new Date().toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  },
  {
    id: "heading",
    command: "/heading",
    label: "Section heading",
    description: "Insert a ## section heading",
    insertText: "## ",
  },
];
