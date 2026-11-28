// @vitest-environment jsdom
/**
 * The client picker of Paid ads (access stage B2, PAR-15212): the real `AdsPage` with `ads.load` answering as the
 * worker does for a limited person (`limitedTo` in the Ads shape, `tests/own-scope.pg.spec.ts`). The picker names his
 * companies, a pick reloads that company, and Performance shows his company's numbers without the "Whose ads" choice.
 * Without `limitedTo` (switch off, or a person who is not limited) the page is as before.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const host = vi.hoisted(() => ({
  search: "",
  load: null as Record<string, unknown> | null,
  calls: [] as Array<[string, Record<string, unknown>]>,
}));

vi.mock("../src/ui/actions.js", () => {
  const loadAccess = async () => ({ mode: "enforce", open: true, permissions: ["ads.work:view"] });
  const fns = new Map<string, (params?: Record<string, unknown>) => Promise<unknown>>();
  const actionFor = (key: string) => async (params: Record<string, unknown> = {}) => {
    host.calls.push([key, params]);
    if (key !== "ads.load") return new Promise(() => {});
    const client = typeof params.client === "string" ? params.client : null;
    const limitedTo = host.load?.limitedTo as { scopeKey: string; scopeKeys: string[] } | undefined;
    return limitedTo && client ? { ...host.load, limitedTo: { ...limitedTo, scopeKey: client } } : host.load;
  };
  return {
    useAccessMe: () => loadAccess,
    useAdsAction: (key: string) => fns.get(key) ?? fns.set(key, actionFor(key)).get(key)!,
  };
});
vi.mock("../src/ui/module-switch.js", () => ({ useModuleEnabled: () => true, ModuleOffBanner: () => null }));
vi.mock("@partnersinbiz/pib-plugin-kit/oauth-client", () => ({ resolvePluginUiBase: async () => "/", rememberOAuthStart: () => {} }));
vi.mock("@partnersinbiz/pib-plugin-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@partnersinbiz/pib-plugin-ui")>()),
  usePluginSetupStatus: () => null,
  useGroupedNav: () => false,
}));
vi.mock("@paperclipai/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/plugin-sdk/ui")>()),
  useHostLocation: () => ({ pathname: "/ads", search: host.search, hash: "" }),
  useHostNavigation: () => ({ navigate: () => {}, resolveHref: (to: string) => to, linkProps: (to: string) => ({ href: to }) }),
  usePluginToast: () => () => {},
}));

const { AdsPage } = await import("../src/ui/index.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = { period: { since: "2026-10-01", until: "2026-10-15", label: "this month" }, groupBy: "platform", scope: "company:acme", groups: [], totals: [], hasData: false };
const OVERVIEW = {
  today: "2026-10-15",
  platforms: [],
  writesEnabled: true,
  settingsSaved: true,
  connections: [],
  accounts: [],
  budgets: [],
  alerts: [],
  proposals: [],
  month: summary,
  daily: { ...summary, groupBy: "day" },
  audit: [],
  agent: { agentId: null, name: null, status: null, active: false },
  clients: { "company:acme": "Acme Ltd", "company:beta": "Beta Bakery", "contact:jo": "Jo Acme" },
  redirectUri: null,
  publicBaseUrlError: null,
  encryptionKey: true,
};
const LIMITED = { ...OVERVIEW, limitedTo: { scopeKey: "company:acme", scopeKeys: ["company:acme", "company:beta", "contact:jo"] } };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host.calls.length = 0;
  host.search = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const context = { companyId: COMPANY } as PluginPageProps["context"];
const picker = () => container.querySelector<HTMLElement>("section[aria-label='Your companies']");
const loads = () => host.calls.filter(([key]) => key === "ads.load").map(([, params]) => params.client ?? null);

describe("Paid ads: the client picker for a limited person", () => {
  it("names his companies, shows the one the worker opened, and a pick reloads that company", async () => {
    host.load = LIMITED;
    act(() => root.render(<AdsPage context={context} />));
    await settle();
    const select = picker()?.querySelector("select");
    expect([...(select?.options ?? [])].map((o) => o.textContent)).toEqual(["Acme Ltd", "Beta Bakery", "Jo Acme"]);
    expect(select?.value).toBe("company:acme");
    expect(loads()).toEqual([null]);

    act(() => {
      select!.value = "company:beta";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(loads()).toEqual([null, "company:beta"]);
    expect(picker()?.querySelector("select")?.value).toBe("company:beta");
  });

  it("Performance reads his company and offers no choice of whose ads", async () => {
    host.load = LIMITED;
    host.search = "?tab=performance";
    act(() => root.render(<AdsPage context={context} />));
    await settle();
    expect(host.calls.find(([key]) => key === "ads.performance")?.[1]).toMatchObject({ client: "company:acme" });
    expect(container.querySelector("select[aria-label='Whose ads']")).toBeNull();
  });

  it("without limitedTo (switch off, or not limited) there is no picker and Performance keeps its choice", async () => {
    host.load = OVERVIEW;
    host.search = "?tab=performance";
    act(() => root.render(<AdsPage context={context} />));
    await settle();
    expect(picker()).toBeNull();
    expect(loads()).toEqual([null]);
    expect(host.calls.find(([key]) => key === "ads.performance")?.[1]).not.toHaveProperty("client");
    expect(container.querySelector("select[aria-label='Whose ads']")).not.toBeNull();
  });
});
