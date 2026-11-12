/**
 * The People tab of a campaign: everyone in it, where each person stands,
 * what comes next for them and what happened so far. Before launch it lists
 * who would get the campaign. No host hooks.
 */
import { useMemo, useState } from "react";
import { Input, KpiCard, Pill, fluidColumns, formatDateTime, tokens } from "@partnersinbiz/pib-plugin-ui";
import type { PersonEvent, PersonView } from "../people.js";

export interface AudiencePerson { contactId: string; name: string | null; email: string | null }

const EVENT_WORDS: Record<string, string> = {
  sent: "sent",
  delivered: "delivered",
  open: "opened",
  click: "link clicked",
  reply: "replied",
  bounce: "bounced (the address does not work)",
  soft_bounce: "bounced for now (may work next time)",
  complaint: "marked as spam",
  unsubscribe: "opted out",
  failed: "could not be sent",
  skipped: "skipped (cannot be reached on this channel)",
};

function contactHref(contactId: string): string {
  return `/crm?client=contact%3A${encodeURIComponent(contactId)}`;
}

function eventLine(event: PersonEvent, numbers: Map<number, number>): string {
  const what = EVENT_WORDS[event.type] ?? event.type;
  const step = `Email ${numbers.get(event.stepPosition) ?? event.stepPosition}`;
  return `${step} ${what}${event.count > 1 ? ` (${event.count} times)` : ""}`;
}

function matches(text: string, q: string): boolean {
  return text.toLowerCase().includes(q);
}

