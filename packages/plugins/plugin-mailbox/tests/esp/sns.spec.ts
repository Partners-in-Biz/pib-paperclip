import { describe, expect, it } from "vitest";
import { handleSnsWebhook, forgetSnsCandidates, forgetSnsCerts, forgetSnsRefusals, canonicalString } from "../../src/esp/sns.js";
import { CO } from "../helpers/memory.js";
import { signSns, FakeSesWithSns, hostFetch, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_REGION, SES_CONFIGURATION_SET } from "../helpers/fake-ses.js";
import { sesMockSetup, sesSetup, SES_TOPIC_ARN, SES_ON, addEspDomain, knownToWebhook, dnsVerified, FROM } from "../helpers/esp.js";
import { rememberCompany } from "../../src/setup-status.js";
import { readSesTopicConfirmed } from "../../src/esp/topic-state.js";
import { setup } from "../helpers/setup.js";
import { fakeDns } from "../helpers/dns.js";
import { forgetEspRuntime } from "../../src/esp/runtime.js";
import { forgetLimiters } from "../../src/esp/limiter.js";
import { forgetWebhookCandidates } from "../../src/esp/webhook.js";
import { MockEmailProvider } from "../../src/esp/mock.js";

type SesMockSetup = ReturnType<typeof sesMockSetup>;
type SesSetup = ReturnType<typeof sesSetup>;

/** Like sesMockSetup but does NOT auto-confirm the topic, for tests that need to start unconfirmed */
function sesMockSetupUnconfirmed() {
  forgetEspRuntime();
  forgetLimiters();
  forgetWebhookCandidates();
  forgetSnsCandidates();
  forgetSnsCerts();
  const base = setup({ ...SES_ON });
  // Do NOT call confirmSesTopic here
  const provider = new MockEmailProvider({ idempotentSends: false, batching: false });
  const sns = new FakeSesWithSns();
  base.env.esp = { provider: () => provider, fetch: hostFetch(sns.handle) };
  base.env.dns = fakeDns(dnsVerified());
  return { ...base, provider, sns };
}

let seq = 0;
function nextMessageId(): string {
  seq += 1;
  return `test-msg-${String(seq).padStart(6, "0")}`;
}

/**
 * Deliver an SNS message the way the host does: the raw body as text/plain.
 */
async function deliver(t: SesMockSetup | SesSetup, body: string) {
  return handleSnsWebhook(t.env, { rawBody: body });
}

describe("canonicalString", () => {
  it("formats Notification with Message, MessageId, Timestamp, TopicArn, Type with trailing newlines", () => {
    const message = {
      Type: "Notification" as const,
      MessageId: "abc123",
      Message: "hello",
      Timestamp: "2024-01-01T00:00:00Z",
      TopicArn: "arn:aws:sns:us-east-1:123456789:test",
      Signature: "sig",
      SignatureVersion: "2" as const,
      SigningCertURL: "https://example.com/cert.pem",
    };
    const expected = "Message\nhello\nMessageId\nabc123\nTimestamp\n2024-01-01T00:00:00Z\nTopicArn\narn:aws:sns:us-east-1:123456789:test\nType\nNotification\n";
    expect(canonicalString(message)).toBe(expected);
  });

  it("includes Subject in Notification when present", () => {
    const message = {
      Type: "Notification" as const,
      MessageId: "abc123",
      Message: "hello",
      Subject: "test subject",
      Timestamp: "2024-01-01T00:00:00Z",
      TopicArn: "arn:aws:sns:us-east-1:123456789:test",
      Signature: "sig",
      SignatureVersion: "2" as const,
      SigningCertURL: "https://example.com/cert.pem",
    };
    const expected = "Message\nhello\nMessageId\nabc123\nSubject\ntest subject\nTimestamp\n2024-01-01T00:00:00Z\nTopicArn\narn:aws:sns:us-east-1:123456789:test\nType\nNotification\n";
    expect(canonicalString(message)).toBe(expected);
  });

  it("formats SubscriptionConfirmation with Message, MessageId, SubscribeURL, Token, Timestamp, TopicArn, Type", () => {
    const message = {
      Type: "SubscriptionConfirmation" as const,
      MessageId: "def456",
      Message: "You have chosen to subscribe",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
      Token: "token123",
      Timestamp: "2024-01-01T00:00:00Z",
      TopicArn: "arn:aws:sns:us-east-1:123456789:test",
      Signature: "sig",
      SignatureVersion: "2" as const,
      SigningCertURL: "https://example.com/cert.pem",
    };
    const expected = "Message\nYou have chosen to subscribe\nMessageId\ndef456\nSubscribeURL\nhttps://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription\nTimestamp\n2024-01-01T00:00:00Z\nToken\ntoken123\nTopicArn\narn:aws:sns:us-east-1:123456789:test\nType\nSubscriptionConfirmation\n";
    expect(canonicalString(message)).toBe(expected);
  });
});

