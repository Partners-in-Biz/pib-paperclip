import { useEffect, useMemo, useState } from "react";
import { rememberOAuthStart } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { Button, EmptyState, Field, Input, Modal, tokens } from "@partnersinbiz/pib-plugin-ui";
import { COMPLETE_ROUTE_PATH, PLUGIN_ID, type SocialPlatform } from "../platforms.js";
import { AccountStatus, Avatar, Banner, Card, ClientSelect, Code, fmtDate, ignore, Muted, platformLabel, Row, SmallButton } from "./parts.js";
import type { Account, RunAction, Snapshot } from "./types.js";

function expectedRedirect(snapshot: Snapshot): string {
  return snapshot.config.redirectUri ?? `${typeof window !== "undefined" ? window.location.origin : ""}/_plugins/<plugin installation id>/ui/oauth-callback.html`;
}

export function SetupBanners({ snapshot }: { snapshot: Snapshot }) {
  const c = snapshot.config;
  const redirect = expectedRedirect(snapshot);
  if (!c.saved) {
    return (
      <Banner tone="error" title="Social settings are not saved for this company">
        Open Settings → Plugins → Social, fill in the public base URL and the token encryption key, then Save. Scheduled jobs cannot act for this company until the settings are saved.
        Register this redirect URI with every provider: <Code>{redirect}</Code>
      </Banner>
    );
  }
  return (
    <>
      {c.publicBaseUrlError ? (
        <Banner tone="error" title="Public base URL is missing or invalid">
          {c.publicBaseUrlError} Once it is set, the redirect URI to register with every provider is <Code>{redirect}</Code>.
        </Banner>
      ) : null}
      {!c.encryptionKey ? (
        <Banner tone="error" title="Token encryption key is not set">
          Add a long random value as the token encryption key in the Social settings. Accounts cannot be connected without it.
        </Banner>
      ) : null}
    </>
  );
}

export async function startConnect(
  run: RunAction,
  companyId: string,
  platform: SocialPlatform,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const result = (await run("social.oauth-start", { platform, ...extra })) as { authorizeUrl?: string; state?: string; label?: string } | undefined;
  if (!result?.authorizeUrl || !result.state) throw new Error("The connection could not start");
  rememberOAuthStart(result.state, {
    companyId,
    completeUrl: COMPLETE_ROUTE_PATH,
    returnTo: window.location.href,
    label: result.label ?? platformLabel(platform),
  });
  window.location.assign(result.authorizeUrl);
}

