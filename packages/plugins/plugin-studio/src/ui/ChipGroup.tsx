/** A segmented row of filter chips; a count shows after the label when given. */
export function ChipGroup({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string, number?]> }) {
  return (
    // One row that scrolls sideways on a phone rather than wrapping inside the pill.
    <div role="group" aria-label={label} style={{ display: "inline-flex", flexWrap: "nowrap", overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "none", gap: 2, padding: 2, border: "1px solid var(--border)", borderRadius: 999, maxWidth: "100%" }}>
      {options.map(([v, text, n]) => (
        <button
          key={v || "all"}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          style={{ border: 0, borderRadius: 999, padding: "4px 12px", minHeight: 32, font: "inherit", fontSize: 13, cursor: "pointer", color: value === v ? "var(--foreground)" : "var(--muted-foreground)", background: value === v ? "var(--accent, var(--muted))" : "transparent", fontWeight: value === v ? 600 : 400 }}
        >
          {text}
          {typeof n === "number" ? <span style={{ marginLeft: 6, opacity: 0.7 }}>{n}</span> : null}
        </button>
      ))}
    </div>
  );
}

