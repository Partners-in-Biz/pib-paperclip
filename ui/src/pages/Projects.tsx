import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { ProjectTile } from "../components/ProjectTile";
import { StatusBadge } from "../components/StatusBadge";
import { MembershipAction } from "../components/MembershipAction";
import { StarToggle } from "../components/StarToggle";
import { ArtifactEmptyGraphic } from "@/components/artifacts/v1/ArtifactEmptyGraphic";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { cn, formatDate, formatNumber, formatProjectBudget, projectUrl } from "../lib/utils";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { ProjectsToolbar, type ProjectSortField, type ProjectSortDir } from "@/components/ProjectsToolbar";
import { ArchiveRestore, ChevronRight, Hexagon, Loader2 } from "lucide-react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

function compareProjectNames(left: Project, right: Project) {
  const nameDiff = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  return nameDiff !== 0 ? nameDiff : left.id.localeCompare(right.id);
}

function projectTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareOptionalTime(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
  sortDir: ProjectSortDir,
) {
  const leftTime = projectTime(left);
  const rightTime = projectTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return sortDir === "asc" ? leftTime - rightTime : rightTime - leftTime;
}

function sortProjects(projects: Project[], sortField: ProjectSortField, sortDir: ProjectSortDir) {
  return [...projects].sort((left, right) => {
    let comparison = 0;
    if (sortField === "name") {
      comparison = compareProjectNames(left, right);
      return sortDir === "asc" ? comparison : -comparison;
    }

    if (sortField === "updated") comparison = compareOptionalTime(left.updatedAt, right.updatedAt, sortDir);
    else if (sortField === "created") comparison = compareOptionalTime(left.createdAt, right.createdAt, sortDir);
    else comparison = compareOptionalTime(left.targetDate, right.targetDate, sortDir);

    if (comparison === 0) comparison = compareProjectNames(left, right);
    return comparison;
  });
}

