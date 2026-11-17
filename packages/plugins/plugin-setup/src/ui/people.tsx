/**
 * Setup → People (PAR-12578 plan, 4.8, 4.3 and 4.4). Owner or admin only: the
 * access switch with the enforce confirm list, the 15 plugins and whether they
 * received the current `rev`, each member's grant and the report list.
 * `PeopleSection` draws from props only; `PeopleTab` loads and acts.
 */
import { useCallback, useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, EmptyState, Modal, Pill, SectionCard, Select, ShieldCheck, Users, breakAnywhere, errorText, formatDateTime, tokens, withRefusal } from "@partnersinbiz/pib-plugin-ui";
import type { AccessPeopleView } from "../access-people.js";
import type { NoAccessPerson } from "../access-switch.js";
import type { LinkPropsFor } from "./components.js";

const useAction = withRefusal(usePluginAction);
type Mode = AccessPeopleView["mode"];
type Grant = NonNullable<AccessPeopleView["people"][number]["grant"]>;
export type AreaState = "preset" | "allow" | "deny" | "mixed";
export interface Draft { preset: string | null; allow: string[]; deny: string[] }
export interface PeopleMember { userId: string; name: string | null; email: string | null; role: string | null }

export const isAccessAdminRole = (role: string | null | undefined) => role === "owner" || role === "admin";
const ACRONYMS: Record<string, string> = { crm: "CRM", seo: "SEO" };
const label = (s: string) => ACRONYMS[s] ?? s[0]!.toUpperCase() + s.slice(1);

/** An area is allowed or denied when all its keys are; some of them is `mixed`, none is the preset's. */
export function areaState(draft: Draft, keys: string[]): AreaState {
  const count = (list: string[]) => keys.filter((key) => list.includes(key)).length;
  const allow = count(draft.allow), deny = count(draft.deny);
  if (allow === keys.length) return "allow";
  if (deny === keys.length) return "deny";
  return allow || deny ? "mixed" : "preset";
}

export function setArea(draft: Draft, keys: string[], state: Exclude<AreaState, "mixed">): Draft {
  const rest = (list: string[]) => list.filter((key) => !keys.includes(key));
  return { ...draft, allow: [...rest(draft.allow), ...(state === "allow" ? keys : [])], deny: [...rest(draft.deny), ...(state === "deny" ? keys : [])] };
}

const draftOf = (grant: Grant | null): Draft => ({ preset: grant?.preset ?? null, allow: grant?.allow ?? [], deny: grant?.deny ?? [] });

export interface PeopleSectionProps {
  view: AccessPeopleView;
  members: PeopleMember[];
  agentNames: Record<string, string>;
  linkFor: LinkPropsFor;
  busy: string | null;
  notice: { text: string; bad: boolean } | null;
  confirm: NoAccessPerson[] | null;
  onMode: (mode: Mode) => void;
  onConfirmEnforce: () => void;
  onCancelConfirm: () => void;
  onSendAgain: () => void;
  onSave: (userId: string, draft: Draft, linkedCompanyIds: string[]) => void;
  onClear: (userId: string) => void;
}

const MODES: Array<{ id: Mode; text: string }> = [
  { id: "off", text: "Nobody is checked." },
  { id: "report", text: "Nobody is refused; what would be refused is listed below." },
  { id: "enforce", text: "People without a grant are refused." },
];

