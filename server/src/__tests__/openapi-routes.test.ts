import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { MUSE_ASSET_VERSION, MUSE_PUBLIC_ROUTES } from "@paperclipai/shared";
import { COMPANY_IMPORT_TRANSFERS_ROUTE_PATH } from "@paperclipai/shared/company-import-transfer";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";
import { mcpDiscoveryDocuments } from "../services/public-mcp/discovery.js";
import {
  MEMBER_RESTRICTION_ROUTE_TABLE,
  PLUGIN_GATE_NOT_GATED,
  createRouteClassifier,
  type MemberRestrictionRouteEntry,
} from "../services/member-restriction/route-table.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "cases.ts": "/api",
  "case-handoffs.ts": "/api",
  "workflows.ts": "/api",
  "smoke-lab.ts": "/api",
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agents.ts": "/api",
  "agent-project-access.ts": "/api",
  "agent-commentary.ts": "/api",
  "agent-chat-messages.ts": "/api",
  "agent-avatars.ts": "/api",
  "agent-profile-avatar.ts": "/api",
  "announcements.ts": "/api",
  "ai-connections.ts": "/api",
  "decision-models.ts": "/api",
  "agent-observability.ts": "/api",
  "fast-responses.ts": "/api",
  "prompt-injection-prevention.ts": "/api",
  "attention.ts": "/api",
  "approvals.ts": "/api",
  "assets.ts": "/api",
  "auth.ts": "/api/auth",
  "board-chat.ts": "/api",
  "browser-use.ts": "/api",
  "built-in-agents.ts": "/api",
  "chat-channels.ts": "/api",
  "slack-tools.ts": "/api",
  "email.ts": "/api",
  "cloud.ts": "/api/cloud",
  "customer-success.ts": "/api/customer-success/v1",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "company-skill-policy.ts": "/api",
  "connection-intents.ts": "/api",
  "connection-event-wake.ts": "/",
  "ephemeral-enrollment.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "dot-runner.ts": "/api",
  "muse.ts": "/api",
  "muse-qualification.ts": "/api",
  "grok-bot.ts": "/api",
  "decision-queues.ts": "/api",
  "decisions.ts": "/api",
  "decision-training.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "task-workspaces.ts": "/api",
  "file-resources.ts": "/api",
  "folders.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "ready.ts": "/api/ready",
  "liveness.ts": "/api/liveness",
  "inbox-agent-policy.ts": "/api",
  "inbox-dismissals.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "issues.ts": "/api",
  "issue-tree-control.ts": "/api",
  "llms.ts": "/api",
  "managed-agent-profiles.ts": "/api",
  "onboarding-seed.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "planning-canvases.ts": "/api",
  "planning-canvas-sharing.ts": "/api",
  "planning-canvas-comments.ts": "/api",
  "planning-canvas-links.ts": "/api",
  "planning-canvas-blueprints.ts": "/api",
  "projects.ts": "/api",
  "primary-agent.ts": "/api",
  "public-mcp.ts": "/api",
  "project-tools.ts": "/api",
  "resource-memberships.ts": "/api",
  "remote-agent-profiles.ts": "/api",
  "routines.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "summary-slots.ts": "/api",
  "status-cards.ts": "/api",
  "teams-catalog.ts": "/api",
  "tool-access.ts": "/api",
  "voice-sessions.ts": "/api",
  "tool-gateway.ts": "/api",
  "user-profiles.ts": "/api",
  "workspace-preferences.ts": "/api",
};

const ROUTE_LITERAL_PATTERN =
  /router\.(get|head|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTE_ARRAY_PATTERN = /router\.(get|head|post|put|patch|delete)\(\s*\[([^\]]+)\]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|head|post|put|patch|delete)\(/;
const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
const explicitOpenApiCoverageExclusions = new Set<string>();

const explicitOpenApiOperationCoverageExclusions = new Set([
  // Exact Cloud-control signed action; ordinary board/agent credentials cannot invoke it.
  "POST /api/instance/connector-events/wake",
  "POST /api/instance/ephemeral-enrollment/prepare",
  // Muse uses its closed, versioned receiver protocol and dedicated credentials,
  // documented in doc/muse-personal-agent.md and the shared protocol contract.
  // Board connection/qualification management remains in this OpenAPI document.
  ...MUSE_PUBLIC_ROUTES.map(route => `${route.method} ${route.path}`),
  // Inspection uses its own versioned Cloud-permit/managed-run protocol,
  // documented in CUSTOMER-SUCCESS-INSPECTION.md and the shared contract.
  // Ordinary board sessions and agent API keys cannot invoke these endpoints.
  "GET /api/customer-success/v1/run-authority",
  "POST /api/customer-success/v1/read",
  // OAuth discovery and protocol endpoints have their own metadata contract;
  // browser connection-management operations remain documented in the board API.
  // Markdown rendering of the separately documented assistant setup page.
  "GET /api/mcp/setup.md",
  "GET /.well-known/oauth-protected-resource",
  "GET /.well-known/oauth-protected-resource/mcp/paperclip",
  "GET /.well-known/oauth-protected-resource/mcp/runner",
  "GET /.well-known/oauth-authorization-server",
  "POST /mcp/oauth/register",
  "POST /mcp/oauth/device_authorization",
  "GET /mcp/oauth/authorize",
  "POST /mcp/oauth/token",
  "POST /mcp/oauth/revoke",
  "GET /.well-known/oauth-authorization-server/mcp/runner/oauth",
  "POST /mcp/runner/oauth/register",
  "POST /mcp/runner/oauth/device_authorization",
  "GET /mcp/runner/oauth/authorize",
  "POST /mcp/runner/oauth/token",
  "POST /mcp/runner/oauth/revoke",
  // This endpoint is authenticated by the provider signature rather than by a
  // Paperclip board/agent credential. It intentionally stays out of the public
  // board API document, while this exact exclusion keeps route coverage honest.
  "POST /api/chat-webhooks/agentmail/{publicId}",
  "POST /api/chat-webhooks/{publicId}/{provider}",
  "POST /api/voice-webhooks/{publicId}/events",
  "POST /api/voice-webhooks/{publicId}/tools",
]);

// The set of contract-first routes whose OpenAPI document leads the mounted
// request handler. The company-and-environment Claude setup-token login routes
// now have request handlers, so the set is empty. A new contract-first route
// belongs here only until its handler lands.
const specOnlyContractFirstRoutes = new Set<string>([]);

function createApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  return app;
}

// Route files may compose paths from shared path constants inside template
// literals; substitute the constants' values before normalizing.
const routePathConstantSubstitutions: Record<string, string> = {
  "${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}": COMPANY_IMPORT_TRANSFERS_ROUTE_PATH,
};

