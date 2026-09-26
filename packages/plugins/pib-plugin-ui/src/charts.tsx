/**
 * Charts: pure React + inline SVG/HTML, no chart library. They fill their
 * container's width (flex columns, or SVG with a stretched `viewBox`), so they
 * work from a 375px phone up. Each chart has `role="img"` and a text summary
 * for screen readers; bar and trend charts also show a tooltip on hover, tap
 * or arrow keys.
 */
import { useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { usePibBaseStyles } from "./base.js";
import { useResolvedAccent, type AccentInput } from "./theme.js";
import { seriesColor, tokens, tone, type ToneInput } from "./tokens.js";

const numberFormat = (value: number) => (Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value) : "–");

/** 1234 → "1.2K". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "–";
  try {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  } catch {
    return String(Math.round(value));
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Colour for a series/segment: explicit colour, tone, else the categorical palette. */
function colorOf(item: { color?: string; tone?: ToneInput }, index: number): string {
  if (item.color) return item.color;
  if (item.tone) return tone(item.tone).solid;
  return seriesColor(index);
}

const cardStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  padding: 16,
  borderRadius: 14,
  border: `1px solid ${tokens.border}`,
  background: tokens.card,
  boxShadow: "0 1px 2px color-mix(in oklab, black 4%, transparent)",
  minWidth: 0,
};

const chartTitle: CSSProperties = { fontSize: 12, fontWeight: 650, color: tokens.muted, textTransform: "uppercase", letterSpacing: "0.06em" };

const tooltipBox: CSSProperties = {
  position: "absolute",
  top: 0,
  zIndex: 5,
  pointerEvents: "none",
  maxWidth: "min(220px, 100%)",
  padding: "7px 9px",
  borderRadius: 8,
  border: `1px solid ${tokens.border}`,
  background: "var(--popover, var(--card))",
  color: "var(--popover-foreground, var(--foreground))",
  boxShadow: "0 6px 20px color-mix(in oklab, black 16%, transparent)",
  fontSize: 12,
  lineHeight: 1.45,
  display: "grid",
  gap: 2,
  whiteSpace: "nowrap",
};

/** Places a tooltip over column `index` of `count` without leaving the chart. */
function tooltipPosition(index: number, count: number): CSSProperties {
  const center = ((index + 0.5) / count) * 100;
  if (center < 30) return { left: `${Math.max(0, (index / count) * 100)}%` };
  if (center > 70) return { right: `${Math.max(0, ((count - index - 1) / count) * 100)}%` };
  return { left: `${center}%`, transform: "translateX(-50%)" };
}

function Swatch({ color, shape = "dot" }: { color: string; shape?: "dot" | "square" }) {
  return <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: shape === "dot" ? 999 : 2, background: color, flexShrink: 0, display: "inline-block" }} />;
}

export interface LegendItem {
  label: string;
  color?: string;
  tone?: ToneInput;
  value?: ReactNode;
}

