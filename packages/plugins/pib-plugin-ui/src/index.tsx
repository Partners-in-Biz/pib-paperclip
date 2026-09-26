import {
  useEffect,
  useId,
  useInsertionEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FormEvent,
  type InputHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

/** Host theme tokens — same CSS variables Paperclip uses in the board UI. */
export const tokens = {
  border: "var(--border)",
  card: "var(--card)",
  bg: "var(--background)",
  fg: "var(--foreground)",
  muted: "var(--muted-foreground)",
  accent: "var(--accent)",
  primary: "var(--primary)",
  primaryFg: "var(--primary-foreground)",
  destructive: "var(--destructive)",
  input: "var(--input)",
  ring: "var(--ring)",
  secondary: "var(--secondary)",
  secondaryFg: "var(--secondary-foreground)",
  chart: ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"],
};

const font = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

const focusRing: CSSProperties = {
  outline: "none",
  boxShadow: `0 0 0 2px ${tokens.bg}, 0 0 0 4px ${tokens.ring}`,
};

const fieldBase: CSSProperties = {
  height: 36,
  borderRadius: 8,
  border: `1px solid ${tokens.input}`,
  background: tokens.bg,
  color: tokens.fg,
  padding: "0 10px",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  minWidth: 0,
  maxWidth: "100%",
  transition: "border-color 120ms ease, box-shadow 120ms ease",
};

// ── Mobile support ──────────────────────────────────────────────────────────

/** Phones (and very narrow windows). Pages, dialogs and sheets switch layout below this width. */
export const NARROW_QUERY = "(max-width: 640px)";

function subscribeMedia(query: string) {
  return (onChange: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
    const list = window.matchMedia(query);
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  };
}

function mediaMatches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

const mediaSubscribers = new Map<string, (onChange: () => void) => () => void>();

/** True while `query` matches (default: a phone-sized viewport). False where `matchMedia` is missing (tests, SSR). */
export function useMediaQuery(query: string): boolean {
  let subscribe = mediaSubscribers.get(query);
  if (!subscribe) {
    subscribe = subscribeMedia(query);
    mediaSubscribers.set(query, subscribe);
  }
  return useSyncExternalStore(subscribe, () => mediaMatches(query), () => false);
}

/** True on a phone-sized viewport (`max-width: 640px`). */
export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

/** For URLs, ids, keys, email addresses and other long strings without spaces. */
export const breakAnywhere: CSSProperties = { overflowWrap: "anywhere", wordBreak: "break-word" };

/** Grid template for one column that may shrink below its content (a plain `display: grid` column never does). */
export const oneColumn = "minmax(0, 1fr)";

/** `repeat(auto-fill|auto-fit, minmax(<min>, 1fr))` that never forces a column wider than its container. */
export function fluidColumns(min: number, mode: "auto-fill" | "auto-fit" = "auto-fit"): string {
  return `repeat(${mode}, minmax(min(${min}px, 100%), 1fr))`;
}

const STYLE_ID = "pib-plugin-ui-base";
const TEXT_INPUTS = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color])";

/**
 * Base rules for everything inside `.pib-ui` (pages, dialogs, sheets). `:where()` keeps them at zero
 * specificity, so any inline style still wins. They stop wide content from stretching the page on a
 * phone: boxes may shrink below their content, long words wrap, media and fields never exceed their box.
 */
const BASE_CSS = `
.pib-ui{min-width:0;max-width:100%;overflow-wrap:break-word;-webkit-text-size-adjust:100%;text-size-adjust:100%}
.pib-ui,.pib-ui *,.pib-ui *::before,.pib-ui *::after{box-sizing:border-box}
.pib-ui :where(div,section,article,aside,header,footer,main,nav,form,fieldset,label,ul,ol,li,dl,dt,dd,p,h1,h2,h3,h4,h5,h6,span,strong,em,small,a,code,figure,blockquote,details,summary){min-width:0}
.pib-ui :where(img,video,canvas,iframe,svg){max-width:100%}
.pib-ui :where(input,select,textarea){max-width:100%}
.pib-ui :where(pre){max-width:100%;overflow-x:auto}
.pib-ui :where(table){border-collapse:collapse}
.pib-scroll-x{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;max-width:100%;min-width:0}
.pib-span-first > :first-child{grid-column:1 / -1}
.pib-tabs{scrollbar-width:none;-ms-overflow-style:none}
.pib-tabs::-webkit-scrollbar{display:none}
@media ${NARROW_QUERY}{
  .pib-ui :where(${TEXT_INPUTS},select,textarea){font-size:16px !important}
}
@media (pointer:coarse){
  .pib-ui :where(button,[role=tab],select,${TEXT_INPUTS}){min-height:40px}
  .pib-ui :where(input[type=checkbox],input[type=radio]){width:20px;height:20px}
  .pib-tabs > :where(a,button){min-height:40px}
}
`;

