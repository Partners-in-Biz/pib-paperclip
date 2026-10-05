/**
 * The page's one-line message ("Sprint paused.", "Connected.") belongs to the page it was raised on: it must not follow a person
 * to another sprint or another client. A message raised just before a navigation (a sprint was created, a sprint reopens in its
 * client's workspace) is marked CARRY and stays for the page it opens, then belongs to that page.
 */
export const CARRY = "*carry";

export interface RaisedMessage {
  text: string;
  /** The page it was raised on (scope and sprint), or CARRY. */
  at: string;
}

export const pageLocation = (scopeKey: string, sprintId: string | null): string => `${scopeKey}|${sprintId ?? ""}`;

/** What to show on `location` now. */
export function visibleMessage(raised: RaisedMessage, location: string): string {
  return raised.at === location || raised.at === CARRY ? raised.text : "";
}

/** The state after the page changed to `location`: a carried message settles on it, any other message of another page is dropped. */
export function settleMessage(raised: RaisedMessage, location: string): RaisedMessage {
  if (raised.at === CARRY) return { text: raised.text, at: location };
  return raised.at === location ? raised : { text: "", at: location };
}
