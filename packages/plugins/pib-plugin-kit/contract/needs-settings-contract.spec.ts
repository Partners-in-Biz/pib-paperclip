/**
 * Cross-plugin contract: the kit's "needs settings" matcher and the Setup
 * plugin's one match the exact text the host gives (PAR-11072, T1).
 *
 * The host refuses a job's call that names a company with no saved plugin
 * settings with one text (SDK `unconfiguredCompanyMessage`). The kit sweep
 * (`classifySkillSync`, `syncAllCompanies`) and Setup's `needsSettingsError`
 * must both read it as "needs settings", not as a failure.
 */
import { unconfiguredCompanyMessage } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { needsSettingsError } from "../../plugin-setup/src/bootstrap.js";
import { classifySkillSync } from "../src/index.js";

const HOST_TEXT =
  'company context is required: company "co-1" has no saved settings for this plugin; ' +
  "calls made outside a host invocation (jobs, timers, start-up) can act only for companies with saved settings";

describe("needs-settings text contract", () => {
  it("the host text is the one the plan fixed", () => {
    expect(unconfiguredCompanyMessage("co-1")).toBe(HOST_TEXT);
  });

  it("the kit sweep classifies it as needs_settings", () => {
    const outcome = classifySkillSync([{ skillKey: "k", action: "failed", error: HOST_TEXT } as never]);
    expect(outcome.status).toBe("needs_settings");
  });

  it("Setup's needsSettingsError matches it, and not a transient scope failure", () => {
    expect(needsSettingsError(HOST_TEXT)).toBe(true);
    expect(needsSettingsError("the worker referenced a missing, expired, or unknown invocation scope")).toBe(false);
  });
});
