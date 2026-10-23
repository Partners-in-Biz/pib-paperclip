import { generateKeyPairSync } from "node:crypto";
import { expect } from "vitest";
import type { GoogleFetch } from "../../src/drive/google-sa.js";

export const DRIVE_ID = "0ADRIVE";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
export const KEY_JSON = JSON.stringify({ type: "service_account", client_email: "drive-sa@proj.iam.gserviceaccount.com", private_key: privateKey, private_key_id: "kid1", project_id: "proj" });

export interface FakeFile { id: string; name: string; mimeType: string; parents: string[]; description?: string; appProperties?: Record<string, string>; size?: string; trashed?: boolean }

export interface FakeGoogleOptions {
  member?: boolean;
  tokenStatus?: number;
  /** Fails every Drive call with this status (the token endpoint still answers). */
  filesStatus?: number;
  /** Fails only the file upload (multipart POST) with this status; folder calls still work. */
  uploadStatus?: number;
  /** The Shared Drive the list calls must be scoped to (default DRIVE_ID). */
  driveId?: string;
}

/** A write that fails once. `skip` lets that many matching writes through first; `applyFirst` creates the folder and then answers with the error (a response lost after the write). */
export interface FakeFault { method: "POST" | "PATCH"; status: number; skip?: number; applyFirst?: boolean }

/** True for a folder. */
export const isFolder = (f: FakeFile) => f.mimeType.includes("folder");

/** The path of a folder or file below the Shared Drive root, from names and parents: "Acme (Jo)/Site/01 Briefs". */
export function pathOf(files: FakeFile[], file: FakeFile, driveId = DRIVE_ID): string {
  const names: string[] = [file.name];
  let parent = file.parents[0];
  while (parent && parent !== driveId) {
    const up = files.find((f) => f.id === parent);
    if (!up) break;
    names.unshift(up.name);
    parent = up.parents[0];
  }
  return names.join("/");
}

/** Every folder's path below the Shared Drive root, sorted. */
export function folderPaths(files: FakeFile[], driveId = DRIVE_ID): string[] {
  return files.filter(isFolder).map((f) => pathOf(files, f, driveId)).sort();
}

/** The files that are not folders (the uploads). */
export const uploadsOf = (files: FakeFile[]) => files.filter((f) => !isFolder(f));

/** A tiny in-memory Google: token endpoint + the Drive v3 calls the broker makes. Records every Drive URL. */
export function fakeGoogle(opts: FakeGoogleOptions = {}) {
  const files: FakeFile[] = [];
  const calls: string[] = [];
  const faults: Array<Required<FakeFault>> = [];
  let seq = 0;
  const member = opts.member ?? true;
  const driveId = opts.driveId ?? DRIVE_ID;
  const takeFault = (method: string): Required<FakeFault> | undefined => {
    const fault = faults.find((x) => x.method === method);
    if (!fault) return undefined;
    if (fault.skip > 0) {
      fault.skip--;
      return undefined;
    }
    faults.splice(faults.indexOf(fault), 1);
    return fault;
  };
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
      expect(u.searchParams.get("driveId")).toBe(driveId);
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
      const fault = takeFault("POST");
      if (fault && !fault.applyFirst) return json(fault.status, { error: { message: "injected failure" } });
      const f: FakeFile = { id: `f${++seq}`, name: body.name, mimeType: body.mimeType, parents: body.parents, description: body.description, appProperties: body.appProperties };
      files.push(f);
      if (fault) return json(fault.status, { error: { message: "injected failure after the write" } });
      return json(200, view(f));
    }
    const patch = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (patch && method === "PATCH") {
      const f = files.find((x) => x.id === patch[1])!;
      const body = JSON.parse(init.body as string);
      const fault = takeFault("PATCH");
      if (fault && !fault.applyFirst) return json(fault.status, { error: { message: "injected failure" } });
      if (body.description !== undefined) f.description = body.description;
      f.appProperties = { ...f.appProperties, ...body.appProperties };
      if (fault) return json(fault.status, { error: { message: "injected failure after the write" } });
      return json(200, view(f));
    }
    if (u.pathname === "/upload/drive/v3/files" && method === "POST") {
      if (opts.uploadStatus) return json(opts.uploadStatus, { error: { message: opts.uploadStatus === 401 ? "Invalid Credentials" : "upload boom" } });
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
  /** Makes the next matching write fail (see FakeFault). */
  const failNext = (fault: FakeFault) => void faults.push({ skip: 0, applyFirst: false, ...fault });
  return { fetchFn, files, calls, failNext };
}

