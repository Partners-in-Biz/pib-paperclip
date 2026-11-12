/** The video fields of a Google YouTube video (Demand Gen) campaign proposal (PAR-6696): what is accepted, cleaned and refused. */
import { describe, expect, it } from "vitest";
import { AdsError } from "../src/domain.js";
import { videoInput, videoObjective, videoSettingsFrom } from "../src/providers/google-video.js";

const refused = (input: Record<string, unknown>, budget = 10_000) => {
  try {
    videoSettingsFrom(input, budget);
  } catch (error) {
    expect(error).toBeInstanceOf(AdsError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("Google YouTube video campaign settings", () => {
  it("maps VIDEO and YOUTUBE to DEMAND_GEN and leaves other objectives alone", () => {
    expect(videoObjective("VIDEO")).toBe("DEMAND_GEN");
    expect(videoObjective("YOUTUBE")).toBe("DEMAND_GEN");
    expect(videoObjective("DEMAND_GEN")).toBe("DEMAND_GEN");
    expect(videoObjective("SEARCH")).toBe("SEARCH");
  });

  it("accepts locations with conversions as the default, a target CPA, or clicks, and cleans the locations", () => {
    expect(videoSettingsFrom({ locationIds: ["2710", "geoTargetConstants/2710"] }, 10_000)).toEqual({ targetCpaMinor: null, bidFor: "CONVERSIONS", locationIds: ["2710"] });
    expect(videoSettingsFrom({ locationIds: "2710, 2826", targetCpaMinor: 500 }, 10_000)).toEqual({ targetCpaMinor: 500, bidFor: "CONVERSIONS", locationIds: ["2710", "2826"] });
    expect(videoSettingsFrom({ locationIds: ["2710"], bidFor: "clicks" }, 10_000)).toEqual({ targetCpaMinor: null, bidFor: "CLICKS", locationIds: ["2710"] });
  });

  it("refuses no or bad locations, a bad bidFor, a target with clicks, and a target that is zero or above the daily budget", () => {
    expect(refused({})).toContain("locationIds is required");
    expect(refused({ locationIds: ["South Africa"] })).toContain("geo target ids");
    expect(refused({ locationIds: ["2710"], bidFor: "VIEWS" })).toContain("bidFor must be one of");
    expect(refused({ locationIds: ["2710"], bidFor: "CLICKS", targetCpaMinor: 500 })).toContain("bids for conversions");
    expect(refused({ locationIds: ["2710"], targetCpaMinor: 0 })).toContain("more than zero");
    expect(refused({ locationIds: ["2710"], targetCpaMinor: 20_000 })).toContain("more than the daily budget");
  });

  it("turns stored settings back into proposal input for a revision", () => {
    const video = videoSettingsFrom({ locationIds: ["2710"], bidFor: "CLICKS" }, 10_000);
    expect(videoSettingsFrom(videoInput(video), 10_000)).toEqual(video);
    expect(videoInput(undefined)).toEqual({});
  });
});
