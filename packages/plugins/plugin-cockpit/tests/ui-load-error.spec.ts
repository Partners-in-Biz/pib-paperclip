import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { errorText } from "@partnersinbiz/pib-plugin-ui";
import { emptyViewText } from "../src/ui/index.js";

describe("cockpit load failure", () => {
  const rejected = { code: "forbidden", message: "Viewer access is read-only" };

  it("reads the server message from a plain rejected object", () => {
    expect(errorText(rejected)).toBe("Viewer access is read-only");
  });

  it("shows no placeholder once the load failed", () => {
    const text = emptyViewText({ loading: false, error: errorText(rejected) });
    const html = renderToStaticMarkup(createElement("p", null, text));
    expect(html).not.toContain("Loading");
    expect(html).not.toContain("Nothing to show yet");
  });

  it("keeps the placeholders while loading and when empty", () => {
    expect(emptyViewText({ loading: true, error: null })).toContain("Loading");
    expect(emptyViewText({ loading: false, error: null })).toBe("Nothing to show yet.");
  });
});
