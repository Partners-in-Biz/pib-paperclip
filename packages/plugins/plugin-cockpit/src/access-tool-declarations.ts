/**
 * Declarations for the access look-up tools (`partnersinbiz.cockpit:access-check`,
 * `access-request`, `access-grant`). The handlers are in access.ts.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { ACCESS_TOOL_NAMES } from "./access-model.js";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const ACCESS_TOOLS: PluginToolDeclaration[] = [
  {
    name: ACCESS_TOOL_NAMES.check,
    displayName: "Check access",
    description:
      'Look access up before you say "I have no access". Answers in plain words, with names only (never a secret value): (1) tool: may a seat use this tool, and if not, which seats and tool profiles have it and who can give it; (2) secret: does the company hold a stored secret with a name like this, and which seats have it attached and under which environment variable; (3) permission: which seats hold a permission such as tasks:assign. The seat is you unless you pass another. With no question it lists what the seat has now. A 403 or "forbidden" on reading a profile, a grant or a secret is not an answer: this tool is. If the answer is yes and a call still fails, the cause is not access, so quote the exact error. If the answer is no, it names the seat that decides and the next call to make.',
    parametersSchema: schema([], {
      tool: { type: "string", maxLength: 200, description: 'A tool name: the full name ("partnersinbiz.studio:studio-usage") or the short one ("studio-usage").' },
      secret: { type: "string", maxLength: 160, description: 'A stored secret\'s name, key or a part of it ("gun auctions ssh", "VERCEL_TOKEN"). Names only come back.' },
      permission: { type: "string", maxLength: 120, description: 'A permission key, e.g. "tasks:assign", "agents:configure", "tools:use".' },
      seat: { type: "string", maxLength: 120, description: "The seat to check: an agent's name or id. Left out, it is you." },
    }),
  },
  {
    name: ACCESS_TOOL_NAMES.request,
    displayName: "Request access",
    description:
      "Ask for access that already exists in the company: a plugin tool your seat cannot call, or a stored secret that is not attached to your seat. Opens ONE child issue for the seat that decides access (never the owner), with the seat, the exact tool or secret name, the task that needs it and the error you got; it blocks your task on it and you are woken when it is decided. Asking again for the same thing joins the open request. It refuses when the access is already there (it then says how to use it), when the name matches nothing, and for a payment, banking or personal login, which only the owner can give. Run access-check first to get the exact name. After it returns, end your run.",
    parametersSchema: schema(["issueId", "kind", "name", "error"], {
      issueId: { type: "string", description: "The task that needs the access (id or identifier, e.g. PAR-123). It is blocked until the request is decided." },
      kind: { type: "string", enum: ["tool", "secret"], description: "tool: a plugin tool. secret: a stored company secret to attach to the seat." },
      name: { type: "string", maxLength: 200, description: "The exact tool name or the exact stored secret name, as access-check gave it." },
      error: { type: "string", maxLength: 800, description: "The text of the error or refusal you got, word for word. Never paste a secret value." },
      why: { type: "string", maxLength: 400, description: "One line: what the task needs it for." },
      envName: { type: "string", pattern: "^[A-Z][A-Z0-9_]{1,63}$", description: "For a secret: the environment variable name your work reads it from, e.g. SAGA_SSH_PASSWORD. Left out, it is made from the secret's key." },
      seat: { type: "string", maxLength: 120, description: "The seat that needs it: an agent's name or id. Left out, it is you." },
    }),
  },
  {
    name: ACCESS_TOOL_NAMES.grant,
    displayName: "Decide an access request",
    description:
      'Only for the seat that decides access (decision rights: access that already exists). Carries the decision out. Pass the request issue and yes or no with one line of reason. A yes for a tool adds that one tool to the seat\'s tools grant at once, logs one line on the task and closes the request, which wakes the asker. A yes for a stored secret puts one fixed-format line on the board\'s queue issue (attaching a secret is a board-only call), and the request closes by itself when the secret shows on the seat. It refuses a payment, banking or personal login (those go to the owner), your own seat, and anything already in place. To give access with no request, pass seat, kind, name and issueId (the task it is for) instead of requestIssueId.',
    parametersSchema: schema(["reason"], {
      requestIssueId: { type: "string", description: 'The access request to decide (id or identifier). Its title starts with "Access request".' },
      decision: { type: "string", enum: ["yes", "no"], description: "yes when the seat's task needs it; no with the one thing that would change it. Left out, it is yes." },
      reason: { type: "string", maxLength: 300, description: "One line: why, and for which task. It is logged on the issue." },
      seat: { type: "string", maxLength: 120, description: "With no request: the seat that gets the access (name or id)." },
      kind: { type: "string", enum: ["tool", "secret"], description: "With no request: tool or secret." },
      name: { type: "string", maxLength: 200, description: "With no request: the exact tool or stored secret name." },
      envName: { type: "string", pattern: "^[A-Z][A-Z0-9_]{1,63}$", description: "With no request, for a secret: the environment variable name on the seat." },
      issueId: { type: "string", description: "With no request: the task the access is for (id or identifier). The line is logged there." },
    }),
  },
];