function normalizeExpressPath(routePath: string) {
  let substituted = routePath;
  for (const [placeholder, value] of Object.entries(
    routePathConstantSubstitutions,
  )) {
    substituted = substituted.split(placeholder).join(value);
  }
  return substituted
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function resolveMountedPath(file: string, prefix: string, routePath: string) {
  if (file === "connection-event-wake.ts") return routePath;
  if (file === "public-mcp.ts" && (routePath.startsWith("/mcp/oauth/") || routePath.startsWith("/.well-known/"))) return routePath;
  if (
    (file === "chat-channels.ts" || file === "email.ts") &&
    routePath.startsWith("/api/chat-webhooks/")
  ) {
    return routePath;
  }
  if (file === "voice-sessions.ts" && routePath.startsWith("/api/voice-webhooks/")) return routePath;
  if (file === "tool-gateway.ts" && routePath.startsWith("/mcp/gateways/")) {
    return routePath;
  }
  if (
    file === "connection-intents.ts" &&
    (routePath.startsWith("/mcp/") || routePath.startsWith("/runtime-tools/"))
  ) {
    return routePath;
  }
  if ((file === "companies.ts" || file === "health.ts" || file === "liveness.ts" || file === "ready.ts") && routePath === "/") {
    return prefix;
  }
  if (file === "companies.ts" || file === "health.ts") {
    return `${prefix}${routePath}`;
  }
  if (file === "auth.ts") {
    return `${prefix}${routePath === "/" ? "" : routePath}`;
  }
  return `${prefix}${routePath}`;
}

/** Source from one route registration up to the next one: the handler, for the member-restriction scan. */
function handlerSource(source: string, index: number) {
  const next = source.slice(index + 1).search(/\brouter\.(get|head|post|put|patch|delete|use)\(/);
  return source.slice(index, next < 0 ? undefined : index + 1 + next);
}

function loadActualRoutes() {
  const routes = new Set<string>();
  const excludedRoutes = new Set<string>();
  const mounts = new Set<string>();
  const handlerSources = new Map<string, string>();
  // Where each operation is first registered, and how often, for the `shadows` check of the route table scan.
  const positions = new Map<string, { file: string; index: number }>();
  const registrations = new Map<string, number>();
  const position = (operation: string, file: string, index: number | undefined) => {
    if (!positions.has(operation)) positions.set(operation, { file, index: index ?? 0 });
    registrations.set(operation, (registrations.get(operation) ?? 0) + 1);
  };
  const unknownRouteFiles: string[] = [];

  for (const file of fs
    .readdirSync(ROUTES_DIR)
    .filter((entry) => entry.endsWith(".ts"))) {
    if (explicitOpenApiCoverageExclusions.has(file)) continue;
    const prefix = apiPrefixes[file];
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!prefix) {
      if (ROUTER_METHOD_PATTERN.test(source)) {
        unknownRouteFiles.push(file);
      }
      continue;
    }

    for (const match of source.matchAll(ROUTE_LITERAL_PATTERN)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const operation = `${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`;
      handlerSources.set(operation, handlerSource(source, match.index ?? 0));
      position(operation, file, match.index);
      if (explicitOpenApiOperationCoverageExclusions.has(operation)) {
        excludedRoutes.add(operation);
      } else {
        routes.add(operation);
      }
    }

    for (const match of source.matchAll(ROUTE_ARRAY_PATTERN)) {
      for (const literal of match[2].matchAll(/["'`]([^"'`]+)["'`]/g)) {
        const operation = `${match[1].toUpperCase()} ${normalizeExpressPath(resolveMountedPath(file, prefix, literal[1]))}`;
        handlerSources.set(operation, handlerSource(source, match.index ?? 0));
        // Each literal of an array gets its own offset (`match[0]` ends with `match[2]` and "]").
        const literalIndex = (match.index ?? 0) + match[0].length - match[2].length - 1 + (literal.index ?? 0);
        position(operation, file, literalIndex);
        if (explicitOpenApiOperationCoverageExclusions.has(operation)) excludedRoutes.add(operation);
        else routes.add(operation);
      }
    }

    // Mounts (`router.use("/plugins/:pluginId/api")`), for `USE` rows of the route table.
    for (const match of source.matchAll(/router\.use\(\s*["'`]([^"'`]+)["'`]/g)) {
      const operation = `USE ${normalizeExpressPath(resolveMountedPath(file, prefix, match[1]))}`;
      mounts.add(operation);
      handlerSources.set(operation, handlerSource(source, match.index ?? 0));
      position(operation, file, match.index);
    }

    if (file === "public-mcp.ts") {
      // The shared gateway mounts these protocol paths for each OAuth resource.
      if (source.includes("mcpDiscoveryDocuments({") && source.includes("router.get(entry.path,")) {
        for (const entry of mcpDiscoveryDocuments({ origin: "https://example.test",
          authorizationOrigin: "https://example.test", profiles: ["personal-mcp", "dot-mcp"] })) {
          const operation = `GET ${entry.path}`;
          if (explicitOpenApiOperationCoverageExclusions.has(operation)) excludedRoutes.add(operation);
          else routes.add(operation);
        }
      }
      for (const match of source.matchAll(/router\.(get|post)\(oauthPath \+ "([^"]+)"/g)) {
        for (const oauthPath of ["/mcp/oauth", "/mcp/runner/oauth"]) {
          const operation = `${match[1].toUpperCase()} ${oauthPath}${match[2]}`;
          if (explicitOpenApiOperationCoverageExclusions.has(operation)) excludedRoutes.add(operation);
          else routes.add(operation);
        }
      }
    }
    const variablePaths = file === "dot-runner.ts" ? ["path", "invitePath"]
      : file === "grok-bot.ts" ? ["path"]
      : file === "muse.ts" ? ["path", "invite"]
      : file === "muse-qualification.ts" ? ["path"] : [];
    for (const name of variablePaths) {
      const basePath = new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`).exec(source)?.[1];
      if (!basePath) throw new Error(`${file} ${name} route prefix is missing`);
      const methods = new RegExp(`router\\.(get|post|put|delete)\\(\\s*${name}(?:\\s*\\+\\s*"([^"]+)")?\\s*,`, "g");
      for (const match of source.matchAll(methods)) {
        routes.add(`${match[1].toUpperCase()} ${normalizeExpressPath(prefix + basePath + (match[2] ?? ""))}`);
      }
    }
    if (file === "muse.ts" && /for\s*\(const route of MUSE_PUBLIC_ROUTES\)/.test(source)) {
      for (const route of MUSE_PUBLIC_ROUTES) excludedRoutes.add(`${route.method} ${route.path}`);
    }

    if (
      file === "companies.ts" &&
      source.includes("router.post(COMPANY_IMPORT_ROUTE_PATH")
    ) {
      routes.add("POST /api/companies/import");
    }
    if (
      file === "companies.ts" &&
      source.includes("router.post(COMPANY_IMPORT_TRANSFERS_ROUTE_PATH")
    ) {
      routes.add(`POST /api/companies${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}`);
    }
  }

  return {
    routes,
    excludedRoutes,
    mounts,
    handlerSources,
    positions,
    registrations,
    unknownRouteFiles: unknownRouteFiles.sort(),
  };
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<
    Record<string, Record<string, unknown>>
  >(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return { spec, routes };
}

describe("openapi routes", () => {
  it("documents the export include body so agents can request projects and skills", () => {
    const spec = buildOpenApiSpec();
    for (const path of ["/api/companies/{companyId}/exports", "/api/companies/{companyId}/exports/preview"]) {
      const operation = spec.paths[path].post;
      const body = operation.requestBody.content["application/json"].schema;
      expect(body.properties.include.properties).toMatchObject({ projects: expect.anything(), skills: expect.anything() });
      expect(operation.description).toMatch(/include\.projects/);
    }
  });
  it("documents the safe company import body so agents can preview and resolve agent name conflicts", () => {
    const spec = buildOpenApiSpec();
    for (const path of ["/api/companies/{companyId}/imports/preview", "/api/companies/{companyId}/imports/apply"]) {
      const operation = spec.paths[path].post;
      const body = operation.requestBody.content["application/json"].schema;
      expect(body.required).toEqual(expect.arrayContaining(["source", "target"]));
      expect(body.properties).toMatchObject({ collisionStrategy: expect.anything(), nameOverrides: expect.anything(), include: expect.anything() });
      expect(operation.description).toMatch(/replace/);
    }
  });
  it("documents generic webhook provenance headers and accepted responses without a provider-specific endpoint", () => {
    const spec = buildOpenApiSpec();
    const operation = spec.paths["/api/routine-triggers/public/{publicId}/fire"].post;
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "header", name: "X-Paperclip-Source-Run-Token", required: false }),
      expect.objectContaining({ in: "header", name: "X-Paperclip-Idempotency-Scope", required: false }),
    ]));
    for (const status of ["202", "400", "401", "404", "409", "415", "422"]) expect(operation.responses).toHaveProperty(status);
    expect(operation.requestBody.content).toHaveProperty("application/json");
    expect(spec.paths).not.toHaveProperty("/api/routine-triggers/public/{publicId}/sentry-run-failures");
  });
  it.each(["summary", "tasks"])("documents the board-only compact attention %s contract", projection => {
    const spec = buildOpenApiSpec() as any;
    const operation = spec.paths[`/api/companies/{companyId}/attention/${projection}`].get;
    expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(operation.parameters.filter((parameter: { in: string }) => parameter.in === "query")).toEqual([]);
    const response = operation.responses["200"].content["application/json"].schema;
    expect(response.properties.totalCount).toMatchObject({ type: "integer", minimum: 0 });
    expect(response.properties.generatedAt).toMatchObject({ format: "date-time" });
    expect(response.properties.items).toBeUndefined();
    expect(response.properties.nextCursor).toBeUndefined();
    if (projection === "tasks") expect(response.properties.taskIds).toMatchObject({ type: "array", items: { type: "string", format: "uuid" } });
    for (const code of ["200", "401", "403"]) expect(operation.responses[code]).toBeDefined();
  });

  it("documents the owned pending-question read as canonical attention items without client scope overrides", () => {
    const spec = buildOpenApiSpec() as any;
    const operation = spec.paths["/api/issues/{id}/pending-questions"].get;
    expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(operation.parameters.filter((parameter: { in: string }) => parameter.in === "query")).toEqual([]);
    const response = operation.responses["200"].content["application/json"].schema;
    expect(response).toMatchObject({ type: "array", items: { type: "object", properties: {
      sourceKind: { enum: ["issue_thread_interaction"] },
      detail: { properties: { kind: { enum: ["questions"] } } },
    } } });
    for (const code of ["200", "400", "401", "403", "404"]) expect(operation.responses[code]).toBeDefined();
  });

  it("documents owned conversation reads and exact revision access separately", () => {
    const spec = buildOpenApiSpec() as any;
    const boardSecurity = [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }];
    for (const path of [
      "/api/issues/{id}/decision-receipts",
      "/api/issues/{id}/chat-handoffs",
      "/api/companies/{companyId}/attention/history",
    ]) {
      const operation = spec.paths[path].get;
      expect(operation.security).toEqual(boardSecurity);
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      const query = Object.fromEntries(operation.parameters
        .filter((parameter: { in: string }) => parameter.in === "query")
        .map((parameter: { name: string; schema: unknown }) => [parameter.name, parameter.schema]));
      expect(query.cursor).toMatchObject({ type: "string", maxLength: 1000 });
      expect(query.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 100 });
      if (path.endsWith("/history")) {
        expect(query.search).toMatchObject({ maxLength: 200 });
        expect(query.outcome).toMatchObject({ maxLength: 40 });
        expect(query.agentId).toMatchObject({ format: "uuid" });
        expect(query.projectId).toMatchObject({ format: "uuid" });
        expect(query.sort).toMatchObject({ enum: ["newest", "oldest"] });
        expect(query.since).toMatchObject({ format: "date-time" });
      } else {
        expect(Object.keys(query).sort()).toEqual(["cursor", "limit"]);
        expect(operation.responses["404"]).toBeDefined();
      }
      for (const code of ["200", "400", "401", "403"]) {
        expect(operation.responses[code]).toBeDefined();
      }
    }

    const revision = spec.paths["/api/issues/{id}/documents/{key}/revisions/{revisionId}"].get;
    expect(revision.security).toEqual([...boardSecurity, { AgentBearerAuth: [] }]);
    const params = Object.fromEntries(revision.parameters.map(
      (parameter: { name: string; schema: unknown }) => [parameter.name, parameter.schema],
    ));
    expect(params.key).toMatchObject({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9_-]*$" });
    expect(params.revisionId).toMatchObject({ type: "string", format: "uuid" });
    for (const code of ["200", "400", "401", "403", "404"]) {
      expect(revision.responses[code]).toBeDefined();
    }
  });

  it("removes Pipelines discovery while retaining Cases and Routines", () => {
    const spec = buildOpenApiSpec() as any;
    const paths = Object.keys(spec.paths);
    expect(paths.filter((path) => /pipelines|review-cases|case-events/.test(path))).toEqual([]);
    // Standalone handoffs also use caseId; that parameter name no longer
    // identifies a removed Pipeline operation. Retain only their live paths.
    expect(paths.filter((path) => path.startsWith("/api/cases/{caseId}")).sort()).toEqual([
      "/api/cases/{caseId}/handoffs",
      "/api/cases/{caseId}/handoffs/{handoffId}/cancel",
      "/api/cases/{caseId}/handoffs/{handoffId}/retry",
    ]);
    expect(spec.paths["/api/companies/{companyId}/cases"].post).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/case-handoffs"].post).toBeDefined();
    expect(spec.paths["/api/cases/{id}"].get).toBeDefined();
    expect(spec.paths["/api/routines/{id}/run"].post).toBeDefined();
  });

  it("documents anonymous liveness separately from database readiness", () => {
    const spec = buildOpenApiSpec() as any;
    for (const method of ["get", "head"]) {
      const operation = spec.paths["/api/liveness"][method];
      expect(operation.security).toEqual([]);
      expect(operation.responses[503]).toBeDefined();
    }
    expect(Object.keys(spec.paths["/api/liveness"].get.responses[200].content["application/json"].schema.properties))
      .toEqual(["status", "commit"]);
    expect(spec.paths["/api/health"].get.responses[503]).toBeDefined();
  });
  it("documents only writable agent update fields and lifecycle status requests", () => {
    const document = buildOpenApiSpec() as any;
    const properties = document.paths["/api/agents/{id}"].patch.requestBody.content["application/json"].schema.properties;
    expect(properties).not.toHaveProperty("spentMonthlyCents");
    expect(properties.status.enum).toEqual(["paused", "idle", "terminated"]);
    expect(properties).toHaveProperty("name");
    expect(properties).toHaveProperty("budgetMonthlyCents");
  });

  it("documents public Dot pairing capabilities while ordinary consent keeps board authentication", () => {
    const spec = buildOpenApiSpec() as any;
    for (const [method, path] of [
      ["get", "/api/dot-mcp/requests/{id}"],
      ["post", "/api/dot-mcp/requests/{id}/dot-pairing"],
      ["post", "/api/dot-mcp/requests/{id}/dot-pairing/preview"],
    ]) {
      expect(spec.paths[path][method].security).toEqual([]);
      expect(spec.paths[path][method].responses["404"]).toBeDefined();
    }
    expect(spec.paths["/api/mcp/requests/{id}/consent"].post.security).not.toEqual([]);
  });

  it("documents manager-only task privacy hints without protected scope identity", () => {
    const spec = buildOpenApiSpec() as any;
    const operation = spec.paths["/api/issues/{id}/privacy-constraints"].get;
    const schema = operation.responses["200"].content["application/json"].schema;
    expect(schema.properties).toEqual({
      publicBlockedBy: { type: "string", enum: ["parent", "project"], nullable: true },
      leavesPersonalProject: { type: "boolean" },
    });
    expect(schema.required).toEqual(["publicBlockedBy", "leavesPersonalProject"]);
    expect(operation.responses["403"]).toBeDefined();
    expect(operation.responses["404"]).toBeDefined();
  });

  it("documents strict run-attributed feedback and board-or-agent commentary reads", () => {
    const { spec } = loadSpecRoutes();
    const path = spec.paths["/api/companies/{companyId}/agent-commentary"];
    expect(Object.keys(path)).toEqual(["get", "post"]);
    const detail = spec.paths["/api/companies/{companyId}/agent-commentary/{id}"].get;
    for (const read of [path.get, detail]) {
      expect(read.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }, { AgentBearerAuth: [] }]);
      expect(read.responses["403"]).toBeDefined();
      expect(read.responses["404"]).toBeDefined();
    }
    expect(path.get.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(
      expect.arrayContaining(["agentId", "kind", "q", "limit", "offset"]),
    );
    const operation = path.post;
    expect(operation.security).toEqual([{ AgentBearerAuth: [] }]);
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "agent", heartbeatBound: true });
    expect(operation.description).toContain("X-Paperclip-Run-Id");
    const body = operation.requestBody.content["application/json"].schema;
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(body.properties).sort()).toEqual(["body", "idempotencyKey", "kind"]);
    expect(body.properties.body.maxLength).toBe(524288);
    for (const code of ["200", "201"]) {
      const result = operation.responses[code].content["application/json"].schema;
      expect(result.additionalProperties).toBe(false);
      expect(Object.keys(result.properties).sort()).toEqual(["createdAt", "id", "kind", "replayed"]);
    }
    expect(operation.responses["409"]).toBeDefined();
    expect(operation.responses["503"]).toBeDefined();
  });

  it("documents delegated pool management with revision-checked deletion", () => {
    const { spec } = loadSpecRoutes();
    const pools = spec.paths["/api/companies/{companyId}/ai-connection-pools"];
    const remove = spec.paths["/api/companies/{companyId}/ai-connection-pools/{poolId}"].delete;
    const inspection = spec.paths["/api/companies/{companyId}/ai-connection-pools/{poolId}/inspection"].get;
    for (const operation of [pools.get, pools.post, remove, inspection]) {
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }, { AgentBearerAuth: [] }]);
    }
    expect(remove.requestBody.required).toBe(true);
    expect(remove.requestBody.content["application/json"].schema).toMatchObject({
      required: ["expectedRevision"], additionalProperties: false,
      properties: { expectedRevision: { type: "integer", minimum: 0, exclusiveMinimum: true } },
    });
    expect(Object.keys(remove.responses)).toEqual(expect.arrayContaining(["200", "400", "401", "403", "404", "409"]));
  });

  it("documents masked board-only agent export settings and revision-checked writes", () => {
    const { spec } = loadSpecRoutes();
    const settings = spec.paths["/api/companies/{companyId}/observability"];
    const test = spec.paths["/api/companies/{companyId}/observability/test"].post;
    for (const operation of [settings.get, settings.put, settings.delete, test]) {
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    }
    expect(settings.delete.requestBody.content["application/json"].schema).toMatchObject({ required: ["expectedRevision"], additionalProperties: false });
    expect(test.responses["409"]).toBeDefined();
    expect(JSON.stringify(settings.get.responses)).not.toMatch(/credentialsSecretId|ciphertext|apiKey/);
    expect(test.responses["200"].content["application/json"].schema.properties.source).toMatchObject({ enum: ["control_plane"] });
  });

  it("documents personal board-only announcements and private responses", () => {
    const { spec } = loadSpecRoutes();
    const current = spec.paths["/api/announcements/current"].get;
    const image = spec.paths["/api/announcements/{id}/image"].get;
    const animation = spec.paths["/api/announcements/{id}/animation"].get;
    const dismiss = spec.paths["/api/announcements/{id}/dismiss"].post;
    for (const operation of [current, image, animation, dismiss]) {
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      const success = operation.responses["200"] ?? operation.responses["204"];
      expect(success.headers["Cache-Control"].schema.enum).toEqual(["private, no-store"]);
    }
    expect(current.responses["200"].content["application/json"].schema.nullable).toBe(true);
    expect(Object.keys(image.responses["200"].content)).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(dismiss.requestBody.content["application/json"].schema).toMatchObject({
      required: ["companyId"], additionalProperties: false,
    });
    expect(dismiss.description).toContain("viewers may dismiss their own");
  });

  it("tells agents that archiving keeps a status card and where a person restores it", async () => {
    const res = await request(createApp()).get("/api/openapi.json");
    const patch = res.body.paths["/api/status-cards/{id}"].patch;
    expect(patch.description).toContain("it is not deleted");
    expect(patch.description).toContain("give them the returned href as a Markdown link");
    expect(patch.description).toContain("Restoring (archived: false) starts a fresh full summary");
  });

  it("documents exact failed-run selection and durable accepted retry responses", async () => {
    const res = await request(createApp()).get("/api/openapi.json");
    const wake = res.body.paths["/api/agents/{id}/wakeup"].post;
    expect(
      wake.requestBody.content["application/json"].schema.properties
        .failedRunId,
    ).toMatchObject({ type: "string", format: "uuid" });
    expect(wake.responses["202"]).toBeDefined();
    expect(wake.responses["409"]).toBeDefined();
    expect(wake.description).toContain("durable queued/deferred receipt");
  });
  it("advertises the guarded prepared-task promotion contract to API clients", async () => {
    const res = await request(createApp()).get("/api/openapi.json");
    const patch = res.body.paths["/api/issues/{id}"].patch;
    expect(patch.requestBody.content["application/json"].schema.properties.expectedStatusVersion)
      .toMatchObject({ type: "integer", minimum: 0 });
    expect(patch.responses["409"]).toBeDefined();
    expect(patch.description).toContain("send exactly status=todo and expectedStatusVersion");
  });
  it("serves the generated OpenAPI document", async () => {
    const res = await request(createApp()).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Paperclip API");
    expect(res.body.paths["/api/openapi.json"].get.summary).toBe(
      "Get the generated OpenAPI document",
    );
    expect(
      res.body.paths["/api/companies/{companyId}/agents"].get.summary,
    ).toBe("List agents in a company");
    expect(res.body.paths["/api/agents/{id}/keys"].post.summary).toBe(
      "Create an agent API key",
    );
    expect(res.body.components.securitySchemes).toMatchObject({
      BoardSessionAuth: { type: "apiKey", in: "cookie" },
      BoardApiKeyAuth: { type: "http", scheme: "bearer" },
      AgentBearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(res.body.paths["/api/health"].get.security).toEqual([]);
    expect(res.body.paths["/api/mcp/project-tools"].post.security).toEqual([{ AgentRunAuth: [] }]);
    expect(res.body.paths["/api/mcp/project-tools"].post["x-paperclip-authorization"]).toEqual({ actor: "agent", heartbeatBound: true, taskBound: true });
    expect(res.body.paths["/mcp/gateways/{gatewayPublicId}"].post.security).toEqual([]);
    expect(res.body.paths["/api/mcp/gateways/{gatewayPublicId}"]).toBeUndefined();
    expect(res.body.paths["/api/companies"].get.parameters).toContainEqual({
      name: "scope",
      in: "query",
      required: false,
      schema: { type: "string", enum: ["accessible"] },
    });
    expect(res.body.paths["/api/companies"].get.responses["403"]).toBeDefined();
    expect(res.body.paths["/api/companies"].get.responses["400"]).toBeDefined();
    expect(
      res.body.paths["/api/companies"].post.responses["201"],
    ).toBeDefined();
    expect(
      res.body.paths["/api/companies"].post.requestBody.content[
        "application/json"
      ].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(
      JSON.stringify(res.body.paths["/api/companies"].post.responses),
    ).not.toContain("candidates");
    expect(
      res.body.paths["/api/companies/{companyId}/skills/scan-projects"].post
        .responses["200"].content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        candidates: { type: "array" },
      },
      required: expect.arrayContaining(["candidates"]),
    });
    expect(
      res.body.paths["/api/agents/{id}/keys"].post.requestBody.content[
        "application/json"
      ].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
    expect(
      res.body.paths["/api/companies/{companyId}/folders"].post.responses[
        "201"
      ],
    ).toBeDefined();
    expect(
      Object.keys(
        res.body.paths[
          "/api/issues/{id}/work-products/{workProductId}/review-document"
        ].post.responses,
      ).sort(),
    ).toEqual(["200", "201", "401", "403", "404", "409", "413", "415", "422"]);
    expect(
      res.body.paths["/api/issues/{id}/interactions/{interactionId}/withdraw"]
        .post.summary,
    ).toBe("Withdraw a pending issue thread interaction");
    const createInteraction =
      res.body.paths["/api/issues/{id}/interactions"].post;
    expect(createInteraction.description).toContain(
      "defaults to canonical `anyone`",
    );
    const createInteractionSchema = JSON.stringify(
      createInteraction.requestBody.content["application/json"].schema,
    );
    for (const resolverPolicy of [
      "anyone",
      "not_creator",
      "human_only",
      "board_or_agents",
      "board_only",
    ]) {
      expect(createInteractionSchema).toContain(`\"${resolverPolicy}\"`);
    }
    expect(
      res.body.paths["/api/companies/{companyId}/folders/items/move"].post
        .summary,
    ).toBe("Move an item into or out of a folder");
    const createQueue =
      res.body.paths["/api/companies/{companyId}/decision-queues"].post;
    expect(createQueue.security).toContainEqual({ AgentBearerAuth: [] });
    expect(createQueue.responses["200"]).toBeDefined();
    expect(createQueue.responses["201"]).toBeDefined();
    expect(
      createQueue.requestBody.content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        key: { type: "string", minLength: 1, maxLength: 80 },
        title: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["key", "title"],
    });
    const updateTriage =
      res.body.paths[
        "/api/companies/{companyId}/decision-triage/{sourceKind}/{sourceId}"
      ].put;
    expect(updateTriage.responses["422"]).toBeDefined();
    expect(
      updateTriage.requestBody.content["application/json"].schema.properties,
    ).toMatchObject({
      decideBy: { nullable: true },
      snoozedUntil: { type: "string", format: "date-time", nullable: true },
    });
    expect(
      JSON.stringify(res.body.paths["/api/tool-gateway/tools"].get),
    ).not.toContain("sessionToken");
    expect(
      JSON.stringify(res.body.paths["/api/tool-gateway/tools/call"].post),
    ).not.toContain("sessionToken");
  });

  it("publishes delegated chat configuration and human-only confirmation boundaries", () => {
    const { spec } = loadSpecRoutes();
    const boardSecurity = [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }];
    const operations = [
      ["get", "/api/companies/{companyId}/chat-endpoints"],
      ["post", "/api/companies/{companyId}/chat-endpoints"],
      ["get", "/api/chat-endpoints/{endpointId}"],
      ["get", "/api/chat-endpoints/{endpointId}/github/configuration"],
      ["put", "/api/chat-endpoints/{endpointId}/github/configuration"],
      ["post", "/api/chat-endpoints/{endpointId}/github/verify"],
      ["put", "/api/chat-endpoints/{endpointId}/github/progress"],
      ["get", "/api/chat-endpoints/{endpointId}/github/reviews"],
      ["get", "/api/chat-endpoints/{endpointId}/github/personal-connections"],
      ["post", "/api/chat-endpoints/{endpointId}/github/identity"],
      ["post", "/api/chat-endpoints/{endpointId}/github/people/lookup"],
      ["post", "/api/chat-endpoints/{endpointId}/github/registration"],
      ["post", "/api/chat-endpoints/{endpointId}/github/app"],
      ["post", "/api/chat-endpoints/{endpointId}/github/repositories/refresh"],
      ["patch", "/api/chat-endpoints/{endpointId}"],
      ["post", "/api/chat-endpoints/{endpointId}/setup"],
      ["post", "/api/chat-endpoints/{endpointId}/setup-secret"],
      ["post", "/api/chat-endpoints/{endpointId}/test"],
      ["post", "/api/chat-endpoints/{endpointId}/photon/inspect"],
      ["get", "/api/chat-endpoints/{endpointId}/resources"],
      ["put", "/api/chat-endpoints/{endpointId}/resources"],
      ["get", "/api/chat-endpoints/{endpointId}/principals"],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/principals/{principalId}/link-intent",
      ],
      [
        "delete",
        "/api/chat-endpoints/{endpointId}/principals/{principalId}/link",
      ],
      ["get", "/api/chat-identity-links/preview"],
      ["post", "/api/chat-identity-links/confirm"],
      ["get", "/api/chat-endpoints/{endpointId}/conversations"],
      ["get", "/api/chat-endpoints/{endpointId}/activity"],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/deliveries/{deliveryId}/replay",
      ],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/replay",
      ],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve",
      ],
      ["post", "/api/chat-endpoints/{endpointId}/actions/{actionId}/resolve"],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications",
      ],
      ["get", "/api/issues/{issueId}/chat-binding"],
      [
        "get",
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications/{publicationId}/status",
      ],
    ] as const;

    const humanOnly = new Set([
      "/api/chat-endpoints/{endpointId}/deliveries/{deliveryId}/replay",
      "/api/chat-endpoints/{endpointId}/publications/{publicationId}/replay",
      "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications",
      "/api/chat-endpoints/{endpointId}/github/identity", "/api/chat-identity-links/preview", "/api/chat-identity-links/confirm",
      "/api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve", "/api/chat-endpoints/{endpointId}/actions/{actionId}/resolve",
    ]);
    for (const [method, routePath] of operations) {
      const operation = spec.paths[routePath]?.[method];
      expect(
        operation,
        `${method.toUpperCase()} ${routePath} is documented`,
      ).toBeDefined();
      expect(
        operation.security,
        `${method.toUpperCase()} ${routePath} retains its actor boundary`,
      ).toEqual(humanOnly.has(routePath) ? boardSecurity : [...boardSecurity, { AgentBearerAuth: [] }]);
      expect(operation["x-paperclip-authorization"]).toEqual({
        actor: humanOnly.has(routePath) ? "board" : "board_or_agent",
      });
      expect(operation.tags).toContain("chat-channels");
    }

    const create = spec.paths["/api/companies/{companyId}/chat-endpoints"].post;
    expect(create.responses["201"]).toBeDefined();
    expect(create.requestBody.content["application/json"].schema).toMatchObject(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          provider: {
            type: "string",
            enum: ["slack", "github", "discord", "microsoft-teams", "telegram", "speko", "imessage-photon"],
          },
          assignedAgentId: { type: "string", format: "uuid" },
        },
        required: ["provider", "assignedAgentId"],
      },
    );

    const endpointResponse =
      spec.paths["/api/chat-endpoints/{endpointId}"].get.responses["200"]
        .content["application/json"].schema;
    expect(endpointResponse).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        assignedAgentId: { type: "string", format: "uuid" },
        status: {
          type: "string",
          enum: [
            "draft",
            "verifying",
            "active",
            "paused",
            "attention",
            "revoked",
            "archived",
          ],
        },
        capabilities: { type: "object", additionalProperties: false },
        setup: { type: "object", additionalProperties: false },
      },
    });
    expect(JSON.stringify(endpointResponse)).not.toContain('"credentials":');
    expect(JSON.stringify(endpointResponse)).not.toContain("privateKey");
    expect(JSON.stringify(endpointResponse)).not.toContain("signingSecret");
    expect(
      endpointResponse.properties.setup.properties.callbacksNeedUpdate,
    ).toEqual({ type: "boolean" });
    expect(
      endpointResponse.properties.setup.properties.callbackSurfaces.properties
        .events.properties.status.enum,
    ).toEqual(["current", "stale", "unverified"]);

    const setup = spec.paths["/api/chat-endpoints/{endpointId}/setup"].post;
    const setupResponse = setup.responses["200"].content["application/json"].schema;
    expect((setupResponse.oneOf ?? setupResponse.anyOf)[1].properties.requiredUserAction.properties.kind.enum).toEqual(["enter_credentials"]);
    expect(setup.description).toContain("without changing credentials");
    expect(
      setup.requestBody.content["application/json"].schema.properties.action
        .enum,
    ).toEqual([
      "configure",
      "verify",
      "pause",
      "resume",
      "reconnect",
      "remove",
    ]);
    expect(setup.description).toContain(
      "Discord: `applicationId`, `guildId`, `botToken`",
    );
    expect(setup.responses["409"]).toBeDefined();
    expect(setup.responses["422"]).toBeDefined();
    expect(setup.responses["502"]).toBeDefined();
    expect(setup.responses["503"]).toBeDefined();

    const photon = spec.paths["/api/chat-endpoints/{endpointId}/photon/inspect"].post;
    expect(photon.requestBody.content["application/json"].schema.required).toEqual([
      "projectId", "projectSecret",
    ]);
    const photonResponse = photon.responses["200"].content["application/json"].schema;
    expect(photonResponse.properties.allocation.enum).toEqual(["dedicated", "shared"]);
    expect(photonResponse.properties.lines.items.additionalProperties).toBe(false);
    expect(JSON.stringify(photonResponse)).not.toMatch(/projectSecret|token/);
    expect(photon.responses["422"]).toBeDefined();
    expect(photon.responses["429"]).toBeDefined();
    expect(photon.responses["502"]).toBeDefined();
    expect(photon.responses["503"]).toBeDefined();

    const setupSecret =
      spec.paths["/api/chat-endpoints/{endpointId}/setup-secret"].post;
    const secretHandoff = setupSecret.responses["200"].content["application/json"].schema;
    expect(secretHandoff.properties.requiredUserAction.properties.kind.enum).toEqual(["enter_credentials"]);
    expect(secretHandoff.properties).not.toHaveProperty("webhookSecret");
    expect(setupSecret.description).toContain("without rotating or reading");
    expect(
      setupSecret.responses["201"].content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["webhookSecret", "credentialRotationId"],
    });
    expect(setupSecret.responses["409"]).toBeDefined();
    expect(setupSecret.responses["422"]).toBeDefined();

    const resolveAction =
      spec.paths["/api/chat-endpoints/{endpointId}/actions/{actionId}/resolve"]
        .post;
    expect(
      resolveAction.requestBody.content["application/json"].schema.properties
        .action.enum,
    ).toEqual(["mark_delivered", "retry_anyway", "cancel"]);
    expect(resolveAction.responses["409"]).toBeDefined();
    expect(resolveAction.responses["422"]).toBeDefined();

    const activity =
      spec.paths["/api/chat-endpoints/{endpointId}/activity"].get.responses[
        "200"
      ].content["application/json"].schema.oneOf[0].items;
    expect(activity.properties.actionType.enum).toEqual([
      "slash_task_start",
      "provider_effect",
      "github_webhook_ingress",
      "slack_session_sync",
      "slack_session_stop",
    ]);
    const fileTransfer = activity.properties.fileTransfer;
    expect(fileTransfer).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["provider", "phase", "filename", "version"],
      properties: {
        provider: { type: "string", enum: ["microsoft-teams"] },
        version: { type: "integer", minimum: 0, exclusiveMinimum: true },
      },
    });
    expect(Object.keys(fileTransfer.properties).sort()).toEqual([
      "expiresAt",
      "filename",
      "phase",
      "provider",
      "version",
    ]);
    expect(fileTransfer.properties.phase.enum).toHaveLength(15);
    const boardSend =
      spec.paths[
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications"
      ].post;
    expect(boardSend.responses["409"]).toBeDefined();
    expect(boardSend.responses["422"]).toBeDefined();
    expect(boardSend.description).toContain(
      "chat_board_send_attachments_already_bound",
    );
    expect(boardSend.description).toContain(
      "Other errors do not establish non-delivery",
    );
    const batchStatus =
      spec.paths[
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications/{publicationId}/status"
      ].get.responses["200"].content["application/json"].schema;
    expect(batchStatus.required).toEqual(
      expect.arrayContaining([
        "publication",
        "parts",
        "total",
        "published",
        "awaitingConsent",
        "declined",
        "expired",
        "cancelled",
        "settled",
        "canDismiss",
      ]),
    );
    expect(batchStatus.properties.parts.items.properties.fileTransfer).toEqual(
      fileTransfer,
    );
    expect(batchStatus.properties.publication.properties.state.enum).toContain(
      "awaiting_consent",
    );
    const resolvePublication =
      spec.paths[
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve"
      ].post.requestBody.content["application/json"].schema;
    expect(resolvePublication.properties.fileTransfer).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["phase", "version"],
      properties: {
        phase: { enum: fileTransfer.properties.phase.enum },
        version: { type: "integer", minimum: 0, exclusiveMinimum: true },
      },
    });
    expect(JSON.stringify(batchStatus)).not.toMatch(
      /uploadUrl|privateState|tokenSha256|credentialFingerprint/,
    );

    const replaceResources =
      spec.paths["/api/chat-endpoints/{endpointId}/resources"].put;
    expect(
      replaceResources.requestBody.content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["resources"],
    });
    expect(replaceResources.responses["409"]).toBeDefined();
    expect(replaceResources.responses["422"]).toBeDefined();

    expect(
      spec.paths[
        "/api/chat-endpoints/{endpointId}/principals/{principalId}/link"
      ].delete.responses["204"],
    ).toBeDefined();
    expect(
      spec.paths[
        "/api/chat-endpoints/{endpointId}/deliveries/{deliveryId}/replay"
      ].post.responses["204"],
    ).toBeDefined();
    expect(
      spec.paths[
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/replay"
      ].post.responses["204"],
    ).toBeDefined();

    const endpointScopedOperations = operations.filter(
      ([, routePath]) =>
        routePath.includes("{endpointId}") ||
        routePath === "/api/issues/{issueId}/chat-binding",
    );
    for (const [method, routePath] of endpointScopedOperations) {
      expect(
        spec.paths[routePath][method].responses["404"],
        `${method.toUpperCase()} ${routePath} preserves the non-member 404 boundary`,
      ).toBeDefined();
    }

    expect(
      spec.paths["/api/chat-webhooks/{publicId}/{provider}"],
    ).toBeUndefined();
  });

  it("documents session-bound voice authority without durable credentials", () => {
    const {spec} = loadSpecRoutes();
    const start = spec.paths["/api/companies/{companyId}/voice-sessions"].post;
    expect(start.security).toEqual([{BoardSessionAuth: []}]);
    expect(start["x-paperclip-authorization"]).toEqual({actor: "board", sessionBound: true});
    expect(start.requestBody.content["application/json"].schema.required).toEqual(expect.arrayContaining(["endpointId", "idempotencyKey"]));
    expect(start.responses["201"]).toBeDefined();
    expect(JSON.stringify(start.responses)).not.toContain("signingSecret");
    expect(spec.paths["/api/voice-webhooks/{publicId}/tools"]).toBeUndefined();
    expect(spec.paths["/api/voice-webhooks/{publicId}/events"]).toBeUndefined();
    const decision=spec.paths["/api/companies/{companyId}/voice-phone/{endpointId}/incoming/{callId}"].post;
    expect(decision.requestBody.content["application/json"].schema.required).toEqual(expect.arrayContaining(["approve", "approvalCode"]));
  });

  it("documents board-only prompt injection settings and fixed-sample testing", () => {
    const { spec } = loadSpecRoutes();
    const base = "/api/companies/{companyId}/prompt-injection-prevention";
    for (const [method, suffix] of [["get", ""], ["put", ""], ["get", "/models"], ["post", "/test"]]) {
      expect(spec.paths[base + suffix][method]["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(spec.paths[base + suffix][method].security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    }
    expect(spec.paths[base].put.requestBody.content["application/json"].schema).toMatchObject({
      additionalProperties: false, required: ["enabled", "connectionId", "grantId", "model"],
    });
    expect(spec.paths[base + "/test"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object", additionalProperties: false, properties: {},
    });
  });

  it("covers the mounted server routes exactly", () => {
    const {
      routes: actualRoutes,
      excludedRoutes,
      unknownRouteFiles,
    } = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes]
      .filter((route) => !specRoutes.has(route))
      .sort();
    const extraInSpec = [...specRoutes]
      .filter(
        (route) =>
          !actualRoutes.has(route) && !specOnlyContractFirstRoutes.has(route),
      )
      .sort();

    expect({
      unknownRouteFiles,
      missingInSpec,
      extraInSpec,
      excludedRoutes: [...excludedRoutes].sort(),
    }).toEqual({
      unknownRouteFiles: [],
      missingInSpec: [],
      extraInSpec: [],
      excludedRoutes: [...explicitOpenApiOperationCoverageExclusions].sort(),
    });
  });

  it("documents additive project access as board-only with a strict request", () => {
    const { spec } = loadSpecRoutes();
    const path = spec.paths["/api/agents/{id}/project-access"];
    for (const operation of [path.get, path.post]) {
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
      expect(operation.responses["200"].content["application/json"].schema.required).toEqual(["projectIds", "canManage"]);
    }
    expect(path.post.requestBody.content["application/json"].schema).toMatchObject({
      additionalProperties: false, required: ["projectIds"],
      properties: { projectIds: { type: "array", items: { type: "string", format: "uuid" } } },
    });
    expect(path.post.responses["409"]).toBeDefined();
  });

  it("documents the authenticated personal primary-agent contract", () => {
    const { spec } = loadSpecRoutes();
    const path = spec.paths["/api/companies/{companyId}/primary-agent/me"];
    for (const operation of [path.get, path.put]) {
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
      expect(operation.responses["200"].content["application/json"].schema.required).toEqual([
        "companyId", "userId", "primaryAgentId", "initialized",
      ]);
    }
    expect(path.put.requestBody.content["application/json"].schema).toMatchObject({
      additionalProperties: false,
      required: ["primaryAgentId"],
      properties: { primaryAgentId: { type: "string", format: "uuid" } },
    });
    expect(path.put.responses["422"]).toBeDefined();
  });

  it("documents Muse operator management separately from receiver credentials", () => {
    const { spec } = loadSpecRoutes();
    const base = "/api/companies/{companyId}/agents/{agentId}/muse-binding";
    const operations = [
      ["get", "/api/companies/{companyId}/muse-invitations"],
      ["post", "/api/companies/{companyId}/muse-invitations"],
      ["get", base], ["post", base], ["post", `${base}/verify`],
      ["post", `${base}/revoke`], ["post", `${base}/attest-stop`],
      ["post", `${base}/attest-detector-cleanup`],
      ["get", `${base}/qualification`], ["post", `${base}/qualification`], ["delete", `${base}/qualification`],
    ];
    for (const [method, routePath] of operations) {
      const operation = spec.paths[routePath][method];
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
      expect(operation.responses["403"]).toBeDefined();
    }
    expect(spec.paths[base].post.responses["201"]).toBeDefined();
    expect(spec.paths[base].post.responses["201"].content["application/json"].schema.properties.assetVersion.enum).toEqual([MUSE_ASSET_VERSION]);
    expect(spec.paths[`${base}/revoke`].post.responses["204"]).toBeDefined();
    expect(spec.paths[`${base}/qualification`].delete.responses["204"]).toBeDefined();
    expect(spec.paths[`${base}/qualification`].get.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "bindingId", in: "query", required: true }),
      expect.objectContaining({ name: "qualificationId", in: "query", required: true }),
    ]));
    for (const route of MUSE_PUBLIC_ROUTES) expect(spec.paths[route.path]).toBeUndefined();
  });

  it("documents operator Dot invitations and current pairing and event-test fields", () => {
    const { spec } = loadSpecRoutes();
    const invitations = spec.paths["/api/companies/{companyId}/dot-invitations"];
    for (const operation of [invitations.get, invitations.post]) {
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.responses["200"]).toBeDefined();
    }
    expect(invitations.post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
    const base = "/api/companies/{companyId}/agents/{agentId}/dot-binding";
    expect(spec.paths[base].post.requestBody.content["application/json"].schema.properties.replaceBindingId).toMatchObject({ type: "string", format: "uuid" });
    expect(spec.paths[base + "/event-test"].post.requestBody.content["application/json"].schema.properties.bindingId).toMatchObject({ type: "string", format: "uuid" });
  });

  it("documents board-only repository discovery and selection", () => {
    const { spec } = loadSpecRoutes();
    const discovery = spec.paths["/api/companies/{companyId}/project-repositories"].get;
    const replacement = spec.paths["/api/projects/{id}/repositories"].put;
    for (const operation of [discovery, replacement]) {
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    }
    expect(replacement.requestBody.content["application/json"].schema.required).toContain("repositoryIds");
    expect(replacement.responses["422"]).toBeDefined();
  });

  it("documents delegated GitHub setup with human identity confirmation and compatible owner-aware registration", () => {
    const { spec } = loadSpecRoutes();
    for (const [suffix, method] of [["draft", "put"], ["setup", "post"], ["identity/start", "post"], ["identity/confirm", "post"]]) {
      const operation = spec.paths[`/api/chat-endpoints/{endpointId}/github/${suffix}`][method];
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: suffix === "identity/confirm" ? "board" : "board_or_agent" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }, ...(suffix === "identity/confirm" ? [] : [{ AgentBearerAuth: [] }])]);
    }
    const registration = spec.paths["/api/chat-endpoints/{endpointId}/github/registration"].post;
    const input = registration.requestBody.content["application/json"].schema;
    expect(input.properties.ownerType.enum).toEqual(["personal", "organization"]);
    expect(input.required).not.toContain("ownerType");
    const response = registration.responses["200"].content["application/json"].schema;
    expect(response.oneOf ?? response.anyOf).toHaveLength(2);
    const appImport = spec.paths["/api/chat-endpoints/{endpointId}/github/app"].post;
    expect(appImport.description).toContain("Only a human session");
    const appImportResponse = appImport.responses["200"].content["application/json"].schema;
    expect(appImportResponse.oneOf ?? appImportResponse.anyOf).toHaveLength(2);
  });

  it("documents GitHub recovery, draft receipts, paged repositories and old review lookups", () => {
    const { spec } = loadSpecRoutes();
    const root = "/api/chat-endpoints/{endpointId}/github/";
    const setup = spec.paths[root + "setup"].post.responses["200"].content["application/json"].schema;
    expect(setup.properties.restartableRegistrationId.format).toBe("uuid");
    const restart = spec.paths[root + "registration/restart"].post;
    expect(restart["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    const restartInput = restart.requestBody.content["application/json"].schema;
    expect(restartInput.required).toEqual(expect.arrayContaining(["registrationId", "appNotCreated"]));
    expect(restartInput.properties.appNotCreated.enum ?? [restartInput.properties.appNotCreated.const]).toEqual([true]);
    const receipt = spec.paths[root + "draft"].put.responses["200"].content["application/json"].schema;
    expect(receipt.required).toEqual(["saved"]);
    expect(receipt.properties).not.toHaveProperty("state");
    const appInput = spec.paths[root + "app"].post.requestBody.content["application/json"].schema;
    const app = (appInput.oneOf ?? appInput.anyOf).find((variant: { properties?: { appId?: unknown } }) => variant.properties?.appId);
    expect(app.properties.clientId).toBeDefined();
    expect(app.properties.clientSecret).toBeDefined();
    expect(app.required).not.toContain("clientId");
    const page = spec.paths[root + "repositories"].get;
    expect(page.parameters.map((param: { name: string }) => param.name)).toEqual(expect.arrayContaining(["endpointId", "offset", "limit", "search"]));
    expect(page.responses["200"].content["application/json"].schema.properties).toHaveProperty("totalCount");
    expect(spec.paths[root + "repositories/access"].put["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    const review = spec.paths[root + "reviews/{reviewId}"].get;
    expect(review.parameters.map((param: { name: string }) => param.name)).toEqual(["endpointId", "reviewId"]);
    expect(review.responses["404"]).toBeDefined();
  });

  it("documents auth and reviewed response-code invariants", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(
      spec.paths["/runtime-tools/github/credentials"].post.security,
    ).toEqual([{ RuntimeToolsBearerAuth: [] }]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(
      spec.paths["/api/plugins/install"].post["x-paperclip-authorization"],
    ).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(
      spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post
        .security,
    ).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(
      spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post[
        "x-paperclip-authorization"
      ],
    ).toEqual({
      actor: "board",
    });
    expect(
      spec.paths["/api/companies/{companyId}/cost-events"].post.responses[
        "201"
      ],
    ).toBeDefined();
    expect(
      spec.paths["/api/companies/{companyId}/cost-events"].post.responses[
        "403"
      ],
    ).toBeDefined();
    expect(
      spec.paths["/api/companies/{companyId}/managed-agent-profiles"].post
        .security,
    ).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(
      spec.paths["/api/companies/{companyId}/remote-agent-profiles"].get
        .security,
    ).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    const remoteAgentProfileBody =
      spec.paths["/api/companies/{companyId}/remote-agent-profiles"].post
        .requestBody.content["application/json"].schema;
    expect(remoteAgentProfileBody.properties.service).toMatchObject({
      type: "string",
      enum: ["aws_bedrock_agentcore_harness"],
    });
    expect(
      remoteAgentProfileBody.properties.credentialSecretId,
    ).toBeUndefined();
    expect(
      spec.paths["/api/instance/database-backups"].post.responses["201"],
    ).toBeDefined();
    expect(
      spec.paths["/api/invites/{token}/accept"].post.responses["202"],
    ).toBeDefined();
    expect(
      spec.paths["/api/board-api-keys"].post.responses["201"],
    ).toBeDefined();
    expect(
      spec.paths["/api/companies/import"].post.responses["202"],
    ).toBeDefined();
    expect(
      spec.paths["/api/routines/{id}/run"].post.responses["422"],
    ).toBeDefined();
  });

  it("publishes the Claude browser-code grammar and strict setup-token response shapes", () => {
    const { spec } = loadSpecRoutes();
    const base = "/api/companies/{companyId}/setup-token-login-sessions";

    // The submitted browser code carries the bounded printable-ASCII grammar.
    const codeBody =
      spec.paths[`${base}/{sessionId}/code`].post.requestBody.content[
        "application/json"
      ].schema;
    const browserCode = codeBody.properties.browserCode;
    expect(browserCode.minLength).toBe(1);
    expect(browserCode.maxLength).toBe(512);
    expect(typeof browserCode.pattern).toBe("string");
    expect(browserCode.pattern.length).toBeGreaterThan(0);

    // Every Claude request object forbids an unknown property.
    const startBody =
      spec.paths[base].post.requestBody.content["application/json"].schema;
    expect(startBody.additionalProperties).toBe(false);
    expect(codeBody.additionalProperties).toBe(false);

    // The four contract-first routes carry typed strict response schemas.
    const responseSchemas: Record<string, Record<string, unknown>> = {
      start:
        spec.paths[base].post.responses["201"].content["application/json"]
          .schema,
      status:
        spec.paths[`${base}/{sessionId}`].get.responses["200"].content[
          "application/json"
        ].schema,
      prompt:
        spec.paths[`${base}/{sessionId}/prompt`].get.responses["200"].content[
          "application/json"
        ].schema,
      code: spec.paths[`${base}/{sessionId}/code`].post.responses["200"]
        .content["application/json"].schema,
    };
    const forbiddenProperties = ["token", "accountId", "leaseId"];
    for (const [name, schema] of Object.entries(responseSchemas)) {
      expect(schema.type, `${name} response is a typed object`).toBe("object");
      expect(schema.additionalProperties, `${name} response is strict`).toBe(
        false,
      );
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      expect(
        Object.keys(properties).length,
        `${name} response lists properties`,
      ).toBeGreaterThan(0);
      for (const forbidden of forbiddenProperties) {
        expect(
          properties[forbidden],
          `${name} response hides ${forbidden}`,
        ).toBeUndefined();
      }
      // No property name looks like a raw prompt secret or a token.
      for (const property of Object.keys(properties)) {
        expect(
          /token|secret|accountId|leaseId/i.test(property),
          `${name}.${property} is not secret-adjacent`,
        ).toBe(false);
      }
    }

    // The status and code routes share the public response; it hides the prompt.
    expect(responseSchemas.status.properties).toEqual(
      responseSchemas.code.properties,
    );
    expect(
      (responseSchemas.status.properties as Record<string, unknown>).prompt,
    ).toBeUndefined();
    // The owner start response adds the panel mode and the one-time prompt.
    expect(
      (responseSchemas.start.properties as Record<string, unknown>).panelMode,
    ).toBeDefined();
    expect(
      (responseSchemas.start.properties as Record<string, unknown>).prompt,
    ).toBeDefined();
    // The prompt route returns the authorization URL and the optional transport
    // advisory. The advisory is present on a non-confidential transport, so the
    // client can show a non-blocking disclaimer.
    expect(
      Object.keys(responseSchemas.prompt.properties as Record<string, unknown>),
    ).toEqual(["authorizationUrl", "transportAdvisory"]);
  });

  it("documents the 404 non-member gate on the Claude setup-token cancel route", () => {
    const { spec } = loadSpecRoutes();
    const cancel =
      spec.paths[
        "/api/companies/{companyId}/setup-token-login-sessions/{sessionId}/cancel"
      ].post;
    // The 404 is reachable at run time. The company-access gate returns a fixed
    // 404 for a non-member before the cancel logic runs, so the spec declares
    // it. The idempotent cancel still returns 200 for an owner-scoped missing,
    // terminal, or foreign session id.
    const codes = Object.keys(cancel.responses).sort();
    expect(codes).toEqual(["200", "401", "403", "404"]);
  });
});


describe("heartbeat run ID OpenAPI contract", () => {
  it("publishes the runtime UUID constraint and 400 response on all agent-router run endpoints", async () => {
    const response = await request(createApp()).get("/api/openapi.json");
    expect(response.status).toBe(200);
    const paths = response.body.paths;
    let checked = 0;
    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/api/heartbeat-runs/{runId}") || path.endsWith("/issues")) continue;
      for (const operation of Object.values(operations as Record<string, any>)) {
        const parameter = operation.parameters.find((param: { name: string }) => param.name === "runId");
        expect(parameter.schema.pattern).toEqual(expect.any(String));
        const pattern = new RegExp(parameter.schema.pattern);
        for (const id of [
          "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "AAAAAAAA-AAAA-5AAA-BAAA-AAAAAAAAAAAA",
        ]) expect(pattern.test(id), id).toBe(true);
        for (const id of [
          "undefined", "not-a-uuid", " aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa ",
          "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n",
        ]) expect(pattern.test(id), JSON.stringify(id)).toBe(false);
        expect(operation.responses["400"]).toBeDefined();
        checked++;
      }
    }
    expect(checked).toBe(12);
  });
});


it("documents explicit owner removals in the timeline response event enum", () => {
  const spec = buildOpenApiSpec() as any;
  const schema = spec.paths["/api/companies/{companyId}/timeline"].get.responses["200"].content["application/json"].schema;
  expect(schema.properties.events.items.properties.kind.enum).toEqual([
    "created", "commented", "approved", "delegated", "assigned", "unassigned",
  ]);
});

it("documents canonical saved-resource links in catalog team install responses", () => {
  const operation = buildOpenApiSpec().paths["/api/companies/{companyId}/teams/catalog/{catalogId}/install"].post;
  expect(operation.description).toContain("resourceLinks");
  const schema = operation.responses[201].content["application/json"].schema;
  expect(schema.required).toContain("resourceLinks");
  expect(schema.properties.resourceLinks.items.properties.kind.enum).toEqual(["agent", "project", "routine"]);
  expect(schema.properties.resourceLinks.items.required).toEqual(["kind", "id", "name", "href"]);
});

// PAR-12608 4.6 and X3: the build-failing scan of the member-restriction route
// table. A route with no row passes (it is closed at run time); a row must name
// a registered route, alone, with its test, and must not catch another route.
const COMPANY_CHECK_PATTERN = /\b(assertCompanyAccess|hasCompanyAccess|getAccessibleResource)\s*[<(]/;
const REPO_ROOT = path.resolve(__dirname, "../../..");

/** `GET /api/issues/{id}` and `GET /api/Issues/:issueId/` have one shape. */
function routeShape(method: string, routePath: string) {
  const shaped = normalizeExpressPath(routePath).replace(/\{[^}]+\}/g, "{}").replace(/(.)\/$/, "$1").toLowerCase();
  return `${method.toUpperCase()} ${shaped}`;
}

type RouteInventory = {
  operations: Iterable<string>;
  handlerSources: Map<string, string>;
  positions: Map<string, { file: string; index: number }>;
  /** Registrations per operation; `positions` keeps only the first. */
  registrations?: Map<string, number>;
};

async function routeTableScanErrors(
  table: readonly MemberRestrictionRouteEntry[],
  inventory: RouteInventory,
  readTest: (repoPath: string) => string | null,
) {
  const errors: string[] = [];
  const byShape = new Map<string, string>();
  for (const operation of inventory.operations) {
    const [method, routePath] = operation.split(" ");
    byShape.set(routeShape(method!, routePath!), operation);
  }
  const seen = new Map<string, MemberRestrictionRouteEntry>();
  for (const entry of table) {
    const row = `${entry.method} ${entry.path}`;
    const shape = routeShape(entry.method, entry.path);
    const operation = byShape.get(shape);
    if (!operation) errors.push(`${row}: matches no registered route`);
    if (seen.has(shape)) errors.push(`${row}: a second row for the route of ${seen.get(shape)!.method} ${seen.get(shape)!.path}`);
    seen.set(shape, entry);
    if (entry.class === "open" || entry.class === "run" || entry.class === "by-company") {
      const test = entry.test ? readTest(entry.test) : null;
      if (test === null) errors.push(`${row}: ${entry.class} row names no existing object-level test`);
      else if (!test.includes(entry.path)) errors.push(`${row}: test ${entry.test} does not name ${entry.path}`);
    }
    if (entry.class === "by-company" && operation && !COMPANY_CHECK_PATTERN.test(inventory.handlerSources.get(operation) ?? "")) {
      errors.push(`${row}: by-company handler calls no company check of routes/authz.ts`);
    }
  }
  // `shadows`: the router must really answer this row's route before the shadowed row's.
  for (const entry of table) {
    if (entry.shadows === undefined) continue;
    const row = `${entry.method} ${entry.path}`;
    const shadowed = table.find((other) => other.method === entry.method && other.path === entry.shadows);
    if (!shadowed) {
      errors.push(`${row}: shadows ${entry.method} ${entry.shadows}, which is no row`);
      continue;
    }
    const caught = await createRouteClassifier([shadowed])(entry.method, entry.path.replace(/:[^/]+/g, "sample1"));
    if (caught.kind !== "matched") errors.push(`${row}: shadows ${entry.method} ${entry.shadows}, which does not catch it`);
    const ownOperation = byShape.get(routeShape(entry.method, entry.path)) ?? "";
    const otherOperation = byShape.get(routeShape(shadowed.method, shadowed.path)) ?? "";
    if ([ownOperation, otherOperation].some((operation) => (inventory.registrations?.get(operation) ?? 1) > 1)) {
      errors.push(`${row}: shadows ${entry.method} ${entry.shadows}, and one of the two is registered more than once`);
    }
    const own = inventory.positions.get(ownOperation);
    const other = inventory.positions.get(otherOperation);
    if (!own || !other || own.file !== other.file) {
      errors.push(`${row}: shadows ${entry.method} ${entry.shadows}, which is not registered in the same file`);
    } else if (own.index >= other.index) {
      errors.push(`${row}: shadows ${entry.method} ${entry.shadows}, which is registered first`);
    }
  }
  const classify = createRouteClassifier(table);
  for (const operation of byShape.values()) {
    const [method, routePath] = operation.split(" ");
    if (method === "USE") continue;
    const result = await classify(method!, normalizeExpressPath(routePath!).replace(/\{[^}]+\}/g, "sample1"));
    // Rows of two classes on one route are refused at run time; fail the build instead.
    if (result.kind === "refused" && result.reason === "ambiguous") {
      errors.push(`${operation}: matched by rows of different classes; give it one row`);
    }
    if (result.kind !== "matched" || result.entry.class === "closed") continue;
    if (routeShape(result.entry.method, result.entry.path) !== routeShape(method!, routePath!)) {
      errors.push(`${result.entry.method} ${result.entry.path}: also catches ${operation}; give that route its own row`);
    }
  }
  return errors.sort();
}

