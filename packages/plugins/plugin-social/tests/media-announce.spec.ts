import { describe, expect, it, vi } from "vitest";
import { announceMedia, mediaAddedPayload, MEDIA_ADDED_EVENT } from "../src/media-announce.js";

const row = { id: "m1", company_id: "c1", name: "Clip", url: "https://cdn/x.mp4", kind: "video", mime: "video/mp4", bytes: 10, alt_text: null, client_kind: "company", client_ref: "acme", client_name: "Acme", scope: "org", owner_user_id: null } as never;

describe("media announce", () => {
  it("emits org media with its client", async () => {
    const emit = vi.fn();
    const ctx = { events: { emit }, logger: { warn: vi.fn() } } as never;
    expect(await announceMedia(ctx, "c1", row)).toBe(true);
    expect(emit).toHaveBeenCalledWith(MEDIA_ADDED_EVENT, "c1", expect.objectContaining({ mediaId: "m1", client: { kind: "company", id: "acme", name: "Acme" } }));
  });
  it("never announces personal media", async () => {
    const emit = vi.fn();
    expect(await announceMedia({ events: { emit } } as never, "c1", { ...(row as object), scope: "personal", owner_user_id: "u1" } as never)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
  it("gives own work no client", () => {
    expect(mediaAddedPayload({ ...(row as object), client_kind: null, client_ref: null } as never).client).toBeNull();
  });
});
