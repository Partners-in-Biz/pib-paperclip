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
    ...(sheet.status === "none" || sheet.facts.filter((f) => f.kind === "say").length === 0
      ? {
          note:
            "The sheet is empty, so every claim of those kinds will be refused. BEFORE you write copy: read the client's own pages (terms, FAQ, about, delivery, returns, and the page you are rewriting) and add each sentence you want to rely on with propose-client-facts: copy it EXACTLY from that page and send the page's address (the plugin checks it). Then write your copy with only those wordings for claims. A claim the client does not make on their own site stays out of the copy.",
        }
      : {}),
    ...(sheet.status === "draft" && sheet.facts.some((f) => f.kind === "say") ? { note: "Drafted from the client's own pages; not yet confirmed by the owner." } : {}),
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

/** Confirm a draft client fact sheet: verify all say-wordings still appear on their source pages, then lock the sheet. */
export async function confirmClientFacts(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const { sprint } = await loadSprintContext(env, companyId, sprintId);
  assertWritable(sprint);

  // Load the raw row to get the exact jsonb value for CAS
  const rows = await env.ctx.db.query(`SELECT facts, status, updated_at FROM ${t("client_facts")} WHERE sprint_id = $1 AND company_id = $2 LIMIT 1`, [sprintId, companyId]);
  const row = rows[0];
  if (!row) throw new SeoError(`No fact sheet for sprint ${sprintId}.`);

  // If already confirmed, return as-is
  if (row.status === "confirmed") {
    return {
      sprintId,
      status: "confirmed",
      confirmed: true,
      confirmedBy: { agentId: actor.kind === "agent" ? actor.agentId : null },
      confirmedAt: row.updated_at ? String(row.updated_at) : env.now().toISOString(),
      checked: 0,
      checkedUrls: [],
      wordingsHash: "",
    };
  }

  // Parse facts from raw jsonb
  const rawFacts = typeof row.facts === "string" ? JSON.parse(String(row.facts)) : row.facts;
  const sayFacts = (Array.isArray(rawFacts) ? rawFacts : []).filter((f): f is ClientFact => f && f.kind === "say" && typeof f.text === "string");

  if (sayFacts.length === 0) throw new SeoError("No say-facts to confirm.");

  // Validate all say facts before fetching
  const { normalizeWording, wordingAppearsInText, normalizeVisibleText } = await import("./page-text.js");

  for (const fact of sayFacts) {
    if (!fact.text || fact.text.length < 8) {
      throw new SeoError(`Wording too short (must be 8+ chars): "${fact.text.slice(0, 50)}".`);
    }
    if (!fact.source) {
      throw new SeoError(`Say-fact missing source: "${fact.text.slice(0, 100)}".`);
    }
  }

  // Extract distinct source URLs (max 5), strip fragments
  const sourceUrls = new Set<string>();
  for (const fact of sayFacts) {
    if (fact.source) {
      try {
        const url = new URL(fact.source);
        url.hash = ""; // Strip fragment
        sourceUrls.add(url.toString());
      } catch {
        throw new SeoError(`Invalid source URL: "${fact.source}".`);
      }
    }
  }

  if (sourceUrls.size > 5) throw new SeoError(`Too many distinct source URLs (max 5): ${sourceUrls.size}.`);

  // Get site host
  let siteHost: string;
  try {
    siteHost = new URL(sprint.siteUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    throw new SeoError("Cannot read sprint site host.");
  }

  // Verify all sources are on the client site
  for (const url of sourceUrls) {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host !== siteHost) {
      return {
        sprintId,
        status: "draft",
        confirmed: false,
        mismatches: [{ index: 0, text: sayFacts[0]?.text?.slice(0, 120) ?? "", source: url, reason: "source not on client site" }],
      };
    }
  }

  // Fetch all pages in parallel with a 20s deadline
  const deadline = Date.now() + 20_000;
  const { safeFetch } = await import("@partnersinbiz/pib-plugin-kit");

  const fetchPromises = Array.from(sourceUrls).map((url) =>
    safeFetch(env.ctx, url, { maxRedirects: 3, maxChars: 2_000_000 }).catch(() => null),
  );

  // Enforce 20s budget on all fetches combined with Promise.race
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise: Promise<"timeout"> = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), 20_000);
  });

  let timedOut = false;
  let results: PromiseSettledResult<unknown>[] = [];
  try {
    const raceResult = await Promise.race([Promise.allSettled(fetchPromises), timeoutPromise]);
    if (raceResult === "timeout") {
      // Timeout occurred
      timedOut = true;
    } else {
      results = raceResult as PromiseSettledResult<unknown>[];
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // If timeout occurred, return draft with fetch failed
  if (timedOut) {
    return {
      sprintId,
      status: "draft",
      confirmed: false,
      mismatches: [{ index: 0, text: sayFacts[0]?.text?.slice(0, 120) ?? "", source: "", reason: "fetch failed" }],
    };
  }
  const pages = new Map<string, string>();

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      const res = result.value as { status: number; headers: Record<string, string>; text: string; url: string };
      if (res.status >= 200 && res.status < 300) {
        const contentType = res.headers["content-type"] ?? "";
        if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
          if (res.text.length <= 2_000_000) {
            pages.set(res.url, normalizeVisibleText(res.text));
          } else {
            // Page too large: all say-facts on this page are mismatches
            return {
              sprintId,
              status: "draft",
              confirmed: false,
              mismatches: sayFacts.map((f, i) => ({
                index: i,
                text: f.text.slice(0, 120),
                source: Array.from(sourceUrls).find((u) => new URL(u).toString() === res.url) ?? "",
                reason: "too large",
              })),
            };
          }
        } else {
          return {
            sprintId,
            status: "draft",
            confirmed: false,
            mismatches: [{ index: 0, text: sayFacts[0]?.text?.slice(0, 120) ?? "", source: res.url, reason: "not html" }],
          };
        }
      } else {
        return {
          sprintId,
          status: "draft",
          confirmed: false,
          mismatches: [{ index: 0, text: sayFacts[0]?.text?.slice(0, 120) ?? "", source: "", reason: "fetch failed" }],
        };
      }
    } else {
      return {
        sprintId,
        status: "draft",
        confirmed: false,
        mismatches: [{ index: 0, text: sayFacts[0]?.text?.slice(0, 120) ?? "", source: "", reason: "fetch failed" }],
      };
    }
  }

  // Check all wordings against pages
  const mismatches: Array<{ index: number; text: string; source: string; reason: string }> = [];

  for (let i = 0; i < sayFacts.length; i++) {
    const fact = sayFacts[i]!;
    const normalized = normalizeWording(fact.text);
    let found = false;

    for (const [url, pageText] of pages) {
      if (pageText && wordingAppearsInText(normalized, pageText)) {
        found = true;
        break;
      }
    }

    if (!found) {
      const sourceUrl = Array.from(sourceUrls).find((u) => new URL(u).toString().startsWith(fact.source ?? "")) ?? Array.from(sourceUrls)[0] ?? "";
      mismatches.push({
        index: i,
        text: fact.text.slice(0, 120),
        source: sourceUrl,
        reason: "cannot verify",
      });
    }
  }

  if (mismatches.length > 0) {
    return {
      sprintId,
      status: "draft",
      confirmed: false,
      mismatches,
    };
  }

  // CAS: update only if status is still draft and facts match
  const rawJsonb = typeof row.facts === "string" ? row.facts : JSON.stringify(row.facts);
  const result = await env.ctx.db.execute(
    `UPDATE ${t("client_facts")} SET status = 'confirmed', updated_by = $1, updated_at = now() WHERE sprint_id = $2 AND company_id = $3 AND status = 'draft' AND facts = $4::jsonb`,
    [actorId(actor), sprintId, companyId, rawJsonb],
  );

  if (result.rowCount === 0) {
    return {
      sprintId,
      status: "draft",
      confirmed: false,
      reason: "sheet changed, retry",
    };
  }

  // Success: compute hash of normalized wordings
  const { createHash } = await import("node:crypto");
  const wordingsJoined = sayFacts.map((f) => normalizeWording(f.text)).join("\n");
  const wordingsHash = createHash("sha256").update(wordingsJoined).digest("hex");

  return {
    sprintId,
    status: "confirmed",
    confirmed: true,
    confirmedBy: {
      agentId: actor.kind === "agent" ? actor.agentId : null,
      runId: actor.kind === "agent" ? actor.runId : null,
    },
    confirmedAt: env.now().toISOString(),
    checked: sayFacts.length,
    checkedUrls: Array.from(sourceUrls),
    wordingsHash,
  };
}
