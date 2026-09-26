/**
 * Status and data display: dots, pills, KPI cards, timelines and section cards.
 */
import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { usePibBaseStyles, useIsNarrow, oneColumn } from "./base.js";
import { Sparkline } from "./charts.js";
import { Icon, IconBadge } from "./icons.js";
import { useResolvedAccent, type AccentInput } from "./theme.js";
import { tokens, tone, toneName, type ToneInput } from "./tokens.js";

export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

/** "just now", "5m ago", "3h ago", "2d ago", then a date. Null for a missing or bad time. */
export function relativeTime(at: string | number | Date | null | undefined, now: Date = new Date()): string | null {
  if (at === null || at === undefined || at === "") return null;
  const t = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (Number.isNaN(t)) return null;
  const diff = now.getTime() - t;
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  const say = (text: string) => (future ? `in ${text}` : `${text} ago`);
  if (s < 45) return future ? "soon" : "just now";
  if (s < 3600) return say(`${Math.max(1, Math.round(s / 60))}m`);
  if (s < 86_400) return say(`${Math.round(s / 3600)}h`);
  if (s < 86_400 * 14) return say(`${Math.round(s / 86_400)}d`);
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(t).getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

// ── Dots and pills ──────────────────────────────────────────────────────────

/**
 * A small coloured status dot. `pulse` adds a soft ping for live things
 * (running, syncing). Give a `label` when the dot carries meaning on its own.
 */
export function StatusDot({ tone: t = "neutral", pulse = false, size = 8, label, halo = false, style }: {
  tone?: ToneInput;
  pulse?: boolean;
  size?: number;
  label?: string;
  /** A soft ring around the dot (bigger "traffic light" look). */
  halo?: boolean;
  style?: CSSProperties;
}) {
  usePibBaseStyles();
  const colors = tone(t);
  return (
    <span
      className={pulse ? "pib-pulse" : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{
        position: "relative",
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 999,
        background: colors.solid,
        color: colors.solid,
        flexShrink: 0,
        boxShadow: halo ? `0 0 0 ${Math.max(3, Math.round(size / 3))}px ${colors.soft}` : undefined,
        ...style,
      }}
    />
  );
}

const PILL_SIZE = { sm: { height: 20, padding: "0 7px", fontSize: 11, gap: 4, icon: 11 }, md: { height: 22, padding: "0 8px", fontSize: 11.5, gap: 5, icon: 12 }, lg: { height: 26, padding: "0 10px", fontSize: 12.5, gap: 6, icon: 14 } } as const;

/**
 * A rounded label in a tone: `soft` (tinted, default), `solid` (filled) or
 * `outline`. Add an `icon` or a leading `dot`.
 */
export function Pill({ children, tone: t = "neutral", variant = "soft", size = "md", icon, dot = false, title, style }: {
  children: ReactNode;
  tone?: ToneInput;
  variant?: "soft" | "solid" | "outline";
  size?: keyof typeof PILL_SIZE;
  icon?: LucideIcon;
  dot?: boolean;
  title?: string;
  style?: CSSProperties;
}) {
  usePibBaseStyles();
  const colors = tone(t);
  const s = PILL_SIZE[size];
  const neutral = toneName(t) === "neutral";
  const look: CSSProperties = variant === "solid"
    ? { background: colors.solid, color: "#fff", border: "1px solid transparent" }
    : variant === "outline"
      ? { background: "transparent", color: neutral ? tokens.muted : colors.fg, border: `1px solid ${neutral ? tokens.border : colors.border}` }
      : { background: neutral ? tokens.secondary : colors.soft, color: neutral ? tokens.secondaryFg : colors.fg, border: `1px solid ${neutral ? tokens.border : colors.border}` };
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: s.gap,
        minHeight: s.height,
        padding: s.padding,
        borderRadius: 999,
        fontSize: s.fontSize,
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        maxWidth: "100%",
        width: "fit-content",
        ...look,
        ...style,
      }}
    >
      {dot ? <StatusDot tone={t} size={6} style={variant === "solid" ? { background: "#fff" } : undefined} /> : null}
      {icon ? <Icon icon={icon} size={s.icon} /> : null}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{children}</span>
    </span>
  );
}

/** Same as `Pill`. */
export const Badge = Pill;

// ── KPI cards ───────────────────────────────────────────────────────────────

export type DeltaDirection = "up" | "down" | "flat";

/** Reads the direction from a number or a string such as "+12% vs last week", "−3", "▼ 4%". */
export function deltaDirection(delta: string | number | null | undefined): DeltaDirection {
  if (delta === null || delta === undefined || delta === "") return "flat";
  if (typeof delta === "number") return delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const text = delta.trim();
  if (/^[+▲↑]/.test(text)) return "up";
  if (/^[-−–▼↓]/.test(text)) return "down";
  return "flat";
}

