/**
 * "Managed by" on a company page (access stage B, PAR-12581). Everyone who can open the company sees who
 * manages it; an owner or admin can change the owner and add up to three more managers. A limited person's
 * own companies are the ones he manages, so this card decides what he can open.
 */
import { useEffect, useState } from "react";
import { Button, Field, Select, SectionCard, Users, tokens } from "@partnersinbiz/pib-plugin-ui";
import {
  MAX_EXTRA_MANAGERS,
  draftOf,
  draftProblem,
  managersLine,
  parseMembers,
  setManagersParams,
  type ManagersData,
  type ManagersDraft,
  type MemberOption,
} from "./managed-by-view.js";

const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 } as const;

/** Member names; null until read or when they cannot be read (the card then says "A team member"). */
function useMemberOptions(companyId: string | null): MemberOption[] | null {
  const [members, setMembers] = useState<MemberOption[] | null>(null);
  useEffect(() => {
    setMembers(null);
    if (!companyId) return;
    let live = true;
    fetch(`/api/companies/${encodeURIComponent(companyId)}/members`, { credentials: "include", headers: { accept: "application/json" } })
      .then(async (res) => (res.ok ? parseMembers(await res.json()) : null))
      .then((rows) => { if (live) setMembers(rows); }, () => undefined);
    return () => { live = false; };
  }, [companyId]);
  return members;
}

export function ManagedByCard({ companyId, companyRecordId, managers, onSave }: {
  companyId: string | null;
  companyRecordId: string;
  managers: ManagersData;
  onSave: (params: ReturnType<typeof setManagersParams>) => Promise<boolean>;
}) {
  const members = useMemberOptions(companyId);
  const names = new Map((members ?? []).map((m) => [m.userId, m.label]));
  const [draft, setDraft] = useState<ManagersDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = draft ? draftProblem(draft) : null;
  const slots = draft ? [...draft.managerUserIds, ...Array(Math.max(0, MAX_EXTRA_MANAGERS - draft.managerUserIds.length)).fill("")].slice(0, MAX_EXTRA_MANAGERS) : [];
  const choose = (value: string, index: number) => {
    if (!draft) return;
    const next = [...slots];
    next[index] = value;
    setDraft({ ...draft, managerUserIds: next.filter(Boolean) });
  };
  const options = (current: string) => (
    <>
      <option value="">{current ? "Nobody" : "Select…"}</option>
      {(members ?? []).map((m) => <option key={m.userId} value={m.userId}>{m.label}</option>)}
    </>
  );

  return (
    <SectionCard
      title="Managed by"
      icon={Users}
      subtitle="The owner and the people who manage this company. A person with access to his own companies only sees the companies he manages."
      actions={managers.canChange && !draft ? <Button type="button" variant="secondary" disabled={!members} onClick={() => setDraft(draftOf(managers))}>Change</Button> : undefined}
    >
      {!draft ? <p style={{ ...muted, color: tokens.fg }}>{managersLine(managers, names)}</p> : (
        <div style={{ display: "grid", gap: 8 }}>
          <Field label="Owner">
            <Select value={draft.ownerUserId} onChange={(event) => setDraft({ ...draft, ownerUserId: event.target.value })}>
              {options(draft.ownerUserId)}
            </Select>
          </Field>
          {slots.map((id, index) => (
            <Field key={index} label={index === 0 ? "Also managed by" : "And by"}>
              <Select value={id} onChange={(event) => choose(event.target.value, index)}>{options(id)}</Select>
            </Field>
          ))}
          {problem ? <p style={muted}>{problem}</p> : null}
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button>
            <Button
              type="button"
              disabled={busy || problem !== null}
              onClick={() => {
                setBusy(true);
                void onSave(setManagersParams(companyRecordId, draft)).then((ok) => {
                  setBusy(false);
                  if (ok) setDraft(null);
                });
              }}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
