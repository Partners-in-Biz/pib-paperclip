import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent } from "../services/live-events.js";

// PAR-14828: the voice plugin's reply feed relies on the person's own live socket carrying
// `activity.logged` + `issue.comment_added` for their chat. This pins that, with the REAL chat
// rule (`canActorReadChat`) deciding who may read the chat, and no server change.
vi.mock("../realtime/task-toast-eligibility.js", () => ({ taskToastEligible: vi.fn(async () => false) }));
vi.mock("../services/heartbeat-run-privacy.js", () => ({
  // The real helper asks `access.decide` once per issue binding; do the same.
  getHeartbeatRunReadDecisions: async (
    _db: unknown,
    access: { decide: (input: unknown) => Promise<{ allowed: boolean }> },
    actor: unknown,
    runs: { companyId: string; issueId?: string }[],
  ) => Promise.all(runs.map(async run => (await access.decide({
    actor, action: "issue:read", resource: { type: "issue", companyId: run.companyId, issueId: run.issueId },
  })).allowed)),
}));
vi.mock("../services/case-access.js", () => ({ canActorReadCase: async () => true }));

const CHAT = { id: "chat-1", conversationAgentId: "agent-ren", conversationUserId: "person-a" };
const PLAIN_TASK = { id: "task-1", conversationAgentId: null, conversationUserId: null };
const ROWS = [CHAT, PLAIN_TASK];

vi.mock("../services/authorization.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/authorization.js")>();
  return {
    ...actual,
    authorizationService: () => ({
      decide: async ({ actor, resource }: { actor: Parameters<typeof actual.canActorReadChat>[1]; resource: { issueId: string } }) => {
        const row = ROWS.find(candidate => candidate.id === resource.issueId);
        const allowed = !row || await actual.canActorReadChat({} as never, actor, { ...row, companyId: "company" });
        return { allowed };
      },
    }),
  };
});

function database() {
  return { select: (fields: Record<string, unknown>) => {
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      limit: async () => (fields.identifier ? [{ identifier: "PAP-1" }] : fields.id ? [{ id: "membership" }] : []),
    };
    return query;
  } };
}

describe("live socket: agent comment on a person's chat", () => {
  it("reaches the chat owner as activity.logged with the chat id, and never person B", async () => {
    const server = createServer();
    setupLiveEventsWebSocketServer(server, database() as never, {
      deploymentMode: "authenticated",
      resolveCloudActor: async req => {
        const userId = String(req.headers["x-test-user"]);
        return { userId, companyIds: ["company"] };
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/companies/company/events/ws`;
    const open = async (userId: string) => {
      const socket = new WebSocket(url, { headers: { "x-test-user": userId } });
      const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
      socket.on("message", data => messages.push(JSON.parse(data.toString())));
      await once(socket, "open");
      return { socket, messages };
    };
    const a = await open("person-a");
    const b = await open("person-b");
    try {
      const comment = (entityId: string) => publishLiveEvent({ companyId: "company", type: "activity.logged", payload: {
        action: "issue.comment_added", entityType: "issue", entityId,
        actorType: "agent", actorId: "agent-ren", details: { body: "private reply text" },
      } });
      comment(CHAT.id);
      // A plain task both can read follows, so B's socket is proven alive and in order.
      comment(PLAIN_TASK.id);
      await vi.waitFor(() => {
        expect(a.messages.map(m => m.payload.entityId)).toEqual([CHAT.id, PLAIN_TASK.id]);
        expect(b.messages.map(m => m.payload.entityId)).toEqual([PLAIN_TASK.id]);
      });
      expect(a.messages[0]).toMatchObject({ type: "activity.logged", payload: { action: "issue.comment_added", entityType: "issue", entityId: CHAT.id } });
      for (const message of [...a.messages, ...b.messages]) expect(JSON.stringify(message)).not.toContain("private reply text");
    } finally {
      a.socket.terminate();
      b.socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
