import type { AuthorizationAction } from "../authorization.js";

/**
 * PAR-12608 rev 3, 4.6 "The action list": which `decide()` actions a caller
 * who works for a restricted person may still ask for. An allowed action is
 * still subject to its own rule (and, where it names a task or project, to the
 * strict check of 4.3); a denied one is `deny_member_restricted`.
 *
 * The map covers the full `AuthorizationAction` union, so an action added to
 * core later does not compile until somebody decides it here. The default for
 * anything new is "denied".
 */
export type MemberRestrictionActionRule = "allowed" | "denied";
export type MemberRestrictionActionList = Record<AuthorizationAction, MemberRestrictionActionRule>;

export const MEMBER_RESTRICTION_ACTION_LIST = {
  // His own work: tasks and projects, filtered by 4.3.
  "issue:read": "allowed",
  "issue:comment": "allowed",
  "issue:mutate": "allowed",
  "project:read": "allowed",
  "project:write_workspace": "allowed",
  // Assigning and instructing agents (4.7), tool calls of a run (4.9).
  "tasks:assign": "allowed",
  "agent:read": "allowed",
  "agent:wake": "allowed",
  "tools:use": "allowed",

  // Company-wide reads; run events reach him only through the route table (C18).
  "company_scope:read": "denied",
  // Company set-up: agents, skills, environments.
  "agents:create": "denied",
  "agents:read": "denied",
  "agents:configure": "denied",
  "agents:suggest-changes": "denied",
  "agent_config:read": "denied",
  "agent_config:update": "denied",
  "agent_instructions:update": "denied",
  "skills:create": "denied",
  "skills:suggest-changes": "denied",
  "skill_config:update": "denied",
  "environments:manage": "denied",
  // Tools administration and audit.
  "tools:admin": "denied",
  "tools:manage_connections": "denied",
  "tools:manage_profiles": "denied",
  "tools:view_audit": "denied",
  "tools:manage_runtime": "denied",
  "audit:view_agent_actions": "denied",
  "commentary:view": "denied",
  // People and access.
  "users:invite": "denied",
  "users:manage_permissions": "denied",
  "joins:approve": "denied",
  "inbox:manage": "denied",
  // Task administration beyond his own assignments.
  "tasks:assign_scope": "denied",
  "tasks:manage_active_checkouts": "denied",
  // Connection management.
  "connections:read": "denied",
  "connections:configure": "denied",
  "connections:profiles": "denied",
  "connections:gateway": "denied",
  "connections:audit": "denied",
  "connections:runtime": "denied",
  "connections:test": "denied",
  // Decision queues, runtime and secrets.
  "decision_queue:manage": "denied",
  "decision_queue:read": "denied",
  "decision_triage:manage": "denied",
  "runtime:manage": "denied",
  "runtime:confirm_owner_stop": "denied",
  "secrets:read": "denied",
  "secrets:propose": "denied",
} as const satisfies MemberRestrictionActionList;

/** Whether a restricted member may ask for this action at all. Unknown at run time: denied. */
export function memberRestrictionAllowsAction(action: AuthorizationAction): boolean {
  return (MEMBER_RESTRICTION_ACTION_LIST as Partial<MemberRestrictionActionList>)[action] === "allowed";
}
