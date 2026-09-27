/**
 * The page's warning lines (pure, no React). Each problem is one short line
 * with the one link that fixes it, and the same lines show on every tab, in
 * the same place, so the tabs never jump. Detail lives where the link goes.
 */
import { rulesCheckText } from "../rule-labels.js";

export type AlertAction = { kind: "settings" } | { kind: "tab"; tab: "statutory" };

export interface PageAlert {
  key: "settings" | "key" | "storage" | "rules-missing" | "rules-check";
  tone: "warn" | "bad";
  text: string;
  actionLabel: string;
  action: AlertAction;
}

export interface AlertInput {
  settings: { saved: boolean; encryptionKey: boolean; privateStorage: boolean };
  rules: { id: string | null; taxYear: string; unverified: readonly unknown[] };
  rulesReviewed: boolean;
}

export function pageAlerts(s: AlertInput): PageAlert[] {
  const out: PageAlert[] = [];
  const settings = { kind: "settings" } as const;
  if (!s.settings.saved) {
    // One line: the key and storage live in the same settings form.
    out.push({ key: "settings", tone: "warn", text: "Payroll settings aren't saved yet.", actionLabel: "Open settings", action: settings });
  } else {
    if (!s.settings.encryptionKey) out.push({ key: "key", tone: "warn", text: "Set the encryption key before you add staff ID, tax and bank details.", actionLabel: "Open settings", action: settings });
    if (!s.settings.privateStorage) out.push({ key: "storage", tone: "warn", text: "Set up private storage for payslips and bank files.", actionLabel: "Open settings", action: settings });
  }
  if (!s.rules.id) {
    out.push({ key: "rules-missing", tone: "bad", text: `No tax rules are loaded for ${s.rules.taxYear}, so pay runs can't be calculated.`, actionLabel: "Details", action: { kind: "tab", tab: "statutory" } });
  } else if (s.rules.unverified.length && !s.rulesReviewed) {
    out.push({ key: "rules-check", tone: "warn", text: `${rulesCheckText(s.rules.unverified.length)}.`, actionLabel: "Review", action: { kind: "tab", tab: "statutory" } });
  }
  return out;
}
