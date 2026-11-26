// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sidebarAppKey, useHiddenSidebarApps } from "./useHiddenSidebarApps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let apps!: ReturnType<typeof useHiddenSidebarApps>;
function Harness({ userId }: { userId: string | null }) { apps = useHiddenSidebarApps(userId); return null; }
const keyFor = (userId: string) => `paperclip.coordinator.hidden-apps.v1:${encodeURIComponent(userId)}`;
beforeEach(() => { localStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { vi.restoreAllMocks(); await act(async () => root.unmount()); host.remove(); });

it("builds a stable app key", () => {
  expect(sidebarAppKey({ pluginKey: "pib.cockpit", id: "cockpit-nav" })).toBe("slot:pib.cockpit:cockpit-nav");
});

it("shows everything by default and ignores garbage or non-string entries", async () => {
  await act(async () => root.render(<Harness userId="u1" />));
  expect(apps.hidden.size).toBe(0);
  localStorage.setItem(keyFor("u1"), JSON.stringify(["a", 3, null, "a", "b"]));
  await act(async () => root.render(<Harness userId="u1" />));
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: keyFor("u1") })); });
  expect([...apps.hidden]).toEqual(["a", "b"]);
  localStorage.setItem(keyFor("u1"), "{not json");
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: keyFor("u1") })); });
  expect(apps.hidden.size).toBe(0);
});

it("toggles in this tab and follows another tab's storage event", async () => {
  await act(async () => root.render(<Harness userId="u@x/1" />));
  await act(async () => apps.toggle("a"));
  expect(JSON.parse(localStorage.getItem(keyFor("u@x/1"))!)).toEqual(["a"]);
  expect(apps.hidden.has("a")).toBe(true);
  await act(async () => apps.toggle("a"));
  expect(apps.hidden.has("a")).toBe(false);
  localStorage.setItem(keyFor("u@x/1"), JSON.stringify(["z"]));
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: keyFor("u@x/1") })); });
  expect(apps.hidden.has("z")).toBe(true);
});

it("keeps users apart and disables toggling without a user", async () => {
  localStorage.setItem(keyFor("other"), JSON.stringify(["a"]));
  await act(async () => root.render(<Harness userId="u1" />));
  expect(apps.hidden.size).toBe(0);
  await act(async () => root.render(<Harness userId={null} />));
  expect(apps.canToggle).toBe(false);
  await act(async () => apps.toggle("a"));
  expect(apps.hidden.size).toBe(0);
  expect(localStorage.length).toBe(1);
});

it("reports blocked storage", async () => {
  await act(async () => root.render(<Harness userId="u1" />));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  await act(async () => apps.toggle("a"));
  expect(apps.error).toMatch(/Couldn’t save/);
  expect(apps.hidden.size).toBe(0);
});
