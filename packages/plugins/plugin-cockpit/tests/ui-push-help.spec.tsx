import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PushHelp, blockReasonFor } from "../src/ui/PushHelp.js";

describe("PushHelp component", () => {
  describe("PushHelp with different reasons", () => {
    it("renders with no reason specified", () => {
      const html = renderToStaticMarkup(createElement(PushHelp));
      expect(html).toContain("Why a device may not receive");
      expect(html).toContain("iPhone/iPad: app not on Home Screen");
      expect(html).toContain("Permission refused");
      expect(html).toContain("Unsupported browser");
      expect(html).toContain("Notification key changed");
      expect(html).toContain("Limits");
      expect(html).toContain("Quiet hours");
    });

    it("renders with reason=null", () => {
      const html = renderToStaticMarkup(createElement(PushHelp, { reason: null }));
      expect(html).toContain("Why a device may not receive");
      expect(html).not.toContain("aria-current");
    });

    it("renders with ios_not_home_screen reason marked active", () => {
      const html = renderToStaticMarkup(createElement(PushHelp, { reason: "ios_not_home_screen" }));
      expect(html).toContain("iPhone/iPad: app not on Home Screen");
      expect(html).toContain("On iPhone or iPad, notifications only work when the Paperclip app is added to your Home Screen");
      expect(html).toContain('aria-current="true"');
    });

    it("renders with permission_denied reason marked active", () => {
      const html = renderToStaticMarkup(createElement(PushHelp, { reason: "permission_denied" }));
      expect(html).toContain("Permission refused");
      expect(html).toContain("Allow notifications for this site in your browser or phone settings");
      expect(html).toContain('aria-current="true"');
    });

    it("renders with unsupported_browser reason marked active", () => {
      const html = renderToStaticMarkup(createElement(PushHelp, { reason: "unsupported_browser" }));
      expect(html).toContain("Unsupported browser");
      expect(html).toContain("Use Safari (iPhone, from Home Screen), Chrome, Edge or Firefox");
      expect(html).toContain('aria-current="true"');
    });

    it("renders with key_changed reason marked active", () => {
      const html = renderToStaticMarkup(createElement(PushHelp, { reason: "key_changed" }));
      expect(html).toContain("Notification key changed");
      expect(html).toContain("The notification key changed, so turn notifications on again on this device");
      expect(html).toContain('aria-current="true"');
    });
  });

  describe("PushHelp sections", () => {
    it("includes Limits section with dead-man email mention", () => {
      const html = renderToStaticMarkup(createElement(PushHelp));
      expect(html).toContain("If Paperclip itself is down");
      expect(html).toContain("dead-man email");
    });

    it("includes Quiet hours section with time range and arrival info", () => {
      const html = renderToStaticMarkup(createElement(PushHelp));
      expect(html).toContain("22:00–06:00");
      expect(html).toContain("Urgent still comes through");
      expect(html).toContain("arrives at 06:00");
    });

    it("all four reasons are present in the list", () => {
      const html = renderToStaticMarkup(createElement(PushHelp));
      expect(html).toContain("iPhone/iPad");
      expect(html).toContain("Permission refused");
      expect(html).toContain("Unsupported browser");
      expect(html).toContain("Notification key changed");
    });

    it("applies overflowWrap to reason bodies", () => {
      const html = renderToStaticMarkup(createElement(PushHelp));
      expect(html).toContain("overflow-wrap:anywhere");
    });

    it("applies overflowWrap to limits and quiet hours text", () => {
      const html = renderToStaticMarkup(createElement(PushHelp));
      // Should have multiple occurrences of overflow-wrap:anywhere
      const matches = html.match(/overflow-wrap:anywhere/g);
      expect(matches).toBeTruthy();
      expect((matches || []).length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("blockReasonFor function", () => {
    it("returns unsupported_browser when hasPush is false", () => {
      const reason = blockReasonFor({
        standalone: true,
        isIos: false,
        hasPush: false,
        permission: "granted",
      });
      expect(reason).toBe("unsupported_browser");
    });

    it("returns ios_not_home_screen when iOS and not standalone", () => {
      const reason = blockReasonFor({
        standalone: false,
        isIos: true,
        hasPush: true,
        permission: "granted",
      });
      expect(reason).toBe("ios_not_home_screen");
    });

    it("returns null when iOS and standalone", () => {
      const reason = blockReasonFor({
        standalone: true,
        isIos: true,
        hasPush: true,
        permission: "granted",
      });
      expect(reason).toBeNull();
    });

    it("returns key_changed when keyChanged is true", () => {
      const reason = blockReasonFor({
        standalone: true,
        isIos: false,
        hasPush: true,
        permission: "granted",
        keyChanged: true,
      });
      expect(reason).toBe("key_changed");
    });

    it("returns permission_denied when permission is denied", () => {
      const reason = blockReasonFor({
        standalone: true,
        isIos: false,
        hasPush: true,
        permission: "denied",
      });
      expect(reason).toBe("permission_denied");
    });

    it("returns null when everything is ok", () => {
      const reason = blockReasonFor({
        standalone: true,
        isIos: false,
        hasPush: true,
        permission: "granted",
      });
      expect(reason).toBeNull();
    });

    it("returns null when permission is default but other factors are ok", () => {
      const reason = blockReasonFor({
        standalone: true,
        isIos: false,
        hasPush: true,
        permission: "default",
      });
      expect(reason).toBeNull();
    });

    it("prioritizes unsupported_browser over other reasons", () => {
      const reason = blockReasonFor({
        standalone: false,
        isIos: true,
        hasPush: false,
        permission: "denied",
        keyChanged: true,
      });
      expect(reason).toBe("unsupported_browser");
    });

    it("prioritizes ios_not_home_screen over key_changed", () => {
      const reason = blockReasonFor({
        standalone: false,
        isIos: true,
        hasPush: true,
        permission: "granted",
        keyChanged: true,
      });
      expect(reason).toBe("ios_not_home_screen");
    });

    it("prioritizes key_changed over permission_denied", () => {
      const reason = blockReasonFor({
        standalone: true,
        isIos: false,
        hasPush: true,
        permission: "denied",
        keyChanged: true,
      });
      expect(reason).toBe("key_changed");
    });

    it("returns permission_denied as fallback when other checks fail", () => {
      const reason = blockReasonFor({
        standalone: true,
        isIos: false,
        hasPush: true,
        permission: "denied",
      });
      expect(reason).toBe("permission_denied");
    });
  });
});
