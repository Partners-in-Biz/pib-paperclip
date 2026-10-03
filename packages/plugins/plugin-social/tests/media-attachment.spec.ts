/**
 * 0.8.0 (Q1a-5, Q10-11): an agent makes a carousel slide, a branded image or a short video and attaches it to its issue. The
 * plugin turns the attachment into a media asset on R2 (an id comes back, never a link to private storage). The file is trusted
 * for what its bytes say, not for its declared type: the PARA-4 MP4s are stored as application/octet-stream.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeUnsupported, mediaInfo, mimeFromName, shapeNotes, sniffMime } from "../src/media-info.js";
import { ATTACHMENT_MAX_BYTES, attachmentSource, importFromAttachment, listIssueAttachments } from "../src/media.js";
import { NAMESPACE } from "../src/namespace.js";
import { fakeCtx, mockFetch } from "./helpers.js";

const T = (name: string) => `${NAMESPACE}.${name}`;

// ── crafted files ───────────────────────────────────────────────────────────

const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16 = (n: number) => Buffer.from([(n >>> 8) & 255, n & 255]);
const l16 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255]);
const l24 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255]);
const box = (type: string, payload: Buffer) => Buffer.concat([u32(8 + payload.length), Buffer.from(type, "ascii"), payload]);

const png = (w: number, h: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(w), u32(h), Buffer.alloc(5), Buffer.alloc(40)]);
const jpeg = (w: number, h: number) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0]), u16(16), Buffer.alloc(14), Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(h), u16(w), Buffer.alloc(10), Buffer.from([0xff, 0xd9])]);
const gif = (w: number, h: number) => Buffer.concat([Buffer.from("GIF89a"), l16(w), l16(h), Buffer.alloc(8)]);
const webpX = (w: number, h: number) => Buffer.concat([Buffer.from("RIFF"), u32(30), Buffer.from("WEBP"), Buffer.from("VP8X"), u32(10), Buffer.alloc(4), l24(w - 1), l24(h - 1)]);
const webpLossy = (w: number, h: number) => Buffer.concat([Buffer.from("RIFF"), u32(30), Buffer.from("WEBP"), Buffer.from("VP8 "), u32(10), Buffer.from([0, 0, 0]), Buffer.from([0x9d, 0x01, 0x2a]), l16(w), l16(h)]);
/** version 0 mvhd: timescale 1000, `ms` long. */
const mvhd = (ms: number) => box("mvhd", Buffer.concat([Buffer.alloc(4), Buffer.alloc(8), u32(1000), u32(ms), Buffer.alloc(80)]));
/** version 0 tkhd with the width and height as 16.16 fixed point. */
const tkhd = (w: number, h: number) => box("tkhd", Buffer.concat([Buffer.alloc(76), u32(w * 65536), u32(h * 65536)]));
const mp4 = (w: number, h: number, ms: number, brand = "isom") => Buffer.concat([box("ftyp", Buffer.concat([Buffer.from(brand), Buffer.alloc(4), Buffer.from(brand)])), box("moov", Buffer.concat([mvhd(ms), box("trak", Buffer.concat([box("tkhd", Buffer.concat([Buffer.alloc(76), u32(0), u32(0)])), box("mdia", Buffer.alloc(8))])), box("trak", tkhd(w, h))])), box("mdat", Buffer.alloc(32, 7))]);

