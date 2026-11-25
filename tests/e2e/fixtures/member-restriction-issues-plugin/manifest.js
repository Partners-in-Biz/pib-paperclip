// A page that renders the host's `PluginSdkIssuesList` (ui/src/plugins/bridge-init.ts), for AC-G10.
export default {
  id: "paperclip.e2e-mr-issues",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "MR Issues (e2e)",
  description: "Browser-test fixture: a plugin page with the SDK issues list.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: ["ui.page.register"],
  entrypoints: { worker: "./worker.js", ui: "./ui" },
  ui: {
    slots: [{ type: "page", id: "mr-issues-page", displayName: "MR Issues", exportName: "IssuesPage", routePath: "mr-issues" }],
  },
};
