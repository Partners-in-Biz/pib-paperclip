// @vitest-environment jsdom
/**
 * The client picker for a limited person (access stage B2, PAR-15212): `readLimitedTo` reads both shapes the plugins
 * send (`{ client, clients }` and the Ads `{ scopeKey, scopeKeys }`), and `LimitedClientPicker` names one company or
 * offers a choice of several.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientWorkspaceBar, LimitedClientPicker, readLimitedTo } from "../src/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("readLimitedTo", () => {
  it("reads { client, clients } with names on the rows (SEO, Campaigns)", () => {
    const raw = { client: "company:acme", clients: [{ client: "company:acme", name: "Acme Ltd" }, { client: "contact:jo", name: "Jo Acme" }] };
    expect(readLimitedTo(raw)).toEqual({ client: "company:acme", clients: [{ client: "company:acme", name: "Acme Ltd" }, { client: "contact:jo", name: "Jo Acme" }] });
  });

  it("reads bare keys with the names from a list of client rows (Social)", () => {
    const names = [{ client: "company:beta", name: "Beta Bakery" }, { client: "company:acme", name: "Acme Ltd" }];
    expect(readLimitedTo({ client: "company:beta", clients: ["company:acme", "company:beta"] }, names)?.clients).toEqual([
      { client: "company:acme", name: "Acme Ltd" },
      { client: "company:beta", name: "Beta Bakery" },
    ]);
  });

  it("reads the Ads shape with the names from a map", () => {
    const got = readLimitedTo({ scopeKey: "contact:jo", scopeKeys: ["company:acme", "contact:jo"] }, { "company:acme": "Acme Ltd", "contact:jo": "Jo Acme" });
    expect(got).toEqual({ client: "contact:jo", clients: [{ client: "company:acme", name: "Acme Ltd" }, { client: "contact:jo", name: "Jo Acme" }] });
  });

  it("names a client it has no name for, drops repeats and anything that is not a client key, and keeps the current one", () => {
    const got = readLimitedTo({ client: "company:zz", clients: ["company:acme", "company:acme", "own", "", 7, null, { client: "all" }, "contact:"] });
    expect(got).toEqual({ client: "company:zz", clients: [{ client: "company:zz", name: "Unnamed company" }, { client: "company:acme", name: "Unnamed company" }] });
    expect(readLimitedTo({ client: "contact:jo", clients: [] })?.clients).toEqual([{ client: "contact:jo", name: "Unnamed contact" }]);
  });

  it("is null without a limitedTo it can read: the switch is off or the person is not limited", () => {
    for (const raw of [undefined, null, "company:acme", [], {}, { client: "own", clients: [] }, { client: "company:acme" }, { client: "company:acme", clients: "company:acme" }, { scopeKey: "all", scopeKeys: [] }]) {
      expect(readLimitedTo(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("LimitedClientPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("with one company names it and offers no choice", () => {
    act(() => root.render(<LimitedClientPicker limitedTo={{ client: "company:acme", clients: [{ client: "company:acme", name: "Acme Ltd" }] }} onPick={() => {}} />));
    expect(container.querySelector("section[aria-label='Your companies']")?.textContent).toContain("Acme Ltd");
    expect(container.querySelector("select")).toBeNull();
  });

  it("with several offers them by name, shows the current one, and picks another", () => {
    const onPick = vi.fn();
    const limitedTo = { client: "company:beta", clients: [{ client: "company:acme", name: "Acme Ltd" }, { client: "company:beta", name: "Beta Bakery" }, { client: "contact:jo", name: "Jo Acme" }] };
    act(() => root.render(<LimitedClientPicker limitedTo={limitedTo} onPick={onPick} />));
    const select = container.querySelector("select")!;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([["company:acme", "Acme Ltd"], ["company:beta", "Beta Bakery"], ["contact:jo", "Jo Acme"]]);
    expect(select.value).toBe("company:beta");
    expect(container.querySelector(`label[for="${select.id}"]`)?.textContent).toBe("Company");
    act(() => {
      select.value = "contact:jo";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onPick).toHaveBeenCalledExactlyOnceWith("contact:jo");
  });

  it("disabled while the page is busy", () => {
    const limitedTo = { client: "company:acme", clients: [{ client: "company:acme", name: "Acme Ltd" }, { client: "company:beta", name: "Beta Bakery" }] };
    act(() => root.render(<LimitedClientPicker limitedTo={limitedTo} onPick={() => {}} disabled />));
    expect(container.querySelector("select")?.disabled).toBe(true);
  });

  it("ClientWorkspaceBar: ownPath null leaves the back link out (a limited person has no company-wide page)", () => {
    const client = { kind: "company" as const, id: "acme", name: "Acme Ltd" };
    const linkProps = (to: string) => ({ href: to });
    act(() => root.render(<ClientWorkspaceBar client={client} active="seo" linkProps={linkProps} ownPath="/seo" />));
    expect([...container.querySelectorAll("a")].find((a) => a.textContent?.includes("Our own"))?.getAttribute("href")).toBe("/seo");
    act(() => root.render(<ClientWorkspaceBar client={client} active="seo" linkProps={linkProps} ownPath={null} />));
    expect([...container.querySelectorAll("a")].some((a) => a.textContent?.includes("Our own"))).toBe(false);
    expect(container.querySelector("h1")?.textContent).toBe("Acme Ltd");
  });
});
