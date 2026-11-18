import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { Outlet, Route, Routes } from "@/lib/router";
import { MemberRestrictionGate } from "@/components/MemberRestrictionGate";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { Sidebar } from "@/components/Sidebar.production";
import { MemberRestrictionProvider } from "@/context/MemberRestrictionContext";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { storybookAuthSession } from "../../fixtures/paperclipData";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

type RestrictionEntry = { restricted: boolean; mode: "off" | "report" | "enforce" };

// Stress data: a long display name and e-mail on the signed-in person.
const restrictedSession = (entry: RestrictionEntry) => ({
  ...storybookAuthSession,
  user: {
    ...storybookAuthSession.user,
    name: "Bartholomew Montgomery-Wolstenholme the Third of Client Services",
    email: "a.very.long.client.address.for.restriction.checks@subsidiary-of-a-long-company-name.example.test",
  },
  memberRestrictions: [{ companyId: "company-storybook", ...entry }],
});

function FixturePage({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-2xl py-10">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">Fixture page body.</p>
    </div>
  );
}

function Shell() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      <main className="min-w-0 flex-1 px-4">
        <Outlet />
      </main>
      <MobileBottomNav visible />
    </div>
  );
}

/** The real sidebar, mobile bar and route gate under one company route, as `App.tsx` mounts the gate. */
function MemberRestrictionScreen() {
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path=":companyPrefix" element={<MemberRestrictionProvider><Shell /></MemberRestrictionProvider>}>
          <Route element={<MemberRestrictionGate />}>
            <Route path="inbox" element={<FixturePage title="Inbox" />} />
            <Route path="issues" element={<FixturePage title="Tasks" />} />
            <Route path="dashboard" element={<FixturePage title="Dashboard" />} />
            <Route path="costs" element={<FixturePage title="Costs" />} />
            <Route path="company/settings/*" element={<FixturePage title="Company settings" />} />
          </Route>
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}

const meta = {
  id: "feature-member-restriction-screen",
  title: "Getting started and access/Login, invitations, and access/Restricted member screen",
  component: MemberRestrictionScreen,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "PAR-12608 4.6, AC-G10: a member restricted under enforce sees no menu entry for a closed page and, on typing its address, a plain \"not available for your access level\" page.",
      },
    },
    paperclip: {
      "capabilities": [
        "access/membership"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production Sidebar, MobileBottomNav and MemberRestrictionGate with fixture session data. The server's route table (403 MEMBER_RESTRICTED) is not exercised here."
    },
  },
  beforeEach: ({ parameters }) =>
    prepareFixtureApi([
      {
        path: "/api/auth/get-session",
        read: () => restrictedSession(parameters.restriction as RestrictionEntry),
      },
      { path: "/api/plugins/ui-contributions", read: () => [] },
    ]).cleanup,
} satisfies Meta<typeof MemberRestrictionScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RestrictedMemberMenu: Story = {
  parameters: { initialEntries: ["/PAP/inbox"], restriction: { restricted: true, mode: "enforce" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Inbox" });
    await expect(canvas.queryByRole("link", { name: "Dashboard" })).toBeNull();
    await expect(canvas.queryByRole("link", { name: "Costs" })).toBeNull();
  },
};

export const RestrictedMemberTypesClosedAddress: Story = {
  parameters: { initialEntries: ["/PAP/costs"], restriction: { restricted: true, mode: "enforce" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Not available for your access level" });
  },
};

export const ReportModeUnchanged: Story = {
  parameters: { initialEntries: ["/PAP/costs"], restriction: { restricted: true, mode: "report" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Costs" });
  },
};