describe("reading a file's own bytes", () => {
  it("knows the types social posts take, from the bytes alone", () => {
    expect(sniffMime(png(10, 10))).toBe("image/png");
    expect(sniffMime(jpeg(10, 10))).toBe("image/jpeg");
    expect(sniffMime(gif(10, 10))).toBe("image/gif");
    expect(sniffMime(webpX(10, 10))).toBe("image/webp");
    expect(sniffMime(mp4(1080, 1920, 1000))).toBe("video/mp4");
    expect(sniffMime(mp4(1080, 1920, 1000, "qt  "))).toBe("video/quicktime");
    // Every common video brand is a video; the same box with a still-image brand (a phone's HEIC, an AVIF) is not.
    for (const brand of ["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash", "3gp4"]) expect(sniffMime(mp4(1080, 1920, 1000, brand)), brand).toBe("video/mp4");
    for (const brand of ["heic", "heix", "hevc", "mif1", "msf1", "avif", "avis"]) expect(sniffMime(mp4(1080, 1920, 1000, brand)), brand).toBeNull();
    for (const other of [Buffer.from("PK\u0003\u0004rest"), Buffer.from("%PDF-1.4"), Buffer.from("<svg xmlns='x'/>"), Buffer.from("hello world"), Buffer.alloc(0), Buffer.alloc(3)]) expect(sniffMime(other)).toBeNull();
  });

  it("reads width and height from each image format", () => {
    expect(mediaInfo(png(1080, 1350), "image/png")).toEqual({ width: 1080, height: 1350, durationS: null });
    expect(mediaInfo(jpeg(1200, 630), "image/jpeg")).toEqual({ width: 1200, height: 630, durationS: null });
    expect(mediaInfo(gif(320, 240), "image/gif")).toEqual({ width: 320, height: 240, durationS: null });
    expect(mediaInfo(webpX(1000, 1500), "image/webp")).toEqual({ width: 1000, height: 1500, durationS: null });
    expect(mediaInfo(webpLossy(800, 600), "image/webp")).toEqual({ width: 800, height: 600, durationS: null });
  });

  it("reads a video's size and length, skipping an audio-only track", () => {
    expect(mediaInfo(mp4(1080, 1920, 18_300), "video/mp4")).toEqual({ width: 1080, height: 1920, durationS: 18.3 });
    expect(mediaInfo(mp4(1920, 1080, 90_500, "qt  "), "video/quicktime")).toEqual({ width: 1920, height: 1080, durationS: 90.5 });
  });

  it("a file that does not parse still gives nothing, never an error", () => {
    expect(mediaInfo(Buffer.from("garbage"), "image/png")).toEqual({ width: null, height: null, durationS: null });
    expect(mediaInfo(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5)]), "image/jpeg")).toEqual({ width: null, height: null, durationS: null });
    expect(mediaInfo(Buffer.concat([box("ftyp", Buffer.from("isom0000isom")), Buffer.from([0, 0, 0xff, 0xff])]), "video/mp4")).toEqual({ width: null, height: null, durationS: null });
  });

  it("flags the shapes a platform will not like", () => {
    expect(shapeNotes({ width: 1080, height: 1350, durationS: null }, "image/png")).toEqual([]);
    expect(shapeNotes({ width: 800, height: 800, durationS: null }, "image/png")[0]).toContain("under 1080 px");
    expect(shapeNotes({ width: 3000, height: 1000, durationS: null }, "image/png").join(" ")).toContain("between 4:5 and 1.91:1");
    expect(shapeNotes({ width: 1080, height: 1920, durationS: 20 }, "video/mp4")).toEqual([]);
    expect(shapeNotes({ width: 1920, height: 1080, durationS: 20 }, "video/mp4")[0]).toContain("not 9:16");
    expect(shapeNotes({ width: 1080, height: 1920, durationS: 120 }, "video/mp4")[0]).toContain("under 90 seconds");
    expect(shapeNotes({ width: null, height: null, durationS: null }, "video/mp4")).toEqual([]);
  });

  it("names what a file is when it cannot be used, and what a file name suggests", () => {
    expect(describeUnsupported(Buffer.from("PK\u0003\u0004zz"), "application/octet-stream", "assets.zip")).toContain("a zip archive");
    expect(describeUnsupported(Buffer.from("%PDF-1.7"), "application/pdf", null)).toContain("a PDF");
    expect(describeUnsupported(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml", null)).toContain("an SVG");
    expect(describeUnsupported(mp4(10, 10, 1000, "heic"), "image/heic", "IMG_0001.HEIC")).toContain("a HEIC, HEIF or AVIF photo");
    expect(describeUnsupported(mp4(10, 10, 1000, "avif"), "image/avif", null)).toContain("export it as JPEG or PNG");
    expect(describeUnsupported(Buffer.from("plain"), "text/plain", "notes.txt")).toBe("a file of type text/plain (notes.txt)");
    expect(mimeFromName("V01-5-second-challenge-1080x1920.mp4")).toBe("video/mp4");
    expect(mimeFromName("SHEET.PNG")).toBe("image/png");
    expect(mimeFromName("assets.zip")).toBeNull();
    expect(mimeFromName(null)).toBeNull();
  });
});

