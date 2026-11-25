/**
 * PAR-10250: a save into an existing client sub-folder takes ONE Drive query for the folder (findSubfolder), not the
 * full ensure. Real native broker, Google faked in memory; the Drive request count is the fake's call log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { boot, CO, seed, company, contact } from "./helpers/crm.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { driveFolderEnsure } from "../src/drive/tools.js";
import { saveDriveFile } from "../src/drive/save.js";
import { DRIVE_ID, KEY_JSON, LAYOUT, fakeGoogle, folderAt, uploadsOf } from "./support/fake-google-drive.js";

const NATIVE = { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: DRIVE_ID } };
const A = `${LAYOUT.clients}/Acme Ltd (Contact A)`;
const B = `${LAYOUT.clients}/Beta Ltd (Contact B)`;
let n = 0;
const input = (projectId: string, subfolder: string) => ({ companyId: CO, projectId, fileKind: "client", name: `2026-10-23 report v${++n}.txt`, mimeType: "text/plain", contentBase64: Buffer.from(`report ${n}`).toString("base64"), subfolder });

async function setup() {
  const st = seed();
  for (const [k, name, who] of [["a", "Acme Ltd", "Contact A"], ["b", "Beta Ltd", "Contact B"]] as const) {
    st.companies!.push(company(`co-${k}`, name));
    st.contacts!.push(contact(`contact-${k}`, who));
    st.contact_companies!.push({ id: `cc-${k}`, company_id: CO, contact_id: `contact-${k}`, account_id: `co-${k}`, role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
    st.client_projects!.push({ id: `cp-${k}`, company_id: CO, project_id: `p-${k}`, client_kind: "company", client_ref: `co-${k}`, kind: "seo", created_at: "2026-01-01T00:00:00Z" });
  }
  const { harness } = await boot({ config: NATIVE, store: st });
  harness.seed({ projects: [{ id: "p-a", companyId: CO, name: "Acme SEO" } as never, { id: "p-b", companyId: CO, name: "Beta SEO" } as never] });
  const google = fakeGoogle();
  vi.stubGlobal("fetch", google.fetchFn);
  const save = (projectId: string, subfolder: string) => saveDriveFile(harness.ctx, { companyId: CO, userId: null, agentId: null, role: null }, input(projectId, subfolder) as never);
  const timing = () => (harness.logs ?? []).filter((l: { message: string }) => l.message === "drive save timing").map((l: any) => l.meta);
  /** Drive requests made while `fn` runs, folder queries (GET /files) and writes (POST) told apart. */
  const count = async (fn: () => Promise<unknown>) => {
    const before = google.calls.length;
    const r = await fn();
    const calls = google.calls.slice(before).filter((c) => c.includes("/drive/v3/files") || c.includes("/upload/drive/v3/files"));
    return { r, calls, writes: calls.filter((c) => c.startsWith("POST")) };
  };
  return { google, save, timing, count, harness };
}

