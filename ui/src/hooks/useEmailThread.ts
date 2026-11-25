import { useQuery } from "@tanstack/react-query";
import { emailApi } from "@/api/email";
import { useMemberRestrictionGate } from "@/hooks/useMemberRestrictionGate";

export function useEmailThread(companyId: string, issueId: string) {
  // PAR-14342: email is closed for a person restricted here under `enforce` (PAR-12608 4.6).
  const memberGate = useMemberRestrictionGate(companyId);
  return useQuery({
    queryKey: ["email-thread", companyId, issueId],
    queryFn: () => emailApi.thread(companyId, issueId),
    enabled: Boolean(companyId && issueId) && !issueId.startsWith("chat:") && !memberGate.closed,
    // A null response identifies an ordinary task. It can still refetch on
    // focus or invalidation, but only email tasks need recurring updates.
    refetchInterval: (query) => query.state.data === null ? false : 3000,
  });
}
