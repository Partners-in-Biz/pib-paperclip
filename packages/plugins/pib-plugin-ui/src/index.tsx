import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type FormEvent,
  type InputHTMLAttributes,
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
  minWidth: 140,
};

export function Page({ title, description, children, message, actions }: {
  title: string;
  description: string;
  children: ReactNode;
  message?: string;
  actions?: ReactNode;
}) {
  return (
    <main style={{
      fontFamily: font,
      color: tokens.fg,
      padding: 24,
      maxWidth: 1120,
      display: "grid",
      gap: 20,
    }}>
      <PageHeader title={title} description={description} actions={actions} />
      {message ? (
        <p
          role="status"
          style={{
            margin: 0,
            fontSize: 13,
            padding: "10px 12px",
            borderRadius: 10,
            border: `1px solid ${tokens.border}`,
            background: tokens.secondary,
            color: tokens.secondaryFg,
          }}
        >
          {message}
        </p>
      ) : null}
      {children}
    </main>
  );
}

export function PageHeader({ title, description, actions }: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header style={{ display: "flex", gap: 16, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>{title}</h1>
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted, lineHeight: 1.45 }}>{description}</p>
      </div>
      {actions ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div> : null}
    </header>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section style={{
      display: "grid",
      gap: 12,
      padding: 16,
      borderRadius: 12,
      border: `1px solid ${tokens.border}`,
      background: tokens.card,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase", color: tokens.muted }}>
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Tabs({ tabs, active, onChange }: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="tablist" style={{ display: "flex", gap: 4, borderBottom: `1px solid ${tokens.border}`, paddingBottom: 0 }}>
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
              padding: "8px 12px",
              cursor: "pointer",
              borderBottom: selected ? `2px solid ${tokens.fg}` : "2px solid transparent",
              marginBottom: -1,
              fontFamily: "inherit",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toolbar({ children, search, onSearchChange, searchPlaceholder = "Search…" }: {
  children?: ReactNode;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
      {onSearchChange ? (
        <Input
          aria-label="Search"
          value={search ?? ""}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          style={{ minWidth: 220, flex: "1 1 200px" }}
        />
      ) : <div />}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>
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
      gap: 8,
      placeItems: "center",
      textAlign: "center",
      padding: "36px 16px",
      borderRadius: 12,
      border: `1px dashed ${tokens.border}`,
      background: tokens.bg,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      {description ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted, maxWidth: 360 }}>{description}</p> : null}
      {action}
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
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
      gap: 10,
      padding: 14,
      borderRadius: 12,
      border: `1px solid ${tokens.border}`,
      background: tokens.card,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: tokens.muted, textTransform: "uppercase", letterSpacing: "0.02em" }}>
        {title}
      </div>
      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No data yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((item, index) => (
            <div key={item.label} style={{ display: "grid", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span>{item.label}</span>
                <span style={{ color: tokens.muted, fontVariantNumeric: "tabular-nums" }}>{item.value}</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: tokens.secondary, overflow: "hidden" }}>
                <div style={{
                  width: `${Math.max((item.value / max) * 100, item.value > 0 ? 4 : 0)}%`,
                  height: "100%",
                  background: item.color ?? tokens.chart[index % tokens.chart.length],
                  borderRadius: 999,
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
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(180px, 1fr))`,
      gap: 10,
      overflowX: "auto",
      paddingBottom: 4,
    }}>
      {columns.map((column) => (
        <div key={column.id} style={{
          display: "grid",
          gap: 8,
          alignContent: "start",
          minWidth: 180,
          padding: 10,
          borderRadius: 12,
          border: `1px solid ${tokens.border}`,
          background: tokens.bg,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
            <strong style={{ fontSize: 12, letterSpacing: "0.02em", textTransform: "uppercase", color: tokens.muted }}>{column.title}</strong>
            {column.meta ? <span style={{ fontSize: 11, color: tokens.muted }}>{column.meta}</span> : null}
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
        gap: 4,
        width: "100%",
        padding: 10,
        borderRadius: 10,
        border: `1px solid ${tokens.border}`,
        background: tokens.card,
        color: tokens.fg,
        cursor: onClick ? "pointer" : "default",
        fontFamily: "inherit",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      {subtitle ? <div style={{ fontSize: 12, color: tokens.muted }}>{subtitle}</div> : null}
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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus();
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
        background: "color-mix(in oklab, black 45%, transparent)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          width: "min(480px, 100%)",
          maxHeight: "90vh",
          overflow: "auto",
          borderRadius: 14,
          border: `1px solid ${tokens.border}`,
          background: tokens.card,
          color: tokens.fg,
          boxShadow: "0 18px 50px color-mix(in oklab, black 35%, transparent)",
          display: "grid",
          gap: 14,
          padding: 18,
          fontFamily: font,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div style={{ display: "grid", gap: 4 }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
            {description ? <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>{description}</p> : null}
          </div>
          <Button type="button" variant="secondary" onClick={onClose} aria-label="Close" style={{ minWidth: 0, padding: "0 10px" }}>×</Button>
        </div>
        <div style={{ display: "grid", gap: 12 }}>{children}</div>
        {footer ? <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>{footer}</div> : null}
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
        background: "color-mix(in oklab, black 35%, transparent)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: "min(420px, 100%)",
          height: "100%",
          background: tokens.card,
          borderLeft: `1px solid ${tokens.border}`,
          color: tokens.fg,
          padding: 18,
          display: "grid",
          gap: 14,
          alignContent: "start",
          overflow: "auto",
          fontFamily: font,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
          <Button type="button" variant="secondary" onClick={onClose} aria-label="Close" style={{ minWidth: 0, padding: "0 10px" }}>×</Button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6, fontSize: 12, color: tokens.muted }}>
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
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
      {children}
    </ul>
  );
}

export function ListItem({ children }: { children: ReactNode }) {
  return (
    <li style={{
      fontSize: 13,
      lineHeight: 1.4,
      padding: "8px 10px",
      borderRadius: 8,
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
      style={{ display: "grid", gap: 12 }}
    >
      {children}
    </form>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...fieldBase, width: "100%", minWidth: 0, ...((props.style as CSSProperties) ?? {}) }} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ ...fieldBase, width: "100%", minWidth: 0, ...((props.style as CSSProperties) ?? {}) }} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      style={{
        ...fieldBase,
        height: "auto",
        minHeight: 72,
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
      style={{
        height: 36,
        borderRadius: 8,
        padding: "0 12px",
        fontSize: 13,
        fontWeight: 550,
        fontFamily: "inherit",
        cursor: "pointer",
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
