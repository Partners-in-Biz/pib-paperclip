/**
 * The client fact sheet (see engine/claims.ts). People maintain it on the SEO page; agents read it with
 * get-client-facts and create-preview refuses copy that makes claims outside it.
 */
import { t } from "../db.js";
import { CLAIM_TERMS, factLines, parseFactLines, type ClientFact } from "../engine/claims.js";
import { actorId, reqStr, SeoError, bool, str, type Actor, type Env, type Params } from "./common.js";
import { assertWritable, loadSprintContext } from "./context.js";

export interface FactSheet {
  status: "draft" | "confirmed" | "none";
  facts: ClientFact[];
  updatedAt: string | null;
}

export async function loadFacts(env: Env, companyId: string, sprintId: string): Promise<FactSheet> {
  const rows = await env.ctx.db.query(`SELECT facts, status, updated_at FROM ${t("client_facts")} WHERE sprint_id = $1 AND company_id = $2 LIMIT 1`, [sprintId, companyId]);
  const row = rows[0];
  if (!row) return { status: "none", facts: [], updatedAt: null };
  const raw = typeof row.facts === "string" ? JSON.parse(String(row.facts)) : row.facts;
  const facts = (Array.isArray(raw) ? raw : []).filter((f): f is ClientFact => Boolean(f) && (f.kind === "say" || f.kind === "avoid") && typeof f.text === "string");
  return { status: row.status === "confirmed" ? "confirmed" : "draft", facts, updatedAt: row.updated_at ? String(row.updated_at) : null };
}

export async function getClientFacts(env: Env, companyId: string, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  await loadSprintContext(env, companyId, sprintId);
  const sheet = await loadFacts(env, companyId, sprintId);
  return {
    sprintId,
    status: sheet.status,
    say: sheet.facts.filter((f) => f.kind === "say").map((f) => ({ wording: f.text, source: f.source ?? null })),
    avoid: sheet.facts.filter((f) => f.kind === "avoid").map((f) => f.text),
    claimTopics: [...new Set(CLAIM_TERMS.map((c) => c.why))],
    rule:
      "Copy may describe how the business works (bidding, ownership, reserves, fees, delivery, guarantees, inspection, verification, licences, legal or FICA wording, refunds, time commitments) ONLY by reusing one of the approved wordings above (shortened is fine, reworded is not). Anything else: leave the claim out. create-preview refuses a sentence that breaks this. If a needed fact is missing, ask the owner to add it (Needs you), do not invent it.",
    ...(sheet.status === "none" ? { note: "No fact sheet yet: every claim of those kinds will be refused until the owner adds approved wordings." } : {}),
    ...(sheet.status === "draft" ? { note: "Drafted from the client's own pages; not yet confirmed by the owner." } : {}),
  };
}

/** A person edits the sheet (page-only). Lines: "+ approved wording | source" and "- never say this". */
export async function setClientFacts(env: Env, companyId: string, actor: Actor, params: Params) {
  if (actor.kind !== "user") throw new SeoError("Only a person edits the client fact sheet.");
  const sprintId = reqStr(params, "sprintId");
  const { sprint } = await loadSprintContext(env, companyId, sprintId);
  assertWritable(sprint);
  const facts = parseFactLines(str(params, "text", { max: 60_000 }) ?? "");
  const status = bool(params, "confirm") ? "confirmed" : "draft";
  await env.ctx.db.execute(
    `INSERT INTO ${t("client_facts")} (sprint_id, company_id, facts, status, updated_by, updated_at) VALUES ($1, $2, $3::jsonb, $4, $5, now())
     ON CONFLICT (sprint_id) DO UPDATE SET facts = EXCLUDED.facts, status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [sprintId, companyId, JSON.stringify(facts), status, actorId(actor)],
  );
  return { sprintId, status, say: facts.filter((f) => f.kind === "say").length, avoid: facts.filter((f) => f.kind === "avoid").length };
}

export function factsText(sheet: FactSheet): string {
  return factLines(sheet.facts);
}
