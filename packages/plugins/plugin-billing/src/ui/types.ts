import type { ClientKind } from "@partnersinbiz/pib-plugin-kit/client-ref";

export interface Address {
  email: string;
  name?: string | null;
}

export interface Invoice {
  id: string;
  number: string;
  status: string;
  currency: string;
  customerKind?: string;
  customerRef: string;
  customerName?: string | null;
  taxRate?: number;
  defaultTaxCode?: string | null;
  pricesIncludeVat?: boolean;
  dueAt?: string | null;
  sentAt?: string | null;
  paidAt?: string | null;
  subtotalMinor?: number;
  vatMinor?: number;
  totalMinor: number;
  paidMinor?: number;
  creditedMinor?: number;
  writtenOffMinor?: number;
  outstandingMinor?: number;
  pendingPops?: number;
  pendingAction?: string | null;
  approvalIssueId?: string | null;
  deliveryStatus?: string | null;
  deliveryError?: string | null;
  ledgerStatus?: string | null;
  ledgerError?: string | null;
  journalNumber?: string | null;
  notes?: string | null;
  sendTo?: Address[];
  shared?: boolean;
}

export interface Quote {
  id: string;
  number: string;
  status: string;
  currency: string;
  customerKind?: string;
  customerRef: string;
  customerName?: string | null;
  subtotalMinor?: number;
  vatMinor?: number;
  totalMinor: number;
  validUntil?: string | null;
  convertedInvoiceId?: string | null;
  defaultTaxCode?: string | null;
  pricesIncludeVat?: boolean;
  notes?: string | null;
  pendingAction?: string | null;
  deliveryStatus?: string | null;
  deliveryError?: string | null;
  sendTo?: Address[];
}

export interface Line {
  id: string;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  taxCode: string | null;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  fromTime?: boolean;
}

export interface TaxGroup {
  taxCode: string | null;
  rateBp: number;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
}

export interface Payment {
  id: string;
  amountMinor: number;
  allocatedMinor: number;
  creditMinor: number;
  method: string;
  reference: string | null;
  source: string;
  bankTxId: string | null;
  paidAt: string | null;
  ledgerStatus: string | null;
  journalNumber: string | null;
}

export interface CreditNote {
  id: string;
  number: string | null;
  invoiceId: string;
  invoiceNumber?: string | null;
  amountMinor: number;
  currency?: string | null;
  reason: string;
  status: string;
  createdAt?: string | null;
  deliveryStatus?: string | null;
  ledgerStatus?: string | null;
  journalNumber?: string | null;
}

export interface Pop {
  id: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  source: string;
  matchBasis: string | null;
  status: string;
  amountMinor: number | null;
  reference: string | null;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  hasFile: boolean;
  fileName: string | null;
  attachments: Array<{ filename: string }>;
  issueId: string | null;
  paymentId: string | null;
  rejectReason: string | null;
  receivedAt: string | null;
}

export interface CreditSource {
  sourceKind: "credit_note" | "payment";
  sourceId: string;
  availableMinor: number;
  currency: string;
  at: string | null;
  label: string;
}

export interface Delivery {
  key: string;
  status: string;
  error: string | null;
  subject: string;
  sentAt: string | null;
  createdAt: string | null;
}

export interface InvoiceDetail {
  invoice: Invoice;
  readOnly: boolean;
  lines: Line[];
  groups: TaxGroup[];
  legacyVat: boolean;
  payments: Payment[];
  credits: Array<{ id: string; sourceKind: string; sourceId: string; amountMinor: number; createdAt: string | null }>;
  creditNotes: CreditNote[];
  pops: Pop[];
  deliveries: Delivery[];
  reminders: Array<{ stage: number; status: string; createdAt: string | null; error: string | null }>;
  recipients: Address[];
  customerCredit: CreditSource[];
  ledgerKey: string;
}

export interface QuoteDetail {
  quote: Quote;
  lines: Line[];
  groups: TaxGroup[];
  legacyVat: boolean;
  deliveries: Delivery[];
  recipients: Address[];
}

export interface Expense {
  id: string;
  description: string;
  amountMinor: number;
  currency: string;
  category: string;
  incurredOn: string | null;
  vendor: string | null;
  taxCode: string | null;
  vatMinor: number;
  vatClaimable: boolean;
  paidFrom: string;
  status: string;
  hasReceipt: boolean;
  receiptName: string | null;
  extraction: { fields?: Record<string, unknown> | null; error?: string | null; jev?: Record<string, unknown> } | null;
  needsReview: boolean;
  ledgerStatus: string | null;
  journalNumber: string | null;
}

export interface BillLine {
  id: string;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  taxCode: string | null;
  category: string | null;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
}

export interface Bill {
  id: string;
  supplierKind: string;
  supplierRef: string | null;
  supplierName: string;
  supplierEmail: string | null;
  supplierReference: string | null;
  status: string;
  currency: string;
  pricesIncludeVat: boolean;
  category: string;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  issueDate: string | null;
  dueDate: string | null;
  notes: string | null;
  source: string;
  hasFile: boolean;
  fileName: string | null;
  pendingAction: string | null;
  ledgerStatus: string | null;
  ledgerError: string | null;
  journalNumber: string | null;
  lines: BillLine[];
  payments?: Array<{ id: string; amountMinor: number; paidAt: string | null; method: string; reference: string | null; bankTxId: string | null }>;
}

export interface TimeEntry {
  id: string;
  owner: string;
  description: string;
  customerKind: string | null;
  customerRef: string | null;
  customerName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  running: boolean;
  minutes: number;
  rateMinor: number;
  currency: string;
  amountMinor: number;
  billable: boolean;
  invoiceId: string | null;
}

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  currency: string;
  period: string;
  taxCode: string | null;
  active: boolean;
}

export interface Subscription {
  id: string;
  planId: string | null;
  customerKind: string;
  customerRef: string;
  customerName: string | null;
  description: string;
  priceMinor: number;
  currency: string;
  period: string;
  status: string;
  autoSend: boolean;
  nextInvoiceAt: string | null;
  cancelledAt: string | null;
}

export interface Recurring {
  id: string;
  templateInvoiceId: string;
  frequency: string;
  nextRunAt: string | null;
  isActive: boolean;
  autoSend: boolean;
  endsAt: string | null;
}

export interface Client {
  kind: ClientKind;
  id: string;
  name: string;
  email?: string | null;
}

export interface WorkspaceClient {
  kind: ClientKind;
  id: string;
  name: string | null;
  detail: string | null;
  found: boolean;
}

export interface Snapshot {
  settingsSaved?: boolean;
  defaults?: { currency: string; taxRate: number; taxCode: string | null; senderName: string; pricesIncludeVat: boolean; reportingCurrency: string; hourlyRateMinor: number };
  features?: { email: boolean; r2: boolean; receipts: boolean; jev: boolean; ledger: boolean; dunning: boolean; numbering: string };
  taxCodes?: Array<{ code: string; label: string; rate: number }>;
  expenseCategories?: string[];
  client?: WorkspaceClient | null;
  clients?: Client[];
  invoices: Invoice[];
  quotes?: Quote[];
  expenses?: Expense[];
  bills?: Bill[];
  recurring?: Recurring[];
  creditNotes?: CreditNote[];
  pops?: Pop[];
  time?: TimeEntry[];
  retainers?: { plans: Plan[]; subscriptions: Subscription[] };
  customerCredit?: CreditSource[];
  dunningOptOut?: boolean;
}
