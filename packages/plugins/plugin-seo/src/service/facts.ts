/**
 * The client fact sheet (see engine/claims.ts). People maintain it on the SEO page; agents read it with
 * get-client-facts and create-preview refuses copy that makes claims outside it.
 */
import { t } from "../db.js";
import { CLAIM_TERMS, factLines, htmlToText, parseFactLines, type ClientFact } from "../engine/claims.js";
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

const MAX_PROPOSED = 20;

/** Wording and page text compared without case, punctuation or spacing differences. */
export function normaliseForMatch(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019\u201c\u201d]/g, "'").replace(/[^a-z0-9%.,']+/g, " ").replace(/\s+/g, " ").trim();
}

export function appearsOnPage(wording: string, pageText: string): boolean {
  const w = normaliseForMatch(wording);
  return w.length >= 12 && normaliseForMatch(pageText).includes(w);
}

/**
 * The SEO agent drafts the sheet from the client's own pages: each approved wording is quoted from a page of the client's site,
 * and the plugin fetches that page and refuses a wording that is not on it. The sheet then stays a draft for the owner to
 * confirm, but copy can already use what the client says about itself (terms, delivery, returns, FAQ). Never an invention.
 */
export async function proposeClientFacts(env: Env, companyId: string, _actor: Actor, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const { sprint } = await loadSprintContext(env, companyId, sprintId);
  assertWritable(sprint);
  const raw = Array.isArray(params.say) ? (params.say as unknown[]) : [];
  if (raw.length === 0) throw new SeoError("Send say: a list of { wording, sourceUrl }: a sentence copied from a page of the client's own site, and that page's address.");
  const host = new URL(sprint.siteUrl).hostname.replace(/^www\./, "").toLowerCase();
  const sheet = await loadFacts(env, companyId, sprintId);
  const known = new Set(sheet.facts.filter((f) => f.kind === "say").map((f) => normaliseForMatch(f.text)));
  const pages = new Map<string, string | null>();
  const accepted: ClientFact[] = [];
  const rejected: Array<{ wording: string; why: string }> = [];
  for (const item of raw.slice(0, MAX_PROPOSED)) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const wording = typeof entry.wording === "string" ? entry.wording.replace(/\s+/g, " ").trim().slice(0, 400) : "";
    const sourceUrl = typeof entry.sourceUrl === "string" ? entry.sourceUrl.trim() : "";
    if (!wording || !sourceUrl) {
      rejected.push({ wording: wording || "(empty)", why: "both wording and sourceUrl are needed" });
      continue;
    }
    let url: string;
    try {
      url = new URL(/^https?:\/\//i.test(sourceUrl) ? sourceUrl : new URL(sourceUrl, sprint.siteUrl).toString()).toString();
    } catch {
      rejected.push({ wording, why: "sourceUrl is not an address" });
      continue;
    }
    if (new URL(url).hostname.replace(/^www\./, "").toLowerCase() !== host) {
      rejected.push({ wording, why: `the source must be a page of ${host}` });
      continue;
    }
    if (known.has(normaliseForMatch(wording))) {
      rejected.push({ wording, why: "already on the sheet" });
      continue;
    }
    if (!pages.has(url)) {
      const res = await env.site(url, { maxChars: 600_000 }).catch(() => null);
      pages.set(url, res && res.status < 400 && res.text ? htmlToText(res.text) : null);
    }
    const pageText = pages.get(url);
    if (pageText == null) {
      rejected.push({ wording, why: "the source page could not be read" });
      continue;
    }
    if (!appearsOnPage(wording, pageText)) {
      rejected.push({ wording, why: "this wording is not on that page: copy it exactly from the page" });
      continue;
    }
    known.add(normaliseForMatch(wording));
    accepted.push({ kind: "say", text: wording, source: url });
  }
  if (accepted.length > 0) {
    const facts = [...sheet.facts, ...accepted];
    await env.ctx.db.execute(
      `INSERT INTO ${t("client_facts")} (sprint_id, company_id, facts, status, updated_by, updated_at) VALUES ($1, $2, $3::jsonb, 'draft', $4, now())
       ON CONFLICT (sprint_id) DO UPDATE SET facts = EXCLUDED.facts, status = 'draft', updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [sprintId, companyId, JSON.stringify(facts), actorId(_actor)],
    );
  }
  return {
    sprintId,
    accepted: accepted.length,
    rejected,
    say: sheet.facts.filter((f) => f.kind === "say").length + accepted.length,
    status: accepted.length > 0 ? "draft" : sheet.status,
    note: "Wordings on the sheet come from the client's own pages. Copy may reuse them (shortened is fine, reworded is not). The owner can confirm the sheet on the SEO page.",
  };
}
