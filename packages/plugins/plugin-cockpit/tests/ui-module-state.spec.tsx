import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModuleStateNotice } from "@partnersinbiz/pib-plugin-ui";

const link = { href: "/PAR/setup" };

describe("module state notice", () => {
  it("tells a switched-off module to be turned on in Setup", () => {
    const html = renderToStaticMarkup(createElement(ModuleStateNotice, { state: "off", setupLinkProps: link }));
    expect(html).toContain("switched off for this company");
    expect(html).toContain('<a href="/PAR/setup"');
    expect(html).toContain("Setup</a>");
  });

  it("tells a module outside the plan to ask Partners in Biz, with no Setup link", () => {
    const html = renderToStaticMarkup(createElement(ModuleStateNotice, { state: "not_entitled", setupLinkProps: link }));
    expect(html).toContain("not in your plan");
    expect(html).toContain("Ask Partners in Biz");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Setup");
  });

  it("shows nothing while loading or when the module is on", () => {
    expect(renderToStaticMarkup(createElement(ModuleStateNotice, { state: null, setupLinkProps: link }))).toBe("");
    expect(renderToStaticMarkup(createElement(ModuleStateNotice, { state: "on", setupLinkProps: link }))).toBe("");
  });
});
