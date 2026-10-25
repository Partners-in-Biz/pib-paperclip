import { describe, expect, it } from "vitest";
import { PLAYBOOKS } from "../src/templates/playbooks.js";

describe("Google grant playbooks", () => {
  it("name the operator's account as grantee, not the Search Console service account", () => {
    const gbp = JSON.stringify(PLAYBOOKS["w0-gbp-claim"]);
    expect(gbp).toContain("add the managing Google account as a manager");
    expect(gbp).toContain("not the Search Console service account");
    expect(gbp).toContain("email to follow");
    const merchant = JSON.stringify(PLAYBOOKS["w0-merchant-center"]);
    expect(merchant).toContain("add the managing Google account as a user");
    expect(merchant).toContain("the operator's account, email as above");
    expect(gbp + merchant).not.toContain("gsc-connect-url");
  });
});
