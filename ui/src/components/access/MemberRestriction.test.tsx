// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyMember } from "@/api/access";
import {
  KillSwitchBanner,
  MemberRestrictionDialog,
  MemberRestrictionSummary,
  MemberRestrictionSwitch,
  agentRestrictionMarks,
} from "./MemberRestriction";

const getModeMock = vi.hoisted(() => vi.fn());
const setModeMock = vi.hoisted(() => vi.fn());
const setRestrictionMock = vi.hoisted(() => vi.fn());
const listPluginsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    getMemberRestrictionMode: (companyId: string) => getModeMock(companyId),
    setMemberRestrictionMode: (companyId: string, mode: string) => setModeMock(companyId, mode),
    setMemberRestriction: (companyId: string, memberId: string, input: unknown) =>
      setRestrictionMock(companyId, memberId, input),
  },
}));
vi.mock("@/api/plugins", () => ({ pluginsApi: { list: () => listPluginsMock() } }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const member = {
  id: "member-2",
  companyId: "company-1",
  principalType: "user",
  principalId: "user-2",
  status: "active",
  membershipRole: "operator",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  user: { id: "user-2", email: "r@example.com", name: "Restricted Person", image: null },
  grants: [],
  restricted: true,
  restrictedPluginKeys: ["pib.crm"],
  restrictedAgentIds: ["agent-ok", "agent-gone"],
} satisfies CompanyMember;

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-ok",
    companyId: "company-1",
    name: "Helper",
    status: "active",
    reportsTo: null,
    adapterType: "http",
    permissions: { canCreateAgents: false },
    ...overrides,
  } as Agent;
}

const byText = (text: string) =>
  [...document.body.querySelectorAll("button")].find((button) => button.textContent === text)!;
const choice = (id: string) => document.body.querySelector<HTMLButtonElement>(`[data-choice='${id}'] [role='checkbox']`);

