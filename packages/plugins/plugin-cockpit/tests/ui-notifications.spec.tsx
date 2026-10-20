import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeviceList } from "../src/ui/DeviceList.js";
import type { DeviceInfo } from "../src/push/actions.js";

const NOW = new Date("2026-10-20T10:00:00.000Z");

describe("Notifications UI components", () => {
  describe("DeviceList", () => {
    const mockOnMute = async () => {};
    const mockOnRemove = async () => {};

    it("renders empty state when no devices", () => {
      const html = renderToStaticMarkup(
        createElement(DeviceList, {
          devices: [],
          onMute: mockOnMute,
          onRemove: mockOnRemove,
        })
      );
      expect(html).toContain("No devices");
      expect(html).toContain("Turn on notifications on this device to get started");
    });

    it("renders a single device with state ok", () => {
      const device: DeviceInfo = {
        id: "dev1",
        label: "My iPhone",
        state: "ok",
        createdAt: "2026-10-15T10:00:00.000Z",
        lastOkAt: "2026-10-20T09:00:00.000Z",
        lastError: null,
      };
      const html = renderToStaticMarkup(
        createElement(DeviceList, {
          devices: [device],
          onMute: mockOnMute,
          onRemove: mockOnRemove,
        })
      );
      expect(html).toContain("My iPhone");
      expect(html).toContain("On");
      expect(html).toContain("Mute");
      expect(html).toContain("Remove");
      expect(html).toContain("Added");
      expect(html).toContain("Last push");
    });

    it("renders device with muted state", () => {
      const device: DeviceInfo = {
        id: "dev2",
        label: "iPad",
        state: "muted",
        createdAt: "2026-10-10T10:00:00.000Z",
        lastOkAt: "2026-10-19T15:00:00.000Z",
        lastError: null,
      };
      const html = renderToStaticMarkup(
        createElement(DeviceList, {
          devices: [device],
          onMute: mockOnMute,
          onRemove: mockOnRemove,
        })
      );
      expect(html).toContain("iPad");
      expect(html).toContain("Muted");
      expect(html).toContain("Unmute");
    });

    it("renders device with needs_resubscribe state and error", () => {
      const device: DeviceInfo = {
        id: "dev3",
        label: "Android Phone",
        state: "needs_resubscribe",
        createdAt: "2026-10-01T10:00:00.000Z",
        lastOkAt: null,
        lastError: "push service worker lost",
      };
      const html = renderToStaticMarkup(
        createElement(DeviceList, {
          devices: [device],
          onMute: mockOnMute,
          onRemove: mockOnRemove,
        })
      );
      expect(html).toContain("Android Phone");
      expect(html).toContain("Needs resubscribe");
      expect(html).toContain("push service worker lost");
    });

    it("renders multiple devices", () => {
      const devices: DeviceInfo[] = [
        {
          id: "dev1",
          label: "iPhone",
          state: "ok",
          createdAt: "2026-10-15T10:00:00.000Z",
          lastOkAt: "2026-10-20T09:00:00.000Z",
          lastError: null,
        },
        {
          id: "dev2",
          label: "iPad",
          state: "muted",
          createdAt: "2026-10-10T10:00:00.000Z",
          lastOkAt: "2026-10-19T15:00:00.000Z",
          lastError: null,
        },
      ];
      const html = renderToStaticMarkup(
        createElement(DeviceList, {
          devices,
          onMute: mockOnMute,
          onRemove: mockOnRemove,
        })
      );
      expect(html).toContain("iPhone");
      expect(html).toContain("iPad");
      expect(html).toContain("On");
      expect(html).toContain("Muted");
    });

    it("renders unnamed device when label is null", () => {
      const device: DeviceInfo = {
        id: "dev1",
        label: null,
        state: "ok",
        createdAt: "2026-10-15T10:00:00.000Z",
        lastOkAt: null,
        lastError: null,
      };
      const html = renderToStaticMarkup(
        createElement(DeviceList, {
          devices: [device],
          onMute: mockOnMute,
          onRemove: mockOnRemove,
        })
      );
      expect(html).toContain("Unnamed device");
    });
  });
});