// PAR-12608 4.8, AC-K7: every route under `/plugins/:pluginId/`, and every
// `plugin` row, calls the core plugin gate unless it is on the not-gated list.
// A list route (`ui-contributions`) calls the gate's filter instead.
const PLUGIN_GATE_CALL_PATTERN = /\b(?:assertPluginOpenForPerson|filterPluginsOpenForPerson)\s*\(/;

function pluginGateScanErrors(
  table: readonly MemberRestrictionRouteEntry[],
  notGated: ReadonlyArray<{ method: string; path: string }>,
  inventory: Pick<RouteInventory, "operations" | "handlerSources">,
) {
  const errors: string[] = [];
  const operations = new Map([...inventory.operations].map((operation) => {
    const [method, routePath] = operation.split(" ");
    return [routeShape(method!, routePath!), operation] as const;
  }));
  const exempt = new Set(notGated.map((entry) => routeShape(entry.method, entry.path)));
  const pluginRows = new Set(table.filter((entry) => entry.class === "plugin").map((entry) => routeShape(entry.method, entry.path)));
  for (const entry of notGated) {
    const shape = routeShape(entry.method, entry.path);
    if (!operations.has(shape)) errors.push(`${entry.method} ${entry.path}: not-gated entry matches no registered route`);
    if (pluginRows.has(shape)) errors.push(`${entry.method} ${entry.path}: on the not-gated list and a plugin row`);
  }
  for (const [shape, operation] of operations) {
    const underPlugin = / \/api\/plugins\/\{\}(\/|$)/.test(shape);
    if ((!underPlugin && !pluginRows.has(shape)) || exempt.has(shape)) continue;
    if (!PLUGIN_GATE_CALL_PATTERN.test(inventory.handlerSources.get(operation) ?? "")) {
      errors.push(`${operation}: calls no assertPluginOpenForPerson and is not on the not-gated list`);
    }
  }
  for (const shape of pluginRows) {
    if (!operations.has(shape)) errors.push(`${shape}: plugin row matches no registered route`);
  }
  return errors.sort();
}

// The inventory only reads `router.<method>(`; a path registered on any other
// receiver would be invisible to the scan above, so it is refused here.
const OTHER_RECEIVER_ROUTE_PATTERN =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|head|post|put|patch|delete|all|options|use|ws)\(\s*\[?\s*["'`]\//g;

function otherReceiverRoutes(file: string, source: string) {
  return [...source.matchAll(OTHER_RECEIVER_ROUTE_PATTERN)]
    .filter((match) => match[1] !== "router")
    .map((match) => `${file}: ${match[0]}`);
}

describe("plugin gate scan (AC-K7)", () => {
  it("no route file registers a path on a receiver other than `router`", () => {
    const found = fs.readdirSync(ROUTES_DIR)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .flatMap((file) => otherReceiverRoutes(file, fs.readFileSync(path.join(ROUTES_DIR, file), "utf8")));
    expect(found).toEqual([]);
    expect(otherReceiverRoutes("plugins.ts", "const r2 = router; r2.get(\"/plugins/:pluginId/x\", h); req.get(\"x-id\");"))
      .toEqual(["plugins.ts: r2.get(\"/"]);
  });

  it("every route under /plugins/:pluginId/ calls the gate or is on the not-gated list", () => {
    const { routes, excludedRoutes, mounts, handlerSources } = loadActualRoutes();
    const operations = [...routes, ...excludedRoutes, ...mounts];
    expect(operations.filter((operation) => operation.includes("/api/plugins/{pluginId}")).length).toBeGreaterThan(20);
    expect(pluginGateScanErrors(MEMBER_RESTRICTION_ROUTE_TABLE, PLUGIN_GATE_NOT_GATED, { operations, handlerSources })).toEqual([]);
  });

  it("fails on a route without the call, a stale not-gated entry and a plugin row without the call", () => {
    const gated = "router.post(\"/plugins/:pluginId/actions/:key\", async (req) => { await assertPluginOpenForPerson(req, c, p, \"a\"); })";
    const inventory = {
      operations: ["POST /api/plugins/{pluginId}/actions/{key}", "GET /api/plugins/{pluginId}/new-data",
        "POST /api/plugins/{pluginId}/webhooks/{endpointKey}", "GET /api/plugins/tools", "GET /api/plugins/ui-contributions"],
      handlerSources: new Map([["POST /api/plugins/{pluginId}/actions/{key}", gated]]),
    };
    const table: MemberRestrictionRouteEntry[] = [
      { method: "POST", path: "/api/plugins/:pluginId/actions/:key", class: "plugin" },
      { method: "GET", path: "/api/plugins/ui-contributions", class: "plugin" },
    ];
    const notGated = [{ method: "POST", path: "/api/plugins/:pluginId/webhooks/:endpointKey" },
      { method: "GET", path: "/api/plugins/:pluginId/gone" }];
    expect(pluginGateScanErrors(table, notGated, inventory)).toEqual([
      "GET /api/plugins/:pluginId/gone: not-gated entry matches no registered route",
      "GET /api/plugins/ui-contributions: calls no assertPluginOpenForPerson and is not on the not-gated list",
      "GET /api/plugins/{pluginId}/new-data: calls no assertPluginOpenForPerson and is not on the not-gated list",
    ]);
  });
});

describe("member restriction route table scan", () => {
  it("every row of the route table is true to the mounted routes", async () => {
    const { routes, excludedRoutes, mounts, handlerSources, positions, registrations } = loadActualRoutes();
    const readTest = (repoPath: string) => {
      const file = path.resolve(REPO_ROOT, repoPath);
      return file.startsWith(REPO_ROOT + path.sep) && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    };
    expect(mounts.has("USE /api/plugins/{pluginId}/api")).toBe(true);
    expect(routes.has("GET /api/companies/{companyId}") || routes.has("GET /api/companies")).toBe(true);
    // Every registration has its own source offset (array literals included), so "registered first" is strict.
    expect(new Set([...positions.values()].map(({ file, index }) => `${file}:${index}`)).size).toBe(positions.size);
    const operations = [...routes, ...excludedRoutes, ...mounts];
    expect(await routeTableScanErrors(MEMBER_RESTRICTION_ROUTE_TABLE, { operations, handlerSources, positions, registrations }, readTest)).toEqual([]);
  });

  it("fails on a row with no route, a doubled row, a missing test, a by-company handler without a check and a caught route", async () => {
    const inventory: RouteInventory = {
      operations: ["GET /api/issues/{id}", "GET /api/agents/me", "GET /api/agents/{id}", "GET /api/approvals/{id}",
        "USE /api/plugins/{pluginId}/api"],
      handlerSources: new Map([
        ["GET /api/approvals/{id}", "router.get(\"/approvals/:id\", async (req, res) => { res.json({}); })"],
        ["GET /api/agents/{id}", "router.get(\"/agents/:id\", async (req, res) => { assertCompanyAccess(req, a.companyId); })"],
      ]),
      positions: new Map(),
    };
    const tests: Record<string, string> = { "t.test.ts": "/api/issues/:id /api/approvals/:id /api/agents/:id" };
    const readTest = (repoPath: string) => tests[repoPath] ?? null;
    const clean: MemberRestrictionRouteEntry[] = [
      { method: "GET", path: "/api/issues/:id", class: "open", test: "t.test.ts" },
      { method: "USE", path: "/api/plugins/:pluginId/api", class: "plugin" },
      { method: "GET", path: "/api/agents/me", class: "closed" },
      { method: "GET", path: "/api/agents/:id", class: "by-company", test: "t.test.ts" },
    ];
    expect(await routeTableScanErrors(clean, inventory, readTest)).toEqual([]);

    expect(await routeTableScanErrors([
      { method: "GET", path: "/api/nowhere/:id", class: "closed" },
      { method: "GET", path: "/api/Issues/:issueId/", class: "open", test: "t.test.ts" },
      { method: "GET", path: "/api/issues/:id", class: "open", test: "t.test.ts" },
      { method: "GET", path: "/api/approvals/:id", class: "by-company", test: "missing.test.ts" },
      { method: "GET", path: "/api/agents/:id", class: "run", test: "t.test.ts" },
    ], inventory, readTest)).toEqual([
      "GET /api/Issues/:issueId/: test t.test.ts does not name /api/Issues/:issueId/",
      "GET /api/agents/:id: also catches GET /api/agents/me; give that route its own row",
      "GET /api/approvals/:id: by-company handler calls no company check of routes/authz.ts",
      "GET /api/approvals/:id: by-company row names no existing object-level test",
      "GET /api/issues/:id: a second row for the route of GET /api/Issues/:issueId/",
      "GET /api/nowhere/:id: matches no registered route",
    ]);

    expect(await routeTableScanErrors([
      { method: "GET", path: "/api/agents/:id", class: "run", test: "t.test.ts" },
      { method: "GET", path: "/api/agents/me", class: "open", test: "t.test.ts" },
    ], inventory, (repoPath) => (repoPath === "t.test.ts" ? "/api/agents/:id /api/agents/me" : null))).toEqual([
      "GET /api/agents/me: matched by rows of different classes; give it one row",
    ]);
  });

  it("checks shadows: a row with that path and method, which catches the shadowing route, registered later in the same file", async () => {
    const at = (file: string, index: number) => ({ file, index });
    const inventory = (me: { file: string; index: number }): RouteInventory => ({
      operations: ["GET /api/agents/me", "GET /api/agents/{id}", "GET /api/agents/{id}/keys"],
      handlerSources: new Map(),
      positions: new Map([["GET /api/agents/me", me], ["GET /api/agents/{id}", at("agents.ts", 200)],
        ["GET /api/agents/{id}/keys", at("agents.ts", 300)]]),
    });
    const readTest = () => "/api/agents/me /api/agents/:id /api/agents/:id/keys";
    const table = (shadows: string): MemberRestrictionRouteEntry[] => [
      { method: "GET", path: "/api/agents/me", class: "run", test: "t.test.ts", shadows },
      { method: "GET", path: "/api/agents/:id", class: "open", test: "t.test.ts" },
      { method: "GET", path: "/api/agents/:id/keys", class: "open", test: "t.test.ts" },
    ];
    expect(await routeTableScanErrors(table("/api/agents/:id"), inventory(at("agents.ts", 100)), readTest)).toEqual([]);
    expect(await routeTableScanErrors(table("/api/agents/:agentId"), inventory(at("agents.ts", 100)), readTest)).toEqual([
      "GET /api/agents/me: matched by rows of different classes; give it one row",
      "GET /api/agents/me: shadows GET /api/agents/:agentId, which is no row",
    ]);
    expect(await routeTableScanErrors(table("/api/agents/:id/keys"), inventory(at("agents.ts", 100)), readTest)).toEqual([
      "GET /api/agents/me: matched by rows of different classes; give it one row",
      "GET /api/agents/me: shadows GET /api/agents/:id/keys, which does not catch it",
    ]);
    expect(await routeTableScanErrors(table("/api/agents/:id"), inventory(at("agents-me.ts", 100)), readTest)).toEqual([
      "GET /api/agents/me: shadows GET /api/agents/:id, which is not registered in the same file",
    ]);
    expect(await routeTableScanErrors(table("/api/agents/:id"), inventory(at("agents.ts", 250)), readTest)).toEqual([
      "GET /api/agents/me: shadows GET /api/agents/:id, which is registered first",
    ]);
    // A second registration of either route (another file) is not seen by the order check: fail.
    expect(await routeTableScanErrors(table("/api/agents/:id"), { ...inventory(at("agents.ts", 100)),
      registrations: new Map([["GET /api/agents/{id}", 2]]) }, readTest)).toEqual([
      "GET /api/agents/me: shadows GET /api/agents/:id, and one of the two is registered more than once",
    ]);
    // Same offset (one registration for both, or a row shadowing its own path): not proved first.
    expect(await routeTableScanErrors(table("/api/agents/:id"), inventory(at("agents.ts", 200)), readTest)).toEqual([
      "GET /api/agents/me: shadows GET /api/agents/:id, which is registered first",
    ]);
  });
});
