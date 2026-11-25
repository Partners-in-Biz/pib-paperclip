/** The app fields of a Google App campaign proposal (PAR-6695): what is accepted, how it is cleaned, and what is refused. */
import { describe, expect, it } from "vitest";
import { AdsError } from "../src/domain.js";
import { appInput, appSettingsFrom } from "../src/providers/google-app.js";

const refused = (input: Record<string, unknown>, budget = 10_000) => {
  try {
    appSettingsFrom(input, budget);
  } catch (error) {
    expect(error).toBeInstanceOf(AdsError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("Google App campaign settings", () => {
  it("accepts a Play package or an App Store id, cleans the id and the locations", () => {
    expect(appSettingsFrom({ appStore: "google_app_store", appId: "com.velox.app", locationIds: ["2710", "geoTargetConstants/2710"] }, 10_000)).toEqual({ appStore: "GOOGLE_APP_STORE", appId: "com.velox.app", targetInstallCostMinor: null, locationIds: ["2710"] });
    expect(appSettingsFrom({ appStore: "APPLE_APP_STORE", appId: "id1234567890", targetInstallCostMinor: 1500, locationIds: "2710, 2826" }, 10_000)).toEqual({ appStore: "APPLE_APP_STORE", appId: "1234567890", targetInstallCostMinor: 1500, locationIds: ["2710", "2826"] });
  });

  it("refuses a missing or wrong store, an app id that does not fit the store, no locations, and a target above the daily budget", () => {
    expect(refused({ appId: "com.a.b", locationIds: ["2710"] })).toContain("appStore");
    expect(refused({ appStore: "AMAZON", appId: "com.a.b", locationIds: ["2710"] })).toContain("appStore must be one of");
    expect(refused({ appStore: "GOOGLE_APP_STORE", appId: "velox", locationIds: ["2710"] })).toContain("package name");
    expect(refused({ appStore: "APPLE_APP_STORE", appId: "com.velox.app", locationIds: ["2710"] })).toContain("numeric id");
    expect(refused({ appStore: "GOOGLE_APP_STORE", appId: "com.a.b" })).toContain("locationIds is required");
    expect(refused({ appStore: "GOOGLE_APP_STORE", appId: "com.a.b", locationIds: ["South Africa"] })).toContain("geo target ids");
    expect(refused({ appStore: "GOOGLE_APP_STORE", appId: "com.a.b", locationIds: ["2710"], targetInstallCostMinor: 20_000 })).toContain("more than the daily budget");
    expect(refused({ appStore: "GOOGLE_APP_STORE", appId: "com.a.b", locationIds: ["2710"], targetInstallCostMinor: 0 })).toContain("more than zero");
  });

  it("turns a stored app back into proposal input for a revision", () => {
    const app = appSettingsFrom({ appStore: "GOOGLE_APP_STORE", appId: "com.a.b", locationIds: ["2710"], targetInstallCostMinor: 900 }, 10_000);
    expect(appSettingsFrom(appInput(app), 10_000)).toEqual(app);
    expect(appInput(null)).toEqual({});
  });
});