export function PeopleTab({ people, audience, capped, total, draft, numbers, linkFor }: {
  /** Everyone enrolled, or null when the list could not be read. */
  people: PersonView[] | null;
  /** Before launch: who would get it. */
  audience: AudiencePerson[] | null;
  /** More people are enrolled than the list holds. */
  capped: boolean;
  total: number;
  draft: boolean;
  numbers: Map<number, number>;
  linkFor: (href: string) => Record<string, unknown>;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "attention" | "emailed" | "replied" | "stopped">("all");
  const q = search.trim().toLowerCase();

  const shown = useMemo(() => {
    const rows = people ?? [];
    return rows.filter((person) => {
      if (q && !matches(`${person.name ?? ""} ${person.email ?? ""}`, q)) return false;
      if (filter === "attention") return person.state.key === "held" || person.state.key === "waiting-agent";
      if (filter === "emailed") return person.sent > 0;
      if (filter === "replied") return person.state.key === "replied";
      if (filter === "stopped") return person.status !== "running";
      return true;
    });
  }, [people, q, filter]);

  if (draft) {
    const rows = (audience ?? []).filter((person) => !q || matches(`${person.name ?? ""} ${person.email ?? ""}`, q));
    return (
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>
          Nobody is enrolled until the campaign is approved and launched. {audience ? `These ${audience.length === 1 ? "is the 1 person" : `are the ${audience.length} people`} who would get it today.` : "The audience could not be read just now."}
        </p>
        {audience && audience.length > 8 ? <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people" aria-label="Search people" /> : null}
        {audience && audience.length === 0 ? <Empty text="Nobody matches this audience yet. Tag contacts in the CRM, or change the audience." /> : null}
        {rows.length > 0 ? (
          <ul style={listStyle}>
            {rows.map((person) => (
              <li key={person.contactId} style={rowStyle}>
                <span style={{ display: "grid", gap: 1, minWidth: 0, flex: "1 1 220px" }}>
                  <a {...linkFor(contactHref(person.contactId))} style={nameStyle}>{person.name || "No name"}</a>
                  <span style={mutedSmall}>{person.email ?? "No email address: gets a task instead"}</span>
                </span>
                <span style={{ ...mutedSmall, flex: "0 1 auto" }}>Will get email 1 at launch</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (!people) return <Empty text="The list of people could not be read just now. Reload the page." />;
  if (people.length === 0) return <Empty text="Nobody is enrolled in this campaign." />;

  const held = people.filter((p) => p.state.key === "held").length;
  const waiting = people.filter((p) => p.state.key === "waiting-agent" || p.state.key === "due" || p.state.key === "sending").length;
  const emailed = people.filter((p) => p.sent > 0).length;
  const replied = people.filter((p) => p.state.key === "replied").length;
  const out = people.filter((p) => p.state.key === "opted-out" || p.state.key === "bounced").length;

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(130), gap: 10 }}>
        <KpiCard size="sm" label="In this campaign" value={total} hint={capped ? `Showing the first ${people.length}` : undefined} />
        {held > 0 ? <KpiCard size="sm" label="Held" value={held} tone="bad" hint="Their task is blocked" /> : null}
        <KpiCard size="sm" label="Waiting to be sent" value={waiting} tone={waiting ? "warn" : "neutral"} />
        <KpiCard size="sm" label="Emailed" value={emailed} />
        <KpiCard size="sm" label="Replied" value={replied} tone={replied ? "ok" : "neutral"} />
        <KpiCard size="sm" label="Opted out or bounced" value={out} />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or email" aria-label="Search people" />
        </div>
        <div role="group" aria-label="Show" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {([["all", "Everyone"], ["attention", "Waiting or held"], ["emailed", "Emailed"], ["replied", "Replied"], ["stopped", "Stopped"]] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} style={chipStyle(filter === id)}>{label}</button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? <Empty text="Nobody matches." /> : (
        <ul style={listStyle}>
          {shown.map((person) => (
            <li key={person.enrollmentId} style={{ ...rowStyle, alignItems: "flex-start" }}>
              <span style={{ display: "grid", gap: 1, minWidth: 0, flex: "2 1 200px" }}>
                <a {...linkFor(contactHref(person.contactId))} title="Open in the CRM" style={nameStyle}>{person.name || "A contact no longer in the CRM"}</a>
                <span style={mutedSmall}>{person.email ?? "No email address"}</span>
              </span>
              <span style={{ display: "grid", gap: 3, minWidth: 0, flex: "3 1 260px", justifyItems: "start" }}>
                <Pill tone={person.state.tone} dot>{person.state.label}</Pill>
                <span style={mutedSmall}>
                  {person.state.next}
                  {person.task ? <> <a {...linkFor(`/issues/${person.task.identifier ?? person.task.id}`)} style={{ color: tokens.primary, fontWeight: 600 }}>Open the task</a></> : null}
                </span>
                {person.events.length > 0 ? (
                  <details>
                    <summary style={{ cursor: "pointer", fontSize: 12.5, color: tokens.primary, fontWeight: 600 }}>History</summary>
                    <ul style={{ margin: "4px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 2 }}>
                      {person.events.map((event, index) => (
                        <li key={index} style={mutedSmall}>{eventLine(event, numbers)}{event.at ? ` · ${formatDateTime(event.at)}` : ""}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {capped ? <p style={{ margin: 0, ...mutedSmall }}>The list shows the first {people.length} of {total} people.</p> : null}
    </div>
  );
}

const listStyle = { margin: 0, padding: 0, listStyle: "none", display: "grid", border: `1px solid ${tokens.border}`, borderRadius: 10, overflow: "hidden", minWidth: 0 } as const;
const rowStyle = { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", padding: "10px 12px", borderBottom: `1px solid ${tokens.border}`, minWidth: 0, background: tokens.card } as const;
const nameStyle = { fontSize: 13.5, fontWeight: 600, color: tokens.fg, textDecoration: "underline", textUnderlineOffset: 3, textDecorationColor: tokens.border, overflowWrap: "anywhere" } as const;
const mutedSmall = { fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere" } as const;

function chipStyle(on: boolean) {
  return {
    appearance: "none", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: "5px 10px", borderRadius: 999, cursor: "pointer",
    border: `1px solid ${on ? tokens.primary : tokens.border}`, background: on ? tokens.secondary : "transparent", color: on ? tokens.secondaryFg : tokens.muted,
  } as const;
}

function Empty({ text }: { text: string }) {
  return <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5 }}>{text}</p>;
}
