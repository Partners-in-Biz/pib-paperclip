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
    restrictedPluginKeys: Array.from({ length: 12 }, (_, i) => `plugin.${i}`),
    restrictedAgentIds: ["agent-1"],
  },
  {
    ...member,
    id: "member-open",
    principalId: "user-open",
    user: { id: "user-open", email: "open@example.test", name: "Open member", image: null },
    restricted: false,
  },
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
