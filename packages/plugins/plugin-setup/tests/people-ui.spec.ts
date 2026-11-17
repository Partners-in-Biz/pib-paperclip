import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GUARDED_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { describe, expect, it } from "vitest";
import { accessAreas, type AccessPeopleView } from "../src/access-people.js";
import { setupTabs } from "../src/ui/index.js";
import { PeopleSection, areaState, isAccessAdminRole, setArea, type PeopleSectionProps } from "../src/ui/people.js";

const noop = () => undefined;
const view = (over: Partial<AccessPeopleView> = {}): AccessPeopleView => ({
  ok: true,
  mode: "report",
  rev: 7,
  plugins: GUARDED_PLUGINS.map((pluginKey, i) => ({ pluginKey, rev: i === 1 ? 6 : 7, syncedAt: null, confirmed: i !== 1, red: i === 1 })),
  switchLost: false,
  people: [{ userId: "u1", role: "member", grant: { userId: "u1", preset: "viewer", allow: [], deny: [], linkedCompanyIds: [], scopeOverrides: {} } as never }],
  refusals: [{ companyId: "co", pluginKey: "partnersinbiz.billing", userId: "u1", key: "billing.list", permission: "billing.invoices:view", viaAgentId: "a1", createdAt: "2026-11-17T10:00:00.000Z" }],
  areas: accessAreas(),
  presets: [{ id: "viewer", label: "Viewer" }],
  ...over,
});
const props = (over: Partial<PeopleSectionProps> = {}): PeopleSectionProps => ({
  view: view(),
  members: [{ userId: "owner", name: "Peet", email: null, role: "owner" }, { userId: "u1", name: "Sipho", email: "s@x.co", role: "member" }],
  agentNames: { a1: "Rhea" },
  linkFor: (href) => ({ href: `/PAR${href}` }),
  busy: null,
  notice: null,
  confirm: null,
  onMode: noop, onConfirmEnforce: noop, onCancelConfirm: noop, onSendAgain: noop, onSave: noop, onClear: noop,
  ...over,
});
const html = (p: PeopleSectionProps) => renderToStaticMarkup(createElement(PeopleSection, p));

describe("People tab", () => {
  it("shows beside Team for an owner or admin, never for an operator", () => {
    expect(setupTabs({ firstVisit: false, showTeam: true, showPeople: isAccessAdminRole("owner"), requested: null }).ids).toEqual(["team", "people", "checklist", "modules", "new-company"]);
    expect(setupTabs({ firstVisit: false, showTeam: true, showPeople: isAccessAdminRole("admin"), requested: "people" }).active).toBe("people");
    const operator = setupTabs({ firstVisit: false, showTeam: true, showPeople: isAccessAdminRole("operator"), requested: "people" });
    expect(operator.ids).not.toContain("people");
    expect(operator.active).toBe("team");
    expect(setupTabs({ firstVisit: false, showTeam: true, showPeople: isAccessAdminRole(null), requested: null }).ids).not.toContain("people");
  });

  it("draws the switch, the 15 plugins with the one behind, the rows, the report list and the invite link", () => {
    const out = html(props());
    expect(out).toContain("Revision 7");
    expect(out).toContain(`1 of ${GUARDED_PLUGINS.length} have not confirmed revision 7`);
    expect(out).toContain("behind (rev 6)");
    expect(out).toContain("Send again");
    expect(out).toContain("Sipho");
    expect(out).toContain("Full access"); // the owner
    expect(out).toContain("Viewer"); // u1's preset
    expect(out).toContain("through agent Rhea");
    expect(out).toContain('href="/PAR/company/settings/invites"');
    expect(out).not.toContain("Switch lost");
  });

  it("switch lost, and an empty report list", () => {
    const out = html(props({ view: view({ switchLost: true, refusals: [] }) }));
    expect(out).toContain("Switch lost, choose again");
    expect(out).toContain("Nothing refused");
  });
});

describe("area switches", () => {
  const keys = ["crm.contacts:view", "crm.contacts:edit"];
  it("allow, deny and back to the preset", () => {
    const empty = { preset: "viewer", allow: [], deny: ["billing.invoices:view"] };
    expect(areaState(empty, keys)).toBe("preset");
    const allowed = setArea(empty, keys, "allow");
    expect(allowed).toEqual({ preset: "viewer", allow: keys, deny: ["billing.invoices:view"] });
    expect(areaState(allowed, keys)).toBe("allow");
    const denied = setArea(allowed, keys, "deny");
    expect(areaState(denied, keys)).toBe("deny");
    expect(denied.allow).toEqual([]);
    expect(setArea(denied, keys, "preset")).toEqual({ preset: "viewer", allow: [], deny: ["billing.invoices:view"] });
    expect(areaState({ preset: null, allow: [keys[0]!], deny: [] }, keys)).toBe("mixed");
  });
});
