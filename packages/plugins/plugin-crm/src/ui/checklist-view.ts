/** Pure wording for the "what is left to set up" card (no React). */

export interface ChecklistRow {
  key: string;
  title: string;
  state: "done" | "todo" | "unknown" | "waits";
  owner: string;
  how: string;
  detail?: string;
}

export interface ChecklistResult {
  checklist: ChecklistRow[];
  remaining: string[];
  next: string;
}

export const STATE_LABEL: Record<ChecklistRow["state"], string> = { done: "Done", todo: "To do", unknown: "Check", waits: "Waiting" };

export function stateTone(state: ChecklistRow["state"]): "ok" | "warn" | "info" | "neutral" {
  return state === "done" ? "ok" : state === "todo" ? "warn" : state === "unknown" ? "info" : "neutral";
}
