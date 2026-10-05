import { describe, expect, it } from "vitest";
import { CARRY, pageLocation, settleMessage, visibleMessage, type RaisedMessage } from "../src/ui/page-message.js";

const agriStudies = pageLocation("company:agri", "sp-1");
const ownSprint = pageLocation("own", "sp-2");
const home = pageLocation("own", null);

describe("the page message belongs to its page", () => {
  it('"Sprint paused." does not follow a person to another sprint, nor back again', () => {
    let raised: RaisedMessage = { text: "Sprint paused.", at: agriStudies };
    expect(visibleMessage(raised, agriStudies)).toBe("Sprint paused.");
    // The first render on another page already hides it, and the settle drops it for good.
    expect(visibleMessage(raised, ownSprint)).toBe("");
    raised = settleMessage(raised, ownSprint);
    expect(raised.text).toBe("");
    expect(visibleMessage(settleMessage(raised, agriStudies), agriStudies)).toBe("");
  });

  it("a message raised just before a navigation follows it, and then belongs to the page it opened", () => {
    let raised: RaisedMessage = { text: "Sprint created.", at: CARRY };
    expect(visibleMessage(raised, ownSprint)).toBe("Sprint created.");
    raised = settleMessage(raised, ownSprint);
    expect(raised).toEqual({ text: "Sprint created.", at: ownSprint });
    expect(visibleMessage(raised, home)).toBe("");
    expect(settleMessage(raised, home).text).toBe("");
  });

  it("settling on the same page keeps the message", () => {
    const raised = { text: "Connected.", at: home };
    expect(settleMessage(raised, home)).toBe(raised);
  });

  it("the same sprint under another client is another page", () => {
    expect(pageLocation("company:a", "sp-1")).not.toBe(pageLocation("company:b", "sp-1"));
  });
});