export function PeopleSection(props: PeopleSectionProps) {
  const { view, members, busy } = props;
  const names = new Map(members.map((m) => [m.userId, m.name || m.email || m.userId]));
  const grants = new Map(view.people.map((row) => [row.userId, row.grant]));
  const behind = view.plugins.filter((p) => !p.confirmed).length;
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      {props.notice ? <p role="status" style={{ margin: 0, fontSize: 13, color: props.notice.bad ? tokens.tones.bad.fg : tokens.muted, ...breakAnywhere }}>{props.notice.text}</p> : null}
      {view.switchLost ? (
        <SectionCard title="Switch lost, choose again" tone="bad" subtitle="Setup has no access settings for this company, but a plugin still holds some. Choose the switch again." icon={ShieldCheck}>{null}</SectionCard>
      ) : null}
      <SectionCard title="Access switch" subtitle={`Revision ${view.rev}`} icon={ShieldCheck}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {MODES.map((m) => (
            <Button key={m.id} type="button" variant={view.mode === m.id ? "primary" : "secondary"} aria-pressed={view.mode === m.id} disabled={busy !== null} onClick={() => props.onMode(m.id)}>{label(m.id)}</Button>
          ))}
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 13, color: tokens.muted }}>{MODES.find((m) => m.id === view.mode)?.text}</p>
      </SectionCard>
      <SectionCard
        title="Received by the plugins"
        subtitle={behind ? `${behind} of ${view.plugins.length} have not confirmed revision ${view.rev}` : `All ${view.plugins.length} have revision ${view.rev}`}
        actions={<Button type="button" variant="secondary" disabled={busy !== null} onClick={props.onSendAgain}>{busy === "send" ? "Sending…" : "Send again"}</Button>}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 250px), 1fr))", gap: 8 }}>
          {view.plugins.map((p) => (
            <div key={p.pluginKey} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", minWidth: 0, fontSize: 13 }}>
              <span style={{ minWidth: 0, ...breakAnywhere }}>{p.pluginKey.replace(/^partnersinbiz\./, "")}</span>
              <Pill size="sm" tone={p.red ? "bad" : p.confirmed ? "ok" : "warn"}>{p.confirmed ? `rev ${p.rev}` : p.rev === null ? "never reported" : `behind (rev ${p.rev})`}</Pill>
            </div>
          ))}
        </div>
      </SectionCard>
      <SectionCard title="People" icon={Users} subtitle="Owners and admins always have full access." actions={<a {...props.linkFor("/company/settings/invites")} style={{ fontSize: 13, color: tokens.primary }}>Invite people</a>}>
        {members.length ? (
          <div style={{ display: "grid", gap: 8 }}>
            {members.map((m) => <PersonRow key={m.userId} member={m} name={names.get(m.userId)!} grant={grants.get(m.userId) ?? null} view={view} busy={busy} onSave={props.onSave} onClear={props.onClear} />)}
          </div>
        ) : <EmptyState compact title="No members yet" description="Invite people first." />}
      </SectionCard>
      <SectionCard title="Report list" subtitle="What was refused, or would be on report. Newest first.">
        {view.refusals.length ? (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6, fontSize: 13 }}>
            {view.refusals.map((r, i) => (
              <li key={i} style={{ minWidth: 0, ...breakAnywhere }}>
                <span style={{ color: tokens.muted }}>{formatDateTime(r.createdAt)}</span>{" "}
                <strong>{r.userId ? names.get(r.userId) ?? r.userId : "Unknown person"}</strong>
                {r.viaAgentId ? ` through agent ${props.agentNames[r.viaAgentId] ?? r.viaAgentId}` : ""}: {r.permission ?? r.key} in {r.pluginKey.replace(/^partnersinbiz\./, "")}
              </li>
            ))}
          </ul>
        ) : <EmptyState compact title="Nothing refused" description={view.mode === "off" ? "Refusals are listed on report and enforce." : "No one was refused yet."} />}
      </SectionCard>
      <Modal
        open={props.confirm !== null}
        title="People with no access under enforce"
        description="They have no grant that opens anything. Check the list, then switch on."
        onClose={props.onCancelConfirm}
        footer={<><Button type="button" variant="secondary" onClick={props.onCancelConfirm}>Cancel</Button><Button type="button" disabled={busy !== null} onClick={props.onConfirmEnforce}>Switch to enforce</Button></>}
      >
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "grid", gap: 4 }}>
          {(props.confirm ?? []).map((p) => (
            <li key={p.userId} style={breakAnywhere}>{names.get(p.userId) ?? p.userId} ({p.role}): {p.runsLast30Days === null ? "runs unknown" : `${p.runsLast30Days} runs worked for them in 30 days`}</li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

function PersonRow({ member, name, grant, view, busy, onSave, onClear }: { member: PeopleMember; name: string; grant: Grant | null; view: AccessPeopleView; busy: string | null; onSave: PeopleSectionProps["onSave"]; onClear: PeopleSectionProps["onClear"] }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const admin = isAccessAdminRole(member.role);
  const preset = view.presets.find((p) => p.id === grant?.preset)?.label;
  const linked = grant?.linkedCompanyIds ?? [];
  return (
    <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 8, padding: 10, display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0, flex: "1 1 200px" }}>
          <div style={{ fontWeight: 600, fontSize: 14, ...breakAnywhere }}>{name}</div>
          {member.email && member.email !== name ? <div style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>{member.email}</div> : null}
        </div>
        <Pill size="sm">{member.role ?? "member"}</Pill>
        <Pill size="sm" tone={admin || grant ? "ok" : "neutral"}>{admin ? "Full access" : preset ?? (grant ? "Custom" : "No access")}</Pill>
        {admin || draft ? null : <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => setDraft(draftOf(grant))}>Change</Button>}
      </div>
      {draft ? (
        <div style={{ display: "grid", gap: 8 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: tokens.muted }}>Preset
            <Select value={draft.preset ?? ""} onChange={(e) => setDraft({ ...draft, preset: e.target.value || null })}>
              <option value="">None</option>
              {view.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 140px), 1fr))", gap: 8 }}>
            {view.areas.map((a) => {
              const state = areaState(draft, a.keys);
              return (
                <label key={a.area} style={{ display: "grid", gap: 4, fontSize: 12, color: tokens.muted }}>{label(a.area)}
                  <Select value={state} onChange={(e) => setDraft(setArea(draft, a.keys, e.target.value as Exclude<AreaState, "mixed">))}>
                    <option value="preset">From preset</option>
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                    {state === "mixed" ? <option value="mixed" disabled>Some keys</option> : null}
                  </Select>
                </label>
              );
            })}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: tokens.muted, ...breakAnywhere }}>Own companies: {linked.length ? linked.join(", ") : "none yet"}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}>
            <Button type="button" variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {grant ? <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => { onClear(member.userId); setDraft(null); }}>Remove access</Button> : null}
              <Button type="button" disabled={busy !== null} onClick={() => { onSave(member.userId, draft, linked); setDraft(null); }}>Save</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The tab: loads the view and agent names, and runs every action through `withRefusal`. */
