import * as db from "../db.js";
import { sprintClock, type SprintClock } from "../engine/sprint.js";
import type { SprintCopy } from "../engine/copy.js";
import { companyInfo, SeoError, type CompanyInfo, type Env } from "./common.js";

export async function requireSprint(env: Env, companyId: string, sprintId: string): Promise<db.Sprint> {
  const sprint = await db.getSprint(env.ctx.db, companyId, sprintId);
  if (!sprint) throw new SeoError(`Sprint ${sprintId} was not found in this company`);
  return sprint;
}

export function clockFor(sprint: Pick<db.Sprint, "startDate">, today: string): SprintClock {
  return sprintClock(sprint.startDate, today);
}

export function sprintCopy(sprint: db.Sprint): SprintCopy {
  return {
    id: sprint.id,
    siteName: sprint.siteName,
    siteUrl: sprint.siteUrl,
    clientName: sprint.clientName,
    autopilotMode: sprint.autopilotMode,
    notes: sprint.notes,
  };
}

export interface SprintContext {
  sprint: db.Sprint;
  info: CompanyInfo;
  clock: SprintClock;
}

export async function loadSprintContext(env: Env, companyId: string, sprintId: string, info?: CompanyInfo): Promise<SprintContext> {
  const sprint = await requireSprint(env, companyId, sprintId);
  const companyData = info ?? (await companyInfo(env, companyId));
  return { sprint, info: companyData, clock: clockFor(sprint, companyData.today) };
}

export function assertWritable(sprint: db.Sprint): void {
  if (sprint.status === "archived") throw new SeoError("This sprint is archived. Resume it first to change it.");
}
