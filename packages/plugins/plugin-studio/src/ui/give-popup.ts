/** Give to agent (PAR-8138): the pure parts of the popup flow, kept out of React so they can be tested. */
import type { HandoffCreatedIssue, HandoffIssueDefaults, HandoffNewIssue } from "@partnersinbiz/pib-plugin-ui";

/** What `give-prepare` returns: the popup prefill plus the id of this give's file copy. */
export interface GivePrefill {
  giveId: string;
  title: string;
  description: string;
  projectId: string | null;
}

export function popupDefaults(prefill: GivePrefill): HandoffIssueDefaults {
  return { title: prefill.title, description: prefill.description, ...(prefill.projectId ? { projectId: prefill.projectId } : {}) };
}

/**
 * Wraps the host popup so a popup closed without a task (or one that fails) removes this give's copy. Exported for
 * the test: `discard` runs once, only when no issue came back.
 */
export function withDiscard(host: HandoffNewIssue, current: () => string | null, discard: (giveId: string) => Promise<unknown>): HandoffNewIssue {
  return {
    async open(defaults) {
      let issue: HandoffCreatedIssue | null = null;
      try {
        issue = await host.open(defaults);
        return issue;
      } finally {
        const giveId = current();
        if (!issue && giveId) await discard(giveId).catch(() => undefined);
      }
    },
  };
}
