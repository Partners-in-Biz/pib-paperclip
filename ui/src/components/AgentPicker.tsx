import { useMemo, type ReactNode } from "react";
import { AgentAvatar, type AvatarAgent } from "@/components/AgentAvatar";
import {
  SearchableSelect,
  type SearchableSelectGroup,
  type SearchableSelectOption,
} from "@/components/SearchableSelect";
import { cn } from "@/lib/utils";

export interface AgentPickerAgent extends AvatarAgent {
  id: string;
  name: string;
  title?: string | null;
  role?: string | null;
}

interface AgentOption extends SearchableSelectOption {
  agent: AgentPickerAgent | null;
}

export interface AgentPickerProps {
  agents: readonly AgentPickerAgent[];
  /** Selected agent id, or "" / null for the empty choice. */
  value: string | null | undefined;
  onChange: (agentId: string) => void;
  /** Trigger text when nothing is chosen, e.g. "Pick an agent…". */
  placeholder?: string;
  /** When set, adds a pinned empty choice with this label (e.g. "Unassigned", "Any assignee"). */
  emptyLabel?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  ariaLabel?: string;
  /** Rendered next to the icon in the trigger; defaults to the name only. */
  compact?: boolean;
}

function roleText(agent: AgentPickerAgent): string {
  return (agent.title ?? agent.role ?? "").replaceAll("_", " ");
}

function AgentRow({ agent, compact }: { agent: AgentPickerAgent; compact?: boolean }): ReactNode {
  const role = roleText(agent);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AgentAvatar agent={agent} size={compact ? 20 : 24} className="shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
        {role && !compact ? <span className="truncate text-xs text-muted-foreground">{role}</span> : null}
      </span>
    </span>
  );
}

/**
 * The one agent selector: searchable, icon first, then the name, with the
 * role underneath. Use it instead of a native `<select>` anywhere a person
 * picks an agent.
 */
export function AgentPicker({
  agents,
  value,
  onChange,
  placeholder = "Select agent…",
  emptyLabel,
  searchPlaceholder = "Search by name or role…",
  disabled,
  className,
  triggerClassName,
  contentClassName,
  ariaLabel,
  compact,
}: AgentPickerProps) {
  const groups = useMemo<SearchableSelectGroup<string, AgentOption>[]>(() => {
    const options: AgentOption[] = [];
    if (emptyLabel) {
      options.push({ key: "__none__", value: "", label: emptyLabel, agent: null });
    }
    for (const agent of [...agents].sort((a, b) => a.name.localeCompare(b.name))) {
      options.push({
        key: agent.id,
        value: agent.id,
        label: agent.name,
        searchText: `${agent.title ?? ""} ${agent.role ?? ""}`,
        agent,
      });
    }
    return [{ id: "agents", options }];
  }, [agents, emptyLabel]);

  return (
    <SearchableSelect<string, AgentOption>
      value={value ?? ""}
      groups={groups}
      onValueChange={(next) => onChange(next)}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyMessage="No agents match."
      disabled={disabled}
      className={className}
      triggerClassName={cn("h-auto min-h-8 py-1 font-normal", triggerClassName)}
      contentClassName={contentClassName}
      triggerAriaLabel={ariaLabel}
      mobileTitle={placeholder}
      renderValue={(option) =>
        option?.agent ? (
          <AgentRow agent={option.agent} compact />
        ) : (
          <span className="text-muted-foreground">{option?.label ?? placeholder}</span>
        )
      }
      renderOption={(option) =>
        option.agent ? (
          <AgentRow agent={option.agent} compact={compact} />
        ) : (
          <span className="truncate text-sm text-muted-foreground">{option.label}</span>
        )
      }
    />
  );
}
