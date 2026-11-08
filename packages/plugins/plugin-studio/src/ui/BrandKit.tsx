/**
 * The card's brand kit box (PAR-8134): the canvas client's kit from the CRM, shown in full, and one button that adds
 * the exact kit text to the card's own prompt, where the person sees and can edit it. Nothing is added without that
 * click, and the text then travels with the prompt into the generation and its Provenance.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Button, errorText } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "./action.js";
import { withBrandKit } from "../brand-kit-text.js";

export interface BrandKitData {
  client: string | null;
  clientName: string | null;
  kit: { primaryColor: string | null; secondaryColor: string | null; accentColor: string | null; hasLogo: boolean } | null;
  promptText: string;
  note: string;
}

const muted: CSSProperties = { color: "var(--muted-foreground)", fontSize: "var(--text-xs, 12px)", overflowWrap: "anywhere" };
const box: CSSProperties = { display: "grid", gap: 6, padding: 8, border: "1px solid var(--border)", borderRadius: 6 };
const swatch = (c: string): CSSProperties => ({ width: 14, height: 14, borderRadius: 3, background: c, border: "1px solid var(--border)", display: "inline-block" });

export function BrandKitBox({ companyId, client, prompt, disabled, onAdd }: { companyId: string; client: string; prompt: string; disabled: boolean; onAdd: (prompt: string) => void }) {
  const load = useStudioAction("brand-kit");
  const [data, setData] = useState<BrandKitData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    if (client === "own") return;
    load({ companyId, client })
      .then((out) => live && setData(out as BrandKitData))
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
    // `load` is a new function each render; the kit depends only on the client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, client]);

  if (client === "own") return null;
  const added = Boolean(data?.promptText) && prompt.includes(data!.promptText);
  const next = data?.promptText ? withBrandKit(prompt, data.promptText) : null;
  const colors = [data?.kit?.primaryColor, data?.kit?.secondaryColor, data?.kit?.accentColor].filter((c): c is string => Boolean(c));
  return (
    <section aria-label="Brand kit" style={box}>
      <strong style={{ fontSize: 13 }}>Brand kit{data?.clientName ? `: ${data.clientName}` : ""}</strong>
      {error ? <span role="alert" style={{ ...muted, color: "var(--destructive)" }}>{error}</span> : null}
      {!data && !error ? <span style={muted}>Loading the brand kit from the CRM…</span> : null}
      {colors.length ? (
        <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {colors.map((c) => <span key={c} title={c} aria-label={`Colour ${c}`} style={swatch(c)} />)}
        </span>
      ) : null}
      {data?.promptText ? <pre aria-label="Brand kit text" style={{ ...muted, whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit" }}>{data.promptText}</pre> : null}
      {data?.note ? <span style={muted}>{data.note}</span> : null}
      {data?.promptText ? (
        added ? <span role="status" style={muted}>Added to this card's prompt. Edit the prompt to change or remove it.</span> : (
          <Button variant="secondary" disabled={disabled || next === null} onClick={() => next !== null && onAdd(next)}>
            {next === null ? "Prompt too long to add the brand kit" : "Add brand kit to prompt"}
          </Button>
        )
      ) : null}
    </section>
  );
}
