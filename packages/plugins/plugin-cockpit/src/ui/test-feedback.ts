/**
 * Copy for the Notifications "Send test" result.
 * An empty send result is not the same as "no devices": push can be off or
 * rate-capped while the device list still shows registered devices as On.
 */

export interface TestFeedbackInput {
  results?: Array<{ label: string | null; outcome: string; status?: string; error?: string }>;
  disabled?: boolean;
  capped?: boolean;
  /** Subscriptions the test targeted, including ones the sender did not attempt. */
  deviceCount?: number;
}

export type TestFeedback = { tone: "bad" | "ok"; text: string };

const PUSH_OFF =
  "Push is turned off, so the test was not sent. Your devices are still registered.";
const PUSH_OFF_NONE = "Push is turned off.";
const CAPPED =
  "Test not sent: the hourly push limit was reached. Your devices are still registered.";
const NOT_SENT = "Test was not sent. Your devices are still registered.";
const NO_DEVICES = "No devices to test";

function outcomeLine(results: NonNullable<TestFeedbackInput["results"]>): string {
  return results
    .map((r) => {
      const status = r.status ? ` (${r.status})` : "";
      const error = r.error ? ` [${r.error}]` : "";
      return `${r.label || "Device"}: ${r.outcome}${status}${error}`;
    })
    .join(", ");
}

export function testFeedback(res: TestFeedbackInput): TestFeedback {
  const results = res.results ?? [];
  const deviceCount = res.deviceCount ?? results.length;

  if (res.disabled) {
    return { tone: "bad", text: deviceCount > 0 ? PUSH_OFF : PUSH_OFF_NONE };
  }

  if (res.capped) {
    const extra = results.length > 0 ? ` ${outcomeLine(results)}` : "";
    return { tone: "bad", text: `${CAPPED}${extra}` };
  }

  if (results.length === 0) {
    return { tone: "bad", text: deviceCount > 0 ? NOT_SENT : NO_DEVICES };
  }

  return { tone: "ok", text: `✓ Test sent: ${outcomeLine(results)}` };
}
