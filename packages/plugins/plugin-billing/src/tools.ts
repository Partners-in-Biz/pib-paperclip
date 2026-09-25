import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const text = { type: "string" } satisfies JsonSchema;
function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const BILLING_TOOLS: PluginToolDeclaration[] = [
  {
    name: "create-invoice",
    displayName: "Create invoice",
    description: "Draft an invoice. Agents cannot send it.",
    parametersSchema: schema(["currency", "customerKind", "customerRef", "customerName"], {
      currency: text,
      customerKind: text,
      customerRef: text,
      customerName: text,
      senderName: text,
      dueAt: text,
    }),
  },
  {
    name: "add-line",
    displayName: "Add invoice line",
    description: "Add a line to a draft invoice. Quantity and unit amount are integers.",
    parametersSchema: schema(["invoiceId", "description", "quantity", "unitAmountMinor"], {
      invoiceId: text,
      description: text,
      quantity: { type: "integer" },
      unitAmountMinor: { type: "integer" },
    }),
  },
  {
    name: "create-quote",
    displayName: "Create quote",
    description: "Draft a quote (estimate). Agents cannot send it. Convert it to an invoice when accepted.",
    parametersSchema: schema(["currency", "customerKind", "customerRef", "customerName"], {
      currency: text,
      customerKind: text,
      customerRef: text,
      customerName: text,
      senderName: text,
      validUntil: text,
    }),
  },
  {
    name: "add-quote-line",
    displayName: "Add quote line",
    description: "Add a line to a draft quote. Quantity and unit amount are integers.",
    parametersSchema: schema(["quoteId", "description", "quantity", "unitAmountMinor"], {
      quoteId: text,
      description: text,
      quantity: { type: "integer" },
      unitAmountMinor: { type: "integer" },
    }),
  },
  {
    name: "convert-quote",
    displayName: "Convert quote to invoice",
    description: "Turn an accepted quote into a draft invoice, copying its lines and customer.",
    parametersSchema: schema(["quoteId"], {
      quoteId: text,
    }),
  },
  {
    name: "create-expense",
    displayName: "Create expense",
    description: "Record a business expense. Amount is an integer in minor units plus a currency code.",
    parametersSchema: schema(["description", "amountMinor"], {
      description: text,
      amountMinor: { type: "integer" },
      currency: text,
      category: text,
      incurredOn: text,
    }),
  },
  {
    name: "invoice-html",
    displayName: "Invoice HTML",
    description: "Return a self-contained, printable HTML invoice a person can open and save as PDF.",
    parametersSchema: schema(["invoiceId"], {
      invoiceId: text,
    }),
  },
  {
    name: "create-recurring-invoice",
    displayName: "Create recurring invoice",
    description: "Schedule a draft invoice to be re-created on a frequency (monthly, quarterly, yearly).",
    parametersSchema: schema(["templateInvoiceId", "frequency", "nextRunAt"], {
      templateInvoiceId: text,
      frequency: text,
      nextRunAt: text,
    }),
  },
  {
    name: "list-recurring-invoices",
    displayName: "List recurring invoices",
    description: "Return the recurring invoice schedules for this workspace.",
    parametersSchema: schema([], {}),
  },
  {
    name: "pause-recurring-invoice",
    displayName: "Pause recurring invoice",
    description: "Stop a recurring schedule from creating new invoices.",
    parametersSchema: schema(["recurringId"], {
      recurringId: text,
    }),
  },
  {
    name: "resume-recurring-invoice",
    displayName: "Resume recurring invoice",
    description: "Re-enable a paused recurring schedule.",
    parametersSchema: schema(["recurringId"], {
      recurringId: text,
    }),
  },
];
