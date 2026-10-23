import { generateKeyPairSync } from "node:crypto";
import { expect } from "vitest";
import type { GoogleFetch } from "../../src/drive/google-sa.js";

export const DRIVE_ID = "0ADRIVE";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
export const KEY_JSON = JSON.stringify({ type: "service_account", client_email: "drive-sa@proj.iam.gserviceaccount.com", private_key: privateKey, private_key_id: "kid1", project_id: "proj" });

export interface FakeFile { id: string; name: string; mimeType: string; parents: string[]; description?: string; appProperties?: Record<string, string>; size?: string; trashed?: boolean }

/** A tiny in-memory Google: token endpoint + the Drive v3 calls the broker makes. Records every Drive URL. */
export function fakeGoogle(opts: { member?: boolean; tokenStatus?: number; filesStatus?: number } = {}) {
  const files: FakeFile[] = [];
  const calls: string[] = [];
  let seq = 0;
  const member = opts.member ?? true;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  const view = (f: FakeFile) => ({ id: f.id, name: f.name, description: f.description, mimeType: f.mimeType, size: f.size, parents: f.parents, appProperties: f.appProperties, webViewLink: `https://drive.google.com/${f.mimeType.includes("folder") ? "drive/folders" : "file/d"}/${f.id}` });

  const fetchFn: GoogleFetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    if (u.hostname === "oauth2.googleapis.com") {
      if (opts.tokenStatus && opts.tokenStatus !== 200) return json(opts.tokenStatus, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      return json(200, { access_token: "ya29.fake", expires_in: 3600 });
    }
    calls.push(`${method} ${u.pathname}${u.search}`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ya29.fake");
    if (opts.filesStatus) return json(opts.filesStatus, { error: { message: opts.filesStatus === 403 ? "The caller does not have permission" : "boom" } });

    if (u.pathname.startsWith("/drive/v3/drives/")) {
      if (!member) return json(404, { error: { message: "Shared drive not found" } });
      return json(200, { id: DRIVE_ID, name: "Partners in Biz", capabilities: { canAddChildren: true } });
    }
    if (u.pathname === "/drive/v3/files" && method === "GET") {
      expect(u.searchParams.get("supportsAllDrives")).toBe("true");
      expect(u.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      expect(u.searchParams.get("corpora")).toBe("drive");
      expect(u.searchParams.get("driveId")).toBe(DRIVE_ID);
      const q = u.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      const type = /key='pibEntityType' and value='([^']*)'/.exec(q)?.[1];
      const id = /key='pibEntityId' and value='([^']*)'/.exec(q)?.[1];
      const folderOnly = q.includes("vnd.google-apps.folder");
      const hits = files.filter(
        (f) => !f.trashed && (!folderOnly || f.mimeType.includes("folder")) && (!parent || f.parents.includes(parent)) && (name === undefined || f.name === name) &&
          (type === undefined || f.appProperties?.pibEntityType === type) && (id === undefined || f.appProperties?.pibEntityId === id),
      );
      return json(200, { files: hits.map(view) });
    }
    if (u.pathname === "/drive/v3/files" && method === "POST") {
      expect(u.searchParams.get("supportsAllDrives")).toBe("true");
      const body = JSON.parse(init.body as string);
      const f: FakeFile = { id: `f${++seq}`, name: body.name, mimeType: body.mimeType, parents: body.parents, description: body.description, appProperties: body.appProperties };
      files.push(f);
      return json(200, view(f));
    }
    const patch = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (patch && method === "PATCH") {
      const f = files.find((x) => x.id === patch[1])!;
      const body = JSON.parse(init.body as string);
      f.description = body.description;
      f.appProperties = { ...f.appProperties, ...body.appProperties };
      return json(200, view(f));
    }
    if (u.pathname === "/upload/drive/v3/files" && method === "POST") {
      expect(u.searchParams.get("supportsAllDrives")).toBe("true");
      expect(u.searchParams.get("uploadType")).toBe("multipart");
      expect((init.headers as Record<string, string>)["Content-Type"]).toMatch(/^multipart\/related; boundary=/);
      const raw = Buffer.from(init.body as Buffer).toString("latin1");
      const metaJson = raw.slice(raw.indexOf("{"), raw.indexOf("}\r\n--") + 1);
      const meta = JSON.parse(metaJson);
      const bodyStart = raw.indexOf("\r\n\r\n", raw.indexOf("Content-Type", raw.indexOf("}\r\n--"))) + 4;
      const bodyEnd = raw.lastIndexOf("\r\n--");
      const bytes = Buffer.from(raw.slice(bodyStart, bodyEnd), "latin1");
      const f: FakeFile = { id: `f${++seq}`, name: meta.name, mimeType: "application/octet-stream", parents: meta.parents, appProperties: meta.appProperties, size: String(bytes.byteLength) };
      files.push(f);
      return json(200, view(f));
    }
    return json(404, { error: { message: `unhandled ${method} ${u.pathname}` } });
  };
  return { fetchFn, files, calls };
}

