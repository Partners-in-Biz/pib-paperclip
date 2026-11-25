/**
 * Social's board card for one post (PAR-14389 plan, C.2 Social row, D row B3a): the three `canvas.cards.*` answers
 * built on the same store function and per-record rule as the page. `resolve` is `requirePost` (the page's detail
 * action), `search` and `related` are `listPosts` with `postVisible` (the page's list). A missing, deleted, other
 * company's or not-visible post is left out, which the helper answers as `{ hidden: true }`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { type CanvasCardInput, type CanvasCardKind, formatClientParam } from "@partnersinbiz/pib-plugin-kit";
import { listPosts, type PostRow } from "./db.js";
import { SocialError } from "./domain.js";
import { resolveScope, scopeOfRow } from "./clients.js";
import { postVisible, requirePost, type Viewer } from "./service.js";
import { POST_CARD_SLOT } from "./slots.js";

const CRM_PLUGIN = "partnersinbiz.crm";
const TITLE_MAX = 80;

/** The person behind the call, as the page's `actionViewer` builds it (a card call is always a user). */
function viewerOf(companyId: string, userId: string | null): Viewer {
  return { companyId, userId, agentId: null, runId: null, isAgent: false };
}

function titleOf(body: string): string {
  const line = body.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!line) return "Untitled post";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function dayOf(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function postCard(row: PostRow): CanvasCardInput {
  const scope = scopeOfRow(row);
  const meta: Array<{ label: string; value: string }> = [];
  const published = dayOf(row.published_at);
  const scheduled = dayOf(row.scheduled_at);
  if (published) meta.push({ label: "Published", value: published });
  else if (scheduled) meta.push({ label: "Scheduled", value: scheduled });
  if (row.scope === "personal") meta.push({ label: "Visibility", value: "Personal" });
  return {
    id: row.id,
    title: titleOf(row.body),
    subtitle: scope ? row.client_name ?? formatClientParam(scope) : "Own work",
    status: row.status,
    meta,
    href: scope ? `/social?client=${formatClientParam(scope)}` : "/social",
  };
}

/** The viewer's call user: the person the call is for (`onBehalfOfUserId` when an agent acts for them). */
function callViewer(companyId: string, call: { context: { actor: { userId?: string | null; onBehalfOfUserId?: string | null } } }): Viewer {
  const actor = call.context.actor;
  return viewerOf(companyId, actor.onBehalfOfUserId ?? actor.userId ?? null);
}

export function createPostCardKind(ctx: PluginContext): CanvasCardKind {
  return {
    type: POST_CARD_SLOT,
    async resolve(ids, call) {
      const viewer = callViewer(call.companyId, call);
      const cards: CanvasCardInput[] = [];
      for (const id of ids) {
        try {
          cards.push(postCard(await requirePost(ctx, viewer, id)));
        } catch (error) {
          if (!(error instanceof SocialError)) throw error;
        }
      }
      return cards;
    },
    async search({ q, limit }, call) {
      const viewer = callViewer(call.companyId, call);
      const rows = await listPosts(ctx, call.companyId, { q, limit });
      return rows.filter((row) => postVisible(viewer, row)).map(postCard);
    },
    async related({ of, limit }, call) {
      if (of.plugin !== CRM_PLUGIN || (of.type !== "card-company" && of.type !== "card-contact")) return [];
      const viewer = callViewer(call.companyId, call);
      let scope;
      try {
        scope = (await resolveScope(ctx, call.companyId, { kind: of.type === "card-company" ? "company" : "contact", id: of.id })).scope;
      } catch (error) {
        if (error instanceof SocialError) return [];
        throw error;
      }
      const rows = await listPosts(ctx, call.companyId, { scope, limit: limit + 1 });
      const cards = rows.filter((row) => postVisible(viewer, row)).map(postCard);
      return cards.length ? [{ relation: "posts", label: "Posts", cards }] : [];
    },
  };
}