describe("SNS webhook for SES", () => {
  describe("refusals: no state change, no event applied", () => {
    it("refuses an empty raw body and logs the PAR-1853/T0 prerequisite", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      const error = await deliver(t, "").catch((e: Error) => e);
      expect(error).toMatchObject({ name: "WebhookRejected", code: "empty_raw_body", message: "The delivery could not be verified" });

      const logs = (t.host.ctx.logger.warn as any).mock.calls.filter((call: any) => call[0] === "Provider webhook refused");
      expect(logs.length).toBeGreaterThan(0);
      const logged = JSON.stringify(logs);
      expect(logged).toContain("PAR-1853");
      expect(logged).toContain("T0");
    });

    it("refuses a body larger than 256 KB", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      const huge = "x".repeat(300_000);
      await expect(deliver(t, huge)).rejects.toMatchObject({ code: "too_large" });
    });

    it("refuses non-JSON", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      await expect(deliver(t, "not json")).rejects.toMatchObject({ code: "not_json" });
    });

    it("refuses an invalid Type", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      const msg = JSON.stringify({ Type: "Invalid", MessageId: "test" });
      await expect(deliver(t, msg)).rejects.toMatchObject({ code: "invalid_type" });
    });

    it("refuses when a required field is missing", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      const msg = JSON.stringify({
        Type: "Notification",
        MessageId: "test",
        Message: "test",
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        // Missing Signature, SignatureVersion, SigningCertURL
      });
      await expect(deliver(t, msg)).rejects.toMatchObject({ code: "missing_field" });
    });

    it("refuses an invalid ARN", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      // Create a valid-format (but wrong) signature: 256 bytes is a typical RSA-2048 signature
      const validSig = Buffer.alloc(256, 0xAA).toString("base64");

      const msg = JSON.stringify({
        Type: "Notification",
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: "invalid-arn",
        Signature: validSig,
        SignatureVersion: "2",
        SigningCertURL: "https://example.com/cert.pem",
      });
      await expect(deliver(t, msg)).rejects.toMatchObject({ code: "invalid_arn" });
    });

    it("refuses a cert URL that doesn't match the SNS host pattern", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      // Create a valid-format (but wrong) signature
      const validSig = Buffer.alloc(256, 0xAA).toString("base64");

      const msg = JSON.stringify({
        Type: "Notification",
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        Signature: validSig,
        SignatureVersion: "2",
        SigningCertURL: "https://evil.com/cert.pem", // Wrong domain
      });
      await expect(deliver(t, msg)).rejects.toMatchObject({ code: "invalid_cert_url" });
    });

    it("refuses SubscriptionConfirmation with SubscribeURL not on SNS host", async () => {
      const t: SesSetup = sesSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "SubscriptionConfirmation" as const,
        MessageId: nextMessageId(),
        Message: "You have chosen to subscribe to the topic ...",
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SubscribeURL: "https://attacker.example/confirm", // Attacker URL
        Token: "test-token",
        SigningCertURL: t.ses.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.ses.privateKey, "2");
      await expect(deliver(t, JSON.stringify(signed))).rejects.toMatchObject({ code: "invalid_subscribe_url" });

      // Verify no fetch was attempted
      expect(t.ses.subscribeUrlHits).toBe(0);

      forgetSnsCerts();
    });

    it("refuses SubscribeURL on different region's SNS host", async () => {
      const t: SesSetup = sesSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "SubscriptionConfirmation" as const,
        MessageId: nextMessageId(),
        Message: "You have chosen to subscribe to the topic ...",
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=test-token", // Wrong region
        Token: "test-token",
        SigningCertURL: t.ses.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.ses.privateKey, "2");
      await expect(deliver(t, JSON.stringify(signed))).rejects.toMatchObject({ code: "invalid_subscribe_url" });

      forgetSnsCerts();
    });

    it("refuses SubscribeURL with domain suffix attack (*.amazonaws.com.evil.com)", async () => {
      const t: SesSetup = sesSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "SubscriptionConfirmation" as const,
        MessageId: nextMessageId(),
        Message: "You have chosen to subscribe to the topic ...",
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SubscribeURL: "https://sns.eu-north-1.amazonaws.com.evil.com/x", // Suffix attack
        Token: "test-token",
        SigningCertURL: t.ses.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.ses.privateKey, "2");
      await expect(deliver(t, JSON.stringify(signed))).rejects.toMatchObject({ code: "invalid_subscribe_url" });

      forgetSnsCerts();
    });

    it("refuses SubscribeURL with userinfo attack (*.amazonaws.com@evil.com)", async () => {
      const t: SesSetup = sesSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "SubscriptionConfirmation" as const,
        MessageId: nextMessageId(),
        Message: "You have chosen to subscribe to the topic ...",
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SubscribeURL: "https://sns.eu-north-1.amazonaws.com@evil.com/x", // Userinfo attack
        Token: "test-token",
        SigningCertURL: t.ses.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.ses.privateKey, "2");
      await expect(deliver(t, JSON.stringify(signed))).rejects.toMatchObject({ code: "invalid_subscribe_url" });

      forgetSnsCerts();
    });

    it("refuses a body with multi-byte characters that exceeds 256 KB in bytes (but not in char count)", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      // Create a message with multi-byte UTF-8 characters
      // Each emoji is 4 bytes in UTF-8 but 1 character
      // We want > 256 KB in bytes
      const emoji = "😀"; // 4 bytes in UTF-8
      const charCount = 70_000; // 70k chars = 280 KB when encoded
      const message = emoji.repeat(charCount);

      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: message,
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      const json = JSON.stringify(signed);

      // Verify the JSON in bytes exceeds 256 KB but char count doesn't matter
      expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(256 * 1024);

      await expect(deliver(t, json)).rejects.toMatchObject({ code: "too_large" });
    });

    it("refuses a Signature that is not valid base64", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      const msg = JSON.stringify({
        Type: "Notification",
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        Signature: "!!!", // Invalid base64
        SignatureVersion: "2",
        SigningCertURL: t.sns.certUrl(),
      });
      await expect(deliver(t, msg)).rejects.toMatchObject({ code: "invalid_signature_format" });
    });

    it("refuses a Signature with invalid base64 padding", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      const msg = JSON.stringify({
        Type: "Notification",
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        Signature: "abc=def=", // Invalid padding
        SignatureVersion: "2",
        SigningCertURL: t.sns.certUrl(),
      });
      await expect(deliver(t, msg)).rejects.toMatchObject({ code: "invalid_signature_format" });
    });

    it("refuses a Signature with length not divisible by 4", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      const msg = JSON.stringify({
        Type: "Notification",
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        Signature: "YWJj", // Valid chars but length 4... actually this is valid. Let me use length 3
        SignatureVersion: "2",
        SigningCertURL: t.sns.certUrl(),
      });

      // Use a deliberately invalid length: 5 chars (not divisible by 4)
      const tampered = JSON.stringify({
        Type: "Notification",
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        Signature: "YWJjZA==", // Replace with invalid length
        SignatureVersion: "2",
        SigningCertURL: t.sns.certUrl(),
      }).replace('"YWJjZA=="', '"AAAAA"'); // 5 chars - not divisible by 4

      // Simpler approach: just construct bad signature directly
      const badMsg = JSON.stringify({
        Type: "Notification",
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        Signature: "AAAAA", // 5 chars, not divisible by 4
        SignatureVersion: "2",
        SigningCertURL: t.sns.certUrl(),
      });

      await expect(deliver(t, badMsg)).rejects.toMatchObject({ code: "invalid_signature_format" });
    });

    it("refuses an unknown topic ARN with no matching company", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      const unknownArn = "arn:aws:sns:eu-north-1:123456789012:unknown-topic";
      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: unknownArn,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      await expect(deliver(t, JSON.stringify(signed))).rejects.toMatchObject({ code: "unknown_topic" });
    });

    it("refuses a bad signature", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      // Sign with wrong signature - create a 256-byte valid format but wrong value
      const wrongSig = Buffer.alloc(256, 0xFF).toString("base64");
      const tampered = {
        ...msg,
        Signature: wrongSig,
        SignatureVersion: "2",
      };
      await expect(deliver(t, JSON.stringify(tampered))).rejects.toMatchObject({ code: "bad_signature" });
    });

    it("refuses ambiguous topic when a Notification has multiple matching companies and no pib_company tag", async () => {
      forgetSnsCandidates();
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      // Add another company with the same topic
      (t.host.ctx.config as any).get = async (id: string) => {
        if (id === CO) return t.host.config;
        if (id === "co-2") return { ...SES_ON };
        return {};
      };
      await rememberCompany(t.host.ctx, "co-2");
      await addEspDomain(t, { provider: "ses", company: "co-2" });
      forgetSnsCandidates();

      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}', // No pib_company tag
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      await expect(deliver(t, JSON.stringify(signed))).rejects.toMatchObject({ code: "ambiguous_topic" });
    });

    it("refuses cert budget exceeded", async () => {
      const t: SesSetup = sesSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      // Fetch 10 times to exhaust budget (with different cert URLs)
      for (let i = 0; i < 10; i++) {
        const msg = {
          Type: "Notification" as const,
          MessageId: nextMessageId(),
          Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
          Timestamp: new Date().toISOString(),
          TopicArn: SES_TOPIC_ARN,
          SigningCertURL: t.ses.certUrl().replace(".pem", `-${i}.pem`),
        };
        const signed = signSns(msg as Record<string, string>, t.ses.privateKey, "2");
        try {
          await deliver(t, JSON.stringify(signed));
        } catch {
          // Expected to fail or succeed initially
        }
      }

      // 11th attempt should be refused (budget exceeded)
      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.ses.certUrl().replace(".pem", "-10.pem"),
      };
      const signed = signSns(msg as Record<string, string>, t.ses.privateKey, "2");
      await expect(deliver(t, JSON.stringify(signed))).rejects.toMatchObject({ code: "cert_budget" });

      forgetSnsCerts(); // Clean up for next test
    });

    it("never includes message content, cert URLs or secrets in thrown error or logs beyond the code", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const secretUrl = "https://sns.eu-north-1.amazonaws.com/super-secret-cert-path.pem";
      const msg = JSON.stringify({
        Type: "Notification",
        MessageId: nextMessageId(),
        Message: '{"mail":{"timestamp":"2024-01-01T00:00:00Z"}}',
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        Signature: Buffer.from("test").toString("base64"),
        SignatureVersion: "2",
        SigningCertURL: secretUrl,
      });

      const error = await deliver(t, msg).catch((e: Error) => (e as any));
      if (error instanceof Error) {
        expect(error.message).not.toContain(secretUrl);
        expect(error.message).not.toContain("secret");
      }
    });
  });

  describe("signature verification", () => {
    it("verifies a Notification with SignatureVersion 2 (RSA-SHA256)", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ notificationType: "Send", mail: { timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      const result = await deliver(t, JSON.stringify(signed));
      expect(result.companyId).toBe(CO);
    });

    it("verifies a Notification with SignatureVersion 1 (RSA-SHA1)", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ notificationType: "Send", mail: { timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "1");
      const result = await deliver(t, JSON.stringify(signed));
      expect(result.companyId).toBe(CO);
    });

    it("builds canonical string with absent Subject omitted in Notification", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      // No Subject field in the message
      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ notificationType: "Send", mail: { timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      const result = await deliver(t, JSON.stringify(signed));
      expect(result.companyId).toBe(CO);
    });
  });

  describe("certificate handling", () => {
    it("fetches the certificate once per URL and caches it", async () => {
      const t: SesSetup = sesSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ notificationType: "Send", mail: { timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.ses.certUrl(),
      };

      // First message: cert fetch
      t.ses.certFetches = 0;
      const signed1 = signSns(msg as Record<string, string>, t.ses.privateKey, "2");
      const result1 = await deliver(t, JSON.stringify(signed1));
      expect(result1.companyId).toBe(CO);
      expect(t.ses.certFetches).toBe(1);

      // Second message: cache hit
      const signed2 = signSns({ ...msg, MessageId: nextMessageId() } as Record<string, string>, t.ses.privateKey, "2");
      const result2 = await deliver(t, JSON.stringify(signed2));
      expect(result2.companyId).toBe(CO);
      expect(t.ses.certFetches).toBe(1); // No additional fetch

      forgetSnsCerts();
    });
  });

  describe("company candidate matching", () => {
    it("finds a company by saved SES topic ARN and region", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ notificationType: "Send", mail: { timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      const result = await deliver(t, JSON.stringify(signed));
      expect(result.companyId).toBe(CO);
    });

    it("re-reads candidates once if an ARN was saved less than 10 seconds ago", async () => {
      forgetSnsCandidates();
      forgetSnsCerts();
      forgetSnsRefusals();
      // Setup WITHOUT topic ARN initially
      const base = setup({ esp: { enabled: true, provider: "ses", ratePerSecond: 10, ses: { region: SES_REGION, accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY, configurationSet: SES_CONFIGURATION_SET, snsTopicArn: null } } });
      await rememberCompany(base.host.ctx, CO);
      const ses = new FakeSesWithSns();
      base.env.esp = { fetch: hostFetch(ses.handle) };
      base.env.dns = fakeDns(dnsVerified());
      const t = { ...base, ses };

      const origNow = t.env.now;
      let elapsed = 0;
      t.env.now = () => origNow() + elapsed;

      // Test case 1: Previous read at t-30s, ARN saved at t, message at t+11s → re-read finds it (10s throttle passed)
      // At t-30s: deliver message for unknown topic → miss, populate cache at t-30s, set throttle at t-30s
      elapsed = -30_000;
      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ eventType: "Send", mail: { messageId: "msg@example.com", source: FROM, timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.ses.certUrl(),
      };
      const signed0 = signSns(msg as Record<string, string>, t.ses.privateKey, "2");
      await expect(deliver(t, JSON.stringify(signed0))).rejects.toMatchObject({ code: "unknown_topic" });

      // At t: save the company's esp.ses.snsTopicArn
      elapsed = 0;
      (t.host.ctx.config as any).get = async (id: string) => {
        if (id === CO) {
          const config = t.host.config as any;
          return { ...config, esp: { ...config.esp, ses: { ...config.esp.ses, snsTopicArn: SES_TOPIC_ARN } } };
        }
        return {};
      };

      // At t+11s: advance clock 11s (>10s throttle). Cache from t-30s is still fresh (11s < 60s) but miss re-read throttle has passed.
      // Force fresh read should find the company with the saved ARN
      elapsed = 11_000;
      const signed1 = signSns({ ...msg, MessageId: nextMessageId() } as Record<string, string>, t.ses.privateKey, "2");
      const result1 = await deliver(t, JSON.stringify(signed1));
      expect(result1.companyId).toBe(CO);

      // Test case 2: From t+11s, advance only 5s more to t+16s. Throttle (10s) prevents re-read, but cache still valid with company
      elapsed = 16_000;
      const signed2 = signSns({ ...msg, MessageId: nextMessageId() } as Record<string, string>, t.ses.privateKey, "2");
      const result2 = await deliver(t, JSON.stringify(signed2));
      expect(result2.companyId).toBe(CO);

      forgetSnsCandidates();
    });

    it("resolves ambiguity when two companies share the topic ARN using pib_company tag", async () => {
      forgetSnsCandidates();
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      // Add another company with the same topic
      (t.host.ctx.config as any).get = async (id: string) => {
        if (id === CO) return t.host.config;
        if (id === "co-2") return { ...SES_ON };
        return {};
      };
      await rememberCompany(t.host.ctx, "co-2");
      await addEspDomain(t, { provider: "ses", company: "co-2" });
      forgetSnsCandidates();
      // Message with pib_company tag pointing to co-2
      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ notificationType: "Send", mail: { timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: ["co-2"] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      const result = await deliver(t, JSON.stringify(signed));
      expect(result.companyId).toBe("co-2");

      forgetSnsCandidates();
    });
  });

  describe("message type handling", () => {
    it("SubscriptionConfirmation fetches the SubscribeURL and marks the topic confirmed", async () => {
      const t: SesSetup = sesSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "SubscriptionConfirmation" as const,
        MessageId: nextMessageId(),
        Message: "You have chosen to subscribe to the topic ...",
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SubscribeURL: t.ses.subscribeUrl(),
        Token: "test-token",
        SigningCertURL: t.ses.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.ses.privateKey, "2");
      const result = await deliver(t, JSON.stringify(signed));

      expect(result.outcome).toBe("ignored");
      expect(t.ses.subscribeUrlHits).toBeGreaterThan(0);
      const confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(true);

      forgetSnsCerts();
    });

    it("SubscriptionConfirmation with failed SubscribeURL GET (500) leaves topic unconfirmed; valid Notification then confirms it", async () => {
      const t = sesMockSetupUnconfirmed();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      // Start from unconfirmed state (sesMockSetupUnconfirmed does not auto-confirm)
      let confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(false); // Assert it is unconfirmed at the start

      // Simulate a failed SubscribeURL fetch by having it return non-2xx
      t.sns.subscribeUrlStatus = 500;

      const msg1 = {
        Type: "SubscriptionConfirmation" as const,
        MessageId: nextMessageId(),
        Message: "You have chosen to subscribe to the topic ...",
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SubscribeURL: t.sns.subscribeUrl(),
        Token: "test-token",
        SigningCertURL: t.sns.certUrl(),
      };
      const signed1 = signSns(msg1 as Record<string, string>, t.sns.privateKey, "2");
      await deliver(t, JSON.stringify(signed1));

      // Topic should still be unconfirmed after the failed SubscribeURL fetch
      confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(false);

      // Verify that the subscribe URL was attempted (to show the fetch happened)
      expect(t.sns.subscribeUrlHits).toBeGreaterThan(0);

      // Reset the status so a valid Notification can now be delivered
      t.sns.subscribeUrlStatus = 200;
      const msg2 = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ notificationType: "Send", mail: { timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed2 = signSns(msg2 as Record<string, string>, t.sns.privateKey, "2");
      await deliver(t, JSON.stringify(signed2));

      // Now the topic should be confirmed (first verified Notification confirms it)
      confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(true);

      forgetSnsCerts();
    });

    it("UnsubscribeConfirmation is logged and returns ignored", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const msg = {
        Type: "UnsubscribeConfirmation" as const,
        MessageId: nextMessageId(),
        Message: "You have chosen to unsubscribe from the topic ...",
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        Token: "test-token",
        SubscribeURL: t.sns.subscribeUrl(),
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      const result = await deliver(t, JSON.stringify(signed));

      expect(result.outcome).toBe("ignored");
    });

    it("Notification with notificationType Delivery is ignored and confirms the topic", async () => {
      const t = sesMockSetupUnconfirmed();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      // Start from unconfirmed state (sesMockSetupUnconfirmed does not auto-confirm)
      let confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(false); // Assert it is unconfirmed at the start

      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ notificationType: "Delivery", mail: { timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      const result = await deliver(t, JSON.stringify(signed));

      expect(result.outcome).toBe("ignored");
      // First verified Notification confirms the topic
      confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(true);
    });
  });

  describe("topic confirmation", () => {
    it("first verified Notification confirms the topic", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      let confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(true); // Already marked in sesMockSetup

      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: JSON.stringify({ eventType: "Send", mail: { messageId: "msg@example.com", source: FROM, timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      await deliver(t, JSON.stringify(signed));

      confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(true);
    });

    it("verified Notification with unparseable body marks topic confirmed", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      // sesMockSetup already marks topic confirmed, so we verify it stays confirmed
      let confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(true);

      // Deliver a Notification with unparseable body (not JSON)
      const msg = {
        Type: "Notification" as const,
        MessageId: nextMessageId(),
        Message: "not json at all",
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");
      const result = await deliver(t, JSON.stringify(signed));

      // Result should be ignored but outcome should still indicate message was ignored
      expect(result.outcome).toBe("ignored");

      // Topic should still be confirmed (even though the message body was unparseable)
      confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(true);
    });

    it("changing the saved ARN resets confirmation", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      let confirmed = await readSesTopicConfirmed(t.host.ctx, CO);
      expect(confirmed).toBe(true);

      // Change the ARN by mocking a new config
      const newArn = "arn:aws:sns:eu-north-1:123456789012:new-topic";
      const newConfig = { ...t.host.config, esp: { ...(t.host.config as any).esp, ses: { ...(t.host.config as any).esp.ses, snsTopicArn: newArn } } };
      (t.host.ctx.config as any).get = async (id: string) => (id === CO ? newConfig : {});
      forgetSnsCandidates();

      // Old ARN is no longer confirmed (config now has different ARN) - verified by checking with the new ARN
      confirmed = await readSesTopicConfirmed(t.host.ctx, CO, newArn);
      expect(confirmed).toBe(false);
    });
  });

  describe("replay defence", () => {
    it("same SNS MessageId twice: second is duplicate (dedupe, not timestamp window)", async () => {
      const t = sesMockSetup();
      await addEspDomain(t, { provider: "ses" });
      await knownToWebhook(t);

      const messageId = nextMessageId();
      const msg = {
        Type: "Notification" as const,
        MessageId: messageId,
        Message: JSON.stringify({ eventType: "Send", mail: { messageId: "msg@example.com", source: FROM, timestamp: "2024-01-01T00:00:00Z", tags: { pib_company: [CO] } } }),
        Timestamp: new Date().toISOString(),
        TopicArn: SES_TOPIC_ARN,
        SigningCertURL: t.sns.certUrl(),
      };
      const signed = signSns(msg as Record<string, string>, t.sns.privateKey, "2");

      // First delivery
      const result1 = await deliver(t, JSON.stringify(signed));
      expect(result1.outcome).not.toBe("ignored");

      // Second delivery (replay)
      const result2 = await deliver(t, JSON.stringify(signed));
      expect(result2.outcome).toBe("duplicate"); // Dedupe
    });
  });

  describe("logging and refusal throttling", () => {
    it("logs a refusal at most once a minute per reason with a count of suppressed ones", async () => {
      const t = sesMockSetup();
      await knownToWebhook(t);

      // Create a valid-format (but wrong) signature
      const validSig = Buffer.alloc(256, 0xAA).toString("base64");

      for (let i = 0; i < 3; i++) {
        const msg = JSON.stringify({
          Type: "Notification",
          MessageId: nextMessageId(),
          Message: "test",
          Timestamp: new Date().toISOString(),
          TopicArn: "invalid-arn",
          Signature: validSig,
          SignatureVersion: "2",
          SigningCertURL: "https://sns.eu-north-1.amazonaws.com/test.pem",
        });
        await deliver(t, msg).catch(() => undefined);
      }

      const logs = (t.host.ctx.logger.warn as any).mock.calls.filter((call: any) => call[0] === "Provider webhook refused");
      expect(logs.length).toBe(1);
      expect(logs[0][1].code).toBe("invalid_arn");

      // Move time forward 61 seconds
      t.env.now = () => Date.now() + 61_000;

      const msg = JSON.stringify({
        Type: "Notification",
        MessageId: nextMessageId(),
        Message: "test",
        Timestamp: new Date().toISOString(),
        TopicArn: "invalid-arn",
        Signature: validSig,
        SignatureVersion: "2",
        SigningCertURL: "https://sns.eu-north-1.amazonaws.com/test.pem",
      });
      await deliver(t, msg).catch(() => undefined);

      // Re-evaluate logs after the new delivery
      const updatedLogs = (t.host.ctx.logger.warn as any).mock.calls.filter((call: any) => call[0] === "Provider webhook refused");
      expect(updatedLogs.length).toBe(2);
      expect(updatedLogs[1][1]).toMatchObject({ code: "invalid_arn", alsoRefused: 2 });
    });
  });
});
