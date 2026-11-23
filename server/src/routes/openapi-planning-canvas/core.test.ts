import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../openapi.js";
import { buildRunnerApiCatalog } from "../../services/native-runtime/runner-api-catalog.js";
import { PLANNING_CANVAS_OPENAPI_ROUTES } from "./core.js";

const C3_ROUTES = [
  "get /api/companies/{companyId}/planning-canvases",
  "get /api/companies/{companyId}/planning-canvases/{boardId}",
  "post /api/companies/{companyId}/planning-canvases/{boardId}/ops",
  "patch /api/companies/{companyId}/planning-canvases/{boardId}/sharing",
  "get /api/companies/{companyId}/planning-canvases/{boardId}/agent-grants",
  "delete /api/companies/{companyId}/planning-canvases/{boardId}/agent-grants/{grantId}",
];

describe("planning canvas OpenAPI registration", () => {
  const document = buildOpenApiDocument() as { paths: Record<string, Record<string, any>> };

  it("registers the C3 routes in the OpenAPI document with descriptions", () => {
    for (const route of C3_ROUTES) {
      const [method, path] = route.split(" ") as [string, string];
      const operation = document.paths[path]?.[method];
      expect(operation, route).toBeDefined();
      expect(operation.description, route).toBeTruthy();
    }
    for (const route of PLANNING_CANVAS_OPENAPI_ROUTES) {
      expect(document.paths[route.path]?.[route.method], `${route.method} ${route.path}`).toBeDefined();
    }
  });

  it("documents the board read formats and filters", () => {
    const parameters = document.paths["/api/companies/{companyId}/planning-canvases/{boardId}"]!.get.parameters as Array<{ name: string }>;
    for (const name of ["format", "since", "keys", "area", "q"]) expect(parameters.map((p) => p.name)).toContain(name);
  });

  it("puts the C3 routes in the runner catalog", () => {
    const catalog = buildRunnerApiCatalog(document);
    for (const route of C3_ROUTES) {
      const [method, path] = route.split(" ") as [string, string];
      expect(catalog.some((op) => op.method.toLowerCase() === method && op.path === path), route).toBe(true);
    }
  });
});
