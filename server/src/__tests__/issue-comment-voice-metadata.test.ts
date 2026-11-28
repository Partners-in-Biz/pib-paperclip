import { describe, expect, it } from "vitest";
import { issueCommentMetadataSchema } from "@paperclipai/shared";
import { withAgentCommentAuthorizationMetadata } from "../services/issues.js";

describe("withAgentCommentAuthorizationMetadata with voice metadata", () => {
  it("adds the authorization section for empty sections and the result still parses", () => {
    const out = withAgentCommentAuthorizationMetadata(
      { version: 1, voice: { mode: "direct" }, sections: [] },
      "allow_test",
    );
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0]?.title).toBe("Authorization");
    expect(out.voice).toBeUndefined();
    expect(issueCommentMetadataSchema.safeParse(out).success).toBe(true);
  });
});
