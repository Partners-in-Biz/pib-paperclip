import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, EmptyState, Plug, tokens } from "@partnersinbiz/pib-plugin-ui";
import { type SocialPlatform } from "../platforms.js";
import { AccountStatus, Banner, Card, fmtDate, Muted, PlatformBadge, platformLabel, Row, SmallButton } from "./parts.js";
import type { Account, Post, RunAction, Snapshot } from "./types.js";
import { startConnect } from "./accounts.js";
import { QueueTab } from "./my-social-queue.js";
import { CalendarTab } from "./my-social-calendar.js";

type TabId = "accounts" | "queue" | "calendar";

/**
 * Personal social page: personal accounts, draft queue, and calendar.
 * Only personal accounts and posts are shown (via my-social.* data).
 */
export function MySocialPage({ snapshot, run }: { snapshot: Snapshot; run: RunAction }) {
  const [tab, setTab] = useState<TabId>("accounts");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      // Load personal accounts and posts
      const [accountsData, postsData] = await Promise.all([
        run("my-social.accounts", {}),
        run("my-social.posts", {}),
      ]);
      setAccounts((accountsData as Account[]) || []);
      setPosts((postsData as Post[]) || []);
      setError("");
    } catch (e) {
      setError(`Failed to load: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div style={{ display: "grid", gap: 16, padding: 16 }}>
        <Banner tone="error" title="Failed to load personal accounts">
          {error}
        </Banner>
      </div>
    );
  }

  if (loading) {
    return <p style={{ margin: 0, fontSize: 13 }}>Loading your social accounts…</p>;
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Banner tone="info" title="Personal accounts only">
        Only you can see this. These accounts are separate from company accounts.
      </Banner>
      <Tabs
        tabs={[
          { id: "accounts", label: "Accounts" },
          { id: "queue", label: "Queue" },
          { id: "calendar", label: "Calendar" },
        ]}
        active={tab}
        onChange={(id) => setTab(id as TabId)}
      />
      {tab === "accounts" ? <AccountsTab accounts={accounts} snapshot={snapshot} run={run} onRefresh={load} /> : null}
      {tab === "queue" ? <QueueTab posts={posts} snapshot={snapshot} run={run} onRefresh={load} /> : null}
      {tab === "calendar" ? <CalendarTab posts={posts} snapshot={snapshot} /> : null}
    </div>
  );
}

/** List personal accounts with connect/disconnect. */
function AccountsTab({ accounts, snapshot, run, onRefresh }: { accounts: Account[]; snapshot: Snapshot; run: RunAction; onRefresh: () => Promise<void> }) {
  const [connecting, setConnecting] = useState<SocialPlatform | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const handleConnect = async (platform: SocialPlatform) => {
    try {
      setConnecting(platform);
      // For personal accounts, use the company ID context if available
      // The backend will know this is a personal account request via the action
      await startConnect(run, "", platform);
    } catch (e) {
      // Error is already shown by startConnect
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!window.confirm("Disconnect this account? You won't lose any posts.")) return;
    try {
      setDisconnecting(accountId);
      await run("my-social.disconnect-account", { accountId }, "Account disconnected");
      await onRefresh();
    } catch (e) {
      // Error already shown
    } finally {
      setDisconnecting(null);
    }
  };

  // Platforms that can be connected
  const supported: SocialPlatform[] = ["x", "linkedin"];
  const platformsToShow = supported.filter((p) => !accounts.some((a) => a.platform === p));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {accounts.length === 0 && platformsToShow.length > 0 ? (
        <EmptyState
          icon={Plug}
          tone="info"
          title="No personal accounts yet"
          description="Connect your social accounts to draft and schedule posts."
        />
      ) : null}

      {accounts.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          {accounts.map((account) => (
            <Card key={account.id} style={{ gap: 12 } as any}>
              <Row style={{ justifyContent: "space-between" }}>
                <Row>
                  <PlatformBadge platform={account.platform} size={32} />
                  <div style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{platformLabel(account.platform)}</div>
                    <div style={{ fontSize: 12, color: tokens.muted }}>
                      {account.displayName}
                      {account.handle ? ` (@${account.handle})` : ""}
                    </div>
                  </div>
                </Row>
                <AccountStatus status={account.status} />
              </Row>

              {account.status === "needs_reconnect" ? (
                <Banner tone="error" title="Needs reconnect">
                  Your token expired. Please reconnect to resume posting.
                </Banner>
              ) : null}

              {account.tokenExpiresAt ? (
                <Muted>
                  Token expires {fmtDate(account.tokenExpiresAt, snapshot.config.timezone)}
                </Muted>
              ) : null}

              <Row>
                {account.status === "needs_reconnect" ? (
                  <Button
                    type="button"
                    style={{ height: 28, fontSize: 12 }}
                    onClick={() => handleConnect(account.platform)}
                    disabled={connecting === account.platform}
                  >
                    Reconnect
                  </Button>
                ) : null}
                <SmallButton
                  onClick={() => handleDisconnect(account.id)}
                  disabled={disconnecting === account.id}
                >
                  Disconnect
                </SmallButton>
              </Row>
            </Card>
          ))}
        </div>
      ) : null}

      {platformsToShow.length > 0 ? (
        <Card style={{ gap: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Connect an account</div>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            {platformsToShow.map((platform) => (
              <Button
                key={platform}
                type="button"
                variant="secondary"
                onClick={() => handleConnect(platform)}
                disabled={connecting === platform}
                style={{ height: 36, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              >
                <PlatformBadge platform={platform} size={20} />
                {platformLabel(platform)}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Section({ title, count, tone: t, children }: { title: string; count: number; tone?: "bad"; children: ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          {title}
          {count ? <Muted> ({count})</Muted> : null}
        </h3>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function Tabs({ tabs, active, onChange }: { tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 16, borderBottom: `1px solid ${tokens.border}`, paddingBottom: 8 }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: "4px 0",
            fontSize: 14,
            fontWeight: active === tab.id ? 600 : 500,
            color: active === tab.id ? tokens.fg : tokens.muted,
            borderBottom: active === tab.id ? `2px solid ${tokens.primary}` : "none",
            paddingBottom: 8,
            marginBottom: -16,
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export { Section };