// ── the tools ───────────────────────────────────────────────────────────────

interface Attachment { id: string; issueId: string; originalFilename: string | null; contentType: string; byteSize: number }

function world(opts: { files?: Array<{ meta: Attachment; bytes: Buffer; sha?: string }>; imported?: Record<string, Record<string, unknown>>; client?: boolean; issueProjects?: Record<string, string>; clientProjects?: string[] } = {}) {
  const files = opts.files ?? [];
  const inserted: unknown[][] = [];
  const reads: string[] = [];
  const lists: string[] = [];
  const ctx = fakeCtx(
    {
      config: {
        get: vi.fn(async () => ({
          publicBaseUrl: "https://paperclip.example.com",
          r2: { accountId: "acc", bucket: "media", accessKeyId: "AK", secretAccessKey: { type: "secret_ref", secretId: "s" }, publicMediaBaseUrl: "https://media.example.com" },
        })),
      },
      secrets: { resolve: vi.fn(async () => "SK") },
      // The CRM's list of Paperclip projects linked to the client (`client.projects.updated`), kept in plugin state by the kit.
      state: { get: vi.fn(async (key: { stateKey: string }) => (key.stateKey === "client-projects:company:c1" && opts.clientProjects ? { projectIds: opts.clientProjects, updatedAt: "2026-10-03T00:00:00Z" } : null)) },
      projects: { managed: { get: vi.fn(async () => ({ projectId: "proj-social" })) } },
      issues: {
        // The host answers an id or an identifier like PIB-23 with the issue (null outside the company).
        get: vi.fn(async (ref: string) => (ref === "iss-missing" ? null : { id: ref === "PIB-23" ? "iss-1" : ref, projectId: opts.issueProjects?.[ref === "PIB-23" ? "iss-1" : ref] ?? null })),
        listAttachments: vi.fn(async (issueId: string) => {
          lists.push(issueId);
          return files.filter((f) => f.meta.issueId === issueId).map((f) => ({ ...f.meta, companyId: "co", createdAt: new Date(), updatedAt: new Date(), contentPath: "/api/attachments/x/content", openPath: "x", downloadPath: "y" }));
        }),
        getAttachmentContent: vi.fn(async (attachmentId: string) => {
          reads.push(attachmentId);
          const f = files.find((x) => x.meta.id === attachmentId);
          return f ? { attachmentId, contentType: f.meta.contentType, byteSize: f.bytes.length, sha256: f.sha ?? createHash("sha256").update(f.bytes).digest("hex"), originalFilename: f.meta.originalFilename, contentBase64: f.bytes.toString("base64") } : null;
        }),
      },
    },
    {
      queryResult: (sql, params) => {
        if (sql.includes(`FROM ${T("media_assets")}`) && sql.includes("source_url = $2")) {
          const hit = opts.imported?.[String(params[1])];
          return hit ? [hit] : [];
        }
        if (sql.includes(`FROM ${T("crm_companies")}`)) return opts.client === false ? [] : [{ id: "c1", name: "Acme", domain: null, lifecycle: null }];
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.startsWith(`INSERT INTO ${T("media_assets")}`)) inserted.push(params);
        return 1;
      },
    },
  );
  return { ctx, inserted, reads, lists };
}

