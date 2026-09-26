/**
 * One dispatcher for agent tools and the UI's generic `seo.call` action.
 */
import * as checks from "./service/checks.js";
import { asParams, SeoError, type Actor, type Env, type Params } from "./service/common.js";
import * as data from "./service/data.js";
import * as gsc from "./service/gsc.js";
import * as optimize from "./service/optimize.js";
import * as snapshots from "./service/snapshots.js";
import * as sprints from "./service/sprints.js";
import * as tasks from "./service/tasks.js";

type Handler = (env: Env, companyId: string, actor: Actor, params: Params) => Promise<unknown>;

export const HANDLERS: Record<string, Handler> = {
  // Sprints
  "list-sprints": (env, c, _a, p) => sprints.listSprintsTool(env, c, p),
  "create-sprint": (env, c, a, p) => sprints.createSprint(env, c, a, p),
  "get-sprint": (env, c, _a, p) => sprints.getSprintTool(env, c, p),
  today: (env, c, _a, p) => sprints.todayTool(env, c, p),
  "set-autopilot": (env, c, a, p) => sprints.setAutopilot(env, c, a, p),
  "update-sprint": (env, c, a, p) => sprints.updateSprintTool(env, c, a, p),
  "pause-sprint": (env, c, a, p) => sprints.setSprintStatus(env, c, a, p, "paused"),
  "resume-sprint": (env, c, a, p) => sprints.setSprintStatus(env, c, a, p, "resume"),
  "archive-sprint": (env, c, a, p) => sprints.setSprintStatus(env, c, a, p, "archived"),
  "post-digest": (env, c, a, p) => sprints.postDigest(env, c, a, p),
  // Tasks
  "list-tasks": (env, c, _a, p) => tasks.listTasksTool(env, c, p),
  "start-task": (env, c, a, p) => tasks.startTask(env, c, a, p),
  "complete-task": (env, c, a, p) => tasks.completeTask(env, c, a, p),
  "block-task": (env, c, a, p) => tasks.blockTask(env, c, a, p),
  "skip-task": (env, c, a, p) => tasks.skipTask(env, c, a, p),
  "add-task": (env, c, a, p) => tasks.addTask(env, c, a, p),
  // Legacy: open-task opened an issue for work a person must do.
  "open-task": (env, c, a, p) => tasks.addTask(env, c, a, { owner: "human", ...p }),
  // Keywords
  "list-keywords": (env, c, _a, p) => data.listKeywordsTool(env, c, p),
  "add-keywords": (env, c, a, p) => data.addKeywords(env, c, a, p),
  "add-keyword": (env, c, a, p) => data.addKeywords(env, c, a, { sprintId: p.sprintId, keywords: [{ ...p, sprintId: undefined }] }),
  "update-keyword": (env, c, _a, p) => data.updateKeywordTool(env, c, p),
  "retire-keyword": (env, c, _a, p) => data.retireKeyword(env, c, p),
  "record-position": (env, c, a, p) => data.recordPosition(env, c, a, p),
  "record-rank": (env, c, a, p) => data.recordPosition(env, c, a, p),
  "keyword-history": (env, c, _a, p) => data.keywordHistoryTool(env, c, p),
  "rank-history": (env, c, _a, p) => data.keywordHistoryTool(env, c, p),
  "discover-keywords": (env, c, _a, p) => data.discoverKeywordsTool(env, c, p),
  // Backlinks
  "list-backlinks": (env, c, _a, p) => data.listBacklinksTool(env, c, p),
  "add-backlink": (env, c, a, p) => data.addBacklink(env, c, a, p),
  "update-backlink": (env, c, a, p) => data.updateBacklinkTool(env, c, a, p),
  // Content
  "list-content": (env, c, _a, p) => data.listContentTool(env, c, p),
  "add-content": (env, c, _a, p) => data.addContent(env, c, p),
  "update-content": (env, c, _a, p) => data.updateContentTool(env, c, p),
  "link-social-post": (env, c, _a, p) => data.linkSocialPost(env, c, p),
  "add-page": (env, c, _a, p) => data.addPage(env, c, p),
  // Site checks
  "check-robots": (env, c, _a, p) => checks.checkRobotsTool(env, c, p),
  "check-sitemap": (env, c, _a, p) => checks.checkSitemapTool(env, c, p),
  "check-meta": (env, c, _a, p) => checks.checkMetaTool(env, c, p),
  "check-canonical": (env, c, _a, p) => checks.checkCanonicalTool(env, c, p),
  "validate-schema": (env, c, _a, p) => checks.validateSchemaTool(env, c, p),
  "internal-link-audit": (env, c, _a, p) => checks.internalLinkAuditTool(env, c, p),
  "crawler-sim": (env, c, _a, p) => checks.crawlerSimTool(env, c, p),
  "run-pagespeed": (env, c, _a, p) => checks.runPagespeedTool(env, c, p),
  // GSC
  "gsc-connect-url": (env, c, _a, p) => gsc.gscConnectUrl(env, c, p),
  "gsc-properties": (env, c, _a, p) => gsc.gscProperties(env, c, p),
  "gsc-set-property": (env, c, _a, p) => gsc.gscSetProperty(env, c, p),
  "gsc-pull": (env, c, _a, p) => gsc.gscPullTool(env, c, p),
  "gsc-query": (env, c, _a, p) => gsc.gscQuery(env, c, p),
  "gsc-submit-sitemap": (env, c, _a, p) => gsc.gscSubmitSitemap(env, c, p),
  "gsc-inspect-url": (env, c, _a, p) => gsc.gscInspectUrl(env, c, p),
  // Audits
  "run-audit-snapshot": (env, c, _a, p) => snapshots.runAuditSnapshotTool(env, c, p),
  "record-finding": (env, c, a, p) => data.recordFinding(env, c, a, p),
  "record-audit": (env, c, a, p) => data.recordFinding(env, c, a, p),
  "resolve-finding": (env, c, _a, p) => data.resolveFindingTool(env, c, p),
  "audit-summary": (env, c, _a, p) => snapshots.auditSummaryTool(env, c, p),
  // Optimization
  "detect-signals": (env, c, _a, p) => optimize.detectSignalsTool(env, c, p),
  "list-optimizations": (env, c, _a, p) => optimize.listOptimizationsTool(env, c, p),
  "approve-optimization": (env, c, a, p) => optimize.approveOptimization(env, c, a, p),
  "reject-optimization": (env, c, a, p) => optimize.rejectOptimization(env, c, a, p),
};

export async function dispatch(env: Env, companyId: string, actor: Actor, name: string, params: unknown): Promise<unknown> {
  const handler = HANDLERS[name];
  if (!handler) throw new SeoError(`Unknown SEO tool ${name}`);
  return handler(env, companyId, actor, asParams(params));
}

/** Short text for the agent next to the structured data. */
export function toolSummary(name: string, data: unknown): string {
  const json = JSON.stringify(data);
  return json.length <= 12_000 ? json : `${json.slice(0, 12_000)}… (truncated; full result in data)`;
}
