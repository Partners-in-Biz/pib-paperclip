import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acceptGrant, linkStatus, proposeGrant } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";

describe("partners", () => {
  it("uses the host namespace", () => {
    expect(NAMESPACE).toBe("plugin_partners_f5013a90fc");
    const sql = readFileSync(new URL("../migrations/001_partners.sql", import.meta.url), "utf8");
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.links`);
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.grants`);
  });

  it("stays pending until both companies accept", () => {
    expect(linkStatus(true, false)).toBe("pending");
    expect(linkStatus(true, true)).toBe("active");
  });

  it("proposes a named grant and does not copy the record", () => {
    expect(() => proposeGrant({ linkStatus: "pending", recordId: "contact-1", recordType: "contact" })).toThrow(/both companies/i);
    const proposed = proposeGrant({ linkStatus: "active", recordId: "contact-1", recordType: "contact" });
    expect(proposed.copiedRecord).toBeNull();
    expect(proposed.status).toBe("proposed");
    const accepted = acceptGrant({
      linkStatus: "active",
      sourceCompanyId: "workspace-a",
      actorCompanyId: "workspace-a",
      recordId: "contact-1",
      recordType: "contact",
    });
    expect(accepted.status).toBe("active");
    expect(accepted.copiedRecord).toBeNull();
    expect(accepted.recordId).toBe("contact-1");
  });
});
