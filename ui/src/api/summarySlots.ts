import type {
  CancelSummarySlotResponse,
  GenerateSummarySlotResponse,
  GetSummarySlotResponse,
  ListSummarySlotRevisionsResponse,
  SummarySlotKey,
  SummarySlotScopeKind,
} from "@paperclipai/shared";
import { api } from "./client";

export interface SummarySlotSelector {
  companyId: string;
  scopeKind: SummarySlotScopeKind;
  scopeId?: string | null;
  slotKey: SummarySlotKey;
}

function summarySlotPath(selector: SummarySlotSelector, suffix = "") {
  const params = new URLSearchParams();
  if (selector.scopeId) params.set("scopeId", selector.scopeId);
  const query = params.toString();
  return [
    `/companies/${selector.companyId}/summary-slots/${selector.scopeKind}/${selector.slotKey}`,
    suffix,
    query ? `?${query}` : "",
  ].join("");
}

export const summarySlotsApi = {
  get: (selector: SummarySlotSelector) =>
    api.get<GetSummarySlotResponse>(summarySlotPath(selector)),
  revisions: (selector: SummarySlotSelector) =>
    api.get<ListSummarySlotRevisionsResponse>(summarySlotPath(selector, "/revisions")),
  generate: (selector: SummarySlotSelector) =>
    api.post<GenerateSummarySlotResponse>(
      summarySlotPath(selector, "/generate"),
      { scopeId: selector.scopeId ?? null },
    ),
  cancel: (selector: SummarySlotSelector) =>
    api.post<CancelSummarySlotResponse>(
      summarySlotPath(selector, "/cancel"),
      { scopeId: selector.scopeId ?? null },
    ),
};