const attach = (id: string, name: string | null, type: string, bytes: Buffer, issueId = "iss-1"): { meta: Attachment; bytes: Buffer } => ({ meta: { id, issueId, originalFilename: name, contentType: type, byteSize: bytes.length }, bytes });

afterEach(() => vi.unstubAllGlobals());

describe("import-media-from-attachment", () => {
  it("imports an MP4 stored as application/octet-stream: type, size and length from the bytes, an asset id back", async () => {
    const video = mp4(1080, 1920, 18_300);
    const w = world({ files: [attach("att-1", "V01-5-second-challenge-1080x1920.mp4", "application/octet-stream", video)] });
    const net = mockFetch([[/^PUT https:\/\/acc\.r2\.cloudflarestorage\.com\/media\/social\/co\//, () => new Response("", { status: 200 })]]);
    const out = await importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-1", altText: "A five second reading challenge" });
    expect(out).toMatchObject({ kind: "video", mime: "video/mp4", width: 1080, height: 1920, durationS: 18.3, bytes: video.length, name: "V01-5-second-challenge-1080x1920.mp4", altText: "A five second reading challenge", reused: false, notes: [] });
    expect(out.url).toMatch(/^https:\/\/media\.example\.com\/social\/co\/\d{4}-\d{2}\/[0-9a-f-]{36}-v01-5-second-challenge-1080x1920\.mp4$/);
    expect(out.r2Key).toBe(String(out.url).replace("https://media.example.com/", ""));
    // One PUT to R2 with the right type and exactly the file's bytes.
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.headers.get("content-type")).toBe("video/mp4");
    expect((net.calls[0]!.body as Uint8Array).length).toBe(video.length);
    // The asset row remembers where it came from, and carries no client (own work).
    const row = w.inserted[0]!;
    expect(row.at(-1)).toBe(attachmentSource("iss-1", "att-1"));
    expect(row.slice(12, 15)).toEqual([null, null, null]);
    // No private link ever leaves: the result has none of the host's attachment paths.
    expect(JSON.stringify(out)).not.toMatch(/\/api\/attachments|contentPath|downloadPath/);
  });

  it("notes a slide that is the wrong shape, and saves it in the client's scope", async () => {
    const w = world({ files: [attach("att-2", "SHEET.png", "image/png", png(800, 800))] });
    mockFetch([[/^PUT /, () => new Response("", { status: 200 })]]);
    const out = await importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-2", client: "company:c1" });
    expect(out).toMatchObject({ kind: "image", mime: "image/png", width: 800, height: 800, client: "company:c1", clientName: "Acme" });
    expect(out.notes[0]).toContain("under 1080 px");
    expect(w.inserted[0]!.slice(12, 15)).toEqual(["company", "c1", "Acme"]);
  });

  it("importing the same attachment again returns the same asset and reads nothing", async () => {
    const existing = { id: "asset-9", company_id: "co", name: "SHEET.png", url: "https://media.example.com/social/co/x.png", kind: "image", r2_key: "social/co/x.png", mime: "image/png", bytes: 99, width: 1080, height: 1350, duration_s: null, alt_text: null, client_kind: null, client_ref: null, client_name: null, created_at: new Date() };
    const w = world({ files: [attach("att-3", "SHEET.png", "image/png", png(1080, 1350))], imported: { [attachmentSource("iss-1", "att-3")]: existing } });
    const net = mockFetch([]);
    const out = await importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-3" });
    expect(out).toMatchObject({ id: "asset-9", reused: true });
    expect(w.reads).toEqual([]);
    expect(net.calls).toEqual([]);
    expect(w.inserted).toEqual([]);
  });

  it("refuses what is not on that issue, what is too big, what is not media, and a file whose bytes were altered", async () => {
    const big = { meta: { id: "att-big", issueId: "iss-1", originalFilename: "long.mp4", contentType: "video/mp4", byteSize: ATTACHMENT_MAX_BYTES + 1 }, bytes: Buffer.alloc(8) };
    const w = world({
      files: [
        attach("att-ok", "a.png", "image/png", png(1080, 1350), "iss-other"),
        big,
        attach("att-zip", "assets.zip", "application/octet-stream", Buffer.from("PK\u0003\u0004zzzz")),
        { ...attach("att-bad", "b.png", "image/png", png(1080, 1350)), sha: "0".repeat(64) },
        attach("att-empty", "e.png", "image/png", Buffer.alloc(0)),
      ],
    });
    mockFetch([[/^PUT /, () => new Response("", { status: 200 })]]);
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-ok" })).rejects.toThrow("not on that issue");
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "nope" })).rejects.toThrow("not on that issue");
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-big" })).rejects.toThrow(/64 MB/);
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-zip" })).rejects.toThrow(/a zip archive.*Social takes JPEG, PNG, GIF, WebP images and MP4 or MOV videos/);
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-bad" })).rejects.toThrow("do not match its recorded checksum");
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-empty" })).rejects.toThrow("attachment is empty");
    await expect(importFromAttachment(w.ctx, "co", { issueId: "", attachmentId: "x" })).rejects.toThrow("issueId is required");
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "" })).rejects.toThrow("attachmentId is required");
    // Nothing reached R2 or the table for any of them.
    expect(w.inserted).toEqual([]);
  });

  it("names a phone's HEIC photo for what it is, instead of passing it off as a video", async () => {
    const w = world({ files: [attach("att-heic", "IMG_0042.HEIC", "application/octet-stream", mp4(3000, 4000, 0, "heic"))] });
    mockFetch([[/^PUT /, () => new Response("", { status: 200 })]]);
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-heic" })).rejects.toThrow(/a HEIC, HEIF or AVIF photo \(export it as JPEG or PNG first/);
    expect(w.inserted).toEqual([]);
  });

  it("imports without keeping a second copy of the file: the bytes handed to R2 are the decoded buffer itself", async () => {
    const w = world({ files: [attach("att-1", "a.png", "image/png", png(1080, 1350))] });
    const net = mockFetch([[/^PUT /, () => new Response("", { status: 200 })]]);
    await importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-1" });
    expect(Buffer.isBuffer(net.calls[0]!.body)).toBe(true);
  });

  it("a client's library takes files from the client's own projects, not from another client's issue", async () => {
    const file = attach("att-1", "logo.png", "image/png", png(1080, 1350));
    mockFetch([[/^PUT /, () => new Response("", { status: 200 })]]);
    // The CRM linked project P-ACME to the client. The attachment's issue is in another client's project.
    const foreign = world({ files: [file], clientProjects: ["P-ACME"], issueProjects: { "iss-1": "P-OTHER" } });
    await expect(importFromAttachment(foreign.ctx, "co", { issueId: "iss-1", attachmentId: "att-1", client: "company:c1" })).rejects.toThrow("another project than Acme's own");
    expect(foreign.reads).toEqual([]);
    expect(foreign.inserted).toEqual([]);
    // The client's own project, the shared Social project (where unlinked work lives) and an issue with no project are fine.
    for (const projectId of ["P-ACME", "proj-social"]) {
      const ok = world({ files: [file], clientProjects: ["P-ACME"], issueProjects: { "iss-1": projectId } });
      await expect(importFromAttachment(ok.ctx, "co", { issueId: "iss-1", attachmentId: "att-1", client: "company:c1" })).resolves.toMatchObject({ client: "company:c1" });
    }
    const none = world({ files: [file], clientProjects: ["P-ACME"] });
    await expect(importFromAttachment(none.ctx, "co", { issueId: "iss-1", attachmentId: "att-1", client: "company:c1" })).resolves.toMatchObject({ kind: "image" });
  });

  it("nothing to compare means no refusal: own work, and a client the CRM has linked no project to", async () => {
    const file = attach("att-1", "logo.png", "image/png", png(1080, 1350));
    mockFetch([[/^PUT /, () => new Response("", { status: 200 })]]);
    const own = world({ files: [file], clientProjects: ["P-ACME"], issueProjects: { "iss-1": "P-OTHER" } });
    await expect(importFromAttachment(own.ctx, "co", { issueId: "iss-1", attachmentId: "att-1" })).resolves.toMatchObject({ kind: "image" });
    const unlinked = world({ files: [file], issueProjects: { "iss-1": "P-OTHER" } });
    await expect(importFromAttachment(unlinked.ctx, "co", { issueId: "iss-1", attachmentId: "att-1", client: "company:c1" })).resolves.toMatchObject({ kind: "image" });
  });

  it("takes an issue identifier as well as an id, and refuses an issue outside the company", async () => {
    const w = world({ files: [attach("att-1", "a.png", "image/png", png(1080, 1350))] });
    mockFetch([[/^PUT /, () => new Response("", { status: 200 })]]);
    const out = await importFromAttachment(w.ctx, "co", { issueId: "PIB-23", attachmentId: "att-1" });
    // The attachments are listed by the issue's id, and the asset remembers that id (so the same file is the same asset by either name).
    expect(w.lists).toEqual(["iss-1"]);
    expect(w.inserted[0]!.at(-1)).toBe(attachmentSource("iss-1", "att-1"));
    expect(out).toMatchObject({ kind: "image" });
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-missing", attachmentId: "att-1" })).rejects.toThrow("Issue iss-missing was not found in this company");
    await expect(listIssueAttachments(w.ctx, "co", { issueId: "iss-missing" })).rejects.toThrow("was not found in this company");
    expect((await listIssueAttachments(w.ctx, "co", { issueId: "PIB-23" })).map((r) => r.attachmentId)).toEqual(["att-1"]);
  });

  it("an unknown client is refused before anything is read", async () => {
    const w = world({ files: [attach("att-1", "a.png", "image/png", png(1080, 1350))], client: false });
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-1", client: "company:nobody" })).rejects.toThrow(/Unknown client/);
    expect(w.lists).toEqual([]);
    expect(w.reads).toEqual([]);
  });

  it("another company's attachment id reads as missing (the host answers null)", async () => {
    const w = world({ files: [] });
    (w.ctx.issues.listAttachments as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: "att-x", issueId: "iss-1", byteSize: 10, contentType: "image/png", originalFilename: "x.png" }]);
    await expect(importFromAttachment(w.ctx, "co", { issueId: "iss-1", attachmentId: "att-x" })).rejects.toThrow("could not be read");
  });
});