/**
 * Adds the shared base rules (see `BASE_CSS`) to the document once. Page, PageFrame, Modal, Sheet and
 * NewTaskDialog call it; call it yourself in a custom page root that has `className="pib-ui"`.
 */
export function usePibBaseStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = BASE_CSS;
    document.head.appendChild(el);
  }, []);
}

/**
 * Horizontal scroller for tables, week grids and anything else wider than a phone. The page stays put;
 * only this box scrolls sideways.
 */
export function ScrollX({ children, style, label, minWidth }: {
  children: ReactNode;
  style?: CSSProperties;
  /** Accessible name; also makes the scroller focusable with the keyboard. */
  label?: string;
  /** Width the content keeps before it starts to scroll, e.g. `640`. */
  minWidth?: number | string;
}) {
  return (
    <div
      className="pib-scroll-x"
      role={label ? "region" : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
      style={{ overflowX: "auto", overflowY: "hidden", maxWidth: "100%", minWidth: 0, WebkitOverflowScrolling: "touch", ...style }}
    >
      {minWidth !== undefined ? <div style={{ minWidth }}>{children}</div> : children}
    </div>
  );
}

/**
 * A grid with a fixed desktop template (e.g. a line editor `"3fr 70px 120px 150px auto"`) that turns into
 * `narrowColumns` equal columns on a phone. `spanFirst` gives the first child (say, the description) a full row there.
 */
export function ResponsiveGrid({ columns, narrowColumns = 1, spanFirst = false, gap = 10, alignItems, style, children }: {
  columns: string;
  narrowColumns?: number;
  spanFirst?: boolean;
  gap?: number;
  alignItems?: CSSProperties["alignItems"];
  style?: CSSProperties;
  children: ReactNode;
}) {
  usePibBaseStyles();
  const narrow = useIsNarrow();
  return (
    <div
      className={narrow && spanFirst ? "pib-span-first" : undefined}
      style={{ display: "grid", gridTemplateColumns: narrow ? `repeat(${narrowColumns}, minmax(0, 1fr))` : columns, gap, alignItems, minWidth: 0, ...style }}
    >
      {children}
    </div>
  );
}

/**
 * The page root every PiB plugin page uses (`Page` wraps it). Full width on a phone (the host already
 * pads the screen), one shrinkable grid column, and the shared base rules.
 */
export function PageFrame({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  usePibBaseStyles();
  const narrow = useIsNarrow();
  return (
    <main
      className="pib-ui"
      style={{
        fontFamily: font,
        color: tokens.fg,
        padding: narrow ? "4px 0 calc(24px + env(safe-area-inset-bottom, 0px))" : 28,
        maxWidth: 1160,
        width: "100%",
        minWidth: 0,
        display: "grid",
        gridTemplateColumns: oneColumn,
        gap: narrow ? 16 : 22,
        ...style,
      }}
    >
      {children}
    </main>
  );
}

/** The status line a page shows under its header. */
export function PageMessage({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="status"
      style={{
        margin: 0,
        fontSize: 13,
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${tokens.border}`,
        background: tokens.secondary,
        color: tokens.secondaryFg,
        lineHeight: 1.45,
        overflowWrap: "anywhere",
      }}
    >
      {message}
    </p>
  );
}

export function Page({ title, description, children, message, actions }: {
  title: string;
  description: string;
  children: ReactNode;
  message?: string;
  actions?: ReactNode;
}) {
  return (
    <PageFrame>
      <PageHeader title={title} description={description} actions={actions} />
      <PageMessage message={message} />
      {children}
    </PageFrame>
  );
}

export function PageHeader({ title, description, actions }: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  const narrow = useIsNarrow();
  return (
    <header style={{ display: "flex", gap: narrow ? 12 : 16, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", minWidth: 0 }}>
      <div style={{ display: "grid", gap: 5, minWidth: 0, flex: "1 1 320px", maxWidth: "100%" }}>
        <h1 style={{ margin: 0, fontSize: narrow ? 22 : 24, fontWeight: 650, letterSpacing: "-0.025em", lineHeight: 1.2, overflowWrap: "anywhere" }}>{title}</h1>
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.5, maxWidth: 640 }}>{description}</p>
      </div>
      {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}>{actions}</div> : null}
    </header>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  const narrow = useIsNarrow();
  return (
    <section style={{
      display: "grid",
      gridTemplateColumns: oneColumn,
      gap: 14,
      padding: narrow ? 14 : 18,
      borderRadius: 14,
      border: `1px solid ${tokens.border}`,
      background: tokens.card,
      boxShadow: "0 1px 2px color-mix(in oklab, black 4%, transparent)",
      minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 650, letterSpacing: "0.06em", textTransform: "uppercase", color: tokens.muted }}>
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * A row of tabs. It never wraps: on a narrow screen it scrolls sideways (no visible scrollbar) and keeps
 * the selected tab in view.
 */
export function Tabs({ tabs, active, onChange }: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
}) {
  usePibBaseStyles();
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    const tab = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return;
    const left = tab.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft) row.scrollLeft = Math.max(left - 16, 0);
    else if (left + tab.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = left + tab.offsetWidth - row.clientWidth + 16;
  }, [active, tabs.length]);
  return (
    <div
      ref={rowRef}
      role="tablist"
      className="pib-tabs"
      style={{
        display: "flex",
        flexWrap: "nowrap",
        gap: 2,
        // An inset line instead of a border: a scroll box would clip the selected tab's underline.
        boxShadow: `inset 0 -1px 0 ${tokens.border}`,
        overflowX: "auto",
        overflowY: "hidden",
        WebkitOverflowScrolling: "touch",
        overscrollBehaviorX: "contain",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            style={{
              appearance: "none",
              border: "none",
              background: "transparent",
              color: selected ? tokens.fg : tokens.muted,
              fontSize: 13,
              fontWeight: selected ? 600 : 500,
              padding: "9px 14px",
              cursor: "pointer",
              borderBottom: selected ? `2px solid ${tokens.fg}` : "2px solid transparent",
              fontFamily: "inherit",
              transition: "color 120ms ease",
              borderRadius: "8px 8px 0 0",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** The pages that make up a client's workspace, in tab order. */
export const CLIENT_WORKSPACE_TABS = [
  { id: "overview", label: "Overview", path: "/crm" },
  { id: "social", label: "Social", path: "/social" },
  { id: "seo", label: "SEO", path: "/seo" },
  { id: "campaigns", label: "Campaigns", path: "/campaigns" },
  { id: "billing", label: "Billing", path: "/billing" },
] as const;

export type ClientWorkspaceTab = (typeof CLIENT_WORKSPACE_TABS)[number]["id"];

type LinkPropsFn = (to: string) => { href?: string; onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void };

/**
 * Header shown on every PiB plugin page while it works for a client
 * (`?client=company:<id>` or `?client=contact:<id>`). Each tab is a different
 * plugin's page, so the links carry the client param across plugins.
 * Pass the host's `useHostNavigation().linkProps`.
 */
export function ClientWorkspaceBar({ client, active, linkProps, ownPath, ownLabel = "Own work", actions }: {
  client: { kind: "company" | "contact"; id: string; name: string; detail?: string | null };
  active: ClientWorkspaceTab;
  linkProps: LinkPropsFn;
  /** Where "Own work" goes, e.g. `/social`. Defaults to the active tab's page without a client. */
  ownPath?: string;
  ownLabel?: string;
  actions?: ReactNode;
}) {
  const param = encodeURIComponent(`${client.kind}:${client.id}`);
  const activePath = CLIENT_WORKSPACE_TABS.find((tab) => tab.id === active)?.path ?? "/crm";
  const own = linkProps(ownPath ?? (active === "overview" ? "/crm" : activePath));
  usePibBaseStyles();
  const initials = client.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?";
  return (
    <header style={{ display: "grid", gridTemplateColumns: oneColumn, gap: 14, minWidth: 0 }}>
      <a {...own} style={{ fontSize: 12.5, color: tokens.muted, textDecoration: "none", width: "fit-content", minHeight: 24, display: "inline-flex", alignItems: "center" }}>
        ← {active === "overview" ? "All CRM" : ownLabel}
      </a>
      <div style={{ display: "flex", gap: 14, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0, flex: "1 1 260px" }}>
          <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: client.kind === "contact" ? 999 : 10, display: "grid", placeItems: "center", background: tokens.secondary, color: tokens.secondaryFg, fontWeight: 650, fontSize: 14, flexShrink: 0 }}>
            {initials}
          </span>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 650, letterSpacing: "-0.01em", color: tokens.fg, overflowWrap: "anywhere" }}>{client.name}</h1>
            <p style={{ margin: "2px 0 0", fontSize: 12.5, color: tokens.muted, overflowWrap: "anywhere" }}>
              {client.kind === "company" ? "Client company" : "Client contact"}{client.detail ? ` · ${client.detail}` : ""}
            </p>
          </div>
        </div>
        {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}>{actions}</div> : null}
      </div>
      <nav
        aria-label="Client workspace"
        className="pib-tabs"
        style={{ display: "flex", flexWrap: "nowrap", gap: 2, boxShadow: `inset 0 -1px 0 ${tokens.border}`, overflowX: "auto", overflowY: "hidden", WebkitOverflowScrolling: "touch", minWidth: 0, maxWidth: "100%" }}
      >
        {CLIENT_WORKSPACE_TABS.map((tab) => {
          const selected = tab.id === active;
          const link = linkProps(`${tab.path}?client=${param}`);
          return (
            <a
              key={tab.id}
              {...link}
              aria-current={selected ? "page" : undefined}
              style={{
                color: selected ? tokens.fg : tokens.muted,
                fontSize: 13,
                fontWeight: selected ? 600 : 500,
                padding: "9px 14px",
                textDecoration: "none",
                whiteSpace: "nowrap",
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                borderBottom: selected ? `2px solid ${tokens.fg}` : "2px solid transparent",
              }}
            >
              {tab.label}
            </a>
          );
        })}
      </nav>
    </header>
  );
}

export function Toolbar({ children, search, onSearchChange, searchPlaceholder = "Search…" }: {
  children?: ReactNode;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between", minWidth: 0 }}>
      {onSearchChange ? (
        <Input
          aria-label="Search"
          value={search ?? ""}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          style={{ minWidth: 0, flex: "1 1 220px" }}
        />
      ) : <div />}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}>{children}</div>
    </div>
  );
}

export function EmptyState({ title, description, action }: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: oneColumn,
      gap: 10,
      placeItems: "center",
      textAlign: "center",
      padding: "44px 20px",
      borderRadius: 14,
      border: `1px dashed ${tokens.border}`,
      background: tokens.bg,
    }}>
      <div style={{
        width: 40,
        height: 40,
        borderRadius: 12,
        display: "grid",
        placeItems: "center",
        background: tokens.secondary,
        color: tokens.muted,
        fontSize: 18,
      }} aria-hidden="true">◇</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      {description ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted, maxWidth: 380, lineHeight: 1.5, overflowWrap: "anywhere" }}>{description}</p> : null}
      {action}
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: fluidColumns(140), gap: 12, minWidth: 0 }}>
      {children}
    </div>
  );
}

export function BarChart({ title, items }: {
  title: string;
  items: Array<{ label: string; value: number; color?: string }>;
}) {
  const max = Math.max(...items.map((item) => item.value), 1);
  return (
    <div style={{
      display: "grid",
      gap: 12,
      padding: 16,
      borderRadius: 14,
      border: `1px solid ${tokens.border}`,
      background: tokens.card,
      boxShadow: "0 1px 2px color-mix(in oklab, black 4%, transparent)",
    }}>
      <div style={{ fontSize: 12, fontWeight: 650, color: tokens.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {title}
      </div>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No data yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {items.map((item, index) => (
            <div key={item.label} style={{ display: "grid", gap: 5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.label}</span>
                <span style={{ color: tokens.muted, fontVariantNumeric: "tabular-nums" }}>{item.value}</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: tokens.secondary, overflow: "hidden" }}>
                <div style={{
                  width: `${Math.max((item.value / max) * 100, item.value > 0 ? 4 : 0)}%`,
                  height: "100%",
                  background: item.color ?? tokens.chart[index % tokens.chart.length],
                  borderRadius: 999,
                  transition: "width 300ms ease",
                }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PipelineBoard({ columns }: {
  columns: Array<{ id: string; title: string; meta?: string; children: ReactNode }>;
}) {
  return (
    <div className="pib-scroll-x" style={{
      display: "grid",
      gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(190px, 1fr))`,
      gap: 12,
      overflowX: "auto",
      WebkitOverflowScrolling: "touch",
      maxWidth: "100%",
      minWidth: 0,
      paddingBottom: 4,
      scrollSnapType: "x proximity",
    }}>
      {columns.map((column) => (
        <div key={column.id} style={{
          display: "grid",
          gap: 10,
          alignContent: "start",
          minWidth: 190,
          scrollSnapAlign: "start",
          padding: 12,
          borderRadius: 14,
          border: `1px solid ${tokens.border}`,
          background: tokens.bg,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
            <strong style={{ fontSize: 12, letterSpacing: "0.04em", textTransform: "uppercase", color: tokens.muted }}>{column.title}</strong>
            {column.meta ? <span style={{ fontSize: 11, color: tokens.muted, fontVariantNumeric: "tabular-nums" }}>{column.meta}</span> : null}
          </div>
          <div style={{ display: "grid", gap: 8 }}>{column.children}</div>
        </div>
      ))}
    </div>
  );
}

export function PipelineCard({ title, subtitle, footer, onClick }: {
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        textAlign: "left",
        display: "grid",
        gap: 5,
        width: "100%",
        padding: 12,
        borderRadius: 12,
        border: `1px solid ${tokens.border}`,
        background: tokens.card,
        color: tokens.fg,
        cursor: onClick ? "pointer" : "default",
        fontFamily: "inherit",
        transition: "border-color 120ms ease, box-shadow 120ms ease",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{title}</div>
      {subtitle ? <div style={{ fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" }}>{subtitle}</div> : null}
      {footer}
    </button>
  );
}

export function Modal({ open, title, description, children, onClose, footer }: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const narrow = useIsNarrow();
  usePibBaseStyles();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // On a phone, focusing a field would pop the keyboard over half the sheet: focus the panel instead.
    if (mediaMatches(NARROW_QUERY)) panelRef.current?.focus({ preventScroll: true });
    else panelRef.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "color-mix(in oklab, black 50%, transparent)",
        backdropFilter: "blur(2px)",
        display: "grid",
        // A phone gets a bottom sheet the width of the screen.
        placeItems: narrow ? "end stretch" : "center",
        padding: narrow ? "calc(8px + env(safe-area-inset-top, 0px)) 0 0" : 16,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="pib-ui"
        style={{
          width: narrow ? "100%" : "min(500px, 100%)",
          maxHeight: narrow ? "calc(100dvh - 8px - env(safe-area-inset-top, 0px))" : "90vh",
          overflowX: "hidden",
          overflowY: "auto",
          overscrollBehavior: "contain",
          WebkitOverflowScrolling: "touch",
          borderRadius: narrow ? "16px 16px 0 0" : 16,
          border: `1px solid ${tokens.border}`,
          borderBottom: narrow ? "none" : `1px solid ${tokens.border}`,
          background: tokens.card,
          color: tokens.fg,
          boxShadow: "0 24px 60px color-mix(in oklab, black 40%, transparent)",
          display: "grid",
          gridTemplateColumns: oneColumn,
          alignContent: "start",
          gap: 16,
          padding: narrow ? "16px 16px calc(16px + env(safe-area-inset-bottom, 0px))" : 20,
          fontFamily: font,
          outline: "none",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: 17, fontWeight: 650, letterSpacing: "-0.01em", overflowWrap: "anywhere" }}>{title}</h2>
            {description ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.45 }}>{description}</p> : null}
          </div>
          <Button type="button" variant="secondary" onClick={onClose} aria-label="Close" style={{ minWidth: narrow ? 40 : 0, padding: "0 10px", flexShrink: 0 }}>×</Button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: oneColumn, gap: 14, minWidth: 0 }}>{children}</div>
        {footer ? <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>{footer}</div> : null}
      </div>
    </div>
  );
}

export interface TaskAssigneeOption {
  kind: "agent" | "user";
  id: string;
  name: string;
  detail?: string | null;
  status?: string | null;
}

/**
 * A "New task" dialog that looks and behaves like Paperclip's own (plugins
 * cannot open the host's dialog). Title and description arrive prefilled and
 * stay editable; the person picks who the task is for.
 */
export function NewTaskDialog({ open, prefix, heading = "New task", initialTitle, initialDescription, assignees, defaultAssignee, onClose, onCreate, note }: {
  open: boolean;
  /** Company issue prefix shown in the header chip, e.g. `PAR`. */
  prefix?: string | null;
  heading?: string;
  initialTitle: string;
  initialDescription: string;
  assignees: TaskAssigneeOption[];
  /** `agent:<id>` or `user:<id>`. */
  defaultAssignee?: string;
  onClose: () => void;
  onCreate: (task: { title: string; description: string; assigneeAgentId: string | null; assigneeUserId: string | null }) => Promise<void>;
  note?: ReactNode;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [assignee, setAssignee] = useState(defaultAssignee ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const narrow = useIsNarrow();
  usePibBaseStyles();

  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle);
    setDescription(initialDescription);
    setAssignee(defaultAssignee ?? "");
    setError("");
    setBusy(false);
  }, [open, initialTitle, initialDescription, defaultAssignee]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    titleRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, busy]);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title, open]);

  // On a phone the description grows with its text and the dialog body scrolls (no box inside a box).
  useEffect(() => {
    const el = descriptionRef.current;
    if (!el) return;
    if (!narrow) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [description, open, narrow]);

  if (!open) return null;

  const [kind, id] = assignee.includes(":") ? (assignee.split(":", 2) as ["agent" | "user", string]) : [null, ""];
  const selected = assignees.find((a) => a.kind === kind && a.id === id) ?? null;
  const agents = assignees.filter((a) => a.kind === "agent");
  const people = assignees.filter((a) => a.kind === "user");

  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({
        title: title.trim(),
        description,
        assigneeAgentId: kind === "agent" ? id : null,
        assigneeUserId: kind === "user" ? id : null,
      });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const bar: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", padding: "10px 16px", flexShrink: 0 };
  const ghost: CSSProperties = { appearance: "none", border: "none", background: "transparent", color: tokens.muted, cursor: "pointer", fontFamily: "inherit", fontSize: 13, borderRadius: 6, padding: "4px 8px" };

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 80, background: "color-mix(in oklab, black 50%, transparent)", display: "grid", placeItems: narrow ? "stretch" : "start center", padding: narrow ? 0 : "10vh 16px 16px" }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        className="pib-ui"
        style={narrow
          // A phone gets the whole screen, clear of the notch and the home indicator.
          ? { width: "100%", height: "100dvh", maxHeight: "100dvh", display: "flex", flexDirection: "column", background: tokens.bg, color: tokens.fg, fontFamily: font, overflow: "hidden", paddingTop: "env(safe-area-inset-top, 0px)" }
          : { width: "min(720px, 100%)", maxHeight: "80vh", display: "flex", flexDirection: "column", borderRadius: 12, border: `1px solid ${tokens.border}`, background: tokens.bg, color: tokens.fg, boxShadow: "0 24px 60px color-mix(in oklab, black 40%, transparent)", fontFamily: font, overflow: "hidden" }}
      >
        <div style={{ ...bar, borderBottom: `1px solid ${tokens.border}`, flexWrap: "nowrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: tokens.muted, minWidth: 0 }}>
            {prefix ? <span style={{ borderRadius: 4, background: tokens.secondary, padding: "2px 6px", fontSize: 12, fontWeight: 600, color: tokens.fg }}>{prefix}</span> : null}
            {prefix ? <span style={{ opacity: 0.6 }}>›</span> : null}
            <span>{heading}</span>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} disabled={busy} style={{ ...ghost, fontSize: 18, lineHeight: 1, padding: "2px 8px", minWidth: narrow ? 40 : undefined, flexShrink: 0 }}>×</button>
        </div>
        <div style={{ minHeight: 0, flex: 1, overflowY: "auto", overscrollBehavior: "contain", WebkitOverflowScrolling: "touch" }}>
          <div style={{ padding: "16px 16px 8px" }}>
            <textarea
              ref={titleRef}
              value={title}
              rows={1}
              placeholder={initialTitle || initialDescription ? "Task title" : "Loading…"}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) event.preventDefault();
              }}
              style={{ width: "100%", fontSize: 18, fontWeight: 600, background: "transparent", color: tokens.fg, border: "none", outline: "none", resize: "none", overflow: "hidden", fontFamily: "inherit", padding: 0 }}
            />
          </div>
          <div style={{ padding: "0 16px 8px", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: tokens.muted, flexWrap: "wrap" }}>
            <span style={{ width: 24, textAlign: "center" }}>For</span>
            <select
              aria-label="Assignee"
              value={assignee}
              disabled={busy}
              onChange={(event) => setAssignee(event.target.value)}
              style={{ height: 30, borderRadius: 6, border: `1px solid ${tokens.border}`, background: tokens.bg, color: selected ? tokens.fg : tokens.muted, fontSize: 13, padding: "0 8px", fontFamily: "inherit", maxWidth: narrow ? "100%" : 360, minWidth: 0, flex: narrow ? "1 1 200px" : undefined }}
            >
              <option value="">No assignee</option>
              {people.length ? (
                <optgroup label="People">
                  {people.map((p) => <option key={`user:${p.id}`} value={`user:${p.id}`}>{p.name}{p.detail ? ` · ${p.detail}` : ""}</option>)}
                </optgroup>
              ) : null}
              {agents.length ? (
                <optgroup label="Agents">
                  {agents.map((a) => <option key={`agent:${a.id}`} value={`agent:${a.id}`}>{a.name}{a.detail ? ` · ${a.detail}` : ""}{a.status === "paused" ? " (paused)" : ""}</option>)}
                </optgroup>
              ) : null}
            </select>
          </div>
          {selected?.kind === "agent" && selected.status === "paused" ? (
            <div style={{ margin: "0 16px 8px", fontSize: 12.5, borderRadius: 6, padding: "8px 10px", border: "1px solid color-mix(in oklab, orange 45%, transparent)", background: "color-mix(in oklab, orange 10%, transparent)" }}>
              <strong>{selected.name}</strong> is paused and will not start on this task until it is resumed.
            </div>
          ) : null}
          {!assignee ? (
            <div style={{ margin: "0 16px 8px", fontSize: 12.5, color: tokens.muted }}>Without an assignee the task is parked in Backlog.</div>
          ) : null}
          {note ? <div style={{ margin: "0 16px 8px", fontSize: 12.5, color: tokens.muted }}>{note}</div> : null}
          <div style={{ padding: "4px 16px 16px" }}>
            <textarea
              ref={descriptionRef}
              value={description}
              placeholder="Add description..."
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
              style={{ width: "100%", minHeight: narrow ? 180 : 260, fontSize: 13, lineHeight: 1.55, background: "transparent", color: tokens.muted, border: "none", outline: "none", resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", padding: 0 }}
            />
          </div>
        </div>
        <div style={{ ...bar, borderTop: `1px solid ${tokens.border}`, paddingBottom: narrow ? "calc(10px + env(safe-area-inset-bottom, 0px))" : 10 }}>
          <button
            type="button"
            style={ghost}
            disabled={busy || (title === initialTitle && description === initialDescription)}
            onClick={() => {
              setTitle(initialTitle);
              setDescription(initialDescription);
            }}
          >
            Reset to template
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0, marginLeft: "auto" }}>
            {error ? <span style={{ fontSize: 12, color: tokens.destructive, overflowWrap: "anywhere" }}>{error}</span> : null}
            <Button type="button" disabled={!title.trim() || busy} aria-busy={busy} onClick={() => void submit()} style={{ minWidth: 136 }}>
              {busy ? "Creating..." : "Create Task"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Sheet({ open, title, children, onClose }: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const narrow = useIsNarrow();
  usePibBaseStyles();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        background: "color-mix(in oklab, black 40%, transparent)",
        backdropFilter: "blur(2px)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="pib-ui"
        style={{
          // A phone gets the whole screen, clear of the notch and the home indicator.
          width: narrow ? "100%" : "min(440px, 100%)",
          height: "100%",
          maxHeight: "100dvh",
          background: tokens.card,
          borderLeft: narrow ? "none" : `1px solid ${tokens.border}`,
          color: tokens.fg,
          padding: narrow
            ? "calc(14px + env(safe-area-inset-top, 0px)) 16px calc(20px + env(safe-area-inset-bottom, 0px))"
            : 20,
          display: "grid",
          gridTemplateColumns: oneColumn,
          gap: 16,
          alignContent: "start",
          overflowX: "hidden",
          overflowY: "auto",
          overscrollBehavior: "contain",
          WebkitOverflowScrolling: "touch",
          fontFamily: font,
          boxShadow: "-12px 0 40px color-mix(in oklab, black 20%, transparent)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 650, letterSpacing: "-0.01em", minWidth: 0, overflowWrap: "anywhere" }}>{title}</h2>
          <Button type="button" variant="secondary" onClick={onClose} aria-label="Close" style={{ minWidth: narrow ? 40 : 0, padding: "0 10px", flexShrink: 0 }}>×</Button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: oneColumn, gap: 6, fontSize: 12, color: tokens.muted, fontWeight: 500, minWidth: 0 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function List({ children, empty }: { children: ReactNode; empty: string }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : [children].filter(Boolean);
  if (items.length === 0) {
    return <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>{empty}</p>;
  }
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gridTemplateColumns: oneColumn, gap: 6, minWidth: 0 }}>
      {children}
    </ul>
  );
}

export function ListItem({ children }: { children: ReactNode }) {
  return (
    <li style={{
      fontSize: 13,
      lineHeight: 1.45,
      minWidth: 0,
      overflowWrap: "anywhere",
      padding: "9px 12px",
      borderRadius: 10,
      background: tokens.secondary,
      color: tokens.fg,
    }}>
      {children}
    </li>
  );
}

export function Form({ onSubmit, children }: { onSubmit: (event: FormEvent) => void; children: ReactNode }) {
  return (
    <form
      onSubmit={onSubmit}
      style={{ display: "grid", gridTemplateColumns: oneColumn, gap: 14, minWidth: 0 }}
    >
      {children}
    </form>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      onFocus={(event) => {
        event.currentTarget.style.boxShadow = focusRing.boxShadow as string;
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        event.currentTarget.style.boxShadow = "none";
        props.onBlur?.(event);
      }}
      style={{ ...fieldBase, width: "100%", minWidth: 0, ...((props.style as CSSProperties) ?? {}) }}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      onFocus={(event) => {
        event.currentTarget.style.boxShadow = focusRing.boxShadow as string;
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        event.currentTarget.style.boxShadow = "none";
        props.onBlur?.(event);
      }}
      style={{ ...fieldBase, width: "100%", minWidth: 0, ...((props.style as CSSProperties) ?? {}) }}
    />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      onFocus={(event) => {
        event.currentTarget.style.boxShadow = focusRing.boxShadow as string;
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        event.currentTarget.style.boxShadow = "none";
        props.onBlur?.(event);
      }}
      style={{
        ...fieldBase,
        height: "auto",
        minHeight: 76,
        padding: 10,
        resize: "vertical",
        width: "100%",
        minWidth: 0,
        ...((props.style as CSSProperties) ?? {}),
      }}
    />
  );
}

export function Button({ variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
}) {
  const styles: CSSProperties = variant === "primary"
    ? { background: tokens.primary, color: tokens.primaryFg, border: "1px solid transparent" }
    : { background: tokens.secondary, color: tokens.secondaryFg, border: `1px solid ${tokens.border}` };
  return (
    <button
      {...props}
      onFocus={(event) => {
        event.currentTarget.style.boxShadow = focusRing.boxShadow as string;
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        event.currentTarget.style.boxShadow = "none";
        props.onBlur?.(event);
      }}
      onMouseEnter={(event) => {
        if (!props.disabled) event.currentTarget.style.filter = "brightness(0.97)";
        props.onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.filter = "none";
        props.onMouseLeave?.(event);
      }}
      style={{
        height: 36,
        borderRadius: 9,
        padding: "0 14px",
        fontSize: 13,
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.55 : 1,
        transition: "filter 120ms ease, box-shadow 120ms ease",
        ...styles,
        ...((props.style as CSSProperties) ?? {}),
      }}
    />
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export function formatMinor(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(amount / 100);
  } catch {
    return `${currency} ${(amount / 100).toFixed(0)}`;
  }
}
