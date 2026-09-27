/**
 * Learned playbook data. The service talks to this interface; the SQL
 * version wraps db.ts and the tests use an in-memory copy with the same
 * semantics (version guard, one draft per measured optimization, pending
 * claim).
 */
import * as db from "../db.js";

export interface PlaybookStore {
  findPlaybook(companyId: string, scopeKey: string): Promise<db.Playbook | null>;
  getPlaybook(companyId: string, id: string): Promise<db.Playbook | null>;
  insertPlaybook(p: Parameters<typeof db.insertPlaybook>[1]): Promise<boolean>;
  setClientName(companyId: string, id: string, clientName: string): Promise<void>;
  /** Replace the markdown while it is still at `expectedVersion`; bumps the version. */
  savePlaybook(companyId: string, id: string, expectedVersion: number, playbook: string): Promise<boolean>;
  insertVersion(v: Parameters<typeof db.insertPlaybookVersion>[1]): Promise<void>;
  listVersions(companyId: string, playbookId: string, limit: number): Promise<db.PlaybookVersion[]>;
  /** False when a drafted (measured) change for the same optimization exists. */
  insertChange(c: db.NewPlaybookChange): Promise<boolean>;
  getChange(companyId: string, id: string): Promise<db.PlaybookChange | null>;
  listChanges(companyId: string, playbookId: string, status?: db.PlaybookChangeStatus): Promise<db.PlaybookChange[]>;
  pendingForSprint(companyId: string, sprintId: string): Promise<db.PlaybookChange[]>;
  /** With `onlyPending`, applies only while the change is pending. */
  updateChange(companyId: string, id: string, patch: db.PlaybookChangePatch, onlyPending: boolean): Promise<boolean>;
}

export function sqlPlaybookStore(sql: db.SeoDb): PlaybookStore {
  return {
    findPlaybook: (companyId, scopeKey) => db.findPlaybook(sql, companyId, scopeKey),
    getPlaybook: (companyId, id) => db.getPlaybook(sql, companyId, id),
    insertPlaybook: (p) => db.insertPlaybook(sql, p),
    setClientName: (companyId, id, clientName) => db.setPlaybookClientName(sql, companyId, id, clientName),
    savePlaybook: (companyId, id, expectedVersion, playbook) => db.savePlaybook(sql, companyId, id, expectedVersion, playbook),
    insertVersion: (v) => db.insertPlaybookVersion(sql, v),
    listVersions: (companyId, playbookId, limit) => db.listPlaybookVersions(sql, companyId, playbookId, limit),
    insertChange: (c) => db.insertPlaybookChange(sql, c),
    getChange: (companyId, id) => db.getPlaybookChange(sql, companyId, id),
    listChanges: (companyId, playbookId, status) => db.listPlaybookChanges(sql, companyId, playbookId, { status }),
    pendingForSprint: (companyId, sprintId) => db.pendingPlaybookChangesForSprint(sql, companyId, sprintId),
    updateChange: (companyId, id, patch, onlyPending) => db.updatePlaybookChange(sql, companyId, id, patch, onlyPending),
  };
}
