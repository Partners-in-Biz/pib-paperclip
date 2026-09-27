/**
 * Phone rows for lists. Under 640px a table's stacked cards repeat every
 * column label and take ~250px a row; these rows show a title, one muted
 * line and an optional trailing value (an amount, a status pill), and the
 * whole row opens the item. Render them instead of the host `DataTable`
 * when `useIsNarrow()` is true:
 *
 *   narrow ? <CompactRows rows={rows} title={(r) => r.name} meta={(r) => `${r.status} · ${formatShortDate(r.due)}`} onOpen={open} />
 *          : <DataTable columns={columns} rows={rows} />
 */
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { usePibBaseStyles } from "./base.js";
import { tokens } from "./tokens.js";

export interface CompactRowsProps<T> {
  rows: T[];
  /** Stable key for each row (defaults to `row.id`). */
  rowKey?: (row: T) => string;
  title: (row: T) => ReactNode;
  /** One short muted line: status, client, date. Empty parts are left out by the caller. */
  meta?: (row: T) => ReactNode;
  /** Right-hand value, e.g. an amount or a pill. */
  trailing?: (row: T) => ReactNode;
  /** Open the row (a button). */
  onOpen?: (row: T) => void;
  /** Or link the row: anchor props (the host's `linkProps(path)`). */
  linkFor?: (row: T) => Record<string, unknown> | null;
  empty?: ReactNode;
  loading?: boolean;
  /** Accessible name for the list. */
  label?: string;
}

export function CompactRows<T>({ rows, rowKey, title, meta, trailing, onOpen, linkFor, empty = "Nothing here yet.", loading = false, label }: CompactRowsProps<T>) {
  usePibBaseStyles();
  if (loading && rows.length === 0) return <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>Loading…</p>;
  if (rows.length === 0) return <div style={{ fontSize: 13, color: tokens.muted, padding: "8px 2px" }}>{empty}</div>;
  return (
    <ul aria-label={label} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", borderTop: `1px solid ${tokens.border}`, minWidth: 0 }}>
      {rows.map((row, index) => {
        const key = rowKey ? rowKey(row) : String((row as { id?: unknown }).id ?? index);
        const link = linkFor?.(row) ?? null;
        const interactive = Boolean(link || onOpen);
        const inner = (
          <>
            <span style={{ display: "grid", gap: 2, minWidth: 0, flex: "1 1 auto" }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: tokens.fg, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title(row)}</span>
              {meta ? <span style={{ fontSize: 12.5, color: tokens.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta(row)}</span> : null}
            </span>
            {trailing ? <span style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{trailing(row)}</span> : null}
            {interactive ? <ChevronRight size={16} aria-hidden="true" style={{ color: tokens.muted, flexShrink: 0 }} /> : null}
          </>
        );
        const rowStyle = { display: "flex", alignItems: "center", gap: 10, minHeight: 56, padding: "8px 4px", width: "100%", textAlign: "left" as const, color: tokens.fg, textDecoration: "none", background: "transparent", border: "none", fontFamily: "inherit", cursor: interactive ? "pointer" : "default", minWidth: 0 };
        return (
          <li key={key} style={{ borderBottom: `1px solid ${tokens.border}`, minWidth: 0 }}>
            {link ? (
              <a {...link} className="pib-link-card" style={rowStyle}>{inner}</a>
            ) : onOpen ? (
              <button type="button" className="pib-link-card" onClick={() => onOpen(row)} style={rowStyle}>{inner}</button>
            ) : (
              <div style={rowStyle}>{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
