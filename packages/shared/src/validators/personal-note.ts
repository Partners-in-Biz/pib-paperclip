import { z } from "zod";
import {
  PERSONAL_NOTE_COLORS,
  PERSONAL_NOTE_RECURRENCES,
} from "../types/personal-note.js";

const personalNoteColorSchema = z.enum(PERSONAL_NOTE_COLORS);
const personalNoteRecurrenceSchema = z.enum(PERSONAL_NOTE_RECURRENCES);

const personalNoteTagsSchema = z
  .array(z.string().trim().min(1).max(48))
  .max(20)
  .transform((tags) => Array.from(new Set(tags)));

export const createPersonalNoteSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(240),
  body: z.string().max(100_000).optional().default(""),
  tags: personalNoteTagsSchema.optional().default([]),
  color: personalNoteColorSchema.optional().default("default"),
  pinned: z.boolean().optional().default(false),
  projectId: z.string().uuid().nullable().optional().default(null),
  dailyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().default(null),
});

export type CreatePersonalNote = z.infer<typeof createPersonalNoteSchema>;

export const updatePersonalNoteSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(240).optional(),
  body: z.string().max(100_000).optional(),
  tags: personalNoteTagsSchema.optional(),
  color: personalNoteColorSchema.optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  projectId: z.string().uuid().nullable().optional(),
});

export type UpdatePersonalNote = z.infer<typeof updatePersonalNoteSchema>;

export const schedulePersonalNoteHandoffSchema = z.object({
  scheduledFor: z.string().datetime({ offset: true }),
  agentId: z.string().uuid().nullable().optional().default(null),
  projectId: z.string().uuid().nullable().optional().default(null),
  priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
  issueStatus: z.enum(["todo", "backlog"]).optional().default("todo"),
  instructions: z.string().max(10_000).nullable().optional().default(null),
  recurrence: personalNoteRecurrenceSchema.optional().default("none"),
});

export type SchedulePersonalNoteHandoff = z.infer<typeof schedulePersonalNoteHandoffSchema>;

export const recordPersonalNoteHandoffSchema = z.object({
  issueId: z.string().uuid(),
  sourceLine: z.string().trim().max(500).nullable().optional().default(null),
});

export type RecordPersonalNoteHandoff = z.infer<typeof recordPersonalNoteHandoffSchema>;

export const openDailyPersonalNoteSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type OpenDailyPersonalNote = z.infer<typeof openDailyPersonalNoteSchema>;

export const splitPersonalNoteChecklistSchema = z.object({
  items: z.array(z.string().trim().min(1).max(300)).min(1).max(25),
  agentId: z.string().uuid().nullable().optional().default(null),
  projectId: z.string().uuid().nullable().optional().default(null),
  priority: z.enum(["low", "medium", "high", "critical"]).optional().default("medium"),
  issueStatus: z.enum(["todo", "backlog"]).optional().default("todo"),
});

export type SplitPersonalNoteChecklist = z.infer<typeof splitPersonalNoteChecklistSchema>;
