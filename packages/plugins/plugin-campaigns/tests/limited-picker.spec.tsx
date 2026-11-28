// @vitest-environment jsdom
/**
 * The client picker of the Campaigns page (access stage B2, PAR-15212): the real `CampaignsPage` behind a stubbed host bridge.
 * `campaigns.load` answers with `tests/fixtures/limited-load.json` (the worker's load for a limited person, from
 * `own-scope.pg.spec.ts`, without `limitedTo`) and, for a limited person, the `limitedTo` the worker adds.
 * A limited person's page moves once to his first company, a pick opens the chosen one, and the "Our own Campaigns" back
 * link and the own-brand button are left out. Without `limitedTo` (switch off, or not limited) there is no picker and no move.
 */
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/limited-load.json" with { type: "json" };

const COMPANY = "11111111-1111-4111-8111-111111111111";
const CLIENTS = [
  { client: "company:acme", name: "Acme Ltd" },
  { client: "company:beta", name: "Beta Bakery" },
  { client: "contact:jo", name: "Jo Acme" },
];

/** The host: location (a store, so a navigate re-renders), navigations, action calls, and the load answer. */
const host = {
  location: { pathname: "/campaigns", search: "", hash: "" },
  listeners: new Set<() => void>(),
  navigations: [] as Array<{ to: string; replace: boolean }>,
  loads: [] as Array<string | null>,
  limited: true,
};
function navigate(to: string, options?: { replace?: boolean }) {
  host.navigations.push({ to, replace: options?.replace === true });
  const url = new URL(to, "http://host");
  host.location = { pathname: url.pathname, search: url.search, hash: "" };
  host.listeners.forEach((listener) => listener());
}
function load(params: Record<string, unknown> = {}) {
  // The Campaigns page sends its scope as `{ kind, id }`.
  const scope = params.client as { kind?: string; id?: string } | null | undefined;
  const asked = scope && scope.kind && scope.id ? `${scope.kind}:${scope.id}` : null;
  host.loads.push(asked);
  if (!host.limited) return structuredClone(fixture);
  const client = asked ?? CLIENTS[0]!.client;
  const [kind, id] = client.split(":");
  const name = CLIENTS.find((c) => c.client === client)!.name;
  return { ...structuredClone(fixture), client: { ...fixture.client, kind, id, name }, limitedTo: { client, clients: CLIENTS } };
}
const actions = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>();
const usePluginAction = (key: string) => {
  if (!actions.has(key)) {
    actions.set(key, async (params) => {
      if (key === "access.me") return { mode: "enforce", open: true, permissions: ["campaigns.campaigns:view"] };
      if (key === "campaigns.load") return load(params);
      return new Promise(() => {});
    });
  }
  return actions.get(key)!;
};
const hooks: Record<string, unknown> = {
  usePluginAction,
  useHostLocation: () => useSyncExternalStore((listener) => (host.listeners.add(listener), () => host.listeners.delete(listener)), () => host.location),
  useHostNavigation: () => ({ navigate, resolveHref: (to: string) => to, linkProps: (to: string) => ({ href: to }) }),
  useHostContext: () => ({ companyId: COMPANY, companyPrefix: "PAR", userId: "user-member", entityId: null, entityType: null, projectId: null }),
  usePluginToast: () => () => null,
  useHostNewIssue: () => () => {},
};
(globalThis as { __paperclipPluginBridge__?: unknown }).__paperclipPluginBridge__ = {
  react: { createElement },
  sdkUi: new Proxy(hooks, { get: (target, key: string) => (key in target ? target[key] : () => null) }),
};
globalThis.fetch = (async () => new Response("[]", { status: 404 })) as typeof fetch;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CampaignsPage } = await import("../src/ui/index.js");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host.location = { pathname: "/campaigns", search: "", hash: "" };
  host.navigations.length = 0;
  host.loads.length = 0;
  host.limited = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle() {
  for (let round = 0; round < 4; round++) {
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
  }
}
const context = { companyId: COMPANY, companyPrefix: "PAR", userId: "user-member", entityId: null, entityType: null, projectId: null };
const picker = () => container.querySelector<HTMLElement>("section[aria-label='Your companies']");
const select = () => picker()?.querySelector("select") ?? null;
const ownBrandButton = () => [...container.querySelectorAll("button")].find((b) => /one of our own brands|Not one of ours/.test(b.textContent ?? ""));
const backLink = () => [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("Our own"));

describe("Campaigns: the client picker for a limited person", () => {
  it("moves once to his first company (replace), then stays: the address names it", async () => {
    act(() => root.render(createElement(CampaignsPage, { context })));
    await settle();
    expect(host.navigations).toEqual([{ to: "/campaigns?client=company%3Aacme", replace: true }]);
    expect(host.loads).toEqual([null, "company:acme"]);
    expect([...select()!.options].map((o) => o.textContent)).toEqual(["Acme Ltd", "Beta Bakery", "Jo Acme"]);
    expect(select()!.value).toBe("company:acme");
    expect(backLink()).toBeUndefined();
    expect(ownBrandButton()).toBeUndefined();
  });

  it("a pick opens the chosen company", async () => {
    host.location = { pathname: "/campaigns", search: "?client=company%3Aacme", hash: "" };
    act(() => root.render(createElement(CampaignsPage, { context })));
    await settle();
    expect(host.navigations).toEqual([]);
    act(() => {
      select()!.value = "company:beta";
      select()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(host.navigations).toEqual([{ to: "/campaigns?client=company%3Abeta", replace: false }]);
    expect(host.loads.at(-1)).toBe("company:beta");
    expect(select()!.value).toBe("company:beta");
  });

  it("without limitedTo (switch off, or not limited): no picker, no move, the back link stays", async () => {
    host.limited = false;
    host.location = { pathname: "/campaigns", search: "?client=company%3Aacme", hash: "" };
    act(() => root.render(createElement(CampaignsPage, { context })));
    await settle();
    expect(host.loads).toEqual(["company:acme"]);
    expect(picker()).toBeNull();
    expect(host.navigations).toEqual([]);
    expect(backLink()?.getAttribute("href")).toBe("/campaigns");
    expect(ownBrandButton()?.textContent).toBe("Mark as one of our own brands");
  });

  it("without limitedTo on the own Campaigns page: no picker and no move to a client", async () => {
    host.limited = false;
    act(() => root.render(createElement(CampaignsPage, { context })));
    await settle();
    expect(host.loads).toEqual([null]);
    expect(picker()).toBeNull();
    expect(host.navigations).toEqual([]);
  });
});
