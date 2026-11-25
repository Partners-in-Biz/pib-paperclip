import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ResourceMembershipResourceType,
  ResourceMembershipState,
  ResourceMemberships,
} from "@paperclipai/shared";
import { authApi } from "../api/auth";
import { memberRestrictionFor } from "../lib/member-restriction";
import { resourceMembershipsApi } from "../api/resourceMemberships";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { useMemberRestrictionGate } from "./useMemberRestrictionGate";

type MutationVariables = {
  resourceType: JoinableResourceType;
  resourceId: string;
  resourceName: string;
  /** Join / leave transition. Omit to only change the starred flag. */
  state?: ResourceMembershipState;
  /** Star / unstar transition. Omit to only change join/leave state. */
  starred?: boolean;
};

/** Thrown instead of sending a closed write; no toast, no cache change. */
class ClosedMembershipsError extends Error {}

type JoinableResourceType = Exclude<ResourceMembershipResourceType, "document">;

function emptyMemberships(): ResourceMemberships {
  return {
    projectMemberships: {},
    agentMemberships: {},
    starredProjectIds: [],
    starredAgentIds: [],
    starredDocumentIds: [],
    projectStarredAt: {},
    agentStarredAt: {},
    documentStarredAt: {},
    updatedAt: null,
  };
}

/**
 * The fixed answer for a restricted member under `enforce` (AC-G10): `resource-memberships/me`
 * is closed for him, so nothing is requested and the absent answer reads as "joined, not starred".
 */
export const EMPTY_RESOURCE_MEMBERSHIPS: ResourceMemberships = emptyMemberships();

function starKeys(resourceType: JoinableResourceType) {
  return resourceType === "project"
    ? { ids: "starredProjectIds", at: "projectStarredAt", state: "projectMemberships" }
    : { ids: "starredAgentIds", at: "agentStarredAt", state: "agentMemberships" };
}

/**
 * Apply an optimistic membership change to the cached memberships snapshot.
 * Mirrors the server rules (see server/src/services/resource-memberships.ts):
 *   - starred=true always implies joined and stamps starredAt,
 *   - starred=false clears the star but leaves join/leave state alone,
 *   - state="left" clears any star (you cannot star a left resource).
 */
function applyMembershipChange(
  current: ResourceMemberships | undefined,
  resourceType: JoinableResourceType,
  resourceId: string,
  change: { state?: ResourceMembershipState; starred?: boolean },
): ResourceMemberships {
  const base = current ?? emptyMemberships();
  const keys = starKeys(resourceType);

  // Resolve next join/leave state (starring implies joined).
  const currentStateMap = base[keys.state as "projectMemberships"] ?? {};
  const previousState: ResourceMembershipState =
    currentStateMap[resourceId] === "left" ? "left" : "joined";
  const nextState: ResourceMembershipState =
    change.starred === true ? "joined" : change.state ?? previousState;

  // Resolve next starred set.
  const currentStarredIds = base[keys.ids as "starredProjectIds"] ?? [];
  const nextStarredAt = { ...(base[keys.at as "projectStarredAt"] ?? {}) };
  const previouslyStarred = currentStarredIds.includes(resourceId);
  const nextStarred =
    nextState === "left"
      ? false
      : change.starred === true
        ? true
        : change.starred === false
          ? false
          : previouslyStarred;

  let starredIds = currentStarredIds;
  if (nextStarred && !previouslyStarred) {
    // Newest star sorts first, matching the server's starredAt DESC ordering.
    starredIds = [resourceId, ...currentStarredIds];
    nextStarredAt[resourceId] = new Date();
  } else if (!nextStarred && previouslyStarred) {
    starredIds = currentStarredIds.filter((id) => id !== resourceId);
    delete nextStarredAt[resourceId];
  }

  return {
    ...base,
    [keys.state]: {
      ...currentStateMap,
      [resourceId]: nextState,
    },
    [keys.ids]: starredIds,
    [keys.at]: nextStarredAt,
    updatedAt: new Date(),
  };
}

