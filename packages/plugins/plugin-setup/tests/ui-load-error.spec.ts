import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { errorText } from "@partnersinbiz/pib-plugin-ui";
import { showLoadingLine } from "../src/ui/index.js";

describe("setup load failure", () => {
  const rejected = { code: "forbidden", message: "Viewer access is read-only" };

  it("reads the server message from a plain rejected object", () => {
    expect(errorText(rejected)).toBe("Viewer access is read-only");
  });

  it("shows the message and no Loading once the load failed", () => {
    const error = errorText(rejected);
    expect(showLoadingLine({ loading: false, load: null, error })).toBe(false);
    expect(showLoadingLine({ loading: true, load: null, error })).toBe(false);
    const html = renderToStaticMarkup(createElement("p", { role: "alert" }, error));
    expect(html).toContain("Viewer access is read-only");
    expect(html).not.toContain("Loading");
  });

  it("still shows Loading while a first load is pending", () => {
    expect(showLoadingLine({ loading: true, load: null, error: null })).toBe(true);
    expect(showLoadingLine({ loading: true, load: {}, error: null })).toBe(false);
  });
});
