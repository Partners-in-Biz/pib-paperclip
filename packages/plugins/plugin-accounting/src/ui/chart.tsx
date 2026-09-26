import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Modal, Section, Select, TextArea, Toolbar, tokens } from "@partnersinbiz/pib-plugin-ui";
import { AccountSelect, Banner, Muted, Row, small, Table, Td, useRunner, words, type Account } from "./shared.js";

interface RoleRow {
  role: string;
  accountCode: string;
  label: string;
  core: boolean;
}

interface TaxRate {
  code: string;
  version: number;
  label: string;
  kind: string;
  rateBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
}

const SUBTYPES: Array<[string, string]> = [
  ["bank", "Bank"],
  ["cash", "Cash"],
  ["receivable", "Accounts receivable"],
  ["current_asset", "Other current asset"],
  ["inventory", "Inventory"],
  ["vat_input", "VAT input"],
  ["fixed_asset", "Fixed asset (cost)"],
  ["accumulated_depreciation", "Accumulated depreciation"],
  ["suspense", "Suspense"],
  ["payable", "Accounts payable"],
  ["vat_output", "VAT output"],
  ["vat_control", "VAT control"],
  ["payroll_liability", "Payroll liability"],
  ["current_liability", "Other current liability"],
  ["non_current_liability", "Non-current liability"],
  ["equity", "Equity"],
  ["retained_earnings", "Retained earnings"],
  ["opening_balance_equity", "Opening balance equity"],
  ["revenue", "Revenue"],
  ["other_income", "Other income"],
  ["cost_of_sales", "Cost of sales"],
  ["expense", "Expense"],
  ["depreciation", "Depreciation"],
];

const CASH_FLOWS: Array<[string, string]> = [
  ["", "Default for the kind"],
  ["cash", "Cash (bank and cash)"],
  ["operating", "Operating"],
  ["investing", "Investing"],
  ["financing", "Financing"],
  ["none", "Not a cash flow"],
];

type Form = { id: string | null; code: string; name: string; subtype: string; cashFlow: string; description: string; active: boolean };

