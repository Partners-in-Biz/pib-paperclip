/**
 * Integrations tab: Needs you, the site repo, this sprint's setup, and the
 * Google Search Console, PageSpeed and Bing connections. Errors read in plain
 * words (engine/plain.ts); the raw text is under Details, once.
 */
import { useEffect, useState } from "react";
import { DataTable, useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { rememberOAuthStart } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { parseClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { Button, ChartColumn, CompactRows, Gauge, Input, Pill, Plug, Search, Section, Share2, breakAnywhere, errorText, formatCompact, formatDateTime, formatShortDate, tokens, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { plainError } from "../engine/plain.js";
import { sprintPagePath } from "../engine/scope.js";
import { NeedsYouSection, SetupChecklist, SiteRepoSection } from "./autonomy.js";
import { ExtrasList } from "./extras.js";
import { IssueLink, PlainProblem, RawDetails, fmt, shortUrl, small } from "./parts.js";
import { statusTone } from "./series.js";
import type { CallFn, LoadResult, PageHealth, SprintBundle } from "./types.js";

/** Lighthouse-style score: 90+ green, 50+ amber, below red. */
function scorePill(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const score = value <= 1 ? Math.round(value * 100) : Math.round(value);
  return <Pill size="sm" tone={score >= 90 ? "ok" : score >= 50 ? "warn" : "bad"}>{score}</Pill>;
}

function seconds(ms: number | null): string {
  return ms == null ? "—" : `${(Number(ms) / 1000).toFixed(1)} s`;
}

/** Setup items that belong to one sprint; the rest are company-wide and live on the Setup page (and the SEO home's setup card). */
const SPRINT_SETUP_KEYS = ["site_project", "gsc_property", "bing_site", "ga4_property", "autopilot"];

const STATUS_WORDS: Record<string, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  needs_reconnect: "Needs reconnecting",
  enabled: "On",
  disabled: "Off",
  error: "Error",
};

export function IntegrationsTab({ companyId, bundle, load, call, reload, onMessage, working }: { companyId: string; bundle: SprintBundle; load: LoadResult; call: CallFn; reload: () => Promise<void>; onMessage: (m: string) => void; working: string | null }) {
  const narrow = useIsNarrow();
  const nav = useHostNavigation();
  const start = usePluginAction("seo.gsc-start");
  const disconnect = usePluginAction("seo.gsc-disconnect");
  const setIntegration = usePluginAction("seo.integration");
  const [properties, setProperties] = useState<Array<{ propertyUrl: string; usable: boolean }> | null>(null);
  const [bingUrl, setBingUrl] = useState("");
  const [ga4Id, setGa4Id] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const gsc = bundle.integrations.find((i) => i.provider === "gsc");
  const pagespeed = bundle.integrations.find((i) => i.provider === "pagespeed");
  const bing = bundle.integrations.find((i) => i.provider === "bing");
  const sprintId = bundle.sprint.sprintId;
  const gscProblem = plainError(gsc?.lastError, "gsc");
  const pagespeedProblem = plainError(pagespeed?.lastError, "pagespeed");
  const bingProblem = plainError(bing?.lastError, "bing");
  // The Google Analytics section is there only where a person switched it on (the worker sends `analytics` only then).
  const analytics = bundle.analytics;
  const ga4Problem = plainError(analytics?.lastError, "ga4");

  useEffect(() => {
    setBingUrl(bing?.propertyUrl ?? bundle.sprint.siteUrl);
  }, [bing?.propertyUrl, bundle.sprint.siteUrl]);

  async function connect() {
    try {
      // Back to this sprint in its own scope (a client's workspace keeps its client).
      const returnTo = sprintPagePath(window.location.pathname, sprintId, parseClientParam(bundle.sprint.client), { tab: "integrations" });
      const result = (await start({ sprintId, returnTo })) as { authorizeUrl: string; state: string };
      rememberOAuthStart(result.state, { companyId, completeUrl: "/api/plugins/partnersinbiz.seo/api/oauth/complete", returnTo, label: "Google Search Console" });
      window.location.assign(result.authorizeUrl);
    } catch (error) {
      onMessage(errorText(error));
    }
  }

  async function loadProperties() {
    const result = (await call("gsc-properties", { sprintId })) as { properties: Array<{ propertyUrl: string; usable: boolean }>; suggested: string | null } | null;
    if (result) setProperties(result.properties);
  }

  /** A person turns an extra on or off (the worker refuses anyone else); the reply says in plain words what changed. */
  async function setExtra(feature: string, enabled: boolean) {
    setSwitching(feature);
    try {
      const result = (await call("set-switch", { sprintId, feature, enabled })) as { note?: string } | null;
      if (result?.note) onMessage(result.note);
    } finally {
      setSwitching(null);
    }
  }

  async function toggle(provider: "pagespeed" | "bing", enabled: boolean) {
    try {
      await setIntegration({ sprintId, provider, enabled, propertyUrl: provider === "bing" ? bingUrl : undefined });
      await reload();
      onMessage(`${provider === "bing" ? "Bing" : "PageSpeed"} checks ${enabled ? "switched on" : "switched off"}.`);
    } catch (error) {
      onMessage(errorText(error));
    }
  }

  const gscLabel = gsc ? `${STATUS_WORDS[gsc.status] ?? gsc.status}${gsc.auth === "service_account" ? " · service account" : gsc.auth === "oauth" ? " · Google sign-in" : ""}` : null;
  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <NeedsYouSection sprintId={sprintId} view={bundle.needsYou} call={call} issueLink={bundle.needsYou?.issueId ? <IssueLink id={bundle.needsYou.issueId} identifier={bundle.needsYou.issueIdentifier} /> : null} />
      {bundle.sprint.site ? <SiteRepoSection sprintId={sprintId} site={bundle.sprint.site} projects={bundle.projects ?? []} wordpressSites={bundle.wordpressSites ?? []} prefix={bundle.prefix} call={call} /> : null}
      <Section title="Extras (off until you turn them on)" icon={Plug}>
        <span style={{ fontSize: 13, color: tokens.muted }}>
          Three optional extras. Each is off for every sprint until a person turns it on here, one sprint at a time: nothing is added, read or scheduled until then, and the agent cannot turn one on.
        </span>
        <ExtrasList states={bundle.extras ?? []} subject="sprint" serviceAccountReady={Boolean(load.settings.serviceAccountEmail)} busy={switching} onSet={setExtra} />
      </Section>
      <SetupChecklist
        title="This sprint's setup"
        items={(bundle.setup ?? []).filter((item) => SPRINT_SETUP_KEYS.includes(item.key))}
        note={<>The company-wide steps (the Google service account, the API keys, the SEO agent) are on the <a {...nav.linkProps("/setup")} style={{ color: tokens.fg }}>Setup page</a>.</>}
      />
      <Section title="Google Search Console" icon={Search} actions={gscLabel ? <Pill tone={statusTone(gsc!.status)} dot>{gscLabel}</Pill> : null}>
        <div style={{ fontSize: 13, display: "grid", gap: 6 }}>
          <span style={{ color: tokens.muted }}>Google's free tool that shows how the site ranks and which pages are indexed. The SEO agent reads it every morning.</span>
          <span style={{ color: tokens.muted, ...breakAnywhere }}>
            {load.settings.serviceAccountEmail
              ? <>Connected through the service account <code style={breakAnywhere}>{load.settings.serviceAccountEmail}</code>: the agent verifies our own sites with it, and a client adds it as a user in their Search Console.</>
              : load.settings.serviceAccountError
                ? "The Google service account key does not work yet (see Setup)."
                : "No Google service account key yet (see Setup)."}
          </span>
          <span style={breakAnywhere}>Site (property): {gsc?.propertyUrl ?? <em style={{ color: tokens.muted }}>none picked yet</em>}</span>
          <span style={{ color: tokens.muted }}>Last update: {gsc?.lastPullAt ? formatDateTime(gsc.lastPullAt) : "never"}</span>
          {gscProblem ? <PlainProblem problem={gscProblem} /> : null}
          {load.settings.serviceAccountError ? <RawDetails raw={load.settings.serviceAccountError} label="Details about the key" /> : null}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {load.settings.serviceAccountEmail ? (
            <Button type="button" variant="secondary" style={small} disabled={working === "gsc-check-access"} onClick={() => void call("gsc-check-access", { sprintId }, "Service account access checked.")}>
              {working === "gsc-check-access" ? "Checking…" : "Check access"}
            </Button>
          ) : null}
          {gsc?.status === "connected" ? (
            <>
              <Button type="button" variant="secondary" style={small} onClick={() => void loadProperties()}>Choose the site</Button>
              <Button type="button" variant="secondary" style={small} disabled={working === "gsc-pull" || !gsc.propertyUrl} onClick={() => void call("gsc-pull", { sprintId }, "Search Console data updated.")}>{working === "gsc-pull" ? "Updating…" : "Update now"}</Button>
              <Button type="button" variant="secondary" style={small} disabled={working === "gsc-submit-sitemap" || !gsc.propertyUrl} onClick={() => void call("gsc-submit-sitemap", { sprintId }, "Sitemap submitted.")}>Submit sitemap</Button>
            </>
          ) : null}
        </div>
        {properties ? (
          <div style={{ display: "grid", gap: 6 }}>
            {properties.length === 0 ? <span style={{ fontSize: 13, color: tokens.muted }}>This Google account has no Search Console sites.</span> : null}
            {properties.map((p) => (
              <div key={p.propertyUrl} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code style={{ fontSize: 12, minWidth: 0, ...breakAnywhere }}>{p.propertyUrl}</code>
                <Button type="button" variant="secondary" style={small} disabled={!p.usable || p.propertyUrl === gsc?.propertyUrl} onClick={() => void call("gsc-set-property", { sprintId, propertyUrl: p.propertyUrl }, "Site picked.").then(() => setProperties(null))}>
                  {p.propertyUrl === gsc?.propertyUrl ? "Picked" : p.usable ? "Use" : "Not verified"}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {load.settings.googleClientId ? (
          <details style={{ fontSize: 12.5 }}>
            <summary style={{ cursor: "pointer", color: tokens.muted, minHeight: 24 }}>Fallback: connect with a Google sign-in</summary>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <span style={{ color: tokens.muted }}>Only for a site the service account cannot reach. A person signs in with the Google account that owns the site in Search Console.</span>
              {load.settings.redirectUri ? <span style={{ color: tokens.muted, ...breakAnywhere }}>Register this redirect address in Google Cloud (Credentials → your web client): <code style={breakAnywhere}>{load.settings.redirectUri}</code></span> : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button type="button" variant="secondary" style={small} onClick={() => void connect()}>{gsc?.auth === "oauth" && gsc.status === "connected" ? "Reconnect with Google" : "Connect with Google"}</Button>
                {gsc?.auth === "oauth" ? <Button type="button" variant="secondary" style={small} onClick={() => { if (window.confirm("Disconnect the Google sign-in for this sprint?")) void disconnect({ sprintId }).then(() => reload()).catch((e: unknown) => onMessage(errorText(e))); }}>Disconnect</Button> : null}
              </div>
            </div>
          </details>
        ) : null}
      </Section>
      <Section title="Page speed (PageSpeed Insights)" icon={Gauge} actions={pagespeed ? <Pill tone={statusTone(pagespeed.status)} dot>{STATUS_WORDS[pagespeed.status] ?? pagespeed.status}</Pill> : null}>
        <span style={{ fontSize: 13, color: tokens.muted }}>
          Google's speed test, every morning on a phone: the home page plus up to 3 pages the plan targets.{" "}
          {load.settings.pagespeedApiKey ? "Uses our PageSpeed API key." : "Without a PageSpeed API key Google allows only a few free checks a day (add one in Setup)."}
        </span>
        {pagespeedProblem ? <PlainProblem problem={pagespeedProblem} /> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" style={small} onClick={() => void toggle("pagespeed", pagespeed?.status !== "enabled")}>{pagespeed?.status === "enabled" ? "Switch off" : "Switch on"}</Button>
          <Button type="button" variant="secondary" style={small} disabled={working === "run-pagespeed"} onClick={() => void call("run-pagespeed", { sprintId }, "Page speed checked.")}>{working === "run-pagespeed" ? "Checking (up to 25 s)…" : "Check the home page now"}</Button>
        </div>
        {bundle.pageHealth.length > 0 ? (
          <>
            <span style={{ fontSize: 12, color: tokens.muted }}>Speed and SEO scores are out of 100. Load time (LCP) should be under 2.5 s, layout shift (CLS) under 0.1 and response (INP) under 200 ms.</span>
            {narrow ? (
              <CompactRows
                rows={bundle.pageHealth.map((h) => ({ ...h, id: `${h.url}-${h.strategy}` }))}
                title={(h) => shortUrl(h.url) || h.url}
                meta={(h: PageHealth) => [`speed ${h.performance == null ? "—" : Math.round(h.performance <= 1 ? h.performance * 100 : h.performance)}`, `loads in ${seconds(h.lcpMs)}`, h.pulledOn ? formatShortDate(h.pulledOn) : null].filter(Boolean).join(" · ")}
                trailing={(h) => scorePill(h.performance)}
                label="Page speed results"
              />
            ) : (
              <DataTable
                columns={[
                  { key: "url", header: "Page", render: (v) => <span style={{ fontSize: 12.5, ...breakAnywhere }}>{shortUrl(String(v)) || String(v)}</span> },
                  { key: "strategy", header: "Device", render: (v) => (v === "mobile" ? "Phone" : "Desktop") },
                  { key: "performance", header: "Speed", render: (v) => scorePill(v as number | null) },
                  { key: "seo", header: "SEO", render: (v) => scorePill(v as number | null) },
                  { key: "lcpMs", header: "Load time (LCP)", render: (v) => seconds(v as number | null) },
                  { key: "cls", header: "Layout shift (CLS)", render: (v) => fmt(v as number | null, 2) },
                  { key: "inpMs", header: "Response (INP)", render: (v) => (v == null ? "—" : `${Math.round(Number(v))} ms`) },
                  { key: "pulledOn", header: "Checked", render: (v) => (v ? formatShortDate(String(v)) : "—") },
                ]}
                rows={bundle.pageHealth.map((h) => ({ ...h, id: `${h.url}-${h.strategy}` }))}
              />
            )}
          </>
        ) : null}
      </Section>
      {analytics ? (
        <Section title="Google Analytics (GA4)" icon={ChartColumn} actions={<Pill tone={analytics.connected ? "ok" : "warn"} dot>{analytics.connected ? "Connected" : "Not connected"}</Pill>}>
          <span style={{ fontSize: 13, color: tokens.muted }}>
            Read only, through the same service account as Search Console. Shows how much organic traffic and how many key events (enquiries, sign-ups, sales) the site gets, and how many landed on the pages this sprint made.{" "}
            {load.settings.serviceAccountEmail ? <>The property's owner adds <code style={breakAnywhere}>{load.settings.serviceAccountEmail}</code> as a Viewer once; the agent then finds the property by the site's address.</> : "It needs the Google service account key first (see Setup)."}
          </span>
          {analytics?.connected ? <span style={{ fontSize: 13, ...breakAnywhere }}>Property {analytics.propertyId} · last update {analytics.lastPullAt ? formatDateTime(analytics.lastPullAt) : "never"}</span> : null}
          {analytics?.summary && analytics.summary.last4.weeks > 0 ? (
            <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
              <span>
                Last {analytics.summary.last4.weeks} weeks: <strong>{formatCompact(analytics.summary.last4.organicSessions)}</strong> organic visits
                {analytics.summary.change.organicSessionsPct != null ? ` (${analytics.summary.change.organicSessionsPct >= 0 ? "+" : ""}${analytics.summary.change.organicSessionsPct}% on the week before)` : ""}
                , <strong>{formatCompact(analytics.summary.last4.organicKeyEvents)}</strong> key events.
              </span>
              {analytics.summary.attribution.sprintPages.count > 0 ? (
                <span style={{ color: tokens.muted }}>
                  {formatCompact(analytics.summary.attribution.sprintPages.organicSessions)} of the organic visits landed on the {analytics.summary.attribution.sprintPages.count} pages this sprint works on.
                </span>
              ) : null}
              {analytics.summary.last4.aiReferralSessions > 0 ? <span style={{ color: tokens.muted }}>{formatCompact(analytics.summary.last4.aiReferralSessions)} visits came from AI assistants.</span> : null}
            </div>
          ) : null}
          {ga4Problem && !analytics?.connected ? <PlainProblem problem={ga4Problem} /> : null}
          {analytics?.lastError ? <RawDetails raw={analytics.lastError} label="Details" /> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Input value={ga4Id} onChange={(e) => setGa4Id(e.target.value)} placeholder={analytics?.propertyId ?? "Property ID (optional)"} style={{ maxWidth: 240, flex: "1 1 160px", minWidth: 0 }} aria-label="GA4 property ID" />
            <Button type="button" variant="secondary" style={small} disabled={working === "connect-ga4" || !load.settings.serviceAccountEmail} onClick={() => void call("connect-ga4", { sprintId, ...(ga4Id.trim() ? { propertyId: ga4Id.trim() } : {}) }, "Google Analytics checked.")}>
              {working === "connect-ga4" ? "Connecting…" : analytics?.connected ? "Update now" : "Connect"}
            </Button>
          </div>
        </Section>
      ) : null}
      <Section title="Bing Webmaster Tools" icon={Share2} actions={bing ? <Pill tone={statusTone(bing.status)} dot>{STATUS_WORDS[bing.status] ?? bing.status}</Pill> : null}>
        <span style={{ fontSize: 13, color: tokens.muted }}>
          Bing's version of Search Console. The agent adds and verifies the site itself, then reads the links pointing to it every day. {load.settings.bingApiKey ? "The Bing API key is set." : "It needs the Bing API key (see Setup)."}
          {typeof bing?.stats?.totalInboundLinks === "number" ? ` Links pointing to the site: ${String(bing.stats.totalInboundLinks)}.` : ""}
        </span>
        {bingProblem ? <PlainProblem problem={bingProblem} /> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Input value={bingUrl} onChange={(e) => setBingUrl(e.target.value)} style={{ maxWidth: 320, flex: "1 1 220px", minWidth: 0 }} aria-label="Site address for Bing" />
          <Button type="button" variant="secondary" style={small} onClick={() => void toggle("bing", bing?.status !== "enabled")}>{bing?.status === "enabled" ? "Switch off" : "Switch on"}</Button>
        </div>
      </Section>
    </div>
  );
}
