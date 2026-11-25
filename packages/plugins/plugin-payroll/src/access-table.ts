/**
 * Payroll's access table (access stage A, spec PAR-12578 section 4.4). Every
 * page action, agent tool and API route the worker registers has one row here;
 * `tests/access.spec.ts` fails on a missing or stale row.
 *
 * Catalog resources: `payroll.employees` (view, create, edit, delete),
 * `payroll.payruns` (view, create, edit, approve, export) and `payroll.settings`
 * (view, edit). None is scopable, so no row is `scoped`: Payroll is not in the
 * Client manager preset and stays closed to an own-companies person.
 *
 * A tool has the permission of the matching page action. Hiring, linking and
 * unlinking the Payroll Clerk changes the company's agents: owner or admin only.
 */
import { ADMIN_ONLY, type AccessTable, type PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const employees = (action: PermissionAction) => ({ resource: "payroll.employees", action });
const payruns = (action: PermissionAction) => ({ resource: "payroll.payruns", action });
const settings = (action: PermissionAction) => ({ resource: "payroll.settings", action });

export const PAYROLL_ACCESS_TABLE: AccessTable = Object.freeze({
  // The page's first read returns employees, pay runs and the overview (settings,
  // open runs, pending leave), so it takes pay runs, like the overview tool.
  // A role with only employees cannot open the Payroll page.
  "payroll.load": payruns("view"),
  "payroll.rules": settings("view"),
  "payroll.review-rules": settings("edit"),
  "payroll.save-component": settings("edit"),
  "payroll.audit": settings("view"),

  "payroll.employee-terms": employees("view"),
  // One action saves a new employee and changes an existing one, so it takes
  // edit: a role with only employees create cannot add an employee.
  "payroll.save-employee": employees("edit"),
  "payroll.terminate-employee": employees("delete"),
  "payroll.save-terms": employees("edit"),
  "payroll.set-recurring": employees("edit"),
  // Sealed ID, tax and bank details: only for someone who may change them.
  "payroll.reveal": employees("edit"),

  "payroll.run": payruns("view"),
  "payroll.create-run": payruns("create"),
  "payroll.calculate-run": payruns("edit"),
  "payroll.adjust-item": payruns("edit"),
  "payroll.request-approval": payruns("edit"),
  "payroll.approve-run": payruns("approve"),
  "payroll.reject-run": payruns("approve"),
  "payroll.lock-run": payruns("approve"),
  "payroll.reverse-run": payruns("approve"),
  "payroll.correct-run": payruns("approve"),
  "payroll.cancel-run": payruns("edit"),
  "payroll.repost-ledger": payruns("edit"),
  "payroll.variances": payruns("view"),

  "payroll.payslips": payruns("view"),
  "payroll.generate-payslips": payruns("edit"),
  "payroll.email-payslips": payruns("export"),
  "payroll.download-payslip": payruns("export"),
  "payroll.net-pay-file": payruns("export"),

  "payroll.emp201": payruns("view"),
  "payroll.mark-emp201-filed": payruns("edit"),
  "payroll.unmark-emp201-filed": payruns("edit"),
  "payroll.certificates": payruns("view"),
  "payroll.emp501": payruns("view"),
  "payroll.export": payruns("export"),
  "payroll.download-export": payruns("export"),
  "payroll.exports": payruns("view"),
  "payroll.import-ytd": payruns("edit"),

  "payroll.leave": employees("view"),
  "payroll.request-leave": employees("edit"),
  "payroll.decide-leave": employees("edit"),
  "payroll.cancel-leave": employees("edit"),
  "payroll.leave-opening": employees("edit"),

  "payroll.hire-options": settings("view"),
  "payroll.start-hire": ADMIN_ONLY,
  "payroll.link-agent": ADMIN_ONLY,
  "payroll.unlink-agent": ADMIN_ONLY,
  "payroll.sync-skills": settings("edit"),

  "tool:payroll-overview": payruns("view"),
  "tool:payroll-rules": settings("view"),
  "tool:list-employees": employees("view"),
  "tool:list-pay-runs": payruns("view"),
  "tool:get-pay-run": payruns("view"),
  "tool:create-pay-run": payruns("create"),
  "tool:calculate-pay-run": payruns("edit"),
  "tool:adjust-pay-run-item": payruns("edit"),
  "tool:pay-run-variances": payruns("view"),
  "tool:request-pay-run-approval": payruns("edit"),
  "tool:list-leave": employees("view"),
  "tool:leave-balances": employees("view"),
  "tool:request-leave": employees("edit"),
  "tool:emp201-summary": payruns("view"),
  "tool:mark-emp201-filed": payruns("edit"),
  "tool:emp501-summary": payruns("view"),

  // Setup's checklist for Payroll (the Setup page and the "Get started" card).
  "api:setup-status": settings("view"),
  // The Cockpit's Payroll numbers.
  "api:cockpit": payruns("view"),
});
