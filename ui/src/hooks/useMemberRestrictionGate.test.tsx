// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMemberRestriction } from "@paperclipai/shared";
import { ApiError } from "../api/api-error";
import { queryKeys } from "../lib/queryKeys";
import { isMemberRestrictedError, useMemberRestrictionGate, type MemberRestrictionGate } from "./useMemberRestrictionGate";

// AC-G10, the in-page half (PAR-12930): a closed company-wide list is not
// requested for a person restricted under `enforce`, and a stale session's 403
// `MEMBER_RESTRICTED` on it is "nothing to show", never an error.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_ID = "company-1";
const session = vi.hoisted(() => ({ memberRestrictions: [] as SessionMemberRestriction[] }));
vi.mock("../api/auth", () => ({
  authApi: { getSession: async () => ({ session: { id: "s", userId: "u" }, user: null, memberRestrictions: session.memberRestrictions }) },
}));

const restrictedError = () => new ApiError("Not available", 403, { error: "Not available", code: "MEMBER_RESTRICTED" });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;
let gate: MemberRestrictionGate | null = null;
let list: { data?: string[]; error: unknown; fetchStatus: string } | null = null;

function Harness({ fetchList }: { fetchList: () => Promise<string[]> }) {
  gate = useMemberRestrictionGate(COMPANY_ID);
  const query = useQuery({
    queryKey: ["labels", COMPANY_ID],
    queryFn: gate.guard(fetchList, [] as string[]),
    enabled: !gate.closed,
    retry: false,
  });
  list = { data: query.data, error: query.error, fetchStatus: query.fetchStatus };
  return null;
}

async function render(fetchList: () => Promise<string[]>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><Harness fetchList={fetchList} /></QueryClientProvider>);
  });
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  session.memberRestrictions = [];
  gate = null;
  list = null;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client.clear();
});

describe("useMemberRestrictionGate", () => {
  it("closes the list and sends no request for a person restricted under enforce", async () => {
    session.memberRestrictions = [{ companyId: COMPANY_ID, restricted: true, mode: "enforce" }];
    const fetchList = vi.fn(async () => ["label"]);
    await render(fetchList);
    expect(gate?.closed).toBe(true);
    expect(fetchList).not.toHaveBeenCalled();
  });

  it.each([
    ["restricted under report (a full operator)", { restricted: true, mode: "report" as const }],
    ["restricted under off", { restricted: true, mode: "off" as const }],
    ["not restricted under enforce", { restricted: false, mode: "enforce" as const }],
  ])("sends the same request as today when %s", async (_name, entry) => {
    session.memberRestrictions = [{ companyId: COMPANY_ID, ...entry }];
    const fetchList = vi.fn(async () => ["label"]);
    await render(fetchList);
    expect(gate?.closed).toBe(false);
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(list?.data).toEqual(["label"]);
  });

  it("answers a stale session's 403 MEMBER_RESTRICTED with nothing to show and refreshes the session", async () => {
    session.memberRestrictions = [{ companyId: COMPANY_ID, restricted: true, mode: "report" }];
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await render(async () => { throw restrictedError(); });
    expect(list?.error).toBeNull();
    expect(list?.data).toEqual([]);
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toEqual(expect.arrayContaining([
      JSON.stringify(queryKeys.auth.session),
      JSON.stringify(queryKeys.access.currentBoardAccess),
      JSON.stringify(queryKeys.access.memberRestrictionMode(COMPANY_ID)),
    ]));
    invalidate.mockRestore();
  });

  it("keeps every other error an error, a plain 403 included", async () => {
    await render(async () => { throw new ApiError("Forbidden", 403, { error: "Forbidden" }); });
    expect(list?.error).toBeInstanceOf(ApiError);
  });
});

describe("isMemberRestrictedError", () => {
  it("matches only a 403 whose body code is MEMBER_RESTRICTED", () => {
    expect(isMemberRestrictedError(restrictedError())).toBe(true);
    expect(isMemberRestrictedError(new ApiError("x", 404, { code: "MEMBER_RESTRICTED" }))).toBe(false);
    expect(isMemberRestrictedError(new ApiError("x", 403, { code: "OTHER" }))).toBe(false);
    expect(isMemberRestrictedError(new Error("MEMBER_RESTRICTED"))).toBe(false);
  });
});