export function PeopleTab({ companyId, members, agentNames, linkFor }: { companyId: string; members: PeopleMember[]; agentNames: Record<string, string>; linkFor: LinkPropsFor }) {
  const load = useAction("setup.access.people");
  const setMode = useAction("setup.access.set-mode");
  const sendAgain = useAction("setup.access.send-again");
  const saveGrant = useAction("setup.access.save-grant");
  const clearGrant = useAction("setup.access.clear-grant");
  const [view, setView] = useState<AccessPeopleView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
  const [confirm, setConfirm] = useState<NoAccessPerson[] | null>(null);

  const reload = useCallback(async () => {
    const answer = (await load({ companyId })) as AccessPeopleView | { ok: false; error: string };
    if (!answer.ok) throw new Error(answer.error);
    setView(answer);
  }, [load, companyId]);
  useEffect(() => { reload().catch((e) => setNotice({ text: errorText(e), bad: true })); }, [reload]);

  /** Runs one action; an `{ ok: false }` answer or a refusal shows its message. */
  const run = async (key: string, act: () => Promise<unknown>, done: (answer: Record<string, unknown>) => string) => {
    setBusy(key);
    try {
      const answer = (await act()) as Record<string, unknown>;
      if (answer.ok === false) {
        if (Array.isArray(answer.noAccess)) setConfirm(answer.noAccess as NoAccessPerson[]);
        else setNotice({ text: String(answer.error), bad: true });
      } else setNotice({ text: done(answer), bad: false });
      await reload();
    } catch (e) {
      setNotice({ text: errorText(e), bad: true });
    } finally {
      setBusy(null);
    }
  };

  if (!view) return notice ? <p style={{ margin: 0, fontSize: 13, color: tokens.tones.bad.fg }}>{notice.text}</p> : <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading…</p>;
  const sent = (a: Record<string, unknown>) => (a.sent === false ? " Not sent yet; the re-send job tries again within a minute." : "");
  return (
    <PeopleSection
      view={view} members={members} agentNames={agentNames} linkFor={linkFor} busy={busy} notice={notice} confirm={confirm}
      onMode={(mode) => void run("mode", () => setMode({ companyId, mode }), (a) => `Switch is ${mode}, revision ${a.rev}.${sent(a)}`)}
      onConfirmEnforce={() => { const seen = (confirm ?? []).map((p) => p.userId); setConfirm(null); void run("mode", () => setMode({ companyId, mode: "enforce", confirmNoAccess: seen }), (a) => `Switch is enforce, revision ${a.rev}.${sent(a)}`); }}
      onCancelConfirm={() => setConfirm(null)}
      onSendAgain={() => void run("send", () => sendAgain({ companyId }), (a) => `Sent revision ${a.rev}.`)}
      onSave={(userId, draft, linkedCompanyIds) => void run("save", () => saveGrant({ companyId, userId, ...draft, linkedCompanyIds }), (a) => `Saved. Access is now at revision ${a.rev}.${sent(a)}`)}
      onClear={(userId) => void run("save", () => clearGrant({ companyId, userId }), (a) => `Access removed. Revision ${a.rev}.${sent(a)}`)}
    />
  );
}
