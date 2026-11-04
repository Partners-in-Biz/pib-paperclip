import { useEffect, useState } from "react";
import { useHostContext, useHostLocation, useHostNavigation, usePluginAction, usePluginData, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText, Input, Page, PageMessage, Section, Select, usePibBaseStyles } from "@partnersinbiz/pib-plugin-ui";

interface Cap {
  scopeKey: string;
  monthlyCredits: number;
  updatedAt: string | null;
}

interface Overview {
  period: string;
  companyUsed: number;
  caps: Cap[];
  clientUsage: Array<{ scopeKey: string; used: number }>;
  history: Array<{ scopeKey: string; oldCredits: number | null; newCredits: number | null; changedBy: string; createdAt: string | null }>;
  clients: Array<{ scopeKey: string; name: string }>;
  assets: Array<{ id: string; name: string; kind: string; client: { name: string | null } | null; createdAt: string | null }>;
}

const DEFAULT_SCOPE = "default";
const COMPANY_SCOPE = "company";

function CapRow({ label, hint, scopeKey, cap, used, save, busy }: { label: string; hint: string; scopeKey: string; cap: Cap | undefined; used?: number; save: (scopeKey: string, value: string) => void; busy: boolean }) {
  const [value, setValue] = useState(cap ? String(cap.monthlyCredits) : "");
  useEffect(() => setValue(cap ? String(cap.monthlyCredits) : ""), [cap?.monthlyCredits]);
  const changed = value.trim() !== (cap ? String(cap.monthlyCredits) : "");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 13, opacity: 0.7 }}>
          {hint}
          {used !== undefined ? ` ${used} used this month.` : ""}
        </div>
      </div>
      <div style={{ width: 120 }}>
        <Input aria-label={`${label} monthly credits`} type="number" min={0} step="any" placeholder="Not set" value={value} onChange={(event) => setValue(event.target.value)} />
      </div>
      <Button disabled={busy || !changed} onClick={() => save(scopeKey, value)}>
        Save
      </Button>
    </div>
  );
}

export function StudioPage({ context }: PluginPageProps) {
  usePibBaseStyles();
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId ?? null;
  const { data, loading, error, refresh } = usePluginData<Overview>("overview", companyId ? { companyId } : undefined);
  const setCap = usePluginAction("set-cap");
  const assetUrl = usePluginAction("asset-url");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [addClient, setAddClient] = useState("");

  if (!companyId) return <Page title="Studio" description="Pick a company first.">{null}</Page>;
  if (error) return <Page title="Studio" description="Creative assets and monthly credit caps." message={errorText(error)} messageTone="danger">{null}</Page>;
  if (loading || !data) return <Page title="Studio" description="Creative assets and monthly credit caps.">Loading…</Page>;

  const capOf = (key: string) => data.caps.find((c) => c.scopeKey === key);
  const nameOf = (key: string) => (key === DEFAULT_SCOPE ? "Default" : key === COMPANY_SCOPE ? "Company" : (data.clients.find((c) => c.scopeKey === key)?.name ?? key));
  const clientCaps = data.caps.filter((c) => c.scopeKey.includes(":"));
  const addable = data.clients.filter((c) => !capOf(c.scopeKey));
  const anyCap = data.caps.some((c) => c.scopeKey === COMPANY_SCOPE || c.scopeKey === DEFAULT_SCOPE);

  async function save(scopeKey: string, value: string) {
    setBusy(true);
    setMessage(null);
    try {
      await setCap({ companyId, scopeKey, monthlyCredits: value.trim() === "" ? null : Number(value) });
      refresh();
      setMessage(`${nameOf(scopeKey)} cap saved. It applies to the next generation.`);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function open(assetId: string) {
    try {
      const out = (await assetUrl({ companyId, assetId })) as { url: string };
      window.open(out.url, "_blank", "noopener");
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <Page title="Studio" description={`Credits used in ${data.period}: ${data.companyUsed}`}>
      {message ? <PageMessage message={message} /> : null}
      {!anyCap ? <PageMessage tone="warning" message="No cap is set, so generation is off. Set a company cap to turn it on." /> : null}
      <Section title="Monthly credit caps">
        <CapRow label="Company" hint="All of this company's work, clients included." scopeKey={COMPANY_SCOPE} cap={capOf(COMPANY_SCOPE)} used={data.companyUsed} save={save} busy={busy} />
        <CapRow label="Default" hint="Used when the company cap is blank." scopeKey={DEFAULT_SCOPE} cap={capOf(DEFAULT_SCOPE)} save={save} busy={busy} />
        {clientCaps.map((c) => (
          <CapRow key={c.scopeKey} label={nameOf(c.scopeKey)} hint="Replaces the company cap for this client's work." scopeKey={c.scopeKey} cap={c} used={data.clientUsage.find((u) => u.scopeKey === c.scopeKey)?.used ?? 0} save={save} busy={busy} />
        ))}
        {addable.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", paddingTop: 12 }}>
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <Select aria-label="Client" value={addClient} onChange={(event) => setAddClient(event.target.value)}>
                <option value="">Add a cap for a client…</option>
                {addable.map((c) => (
                  <option key={c.scopeKey} value={c.scopeKey}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="secondary"
              disabled={busy || !addClient}
              onClick={() => {
                const scopeKey = addClient;
                setAddClient("");
                void save(scopeKey, String(capOf(COMPANY_SCOPE)?.monthlyCredits ?? capOf(DEFAULT_SCOPE)?.monthlyCredits ?? 0));
              }}
            >
              Add
            </Button>
          </div>
        ) : null}
        <p style={{ fontSize: 13, opacity: 0.7, marginTop: 12 }}>Leave a cap blank to clear it. 0 turns generation off. Only a company owner can change a cap.</p>
      </Section>
      <Section title="Recent assets">
        {data.assets.length === 0 ? <div style={{ opacity: 0.7 }}>Nothing yet.</div> : null}
        {data.assets.map((a) => (
          <div key={a.id} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>
              {a.name}
              <div style={{ fontSize: 13, opacity: 0.7 }}>
                {a.kind} · {a.client?.name ?? "Own work"}
              </div>
            </div>
            <Button variant="secondary" onClick={() => void open(a.id)}>
              Open
            </Button>
          </div>
        ))}
      </Section>
      {data.history.length > 0 ? (
        <Section title="Cap changes">
          {data.history.map((h, i) => (
            <div key={`${h.scopeKey}-${h.createdAt}-${i}`} style={{ fontSize: 13, padding: "4px 0", overflowWrap: "anywhere" }}>
              {h.createdAt?.slice(0, 16).replace("T", " ")} · {nameOf(h.scopeKey)}: {h.oldCredits ?? "not set"} to {h.newCredits ?? "not set"} · {h.changedBy}
            </div>
          ))}
        </Section>
      ) : null}
    </Page>
  );
}

export function StudioSidebar(_props: PluginSidebarProps) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const active = location.pathname === navigation.resolveHref("/studio");
  return (
    <a
      {...navigation.linkProps("/studio")}
      aria-current={active ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </svg>
      <span className="flex-1 truncate">Studio</span>
    </a>
  );
}
