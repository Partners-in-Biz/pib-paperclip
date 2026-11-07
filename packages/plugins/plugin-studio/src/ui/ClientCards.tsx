import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText, PageMessage, Section } from "@partnersinbiz/pib-plugin-ui";
import { clientsWithAssets, type ClientSummary } from "./clients.js";
import { usePreviewUrls } from "./previews.js";

const muted = { fontSize: 13, opacity: 0.7 } as const;

/** One card per client. Thumbnails use the same person-only "asset-urls" action as the library. */
export function ClientCards({ companyId, version, onOpenLibrary }: { companyId: string; version: number; onOpenLibrary: (scopeKey: string) => void }) {
  const summaries = usePluginData<{ period: string; clients: ClientSummary[] }>("client-summaries", { companyId, v: version });
  const clients = clientsWithAssets(summaries.data?.clients ?? []);
  const { urls } = usePreviewUrls(companyId, clients.flatMap((c) => c.recentApproved.map((a) => a.id)));

  if (summaries.error) return <PageMessage tone="danger" message={errorText(summaries.error)} />;
  if (!summaries.data || clients.length === 0) return null;

  return (
    <Section title="Clients">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))", gap: 12, marginBottom: 12 }}>
        {clients.map((c) => (
          <div key={c.scopeKey} data-testid="client-card" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, minWidth: 0, display: "grid", gap: 8 }}>
            <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{c.name}</div>
            <div style={muted}>
              {c.counts.draft} draft · {c.counts.approved} approved · {c.counts.rejected} rejected
            </div>
            <div style={muted}>
              {summaries.data?.period}: {c.used} credits used of {c.monthlyCap === null ? "no cap set" : `${c.monthlyCap}${c.capSource === "client" ? "" : ` (${c.capSource} cap)`}`}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
              {c.recentApproved.length === 0 ? <div style={{ ...muted, gridColumn: "1 / -1" }}>No approved assets yet.</div> : null}
              {c.recentApproved.map((a) => {
                const box = { width: "100%", aspectRatio: "1 / 1", objectFit: "cover" as const, borderRadius: 6, background: "rgba(127,127,127,0.12)", display: "block" };
                const url = urls[a.id];
                return url && a.kind !== "video" ? <img key={a.id} src={url} alt={a.name} style={box} loading="lazy" /> : <div key={a.id} title={a.name} style={{ ...box, display: "grid", placeItems: "center", ...muted }}>{a.kind}</div>;
              })}
            </div>
            <Button variant="secondary" onClick={() => onOpenLibrary(c.scopeKey)}>
              View library
            </Button>
          </div>
        ))}
      </div>
    </Section>
  );
}
