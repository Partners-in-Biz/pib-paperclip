import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { IssuesList } from "@/components/IssuesList";
import { IssueProperties } from "@/components/IssueProperties";
import { defaultIssueFilterState } from "@/lib/issue-filters";
import { saveTaskCollectionPreferences } from "@/lib/task-collection-preferences";
import { queryKeys } from "@/lib/queryKeys";
import { createIssue, storybookAgents, storybookAuthSession, storybookCompanies, storybookProjects } from "../../fixtures/paperclipData";

const companyId = "company-storybook";
const viewStateKey = "storybook:created-by:list";
const LONG_ROUTINE = "Weekly client retention digest for every Partners in Biz retainer customer across all regions";

const base = { status: "todo" as const, checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, executionWorkspaceId: null, currentExecutionWorkspace: null, startedAt: null, labelIds: [], labels: [] };
const tasks = [
  createIssue({ id: "cb-person", identifier: "PAP-2101", title: "Made by a person's click in a plugin", createdByUserId: "user-board", createdByAgentId: null }),
  createIssue({ id: "cb-agent", identifier: "PAP-2102", title: "Made by an agent", createdByUserId: null, createdByAgentId: "agent-codex" }),
  createIssue({ id: "cb-seo", identifier: "PAP-2103", title: "Made by the SEO plugin", originKind: "plugin:partnersinbiz.seo", createdByUserId: null, createdByAgentId: null }),
  createIssue({ id: "cb-mail", identifier: "PAP-2104", title: "Made by the Mailbox plugin", originKind: "plugin:partnersinbiz.mailbox", createdByUserId: null, createdByAgentId: null }),
  createIssue({ id: "cb-routine", identifier: "PAP-2105", title: "Made by a routine with a very long name", originKind: "routine_execution", originId: "routine-long", createdByUserId: null, createdByAgentId: null }),
].map((issue) => ({ ...issue, ...base }));

function useSeed() {
  const queryClient = useQueryClient();
  useState(() => {
    queryClient.setQueryData(queryKeys.companies.all, { companies: storybookCompanies, unauthorized: false });
    queryClient.setQueryData(queryKeys.auth.session, storybookAuthSession);
    queryClient.setQueryData(queryKeys.agents.list(companyId), storybookAgents);
    queryClient.setQueryData(queryKeys.projects.list(companyId), storybookProjects);
    queryClient.setQueryData(queryKeys.instance.experimentalSettings, { enableIsolatedWorkspaces: false, enableStreamlinedUi: true });
    queryClient.setQueryData(queryKeys.routines.detail("routine-long"), { id: "routine-long", title: LONG_ROUTINE });
    saveTaskCollectionPreferences({ companyId, collectionKey: viewStateKey, legacyViewStorageKey: `${viewStateKey}:${companyId}` }, {
      viewState: { ...defaultIssueFilterState, showAgentCreatedTasks: true, viewMode: "list", groupBy: "none", sortField: "updated", sortDir: "desc", nestingEnabled: false, collapsedParents: [], collapsedGroups: [] },
      columns: ["status", "id", "assignee", "kickedOffBy", "updated"],
    });
    return true;
  });
}

function List() {
  useSeed();
  return (
    <div className="paperclip-story min-h-screen bg-background p-6 text-foreground">
      <IssuesList issues={tasks} agents={storybookAgents} projects={storybookProjects} viewStateKey={viewStateKey} enableAgentCreatedVisibilityFilter searchWithinLoadedIssues rowPresentation="task" toolbarPresentation="collection" onUpdateIssue={() => undefined} />
    </div>
  );
}

function Panes() {
  useSeed();
  return (
    <div className="paperclip-story grid gap-4 bg-background p-6 text-foreground sm:grid-cols-2">
      {tasks.map((issue) => (
        <div key={issue.id} className="w-full min-w-0 max-w-80 border border-border bg-card p-4">
          <IssueProperties issue={issue} childIssues={[]} onAddSubIssue={() => undefined} onUpdate={() => undefined} />
        </div>
      ))}
    </div>
  );
}

const meta = {
  id: "product-task-created-by",
  title: "Tasks and conversations/Task creation and lifecycle/Product/Created by",
  component: List,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Who created a task: a person, an agent, or an automation named by its source (SEO, Mailbox, Routine: <name>), in the task list column and the task page row." } },
    paperclip: {
      "capabilities": ["tasks/properties", "tasks/organize"],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production task list and Properties panel with fixture tasks for each creator kind; the long routine name is simulated from the cached routine detail."
    },
  },
} satisfies Meta<typeof List>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ListColumn: Story = { name: "Created by - list column", render: () => <List /> };
export const PropertiesRow: Story = { name: "Created by - task page row", render: () => <Panes /> };
