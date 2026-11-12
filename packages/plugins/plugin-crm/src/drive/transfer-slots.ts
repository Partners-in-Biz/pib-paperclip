/**
 * One counter for every streamed Drive transfer in the CRM worker (PAR-9219 C.4): agent saves and fetches, the
 * producer `r2Url` save branch and `copyAssetFileToR2`. Each holds at most one 8 MiB chunk plus a 1 MiB buffer, so
 * capping agent work at two in flight bounds the memory this path adds.
 */

/** Agent jobs start only while fewer than this many transfers run. */
export const MAX_AGENT_TRANSFERS = 2;

export const BUSY_TEXT = "Two Drive transfers are already running. Try again in a few minutes.";

export type ReleaseSlot = () => void;

let inFlight = 0;

function slot(): ReleaseSlot {
  inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight -= 1;
  };
}

/** Transfers running now, of any kind. */
export function transfersInFlight(): number {
  return inFlight;
}

/**
 * A producer route (Studio page transfers): counted, never refused, so their shipped behaviour is kept.
 * Call the returned release in `finally`; a second call is a no-op.
 */
export function acquireTransferSlot(): ReleaseSlot {
  return slot();
}

/** An agent job: null (busy) when MAX_AGENT_TRANSFERS or more are already in flight. */
export function tryAcquireAgentSlot(): ReleaseSlot | null {
  if (inFlight >= MAX_AGENT_TRANSFERS) return null;
  return slot();
}

/** Tests only. */
export function resetTransferSlotsForTests(): void {
  inFlight = 0;
}