/** "+12% vs last week" → "▲ 12% vs last week"; 5 → "▲ 5". */
export function formatDelta(delta: string | number): string {
  const dir = deltaDirection(delta);
  const text = typeof delta === "number" ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(Math.abs(delta)) : delta.trim().replace(/^[+\-−–▲▼↑↓]\s*/, "");
  return dir === "up" ? `▲ ${text}` : dir === "down" ? `▼ ${text}` : text;
}

export interface KpiCardProps {
  label: ReactNode;
  value: ReactNode;
  /** Status of the number itself: `bad` colours the value and border, `warn` the border. */
  tone?: ToneInput;
  /** Change vs last period: a number or text like "+12% vs last week". */
  delta?: string | number | null;
  /** Colour of the delta; by default up is good (green) and down is bad (red). */
  deltaTone?: ToneInput;
  /** Lower is better (costs, overdue): flips the default delta colours. */
  invert?: boolean;
  /** Small line under the value, e.g. the source module. */
  hint?: ReactNode;
  icon?: LucideIcon;
  /** Tint of the icon badge (e.g. the source module); defaults to the tone, else the page accent. */
  iconAccent?: AccentInput;
  sparkline?: number[];
  /** Makes the whole card a link. Pass the host's `linkProps(href)` result, or a plain `href`. */
  link?: LinkProps | null;
  href?: string | null;
  size?: "sm" | "md";
  style?: CSSProperties;
}

/** A metric tile: label, big value, delta with ▲/▼, optional icon, sparkline and link. */
export function KpiCard({ label, value, tone: t, delta, deltaTone, invert = false, hint, icon, iconAccent, sparkline, link, href, size = "md", style }: KpiCardProps) {
  usePibBaseStyles();
  const accent = useResolvedAccent(iconAccent);
  const name = toneName(t ?? "neutral");
  const colors = tone(name);
  const dir = deltaDirection(delta);
  const dTone = deltaTone ?? (dir === "flat" ? "neutral" : (dir === "up") !== invert ? "ok" : "bad");
  const dColors = tone(dTone);
  const alert = name === "bad" || name === "warn";
  const small = size === "sm";
  // An explicit iconAccent (e.g. the source module) wins; else a status tone; else the page accent.
  const badgeColors = iconAccent ? accent : name !== "neutral" ? colors : accent;
  const body = (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: small ? 11.5 : 12.5, fontWeight: 500, color: tokens.muted, overflowWrap: "anywhere", lineHeight: 1.35 }}>{label}</span>
        {icon ? <IconBadge icon={icon} accent={badgeColors ?? undefined} size={small ? "xs" : "sm"} /> : alert ? <StatusDot tone={name} size={7} style={{ marginTop: 4 }} /> : null}
      </div>
      <span style={{ fontSize: small ? 18 : 24, fontWeight: 650, letterSpacing: "-0.025em", lineHeight: 1.15, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere", color: name === "bad" ? colors.fg : tokens.fg }}>{value}</span>
      {delta !== null && delta !== undefined && delta !== "" || hint ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 11.5, color: tokens.muted, minWidth: 0 }}>
          {delta !== null && delta !== undefined && delta !== "" ? (
            <span style={{ color: toneName(dTone) === "neutral" ? tokens.muted : dColors.fg, fontWeight: 600, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>{formatDelta(delta)}</span>
          ) : null}
          {hint ? <span style={{ overflowWrap: "anywhere" }}>{hint}</span> : null}
        </div>
      ) : null}
      {sparkline && sparkline.length > 1 ? <Sparkline values={sparkline} tone={name !== "neutral" ? name : undefined} color={name === "neutral" ? accent?.solid : undefined} height={small ? 22 : 30} /> : null}
    </>
  );
  const box: CSSProperties = {
    display: "grid",
    gridTemplateColumns: oneColumn,
    alignContent: "start",
    gap: small ? 4 : 6,
    padding: small ? 10 : 14,
    borderRadius: 12,
    border: `1px solid ${alert ? colors.border : tokens.border}`,
    background: alert ? `linear-gradient(180deg, ${colors.soft}, transparent 70%), ${tokens.card}` : tokens.card,
    color: tokens.fg,
    minWidth: 0,
    textDecoration: "none",
    ...style,
  };
  const anchor = link ?? (href ? { href } : null);
  if (anchor) {
    const external = typeof anchor.href === "string" && /^https?:\/\//i.test(anchor.href);
    return <a {...(external ? { target: "_blank", rel: "noreferrer" } : {})} {...anchor} className="pib-link-card" style={box}>{body}</a>;
  }
  return <div style={box}>{body}</div>;
}

// ── Timeline ────────────────────────────────────────────────────────────────

export interface TimelineItem {
  id?: string;
  at?: string | number | Date | null;
  title: ReactNode;
  detail?: ReactNode;
  /** Right-hand or trailing meta, e.g. the agent or source. */
  meta?: ReactNode;
  tone?: ToneInput;
  icon?: LucideIcon;
  /** Link for the title: the host's `linkProps(href)` result, or `{ href }`. */
  link?: LinkProps | null;
}

