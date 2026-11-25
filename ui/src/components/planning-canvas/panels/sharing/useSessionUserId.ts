import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";

/** The signed-in person; owner-only controls compare a board's `userId` to this. */
export function useSessionUserId(): string | null {
  const { data } = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  return data?.user.id ?? null;
}
