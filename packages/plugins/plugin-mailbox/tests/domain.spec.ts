import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertMayDraft, assertMaySend, defaultDelegation } from "../src/domain.js";
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