/** An activity feed: coloured dots on a rail, title, detail and a relative time. */
export function Timeline({ items, now, empty = "Nothing yet.", limit, dense = false }: {
  items: TimelineItem[];
  now?: Date;
  empty?: string;
  limit?: number;
  dense?: boolean;
}) {
  usePibBaseStyles();
  if (items.length === 0) return <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>{empty}</p>;
  const shown = limit ? items.slice(0, limit) : items;
  const clock = now ?? new Date();
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gridTemplateColumns: oneColumn, minWidth: 0 }}>
        {shown.map((item, index) => {
          const colors = tone(item.tone ?? "info");
          const when = relativeTime(item.at ?? null, clock);
          const last = index === shown.length - 1;
          const titleNode = item.link
            ? <a {...item.link} style={{ color: "inherit", textDecoration: "none", ...(item.link.style ?? {}) }}>{item.title}</a>
            : item.title;
          return (
            <li key={item.id ?? index} style={{ display: "grid", gridTemplateColumns: `18px ${oneColumn}`, columnGap: 10, minWidth: 0 }}>
              <div aria-hidden="true" style={{ position: "relative", display: "flex", justifyContent: "center" }}>
                {!last ? <span style={{ position: "absolute", top: dense ? 16 : 20, bottom: dense ? -4 : -6, width: 1, background: tokens.border }} /> : null}
                {item.icon ? (
                  <span style={{ marginTop: dense ? 2 : 4, width: 18, height: 18, borderRadius: 6, display: "grid", placeItems: "center", background: colors.soft, boxShadow: `inset 0 0 0 1px ${colors.border}` }}>
                    <Icon icon={item.icon} size={11} color={colors.solid} />
                  </span>
                ) : (
                  <span style={{ marginTop: dense ? 5 : 7, width: 9, height: 9, borderRadius: 999, background: colors.solid, boxShadow: `0 0 0 3px ${colors.soft}` }} />
                )}
              </div>
              <div style={{ display: "grid", gap: 2, padding: dense ? "2px 0 10px" : "4px 0 14px", minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 550, lineHeight: 1.4, minWidth: 0, overflowWrap: "anywhere", flex: "1 1 180px" }}>{titleNode}</span>
                  {when ? <time dateTime={new Date(item.at instanceof Date ? item.at.getTime() : typeof item.at === "number" ? item.at : Date.parse(String(item.at))).toISOString()} style={{ fontSize: 11.5, color: tokens.muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{when}</time> : null}
                </div>
                {item.detail || item.meta ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: tokens.muted, lineHeight: 1.45, minWidth: 0, overflowWrap: "anywhere" }}>
                    {item.meta}
                    {item.detail ? <span style={{ minWidth: 0 }}>{item.detail}</span> : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {limit && items.length > limit ? <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted, paddingLeft: 28 }}>And {items.length - limit} more.</p> : null}
    </div>
  );
}

// ── Section card ────────────────────────────────────────────────────────────

/**
 * A card section with a title, optional icon badge, subtitle, actions and an
 * accent strip along the top. Use it for every block on an overview page.
 */
export function SectionCard({ title, subtitle, icon, tone: t, accent, strip = false, actions, children, id, footer, style }: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  /** Tints the icon badge and strip with a status colour instead of the accent. */
  tone?: ToneInput;
  accent?: AccentInput;
  /** A 3px coloured line along the top edge. */
  strip?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
  footer?: ReactNode;
  style?: CSSProperties;
}) {
  usePibBaseStyles();
  const narrow = useIsNarrow();
  const resolved = useResolvedAccent(accent);
  const colors = t ? tone(t) : resolved ?? tone("neutral");
  return (
    <section
      id={id}
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: oneColumn,
        gap: 14,
        padding: narrow ? 14 : 18,
        borderRadius: 14,
        border: `1px solid ${tokens.border}`,
        background: tokens.card,
        boxShadow: "0 1px 2px color-mix(in oklab, black 4%, transparent)",
        minWidth: 0,
        ...style,
      }}
    >
      {strip ? <span aria-hidden="true" style={{ position: "absolute", top: -1, left: -1, right: -1, height: 3, borderRadius: "14px 14px 0 0", background: colors.solid }} /> : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: "1 1 200px" }}>
          {icon ? <IconBadge icon={icon} accent={colors} size="sm" /> : null}
          <div style={{ display: "grid", gap: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 650, letterSpacing: "-0.01em", lineHeight: 1.3, color: tokens.fg, overflowWrap: "anywhere" }}>{title}</h2>
            {subtitle ? <p style={{ margin: 0, fontSize: 12, color: tokens.muted, lineHeight: 1.4, overflowWrap: "anywhere" }}>{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}>{actions}</div> : null}
      </div>
      {children}
      {footer ? <div style={{ borderTop: `1px solid ${tokens.border}`, paddingTop: 12, minWidth: 0 }}>{footer}</div> : null}
    </section>
  );
}
