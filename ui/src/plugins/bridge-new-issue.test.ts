// @vitest-environment jsdom
import * as React from "react";
import * as ReactDOM from "react-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DialogProvider, useDialog } from "@/context/DialogContext";
import { pickHostNewIssueDefaults, useHostNewIssue, type HostNewIssue } from "./bridge";
import { initPluginBridge } from "./bridge-init";
import { readFileSync } from "node:fs";
import path from "node:path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Dialog = ReturnType<typeof useDialog>;

function mount() {
  const captured: { newIssue?: HostNewIssue; dialog?: Dialog } = {};
  function Probe() {
    captured.newIssue = useHostNewIssue();
    captured.dialog = useDialog();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(React.createElement(DialogProvider, null, React.createElement(Probe)));
  });
  return { captured, root, container };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("useHostNewIssue", () => {
  it("opens the New Task dialog with only the allowed defaults and resolves with the created issue", async () => {
    const { captured, root, container } = mount();
    cleanup = () => { act(() => root.unmount()); container.remove(); };

    let pending!: Promise<unknown>;
    act(() => {
      pending = captured.newIssue!.open({
        title: "Mail: Invoice",
        description: "body",
        projectId: "p1",
        assigneeAgentId: "a1",
        // not allowed through the plugin hook:
        status: "done",
        executionWorkspaceId: "ws",
      } as never);
    });
    expect(captured.dialog!.newIssueOpen).toBe(true);
    expect(captured.dialog!.newIssueDefaults).toEqual({
      title: "Mail: Invoice",
      description: "body",
      projectId: "p1",
      assigneeAgentId: "a1",
    });

    const issue = { id: "i1", identifier: "PAR-1", title: "Mail: Invoice", projectId: "p1", assigneeAgentId: "a1" };
    act(() => {
      captured.dialog!.notifyNewIssueCreated(issue);
      captured.dialog!.closeNewIssue();
    });
    await expect(pending).resolves.toEqual(issue);
    expect(captured.dialog!.newIssueOpen).toBe(false);
  });

  it("resolves null when the dialog is closed without creating", async () => {
    const { captured, root, container } = mount();
    cleanup = () => { act(() => root.unmount()); container.remove(); };
    let pending!: Promise<unknown>;
    act(() => { pending = captured.newIssue!.open({ title: "x" }); });
    act(() => captured.dialog!.closeNewIssue());
    await expect(pending).resolves.toBeNull();
  });

  it("resolves the first opening with null when a second opening replaces it", async () => {
    const { captured, root, container } = mount();
    cleanup = () => { act(() => root.unmount()); container.remove(); };
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => { first = captured.newIssue!.open({ title: "one" }); });
    act(() => { second = captured.newIssue!.open({ title: "two" }); });
    await expect(first).resolves.toBeNull();
    const issue = { id: "i2", identifier: null, title: "two", projectId: null, assigneeAgentId: null };
    act(() => { captured.dialog!.notifyNewIssueCreated(issue); captured.dialog!.closeNewIssue(); });
    await expect(second).resolves.toEqual(issue);
  });

  it("drops non-string and unknown fields", () => {
    expect(pickHostNewIssueDefaults({ title: 3, description: "", priority: "high", status: "done" })).toEqual({ priority: "high" });
    expect(pickHostNewIssueDefaults(null)).toEqual({});
  });

  it("is registered on the plugin bridge and exported by the sdk-ui shim", () => {
    initPluginBridge(React, ReactDOM);
    expect(globalThis.__paperclipPluginBridge__?.sdkUi?.useHostNewIssue).toBeTypeOf("function");
    // The sdk-ui shim must export the name, or plugins importing it fail to link.
    const slots = readFileSync(path.resolve(__dirname, "slots.tsx"), "utf8");
    expect(slots).toContain("useHostNavigation, useHostNewIssue, usePluginStream");
    expect(slots).toContain("SDK.useHostNewIssue ??");
  });
});
