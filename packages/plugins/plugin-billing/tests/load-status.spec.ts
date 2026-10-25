import { describe, expect, it } from "vitest";
import { loadStatusText } from "../src/ui/load-status.js";

describe("what the page shows while its data is not here", () => {
  it("says Loading… until the load settles", () => {
    expect(loadStatusText(null)).toBe("Loading…");
  });

  it("shows a viewer the read-only message, not Loading…, when the load is refused", async () => {
    const error = await Promise.reject({ message: "Viewer access is read-only" }).catch((e: { message: string }) => e.message);
    expect(loadStatusText(error)).toBe("Viewer access is read-only");
    expect(loadStatusText(error)).not.toContain("Loading");
  });
});
