/** PAR-4165 (C36b): media-compliance counts published posts with media and alt text and lists unverified live posts. */
import { describe, expect, it } from "vitest";
import { mediaCompliance, summariseCompliance } from "../src/media-compliance.js";
import { fakeCtx } from "./helpers.js";

const img = (alt: string | null) => ({ url: "https://m/a.png", kind: "image", altText: alt });
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "published", media: [img("a dog")], overrides: {}, experiment_arm: null, published_at: "2026-10-20T08:00:00Z", ...extra }) as never;

describe("media compliance counts", () => {
  it("counts media and alt text, and excludes the control arm and text-native posts", () => {
    const out = summariseCompliance(
      [
        row("ok"),
        row("noalt", { media: [img("a dog"), img(" ")] }),
        row("nomedia", { media: [] }),
        row("ctrl", { media: [], experiment_arm: "control" }),
        row("tn", { media: [], overrides: { tags: ["text-native"] } }),
        row("variant", { experiment_arm: "variant" }),
      ],
      [{ id: "u1", status: "approved" }],
    );
    expect(out.excluded).toEqual({ controlArm: 1, textNative: 1 });
    expect(out.mediaFirst).toEqual({ total: 4, withMedia: 3, withoutMedia: 1, withAltText: 2, missingAltText: 1 });
    expect(out.postsWithoutMedia).toEqual(["nomedia"]);
    expect(out.postsMissingAltText).toEqual(["noalt"]);
    expect(out.unverified).toEqual([{ postId: "u1", status: "approved" }]);
  });
});

describe("media-compliance query", () => {
  // Two scopes in one store: the fake filters by the scope params the query passes, like the SQL does.
  const store = [
    { ...(row("a1") as object), client_ref: "A", client_kind: "company" },
    { ...(row("a2", { media: [] }) as object), client_ref: "A", client_kind: "company" },
    { ...(row("b1", { media: [] }) as object), client_ref: "B", client_kind: "company" },
  ] as Array<Record<string, unknown>>;
  const ctx = () =>
    fakeCtx({}, {
      queryResult: (sql, params) => {
        const ref = params[3];
        const rows = store.filter((r) => (ref === undefined ? r.client_ref == null : r.client_ref === ref));
        return sql.includes("review_outcomes") ? rows.slice(0, 1).map((r) => ({ id: r.id, status: "approved" })) : rows;
      },
    });

  it("TWO-SCOPE ISOLATION: scope A never sees scope B's posts", async () => {
    const c = ctx();
    const a = await mediaCompliance(c, "co", { kind: "company", id: "A" }, 28);
    expect(a.scope).toBe("company:A");
    expect(a.published).toBe(2);
    expect(a.postsWithoutMedia).toEqual(["a2"]);
    expect(a.unverified).toEqual([{ postId: "a1", status: "approved" }]);
    const b = await mediaCompliance(c, "co", { kind: "company", id: "B" }, 28);
    expect(b.postsWithoutMedia).toEqual(["b1"]);
    expect(JSON.stringify(b)).not.toContain("a1");
    expect((await mediaCompliance(c, "co", null, 28)).published).toBe(0);
  });

  it("is read-only, company-scoped and asks for a reviewer verdict only", async () => {
    const c = ctx();
    await mediaCompliance(c, "co", { kind: "company", id: "A" }, 7);
    expect(c.fakeDb.executes).toEqual([]);
    expect(c.fakeDb.queries.every((q) => q.params[0] === "co" && q.params[1] === 7)).toBe(true);
    expect(c.fakeDb.queries[1]!.sql).toContain("o.stage = 'reviewer'");
  });
});
