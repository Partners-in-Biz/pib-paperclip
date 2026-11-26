import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OptionSelect } from "@/components/OptionSelect";

/** Providers supply only credentials the current user is authorized to use.
 * Values are opaque connection references, never secret values. */
export function ApiKeyCredentialField({ options, connectionId, onConnectionChange, value, onChange,
  disabled, loading, error, providerName, keysUrl, label = "API key" }: {
  options: { id: string; label: string; disabled?: boolean }[];
  connectionId: string | null;
  onConnectionChange(id: string): void;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  providerName: string;
  keysUrl: string;
  label?: string;
}) {
  const id = useId();
  const choices = connectionId && !options.some(option => option.id === connectionId)
    ? [{ id: connectionId, label: loading ? "Checking saved API key…" : "Previously selected key · unavailable", disabled: true }, ...options] : options;
  return <div className="space-y-2">
    <Label htmlFor={choices.length ? undefined : id}>{label}</Label>
    {choices.length > 0 && <OptionSelect
      ariaLabel={label}
      items={[
        ...choices.map(option => ({ value: option.id, label: option.label, disabled: option.disabled })),
        { value: "", label: "Enter a new API key" },
      ]}
      value={connectionId ?? ""}
      disabled={disabled}
      onChange={onConnectionChange}
      placeholder="Enter a new API key"
      triggerClassName="h-auto py-2 text-sm font-normal"
    />}
    {!connectionId && <Input id={choices.length ? `${id}-new` : id} aria-label={choices.length ? "New API key" : undefined}
      type="password" autoComplete="off" value={value} disabled={disabled}
      onChange={event => { onConnectionChange(""); onChange(event.target.value); }} placeholder={`Paste your ${providerName} API key`} />}
    {loading && <p role="status" className="text-sm text-muted-foreground">Checking saved API keys…</p>}
    {error && <p role="alert" className="text-sm text-destructive">Could not load saved API keys. {error}</p>}
    <a href={keysUrl} target="_blank" rel="noreferrer" className="text-sm underline">Get an {providerName} API key ↗</a>
  </div>;
}
