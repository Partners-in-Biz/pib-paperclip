import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleApiRequest } from "../src/routes.js";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";

describe("Routes", () => {
  let mockCtx: any;

  beforeEach(() => {
    mockCtx = {
      config: { get: vi.fn() },
      secrets: { resolve: vi.fn() },
      db: {
        query: vi.fn(),
        execute: vi.fn(),
      },
      logger: { debug: vi.fn(), error: vi.fn() },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("voice-token route", () => {
    it("returns 403 for agent actor", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"] });

      const input: PluginApiRequestInput = {
        routeKey: "voice-token",
        method: "POST",
        path: "/voice/token",
        body: {},
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "agent", actorId: "agent-1" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty("error");
    });

    it("returns 403 for user not on allowlist", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"] });

      const input: PluginApiRequestInput = {
        routeKey: "voice-token",
        method: "POST",
        path: "/voice/token",
        body: {},
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "user", actorId: "user-2", userId: "user-2" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(403);
    });

    it("returns 409 when secrets are missing", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"] });
      mockCtx.secrets.resolve.mockResolvedValue(null);

      const input: PluginApiRequestInput = {
        routeKey: "voice-token",
        method: "POST",
        path: "/voice/token",
        body: {},
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty("missing");
    });

    it("returns 200 with token and identity", async () => {
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

      const input: PluginApiRequestInput = {
        routeKey: "voice-token",
        method: "POST",
        path: "/voice/token",
        body: {},
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("token");
      expect(response.body).toHaveProperty("identity", "user-1");
      expect(response.body).toHaveProperty("expiresIn", 3600);
      expect(mockCtx.db.execute).toHaveBeenCalled();
    });
  });

  describe("calls-start route", () => {
    it("returns 400 for invalid number", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });

      const input: PluginApiRequestInput = {
        routeKey: "calls-start",
        method: "POST",
        path: "/calls/start",
        body: { to: "invalid" },
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error", "invalid_number");
    });

    it("returns 409 when caller ID not configured", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      mockCtx.secrets.resolve.mockResolvedValue(null);

      const input: PluginApiRequestInput = {
        routeKey: "calls-start",
        method: "POST",
        path: "/calls/start",
        body: { to: "+27123456789" },
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(409);
    });

    it("returns 409 when outside US calling hours", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      mockCtx.secrets.resolve.mockResolvedValue("+27123456789");
      mockCtx.db.execute.mockResolvedValue({ rowCount: 1 });

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-15T02:00:00Z")); // 2 AM UTC = outside US hours

      const input: PluginApiRequestInput = {
        routeKey: "calls-start",
        method: "POST",
        path: "/calls/start",
        body: { to: "+12125551234", contactId: "contact-1" },
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty("error", "outside_calling_hours");

      vi.useRealTimers();
    });

    it("returns 429 when daily cap reached", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 2 });
      mockCtx.secrets.resolve.mockResolvedValue("+27123456789");
      mockCtx.db.query.mockResolvedValue([{ count: 2 }]);
      mockCtx.db.execute.mockResolvedValue({ rowCount: 1 });

      const input: PluginApiRequestInput = {
        routeKey: "calls-start",
        method: "POST",
        path: "/calls/start",
        body: { to: "+27123456789", contactId: "contact-1" },
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(429);
      expect(response.body).toHaveProperty("error", "daily_cap_reached");
    });

    it("returns 200 with ZA caller ID", async () => {
      mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"], maxCallsPerDay: 50 });
      mockCtx.secrets.resolve.mockImplementation((name: string) => {
        if (name === "TWILIO_ZA_NUMBER") return Promise.resolve("+27218765432");
        if (name === "TWILIO_US_NUMBER") return Promise.resolve(null);
        return Promise.resolve(null);
      });
      mockCtx.db.query.mockResolvedValue([{ count: 0 }]);
      mockCtx.db.execute.mockResolvedValue({ rowCount: 1 });

      const input: PluginApiRequestInput = {
        routeKey: "calls-start",
        method: "POST",
        path: "/calls/start",
        body: { to: "+27123456789", contactId: "contact-1" },
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("to", "+27123456789");
      expect(response.body).toHaveProperty("callerId", "+27218765432");
      expect(response.body).toHaveProperty("contactId", "contact-1");
      expect(mockCtx.db.execute).toHaveBeenCalledWith(expect.any(String), expect.any(Array));
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
      vi.setSystemTime(new Date("2024-01-15T16:00:00Z")); // 4 PM UTC = during US hours

      const input: PluginApiRequestInput = {
        routeKey: "calls-start",
        method: "POST",
        path: "/calls/start",
        body: { to: "+12125551234" },
        query: {},
        params: {},
        headers: {},
        actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
        companyId: "company-1",
      };

      const response = await handleApiRequest(mockCtx, input);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("to", "+12125551234");
      expect(response.body).toHaveProperty("callerId", "+12025551234");

      vi.useRealTimers();
    });
  });

  it("returns 404 for unknown route", async () => {
    mockCtx.config.get.mockResolvedValue({ voiceAllowedUserIds: ["user-1"] });

    const input: PluginApiRequestInput = {
      routeKey: "unknown-route",
      method: "POST",
      path: "/unknown",
      body: {},
      query: {},
      params: {},
      headers: {},
      actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
      companyId: "company-1",
    };

    const response = await handleApiRequest(mockCtx, input);
    expect(response.status).toBe(404);
  });
});