/** A wrapping legend: coloured dot, label, optional value. */
export function ChartLegend({ items, style }: { items: LegendItem[]; style?: CSSProperties }) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 11.5, color: tokens.muted, minWidth: 0, ...style }}>
      {items.map((item, index) => (
        <li key={`${item.label}:${index}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Swatch color={colorOf(item, index)} />
          <span style={{ overflowWrap: "anywhere" }}>{item.label}</span>
          {item.value !== undefined ? <span style={{ color: tokens.fg, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{item.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// ── Bars ────────────────────────────────────────────────────────────────────

export interface BarListItem {
  label: string;
  value: number;
  color?: string;
  tone?: ToneInput;
}

export interface BarListProps {
  title: string;
  items: BarListItem[];
  formatValue?: (value: number) => string;
  /** Wrap in a card (default) or render bare inside your own card. */
  bare?: boolean;
}

/** Horizontal labelled bars (the original `BarChart`). One colour per row from the series palette unless given. */
export function BarList({ title, items, formatValue = numberFormat, bare = false }: BarListProps) {
  usePibBaseStyles();
  const max = Math.max(...items.map((item) => item.value), 1);
  const summary = items.length ? `${title}: ${items.map((item) => `${item.label} ${formatValue(item.value)}`).join(", ")}` : `${title}: no data yet`;
  const body = (
    <>
      <div style={chartTitle}>{title}</div>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No data yet.</p>
      ) : (
        <div role="img" aria-label={summary} style={{ display: "grid", gap: 10 }}>
          {items.map((item, index) => (
            <div key={`${item.label}:${index}`} aria-hidden="true" style={{ display: "grid", gap: 5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12 }}>
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.label}</span>
                <span style={{ color: tokens.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", flexShrink: 0 }}>{formatValue(item.value)}</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: tokens.track, overflow: "hidden" }}>
                <div style={{
                  width: `${Math.max((item.value / max) * 100, item.value > 0 ? 4 : 0)}%`,
                  height: "100%",
                  background: colorOf(item, index),
                  borderRadius: 999,
                  transition: "width 300ms ease",
                }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
  return bare ? <div style={{ display: "grid", gap: 12, minWidth: 0 }}>{body}</div> : <div style={cardStyle}>{body}</div>;
}

export interface ChartSeries {
  key: string;
  label: string;
  tone?: ToneInput;
  color?: string;
}

export interface ColumnDatum {
  /** Axis label, e.g. `9/26`. */
  label: string;
  /** Tooltip heading; defaults to `label`. */
  title?: string;
  /** One value per series key. */
  values?: Record<string, number>;
  /** Shortcut for a single series. */
  value?: number;
}

export interface ColumnChartProps {
  data: ColumnDatum[];
  /** Series in stacking order (bottom first). Defaults to one series in the accent colour. */
  series?: ChartSeries[];
  /** Stack series (default) or put them side by side. */
  stacked?: boolean;
  /** Plot height in px (default 96). */
  height?: number;
  /** Shown above the chart when `card` is on, and used in the text summary. */
  title?: string;
  /** Unit for the summary and tooltip total, e.g. "runs". */
  unit?: string;
  legend?: boolean;
  formatValue?: (value: number) => string;
  /** Which axis labels to show: "auto" (first, middle, last on long axes), "all", or "none". */
  axis?: "auto" | "all" | "none";
  emptyText?: string;
  ariaLabel?: string;
  accent?: AccentInput;
  /** Wrap in a card with the title. Off by default (put it inside a SectionCard). */
  card?: boolean;
}

/** Vertical bars over a date or category axis, optionally stacked — like the host's Run Activity chart. */
export function ColumnChart({
  data,
  series,
  stacked = true,
  height = 96,
  title,
  unit,
  legend = true,
  formatValue = numberFormat,
  axis = "auto",
  emptyText = "No data yet.",
  ariaLabel,
  accent,
  card = false,
}: ColumnChartProps) {
  usePibBaseStyles();
  const resolvedAccent = useResolvedAccent(accent);
  const [active, setActive] = useState<number | null>(null);
  const liveId = useId();
  const list: ChartSeries[] = series?.length ? series : [{ key: "value", label: title ?? "Value", color: resolvedAccent?.solid ?? tone("accent").solid }];
  const valueOf = (d: ColumnDatum, key: string) => {
    const v = d.values?.[key] ?? (key === "value" ? d.value : undefined) ?? 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const totals = data.map((d) => list.reduce((sum, s) => sum + valueOf(d, s.key), 0));
  const max = Math.max(1, ...(stacked ? totals : data.flatMap((d) => list.map((s) => valueOf(d, s.key)))));
  const grand = totals.reduce((a, b) => a + b, 0);
  const n = data.length;
  const peak = totals.indexOf(Math.max(...totals, 0));
  const unitText = unit ? ` ${unit}` : "";
  const summary = ariaLabel ?? (n === 0 || grand === 0
    ? `${title ?? "Chart"}: ${emptyText}`
    : `${title ?? "Chart"}: ${formatValue(grand)}${unitText} over ${n} ${n === 1 ? "period" : "periods"}; highest ${data[peak]!.title ?? data[peak]!.label} with ${formatValue(totals[peak]!)}${unitText}.${list.length > 1 ? ` ${list.map((s) => `${s.label} ${formatValue(data.reduce((sum, d) => sum + valueOf(d, s.key), 0))}`).join(", ")}.` : ""}`);

  const shown = (i: number) => {
    if (axis === "none") return false;
    if (axis === "all" || n <= 7) return true;
    return i === 0 || i === n - 1 || i === Math.floor((n - 1) / 2);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const start = active ?? (event.key === "ArrowRight" ? -1 : n);
      setActive(Math.min(n - 1, Math.max(0, start + (event.key === "ArrowRight" ? 1 : -1))));
    } else if (event.key === "Escape") setActive(null);
  };

  const tip = active !== null && data[active] ? (
    <div style={{ ...tooltipBox, ...tooltipPosition(active, n) }}>
      <strong style={{ fontSize: 12 }}>{data[active]!.title ?? data[active]!.label}</strong>
      {list.length > 1 ? list.map((s, i) => (
        <span key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Swatch color={colorOf(s, i)} />
          <span style={{ color: tokens.muted }}>{s.label}</span>
          <span style={{ marginLeft: "auto", paddingLeft: 8, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatValue(valueOf(data[active]!, s.key))}</span>
        </span>
      )) : null}
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{list.length > 1 ? "Total " : ""}<strong>{formatValue(totals[active]!)}</strong>{unitText}</span>
    </div>
  ) : null;

  const plot = n === 0 || grand === 0 ? (
    <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>{emptyText}</p>
  ) : (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <div
        className="pib-chart"
        role="img"
        aria-label={summary}
        aria-describedby={liveId}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={(event) => { if (event.pointerType === "mouse") setActive(null); }}
        style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: n > 20 ? 2 : 3, height, minWidth: 0, outline: "none", touchAction: "pan-y" }}
      >
        {data.map((d, i) => {
          const total = totals[i]!;
          const dim = active !== null && active !== i;
          return (
            <div
              key={`${d.label}:${i}`}
              aria-hidden="true"
              onPointerEnter={(event) => { if (event.pointerType === "mouse") setActive(i); }}
              onClick={() => setActive(active === i ? null : i)}
              style={{ flex: "1 1 0", minWidth: 0, height: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 1, cursor: "default", opacity: dim ? 0.45 : 1, transition: "opacity 120ms ease" }}
            >
              {total === 0 ? (
                <div style={{ width: "100%", height: 2, borderRadius: 1, background: tokens.track }} />
              ) : stacked ? (
                <div style={{ width: "100%", height: `${(total / max) * 100}%`, minHeight: 2, display: "flex", flexDirection: "column-reverse", gap: 1, borderRadius: "3px 3px 1px 1px", overflow: "hidden" }}>
                  {list.map((s, si) => {
                    const v = valueOf(d, s.key);
                    return v > 0 ? <div key={s.key} style={{ flex: `${v} 1 0`, minHeight: 1, background: colorOf(s, si) }} /> : null;
                  })}
                </div>
              ) : (
                list.map((s, si) => {
                  const v = valueOf(d, s.key);
                  return <div key={s.key} style={{ flex: "1 1 0", height: `${(v / max) * 100}%`, minHeight: v > 0 ? 2 : 0, borderRadius: "3px 3px 1px 1px", background: colorOf(s, si) }} />;
                })
              )}
            </div>
          );
        })}
        {tip}
      </div>
      <span id={liveId} className="pib-sr-only" aria-live="polite">
        {active !== null && data[active] ? `${data[active]!.title ?? data[active]!.label}: ${list.map((s) => `${s.label} ${formatValue(valueOf(data[active]!, s.key))}`).join(", ")}` : ""}
      </span>
      {axis !== "none" ? (
        <div aria-hidden="true" style={{ display: "flex", gap: n > 20 ? 2 : 3, minWidth: 0 }}>
          {data.map((d, i) => (
            <div key={`${d.label}:${i}`} style={{ flex: "1 1 0", minWidth: 0, position: "relative", height: 14 }}>
              {shown(i) ? (
                <span style={{
                  position: "absolute",
                  top: 0,
                  ...(i === 0 && n > 1 ? { left: 0 } : i === n - 1 && n > 1 ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" }),
                  fontSize: 10.5,
                  color: tokens.muted,
                  whiteSpace: "nowrap",
                  fontVariantNumeric: "tabular-nums",
                }}>{d.label}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {legend && list.length > 1 ? <ChartLegend items={list.map((s, i) => ({ label: s.label, color: colorOf(s, i) }))} /> : null}
    </div>
  );

  if (!card) return plot;
  return (
    <div style={cardStyle}>
      {title ? <div style={chartTitle}>{title}</div> : null}
      {plot}
    </div>
  );
}

export type BarChartProps = BarListProps | ColumnChartProps;

/**
 * `BarChart` with `items` renders horizontal labelled bars (unchanged API);
 * with `data` it renders vertical, optionally stacked columns (`ColumnChart`).
 */
export function BarChart(props: BarChartProps) {
  if ("items" in props) return <BarList {...props} />;
  return <ColumnChart {...props} />;
}

// ── Distribution ────────────────────────────────────────────────────────────

export interface Segment {
  key?: string;
  label: string;
  value: number;
  tone?: ToneInput;
  color?: string;
}

function segmentSummary(title: string | undefined, segments: Segment[], total: number, formatValue: (v: number) => string): string {
  if (total <= 0) return `${title ?? "Distribution"}: nothing yet`;
  return `${title ?? "Distribution"}: ${segments.filter((s) => s.value > 0).map((s) => `${s.label} ${formatValue(s.value)} (${Math.round((s.value / total) * 100)}%)`).join(", ")}`;
}

/**
 * One horizontal bar split into parts, e.g. tasks by status or AR ageing.
 * Legend below shows each part's value and share.
 */
export function StackedBar({ segments, height = 10, legend = true, formatValue = numberFormat, title, showPercent = true, style }: {
  segments: Segment[];
  height?: number;
  legend?: boolean;
  formatValue?: (value: number) => string;
  /** Used in the text summary. */
  title?: string;
  showPercent?: boolean;
  style?: CSSProperties;
}) {
  usePibBaseStyles();
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0, ...style }}>
      <div role="img" aria-label={segmentSummary(title, segments, total, formatValue)} style={{ display: "flex", gap: 2, height, borderRadius: 999, overflow: "hidden", background: tokens.track, minWidth: 0 }}>
        {total > 0 ? segments.map((s, i) => (s.value > 0 ? (
          <div key={s.key ?? `${s.label}:${i}`} title={`${s.label}: ${formatValue(s.value)}`} style={{ flex: `${s.value} 1 0`, minWidth: 3, background: colorOf(s, i) }} />
        ) : null)) : null}
      </div>
      {legend ? (
        <ChartLegend items={segments.map((s, i) => ({
          label: s.label,
          color: colorOf(s, i),
          value: `${formatValue(s.value)}${showPercent && total > 0 ? ` · ${Math.round((s.value / total) * 100)}%` : ""}`,
        }))} />
      ) : null}
    </div>
  );
}

/** A ring split into parts, with an optional value in the middle and a legend beside it. */
export function DonutChart({ segments, size = 132, thickness = 12, centerValue, centerLabel, legend = true, formatValue = numberFormat, title }: {
  segments: Segment[];
  /** Largest diameter in px; it shrinks with its container. */
  size?: number;
  /** Ring thickness in viewBox units (0–40). */
  thickness?: number;
  centerValue?: ReactNode;
  centerLabel?: ReactNode;
  legend?: boolean;
  formatValue?: (value: number) => string;
  title?: string;
}) {
  usePibBaseStyles();
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const r = 50 - thickness / 2 - 1;
  const c = 2 * Math.PI * r;
  const gap = total > 0 && segments.filter((s) => s.value > 0).length > 1 ? Math.min(1.5, c * 0.01) : 0;
  let offset = 0;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, minWidth: 0 }}>
      <div style={{ position: "relative", width: size, maxWidth: "100%", aspectRatio: "1 / 1", flexShrink: 0 }}>
        <svg viewBox="0 0 100 100" width="100%" height="100%" role="img" aria-label={segmentSummary(title, segments, total, formatValue)} style={{ display: "block", transform: "rotate(-90deg)" }}>
          <circle cx="50" cy="50" r={r} fill="none" stroke={tokens.track} strokeWidth={thickness} />
          {total > 0 ? segments.map((s, i) => {
            if (s.value <= 0) return null;
            const len = (s.value / total) * c;
            const dash = Math.max(0.01, len - gap);
            const el = <circle key={s.key ?? `${s.label}:${i}`} cx="50" cy="50" r={r} fill="none" stroke={colorOf(s, i)} strokeWidth={thickness} strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset}><title>{`${s.label}: ${formatValue(s.value)}`}</title></circle>;
            offset += len;
            return el;
          }) : null}
        </svg>
        {centerValue !== undefined || centerLabel !== undefined ? (
          <div aria-hidden="true" style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center", padding: thickness + 4 }}>
            {centerValue !== undefined ? <div style={{ fontSize: 20, fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{centerValue}</div> : null}
            {centerLabel !== undefined ? <div style={{ fontSize: 11, color: tokens.muted, marginTop: 2 }}>{centerLabel}</div> : null}
          </div>
        ) : null}
      </div>
      {legend ? (
        <ChartLegend
          style={{ flexDirection: "column", flexWrap: "nowrap", gap: 6, flex: "1 1 140px", fontSize: 12 }}
          items={segments.map((s, i) => ({ label: s.label, color: colorOf(s, i), value: `${formatValue(s.value)}${total > 0 ? ` · ${Math.round((s.value / total) * 100)}%` : ""}` }))}
        />
      ) : null}
    </div>
  );
}

// ── Progress ────────────────────────────────────────────────────────────────

/** Tone for a used-up ratio such as budget spend: ok below 80%, warn below 100%, bad at 100%+. */
export function budgetTone(ratio: number | null | undefined, warnAt = 0.8, badAt = 1): "ok" | "warn" | "bad" | "neutral" {
  if (ratio == null || !Number.isFinite(ratio)) return "neutral";
  return ratio >= badAt ? "bad" : ratio >= warnAt ? "warn" : "ok";
}

function ratioOf(value: number | undefined, done: number | undefined, total: number | undefined): number {
  if (value !== undefined) return clamp01(value);
  if (total !== undefined && total > 0) return clamp01((done ?? 0) / total);
  return total === 0 ? 1 : 0;
}

const BAR_HEIGHT = { xs: 4, sm: 6, md: 8, lg: 12 } as const;

/**
 * A toned progress bar. Give `value` (0–1) or `done`/`total`. `tone="budget"`
 * colours by `budgetTone`; default is the page accent, green when complete.
 */
export function ProgressBar({ value, done, total, tone: t, color, label, valueText, showValue = !!label, size = "md", ariaLabel, style }: {
  value?: number;
  done?: number;
  total?: number;
  tone?: ToneInput | "budget";
  color?: string;
  label?: ReactNode;
  /** Right-hand text; defaults to "3 of 5 · 60%" or "60%". */
  valueText?: ReactNode;
  showValue?: boolean;
  size?: keyof typeof BAR_HEIGHT;
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  usePibBaseStyles();
  const accent = useResolvedAccent();
  const ratio = ratioOf(value, done, total);
  const percent = Math.round(ratio * 100);
  const rawRatio = value ?? (total ? (done ?? 0) / total : 0);
  const fill = color
    ?? (t === "budget" ? tone(budgetTone(rawRatio)).solid
      : t ? tone(t).solid
        : ratio >= 1 ? tone("ok").solid : (accent?.solid ?? tone("accent").solid));
  const text = valueText ?? (total !== undefined ? (total === 0 ? "Nothing required" : `${done ?? 0} of ${total} · ${percent}%`) : `${Math.round(rawRatio * 100)}%`);
  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0, ...style }}>
      {label || showValue ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, color: tokens.muted, flexWrap: "wrap" }}>
          {label ? <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{label}</span> : <span />}
          {showValue ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{text}</span> : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
        style={{ height: BAR_HEIGHT[size], borderRadius: 999, background: tokens.track, overflow: "hidden" }}
      >
        <div style={{ width: `${percent}%`, minWidth: percent > 0 ? 3 : 0, height: "100%", borderRadius: 999, background: fill, transition: "width 240ms ease" }} />
      </div>
    </div>
  );
}

/** A circular progress meter with the percentage (or your content) in the middle. */
export function ProgressRing({ value, done, total, size = 72, thickness = 9, tone: t, color, label, children }: {
  value?: number;
  done?: number;
  total?: number;
  /** Diameter in px (shrinks with its container). */
  size?: number;
  /** Ring thickness in viewBox units. */
  thickness?: number;
  tone?: ToneInput;
  color?: string;
  /** Accessible name, e.g. "Setup progress". */
  label: string;
  children?: ReactNode;
}) {
  usePibBaseStyles();
  const accent = useResolvedAccent();
  const ratio = ratioOf(value, done, total);
  const percent = Math.round(ratio * 100);
  const stroke = color ?? (t ? tone(t).solid : ratio >= 1 ? tone("ok").solid : (accent?.solid ?? tone("accent").solid));
  const r = 50 - thickness / 2 - 1;
  const c = 2 * Math.PI * r;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} style={{ position: "relative", width: size, maxWidth: "100%", aspectRatio: "1 / 1", flexShrink: 0 }}>
      <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true" style={{ display: "block", transform: "rotate(-90deg)" }}>
        <circle cx="50" cy="50" r={r} fill="none" stroke={tokens.track} strokeWidth={thickness} />
        {percent > 0 ? <circle cx="50" cy="50" r={r} fill="none" stroke={stroke} strokeWidth={thickness} strokeLinecap="round" strokeDasharray={`${ratio * c} ${c}`} style={{ transition: "stroke-dasharray 300ms ease" }} /> : null}
      </svg>
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
        {children ?? <span style={{ fontSize: Math.max(12, Math.round(size * 0.24)), fontWeight: 650, letterSpacing: "-0.02em" }}>{percent}%</span>}
      </div>
    </div>
  );
}

// ── Lines ───────────────────────────────────────────────────────────────────

/** A tiny line for a KPI card. Fills its container's width. */
export function Sparkline({ values, tone: t, color, height = 28, fill = true, label }: {
  values: number[];
  tone?: ToneInput;
  color?: string;
  height?: number;
  fill?: boolean;
  /** Text summary; defaults to first → last value. */
  label?: string;
}) {
  usePibBaseStyles();
  const accent = useResolvedAccent();
  const gradient = useId().replace(/:/g, "");
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return null;
  const stroke = color ?? (t ? tone(t).solid : (accent?.solid ?? tone("accent").solid));
  const max = Math.max(...clean);
  const min = Math.min(...clean);
  const h = 30;
  const pad = 2;
  const span = max - min || 1;
  const points = clean.map((v, i) => [(i / (clean.length - 1)) * 100, pad + (1 - (v - min) / span) * (h - pad * 2)] as const);
  const d = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px},${py}`).join(" ");
  const last = clean[clean.length - 1]!;
  const lastY = (points[points.length - 1]![1] / h) * 100;
  return (
    <div role="img" aria-label={label ?? `Trend from ${numberFormat(clean[0]!)} to ${numberFormat(last)}`} style={{ position: "relative", height, minWidth: 0 }}>
      <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {fill ? <path d={`${d} L100,${h} L0,${h} Z`} fill={`url(#${gradient})`} stroke="none" /> : null}
        <path d={d} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span aria-hidden="true" style={{ position: "absolute", right: -2.5, top: `calc(${lastY}% - 2.5px)`, width: 5, height: 5, borderRadius: 999, background: stroke }} />
    </div>
  );
}

export interface TrendSeries {
  key: string;
  label: string;
  values: number[];
  tone?: ToneInput;
  color?: string;
  /** Dashed line (e.g. last period). */
  dashed?: boolean;
}

/**
 * An area/line chart over labelled points, with a gradient fill under the
 * first series, a hover/tap guide and tooltip. Give `data` for one series or
 * `labels` + `series` for several.
 */
export function TrendChart({ data, labels: labelsProp, series: seriesProp, height = 140, area = true, formatValue = numberFormat, title, unit, axis = "auto", emptyText = "No data yet.", tone: t, color, accent }: {
  data?: Array<{ label: string; value: number }>;
  labels?: string[];
  series?: TrendSeries[];
  height?: number;
  area?: boolean;
  formatValue?: (value: number) => string;
  title?: string;
  unit?: string;
  axis?: "auto" | "all" | "none";
  emptyText?: string;
  tone?: ToneInput;
  color?: string;
  accent?: AccentInput;
}) {
  usePibBaseStyles();
  const resolvedAccent = useResolvedAccent(accent);
  const [active, setActive] = useState<number | null>(null);
  const gradient = useId().replace(/:/g, "");
  const labels = labelsProp ?? data?.map((d) => d.label) ?? [];
  const firstColor = color ?? (t ? tone(t).solid : (resolvedAccent?.solid ?? tone("accent").solid));
  const series: TrendSeries[] = seriesProp?.length ? seriesProp : [{ key: "value", label: title ?? "Value", values: data?.map((d) => d.value) ?? [], color: firstColor }];
  const colors = series.map((s, i) => (i === 0 && !s.color && !s.tone ? firstColor : colorOf(s, i)));
  const n = labels.length;
  const all = series.flatMap((s) => s.values.filter((v) => Number.isFinite(v)));
  const unitText = unit ? ` ${unit}` : "";
  if (n < 2 || all.length === 0) return <p style={{ margin: 0, fontSize: 12.5, color: tokens.muted }}>{emptyText}</p>;
  const max = Math.max(...all, 0) || 1;
  const min = Math.min(0, ...all);
  const h = 100;
  const x = (i: number) => (i / (n - 1)) * 100;
  const y = (v: number) => ((max - v) / (max - min || 1)) * h;
  const first = series[0]!;
  const summary = `${title ?? "Trend"}: ${series.map((s) => `${s.label} from ${formatValue(s.values[0] ?? 0)} to ${formatValue(s.values[n - 1] ?? 0)}${unitText}`).join("; ")}; peak ${formatValue(Math.max(...all))}${unitText}.`;
  const indexAt = (clientX: number, rect: DOMRect) => Math.round(clamp01((clientX - rect.left) / (rect.width || 1)) * (n - 1));
  const shown = (i: number) => axis === "all" || (axis === "auto" && (n <= 7 || i === 0 || i === n - 1 || i === Math.floor((n - 1) / 2)));

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: tokens.muted, fontVariantNumeric: "tabular-nums" }} aria-hidden="true">
        <span>{formatValue(max)}{unitText}</span>
        {series.length > 1 ? <ChartLegend items={series.map((s, i) => ({ label: s.label, color: colors[i] }))} style={{ fontSize: 10.5, justifyContent: "flex-end" }} /> : null}
      </div>
      <div
        className="pib-chart"
        role="img"
        aria-label={summary}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
          event.preventDefault();
          const start = active ?? (event.key === "ArrowRight" ? -1 : n);
          setActive(Math.min(n - 1, Math.max(0, start + (event.key === "ArrowRight" ? 1 : -1))));
        }}
        onBlur={() => setActive(null)}
        onPointerMove={(event) => setActive(indexAt(event.clientX, event.currentTarget.getBoundingClientRect()))}
        onPointerDown={(event) => setActive(indexAt(event.clientX, event.currentTarget.getBoundingClientRect()))}
        onPointerLeave={(event) => { if (event.pointerType === "mouse") setActive(null); }}
        style={{ position: "relative", height, minWidth: 0, outline: "none", touchAction: "pan-y" }}
      >
        <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors[0]} stopOpacity="0.26" />
              <stop offset="100%" stopColor={colors[0]} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map((f) => <line key={f} x1="0" x2="100" y1={f * h} y2={f * h} stroke="var(--border)" strokeWidth="1" strokeDasharray={f === 1 ? undefined : "3 3"} vectorEffect="non-scaling-stroke" />)}
          {area ? <path d={`${first.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v ?? 0)}`).join(" ")} L100,${y(min)} L0,${y(min)} Z`} fill={`url(#${gradient})`} /> : null}
          {series.map((s, si) => (
            <path key={s.key} d={s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v ?? 0)}`).join(" ")} fill="none" stroke={colors[si]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "4 4" : undefined} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        {active !== null ? (
          <>
            <span aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: `${x(active)}%`, width: 1, background: tokens.border }} />
            {series.map((s, si) => (
              <span key={s.key} aria-hidden="true" style={{ position: "absolute", left: `calc(${x(active)}% - 4px)`, top: `calc(${(y(s.values[active] ?? 0) / h) * 100}% - 4px)`, width: 8, height: 8, borderRadius: 999, background: colors[si], boxShadow: `0 0 0 2px ${tokens.card}` }} />
            ))}
            <div style={{ ...tooltipBox, ...tooltipPosition(active, n) }}>
              <strong>{labels[active]}</strong>
              {series.map((s, si) => (
                <span key={s.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Swatch color={colors[si]!} />
                  {series.length > 1 ? <span style={{ color: tokens.muted }}>{s.label}</span> : null}
                  <span style={{ marginLeft: series.length > 1 ? "auto" : 0, paddingLeft: series.length > 1 ? 8 : 0, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{formatValue(s.values[active] ?? 0)}{unitText}</span>
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>
      {axis !== "none" ? (
        <div aria-hidden="true" style={{ position: "relative", height: 14, minWidth: 0 }}>
          {labels.map((label, i) => (shown(i) ? (
            <span key={`${label}:${i}`} style={{ position: "absolute", top: 0, ...(i === 0 ? { left: 0 } : i === n - 1 ? { right: 0 } : { left: `${x(i)}%`, transform: "translateX(-50%)" }), fontSize: 10.5, color: tokens.muted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{label}</span>
          ) : null))}
        </div>
      ) : null}
    </div>
  );
}
