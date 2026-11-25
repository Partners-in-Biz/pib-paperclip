export {};

import type { ActorCompanyMembership, AgentApiKeyScope } from "@paperclipai/shared";

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        sessionId?: string | null;
        memberships?: ActorCompanyMembership[];
        onBehalfOfMemberships?: ActorCompanyMembership[];
        isInstanceAdmin?: boolean;
        /** Companies where a person this actor carries is restricted under `enforce`; set by the route-table middleware. */
        memberRestrictedCompanyIds?: string[];
        /** The route is `by-company`: its handler must refuse a company in `memberRestrictedCompanyIds`. */
        memberRestrictionByCompany?: boolean;
        canManageExperimentalSettings?: boolean;
        keyId?: string;
        keyScope?: AgentApiKeyScope;
        runId?: string;
        onBehalfOfUserId?: string | null;
        authorizingUserId?: string;
        identityContextId?: string | null;
        source?: "local_implicit" | "session" | "board_key" | "agent_key" | "agent_jwt" | "mcp_oauth" | "cloud_tenant" | "cloud_control" | "none";
      };
    }
  }
}
