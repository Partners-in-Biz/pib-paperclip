/**
 * The owner's standing yes to the memory starter pack (PAR-4701, decided on PAR-2885 and PAR-4691).
 *
 * Every new company seeds the pack without another owner click, but only the versions listed here
 * (by content hash). A pack whose facts changed has a new hash that is not listed, so it falls back
 * to the owner gate in `setup.approve-starter-pack` until a person approves it or a PR adds its hash.
 * Never add a hash for a pack nobody on the board has read.
 */
export interface StandingApproval {
  packVersion: number;
  contentHash: string;
  approvedBy: string;
  approvedAt: string;
}

export const STANDING_APPROVALS: readonly StandingApproval[] = [
  { packVersion: 1, contentHash: "65da3db445d6a69e018837420bd146bfe824c87c4ca087eebac426b7a576e4cc", approvedBy: "standing-approval (PAR-2885, PAR-4691)", approvedAt: "2026-10-22T00:00:00.000Z" },
];

export function standingApproval(packVersion: number, contentHash: string): StandingApproval | null {
  return STANDING_APPROVALS.find((row) => row.packVersion === packVersion && row.contentHash === contentHash) ?? null;
}
