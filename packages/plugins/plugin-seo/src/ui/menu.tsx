/**
 * The "⋯" menu: secondary and destructive actions of a page (pause, archive,
 * run now), so the page keeps one main action. Closes on a choice, a click
 * outside or Escape. Items are 40px tall for touch.
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { tokens, tone } from "@partnersinbiz/pib-plugin-ui";

export type MenuItem =
  | { kind?: "action"; key: string; label: string; hint?: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | { kind: "link"; key: string; label: string; hint?: string; link: { href?: string; onClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void } }
  | { kind: "separator"; key: string };

const itemStyle: CSSProperties = {
  display: "grid",
  gap: 1,
  width: "100%",
  minHeight: 40,
  padding: "8px 10px",
  border: "none",
  borderRadius: 8,
  background: "transparent",
  color: tokens.fg,
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 500,
  textAlign: "left",
  textDecoration: "none",
  cursor: "pointer",
};

export function MoreMenu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", key);
    list.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  if (items.every((item) => item.kind === "separator")) return null;
  return (
    <div ref={root} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
        style={{ width: 40, height: 40, borderRadius: 10, border: `1px solid ${tokens.border}`, background: tokens.secondary, color: tokens.fg, fontSize: 18, fontWeight: 700, lineHeight: 1, cursor: "pointer", fontFamily: "inherit" }}
      >
        ⋯
      </button>
      {open ? (
        <div
          ref={list}
          role="menu"
          aria-label={label}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 60,
            width: "max-content",
            minWidth: 220,
            maxWidth: "min(300px, calc(100vw - 32px))",
            padding: 6,
            display: "grid",
            gap: 2,
            borderRadius: 12,
            border: `1px solid ${tokens.border}`,
            background: tokens.card,
            boxShadow: "0 12px 32px color-mix(in oklab, black 22%, transparent)",
          }}
        >
          {items.map((item) => {
            if (item.kind === "separator") return <div key={item.key} role="separator" style={{ height: 1, background: tokens.border, margin: "4px 2px" }} />;
            const text = (
              <>
                <span>{item.label}</span>
                {item.hint ? <span style={{ fontSize: 11.5, fontWeight: 400, color: tokens.muted }}>{item.hint}</span> : null}
              </>
            );
            if (item.kind === "link") {
              return (
                <a
                  key={item.key}
                  role="menuitem"
                  className="pib-link-card"
                  {...item.link}
                  onClick={(event) => {
                    setOpen(false);
                    item.link.onClick?.(event);
                  }}
                  style={itemStyle}
                >
                  {text}
                </a>
              );
            }
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className="pib-link-card"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                style={{ ...itemStyle, color: item.danger ? tone("bad").fg : tokens.fg, opacity: item.disabled ? 0.5 : 1, cursor: item.disabled ? "not-allowed" : "pointer" }}
              >
                {text}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