export function resourceMembershipState(
  memberships: ResourceMemberships | undefined,
  resourceType: JoinableResourceType,
  resourceId: string,
): ResourceMembershipState {
  const state = resourceType === "project"
    ? memberships?.projectMemberships[resourceId]
    : memberships?.agentMemberships[resourceId];
  return state === "left" ? "left" : "joined";
}

/** Whether the current viewer has starred this resource (navigation preference). */
export function isStarred(
  memberships: ResourceMemberships | undefined,
  resourceType: ResourceMembershipResourceType,
  resourceId: string,
): boolean {
  const ids = resourceType === "project"
    ? memberships?.starredProjectIds
    : resourceType === "agent"
      ? memberships?.starredAgentIds
      : memberships?.starredDocumentIds;
  return Array.isArray(ids) && ids.includes(resourceId);
}

/** Ordered starred ids (server returns starredAt DESC; falls back to empty). */
export function starredResourceIds(
  memberships: ResourceMemberships | undefined,
  resourceType: ResourceMembershipResourceType,
): string[] {
  const ids = resourceType === "project"
    ? memberships?.starredProjectIds
    : resourceType === "agent"
      ? memberships?.starredAgentIds
      : memberships?.starredDocumentIds;
  return Array.isArray(ids) ? ids : [];
}

export function useResourceMemberships(companyId: string | null | undefined) {
  const gate = useMemberRestrictionGate(companyId);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const enforced = memberRestrictionFor(session?.memberRestrictions, companyId).enforced;
  return useQuery({
    queryKey: queryKeys.resourceMemberships.mine(companyId ?? "__none__"),
    queryFn: gate.guard(() => resourceMembershipsApi.listMine(companyId!), EMPTY_RESOURCE_MEMBERSHIPS),
    enabled: !!companyId && !gate.closed,
    // A returned value, never written to the cache: an owner must not inherit "no stars".
    placeholderData: enforced ? EMPTY_RESOURCE_MEMBERSHIPS : undefined,
  });
}

/**
 * Whether the star and join controls show. False for a restricted member under `enforce`
 * and while the session is unknown: his memberships are closed, so the controls would only fail.
 */
export function useResourceMembershipControls(companyId: string | null | undefined): boolean {
  return !useMemberRestrictionGate(companyId).closed;
}

export function useResourceMembershipMutation(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const queryKey = queryKeys.resourceMemberships.mine(companyId ?? "__none__");
  const closed = useMemberRestrictionGate(companyId).closed;

  return useMutation({
    mutationFn: (variables: MutationVariables) => {
      if (closed) throw new ClosedMembershipsError();
      if (!companyId) throw new Error("Select an organization first.");
      const body = { state: variables.state, starred: variables.starred };
      return variables.resourceType === "project"
        ? resourceMembershipsApi.updateProject(companyId, variables.resourceId, body)
        : resourceMembershipsApi.updateAgent(companyId, variables.resourceId, body);
    },
    onMutate: async (variables) => {
      if (closed) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ResourceMemberships>(queryKey);
      queryClient.setQueryData<ResourceMemberships>(
        queryKey,
        applyMembershipChange(previous, variables.resourceType, variables.resourceId, {
          state: variables.state,
          starred: variables.starred,
        }),
      );
      return { previous };
    },
    onError: (error, variables, context) => {
      if (error instanceof ClosedMembershipsError) return;
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      const verb = variables.starred !== undefined
        ? variables.starred ? "star" : "unstar"
        : variables.state === "left" ? "leave" : "join";
      pushToast({
        title: `Couldn't ${verb} ${variables.resourceName}.`,
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData<ResourceMemberships>(
        queryKey,
        // Loose null-check: a missing or null starredAt both mean "not starred".
        (current) => applyMembershipChange(current, variables.resourceType, result.resourceId, {
          state: result.state,
          starred: result.starredAt != null,
        }),
      );
    },
    onSettled: () => {
      if (closed) return;
      queryClient.invalidateQueries({ queryKey: ["primary-agent", companyId] });
      queryClient.invalidateQueries({ queryKey });
    },
  });
}
