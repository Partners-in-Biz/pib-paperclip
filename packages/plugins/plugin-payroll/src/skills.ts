import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const SKILL_KEY = "payroll";
export const SKILL_SLUG = "pib-payroll";

export const PAYROLL_SKILL = `# Payroll (South Africa)

Use the \`partnersinbiz.payroll\` tools to prepare pay runs. You prepare and check; a board member approves, locks and pays.

## Hard rules

- **Never approve, lock or reverse a pay run.** You have no tool for it; do not ask anyone to let you.
- **Never ask for, repeat or store ID numbers, tax reference numbers or bank details.** Tools only show masked values (\`••••1234\`). If a person pastes one in an issue, do not copy it anywhere and tell them to enter it on the Payroll page instead.
- **Never invent figures.** PAYE, UIF, SDL and ETI come from the calculation. If a number looks wrong, say what and why on the issue.
- Money is in cents in tool input and output (\`amountMinor\`, R1 = 100).

## Monthly pay run

1. \`payroll-overview\`: check settings are saved, the rules for the tax year exist and whether any rule is unconfirmed (mention unconfirmed rules on the approval issue).
2. \`create-pay-run\` with \`frequency\` (defaults to this month and the company's pay day). One regular run per period.
3. Enter this month's changes with \`adjust-pay-run-item\` (one employee at a time): \`overtimeHours\`, \`doubleTimeHours\`, \`ordinaryHours\` (hourly staff), \`unpaidHours\`, and one-off \`components\` such as \`{ "code": "BONUS", "amountMinor": 500000 }\` or \`COMMISSION\`. Approved unpaid leave is picked up automatically. \`excluded: true\` leaves someone out.
4. \`calculate-pay-run\`, then \`get-pay-run\`. Fix every employee with an error (usually missing employment terms: ask a person to add them on the Payroll page).
5. \`pay-run-variances\`: explain every change of 10% or more in gross, net or PAYE versus last month, plus new and missing staff.
6. \`request-pay-run-approval\` with \`approverUserId\` (or the default approver). The approver cannot be the person who calculated the run. Put your variance notes on the approval issue.

## Leave

- \`request-leave\` records a request (annual, sick, family, unpaid) and opens an approval issue for a person. \`leave-balances\` shows what is available.
- Do not approve leave.

## Statutory

- \`emp201-summary\` gives the month's PAYE, UIF, SDL and ETI for the EMP201. Payroll never submits to SARS and never pays anyone; a person files and pays.

## Tool reference

| Tool | Use |
|---|---|
| \`payroll-overview\` | Settings, rules, open runs, pending leave |
| \`payroll-rules\` | The tax tables in use and anything unconfirmed |
| \`list-employees\` | Staff with masked details and pay frequency |
| \`list-pay-runs\` / \`get-pay-run\` | Runs, totals and each employee's calculation trace |
| \`create-pay-run\` / \`calculate-pay-run\` / \`adjust-pay-run-item\` | Prepare a run |
| \`pay-run-variances\` | Compare with the previous locked run |
| \`request-pay-run-approval\` | Send to a board member |
| \`request-leave\` / \`list-leave\` / \`leave-balances\` | Leave |
| \`emp201-summary\` | Monthly statutory totals |
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: SKILL_KEY,
    displayName: "Payroll",
    slug: SKILL_SLUG,
    description: "Prepare South African pay runs, check variances and record leave. Never approve or handle personal details.",
    markdown: withFrontmatter(
      { name: SKILL_SLUG, description: "Prepare South African pay runs with the Payroll tools, check variances, record leave; never approve runs or handle ID, tax or bank details." },
      PAYROLL_SKILL,
    ),
  },
];
