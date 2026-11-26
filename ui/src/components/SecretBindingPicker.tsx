import { createContext, useContext, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, KeyRound, Loader2, Plus, X } from "lucide-react";
import type { CompanySecret, SecretVersionSelector } from "@paperclipai/shared";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/OptionSelect";
import {
  SearchableSelect,
  type SearchableSelectGroup,
  type SearchableSelectOption,
} from "@/components/SearchableSelect";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "../lib/utils";

export interface SecretBindingValue {
  secretId: string;
  version?: SecretVersionSelector;
}

/**
 * Metadata for bound secrets the current company's list cannot show — e.g.
 * an instance-scoped environment referencing a secret owned by another
 * company. Keyed by secret id. Editors that can read instance-level
 * secret-ref descriptors provide it; everywhere else the context is absent
 * and the picker falls back to its generic missing-secret treatment.
 */
export interface SecretRefHint {
  name: string;
  status: string;
  companyId: string;
  companyName: string | null;
}

/**
 * `status` reports the descriptor request itself, so the picker never claims
 * a secret is missing while the lookup is still loading or has failed —
 * only a `ready` map is authoritative about unknown ids.
 */
export interface SecretRefHintsContextValue {
  status: "loading" | "error" | "ready";
  hints: Record<string, SecretRefHint>;
}

export const SecretRefHintsContext = createContext<SecretRefHintsContextValue | undefined>(undefined);

interface SecretBindingPickerProps {
  value: SecretBindingValue | null;
  onChange: (next: SecretBindingValue | null) => void;
  label?: string;
  placeholder?: string;
  allowVersionSelector?: boolean;
  emptyHint?: string;
  className?: string;
  disabled?: boolean;
  /**
   * Optional whitelist of secret statuses to show. Defaults to "active".
   * Pass null to disable the filter and show every secret in the company.
   */
  statusFilter?: Array<CompanySecret["status"]> | null;
}

type SecretPickerOption = SearchableSelectOption<string>;

const VERSION_LATEST: SecretVersionSelector = "latest";

function describeSecret(secret: CompanySecret): string {
  const provider = secret.provider.replaceAll("_", " ");
  if (secret.managedMode === "external_reference") {
    return `External · ${provider}`;
  }
  return provider;
}

