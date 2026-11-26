import { useMemo } from "react";
import {
  SearchableSelect,
  type SearchableSelectGroup,
  type SearchableSelectOption,
} from "@/components/SearchableSelect";

export interface OptionSelectItem {
  value: string;
  label: string;
  /** Extra text the search also matches (a key, a path, a role). */
  searchText?: string;
  disabled?: boolean;
  /** Optional group heading (an <optgroup>); items sharing a group render together. */
  group?: string;
}

export interface OptionSelectProps {
  items: readonly OptionSelectItem[];
  value: string | null | undefined;
  onChange: (value: string) => void;
  placeholder: string;
  /** Adds a pinned empty choice ("No project", "Any goal"). */
  emptyLabel?: string;
  searchPlaceholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
}

/**
 * Searchable replacement for a native `<select>` over a list of records
 * (projects, secrets, environments). For agents use `AgentPicker`.
 */
export function OptionSelect({
  items,
  value,
  onChange,
  placeholder,
  emptyLabel,
  searchPlaceholder = "Search…",
  ariaLabel,
  id,
  disabled,
  className,
  triggerClassName,
}: OptionSelectProps) {
  const groups = useMemo<SearchableSelectGroup<string, SearchableSelectOption>[]>(() => {
    const toOption = (item: OptionSelectItem): SearchableSelectOption => ({
      key: item.value, value: item.value, label: item.label, searchText: item.searchText, disabled: item.disabled,
    });
    const result: SearchableSelectGroup<string, SearchableSelectOption>[] = [];
    if (emptyLabel) result.push({ id: "__none__", options: [{ key: "__none__", value: "", label: emptyLabel }] });
    const byHeading = new Map<string, SearchableSelectOption[]>();
    for (const item of items) {
      const heading = item.group ?? "";
      const list = byHeading.get(heading) ?? [];
      list.push(toOption(item));
      byHeading.set(heading, list);
    }
    for (const [heading, options] of byHeading) result.push({ id: `g:${heading}`, label: heading || undefined, options });
    return result;
  }, [items, emptyLabel]);
  return (
    <SearchableSelect
      value={value ?? ""}
      groups={groups}
      onValueChange={(next) => onChange(next)}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      disabled={disabled}
      className={className}
      triggerClassName={triggerClassName}
      triggerAriaLabel={ariaLabel}
      triggerId={id}
      mobileTitle={placeholder}
    />
  );
}