describe("list-issue-attachments", () => {
  it("lists metadata only and says which files look importable, by name when the type is generic", async () => {
    const w = world({
      files: [
        attach("a1", "V01.mp4", "application/octet-stream", Buffer.alloc(409_116)),
        attach("a2", "SHEET.png", "image/png", Buffer.alloc(242_252)),
        attach("a3", "assets.zip", "application/octet-stream", Buffer.alloc(8_879_558)),
        { meta: { id: "a4", issueId: "iss-1", originalFilename: "huge.mp4", contentType: "video/mp4", byteSize: ATTACHMENT_MAX_BYTES + 5 }, bytes: Buffer.alloc(1) },
      ],
    });
    const rows = await listIssueAttachments(w.ctx, "co", { issueId: "iss-1" });
    expect(rows.map((r) => [r.attachmentId, r.importable, r.looksLike])).toEqual([["a1", true, "video/mp4"], ["a2", true, "image/png"], ["a3", false, null], ["a4", false, "video/mp4"]]);
    expect(rows[3]!.problem).toContain("too big");
    expect(Object.keys(rows[0]!).sort()).toEqual(["attachmentId", "bytes", "declaredType", "importable", "issueId", "looksLike", "name"]);
    expect(JSON.stringify(rows)).not.toMatch(/contentPath|openPath|downloadPath|\/api\//);
    await expect(listIssueAttachments(w.ctx, "co", {})).rejects.toThrow("issueId is required");
    expect(await listIssueAttachments(w.ctx, "co", { issueId: "iss-empty" })).toEqual([]);
  });
});