beforeEach(() => clearServiceAccountTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("PAR-10250: one-query fast path into an existing sub-folder", () => {
  it("a repeat save into Assets/Social is 4 Drive requests (resolve, findSubfolder, dedupe list, upload), path fast, nothing created", async () => {
    const { google, save, timing, count } = await setup();
    expect((await save("p-a", "Assets/Social")).status).toBe("saved");
    const folders = google.files.length;
    const { r, calls, writes } = await count(() => save("p-a", "Assets/Social"));
    expect(r).toMatchObject({ status: "saved", subfolder: "Assets/Social" });
    expect(calls).toHaveLength(4);
    expect(writes).toHaveLength(1); // the upload only: no folder ensure
    expect(google.files.length).toBe(folders + 1);
    expect(uploadsOf(google.files).at(-1)!.parents).toEqual([folderAt(google.files, `${A}/Assets/Social`)!.id]);
    expect(timing().at(-1)).toMatchObject({ path: "fast", ensureMs: 0, siblingsMs: 0, driveLookups: 0 });
  });

  it("a top-level sub-folder takes the fast path too", async () => {
    const { save, timing, count } = await setup();
    await save("p-a", "Deliverables");
    const { calls } = await count(() => save("p-a", "Deliverables"));
    expect(calls).toHaveLength(4);
    expect(timing().at(-1)).toMatchObject({ path: "fast" });
  });

  it("the query is one list scoped to this company's Shared Drive, asking for every prefix of the path", async () => {
    const { google, save, count } = await setup();
    await save("p-a", "Assets/Social");
    const { calls } = await count(() => save("p-a", "Assets/Social"));
    const find = calls.filter((c) => c.startsWith("GET") && decodeURIComponent(c).includes("'subfolder'"));
    expect(find).toHaveLength(1);
    const url = decodeURIComponent(find[0]!);
    expect(url).toContain(`driveId=${DRIVE_ID}`);
    expect(url).toContain("corpora=drive");
    expect(url).toContain("trashed = false");
    expect(url.match(/key='pibEntityId'/g)).toHaveLength(2);
    expect(google.files.length).toBeGreaterThan(0);
  });

  it.each([
    ["no such sub-folder (not made yet)", "Deliverables", (_g: any) => undefined],
    ["trashed", "Assets/Social", (g: any) => { folderAt(g.files, `${A}/Assets/Social`)!.trashed = true; }],
    ["top-level folder under another parent", "Deliverables", (g: any) => { folderAt(g.files, `${A}/Deliverables`)!.parents = ["elsewhere"]; }],
    ["nested folder under another Assets", "Assets/Social", (g: any) => {
      g.files.push({ id: "other-assets", name: "Assets", mimeType: "application/vnd.google-apps.folder", parents: ["elsewhere"] });
      folderAt(g.files, `${A}/Assets/Social`)!.parents = ["other-assets"];
    }],
  ])("falls back to the full path: %s", async (_label, sub, damage) => {
    const { google, save, timing } = await setup();
    await save("p-a", "Assets/Social");
    await save("p-a", "Deliverables");
    damage(google);
    if (sub === "Deliverables" && _label.startsWith("no such")) google.files.splice(google.files.indexOf(folderAt(google.files, `${A}/Deliverables`)!), 1);
    const r = await save("p-a", sub);
    expect(r.status).toBe("saved");
    expect(timing().at(-1).path).not.toBe("fast");
  });

  it("two clients with the same Assets/Social: each save gets its own folder, never the other's", async () => {
    const { google, save } = await setup();
    await save("p-a", "Assets/Social");
    await save("p-b", "Assets/Social");
    const a = folderAt(google.files, `${A}/Assets/Social`)!.id;
    const b = folderAt(google.files, `${B}/Assets/Social`)!.id;
    expect(a).not.toBe(b);
    await save("p-b", "Assets/Social");
    await save("p-a", "Assets/Social");
    const ups = uploadsOf(google.files);
    expect(ups.map((u) => u.parents[0])).toEqual([a, b, b, a]);
  });
});

describe("PAR-11350: one broker per save, every stage timed", () => {
  it("a fast-path save reads the config once (the ensure reuses the save's broker); Drive requests stay 4", async () => {
    const { save, count, harness } = await setup();
    await save("p-a", "Assets/Social");
    const get = vi.spyOn(harness.ctx.config, "get");
    const { calls } = await count(() => save("p-a", "Assets/Social"));
    expect(calls).toHaveLength(4);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("the timing line carries every new stage and the named stages add up to totalMs (fake clock)", async () => {
    const { save, timing, google } = await setup();
    await save("p-a", "Assets/Social");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(0);
      // Every Drive request costs 100 ms on the fake clock, so the stage sum is a real number.
      vi.stubGlobal("fetch", (async (...a: Parameters<typeof google.fetchFn>) => { vi.setSystemTime(Date.now() + 100); return google.fetchFn(...a); }) as never);
      // Each async step costs wall time on a real clock; the fake clock only moves where the test moves it, so run the save and then read the line.
      await save("p-a", "Assets/Social");
    } finally {
      vi.useRealTimers();
    }
    const t = timing().at(-1);
    for (const k of ["sourceMs", "brokerMs", "factsMs", "findSubfolderMs", "upsertMs", "uploadListMs", "uploadPostMs", "uploadMs"]) expect(typeof t[k]).toBe("number");
    expect(t.uploadMs).toBe(t.uploadListMs + t.uploadPostMs);
    const sum = t.sourceMs + t.brokerMs + t.factsMs + t.resolveMs + t.findSubfolderMs + t.dedupeMs + t.uploadMs + t.upsertMs;
    expect(t.totalMs).toBeGreaterThanOrEqual(400);
    expect(Math.abs(t.totalMs - sum)).toBeLessThanOrEqual(50);
  });

  it("a hostile broker value in the tool body is ignored: ensure builds its own broker", async () => {
    const { harness } = await setup();
    const r = await driveFolderEnsure(harness.ctx, { companyId: CO, userId: null, agentId: null, role: null } as never, { entity_type: "project", entity_id: "p-a", broker: {}, timing: "x" } as never);
    expect(r).toBeTruthy();
  });
});
