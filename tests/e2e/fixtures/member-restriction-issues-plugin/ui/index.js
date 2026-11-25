// The host rewrites these bare imports to its shared React and SDK (ui/src/plugins/slots.tsx).
import { createElement } from "react";
import { IssuesList } from "@paperclipai/plugin-sdk/ui";

export function IssuesPage({ context }) {
  return createElement("div", { "data-testid": "mr-plugin-issues" },
    createElement(IssuesList, { companyId: context.companyId, viewStateKey: "paperclip:e2e-mr-issues-view" }));
}
