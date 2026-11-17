import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToastViewport } from "@/components/ToastViewport";
import { CompanyAccess } from "@/pages/CompanyAccess";
import { expect, userEvent, within, waitFor } from "storybook/test";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
let member = {
  id: "member-gap",
  companyId: "company-storybook",
  principalType: "user",
  principalId: "user-review",
  status: "active",
  membershipRole: "operator",
  user: {
    id: "user-review",
    email: "reviewer@example.test",
    name: "Release reviewer",
    image: null,
  },
  grants: [],
  createdAt: "2026-10-12T12:00:00Z",
  updatedAt: "2026-10-12T12:00:00Z",
};
// Stress data for the restriction column: long names, both flag states, a large 7-day count.
const restrictedMembers = [
  {
    ...member,
    id: "member-restricted",
    principalId: "user-restricted",
    user: {
      id: "user-restricted",
      email: "a.very.long.client.address.for.restriction.checks@subsidiary-of-a-long-company-name.example.test",
      name: "Bartholomew Montgomery-Wolstenholme the Third of Client Services",
      image: null,
    },
    restricted: true,
    restrictedPluginKeys: ["pib.plugin-with-a-rather-long-key-0", "pib.removed-plugin"],
    restrictedAgentIds: ["agent-0", "agent-3", "00000000-0000-4000-8000-000000000000"],
  },
  {
    ...member,
    id: "member-open",
    principalId: "user-open",
    user: { id: "user-open", email: "open@example.test", name: "Open member", image: null },
    restricted: false,
  },
];
// Stress data for the Access dialog: many plugins and agents with long names, every 4.7 mark.
const longName = "Client Services Operations Coordinator for the Southern Region Subsidiary";
const stressPlugins = Array.from({ length: 24 }, (_, i) => ({
  id: `plugin-${i}`,
  pluginKey: `pib.plugin-with-a-rather-long-key-${i}`,
  status: "ready",
  manifestJson: { displayName: i % 3 === 0 ? `${longName} plugin ${i}` : `Plugin ${i}` },
}));
const stressAgents = Array.from({ length: 30 }, (_, i) => ({
  id: `agent-${i}`,
  companyId: "company-storybook",
  name: i % 4 === 0 ? `${longName} agent ${i}` : `Agent ${i}`,
  role: "general",
  status: i % 7 === 3 ? "terminated" : i % 9 === 5 ? "paused" : "active",
  reportsTo: i > 0 && i < 6 ? "agent-0" : null,
  adapterType: i % 3 === 0 ? "claude_local" : i % 3 === 1 ? "http" : "hermes_gateway",
  permissions: { canCreateAgents: i % 5 === 0 },
}));
function MembershipHost() {
  return (
    <>
      <CompanyAccess />
      <ToastViewport />
    </>
  );
}
const meta = {
  id: "feature-membership",
  title:
    "Getting started and access/Login, invitations, and access/Organization membership",
  component: MembershipHost,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "access/membership"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "CompanyAccess member list and role change with loading/empty/failure/403 and failed mutation toast. Backend actor authority, invite lifecycle and durable membership are not verified."
    },
  },
  beforeEach: ({ parameters }) => {
    member = { ...member, membershipRole: "operator", status: "active" };
    return prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/members",
          read: () => ({
            members:
              parameters.fixtureState === "empty"
                ? []
                : parameters.restrictionStress
                  ? [member, ...restrictedMembers]
                  : [member],
            access: {
              currentUserRole: "owner",
              canManageMembers: true,
              canInviteUsers: true,
              canApproveJoinRequests: true,
            },
          }),
        },
        {
          path: "/api/companies/company-storybook/agents",
          read: () => (parameters.restrictionStress ? stressAgents : []),
        },
        { path: "/api/plugins", read: () => stressPlugins },
        {
          path: "/api/companies/company-storybook/join-requests",
          read: () => [],
        },
        {
          path: "/api/companies/company-storybook/member-restriction-mode",
          method: "GET",
          read: () => ({
            mode: parameters.restrictionStress ? "enforce" : "off",
            deniedLast7Days: parameters.restrictionStress ? 123456 : 0,
          }),
        },
        {
          path: "/api/health",
          read: () => ({
            status: "ok",
            ...(parameters.restrictionKillSwitch ? { memberRestriction: "forced_off" } : {}),
          }),
        },
        {
          path: "/api/companies/company-storybook/members/member-gap",
          method: "PATCH",
          read: ({ body }) => {
            member = { ...member, ...body };
            return member;
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof MembershipHost>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Members: Story = {};
/** Kill switch on, company stored as `enforce`: every flagged member reads "flag set, not enforced". */
export const RestrictionKillSwitch: Story = {
  parameters: { restrictionStress: true, restrictionKillSwitch: true },
};
/** Company stored as `enforce`, no kill switch: the flagged member reads "restricted". */
export const RestrictionEnforced: Story = { parameters: { restrictionStress: true } };
/** The Access dialog of the flagged member with stress data and a stored id that is no longer an agent. */
export const RestrictionDialog: Story = {
  parameters: { restrictionStress: true },
  play: async ({ canvasElement }) => {
    const row = (await within(canvasElement).findByText(/Bartholomew/)).closest("tr")!;
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Access" }));
    await within(document.body).findByText("Agents this member may instruct");
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
export const UpdateRole: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Edit" }),
    );
    const c = within(document.body);
    await userEvent.selectOptions(
      c.getByRole("combobox", { name: "Organization role" }),
      "viewer",
    );
    await userEvent.click(c.getByRole("button", { name: "Save member" }));
    await waitFor(() => expect(member.membershipRole).toBe("viewer"));
    await waitFor(() =>
      expect(c.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  },
};
export const SaveFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Edit" }),
    );
    const c = within(document.body);
    await userEvent.selectOptions(
      c.getByRole("combobox", { name: "Organization role" }),
      "viewer",
    );
    await userEvent.click(c.getByRole("button", { name: "Save member" }));
    await c.findByText("The request failed. Please try again.");
  },
};
