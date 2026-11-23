import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { scheduleCanvasRefsRefresh } from "./LiveUpdatesProvider";

describe("scheduleCanvasRefsRefresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("invalidates canvas refs once per window for linked entity events, within 2 s", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    scheduleCanvasRefsRefresh(queryClient, "c1", "issue", "issue.updated");
    scheduleCanvasRefsRefresh(queryClient, "c1", "agent", "agent.updated");
    vi.advanceTimersByTime(1999);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.planningCanvasRefs.all("c1") });
    scheduleCanvasRefsRefresh(queryClient, "c1", "goal", "goal.updated");
    vi.advanceTimersByTime(1999);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("ignores other entities and comment events", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    scheduleCanvasRefsRefresh(queryClient, "c1", "approval", "approval.created");
    scheduleCanvasRefsRefresh(queryClient, "c1", "issue", "issue.comment_added");
    vi.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();
  });
});
