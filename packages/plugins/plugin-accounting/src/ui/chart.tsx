import { useEffect, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, CompactRows, Field, Input, Modal, Section, Select, TextArea, Toolbar, formatDate, tokens, useIsNarrow } from "@partnersinbiz/pib-plugin-ui";
import { readableDates } from "../domain/dates.js";
import { AccountSelect, Banner, capitalise, Details, Muted, small, Table, Td, useRunner, words, type Account } from "./shared.js";

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

const subtypeLabel = (subtype: string) => SUBTYPES.find(([k]) => k === subtype)?.[1] ?? capitalise(words(subtype));
const cashFlowLabel = (cashFlow: string) => CASH_FLOWS.find(([k]) => k === cashFlow)?.[1] ?? capitalise(words(cashFlow));

/** A category role in words: `expense:software` → `Expenses: software`, `revenue:consulting` → `Income: consulting`. */
export function categoryRoleLabel(role: string): string {
  const i = role.indexOf(":");
  if (i < 0) return capitalise(words(role));
  const head = role.slice(0, i);
  const tail = words(role.slice(i + 1));
  return `${head === "revenue" ? "Income" : head === "expense" ? "Expenses" : capitalise(words(head))}: ${tail}`;
}

type Form = { id: string | null; code: string; name: string; subtype: string; cashFlow: string; description: string; active: boolean };