describe("MemberRestriction", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(node: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  it.each([
    ["off", false, "flag set, not enforced"],
    ["report", false, "flag set, not enforced"],
    ["enforce", false, "restricted"],
    ["enforce", true, "flag set, not enforced"],
    [undefined, false, "flag set"],
  ] as const)("labels a flagged member under mode %s (kill switch %s) as %s", async (mode, forcedOff, label) => {
    await render(<MemberRestrictionSummary member={member} mode={mode} forcedOff={forcedOff} />);
    expect(container.querySelector("[data-slot='badge']")?.textContent).toBe(label);
    expect(container.textContent).toContain("1 plugin, 2 agents");
  });

  it("shows full access for an unflagged member", async () => {
    await render(
      <MemberRestrictionSummary member={{ ...member, restricted: false }} mode="enforce" forcedOff={false} />,
    );
    expect(container.textContent).toBe("Full access");
  });

  it("renders the kill-switch banner as an alert", async () => {
    await render(<KillSwitchBanner />);
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Restriction is switched off for the whole server",
    );
  });

  it("shows the switch with its 7-day count and applies a new mode", async () => {
    getModeMock.mockResolvedValue({ mode: "off", deniedLast7Days: 3 });
    setModeMock.mockResolvedValue({ mode: "report", deniedLast7Days: 3 });
    await render(<MemberRestrictionSwitch companyId="company-1" />);
    expect(container.querySelector("[data-testid='restriction-denied-count']")?.textContent).toBe(
      "3 would-refuse entries in the last 7 days",
    );
    const radios = [...container.querySelectorAll<HTMLButtonElement>("[role='radio']")];
    expect(radios.find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent).toBe("Off");
    await act(async () => radios.find((radio) => radio.textContent === "Report only")!.click());
    const apply = [...container.querySelectorAll("button")].find((button) => button.textContent === "Apply")!;
    await act(async () => apply.click());
    expect(setModeMock).toHaveBeenCalledWith("company-1", "report");
  });

  it("asks once more before Enforce", async () => {
    getModeMock.mockResolvedValue({ mode: "report", deniedLast7Days: 0 });
    setModeMock.mockResolvedValue({ mode: "enforce", deniedLast7Days: 0 });
    await render(<MemberRestrictionSwitch companyId="company-1" />);
    const enforce = [...container.querySelectorAll<HTMLButtonElement>("[role='radio']")].find((r) => r.textContent === "Enforce")!;
    await act(async () => enforce.click());
    await act(async () => byText("Apply").click());
    expect(setModeMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enforce restricts every flagged member now");
    await act(async () => byText("Yes, enforce").click());
    expect(setModeMock).toHaveBeenCalledWith("company-1", "enforce");
  });

  it("marks risky, unusable and unknown agents", () => {
    const boss = agent({ id: "boss", adapterType: "claude_local", permissions: { canCreateAgents: true } });
    const all = [boss, agent({ id: "a", reportsTo: "boss" }), agent({ id: "b", reportsTo: "boss" })];
    expect(agentRestrictionMarks(boss, all)).toEqual({
      usable: true,
      risky: true,
      marks: ["may configure other agents", "2 agents report to it", "claude_local", "shell on the server"],
    });
    expect(agentRestrictionMarks(agent({ adapterType: "process" }), all).marks).toContain("shell on the server");
    expect(agentRestrictionMarks(agent({}), all)).toEqual({ usable: true, risky: false, marks: ["http"] });
    expect(agentRestrictionMarks(agent({ status: "terminated" }), all)).toMatchObject({
      usable: false,
      marks: ["not usable: terminated", "http"],
    });
    expect(agentRestrictionMarks(undefined, all)).toEqual({
      usable: false,
      risky: false,
      marks: ["no longer an agent of this company"],
    });
  });

  it("counts listed agents that cannot run in the row summary", async () => {
    await render(<MemberRestrictionSummary member={member} mode="enforce" forcedOff={false} agents={[agent({})]} />);
    expect(container.textContent).toContain("1 listed agent not usable");
  });

  it("saves the flag and both lists, only with agents of this company and no stale entries", async () => {
    setRestrictionMock.mockResolvedValue(member);
    listPluginsMock.mockResolvedValue([
      { pluginKey: "pib.crm", status: "ready", manifestJson: { displayName: "CRM" } },
      { pluginKey: "pib.seo", status: "ready", manifestJson: { displayName: "SEO" } },
      { pluginKey: "pib.old", status: "uninstalled", manifestJson: { displayName: "Old" } },
    ]);
    const onClose = vi.fn();
    const agents = [
      agent({}),
      agent({ id: "agent-shell", name: "Shell agent", adapterType: "codex_local" }),
      agent({ id: "agent-dead", name: "Dead agent", status: "terminated" }),
      agent({ id: "agent-foreign", name: "Foreign agent", companyId: "company-2" }),
    ];
    await render(<MemberRestrictionDialog companyId="company-1" member={member} agents={agents} onClose={onClose} />);
    const body = () => document.body.textContent ?? "";
    expect(body()).toContain("SEO");
    expect(body()).not.toContain("Old");
    // An agent of another company is never offered.
    expect(body()).not.toContain("Foreign agent");
    expect(choice("agent-foreign")).toBeNull();
    expect(body()).toContain("codex_local · shell on the server");
    expect(body()).toContain("not usable: terminated");
    // The stored id that is no longer an agent here shows as such and blocks the save until unticked.
    expect(document.body.querySelector("[data-choice='agent-gone']")?.textContent).toContain(
      "no longer an agent of this company",
    );
    expect(byText("Save access").disabled).toBe(true);
    await act(async () => choice("agent-gone")!.click());
    expect(choice("agent-gone")).toBeNull();
    await act(async () => choice("pib.seo")!.click());
    await act(async () => choice("agent-shell")!.click());
    await act(async () => byText("Save access").click());
    expect(setRestrictionMock).toHaveBeenCalledWith("company-1", "member-2", {
      restricted: true,
      pluginKeys: ["pib.crm", "pib.seo"],
      agentIds: ["agent-ok", "agent-shell"],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("saves the flag turned off with the lists kept", async () => {
    setRestrictionMock.mockResolvedValue(member);
    listPluginsMock.mockResolvedValue([{ pluginKey: "pib.crm", status: "ready", manifestJson: { displayName: "CRM" } }]);
    const listed = { ...member, restrictedAgentIds: ["agent-ok"] };
    await render(<MemberRestrictionDialog companyId="company-1" member={listed} agents={[agent({})]} onClose={vi.fn()} />);
    await act(async () => document.body.querySelector<HTMLButtonElement>("[aria-label='Restricted member']")!.click());
    await act(async () => byText("Save access").click());
    expect(setRestrictionMock).toHaveBeenCalledWith("company-1", "member-2", {
      restricted: false,
      pluginKeys: ["pib.crm"],
      agentIds: ["agent-ok"],
    });
  });
});
