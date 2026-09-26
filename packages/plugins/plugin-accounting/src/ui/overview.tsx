import { Button, Section, StatRow } from "@partnersinbiz/pib-plugin-ui";
import { BookkeeperPanel, type HireView } from "./agent.js";
import { Banner, Muted, rand, Stat, type Account, type BankAccount } from "./shared.js";

export interface LoadResult {
  book: { companyId: string; currency: string; cutoverDate: string | null; openingJournalId: string | null };
  settings: {
    saved: boolean;
    legalName: string;
    vatNumber: string;
    vatCategory: string;
    yearEndMonth: number;
    agentsMayAcceptCategorisation: boolean;
    jevConfigured: boolean;
    r2Configured: boolean;
  };
  overview: {
    cashMinor: number;
    receivablesMinor: number;
    payablesMinor: number;
    vatDueMinor: number;
    month: string;
    monthRevenueMinor: number;
    monthExpensesMinor: number;
    monthProfitMinor: number;
    bankLines: Record<string, number>;
    rejectedPostings: number;
    pendingApprovals: number;
  };
  roleGaps: string[];
  bankAccounts: BankAccount[];
  accounts: Account[];
  currentVatPeriod: { start: string; end: string } | null;
  hire: HireView | null;
}

export function OverviewTab({ data, onMessage, onOpen, refresh }: { data: LoadResult; onMessage: (m: string) => void; onOpen: (tab: string) => void; refresh: () => Promise<void> }) {
  const o = data.overview;
  const open = (o.bankLines.unreconciled ?? 0) + (o.bankLines.matching ?? 0);
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <StatRow>
        <Stat label="Cash and bank" value={rand(o.cashMinor)} />
        <Stat label="Receivables (AR)" value={rand(o.receivablesMinor)} />
        <Stat label="Payables (AP)" value={rand(o.payablesMinor)} />
        <Stat label={o.vatDueMinor >= 0 ? "VAT owed to SARS" : "VAT refund due"} value={rand(Math.abs(o.vatDueMinor))} hint={data.currentVatPeriod ? `Period ${data.currentVatPeriod.start} to ${data.currentVatPeriod.end}` : "Not VAT-registered"} />
      </StatRow>
      <Section title={`Profit and loss, ${o.month}`}>
        <StatRow>
          <Stat label="Income" value={rand(o.monthRevenueMinor)} />
          <Stat label="Costs" value={rand(o.monthExpensesMinor)} />
          <Stat label="Profit" value={rand(o.monthProfitMinor)} />
        </StatRow>
      </Section>
      <Section title="Needs attention">
        <div style={{ display: "grid", gap: 8 }}>
          {open > 0 ? (
            <Banner tone="warn">
              <span>{open} bank line{open === 1 ? " is" : "s are"} not reconciled yet.</span>
              <div><Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => onOpen("bank")}>Open Bank</Button></div>
            </Banner>
          ) : null}
          {o.rejectedPostings > 0 ? (
            <Banner tone="warn">
              <span>{o.rejectedPostings} posting{o.rejectedPostings === 1 ? " was" : "s were"} rejected. The books are missing {o.rejectedPostings === 1 ? "it" : "them"} until the cause is fixed.</span>
              <div><Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => onOpen("journals")}>Open Journals</Button></div>
            </Banner>
          ) : null}
          {o.pendingApprovals > 0 ? <Banner><span>{o.pendingApprovals} manual journal{o.pendingApprovals === 1 ? " is" : "s are"} waiting for approval (Journals → Drafts).</span></Banner> : null}
          {!data.book.openingJournalId ? <Banner><span>No opening balances yet. Import the trial balance at your cut-over date under Cut-over before relying on the balance sheet.</span></Banner> : null}
          {open === 0 && o.rejectedPostings === 0 && o.pendingApprovals === 0 && data.book.openingJournalId ? <Muted>Nothing is waiting.</Muted> : null}
        </div>
      </Section>
      <Section title="Bookkeeper agent">
        <BookkeeperPanel hire={data.hire} refresh={refresh} onMessage={onMessage} />
      </Section>
      <Section title="Set-up">
        <div style={{ display: "grid", gap: 4, fontSize: 13 }}>
          <span>Legal name: {data.settings.legalName || "not set"} · VAT {data.settings.vatNumber || "number not set"} · category {data.settings.vatCategory} · year ends month {data.settings.yearEndMonth}</span>
          <span>Jev decisions: {data.settings.jevConfigured ? "on" : "off (bank rules and matching still work)"} · Private file storage: {data.settings.r2Configured ? "set up" : "not set up (imports up to 1 MB)"}</span>
          <span>Agents may accept bank suggestions: {data.settings.agentsMayAcceptCategorisation ? "yes (exact invoice matches only)" : "no"}</span>
        </div>
      </Section>
    </div>
  );
}