export function PickerModal({ pickerId, snapshot, run, onClose, onDone }: {
  pickerId: string;
  snapshot: Snapshot;
  run: RunAction;
  onClose: () => void;
  onDone: (connected: number) => void;
}) {
  const [data, setData] = useState<{
    label: string;
    clientRef: string | null;
    options: Array<{ key: string; platform: string; kind: string; displayName: string; handle: string | null; avatarUrl: string | null; alreadyConnected: boolean; detail: string | null }>;
  } | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clientRef, setClientRef] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    run("social.oauth-pending", { pickerId })
      .then((res) => {
        if (cancelled) return;
        const value = res as typeof data;
        setData(value);
        setClientRef(value?.clientRef ?? "");
        setSelected(new Set((value?.options ?? []).filter((o) => o.alreadyConnected).map((o) => o.key)));
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [pickerId]);

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <Modal
      open
      title={data ? `Choose ${data.label} accounts` : "Choose accounts"}
      description="Each account you pick is added separately with its own token. Already connected accounts are refreshed."
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={async () => {
              setBusy(true);
              try {
                const res = (await run("social.oauth-confirm", { pickerId, selections: [...selected], clientRef: clientRef || null })) as { connected?: number };
                onDone(res?.connected ?? selected.size);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Adding…" : `Add ${selected.size || ""} account${selected.size === 1 ? "" : "s"}`}
          </Button>
        </>
      )}
    >
      {error ? <Banner tone="error" title="Could not load the choices">{error}</Banner> : null}
      {!data && !error ? <Muted>Loading…</Muted> : null}
      {data ? (
        <>
          <div style={{ display: "grid", gap: 6, maxHeight: 320, overflow: "auto" }}>
            {data.options.map((option) => (
              <label key={option.key} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", borderRadius: 10, border: `1px solid ${tokens.border}`, cursor: "pointer" }}>
                <input type="checkbox" checked={selected.has(option.key)} onChange={() => toggle(option.key)} />
                <Avatar url={option.avatarUrl} label={option.displayName} />
                <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                  <strong style={{ fontSize: 13 }}>{option.displayName}</strong>
                  <Muted>
                    {platformLabel(option.platform)} · {option.kind.replace(/_/g, " ")}
                    {option.handle ? ` · ${option.handle}` : ""}
                    {option.detail ? ` · ${option.detail}` : ""}
                    {option.alreadyConnected ? " · already connected" : ""}
                  </Muted>
                </span>
              </label>
            ))}
          </div>
          <Field label="Client for these accounts">
            <ClientSelect clients={snapshot.clients} value={clientRef} onChange={setClientRef} allLabel="No client" />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}

function BlueskyModal({ snapshot, run, account, onClose, onDone }: {
  snapshot: Snapshot;
  run: RunAction;
  account: Account | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [identifier, setIdentifier] = useState(account?.handle ?? "");
  const [appPassword, setAppPassword] = useState("");
  const [pdsUrl, setPdsUrl] = useState("");
  const [clientRef, setClientRef] = useState(account?.clientRef ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      title={account ? "Reconnect Bluesky" : "Connect Bluesky"}
      description="Create an app password in Bluesky (Settings → Privacy and security → App passwords). Your main password is never used."
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            disabled={busy || !identifier || !appPassword}
            onClick={async () => {
              setBusy(true);
              try {
                await run("social.connect-bluesky", { identifier, appPassword, pdsUrl: pdsUrl || undefined, clientRef: clientRef || undefined }, "Bluesky connected");
                onDone();
              } catch {
                // shown by run()
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </>
      )}
    >
      <Field label="Handle"><Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="you.bsky.social" autoComplete="username" /></Field>
      <Field label="App password"><Input type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} placeholder="xxxx-xxxx-xxxx-xxxx" autoComplete="off" /></Field>
      <Field label="PDS URL (optional)"><Input value={pdsUrl} onChange={(e) => setPdsUrl(e.target.value)} placeholder={snapshot.config.blueskyDefaultPds} /></Field>
      <Field label="Client"><ClientSelect clients={snapshot.clients} value={clientRef} onChange={setClientRef} allLabel="No client" /></Field>
    </Modal>
  );
}

function EditAccountModal({ account, snapshot, run, onClose }: { account: Account; snapshot: Snapshot; run: RunAction; onClose: () => void }) {
  const [clientRef, setClientRef] = useState(account.clientRef ?? "");
  const [subreddit, setSubreddit] = useState(account.defaultSubreddit ?? "");
  const [boardId, setBoardId] = useState(account.boardId ?? "");
  return (
    <Modal
      open
      title={`Edit ${account.displayName}`}
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            onClick={async () => {
              const params: Record<string, unknown> = { accountId: account.id, clientRef: clientRef || null };
              if (account.platform === "reddit") params.defaultSubreddit = subreddit || null;
              if (account.platform === "pinterest") params.boardId = boardId || null;
              try {
                await run("social.update-account", params, "Account updated");
                onClose();
              } catch {
                // shown by run()
              }
            }}
          >
            Save
          </Button>
        </>
      )}
    >
      <Field label="Client"><ClientSelect clients={snapshot.clients} value={clientRef} onChange={setClientRef} allLabel="No client" /></Field>
      {account.platform === "reddit" ? (
        <Field label="Default subreddit"><Input value={subreddit} onChange={(e) => setSubreddit(e.target.value)} placeholder="smallbusiness" /></Field>
      ) : null}
      {account.platform === "pinterest" ? (
        <Field label="Board id"><Input value={boardId} onChange={(e) => setBoardId(e.target.value)} placeholder={account.boardId ?? ""} /></Field>
      ) : null}
    </Modal>
  );
}

export function AccountsTab({ snapshot, companyId, run, clientFilter }: {
  snapshot: Snapshot;
  companyId: string;
  run: RunAction;
  clientFilter: string;
}) {
  const [connectClient, setConnectClient] = useState("");
  const [mastodonInstance, setMastodonInstance] = useState(snapshot.config.mastodonDefaultInstance ?? "https://mastodon.social");
  const [redditSubreddit, setRedditSubreddit] = useState("");
  const [bluesky, setBluesky] = useState<{ account: Account | null } | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [busy, setBusy] = useState("");
  const ready = snapshot.config.saved && !snapshot.config.publicBaseUrlError && snapshot.config.encryptionKey;

  const accounts = useMemo(
    () => snapshot.accounts.filter((a) => !clientFilter || (clientFilter === "__none" ? !a.clientRef : a.clientRef === clientFilter)),
    [snapshot.accounts, clientFilter],
  );

  async function connect(platform: SocialPlatform, extra: Record<string, unknown> = {}) {
    setBusy(platform);
    try {
      await startConnect(run, companyId, platform, { clientRef: connectClient || undefined, ...extra });
    } catch {
      // run() already showed the error
    } finally {
      setBusy("");
    }
  }

  async function reconnect(account: Account) {
    if (account.platform === "bluesky") {
      setBluesky({ account });
      return;
    }
    await connect(account.platform, {
      reconnectAccountId: account.id,
      ...(account.platform === "mastodon" && account.instanceUrl ? { instanceUrl: account.instanceUrl } : {}),
    });
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <SetupBanners snapshot={snapshot} />
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <strong style={{ fontSize: 13 }}>Connect an account</strong>
          <Row>
            <Muted>New accounts belong to</Muted>
            <ClientSelect clients={snapshot.clients} value={connectClient} onChange={setConnectClient} allLabel="No client" />
          </Row>
        </Row>
        <Muted>
          Redirect URI to register with every provider: <Code>{expectedRedirect(snapshot)}</Code>
        </Muted>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
          {snapshot.platforms.map((p) => {
            const disabled = !ready || (p.mode === "oauth" && !p.configured) || busy !== "";
            const hint = !ready
              ? "Save the settings first"
              : p.mode === "oauth" && !p.configured
                ? p.platform === "instagram"
                  ? "Connect Facebook to add linked Instagram accounts, or add the Instagram app in settings"
                  : `Add ${p.missing.map((m) => m.split(".").pop()).join(" and ")} in settings`
                : p.mode === "credentials"
                  ? "Handle + app password"
                  : p.mode === "instance"
                    ? "Any Mastodon instance"
                    : p.platform === "facebook"
                      ? "Pages and linked Instagram"
                      : "OAuth";
            return (
              <div key={p.platform} style={{ display: "grid", gap: 6, padding: 10, borderRadius: 10, border: `1px solid ${tokens.border}` }}>
                <Row style={{ justifyContent: "space-between" }}>
                  <strong style={{ fontSize: 13 }}>{p.label}</strong>
                  <SmallButton
                    disabled={disabled}
                    onClick={() => {
                      if (p.mode === "credentials") setBluesky({ account: null });
                      else if (p.mode === "instance") void connect(p.platform, { instanceUrl: mastodonInstance });
                      else if (p.platform === "reddit") void connect(p.platform, { defaultSubreddit: redditSubreddit || undefined });
                      else void connect(p.platform);
                    }}
                  >
                    {busy === p.platform ? "Opening…" : "Connect"}
                  </SmallButton>
                </Row>
                <Muted>{hint}</Muted>
                {p.mode === "instance" ? (
                  <Input value={mastodonInstance} onChange={(e) => setMastodonInstance(e.target.value)} placeholder="https://mastodon.social" style={{ height: 30, fontSize: 12 }} />
                ) : null}
                {p.platform === "reddit" ? (
                  <Input value={redditSubreddit} onChange={(e) => setRedditSubreddit(e.target.value)} placeholder="Default subreddit (optional)" style={{ height: 30, fontSize: 12 }} />
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>

      {accounts.length === 0 ? (
        <EmptyState title="No accounts yet" description="Connect a platform above. Facebook lets you pick several Pages and their Instagram accounts at once." />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {accounts.map((account) => {
            const canRefresh = account.connected && !["bluesky", "mastodon", "dribbble"].includes(account.platform);
            return (
              <Card key={account.id} style={{ gap: 8 }}>
                <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <Row style={{ minWidth: 0, flex: "1 1 320px" }}>
                    <Avatar url={account.avatarUrl} label={account.displayName} />
                    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <strong style={{ fontSize: 13 }}>{account.displayName}</strong>
                      <Muted>
                        {platformLabel(account.platform)}
                        {account.kind ? ` · ${account.kind.replace(/_/g, " ")}` : ""}
                        {account.handle ? ` · ${account.handle}` : ""}
                        {account.boardName ? ` · board ${account.boardName}` : ""}
                        {account.defaultSubreddit ? ` · r/${account.defaultSubreddit}` : ""}
                        {account.pageName ? ` · via ${account.pageName}` : ""}
                      </Muted>
                      <Muted>
                        Client: {account.clientName ?? "none"} · Token {account.tokenExpiresAt ? `expires ${fmtDate(account.tokenExpiresAt, snapshot.config.timezone, false)}` : "does not expire"}
                      </Muted>
                    </div>
                  </Row>
                  <AccountStatus status={account.status} />
                </Row>
                {account.lastError ? <Muted style={{ color: account.status === "connected" ? tokens.muted : "var(--destructive)" }}>{account.lastError}</Muted> : null}
                <Row>
                  <SmallButton disabled={!ready || busy !== ""} onClick={() => void reconnect(account)}>Reconnect</SmallButton>
                  {canRefresh ? <SmallButton onClick={() => run("social.refresh-account", { accountId: account.id }, "Token refreshed").catch(ignore)}>Refresh token</SmallButton> : null}
                  <SmallButton onClick={() => setEditing(account)}>Edit</SmallButton>
                  {account.status !== "disabled" ? (
                    <SmallButton
                      onClick={() => {
                        if (window.confirm(`Disconnect ${account.displayName}? Its tokens are removed; publishing history stays.`)) {
                          run("social.disconnect-account", { accountId: account.id }, "Account disconnected").catch(ignore);
                        }
                      }}
                    >
                      Disconnect
                    </SmallButton>
                  ) : null}
                </Row>
              </Card>
            );
          })}
        </div>
      )}

      {bluesky ? (
        <BlueskyModal snapshot={snapshot} run={run} account={bluesky.account} onClose={() => setBluesky(null)} onDone={() => setBluesky(null)} />
      ) : null}
      {editing ? <EditAccountModal account={editing} snapshot={snapshot} run={run} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

