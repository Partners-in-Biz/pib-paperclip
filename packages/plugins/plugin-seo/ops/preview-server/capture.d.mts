export function titleOf(html: string | null | undefined): string;
export function captureMismatch(
  got: { status: number; url: string; html?: string } | null | undefined,
  want: { host?: string; title?: string },
): string | null;
export type ProposalState = "cancelled" | "declined" | "staff" | "approved" | "expired" | "hold" | "serve";
export function proposalState(
  row: { status?: string; review_key?: string; expired?: boolean; approved_live?: boolean; review_status?: string },
  key: string | null | undefined,
): ProposalState;
export interface FetchLiveOpts {
  fetchImpl?: typeof fetch;
  check?: (url: string) => Promise<unknown>;
  maxHops?: number;
  maxBytes?: number;
  timeoutMs?: number;
}
export function fetchLive(url: string, opts?: FetchLiveOpts): Promise<{ status: number; url: string; html: string }>;
export function guardShot(
  args: { which: string; mobile?: boolean; liveUrl: string; proposalUrl: string; proposalHtml: string },
  deps?: FetchLiveOpts,
): Promise<void>;