function statusTone(status: CompanySecret["status"]): string {
  switch (status) {
    case "active":
      return "text-emerald-600 dark:text-emerald-400";
    case "disabled":
      return "text-amber-600 dark:text-amber-400";
    case "archived":
      return "text-muted-foreground";
    case "deleted":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

export function SecretBindingPicker({
  value,
  onChange,
  label = "Secret",
  placeholder = "Select secret",
  allowVersionSelector = true,
  emptyHint = "No matching secrets. Create one to bind it here.",
  className,
  disabled,
  statusFilter = ["active"],
}: SecretBindingPickerProps) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createValue, setCreateValue] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.list(selectedCompanyId)
      : ["secrets", "__disabled__"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const filteredSecrets = useMemo(() => {
    const all = secretsQuery.data ?? [];
    if (statusFilter === null) return all;
    return all.filter((secret) => statusFilter.includes(secret.status));
  }, [secretsQuery.data, statusFilter]);

  const selectedSecret = useMemo(() => {
    if (!value) return null;
    return (secretsQuery.data ?? []).find((secret) => secret.id === value.secretId) ?? null;
  }, [secretsQuery.data, value]);

  const selectedMissing = Boolean(value && !selectedSecret);
  const hintsContext = useContext(SecretRefHintsContext);
  const missingHint = selectedMissing && value ? hintsContext?.hints[value.secretId] : undefined;
  // Only an active cross-company secret is healthy: runtime resolution
  // rejects disabled/archived/deleted secrets, so those must not be
  // presented as working bindings.
  const crossCompanyHint = missingHint && missingHint.status === "active" ? missingHint : undefined;
  const hintsPending = selectedMissing && !missingHint && hintsContext !== undefined && hintsContext.status !== "ready";
  const calmMissing = Boolean(crossCompanyHint) || hintsPending;

  const createMutation = useMutation({
    mutationFn: () =>
      secretsApi.create(selectedCompanyId!, {
        name: createName.trim(),
        value: createValue,
        description: createDescription.trim() || null,
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
      onChange({ secretId: created.id, version: VERSION_LATEST });
      setCreateOpen(false);
      setCreateName("");
      setCreateValue("");
      setCreateDescription("");
      setCreateError(null);
    },
    onError: (error) => {
      setCreateError(error instanceof Error ? error.message : "Failed to create secret");
    },
  });

  const missingLabel =
    selectedMissing && value
      ? missingHint
        ? `${missingHint.name} — ${missingHint.companyName ?? "another organization"}`
        : hintsPending
          ? `Secret (${value.secretId.slice(0, 8)}…)`
          : `Missing secret (${value.secretId.slice(0, 8)}…)`
      : null;
  const secretGroups = useMemo<SearchableSelectGroup<string, SecretPickerOption>[]>(() => {
    const options: SecretPickerOption[] = [
      { key: "__none__", value: "", label: secretsQuery.isPending ? "Loading…" : placeholder },
    ];
    if (missingLabel && value) {
      options.push({ key: `missing-${value.secretId}`, value: value.secretId, label: missingLabel });
    }
    for (const secret of filteredSecrets) {
      options.push({
        key: secret.id,
        value: secret.id,
        label: `${secret.name} — ${describeSecret(secret)}`,
        searchText: `${secret.key} ${secret.name}`,
      });
    }
    return [{ id: "secrets", options }];
  }, [filteredSecrets, missingLabel, placeholder, secretsQuery.isPending, value]);

  const versionDisplay = (selector: SecretVersionSelector | undefined) => {
    if (selector === undefined || selector === VERSION_LATEST) return "latest";
    return `v${selector}`;
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <div className="flex items-center justify-between text-xs font-medium text-foreground/80">
          <span>{label}</span>
          {value ? (
            <button
              type="button"
              className="text-(length:--text-micro) text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              onClick={() => onChange(null)}
              disabled={disabled}
            >
              <X className="h-3 w-3" /> Clear
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <KeyRound className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <SearchableSelect<string, SecretPickerOption>
            value={value?.secretId ?? ""}
            groups={secretGroups}
            onValueChange={(next) => {
              if (!next) {
                onChange(null);
                return;
              }
              onChange({ secretId: next, version: value?.version ?? VERSION_LATEST });
            }}
            placeholder={secretsQuery.isPending ? "Loading…" : placeholder}
            searchPlaceholder="Search secrets…"
            emptyMessage="No secrets match."
            disabled={disabled || secretsQuery.isPending}
            mobileTitle="Select secret"
            triggerClassName={cn(
              "h-9 pl-7 pr-2 text-sm font-normal",
              selectedMissing && !calmMissing && "border-destructive text-destructive",
            )}
          />
        </div>
        {allowVersionSelector ? (
          <OptionSelect
            ariaLabel="Version"
            className="w-24"
            triggerClassName="h-9 px-2 text-xs font-normal"
            value={value?.version === undefined ? "latest" : String(value.version)}
            disabled={disabled || !value || !selectedSecret}
            placeholder="latest"
            searchPlaceholder="Search versions…"
            items={[
              { value: "latest", label: "latest" },
              ...(selectedSecret
                ? Array.from({ length: Math.max(0, selectedSecret.latestVersion) }, (_, index) => selectedSecret.latestVersion - index)
                    .filter((version) => version > 0)
                    .map((version) => ({ value: String(version), label: `v${version}` }))
                : []),
            ]}
            onChange={(raw) => {
              if (!value) return;
              const next: SecretVersionSelector = raw === "latest" ? VERSION_LATEST : Number.parseInt(raw, 10);
              onChange({ ...value, version: next });
            }}
          />
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setCreateOpen(true)}
          disabled={disabled || !selectedCompanyId}
          aria-label="Create secret"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {selectedSecret ? (
        <p className={cn("text-(length:--text-micro) text-muted-foreground", statusTone(selectedSecret.status))}>
          {selectedSecret.status !== "active" ? `Status: ${selectedSecret.status}. ` : null}
          Bound to {versionDisplay(value?.version)} · {selectedSecret.key}
        </p>
      ) : crossCompanyHint ? (
        <p className="text-(length:--text-micro) text-muted-foreground flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          Owned by {crossCompanyHint.companyName ? `the ${crossCompanyHint.companyName} organization` : "another organization"}. The binding keeps working; selecting a secret from this list re-points it here.
        </p>
      ) : missingHint ? (
        <p className="text-(length:--text-micro) text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {missingHint.status === "deleted"
            ? "The previously selected secret was deleted. Pick another or remove the binding."
            : `This secret is ${missingHint.status}; runs cannot resolve it until it is active again.`}
        </p>
      ) : hintsPending ? (
        <p className="text-(length:--text-micro) text-muted-foreground flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {hintsContext?.status === "error"
            ? "Could not load this secret reference's details."
            : "Checking this secret reference…"}
        </p>
      ) : selectedMissing ? (
        <p className="text-(length:--text-micro) text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          The previously selected secret is no longer available. Pick another or remove the binding.
        </p>
      ) : (filteredSecrets.length === 0 && !secretsQuery.isPending) ? (
        <p className="text-(length:--text-micro) text-muted-foreground">{emptyHint}</p>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create new secret</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-foreground/80" htmlFor="secret-name">Name</label>
              <Input
                id="secret-name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="OPENAI_API_KEY"
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground/80" htmlFor="secret-value">Value</label>
              <Textarea
                id="secret-value"
                value={createValue}
                onChange={(event) => setCreateValue(event.target.value)}
                rows={3}
                placeholder="Paste the secret value"
                className="font-mono text-xs"
              />
              <p className="text-(length:--text-micro) text-muted-foreground mt-1">
                The value is stored once and never re-displayed. Rotate to replace.
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-foreground/80" htmlFor="secret-description">Description</label>
              <Input
                id="secret-description"
                value={createDescription}
                onChange={(event) => setCreateDescription(event.target.value)}
                placeholder="Optional notes (no values)"
              />
            </div>
            {createError ? <p className="text-xs text-destructive">{createError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={!createName.trim() || !createValue || createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Create &amp; bind
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
