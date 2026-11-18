import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToastViewport } from "@/components/ToastViewport";
import { CompanyAccess } from "@/pages/CompanyAccess";
import { JoinRequestQueue } from "@/pages/JoinRequestQueue";
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
// Stress data for the invite restriction mark (PAR-12608 4.2a): long lists, a stale agent id, an
// unmarked invite, and a join request whose mark is the server default (no choice was made).
const inviteMark = {
  restricted: true,
  pluginKeys: stressPlugins.slice(0, 6).map((plugin) => plugin.pluginKey),
  agentIds: ["agent-0", "agent-4", "agent-8", "00000000-0000-4000-8000-000000000000"],
};
const invitedByUser = { id: "user-review", name: restrictedMembers[0].user.name, email: null, image: null };
const inviteRow = (id: string, memberRestriction: typeof inviteMark | null) => ({
  id,
  companyId: "company-storybook",
  companyName: "Storybook",
  inviteType: "company_join",
  allowedJoinTypes: "human",
  humanRole: "operator",
  defaultsPayload: null,
  memberRestriction,
  expiresAt: "2026-12-01T00:00:00Z",
  invitedByUserId: "user-review",
  revokedAt: null,
  acceptedAt: null,
  createdAt: "2026-11-18T08:00:00Z",
  updatedAt: "2026-11-18T08:00:00Z",
  inviteMessage: null,
  state: "active",
  invitedByUser,
  relatedJoinRequestId: null,
});
const restrictionInvites = [
  inviteRow("invite-marked", inviteMark),
  inviteRow("invite-empty-lists", { restricted: true, pluginKeys: [], agentIds: [] }),
  inviteRow("invite-unmarked", null),
];
const joinRequest = (id: string, invite: Record<string, unknown>) => ({
  id,
  companyId: "company-storybook",
  requestType: "human",
  status: "pending_approval",
  requestIp: "203.0.113.10",
  requestingUserId: `user-${id}`,
  requestEmailSnapshot: restrictedMembers[0].user.email,
  requesterUser: { id: `user-${id}`, email: restrictedMembers[0].user.email, name: restrictedMembers[0].user.name, image: null },
  createdAt: "2026-11-18T08:30:00Z",
  updatedAt: "2026-11-18T08:30:00Z",
  invite: { ...inviteRow(`invite-${id}`, null), ...invite },
});
const restrictionJoinRequests = [
  joinRequest("join-marked", { memberRestriction: inviteMark }),
  joinRequest("join-default", {
    memberRestriction: { restricted: true, pluginKeys: [], agentIds: [] },
    memberRestrictionIsDefault: true,
  }),
  joinRequest("join-unmarked", {}),
];
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
          read: () => (parameters.restrictionInvites ? restrictionJoinRequests : []),
        },
        {
          path: "/api/companies/company-storybook/invites",
          method: "GET",
          read: () => ({ invites: parameters.restrictionInvites ? restrictionInvites : [], nextOffset: null }),
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
/** Company on `enforce`: pending joins show each invite's mark; one mark is the server default. */
export const RestrictionJoinRequests: Story = {
  parameters: { restrictionStress: true, restrictionInvites: true },
};
/** The join-request queue (approval screen) with the same marks. */
export const RestrictionJoinRequestQueue: Story = {
  parameters: { restrictionStress: true, restrictionInvites: true },
  render: () => <JoinRequestQueue />,
};
const invitesTab = {
  restrictionStress: true,
  restrictionInvites: true,
  initialEntries: ["/PAP/company/settings/members?tab=invites"],
};
/** Invites tab on `enforce` before a choice: no default, Create invite disabled, the prompt shows. */
export const RestrictionInviteRequired: Story = {
  parameters: invitesTab,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByText("Choose full access or restricted to create the invite.");
    await expect(c.getByRole("button", { name: "Create invite" })).toBeDisabled();
  },
};
/** Invites tab on `enforce` with Restricted chosen: the plugin and agent lists open. */
export const RestrictionInviteForm: Story = {
  parameters: invitesTab,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("radio", { name: /^Restricted/ }));
    await c.findByText("Agents this person may instruct");
    await expect(c.getByRole("button", { name: "Create invite" })).toBeEnabled();
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
