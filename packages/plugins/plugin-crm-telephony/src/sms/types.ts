export type SmsKind = "marketing" | "service";

export type SmsRefusal =
  | "disabled"
  | "invalid_number"
  | "unsupported_region"
  | "za_provider_not_configured"
  | "us_campaign_not_approved"
  | "no_consent"
  | "opted_out"
  | "suppressed"
  | "suppression_check_failed"
  | "outside_hours"
  | "daily_cap"
  | "transport_error";

export interface SmsSendRequest {
  companyId: string;
  contactId: string | null;
  to: string;
  body: string;
  kind: SmsKind;
  actorUserId?: string | null;
  now?: Date;
}

export type SmsSendResult =
  | { ok: true; messageId: string; providerMsgId: string }
  | { ok: false; reason: SmsRefusal; detail?: string };

export interface SuppressionChecker {
  check(companyId: string, e164: string): Promise<{ suppressed: boolean; consented: boolean }>;
}

export type SmsTransportResult =
  | { ok: true; providerMsgId: string; status: string }
  | { ok: false; kind: "retry" | "rejected" | "config"; error: string };

export interface SmsTransport {
  send(args: { to: string; body: string }): Promise<SmsTransportResult>;
}
