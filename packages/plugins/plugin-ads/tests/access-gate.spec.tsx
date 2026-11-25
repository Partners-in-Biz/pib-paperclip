// @vitest-environment jsdom
/**
 * The page gate of Paid ads (access stage A, spec PAR-12578 section 4.6; PAR-12645): `AdsPage` and `AdsSidebar` render
 * the real components with `access.me` answering closed or open. Closed: the "no access" page, no sidebar entry, and no
 * `ads.load` call. Taking `AccessGate` off either component fails this spec.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPageProps, PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const access = vi.hoisted(() => ({ answer: { mode: "enforce", open: false, permissions: [] as string[] } }));
const calls = vi.hoisted(() => ({ actions: [] as string[] }));

// Stable functions, as the host's `usePluginAction` returns: a new loader each render would re-run the access check.
vi.mock("../src/ui/actions.js", () => {
  const loadAccess = async () => access.answer;
  const fns = new Map<string, () => Promise<unknown>>();
  // Records each call; never settles, so an open page stays on its loading state without host data.
  const actionFor = (key: string) => () => {
    calls.actions.push(key);
    return new Promise(() => {});
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
  useHostLocation: () => ({ pathname: "/ads", search: "", hash: "" }),
  useHostNavigation: () => ({ navigate: () => {}, resolveHref: (to: string) => to, linkProps: (to: string) => ({ href: to }) }),
  usePluginToast: () => () => {},
}));

const { AdsPage, AdsSidebar } = await import("../src/ui/index.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.actions.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode) {
  act(() => root.render(node));
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const context = { companyId: COMPANY } as PluginPageProps["context"];
const closed = () => container.querySelector('[data-access-state="closed"]');

describe("Paid ads page gate", () => {
  it("closed: the page shows the no-access page, makes no ads.load call, and shows no page body", async () => {
    access.answer = { mode: "enforce", open: false, permissions: [] };
    await render(<AdsPage context={context} />);
    expect(closed()?.textContent).toContain("You do not have access to Paid ads");
    expect(calls.actions).toEqual([]);
    expect(container.textContent).not.toMatch(/Overview|Loading/);
  });

  it("closed: the sidebar renders nothing", async () => {
    access.answer = { mode: "enforce", open: false, permissions: [] };
    await render(<AdsSidebar context={context as PluginSidebarProps["context"]} />);
    expect(container.innerHTML).toBe("");
  });

  it("open: the page body loads (ads.load is called) and the sidebar shows its entry", async () => {
    access.answer = { mode: "enforce", open: true, permissions: ["ads.work:view"] };
    await render(<AdsPage context={context} />);
    expect(closed()).toBeNull();
    expect(calls.actions).toContain("ads.load");

    act(() => root.unmount());
    root = createRoot(container);
    await render(<AdsSidebar context={context as PluginSidebarProps["context"]} />);
    expect(container.querySelector('a[href="/ads"]')).not.toBeNull();
  });
});
