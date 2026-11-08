import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { tokens } from "./tokens.js";

/** A select with more options than this turns into a searchable list. */
export const SEARCHABLE_SELECT_THRESHOLD = 10;

export interface FlatOption {
  value: string;
  label: string;
  disabled: boolean;
  group: string | null;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/**
 * Reads `<option>` / `<optgroup>` children (through fragments and arrays) into a flat list.
 * Returns null when the children hold anything else (a custom component), so the caller keeps the native select.
 */
export function flattenOptions(children: ReactNode): FlatOption[] | null {
  const out: FlatOption[] = [];
  let ok = true;
  const walk = (nodes: ReactNode, group: string | null) => {
    Children.forEach(nodes, (child) => {
      if (!ok || child == null || typeof child === "boolean") return;
      if (typeof child === "string" || typeof child === "number") {
        if (String(child).trim()) ok = false;
        return;
      }
      if (!isValidElement(child)) return;
      const props = child.props as { value?: unknown; disabled?: boolean; label?: string; children?: ReactNode };
      if (child.type === Fragment) walk(props.children, group);
      else if (child.type === "optgroup") walk(props.children, props.label ?? "");
      else if (child.type === "option") {
        const label = textOf(props.children);
        out.push({ value: props.value == null ? label : String(props.value), label, disabled: Boolean(props.disabled), group });
      } else ok = false;
    });
  };
  walk(children, null);
  return ok ? out : null;
}

/** Case-insensitive; every word typed must appear in the option's label (or its group's). */
export function filterOptions(options: FlatOption[], query: string): FlatOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const hay = `${o.label} ${o.group ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

const POPOVER_MAX = 320;

/**
 * Searchable stand-in for a long `<select>`: the same props and the same `onChange(event.target.value)`,
 * with a search box on top of the list. Used by `Select` once it has more than SEARCHABLE_SELECT_THRESHOLD options.
 */
export function SearchableSelect({
  options,
  base,
  focusRing,
  ...props
}: SelectProps & { options: FlatOption[]; base: CSSProperties; focusRing: CSSProperties }) {
  const { value, defaultValue, onChange, disabled, name, style, className, children: _children, multiple: _m, size: _s, ...rest } = props;
  const listId = useId();
  const [inner, setInner] = useState<string>(() => (defaultValue == null ? (options[0]?.value ?? "") : String(defaultValue)));
  const current = value === undefined ? inner : String(value ?? "");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => filterOptions(options, query), [options, query]);
  const selected = options.find((o) => o.value === current) ?? options[0];

  const place = () => {
    const el = buttonRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const width = Math.min(Math.max(r.width, 240), vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    if (below >= 220 || below >= above) setBox({ left, top: r.bottom + 4, width, maxHeight: Math.min(POPOVER_MAX, Math.max(160, below)) });
    else setBox({ left, bottom: vh - r.top + 4, width, maxHeight: Math.min(POPOVER_MAX, Math.max(160, above)) });
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) buttonRef.current?.focus();
  };

  const openList = () => {
    if (disabled) return;
    place();
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  };

  const choose = (option: FlatOption) => {
    if (option.disabled) return;
    if (value === undefined) setInner(option.value);
    const target = { value: option.value, name: name ?? "" };
    onChange?.({ target, currentTarget: target, type: "change" } as unknown as ChangeEvent<HTMLSelectElement>);
    close(true);
  };

  useLayoutEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Close on an outside click, on resize, and when the page behind scrolls.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close(false);
    };
    const scroll = (e: Event) => {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) return;
      close(false);
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", down);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home" && e.ctrlKey) {
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      setActive(Math.max(0, shown.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = shown[active];
      if (o) choose(o);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openList();
    }
  };

  let lastGroup: string | null = null;
  return (
    <div ref={wrapRef} className="pib-select" style={{ position: "relative", display: "inline-block", minWidth: 0, maxWidth: "100%", verticalAlign: "middle" }}>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={rest["aria-label"]}
        aria-labelledby={rest["aria-labelledby"]}
        id={rest.id}
        title={rest.title}
        autoFocus={rest.autoFocus}
        disabled={disabled}
        className={className}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onButtonKey}
        onFocus={(e) => {
          e.currentTarget.style.boxShadow = focusRing.boxShadow as string;
        }}
        onBlur={(e) => {
          e.currentTarget.style.boxShadow = "none";
        }}
        style={{
          ...base,
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          ...style,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected?.label ?? ""}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: "none", opacity: 0.6 }}>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      {open && box ? createPortal(
        <div
          ref={popRef}
          style={{
            position: "fixed",
            left: box.left,
            top: box.top,
            bottom: box.bottom,
            width: box.width,
            zIndex: 2147483000,
            display: "flex",
            flexDirection: "column",
            maxHeight: box.maxHeight,
            background: tokens.bg,
            color: tokens.fg,
            border: `1px solid ${tokens.border}`,
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.28)",
            fontSize: 13,
            fontFamily: "inherit",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: 6, borderBottom: `1px solid ${tokens.border}`, flex: "none" }}>
            <input
              ref={searchRef}
              type="text"
              role="searchbox"
              aria-label="Search options"
              aria-controls={listId}
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              placeholder={`Search ${options.length} options…`}
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
              style={{ ...base, width: "100%", height: 32, boxShadow: "none", fontSize: window.innerWidth < 640 ? 16 : 13 }}
            />
          </div>
          <div ref={listRef} id={listId} role="listbox" style={{ overflowY: "auto", padding: 4, flex: "1 1 auto", overscrollBehavior: "contain" }}>
            {shown.length === 0 ? (
              <div style={{ padding: "8px 10px", color: tokens.muted }}>No matches</div>
            ) : (
              shown.map((o, i) => {
                const header = o.group && o.group !== lastGroup ? o.group : null;
                lastGroup = o.group;
                const isSel = o.value === current;
                return (
                  <Fragment key={`${o.value}:${i}`}>
                    {header ? <div style={{ padding: "6px 10px 2px", fontSize: 11, fontWeight: 600, color: tokens.muted, textTransform: "uppercase", letterSpacing: ".04em" }}>{header}</div> : null}
                    <div
                      id={`${listId}-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={isSel}
                      aria-disabled={o.disabled || undefined}
                      onMouseEnter={() => setActive(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(o)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 10px",
                        borderRadius: 6,
                        cursor: o.disabled ? "not-allowed" : "pointer",
                        opacity: o.disabled ? 0.45 : 1,
                        background: i === active ? tokens.accent : "transparent",
                        fontWeight: isSel ? 600 : 400,
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{o.label || " "}</span>
                      {isSel ? <span aria-hidden="true">✓</span> : null}
                    </div>
                  </Fragment>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