export function ChartTab({ onMessage, onChanged }: { onMessage: (m: string) => void; onChanged: () => Promise<void> }) {
  const narrow = useIsNarrow();
  const load = usePluginAction("accounting.chart");
  const saveAccount = usePluginAction("accounting.save-account");
  const mapRole = usePluginAction("accounting.map-role");
  const { busy, run } = useRunner(onMessage);
  const [data, setData] = useState<{ accounts: Account[]; roles: RoleRow[]; gaps: string[]; taxRates: TaxRate[] } | null>(null);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [newRole, setNewRole] = useState({ kind: "expense", category: "", accountCode: "" });

  async function refresh() {
    setData((await load({})) as { accounts: Account[]; roles: RoleRow[]; gaps: string[]; taxRates: TaxRate[] });
  }
  useEffect(() => {
    void run("load", refresh);
  }, []);

  if (!data) return <Muted>Loading…</Muted>;
  const q = search.trim().toLowerCase();
  const accounts = data.accounts.filter((a) => !q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || subtypeLabel(a.subtype).toLowerCase().includes(q));
  const core = data.roles.filter((r) => r.core);
  const categories = data.roles.filter((r) => !r.core);
  const roleLabel = (role: string) => core.find((r) => r.role === role)?.label ?? categoryRoleLabel(role);
  const edit = (a: Account) => setForm({ id: a.id, code: a.code, name: a.name, subtype: a.subtype, cashFlow: a.cashFlow, description: a.description, active: a.active });
  const accountName = (code: string) => data.accounts.find((a) => a.code === code)?.name ?? code;

  return (
    <div style={{ display: "grid", gap: 18, minWidth: 0 }}>
      <Banner>
        <span>
          Your accounts start from a standard South African chart. Billing and Payroll do not pick accounts themselves: they say what each amount is for (for example money owed to you, or VAT on sales), and the <strong>roles</strong> below decide which account it goes to. Ask your accountant to check both once.
        </span>
      </Banner>
      <Section
        title={`Accounts (${data.accounts.length})`}
        actions={<Button type="button" variant="secondary" style={small} onClick={() => setForm({ id: null, code: "", name: "", subtype: "expense", cashFlow: "", description: "", active: true })}>+ Add account</Button>}
      >
        <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search accounts…">{null}</Toolbar>
        {narrow ? (
          <CompactRows
            rows={accounts}
            label="Accounts"
            empty="No account matches."
            title={(a) => `${a.code} ${a.name}${a.active ? "" : " (switched off)"}`}
            meta={(a) => [subtypeLabel(a.subtype), a.system ? "built-in" : null].filter(Boolean).join(" · ")}
            onOpen={edit}
          />
        ) : (
          <Table head={["Code", "Name", "Kind", "Cash flow", ""]}>
            {accounts.map((a) => (
              <tr key={a.id}>
                <Td>{a.code}</Td>
                <Td>
                  {a.name}
                  {!a.active ? <span style={{ color: tokens.muted }}> (switched off)</span> : null}
                  {a.system ? <span style={{ fontSize: 11, color: tokens.muted }}> · built-in</span> : null}
                </Td>
                <Td>{subtypeLabel(a.subtype)}</Td>
                <Td muted>{cashFlowLabel(a.cashFlow)}</Td>
                <Td>
                  <Button type="button" variant="secondary" style={small} onClick={() => edit(a)}>Edit</Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Roles: which account each amount goes to">
        {data.gaps.length ? <Banner tone="bad"><span>No account yet for: {data.gaps.map(roleLabel).join(", ")}. Postings that use {data.gaps.length === 1 ? "it" : "them"} are rejected until you pick one.</span></Banner> : null}
        {narrow ? (
          <div style={{ display: "grid", gap: 10 }}>
            {core.map((r) => (
              <Field key={r.role} label={data.gaps.includes(r.role) ? `${r.label} (no account yet)` : r.label}>
                <AccountSelect accounts={data.accounts} value={r.accountCode} fullWidth onChange={(code) => void run("role", async () => { await mapRole({ role: r.role, accountCode: code }); await refresh(); await onChanged(); }, `${r.label} now goes to ${code} ${accountName(code)}.`)} />
              </Field>
            ))}
          </div>
        ) : (
          <Table head={["What it is for", "Account"]}>
            {core.map((r) => (
              <tr key={r.role}>
                <Td strong={data.gaps.includes(r.role)} tone={data.gaps.includes(r.role) ? "bad" : undefined}>{r.label}</Td>
                <Td>
                  <AccountSelect accounts={data.accounts} value={r.accountCode} label={`Account for ${r.label}`} onChange={(code) => void run("role", async () => { await mapRole({ role: r.role, accountCode: code }); await refresh(); await onChanged(); }, `${r.label} now goes to ${code} ${accountName(code)}.`)} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <strong style={{ fontSize: 13 }}>Income and expense categories</strong>
        <Muted>Billing sends a category with each invoice and bill line (for example software or consulting). A category without its own account goes to the default Revenue or Expenses account.</Muted>
        {categories.length && narrow ? (
          <div style={{ display: "grid", gap: 10 }}>
            {categories.map((r) => (
              <div key={r.role} style={{ display: "flex", gap: 8, alignItems: "flex-end", minWidth: 0 }}>
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <Field label={categoryRoleLabel(r.role)}>
                    <AccountSelect accounts={data.accounts} value={r.accountCode} fullWidth onChange={(code) => void run("role", async () => { await mapRole({ role: r.role, accountCode: code }); await refresh(); })} />
                  </Field>
                </div>
                <Button type="button" variant="secondary" onClick={() => void run("role", async () => { await mapRole({ role: r.role, accountCode: null }); await refresh(); }, `${categoryRoleLabel(r.role)} removed; it goes to the default account again.`)}>Remove</Button>
              </div>
            ))}
          </div>
        ) : categories.length ? (
          <Table head={["Category", "Account", ""]}>
            {categories.map((r) => (
              <tr key={r.role}>
                <Td>{categoryRoleLabel(r.role)}</Td>
                <Td>
                  <AccountSelect accounts={data.accounts} value={r.accountCode} label={`Account for ${categoryRoleLabel(r.role)}`} onChange={(code) => void run("role", async () => { await mapRole({ role: r.role, accountCode: code }); await refresh(); })} />
                </Td>
                <Td>
                  <Button type="button" variant="secondary" style={small} onClick={() => void run("role", async () => { await mapRole({ role: r.role, accountCode: null }); await refresh(); }, `${categoryRoleLabel(r.role)} removed; it goes to the default account again.`)}>Remove</Button>
                </Td>
              </tr>
            ))}
          </Table>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", minWidth: 0 }}>
          <div style={{ flex: "0 1 140px", minWidth: 0 }}>
            <Field label="Type">
              <Select value={newRole.kind} onChange={(e) => setNewRole({ ...newRole, kind: e.target.value })}>
                <option value="expense">Expense</option>
                <option value="revenue">Income</option>
              </Select>
            </Field>
          </div>
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <Field label="Category"><Input value={newRole.category} onChange={(e) => setNewRole({ ...newRole, category: e.target.value })} placeholder="software" /></Field>
          </div>
          <div style={{ flex: "2 1 200px", minWidth: 0 }}>
            <Field label="Account"><AccountSelect accounts={data.accounts} value={newRole.accountCode} onChange={(code) => setNewRole({ ...newRole, accountCode: code })} fullWidth /></Field>
          </div>
          <Button type="button" variant="secondary" disabled={!newRole.category.trim() || !newRole.accountCode || busy !== ""} onClick={() => void run("role", async () => {
            await mapRole({ role: `${newRole.kind}:${newRole.category.trim()}`, accountCode: newRole.accountCode });
            setNewRole({ kind: newRole.kind, category: "", accountCode: "" });
            await refresh();
          }, "Category added.")}>Add</Button>
        </div>
        <Details summary="Technical role names (for developers and your accountant)">
          {data.roles.map((r) => <span key={r.role}><code>{r.role}</code>: {r.core ? r.label : categoryRoleLabel(r.role)}</span>)}
        </Details>
      </Section>

      <Section title="VAT codes">
        <Table head={["VAT code", "Rate", "From"]}>
          {data.taxRates.map((t) => (
            <tr key={`${t.code}-${t.version}`}>
              <Td>{t.label}</Td>
              <Td>{(t.rateBps / 100).toFixed(2)}%</Td>
              <Td>{formatDate(t.effectiveFrom)}{t.effectiveTo ? ` to ${formatDate(t.effectiveTo)}` : ""}</Td>
            </tr>
          ))}
        </Table>
        <Details summary="Where the rates come from">
          {data.taxRates.map((t) => <span key={`${t.code}-${t.version}-src`}><code>{t.code}</code>: {readableDates(t.source)}</span>)}
        </Details>
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
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 10 }}>
              <Field label="Code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
              <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            </div>
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
              <label style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", minHeight: 40 }}>
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> In use
              </label>
            ) : null}
          </>
        ) : null}
      </Modal>
    </div>
  );
}
