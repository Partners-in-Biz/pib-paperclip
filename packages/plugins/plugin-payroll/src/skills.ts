import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const SKILL_KEY = "payroll";
export const SKILL_SLUG = "pib-payroll";

export const PAYROLL_SKILL = `# Payroll (South Africa)

Use the \`partnersinbiz.payroll\` tools to run Partners in Biz's own payroll (its own staff; Payroll has no client workspace). You prepare and check. A person approves, locks, pays and files. Money is whole cents in tool input and output (\`amountMinor\`, R1 = 100). Dates are YYYY-MM-DD.

## Hard rules

- **Never approve, lock or reverse a pay run.** You have no tool for it. Never close or cancel an approval issue: if you do, it opens again for the person.
- **Never ask for, repeat or store ID numbers, tax reference numbers or bank details.** Tools only show masked values (\`••••1234\`). If a person pastes one in an issue, do not copy it anywhere; ask them to enter it on the Payroll page.
- **Never invent figures.** PAYE, UIF, SDL and ETI come from the calculation. If a number looks wrong, say what and why.
- Payroll never pays anyone and never files with SARS.

## Who does what

| Step | Who | How |
|---|---|---|
| Prepare, adjust, calculate, check variances | You | The tools below |
| Approve the run | A board member who did not prepare it | \`request-pay-run-approval\` opens their approval issue |
| Lock it (posts the journal to Accounting, makes the payslips) | The approver: approving locks it when "Lock on approval" is on (the default); otherwise a board member locks it | The Payroll page; an approved run waits in the Cockpit until it is locked |
| Email the payslips | Automatic when "Email payslips when a run is locked" is on; otherwise a board member clicks Email payslips | The Mailbox sends them |
| Pay the staff (upload the net pay file), file and pay the EMP201 and EMP501 | A person | One \`${ASK_OWNER_TOOL}\` with the figures and the steps |
| Decide leave | The leave approver | \`request-leave\` opens their issue |
| Add employees, terms and ID, tax or bank details | A person on the Payroll page | One \`${ASK_OWNER_TOOL}\` listing what is missing |
| Choose who approves pay runs | The owner, on Payroll → Pay runs → Who approves pay runs | One \`${ASK_OWNER_TOOL}\` when no approver is set |
| Check the unconfirmed tax rules | The owner's accountant; the owner records their name and the date on Payroll → Statutory | Until then, name the rules on the approval issue |

## The monthly cycle

### 1. Prepare ("Prepare pay run for <month>")
Payroll opens this issue for you a few days before the monthly pay day (5 by default).
1. \`payroll-overview\`: the settings are saved, this tax year's rules are loaded, no leave is waiting. While \`rulesReviewed\` is false, note the unconfirmed rules for the approver by their plain \`label\` (never the \`path\`); \`rulesReview\` says who checked them and when.
2. \`create-pay-run\` with \`frequency: "monthly"\` (this month and the pay day are the defaults), or use the open draft from \`list-pay-runs\`. One regular run per period.
3. This month's changes with \`adjust-pay-run-item\`, one employee at a time: \`overtimeHours\`, \`doubleTimeHours\`, \`ordinaryHours\` (hourly staff), \`unpaidHours\`, and one-off \`components\` such as \`{ "code": "BONUS", "amountMinor": 500000 }\` or \`COMMISSION\`. Approved unpaid leave is picked up on its own. \`excluded: true\` leaves someone out.

### 2. Calculate and check
4. \`calculate-pay-run\`, then \`get-pay-run\`. Fix every employee with an error. Missing employment terms or details are added by a person on the Payroll page: ask once for all of them.
5. \`pay-run-variances\`: explain every change of 10% or more in gross, net or PAYE against the last locked run, plus new and missing staff.

### 3. Approval
6. \`request-pay-run-approval\` with the \`runId\`. Leave \`approverUserId\` out to use the default approver from the Payroll settings (the owner picks them on Payroll → Pay runs; if none is set, ask once with \`${ASK_OWNER_TOOL}\`); the approver can never be whoever calculated the run. Put your variance notes, and any rule still waiting for the accountant's check, on the approval issue.
7. Mark your prepare issue done with the run number and its approval issue. Adjusting or recalculating afterwards drops the approval: ask again.

### 4. Lock and the books
When the approver approves, the run locks as them (with "Lock on approval" on): its journal goes to Accounting through the outbox (the Bookkeeper sees it) and the payslips are made. With it off, the approved run waits in the Cockpit until a board member clicks Lock and post. If Accounting refuses the journal, the run shows it; a person fixes the cause in Accounting and clicks Post again.

### 5. Payslips
Made at lock and stored privately. Emailed through the Mailbox when "Email payslips when a run is locked" is on; the follow-up job also emails payslips it makes later. \`get-pay-run\` shows each payslip's status. A failed email: ask the owner to check the Mailbox's Gmail connection and the employee's email address.

### 6. EMP201 (by the 7th of the next month)
"EMP201 for <month> due by <date>" opens early each month (for the Bookkeeper, else you).
1. \`emp201-summary\` with \`month\`: check the runs included and the totals (PAYE, SDL, UIF, ETI used, total payable). A run for the month that is not locked yet is not in it: say so.
2. Ask the owner once with \`${ASK_OWNER_TOOL}\`: export it under Payroll → Statutory → EMP201 (monthly) → Download CSV, file it on eFiling and pay the total by the due date. Give the totals.
3. Mark the issue done when they confirm, with their payment reference.

### 7. EMP501 (twice a year)
The interim reconciliation covers March to August (file by the end of October); the annual one March to February (file by the end of May). \`emp501-summary\` with \`period\` compares the EMP201s declared with the IRP5/IT3(a) certificate totals. If it does not reconcile, find the month with \`emp201-summary\`. Then ask the owner once to export the pack and the certificates (Payroll → Statutory) and file on eFiling, with the totals and any difference.

## Leave

- \`request-leave\` records a request (annual, sick, family, unpaid) and opens an approval issue for the leave approver. \`leave-balances\` shows what is available. Never approve leave.

## Tool reference

| Tool | Use |
|---|---|
| \`payroll-overview\` | Settings, rules (each unconfirmed one with a plain \`label\`, and the accountant's check), open runs, pending leave |
| \`payroll-rules\` | The tax tables in use and anything unconfirmed |
| \`list-employees\` | Staff with masked details and pay frequency |
| \`list-pay-runs\` / \`get-pay-run\` | Runs, totals, each employee's calculation trace and payslips |
| \`create-pay-run\` / \`calculate-pay-run\` / \`adjust-pay-run-item\` | Prepare a run |
| \`pay-run-variances\` | Compare with the previous locked run |
| \`request-pay-run-approval\` | Send to a board member (their approval locks it) |
| \`request-leave\` / \`list-leave\` / \`leave-balances\` | Leave |
| \`emp201-summary\` / \`emp501-summary\` | Monthly and twice-yearly SARS totals (a person files) |
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: SKILL_KEY,
    displayName: "Payroll",
    slug: SKILL_SLUG,
    description: "PiB's monthly payroll cycle: prepare and calculate pay runs, send them for approval, payslips, EMP201 and EMP501. Never approve or handle personal details.",
    markdown: withFrontmatter(
      { name: SKILL_SLUG, description: "Run the monthly South African payroll cycle with the Payroll tools: prepare, calculate, check variances, request approval, follow payslips, ready the EMP201 and EMP501, record leave. Never approve runs or handle ID, tax or bank details." },
      PAYROLL_SKILL,
    ),
  },
];
