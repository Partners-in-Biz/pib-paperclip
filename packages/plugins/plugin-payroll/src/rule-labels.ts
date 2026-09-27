/**
 * Plain names for the rule paths a rule version flags as unconfirmed
 * (`RuleVersion.unverified[].path`, e.g. `treatment.uifFringeBenefits`).
 * People never see the raw path: the Payroll page, the setup checklist and
 * the Cockpit all use `ruleLabel`. Pure, shared by the worker and the page.
 */

/** Known paths (the 2026/27 seed in `seed.ts`). */
export const RULE_LABELS: Readonly<Record<string, string>> = {
  "treatment.uifFringeBenefits": "UIF on fringe benefits",
  "treatment.uifSdlTravelAllowance": "UIF and SDL on travel allowances",
  "statutory.it3aReasonCode": "IT3(a) reason code",
  "leave.annualWorkingDays": "Annual leave in working days",
};

const ACRONYMS: Readonly<Record<string, string>> = {
  uif: "UIF",
  sdl: "SDL",
  paye: "PAYE",
  eti: "ETI",
  it3a: "IT3(a)",
  irp5: "IRP5",
  emp201: "EMP201",
  emp501: "EMP501",
  sars: "SARS",
  bcea: "BCEA",
  ytd: "year-to-date",
};

/** Group names that say nothing on their own ("treatment.x" is just "x"). */
const GENERIC = new Set(["treatment", "statutory", "rules", "rule"]);

function words(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
}

/**
 * `treatment.uifFringeBenefits` → "UIF on fringe benefits". An unknown path
 * becomes readable words ("paye.brackets" → "PAYE brackets"), never the raw key.
 */
export function ruleLabel(path: string | null | undefined): string {
  const key = (path ?? "").trim();
  const known = RULE_LABELS[key];
  if (known) return known;
  const parts = key.split(".").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "A payroll rule";
  const last = words(parts[parts.length - 1]!);
  const parentName = parts.length > 1 ? parts[parts.length - 2]! : "";
  const parent = parentName && !GENERIC.has(parentName.toLowerCase()) ? words(parentName) : [];
  const all = last.length <= 1 && parent.length ? [...parent, ...last] : last;
  const text = all.join(" ").trim();
  if (!text) return "A payroll rule";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The unconfirmed rules with their plain names. */
export function withRuleLabels<T extends { path: string }>(rules: readonly T[]): Array<T & { label: string }> {
  return rules.map((rule) => ({ ...rule, label: ruleLabel(rule.path) }));
}

/** "4 tax rules need your accountant's check" (the same words on the page, in Setup and in the Cockpit). */
export function rulesCheckText(count: number): string {
  return `${count} tax ${count === 1 ? "rule needs" : "rules need"} your accountant's check`;
}