function matchProjects(projects: Project[], query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return projects.filter(project => {
    const text = `${project.name} ${project.description ?? ""}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}

function taskCountLabel(project: Project) {
  const count = project.taskCount ?? 0;
  return `${formatNumber(count)} task${count === 1 ? "" : "s"}`;
}

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");
  const [sortField, setSortField] = useState<ProjectSortField>("name");
  const [sortDir, setSortDir] = useState<ProjectSortDir>("asc");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const projectsQuery = useQuery({
    // Archived projects come along so the page can list them for unarchiving.
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });
  const { data: allProjects, isLoading } = projectsQuery;
  const projectsView = useQueryView(projectsQuery);
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const unarchiveMutation = useMutation({
    mutationFn: (project: Project) =>
      projectsApi.update(project.id, { archivedAt: null }, selectedCompanyId!),
    onSuccess: (_updated, project) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(selectedCompanyId!) });
      pushToast({ title: `"${project.name}" has been unarchived`, tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to unarchive project", tone: "error" });
    },
  });
  const projects = useMemo(
    () => (allProjects ?? []).filter(project => !project.archivedAt),
    [allProjects],
  );
  const archivedProjects = useMemo(
    () => (allProjects ?? []).filter(project => !!project.archivedAt),
    [allProjects],
  );
  const sortedProjects = useMemo(
    () => sortProjects(matchProjects(projects, query), sortField, sortDir),
    [projects, query, sortDir, sortField],
  );
  const sortedArchivedProjects = useMemo(
    () => sortProjects(matchProjects(archivedProjects, query), sortField, sortDir),
    [archivedProjects, query, sortDir, sortField],
  );
  // A search opens the section, so a match in an archived project is never hidden.
  const showArchivedRows = archivedOpen || query.trim().length > 0;
  const groupedProjects = useMemo(() => {
    const groups = {
      mine: [] as typeof sortedProjects,
      other: [] as typeof sortedProjects,
    };

    for (const project of sortedProjects) {
      const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
      if (state === "left") groups.other.push(project);
      else groups.mine.push(project);
    }

    return groups;
  }, [membershipsQuery.data, sortedProjects]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select an organization to view projects." />;
  }

  // Keep a loaded list on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (isLoading || projectsView.kind === "reconnecting") {
    return <PageSkeleton variant="list" />;
  }
  if (projectsView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={projectsView.error}
        action="load projects"
        onRetry={projectsView.retry}
        retrying={projectsView.isFetching}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ProjectsToolbar query={query} onQueryChange={setQuery} sortField={sortField} sortDir={sortDir}
        onSortChange={(field, direction) => { setSortField(field); setSortDir(direction); }} onNewProject={openNewProject} />

      {!isLoading && projects.length === 0 && archivedProjects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          graphic={<ArtifactEmptyGraphic stack />}
          message="No projects yet."
          action="Create project"
          hideActionIcon
          onAction={openNewProject}
        />
      )}

      {projects.length + archivedProjects.length > 0 && query.trim().length > 0 && sortedProjects.length === 0 && sortedArchivedProjects.length === 0 && <p className="text-sm text-muted-foreground">No projects match your search.</p>}

      {sortedProjects.length > 0 && (
        <div className="space-y-6">
          {([
            ["My Projects", groupedProjects.mine],
            ["Other Projects", groupedProjects.other],
          ] as const).map(([label, sectionProjects]) => {
            if (sectionProjects.length === 0) return null;

            return (
              <section key={label} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">{label}</h2>
                  <span className="text-xs text-muted-foreground">
                    {sectionProjects.length} project{sectionProjects.length === 1 ? "" : "s"}
                  </span>
                </div>
                <Card className="block py-0 overflow-hidden divide-y divide-border">
                  {sectionProjects.map((project) => {
                    const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
                    const pending = membershipMutation.isPending &&
                      membershipMutation.variables?.resourceType === "project" &&
                      membershipMutation.variables.resourceId === project.id;
                    const starPending = pending && membershipMutation.variables?.starred !== undefined;
                    const joinLeavePending = pending && membershipMutation.variables?.starred === undefined;
                    const starred = isStarred(membershipsQuery.data, "project", project.id);
                    return (
                      <EntityRow
                        key={project.id}
                        leading={<ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="sm" />}
                        title={project.name}
                        subtitle={project.description ?? undefined}
                        reserveSubtitleSpace
                        to={projectUrl(project)}
                        className={state === "left" ? "group text-foreground/55" : "group"}
                        trailing={
                          <div className="flex items-center gap-3">
                            {project.visibility === "private" ? <Lock className="size-4 shrink-0 text-muted-foreground" aria-label="Private project" /> : null}
                            <span
                              className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
                              title={`${formatNumber(project.taskCount ?? 0)} task${(project.taskCount ?? 0) === 1 ? "" : "s"}`}
                            >
                              {formatNumber(project.taskCount ?? 0)} task{(project.taskCount ?? 0) === 1 ? "" : "s"}
                            </span>
                            {project.budget && (
                              <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                                {formatProjectBudget(project.budget)}
                              </span>
                            )}
                            {project.targetDate && (
                              <span className="hidden text-xs text-muted-foreground md:inline">
                                {formatDate(project.targetDate)}
                              </span>
                            )}
                            <StatusBadge status={project.status} />
                            <MembershipAction
                              state={state}
                              pending={joinLeavePending}
                              pendingState={joinLeavePending ? membershipMutation.variables?.state : null}
                              resourceName={project.name}
                              onJoin={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "joined",
                              })}
                              onLeave={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "left",
                              })}
                            />
                            <StarToggle
                              size="row"
                              starred={starred}
                              pending={starPending}
                              resourceName={project.name}
                              onToggle={(next) => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                starred: next,
                              })}
                            />
                          </div>
                        }
                      />
                    );
                  })}
                </Card>
              </section>
            );
          })}
        </div>
      )}

      {sortedArchivedProjects.length > 0 && (
        <section className="space-y-2" data-testid="archived-projects">
          <div className="flex items-center justify-between">
            <button
              type="button"
              aria-expanded={showArchivedRows}
              onClick={() => setArchivedOpen(open => !open)}
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn("size-4 transition-transform", showArchivedRows && "rotate-90")} />
              <span>Archived</span>
            </button>
            <span className="text-xs text-muted-foreground">
              {sortedArchivedProjects.length} project{sortedArchivedProjects.length === 1 ? "" : "s"}
            </span>
          </div>
          {showArchivedRows && (
            <Card className="block py-0 overflow-hidden divide-y divide-border">
              {sortedArchivedProjects.map((project) => {
                const pending = unarchiveMutation.isPending && unarchiveMutation.variables?.id === project.id;
                return (
                  <EntityRow
                    key={project.id}
                    leading={<ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="sm" />}
                    title={project.name}
                    subtitle={project.description ?? undefined}
                    reserveSubtitleSpace
                    to={projectUrl(project)}
                    className="text-foreground/55"
                    trailing={
                      <div className="flex items-center gap-3">
                        {project.visibility === "private" ? <Lock className="size-4 shrink-0 text-muted-foreground" aria-label="Private project" /> : null}
                        <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline" title={taskCountLabel(project)}>
                          {taskCountLabel(project)}
                        </span>
                        {project.archivedAt && (
                          <span className="hidden text-xs text-muted-foreground md:inline">
                            Archived {formatDate(project.archivedAt)}
                          </span>
                        )}
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          aria-label={`Unarchive ${project.name}`}
                          aria-busy={pending ? "true" : undefined}
                          disabled={pending}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!pending) unarchiveMutation.mutate(project);
                          }}
                        >
                          {pending
                            ? <Loader2 className="h-3 w-3 motion-safe:animate-spin" />
                            : <ArchiveRestore className="h-3 w-3" />}
                          <span>{pending ? "Unarchiving..." : "Unarchive"}</span>
                        </Button>
                      </div>
                    }
                  />
                );
              })}
            </Card>
          )}
        </section>
      )}
    </div>
  );
}
