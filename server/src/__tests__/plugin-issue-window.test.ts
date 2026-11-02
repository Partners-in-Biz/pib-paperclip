import { describe, expect, it } from "vitest";
import {
  PLUGIN_ISSUE_LIST_DEFAULT_LIMIT,
  PLUGIN_ISSUE_LIST_MAX_LIMIT,
  resolvePluginIssueWindow,
} from "../services/plugin-issue-window.js";

describe("resolvePluginIssueWindow", () => {
  it("bounds a read that gives no limit", () => {
    expect(resolvePluginIssueWindow()).toEqual({ limit: PLUGIN_ISSUE_LIST_DEFAULT_LIMIT, offset: 0 });
    expect(resolvePluginIssueWindow({})).toEqual({ limit: 200, offset: 0 });
    expect(resolvePluginIssueWindow({ limit: undefined, offset: undefined })).toEqual({ limit: 200, offset: 0 });
  });

  it("keeps a limit inside the max", () => {
    expect(resolvePluginIssueWindow({ limit: 50 }).limit).toBe(50);
    expect(resolvePluginIssueWindow({ limit: 1 }).limit).toBe(1);
    expect(resolvePluginIssueWindow({ limit: PLUGIN_ISSUE_LIST_MAX_LIMIT }).limit).toBe(1000);
    expect(resolvePluginIssueWindow({ limit: 1001 }).limit).toBe(1000);
    expect(resolvePluginIssueWindow({ limit: 1_000_000 }).limit).toBe(1000);
  });

  it("raises a zero or negative limit to 1 and floors fractions", () => {
    expect(resolvePluginIssueWindow({ limit: 0 }).limit).toBe(1);
    expect(resolvePluginIssueWindow({ limit: -5 }).limit).toBe(1);
    expect(resolvePluginIssueWindow({ limit: 12.9 }).limit).toBe(12);
  });

  it("reads numeric strings and ignores junk", () => {
    expect(resolvePluginIssueWindow({ limit: "75", offset: "10" })).toEqual({ limit: 75, offset: 10 });
    expect(resolvePluginIssueWindow({ limit: "abc", offset: "" })).toEqual({ limit: 200, offset: 0 });
    expect(resolvePluginIssueWindow({ limit: Number.NaN, offset: Number.POSITIVE_INFINITY })).toEqual({ limit: 200, offset: 0 });
  });

  it("never returns a negative offset", () => {
    expect(resolvePluginIssueWindow({ offset: -3 }).offset).toBe(0);
    expect(resolvePluginIssueWindow({ offset: 40.7 }).offset).toBe(40);
  });
});
