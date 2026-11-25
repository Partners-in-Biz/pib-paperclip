import type {
  CreatePersonalNote,
  PersonalNote,
  SchedulePersonalNoteHandoff,
  SplitPersonalNoteChecklist,
  UpdatePersonalNote,
} from "@paperclipai/shared";
import { api } from "./client";

export const personalNotesApi = {
  list: (companyId: string) =>
    api.get<PersonalNote[]>(`/companies/${companyId}/personal-notes`, { cache: "no-store" }),

  get: (companyId: string, noteId: string) =>
    api.get<PersonalNote>(`/companies/${companyId}/personal-notes/${noteId}`, { cache: "no-store" }),

  create: (companyId: string, data: CreatePersonalNote) =>
    api.post<PersonalNote>(`/companies/${companyId}/personal-notes`, data),

  openDaily: (companyId: string, date?: string) =>
    api.post<PersonalNote>(`/companies/${companyId}/personal-notes/daily`, date ? { date } : {}),

  update: (companyId: string, noteId: string, data: UpdatePersonalNote) =>
    api.patch<PersonalNote>(`/companies/${companyId}/personal-notes/${noteId}`, data),

  remove: (companyId: string, noteId: string) =>
    api.delete<{ deleted: true }>(`/companies/${companyId}/personal-notes/${noteId}`),

  scheduleHandoff: (companyId: string, noteId: string, data: SchedulePersonalNoteHandoff) =>
    api.post<PersonalNote>(`/companies/${companyId}/personal-notes/${noteId}/schedule-handoff`, data),

  cancelScheduledHandoff: (companyId: string, noteId: string) =>
    api.delete<PersonalNote>(`/companies/${companyId}/personal-notes/${noteId}/schedule-handoff`),

  dispatchNow: (companyId: string, noteId: string) =>
    api.post<PersonalNote>(`/companies/${companyId}/personal-notes/${noteId}/dispatch-now`, {}),

  recordHandoff: (companyId: string, noteId: string, issueId: string, sourceLine?: string | null) =>
    api.post<PersonalNote>(`/companies/${companyId}/personal-notes/${noteId}/record-handoff`, {
      issueId,
      sourceLine: sourceLine ?? null,
    }),

  splitChecklistToTasks: (
    companyId: string,
    noteId: string,
    data: SplitPersonalNoteChecklist,
  ) =>
    api.post<{ note: PersonalNote; createdCount: number }>(
      `/companies/${companyId}/personal-notes/${noteId}/split-tasks`,
      data,
    ),
};
