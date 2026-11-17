// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyMember } from "@/api/access";
import { KillSwitchBanner, MemberRestrictionSummary, MemberRestrictionSwitch } from "./MemberRestriction";

const getModeMock = vi.hoisted(() => vi.fn());
const setModeMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    getMemberRestrictionMode: (companyId: string) => getModeMock(companyId),
    setMemberRestrictionMode: (companyId: string, mode: string) => setModeMock(companyId, mode),
  },
}));
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
});
