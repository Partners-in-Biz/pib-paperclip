import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertMayDraft, assertMaySend, defaultDelegation,
  createEmailTemplate,} from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";

describe("mailbox", () => {
  it("uses the host namespace", () => {
    expect(NAMESPACE).toBe("plugin_mailbox_319145c88b");
    const sql = readFileSync(new URL("../migrations/001_mailbox.sql", import.meta.url), "utf8");
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.delegations`);
    expect(sql).toContain("can_send boolean NOT NULL DEFAULT false");
  });

  it("drafts on a delegation and refuses a send unless that delegation allows it", () => {
    const delegation = defaultDelegation();
    expect(() => assertMayDraft(delegation)).not.toThrow();
    expect(() => assertMaySend(delegation)).toThrow(/draft-only/);
    expect(() => assertMaySend({ ...delegation, canSend: true })).not.toThrow();
    expect(() => assertMayDraft(null)).toThrow(/not allowed to draft/);
  });
});

describe("mailbox email templates", () => {
  it("creates a template with subject and body", () => {
    const template = createEmailTemplate({ companyId: "workspace-a", name: "Intro", subject: "Hello", body: "Hi there" });
    expect(template.name).toBe("Intro");
    expect(template.subject).toBe("Hello");
    expect(template.body).toBe("Hi there");
  });

  it("rejects a blank name or subject", () => {
    expect(() => createEmailTemplate({ companyId: "workspace-a", name: "  ", subject: "x" })).toThrow(/name is required/);
    expect(() => createEmailTemplate({ companyId: "workspace-a", name: "x", subject: "  " })).toThrow(/subject is required/);
  });
});
