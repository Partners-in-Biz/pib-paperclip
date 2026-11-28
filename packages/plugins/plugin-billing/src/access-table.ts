/**
 * Who may do what in Billing (access stage A, spec PAR-12578 sections 4.4 and 4.6; PAR-12675). Keys: action key,
 * `tool:<name>`, `api:<routeKey>`. Owners and admins always pass; a limited person needs the permission named here.
 * With the company switch `off` (every company today) the guard passes every call on unchanged.
 * `tests/access.spec.ts` fails on a missing or stale row.
 *
 * - `view` reads, `create` adds a record, `edit` changes one or asks a person for a decision (a send, a payment check),
 *   `delete` cancels or removes one.
 * - `billing.invoices:approve`: what moves money or reaches a client without a further approval (mark sent, send a
 *   credit note or statement, record a payment or refund, credits, write-offs, proofs of payment, reminders run now,
 *   a retried send). Turning on automatic sending of a recurring invoice or subscription needs it too, on top of the
 *   `billing.plans` row (`AUTO_SEND_ACTIONS`).
 * - `billing.invoices:export`: the Drive catch-up of sent PDFs.
 * - `billing.plans`: recurring invoices, retainer plans and subscriptions.
 * - `billing.settings:edit` (`set-numbering`): a client's invoice letters and next number; the company sequence also
 *   needs a person. Grantable to non-admins on purpose, like the other `*.settings:edit`.
 * - `billing.bank` has no row: the bank details are read and saved only through the preferences, which the kit keeps
 *   to owners and admins (a save) or shows masked to anyone else (a read).
 * - `ADMIN_ONLY`: the company preferences save and the skill sync (the kit checks owner or admin there already).
 *
 * A tool has the permission of the action it runs (`TOOL_ACTIONS`). Rows in `SCOPED_ACTION_KEYS` and
 * `api:client-summary` are `scoped` (stage B-4): an own-companies grant opens them for his companies' customers only;
 * every other row stays closed to that grant.
 *
 * `api:invoice-grant` is named on purpose: it is Billing's old fall-through route (the Partners page shares an
 * invoice through it) and is now registered by name, so an unknown route key is refused under `report` and `enforce`.
 */