export function ChartTab({ onMessage, onChanged }: { onMessage: (m: string) => void; onChanged: () => Promise<void> }) {
  const load = usePluginAction("accounting.chart");
  const saveAccount = usePluginAction("accounting.save-account");
  const mapRole = usePluginAction("accounting.map-role");
  const { busy, run } = useRunner(onMessage);
  const [data, setData] = useState<{ accounts: Account[]; roles: RoleRow[]; gaps: string[]; taxRates: TaxRate[] } | null>(null);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [newRole, setNewRole] = useState({ role: "expense:", accountCode: "" });

  async function refresh() {
    setData((await load({})) as { accounts: Account[]; roles: RoleRow[]; gaps: string[]; taxRates: TaxRate[] });
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);

  if (!data) return <Muted>Loading…</Muted>;
  const q = search.trim().toLowerCase();
  const accounts = data.accounts.filter((a) => !q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || a.subtype.includes(q));
  const core = data.roles.filter((r) => r.core);
  const categories = data.roles.filter((r) => !r.core);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <Banner>
        <span>
          The chart starts from a South African template (IFRS for SMEs style). Other plugins post by <strong>role</strong> (for example <code>ar</code>, <code>vat_output</code>, <code>expense:software</code>); the role map decides the account. Have your accountant review both before relying on the books.
        </span>
      </Banner>
      <Section
        title={`Accounts (${data.accounts.length})`}
        actions={<Button type="button" variant="secondary" style={small} onClick={() => setForm({ id: null, code: "", name: "", subtype: "expense", cashFlow: "", description: "", active: true })}>+ Add account</Button>}
      >
        <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search accounts…">{null}</Toolbar>
        <Table head={["Code", "Name", "Kind", "Cash flow", ""]}>
          {accounts.map((a) => (
            <tr key={a.id}>
              <Td>{a.code}</Td>
              <Td>
                {a.name}
                {!a.active ? <span style={{ color: tokens.muted }}> (inactive)</span> : null}
                {a.system ? <span style={{ fontSize: 11, color: tokens.muted }}> · system</span> : null}
              </Td>
              <Td>{SUBTYPES.find(([k]) => k === a.subtype)?.[1] ?? words(a.subtype)}</Td>
              <Td muted>{words(a.cashFlow)}</Td>
              <Td>
                <Button type="button" variant="secondary" style={small} onClick={() => setForm({ id: a.id, code: a.code, name: a.name, subtype: a.subtype, cashFlow: a.cashFlow, description: a.description, active: a.active })}>Edit</Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Role map">
        {data.gaps.length ? <Banner tone="warn"><span>Not mapped: {data.gaps.join(", ")}</span></Banner> : null}
        <Table head={["Role", "Used for", "Account"]}>
          {core.map((r) => (
            <tr key={r.role}>
              <Td><code>{r.role}</code></Td>
              <Td>{r.label}</Td>
              <Td>
                <AccountSelect accounts={data.accounts} value={r.accountCode} onChange={(code) => void run("role", async () => { await mapRole({ role: r.role, accountCode: code }); await refresh(); await onChanged(); }, `${r.role} now posts to ${code}.`)} />
              </Td>
            </tr>
          ))}
        </Table>
        <strong style={{ fontSize: 13 }}>Category roles</strong>
        <Muted>Billing sends <code>expense:&lt;category&gt;</code> or <code>revenue:&lt;category&gt;</code>. Unmapped categories fall back to the plain expense or revenue role.</Muted>
        <Table head={["Role", "Account", ""]}>
          {categories.map((r) => (
            <tr key={r.role}>
              <Td><code>{r.role}</code></Td>
              <Td>
                <AccountSelect accounts={data.accounts} value={r.accountCode} onChange={(code) => void run("role", async () => { await mapRole({ role: r.role, accountCode: code }); await refresh(); })} />
              </Td>
              <Td>
                <Button type="button" variant="secondary" style={small} onClick={() => void run("role", async () => { await mapRole({ role: r.role, accountCode: null }); await refresh(); }, `${r.role} removed; it falls back to the plain role.`)}>Remove</Button>
              </Td>
            </tr>
          ))}
        </Table>
        <Row>
          <Field label="New category role"><Input value={newRole.role} onChange={(e) => setNewRole({ ...newRole, role: e.target.value })} placeholder="expense:software" /></Field>
          <Field label="Account"><AccountSelect accounts={data.accounts} value={newRole.accountCode} onChange={(code) => setNewRole({ ...newRole, accountCode: code })} /></Field>
          <Button type="button" variant="secondary" disabled={!newRole.accountCode || busy !== ""} onClick={() => void run("role", async () => { await mapRole(newRole); setNewRole({ role: "expense:", accountCode: "" }); await refresh(); }, "Role added.")}>Add</Button>
        </Row>
      </Section>

      <Section title="VAT codes">
        <Table head={["Code", "Label", "Rate", "From", "Source"]}>
          {data.taxRates.map((t) => (
            <tr key={`${t.code}-${t.version}`}>
              <Td><code>{t.code}</code></Td>
              <Td>{t.label}</Td>
              <Td>{(t.rateBps / 100).toFixed(2)}%</Td>
              <Td>{t.effectiveFrom}{t.effectiveTo ? ` to ${t.effectiveTo}` : ""}</Td>
              <Td muted>{t.source}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Modal
        open={!!form}
        title={form?.id ? "Edit account" : "Add account"}
        description="An account with postings keeps its code and section; it can still be renamed."
        onClose={() => setForm(null)}
        footer={
          <Button type="button" disabled={!form || busy !== ""} onClick={() => form && void run("save", async () => {
            await saveAccount({ ...form, cashFlow: form.cashFlow || undefined });
            setForm(null);
            await refresh();
            await onChanged();
          }, "Account saved.")}>Save</Button>
        }
      >
        {form ? (
          <>
            <Row>
              <Field label="Code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
              <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            </Row>
            <Field label="Kind">
              <Select value={form.subtype} onChange={(e) => setForm({ ...form, subtype: e.target.value })}>
                {SUBTYPES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </Select>
            </Field>
            <Field label="Cash flow statement">
              <Select value={form.cashFlow} onChange={(e) => setForm({ ...form, cashFlow: e.target.value })}>
                {CASH_FLOWS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </Select>
            </Field>
            <Field label="Description"><TextArea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            {form.id ? (
              <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
              </label>
            ) : null}
          </>
        ) : null}
      </Modal>
    </div>
  );
}
