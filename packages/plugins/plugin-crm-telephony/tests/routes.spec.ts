import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleApiRequest } from "../src/routes.js";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";

describe("Routes", () => {
  let mockCtx: any;

  beforeEach(() => {
    mockCtx = {
      config: { get: vi.fn() },
      secrets: { resolve: vi.fn() },
      db: { query: vi.fn(), execute: vi.fn() },
      logger: { debug: vi.fn(), error: vi.fn() },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const makeInput = (
    routeKey: string,
    body: any = {},
    actor: any = { actorType: "user", actorId: "user-1", userId: "user-1" }
  ): PluginApiRequestInput => ({
    routeKey,
    method: "POST",
    path: routeKey === "voice-token" ? "/voice/token" : "/calls/start",
    body,
    query: {},
    params: {},
    headers: {},
    actor,
    companyId: "company-1",
  });

  describe.each([
    { route: "voice-token", path: "/voice/token" },
    { route: "calls-start", path: "/calls/start" },
  ])("$route: access control", ({ route }) => {
    it("returns 403 for agent actor", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      const response = await handleApiRequest(
        mockCtx,
        makeInput(route, {}, { actorType: "agent", actorId: "agent-1" })
      );
      expect(response.status).toBe(403);
    });

    it("returns 403 for user not on allowlist", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      const response = await handleApiRequest(
        mockCtx,
        makeInput(route, {}, { actorType: "user", actorId: "user-2", userId: "user-2" })
      );
      expect(response.status).toBe(403);
    });
  });

  describe("voice-token", () => {
    it("returns 409 when secrets are missing", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"] });
      mockCtx.secrets.resolve.mockResolvedValue(null);
      const response = await handleApiRequest(mockCtx, makeInput("voice-token"));
      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty("missing");
    });

    it("returns 200 with token, identity (no secret in body), and audit written", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"] });
      mockCtx.secrets.resolve.mockImplementation((name: string) => {
        const secrets: Record<string, string> = {
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_API_KEY_SID: "SK456",
          TWILIO_API_KEY_SECRET: "secret789",
          TWILIO_TWIML_APP_SID: "AP012",
        };
        return Promise.resolve(secrets[name]);
      });
      mockCtx.db.execute.mockResolvedValue({ rowCount: 1 });

      const response = await handleApiRequest(mockCtx, makeInput("voice-token"));
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("token");
      expect(response.body).toHaveProperty("identity", "user-1");
      expect(response.body).toHaveProperty("expiresIn", 3600);
      expect(response.body).not.toHaveProperty("secret");
      expect(mockCtx.db.execute).toHaveBeenCalled();
    });
  });

  describe("calls-start", () => {
    it("returns 400 for invalid number", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      const response = await handleApiRequest(mockCtx, makeInput("calls-start", { to: "invalid" }));
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error", "invalid_number");
    });
    it("returns 409 when caller ID not configured", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      mockCtx.secrets.resolve.mockResolvedValue(null);
      const response = await handleApiRequest(mockCtx, makeInput("calls-start", { to: "+27123456789" }));
      expect(response.status).toBe(409);
    });
    it("returns 409 when outside US calling hours", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      mockCtx.secrets.resolve.mockResolvedValue("+27123456789");
      mockCtx.db.execute.mockResolvedValue({ rowCount: 1 });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T02:00:00Z"));
      const response = await handleApiRequest(
        mockCtx,
        makeInput("calls-start", { to: "+12125551234", contactId: "contact-1" })
      );
      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty("error", "outside_calling_hours");
      vi.useRealTimers();
    });
    it("returns 429 when daily cap reached", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 2 });
      mockCtx.secrets.resolve.mockResolvedValue("+27123456789");
      mockCtx.db.query.mockResolvedValue([{ count: 2 }]);
      mockCtx.db.execute.mockResolvedValue({ rowCount: 1 });
      const response = await handleApiRequest(
        mockCtx,
        makeInput("calls-start", { to: "+27123456789", contactId: "contact-1" })
      );
      expect(response.status).toBe(429);
      expect(response.body).toHaveProperty("error", "daily_cap_reached");
    });

    it("returns 200 with ZA caller ID and audit written", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      mockCtx.secrets.resolve.mockImplementation((name: string) => {
        if (name === "TWILIO_ZA_NUMBER") return Promise.resolve("+27218765432");
        return Promise.resolve(null);
      });
      mockCtx.db.query.mockResolvedValue([{ count: 0 }]);
      mockCtx.db.execute.mockResolvedValue({ rowCount: 1 });
      const response = await handleApiRequest(
        mockCtx,
        makeInput("calls-start", { to: "+27123456789", contactId: "contact-1" })
      );
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("to", "+27123456789");
      expect(response.body).toHaveProperty("callerId", "+27218765432");
      expect(mockCtx.db.execute).toHaveBeenCalled();
    });

    it("returns 200 with US caller ID", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      mockCtx.secrets.resolve.mockImplementation((name: string) => {
        if (name === "TWILIO_US_NUMBER") return Promise.resolve("+12025551234");
        return Promise.resolve(null);
      });
      mockCtx.db.query.mockResolvedValue([{ count: 0 }]);
      mockCtx.db.execute.mockResolvedValue({ rowCount: 1 });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T16:00:00Z"));
      const response = await handleApiRequest(
        mockCtx,
        makeInput("calls-start", { to: "+12125551234" })
      );
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("callerId", "+12025551234");
      vi.useRealTimers();
    });
  });

});
