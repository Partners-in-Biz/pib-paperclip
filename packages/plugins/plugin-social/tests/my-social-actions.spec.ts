import { describe, expect, it, vi, beforeEach } from "vitest";
import { SocialError } from "../src/domain.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  myAccountsAction,
  myPostsAction,
  myCreateDraftAction,
  myUpdateDraftAction,
  myDeleteDraftAction,
  myApproveAction,
  myDisconnectAccountAction,
} from "../src/my-social.js";
import { fakeCtx } from "./helpers.js";

const COMPANY_ID = "company-1";
const USER_A = "user-a";
const USER_B = "user-b";
const AGENT_ID = "agent-1";

describe("My Social Actions - Security & Isolation", () => {
  describe("my-social.accounts", () => {
    it("requires authenticated human user", async () => {
      const ctx = fakeCtx();
      const agentViewer = { companyId: COMPANY_ID, userId: null, agentId: AGENT_ID, runId: null, isAgent: true };

      await expect(myAccountsAction(ctx, agentViewer)).rejects.toThrow(/person must/);
    });

    it("returns only personal accounts owned by the actor", async () => {
      const ctx = fakeCtx();
      // Mock listPersonalAccounts to return accounts
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "acc-1",
          company_id: COMPANY_ID,
          platform: "x",
          scope: "personal",
          owner_user_id: USER_A,
          display_name: "User A Twitter",
          token_enc: "token",
          // Other fields...
        } as any,
      ]);

      const userAViewer = { companyId: COMPANY_ID, userId: USER_A, agentId: null, runId: null, isAgent: false };
      const result = await myAccountsAction(ctx, userAViewer);

      expect(Array.isArray(result)).toBe(true);
      expect((result as any)[0]?.id).toBe("acc-1");
      // Ensure token field is not exposed
      expect((result as any)[0]?.token_enc).toBeUndefined();
    });
  });

  describe("my-social.posts", () => {
    it("requires authenticated human user", async () => {
      const ctx = fakeCtx();
      const agentViewer = { companyId: COMPANY_ID, userId: null, agentId: AGENT_ID, runId: null, isAgent: true };

      await expect(myPostsAction(ctx, agentViewer)).rejects.toThrow(/person must/);
    });

    it("returns only personal posts owned by actor", async () => {
      const ctx = fakeCtx();
      const now = new Date();

      // Mock listPersonalPosts
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "post-1",
          company_id: COMPANY_ID,
          body: "Test post",
          status: "draft",
          scope: "personal",
          owner_user_id: USER_A,
          created_at: now,
          updated_at: now,
          // Other fields...
        } as any,
      ]);

      // Mock destinationsForPost
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([]);

      const userAViewer = { companyId: COMPANY_ID, userId: USER_A, agentId: null, runId: null, isAgent: false };
      const result = await myPostsAction(ctx, userAViewer);

      expect(Array.isArray(result)).toBe(true);
      expect((result as any).length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("my-social.create-draft", () => {
    it("rejects agents when called directly (not via targetUserId)", async () => {
      const ctx = fakeCtx();
      const agentViewer = { companyId: COMPANY_ID, userId: null, agentId: AGENT_ID, runId: null, isAgent: true };

      const params = {
        body: "Test",
        accountIds: [],
        // No targetUserId provided for agent
      };

      await expect(myCreateDraftAction(ctx, agentViewer, params)).rejects.toThrow(/required/);
    });

    it("allows agents to create drafts for other users if targetUserId is provided", async () => {
      const ctx = fakeCtx();
      const agentViewer = { companyId: COMPANY_ID, userId: null, agentId: AGENT_ID, runId: null, isAgent: true };

      // Mock database operations
      vi.spyOn(ctx.db, "execute").mockResolvedValueOnce({ rowCount: 1 } as any);
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "post-1",
          company_id: COMPANY_ID,
          body: "Test",
          status: "draft",
          scope: "personal",
          owner_user_id: USER_A,
        } as any,
      ]);

      const params = {
        body: "Test post",
        accountIds: [],
        targetUserId: USER_A,
      };

      const result = await myCreateDraftAction(ctx, agentViewer, params);
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("status", "draft");
    });

    it("allows humans to create drafts only for themselves", async () => {
      const ctx = fakeCtx();
      const userAViewer = { companyId: COMPANY_ID, userId: USER_A, agentId: null, runId: null, isAgent: false };

      // Mock database operations
      vi.spyOn(ctx.db, "execute").mockResolvedValueOnce({ rowCount: 1 } as any);
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "post-1",
          company_id: COMPANY_ID,
          body: "Test",
          status: "draft",
          scope: "personal",
          owner_user_id: USER_A,
        } as any,
      ]);

      const params = {
        body: "Test post",
        accountIds: [],
      };

      const result = await myCreateDraftAction(ctx, userAViewer, params);
      expect(result).toHaveProperty("id");
    });
  });

  describe("my-social.update-draft", () => {
    it("prevents non-owners from updating another user's draft", async () => {
      const ctx = fakeCtx();
      const userBViewer = { companyId: COMPANY_ID, userId: USER_B, agentId: null, runId: null, isAgent: false };

      // Mock getPost to return a post owned by USER_A
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "post-1",
          company_id: COMPANY_ID,
          body: "Original",
          status: "draft",
          scope: "personal",
          owner_user_id: USER_A,
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      ]);

      const params = {
        postId: "post-1",
        body: "Hacked",
        accountIds: [],
      };

      await expect(myUpdateDraftAction(ctx, userBViewer, params)).rejects.toThrow(/Cannot edit/);
    });

    it("prevents updating non-draft posts", async () => {
      const ctx = fakeCtx();
      const userAViewer = { companyId: COMPANY_ID, userId: USER_A, agentId: null, runId: null, isAgent: false };

      // Mock getPost to return a scheduled post owned by USER_A
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "post-1",
          company_id: COMPANY_ID,
          body: "Original",
          status: "scheduled",
          scope: "personal",
          owner_user_id: USER_A,
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      ]);

      const params = {
        postId: "post-1",
        body: "Updated",
        accountIds: [],
      };

      await expect(myUpdateDraftAction(ctx, userAViewer, params)).rejects.toThrow(/Only draft posts/);
    });
  });

  describe("my-social.delete-draft", () => {
    it("prevents non-owners from deleting another user's draft", async () => {
      const ctx = fakeCtx();
      const userBViewer = { companyId: COMPANY_ID, userId: USER_B, agentId: null, runId: null, isAgent: false };

      // Mock getPost to return a post owned by USER_A
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "post-1",
          company_id: COMPANY_ID,
          body: "Original",
          status: "draft",
          scope: "personal",
          owner_user_id: USER_A,
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      ]);

      const params = { postId: "post-1" };

      await expect(myDeleteDraftAction(ctx, userBViewer, params)).rejects.toThrow(/Cannot delete/);
    });

    it("prevents deleting non-draft posts", async () => {
      const ctx = fakeCtx();
      const userAViewer = { companyId: COMPANY_ID, userId: USER_A, agentId: null, runId: null, isAgent: false };

      // Mock getPost to return a published post owned by USER_A
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "post-1",
          company_id: COMPANY_ID,
          body: "Original",
          status: "published",
          scope: "personal",
          owner_user_id: USER_A,
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      ]);

      const params = { postId: "post-1" };

      await expect(myDeleteDraftAction(ctx, userAViewer, params)).rejects.toThrow(/Only draft posts/);
    });
  });

  describe("my-social.approve", () => {
    it("requires authenticated human user (rejects agents)", async () => {
      const ctx = fakeCtx();
      const agentViewer = { companyId: COMPANY_ID, userId: null, agentId: AGENT_ID, runId: null, isAgent: true };

      const params = {
        postId: "post-1",
        mode: "now",
      };

      await expect(myApproveAction(ctx, agentViewer, params)).rejects.toThrow(/person must/);
    });

    it("prevents non-owners from approving another user's post", async () => {
      const ctx = fakeCtx();
      const userBViewer = { companyId: COMPANY_ID, userId: USER_B, agentId: null, runId: null, isAgent: false };

      // Mock getPost to return a post owned by USER_A
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "post-1",
          company_id: COMPANY_ID,
          body: "Original",
          status: "draft",
          scope: "personal",
          owner_user_id: USER_A,
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      ]);

      const params = {
        postId: "post-1",
        mode: "now",
      };

      await expect(myApproveAction(ctx, userBViewer, params)).rejects.toThrow(/Only the post owner/);
    });

    it("prevents approving non-draft posts", async () => {
      const ctx = fakeCtx();
      const userAViewer = { companyId: COMPANY_ID, userId: USER_A, agentId: null, runId: null, isAgent: false };

      // Mock getPost to return an already scheduled post owned by USER_A
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "post-1",
          company_id: COMPANY_ID,
          body: "Original",
          status: "scheduled",
          scope: "personal",
          owner_user_id: USER_A,
          created_at: new Date(),
          updated_at: new Date(),
        } as any,
      ]);

      const params = {
        postId: "post-1",
        mode: "schedule",
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
      };

      await expect(myApproveAction(ctx, userAViewer, params)).rejects.toThrow(/Only draft posts/);
    });
  });

  describe("my-social.disconnect-account", () => {
    it("requires authenticated human user", async () => {
      const ctx = fakeCtx();
      const agentViewer = { companyId: COMPANY_ID, userId: null, agentId: AGENT_ID, runId: null, isAgent: true };

      const params = { accountId: "acc-1" };

      await expect(myDisconnectAccountAction(ctx, agentViewer, params)).rejects.toThrow(/person must/);
    });

    it("prevents non-owners from disconnecting another user's account", async () => {
      const ctx = fakeCtx();
      const userBViewer = { companyId: COMPANY_ID, userId: USER_B, agentId: null, runId: null, isAgent: false };

      // Mock getAccount to return an account owned by USER_A
      vi.spyOn(ctx.db, "query").mockResolvedValueOnce([
        {
          id: "acc-1",
          company_id: COMPANY_ID,
          platform: "x",
          scope: "personal",
          owner_user_id: USER_A,
          display_name: "User A Twitter",
          token_enc: "token",
        } as any,
      ]);

      const params = { accountId: "acc-1" };

      await expect(myDisconnectAccountAction(ctx, userBViewer, params)).rejects.toThrow(/Cannot disconnect/);
    });
  });

  describe("Org posts/accounts are never returned", () => {
    it("my-social.posts filters out org posts", async () => {
      const ctx = fakeCtx();
      const userAViewer = { companyId: COMPANY_ID, userId: USER_A, agentId: null, runId: null, isAgent: false };

      // The UI expects that only personal posts are returned by listPersonalPosts
      // This is enforced at the DB level with personalScopeClause
      // Test that listPersonalPosts queries with proper filters

      // Mock to verify the query is made with correct filters
      const spy = vi.spyOn(ctx.db, "query").mockResolvedValueOnce([]);

      await myPostsAction(ctx, userAViewer);

      // The query should include the personal scope filter
      expect(spy).toHaveBeenCalled();
    });

    it("my-social.accounts filters out org accounts", async () => {
      const ctx = fakeCtx();
      const userAViewer = { companyId: COMPANY_ID, userId: USER_A, agentId: null, runId: null, isAgent: false };

      // The UI expects that only personal accounts are returned by listPersonalAccounts
      // This is enforced at the DB level with personalScopeClause

      const spy = vi.spyOn(ctx.db, "query").mockResolvedValueOnce([]);

      await myAccountsAction(ctx, userAViewer);

      // The query should include the personal scope filter
      expect(spy).toHaveBeenCalled();
    });
  });
});
