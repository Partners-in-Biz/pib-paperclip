import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  agents,
  issues,
  personalNoteIssueLinks,
  personalNotes,
  projects,
  type Db,
} from "@paperclipai/db";
import type {
  CreatePersonalNote,
  PersonalNote,
  PersonalNoteColor,
  PersonalNoteLinkedTask,
  PersonalNoteRecurrence,
  PersonalNoteScheduleStatus,
  SchedulePersonalNoteHandoff,
  SplitPersonalNoteChecklist,
  UpdatePersonalNote,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

type PersonalNoteRow = typeof personalNotes.$inferSelect;

interface NoteJoinRow {
  note: PersonalNoteRow;
  issueIdentifier: string | null;
  issueTitle: string | null;
}

export function computeNextRecurrence(
  fromDate: Date,
  recurrence: PersonalNoteRecurrence,
): Date | null {
  if (recurrence === "none") return null;
  const next = new Date(fromDate.getTime());
  if (recurrence === "daily") {
    next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (recurrence === "weekdays") {
    next.setUTCDate(next.getUTCDate() + 1);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }
  if (recurrence === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  if (recurrence === "monthly") {
    next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
  }
  return null;
}

function serializePersonalNote(
  row: NoteJoinRow,
  linkedTasks: PersonalNoteLinkedTask[],
): PersonalNote {
  const { note, issueIdentifier, issueTitle } = row;
  return {
    id: note.id,
    companyId: note.companyId,
    userId: note.userId,
    title: note.title,
    body: note.body,
    tags: note.tags ?? [],
    color: (note.color as PersonalNoteColor) ?? "default",
    pinned: note.pinned,
    archived: note.archived,
    projectId: note.projectId ?? null,
    dailyDate: note.dailyDate ?? null,
    scheduledFor: note.scheduledFor ? note.scheduledFor.toISOString() : null,
    scheduledAgentId: note.scheduledAgentId ?? null,
    scheduledProjectId: note.scheduledProjectId ?? null,
    scheduledPriority: note.scheduledPriority ?? "medium",
    scheduledIssueStatus: note.scheduledIssueStatus ?? "todo",
    scheduledInstructions: note.scheduledInstructions ?? null,
    scheduledRecurrence: (note.scheduledRecurrence as PersonalNoteRecurrence) ?? "none",
    scheduledStatus: (note.scheduledStatus as PersonalNoteScheduleStatus) ?? "none",
    scheduledError: note.scheduledError ?? null,
    handedOffIssueId: note.handedOffIssueId ?? null,
    handedOffIssueIdentifier: issueIdentifier ?? null,
    handedOffIssueTitle: issueTitle ?? null,
    handedOffAt: note.handedOffAt ? note.handedOffAt.toISOString() : null,
    linkedTasks,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

export function buildPersonalNoteHandoffDescription(
  note: Pick<PersonalNoteRow, "body" | "tags" | "scheduledInstructions">,
): string {
  const sections: string[] = [];
  if (note.scheduledInstructions?.trim()) {
    sections.push(`## Instructions\n\n${note.scheduledInstructions.trim()}`);
  }
  if (note.body.trim()) {
    sections.push(note.body.trim());
  }
  if (note.tags && note.tags.length > 0) {
    sections.push(`_Tags: ${note.tags.map((t) => `#${t}`).join(" ")}_`);
  }
  return sections.join("\n\n");
}

function formatDailyNoteTitle(dateStr: string): string {
  const parsed = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return `Daily Note — ${dateStr}`;
  const formatted = parsed.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Daily Note — ${formatted}`;
}

export interface PersonalNoteServiceDeps {
  heartbeat?: IssueAssignmentWakeupDeps;
}

export function personalNoteService(db: Db, deps: PersonalNoteServiceDeps = {}) {
  const issueSvc = issueService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db);

  async function fetchLinkedTasksMap(noteIds: string[]): Promise<Map<string, PersonalNoteLinkedTask[]>> {
    const map = new Map<string, PersonalNoteLinkedTask[]>();
    if (noteIds.length === 0) return map;
    const rows = await db
      .select({
        id: personalNoteIssueLinks.id,
        noteId: personalNoteIssueLinks.noteId,
        issueId: personalNoteIssueLinks.issueId,
        sourceLine: personalNoteIssueLinks.sourceLine,
        createdAt: personalNoteIssueLinks.createdAt,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(personalNoteIssueLinks)
      .leftJoin(issues, eq(personalNoteIssueLinks.issueId, issues.id))
      .where(inArray(personalNoteIssueLinks.noteId, noteIds))
      .orderBy(desc(personalNoteIssueLinks.createdAt));

    for (const row of rows) {
      const list = map.get(row.noteId) ?? [];
      list.push({
        id: row.id,
        issueId: row.issueId,
        issueIdentifier: row.issueIdentifier ?? null,
        issueTitle: row.issueTitle ?? null,
        issueStatus: row.issueStatus ?? null,
        issuePriority: row.issuePriority ?? null,
        assigneeAgentId: row.assigneeAgentId ?? null,
        sourceLine: row.sourceLine ?? null,
        createdAt: row.createdAt.toISOString(),
      });
      map.set(row.noteId, list);
    }
    return map;
  }

  async function selectNoteById(companyId: string, userId: string, noteId: string): Promise<PersonalNote | null> {
    const rows = await db
      .select({
        note: personalNotes,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
      })
      .from(personalNotes)
      .leftJoin(issues, eq(personalNotes.handedOffIssueId, issues.id))
      .where(
        and(
          eq(personalNotes.id, noteId),
          eq(personalNotes.companyId, companyId),
          eq(personalNotes.userId, userId),
        ),
      )
      .limit(1);
    if (!rows[0]) return null;
    const linksMap = await fetchLinkedTasksMap([noteId]);
    return serializePersonalNote(rows[0], linksMap.get(noteId) ?? []);
  }

  async function assertValidCompanyRefs(
    companyId: string,
    refs: { projectId?: string | null; agentId?: string | null },
  ) {
    if (refs.projectId) {
      const proj = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, refs.projectId), eq(projects.companyId, companyId)))
        .limit(1);
      if (!proj[0]) throw badRequest("Selected project does not belong to this company");
    }
    if (refs.agentId) {
      const ag = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, refs.agentId), eq(agents.companyId, companyId)))
        .limit(1);
      if (!ag[0]) throw badRequest("Selected agent does not belong to this company");
    }
  }

  async function dispatchRowToAgent(note: PersonalNoteRow, source: "schedule" | "manual") {
    const now = new Date();
    const targetProjectId = note.scheduledProjectId ?? note.projectId ?? null;
    const description = buildPersonalNoteHandoffDescription(note);
    const createdIssue = await issueSvc.create(note.companyId, {
      title: note.title,
      description: description || null,
      status: note.scheduledIssueStatus === "backlog" ? "backlog" : "todo",
      priority: note.scheduledPriority || "medium",
      projectId: targetProjectId,
      assigneeAgentId: note.scheduledAgentId ?? null,
      createdByUserId: note.userId,
      originKind: "personal_note",
      originId: note.id,
    });

    if (createdIssue.assigneeAgentId) {
      await queueIssueAssignmentWakeup({
        heartbeat,
        issue: createdIssue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: source === "schedule" ? "personal_note.scheduled_handoff" : "personal_note.handoff",
        requestedByActorType: source === "schedule" ? "system" : "user",
        requestedByActorId: source === "schedule" ? "personal-note-scheduler" : note.userId,
      });
    }

    await db.insert(personalNoteIssueLinks).values({
      noteId: note.id,
      companyId: note.companyId,
      issueId: createdIssue.id,
      sourceLine: null,
      createdAt: now,
    });

    const recurrence = (note.scheduledRecurrence as PersonalNoteRecurrence) ?? "none";
    const baseTime = note.scheduledFor && note.scheduledFor > now ? note.scheduledFor : now;
    const nextRun = source === "schedule" ? computeNextRecurrence(baseTime, recurrence) : null;

    await db
      .update(personalNotes)
      .set({
        handedOffIssueId: createdIssue.id,
        handedOffAt: now,
        scheduledFor: nextRun ?? note.scheduledFor,
        scheduledStatus: nextRun ? "pending" : "dispatched",
        scheduledError: null,
        updatedAt: now,
      })
      .where(eq(personalNotes.id, note.id));

    return createdIssue;
  }

  return {
    async list(companyId: string, userId: string): Promise<PersonalNote[]> {
      const rows = await db
        .select({
          note: personalNotes,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(personalNotes)
        .leftJoin(issues, eq(personalNotes.handedOffIssueId, issues.id))
        .where(
          and(
            eq(personalNotes.companyId, companyId),
            eq(personalNotes.userId, userId),
          ),
        )
        .orderBy(desc(personalNotes.pinned), desc(personalNotes.updatedAt));
      const linksMap = await fetchLinkedTasksMap(rows.map((r) => r.note.id));
      return rows.map((row) => serializePersonalNote(row, linksMap.get(row.note.id) ?? []));
    },

    async getById(companyId: string, userId: string, noteId: string): Promise<PersonalNote> {
      const note = await selectNoteById(companyId, userId, noteId);
      if (!note) throw notFound("Note not found");
      return note;
    },

    async create(companyId: string, userId: string, input: CreatePersonalNote): Promise<PersonalNote> {
      await assertValidCompanyRefs(companyId, { projectId: input.projectId ?? null });
      const now = new Date();
      const [inserted] = await db
        .insert(personalNotes)
        .values({
          companyId,
          userId,
          title: input.title,
          body: input.body ?? "",
          tags: input.tags ?? [],
          color: input.color ?? "default",
          pinned: input.pinned ?? false,
          projectId: input.projectId ?? null,
          dailyDate: input.dailyDate ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return serializePersonalNote({ note: inserted!, issueIdentifier: null, issueTitle: null }, []);
    },

    async openDaily(companyId: string, userId: string, dateStr?: string): Promise<PersonalNote> {
      const today = dateStr ?? new Date().toISOString().slice(0, 10);
      const existing = await db
        .select({ id: personalNotes.id })
        .from(personalNotes)
        .where(
          and(
            eq(personalNotes.companyId, companyId),
            eq(personalNotes.userId, userId),
            eq(personalNotes.dailyDate, today),
          ),
        )
        .limit(1);

      if (existing[0]) {
        const found = await selectNoteById(companyId, userId, existing[0].id);
        if (found) return found;
      }

      const starterBody = [
        "## Top Priorities",
        "- [ ] ",
        "",
        "## Notes & Brain Dump",
        "",
        "## Delegate to Agents",
        "- [ ] ",
      ].join("\n");

      return this.create(companyId, userId, {
        title: formatDailyNoteTitle(today),
        body: starterBody,
        tags: ["daily"],
        color: "blue",
        pinned: false,
        projectId: null,
        dailyDate: today,
      });
    },

    async update(
      companyId: string,
      userId: string,
      noteId: string,
      patch: UpdatePersonalNote,
    ): Promise<PersonalNote> {
      if (patch.projectId !== undefined) {
        await assertValidCompanyRefs(companyId, { projectId: patch.projectId });
      }
      const updateValues: Partial<typeof personalNotes.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (patch.title !== undefined) updateValues.title = patch.title;
      if (patch.body !== undefined) updateValues.body = patch.body;
      if (patch.tags !== undefined) updateValues.tags = patch.tags;
      if (patch.color !== undefined) updateValues.color = patch.color;
      if (patch.pinned !== undefined) updateValues.pinned = patch.pinned;
      if (patch.archived !== undefined) updateValues.archived = patch.archived;
      if (patch.projectId !== undefined) updateValues.projectId = patch.projectId;

      const updated = await db
        .update(personalNotes)
        .set(updateValues)
        .where(
          and(
            eq(personalNotes.id, noteId),
            eq(personalNotes.companyId, companyId),
            eq(personalNotes.userId, userId),
          ),
        )
        .returning({ id: personalNotes.id });

      if (!updated[0]) throw notFound("Note not found");
      const full = await selectNoteById(companyId, userId, noteId);
      if (!full) throw notFound("Note not found");
      return full;
    },

    async remove(companyId: string, userId: string, noteId: string): Promise<{ deleted: true }> {
      const deleted = await db
        .delete(personalNotes)
        .where(
          and(
            eq(personalNotes.id, noteId),
            eq(personalNotes.companyId, companyId),
            eq(personalNotes.userId, userId),
          ),
        )
        .returning({ id: personalNotes.id });
      if (!deleted[0]) throw notFound("Note not found");
      return { deleted: true };
    },

    async scheduleHandoff(
      companyId: string,
      userId: string,
      noteId: string,
      input: SchedulePersonalNoteHandoff,
    ): Promise<PersonalNote> {
      const scheduledDate = new Date(input.scheduledFor);
      if (Number.isNaN(scheduledDate.getTime())) {
        throw badRequest("Invalid scheduledFor timestamp");
      }
      await assertValidCompanyRefs(companyId, {
        projectId: input.projectId ?? null,
        agentId: input.agentId ?? null,
      });

      const updated = await db
        .update(personalNotes)
        .set({
          scheduledFor: scheduledDate,
          scheduledAgentId: input.agentId ?? null,
          scheduledProjectId: input.projectId ?? null,
          scheduledPriority: input.priority ?? "medium",
          scheduledIssueStatus: input.issueStatus ?? "todo",
          scheduledInstructions: input.instructions?.trim() ? input.instructions.trim() : null,
          scheduledRecurrence: input.recurrence ?? "none",
          scheduledStatus: "pending",
          scheduledError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personalNotes.id, noteId),
            eq(personalNotes.companyId, companyId),
            eq(personalNotes.userId, userId),
          ),
        )
        .returning({ id: personalNotes.id });

      if (!updated[0]) throw notFound("Note not found");
      const full = await selectNoteById(companyId, userId, noteId);
      if (!full) throw notFound("Note not found");
      return full;
    },

    async cancelScheduledHandoff(companyId: string, userId: string, noteId: string): Promise<PersonalNote> {
      const updated = await db
        .update(personalNotes)
        .set({
          scheduledFor: null,
          scheduledAgentId: null,
          scheduledProjectId: null,
          scheduledInstructions: null,
          scheduledRecurrence: "none",
          scheduledStatus: "none",
          scheduledError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personalNotes.id, noteId),
            eq(personalNotes.companyId, companyId),
            eq(personalNotes.userId, userId),
          ),
        )
        .returning({ id: personalNotes.id });

      if (!updated[0]) throw notFound("Note not found");
      const full = await selectNoteById(companyId, userId, noteId);
      if (!full) throw notFound("Note not found");
      return full;
    },

    async recordHandoff(
      companyId: string,
      userId: string,
      noteId: string,
      issueId: string,
      sourceLine: string | null = null,
    ): Promise<PersonalNote> {
      const existingIssue = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .limit(1);
      if (!existingIssue[0]) throw badRequest("Issue does not belong to this company");

      const now = new Date();
      const updated = await db
        .update(personalNotes)
        .set({
          handedOffIssueId: issueId,
          handedOffAt: now,
          scheduledStatus: sql`CASE WHEN ${personalNotes.scheduledStatus} = 'pending' AND ${personalNotes.scheduledRecurrence} = 'none' THEN 'dispatched' ELSE ${personalNotes.scheduledStatus} END`,
          scheduledError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(personalNotes.id, noteId),
            eq(personalNotes.companyId, companyId),
            eq(personalNotes.userId, userId),
          ),
        )
        .returning({ id: personalNotes.id });

      if (!updated[0]) throw notFound("Note not found");

      await db.insert(personalNoteIssueLinks).values({
        noteId,
        companyId,
        issueId,
        sourceLine: sourceLine?.trim() ? sourceLine.trim() : null,
        createdAt: now,
      });

      const full = await selectNoteById(companyId, userId, noteId);
      if (!full) throw notFound("Note not found");
      return full;
    },

    async splitChecklistToTasks(
      companyId: string,
      userId: string,
      noteId: string,
      input: SplitPersonalNoteChecklist,
    ): Promise<{ note: PersonalNote; createdCount: number }> {
      await assertValidCompanyRefs(companyId, {
        projectId: input.projectId ?? null,
        agentId: input.agentId ?? null,
      });

      const rows = await db
        .select()
        .from(personalNotes)
        .where(
          and(
            eq(personalNotes.id, noteId),
            eq(personalNotes.companyId, companyId),
            eq(personalNotes.userId, userId),
          ),
        )
        .limit(1);
      const noteRow = rows[0];
      if (!noteRow) throw notFound("Note not found");

      const now = new Date();
      let lastIssueId: string | null = null;
      let createdCount = 0;
      const targetProjectId = input.projectId ?? noteRow.projectId ?? null;

      for (const rawItem of input.items) {
        const line = rawItem.trim();
        if (!line) continue;
        const description = [
          `Delegated from personal note **${noteRow.title}**.`,
          "",
          noteRow.body.trim() ? `### Note Context\n\n${noteRow.body.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const createdIssue = await issueSvc.create(companyId, {
          title: line.slice(0, 200),
          description,
          status: input.issueStatus === "backlog" ? "backlog" : "todo",
          priority: input.priority ?? "medium",
          projectId: targetProjectId,
          assigneeAgentId: input.agentId ?? null,
          createdByUserId: userId,
          originKind: "personal_note",
          originId: noteRow.id,
        });

        if (createdIssue.assigneeAgentId) {
          await queueIssueAssignmentWakeup({
            heartbeat,
            issue: createdIssue,
            reason: "issue_assigned",
            mutation: "create",
            contextSource: "personal_note.checklist_split",
            requestedByActorType: "user",
            requestedByActorId: userId,
          });
        }

        await db.insert(personalNoteIssueLinks).values({
          noteId: noteRow.id,
          companyId,
          issueId: createdIssue.id,
          sourceLine: line,
          createdAt: now,
        });

        lastIssueId = createdIssue.id;
        createdCount += 1;
      }

      if (lastIssueId) {
        await db
          .update(personalNotes)
          .set({
            handedOffIssueId: lastIssueId,
            handedOffAt: now,
            updatedAt: now,
          })
          .where(eq(personalNotes.id, noteRow.id));
      }

      const full = await selectNoteById(companyId, userId, noteId);
      if (!full) throw notFound("Note not found");
      return { note: full, createdCount };
    },

    async dispatchNow(companyId: string, userId: string, noteId: string): Promise<PersonalNote> {
      const rows = await db
        .select()
        .from(personalNotes)
        .where(
          and(
            eq(personalNotes.id, noteId),
            eq(personalNotes.companyId, companyId),
            eq(personalNotes.userId, userId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("Note not found");

      await dispatchRowToAgent(row, "manual");
      const full = await selectNoteById(companyId, userId, noteId);
      if (!full) throw notFound("Note not found");
      return full;
    },

    async tickScheduledHandoffs(now = new Date()): Promise<{ checked: number; dispatched: number; failed: number }> {
      const dueRows = await db
        .select()
        .from(personalNotes)
        .where(
          and(
            eq(personalNotes.scheduledStatus, "pending"),
            lte(personalNotes.scheduledFor, now),
          ),
        )
        .limit(25);

      let dispatched = 0;
      let failed = 0;

      for (const due of dueRows) {
        const claimed = await db
          .update(personalNotes)
          .set({
            scheduledStatus: "dispatched",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(personalNotes.id, due.id),
              eq(personalNotes.scheduledStatus, "pending"),
            ),
          )
          .returning();

        const claimedRow = claimed[0];
        if (!claimedRow) continue;

        try {
          await dispatchRowToAgent(claimedRow, "schedule");
          dispatched += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          await db
            .update(personalNotes)
            .set({
              scheduledStatus: "failed",
              scheduledError: message.slice(0, 500),
              updatedAt: new Date(),
            })
            .where(eq(personalNotes.id, due.id));
        }
      }

      return { checked: dueRows.length, dispatched, failed };
    },
  };
}