import type { AccessTable, AccessTableEntry, ADMIN_ONLY as KIT_ADMIN_ONLY, PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const ADMIN_ONLY: typeof KIT_ADMIN_ONLY = "ADMIN_ONLY";
const on = (resource: string) => (action: PermissionAction): AccessTableEntry => ({ resource, action });
const invoices = on("billing.invoices");
const quotes = on("billing.quotes");
const expenses = on("billing.expenses");
const bills = on("billing.bills");
const time = on("billing.time");
const plans = on("billing.plans");
const reports = on("billing.reports");
const settings = on("billing.settings");
const rows = (entry: AccessTableEntry, keys: readonly string[]) => Object.fromEntries(keys.map((key) => [`billing.${key}`, entry]));

/**
 * Stage B-4 (plan B-D6, PAR-12581): rows a `linked` grant may use, because the worker checks each call's customer
 * against his companies and lists filter their rows (`customer-scope.ts` `CUSTOMER_RULES`, the same keys). Everything
 * else stays closed to him: reports, cockpit, the company-wide payments status, dunning, bills, expenses, settings,
 * numbering, the Drive catch-up, journal retries, test payments and the Planning Canvas cards.
 */
export const SCOPED_ACTION_KEYS: readonly string[] = Object.freeze([
  "load", "open-invoices", "list-quotes", "list-credit-notes", "pops", "list-time", "list-recurring", "retainers",
  "invoice-html", "invoice-detail", "invoice-pdf", "invoice-payments", "add-line", "update-line", "remove-line", "update-invoice",
  "set-invoice-tax", "request-send", "request-pay", "request-payment-check", "request-reminder-send", "mark-sent", "cancel-invoice",
  "delete-draft-invoice", "record-payment", "create-credit-note", "apply-credit", "write-off", "record-refund", "create-payment-link",
  "payment-links", "register-pop", "document-pdf", "retry-send", "log-follow-up", "bill-time", "create-recurring", "create-invoice",
  "upload-url", "quote-html", "quote-detail", "add-quote-line", "update-quote-line", "remove-quote-line", "update-quote",
  "set-quote-status", "request-quote-send", "delete-draft-quote", "convert-quote", "create-quote", "credit-note-pdf", "send-credit-note",
  "statement-pdf", "send-statement", "customer-credit", "pop-file", "reject-pop", "confirm-pop", "link-pop", "cancel-payment-link",
  "start-timer", "log-time", "stop-timer", "delete-time-entry", "pause-recurring", "resume-recurring", "update-recurring",
  "create-subscription", "set-subscription-status",
].map((key) => `billing.${key}`));

const SCOPED = new Set(SCOPED_ACTION_KEYS);
/** The row of a scoped key gets `scoped: true`; a scoped key must be a permission row. */
const scope = (table: Record<string, AccessTableEntry>): Readonly<Record<string, AccessTableEntry>> => {
  for (const key of SCOPED) {
    const entry = table[key];
    if (!entry || typeof entry !== "object" || !("resource" in entry)) throw new Error(`Billing access table: ${key} cannot be scoped`);
    table[key] = Object.freeze({ ...entry, scoped: true as const });
  }
  return Object.freeze(table);
};

/** Page and tool actions, keyed by action key. */
const ACTION_ROWS: Readonly<Record<string, AccessTableEntry>> = scope({
  ...rows(invoices("view"), [
    "load", "invoice-html", "invoice-detail", "document-pdf", "invoice-pdf", "open-invoices", "invoice-payments",
    "payment-links", "list-credit-notes", "credit-note-pdf", "statement-pdf", "customer-credit", "pops", "pop-file", "dunning",
  ]),
  ...rows(invoices("create"), ["create-invoice", "add-line", "create-payment-link", "register-pop", "upload-url", "convert-quote", "bill-time"]),
  ...rows(invoices("edit"), [
    "update-line", "remove-line", "update-invoice", "set-invoice-tax", "request-send", "request-pay",
    "request-payment-check", "request-reminder-send", "cancel-payment-link", "log-follow-up", "set-dunning-optout", "retry-ledger",
  ]),
  ...rows(invoices("delete"), ["cancel-invoice", "delete-draft-invoice"]),
  ...rows(invoices("approve"), [
    "mark-sent", "record-payment", "create-credit-note", "send-credit-note", "send-statement", "apply-credit", "write-off",
    "confirm-pop", "link-pop", "reject-pop", "record-refund", "simulate-payment", "run-dunning", "retry-send",
  ]),
  ...rows(invoices("export"), ["drive-catchup"]),
  // Planning Canvas invoice cards (PAR-14389): reading invoices, so `view` (not prefixed `billing.`).
  ...Object.fromEntries(["canvas.cards.resolve", "canvas.cards.search", "canvas.cards.related"].map((key) => [key, invoices("view")])),

  ...rows(quotes("view"), ["quote-html", "quote-detail", "list-quotes"]),
  ...rows(quotes("create"), ["create-quote", "add-quote-line"]),
  ...rows(quotes("edit"), ["update-quote-line", "remove-quote-line", "update-quote", "set-quote-status", "request-quote-send"]),
  ...rows(quotes("delete"), ["delete-draft-quote"]),

  ...rows(expenses("view"), ["receipt-file"]),
  ...rows(expenses("create"), ["create-expense", "receipt-to-expense"]),
  ...rows(expenses("edit"), ["update-expense", "correct-decision"]),
  ...rows(expenses("delete"), ["void-expense"]),

  ...rows(bills("view"), ["bill-detail", "bill-file", "list-bills"]),
  ...rows(bills("create"), ["create-bill", "add-bill-line", "attach-bill-file"]),
  ...rows(bills("edit"), ["remove-bill-line", "update-bill", "request-bill-approval"]),
  ...rows(bills("delete"), ["cancel-bill"]),
  ...rows(bills("approve"), ["approve-bill", "pay-bill"]),

  ...rows(time("view"), ["list-time"]),
  ...rows(time("create"), ["start-timer", "log-time"]),
  ...rows(time("edit"), ["stop-timer"]),
  ...rows(time("delete"), ["delete-time-entry"]),

  ...rows(plans("view"), ["list-recurring", "retainers"]),
  ...rows(plans("create"), ["create-recurring", "create-plan", "create-subscription"]),
  ...rows(plans("edit"), ["pause-recurring", "resume-recurring", "update-recurring", "update-plan", "set-subscription-status"]),

  ...rows(reports("view"), ["reports"]),

  ...rows(settings("view"), ["preferences-load", "get-numbering", "numbering-settings", "payments"]),
  ...rows(settings("edit"), ["set-numbering"]),

  ...rows(ADMIN_ONLY, ["preferences-save", "sync-skills"]),
});

/** Agent tool → the action it runs (worker `TOOL_ACTIONS`; the spec checks the two agree). */
export const TOOL_ACTION_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "create-invoice": "billing.create-invoice", "add-line": "billing.add-line", "update-line": "billing.update-line",
  "remove-line": "billing.remove-line", "update-invoice": "billing.update-invoice", "invoice-detail": "billing.invoice-detail",
  "invoice-pdf": "billing.invoice-pdf", "list-open-invoices": "billing.open-invoices", "request-invoice-send": "billing.request-send",
  "invoice-html": "billing.invoice-html", "set-invoice-tax": "billing.set-invoice-tax", "invoice-payments": "billing.invoice-payments",
  "delete-draft-invoice": "billing.delete-draft-invoice", "create-quote": "billing.create-quote", "add-quote-line": "billing.add-quote-line",
  "remove-quote-line": "billing.remove-quote-line", "update-quote": "billing.update-quote", "quote-detail": "billing.quote-detail",
  "list-quotes": "billing.list-quotes", "request-quote-send": "billing.request-quote-send", "set-quote-status": "billing.set-quote-status",
  "convert-quote": "billing.convert-quote", "quote-html": "billing.quote-html", "delete-draft-quote": "billing.delete-draft-quote",
  "request-payment-check": "billing.request-payment-check", "record-payment": "billing.record-payment",
  "create-credit-note": "billing.create-credit-note", "list-credit-notes": "billing.list-credit-notes",
  "customer-credit": "billing.customer-credit", "list-proofs-of-payment": "billing.pops",
  "request-reminder-send": "billing.request-reminder-send", "create-payment-link": "billing.create-payment-link",
  "list-payment-links": "billing.payment-links", "log-follow-up": "billing.log-follow-up",
  "create-recurring-invoice": "billing.create-recurring", "list-recurring-invoices": "billing.list-recurring",
  "pause-recurring-invoice": "billing.pause-recurring", "resume-recurring-invoice": "billing.resume-recurring",
  "create-retainer-plan": "billing.create-plan", "create-subscription": "billing.create-subscription",
  "list-retainers": "billing.retainers", "create-expense": "billing.create-expense", "create-bill": "billing.create-bill",
  "add-bill-line": "billing.add-bill-line", "request-bill-approval": "billing.request-bill-approval", "list-bills": "billing.list-bills",
  "start-timer": "billing.start-timer", "stop-timer": "billing.stop-timer", "log-time": "billing.log-time",
  "list-time-entries": "billing.list-time", "bill-time": "billing.bill-time", "billing-report": "billing.reports",
  "get-numbering": "billing.get-numbering", "billing-settings": "billing.numbering-settings",
});

const TOOL_ROWS = Object.fromEntries(Object.entries(TOOL_ACTION_KEYS).map(([tool, action]) => [`tool:${tool}`, ACTION_ROWS[action]!]));

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions ──
  ...ACTION_ROWS,

  // ── agent tools: the same permission as the action they run ──
  ...TOOL_ROWS,

  // ── API routes ──
  "api:invoice-grant": invoices("approve"),
  "api:client-summary": { resource: "billing.invoices", action: "view", scoped: true } satisfies AccessTableEntry,
  "api:setup-status": settings("view"),
  "api:cockpit": reports("view"),
});

/**
 * Actions that turn on automatic sending when `autoSend` is true: from then on invoices reach the client with no
 * further approval, so under `enforce` a limited person also needs `billing.invoices:approve` (checked in the worker).
 */
export const AUTO_SEND_ACTIONS: ReadonlySet<string> = new Set([
  "billing.create-recurring", "billing.update-recurring", "billing.create-subscription", "billing.set-subscription-status",
]);
export const AUTO_SEND_PERMISSION: AccessTableEntry = invoices("approve");
