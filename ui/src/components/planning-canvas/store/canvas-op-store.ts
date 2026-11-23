import type {
  PlanningCanvasItem,
  PlanningCanvasItemType,
  PlanningCanvasItemsRead,
  PlanningCanvasOp,
  PlanningCanvasOpBatch,
  PlanningCanvasOpBatchResponse,
  PlanningCanvasOpResult,
} from "@paperclipai/shared";
import { PLANNING_CANVAS_LIMITS } from "@paperclipai/shared";
import { diffTableOps, isTableData } from "@/components/planning-canvas/store/table-ops";

/**
 * Planning Canvas op store (PAR-13934, plan PAR-13925 B.3, B.4, F).
 *
 * - `base` is what the server has (fields, `version`, tombstone); `view` is
 *   what this tab shows, with its own edits applied optimistically.
 * - A flush runs at most `batchDelayMs` after the first unsent edit. It diffs
 *   `base` against `view` into ops and sends one batch. One batch is in flight
 *   at a time; a retry resends the same body and `clientBatchId`, so a lost
 *   response replays the stored results instead of conflicting with itself.
 * - Content updates carry `baseVersion`. The server conflicts only on a field
 *   we set that someone else changed: other fields are resent on the new base,
 *   and a text field keeps our text as a draft (Keep mine, Keep theirs, Copy to
 *   new node), so typed text is never lost.
 * - Undo and redo hold this user's own edits (200 groups). An undo whose
 *   target someone else changed since is skipped.
 */

export type ItemFields = Record<string, unknown>;
export interface StoreItem {
  itemType: PlanningCanvasItemType;
  fields: ItemFields;
}
interface BaseItem extends StoreItem {
  version: number;
  deleted: boolean;
  deletedWithKey: string | null;
}

export type SaveState = "saved" | "saving" | "offline" | "failed";
export type DraftField = "title" | "content" | "label" | "markdown";

export interface ConflictDraft {
  id: string;
  key: string;
  field: DraftField;
  mine: string;
  theirs: string;
  /** `deleted`: someone deleted the item while this tab edited it. */
  reason: "conflict" | "deleted";
  /** The item as this tab had it, for Keep mine after a delete and for Copy to new node. */
  snapshot: StoreItem;
}

export interface OpStoreSnapshot {
  saveState: SaveState;
  canUndo: boolean;
  canRedo: boolean;
  drafts: ConflictDraft[];
}

export interface OpStoreTransport {
  send(batch: PlanningCanvasOpBatch): Promise<PlanningCanvasOpBatchResponse>;
  readSince(revision: number): Promise<PlanningCanvasItemsRead>;
  sendKeepalive?(batch: PlanningCanvasOpBatch): void;
}

export interface OpStoreOptions {
  transport: OpStoreTransport;
  newId?: () => string;
  batchDelayMs?: number;
  undoDepth?: number;
  undoGroupIdleMs?: number;
  /** sessionStorage-like store for the undo stacks (undo survives a reload in the session). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  storageKey?: string;
  onNotice?: (message: string) => void;
  /** The server could not take the batch (not a network problem): reload the board. */
  onFatal?: (error: unknown) => void;
  /** The server purged history past our revision: reload the board. */
  onResync?: () => void;
}

interface UndoEntry {
  key: string;
  itemType: PlanningCanvasItemType;
  before: ItemFields | null;
  after: ItemFields | null;
}
type UndoGroup = UndoEntry[];

interface Inflight {
  batch: PlanningCanvasOpBatch;
  /** Per key, the view fields the batch was built from. */
  sent: Map<string, ItemFields>;
  attempt: number;
}

const TEXT_FIELDS = new Set(["title", "content", "label"]);
const NODE_FIRST: PlanningCanvasItemType[] = ["node", "connector", "stroke"];
const UNDO_STORAGE_MAX = 2_000_000;

export function sameValue(a: unknown, b: unknown) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** The item key an op is about (`add` carries it inside the item). */
export function keyOf(op: PlanningCanvasOp) {
  return op.op === "add" ? op.item.key : op.key;
}

function changedFields(from: ItemFields, to: ItemFields) {
  return Object.keys(to).filter((field) => !sameValue(from[field], to[field]));
}

/** Network drops and 408/429/5xx retry; anything else is a refusal. */
export function isRetryableError(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return true;
  return status === 408 || status === 429 || status >= 500;
}

export function backoffMs(attempt: number) {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function draftValue(item: StoreItem, field: DraftField): string {
  if (field === "markdown") return String((item.fields.data as { markdown?: unknown } | undefined)?.markdown ?? "");
  return String(item.fields[field] ?? "");
}

function textFieldsOf(item: StoreItem, fields: string[]): DraftField[] {
  const out: DraftField[] = [];
  for (const field of fields) {
    if (TEXT_FIELDS.has(field)) out.push(field as DraftField);
    else if (field === "data" && item.fields.kind === "markdown") out.push("markdown");
  }
  return out;
}

export class CanvasOpStore {
  private base = new Map<string, BaseItem>();
  private view = new Map<string, StoreItem>();
  /** baseVersion to send for keys whose base moved under unsent local edits. */
  private pinned = new Map<string, number>();
  private dirty = new Set<string>();
  private firstDirtyAt: number | null = null;
  private revision = 0;
  private inflight: Inflight | null = null;
  private catchingUp = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private groupTimer: ReturnType<typeof setTimeout> | null = null;
  private open: Map<string, UndoEntry> | null = null;
  private undoStack: UndoGroup[] = [];
  private redoStack: UndoGroup[] = [];
  private drafts: ConflictDraft[] = [];
  private saveState: SaveState = "saved";
  private snapshot: OpStoreSnapshot;
  private listeners = new Set<() => void>();
  private viewListeners = new Set<(keys: string[]) => void>();
  private disposed = false;
  private closing = false;
  /** An add met an item we did not know: re-read everything once. */
  private unknownKeys = false;
  private readonly opts: Required<Pick<OpStoreOptions, "batchDelayMs" | "undoDepth" | "undoGroupIdleMs" | "newId">> & OpStoreOptions;

  constructor(options: OpStoreOptions) {
    this.opts = {
      batchDelayMs: 250,
      undoDepth: 200,
      undoGroupIdleMs: 800,
      newId: () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      ...options,
    };
    this.snapshot = this.makeSnapshot();
  }

  // ---- reading --------------------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Keys whose view the store changed (remote edits, undo, conflicts); local edits are not echoed. */
  subscribeView(listener: (keys: string[]) => void) {
    this.viewListeners.add(listener);
    return () => {
      this.viewListeners.delete(listener);
    };
  }

  getSnapshot = () => this.snapshot;
  getItem(key: string) {
    return this.view.get(key);
  }
  getItems() {
    return this.view;
  }
  getRevision() {
    return this.revision;
  }
  hasUnsaved() {
    return this.dirty.size > 0 || this.inflight !== null;
  }

  // ---- loading --------------------------------------------------------------

  /** Replace everything with a full board read. Unsent edits are dropped; undo stacks come back from storage. */
  load(read: { revision: number; items: PlanningCanvasItem[] }) {
    this.base.clear();
    this.view.clear();
    this.pinned.clear();
    this.dirty.clear();
    this.firstDirtyAt = null;
    for (const item of read.items) {
      this.base.set(item.key, this.baseOf(item));
      if (!item.deletedAt) this.view.set(item.key, { itemType: item.itemType, fields: { ...(item.data as unknown as ItemFields) } });
    }
    this.revision = read.revision;
    this.restoreUndo();
    this.drafts = [];
    this.saveState = "saved";
    this.emit();
  }

  private baseOf(item: PlanningCanvasItem): BaseItem {
    return {
      itemType: item.itemType,
      fields: { ...(item.data as unknown as ItemFields) },
      version: item.version,
      deleted: item.deletedAt !== null,
      deletedWithKey: item.deletedWithKey,
    };
  }

  // ---- local edits ----------------------------------------------------------

  /** This tab's edits. `item: null` deletes. Unchanged items are ignored. */
  applyLocal(changes: Array<{ key: string; item: StoreItem | null }>) {
    let changed = false;
    for (const { key, item } of changes) {
      const before = this.view.get(key) ?? null;
      if (!item && !before) continue;
      if (item && before && before.itemType === item.itemType && changedFields(before.fields, item.fields).length === 0) continue;
      this.record(key, (item ?? before)!.itemType, before?.fields ?? null, item?.fields ?? null);
      this.setView(key, item);
      changed = true;
    }
    if (!changed) return;
    this.restartGroupTimer();
    this.scheduleFlush();
    this.emit();
  }

  private setView(key: string, item: StoreItem | null) {
    if (item) this.view.set(key, { itemType: item.itemType, fields: { ...item.fields } });
    else this.view.delete(key);
    this.markDirty(key);
  }

  private markDirty(key: string) {
    this.dirty.add(key);
    this.firstDirtyAt ??= Date.now();
  }

  // ---- undo and redo --------------------------------------------------------

  private record(key: string, itemType: PlanningCanvasItemType, before: ItemFields | null, after: ItemFields | null) {
    this.open ??= new Map();
    const entry = this.open.get(key);
    if (entry) entry.after = after ? { ...after } : null;
    else this.open.set(key, { key, itemType, before: before ? { ...before } : null, after: after ? { ...after } : null });
  }

  private restartGroupTimer() {
    if (this.groupTimer) clearTimeout(this.groupTimer);
    this.groupTimer = setTimeout(() => this.checkpoint(), this.opts.undoGroupIdleMs);
  }

  /** Close the open undo group: the next edit starts a new one (a drag, a command, a burst of typing). */
  checkpoint() {
    if (this.groupTimer) clearTimeout(this.groupTimer);
    this.groupTimer = null;
    const group = this.open ? [...this.open.values()].filter((entry) => !sameValue(entry.before, entry.after)) : [];
    this.open = null;
    if (group.length === 0) return;
    this.undoStack.push(group);
    if (this.undoStack.length > this.opts.undoDepth) this.undoStack.splice(0, this.undoStack.length - this.opts.undoDepth);
    this.redoStack = [];
    this.persistUndo();
    this.emit();
  }

  undo() {
    this.checkpoint();
    return this.travel(this.undoStack, this.redoStack, "Undo");
  }

  redo() {
    this.checkpoint();
    return this.travel(this.redoStack, this.undoStack, "Redo");
  }

  /** Revert one group to its `before`, skipping entries someone else changed since. */
  private travel(from: UndoGroup[], to: UndoGroup[], label: string) {
    const group = from.pop();
    if (!group) return { applied: 0, skipped: 0 };
    const inverse: UndoGroup = [];
    const touched: string[] = [];
    let skipped = 0;
    for (const entry of group) {
      const current = this.view.get(entry.key)?.fields ?? null;
      if (!this.stillOurs(entry, current)) {
        skipped += 1;
        continue;
      }
      let target: ItemFields | null = null;
      if (entry.before) {
        target = { ...(current ?? entry.before) };
        for (const field of Object.keys({ ...entry.before, ...(entry.after ?? {}) })) {
          if (field in entry.before) target[field] = entry.before[field];
          else delete target[field];
        }
      }
      inverse.push({ key: entry.key, itemType: entry.itemType, before: current, after: target });
      this.setView(entry.key, target ? { itemType: entry.itemType, fields: target } : null);
      touched.push(entry.key);
    }
    if (inverse.length > 0) to.push(inverse);
    this.persistUndo();
    if (skipped > 0) {
      this.opts.onNotice?.(
        inverse.length === 0
          ? `${label} skipped: someone else changed this since.`
          : `${label} skipped ${skipped} item${skipped === 1 ? "" : "s"} someone else changed since.`,
      );
    }
    if (touched.length > 0) {
      this.emitView(touched);
      this.scheduleFlush();
    }
    this.emit();
    return { applied: inverse.length, skipped };
  }

  /** True when nobody else changed the fields this entry set (own later edits are undone first, in order). */
  private stillOurs(entry: UndoEntry, current: ItemFields | null) {
    if (!entry.after) return current === null;
    if (!current) return false;
    const fields = entry.before ? changedFields(entry.before, entry.after) : Object.keys(entry.after);
    return fields.every((field) => sameValue(current[field], entry.after![field]));
  }

  private persistUndo() {
    const { storage, storageKey } = this.opts;
    if (!storage || !storageKey) return;
    try {
      const json = JSON.stringify({ undo: this.undoStack, redo: this.redoStack });
      storage.setItem(storageKey, json.length > UNDO_STORAGE_MAX ? JSON.stringify({ undo: [], redo: [] }) : json);
    } catch {
      // Storage full or blocked: undo still works for this page.
    }
  }

  private restoreUndo() {
    this.open = null;
    const { storage, storageKey } = this.opts;
    if (!storage || !storageKey) return;
    try {
      const parsed = JSON.parse(storage.getItem(storageKey) ?? "null") as { undo?: UndoGroup[]; redo?: UndoGroup[] } | null;
      this.undoStack = Array.isArray(parsed?.undo) ? parsed.undo.slice(-this.opts.undoDepth) : [];
      this.redoStack = Array.isArray(parsed?.redo) ? parsed.redo.slice(-this.opts.undoDepth) : [];
    } catch {
      this.undoStack = [];
      this.redoStack = [];
    }
  }

  // ---- drafts ---------------------------------------------------------------

  resolveDraft(id: string, choice: "mine" | "theirs" | "copy") {
    const draft = this.drafts.find((candidate) => candidate.id === id);
    if (!draft) return null;
    this.drafts = this.drafts.filter((candidate) => candidate.id !== id);
    let newKey: string | null = null;
    if (choice === "mine") {
      const current = this.view.get(draft.key) ?? draft.snapshot;
      const fields = { ...current.fields };
      if (draft.field === "markdown") fields.data = { ...((fields.data as object | undefined) ?? {}), markdown: draft.mine };
      else fields[draft.field] = draft.mine;
      this.checkpoint();
      this.applyLocal([{ key: draft.key, item: { itemType: current.itemType, fields } }]);
      this.checkpoint();
      this.emitView([draft.key]);
    } else if (choice === "copy") {
      newKey = `sticky_${this.opts.newId().replace(/-/g, "").slice(0, 8)}`;
      this.checkpoint();
      this.applyLocal([{ key: newKey, item: { itemType: "node", fields: this.copyFields(draft) } }]);
      this.checkpoint();
      this.emitView([newKey]);
    }
    this.emit();
    return newKey;
  }

  /** A sticky beside the item (or beside the connector's source node) holding this tab's text. */
  private copyFields(draft: ConflictDraft): ItemFields {
    const source = draft.snapshot.itemType === "node"
      ? draft.snapshot.fields
      : (this.view.get(String(draft.snapshot.fields.fromKey))?.fields ?? { x: 0, y: 0, width: 0 });
    const x = Number(source.x ?? 0) + Number(source.width ?? 0) + 24;
    const y = Number(source.y ?? 0);
    const title = draft.field === "title" ? draft.mine : `${String(draft.snapshot.fields.title ?? "") || "Untitled"} (my version)`;
    return {
      kind: "sticky",
      x,
      y,
      width: 260,
      height: 180,
      zIndex: Number(source.zIndex ?? 1) + 1,
      color: "amber",
      title: title.slice(0, 300),
      content: draft.field === "title" ? "" : draft.mine.slice(0, 20_000),
    };
  }

  // ---- sending --------------------------------------------------------------

  private scheduleFlush() {
    if (this.disposed || this.flushTimer || this.inflight || this.retryTimer || this.catchingUp) return;
    if (this.dirty.size === 0) return;
    if (this.saveState === "saved" || this.saveState === "failed") this.setSaveState("saving");
    const wait = Math.max(0, (this.firstDirtyAt ?? Date.now()) + this.opts.batchDelayMs - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
  }

  /** Send now (also used on board switch). Resolves when this batch settles. */
  async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.inflight || this.catchingUp || this.disposed) return;
    const built = this.buildBatch();
    if (!built) {
      this.setSaveState("saved");
      return;
    }
    this.inflight = { ...built, attempt: 0 };
    this.setSaveState("saving");
    await this.sendInflight();
  }

  private buildBatch(): { batch: PlanningCanvasOpBatch; sent: Map<string, ItemFields> } | null {
    const buckets: PlanningCanvasOp[][] = [[], [], [], [], [], []];
    const sent = new Map<string, ItemFields>();
    const keys = [...this.dirty];
    this.dirty.clear();
    this.firstDirtyAt = null;
    for (const key of keys) {
      const view = this.view.get(key);
      const base = this.base.get(key);
      const rank = NODE_FIRST.indexOf((view ?? base)?.itemType ?? "node") === 0 ? 0 : 1;
      if (view) sent.set(key, { ...view.fields });
      if (view && !base) {
        buckets[rank * 2]!.push({ op: "add", item: { itemType: view.itemType, key, ...view.fields } as never });
      } else if (view && base) {
        if (base.deleted) buckets[rank * 2]!.push({ op: "restore", key });
        const fields = changedFields(base.fields, view.fields);
        if (fields.length === 0) continue;
        const baseVersion = this.pinned.get(key) ?? base.version;
        const set: ItemFields = {};
        for (const field of fields) set[field] = view.fields[field];
        const tableOps = "data" in set && view.fields.kind === "table" && isTableData(base.fields.data) && isTableData(set.data)
          ? diffTableOps(key, base.fields.data, set.data)
          : null;
        if (tableOps) delete set.data;
        if (Object.keys(set).length > 0) buckets[rank * 2 + 1]!.push({ op: "update", key, baseVersion, set });
        if (tableOps) buckets[rank * 2 + 1]!.push(...tableOps);
      } else if (!view && base && !base.deleted) {
        buckets[rank === 0 ? 5 : 4]!.push({ op: "delete", key });
      }
    }
    // Order: node adds, node updates, other adds, other updates, other deletes, node deletes.
    let ops = buckets.flat();
    if (ops.length > PLANNING_CANVAS_LIMITS.opsPerBatchMax) {
      // Nodes come first, so a cut never sends a connector without its nodes. An item whose ops were cut goes whole next time.
      const cutKeys = new Set(ops.slice(PLANNING_CANVAS_LIMITS.opsPerBatchMax).map(keyOf));
      ops = ops.slice(0, PLANNING_CANVAS_LIMITS.opsPerBatchMax).filter((op) => !cutKeys.has(keyOf(op)));
      for (const key of cutKeys) {
        this.markDirty(key);
        sent.delete(key);
      }
    }
    if (ops.length === 0) return null;
    return { batch: { ops, clientBatchId: this.opts.newId() }, sent };
  }

  private async sendInflight() {
    const inflight = this.inflight;
    if (!inflight || this.disposed) return;
    let response: PlanningCanvasOpBatchResponse;
    try {
      response = await this.opts.transport.send(inflight.batch);
    } catch (error) {
      if (this.disposed || this.inflight !== inflight) return;
      if (!isRetryableError(error)) {
        this.inflight = null;
        if (this.closing) return this.dispose();
        this.setSaveState("failed");
        this.opts.onFatal?.(error);
        return;
      }
      inflight.attempt += 1;
      this.setSaveState("offline");
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.sendInflight();
      }, backoffMs(inflight.attempt) + Math.floor(Math.random() * 250));
      return;
    }
    if (this.disposed || this.inflight !== inflight) return;
    this.inflight = null;
    const before = this.revision;
    this.unknownKeys = false;
    const touched = this.applyResults(inflight, response.results);
    if (touched.length > 0) this.emitView(touched);
    if (this.unknownKeys) await this.catchUp(0);
    else if (!response.replayed && response.revision === before + 1) this.revision = response.revision;
    else if (response.revision > before) await this.catchUp(before);
    if (this.closing && !this.hasUnsaved()) return this.dispose();
    this.setSaveState(this.dirty.size > 0 ? "saving" : "saved");
    this.scheduleFlush();
    this.emit();
  }

  /** Board switch or unmount: stop notifying, but keep sending until everything is saved. */
  close() {
    this.checkpoint();
    this.closing = true;
    if (!this.hasUnsaved()) return this.dispose();
    void this.flush();
  }

  /** Undo a `close()` (React StrictMode mounts effects twice). */
  reopen() {
    this.closing = false;
    if (!this.disposed) return;
    this.disposed = false;
    this.scheduleFlush();
  }

  /** Retry a waiting batch now (the browser came back online). */
  retryNow() {
    if (!this.retryTimer || !this.inflight) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.sendInflight();
  }

  /** Best effort on `beforeunload`: the in-flight batch (same id) and everything unsent. */
  flushKeepalive() {
    const send = this.opts.transport.sendKeepalive;
    if (!send) return;
    if (this.inflight) send(this.inflight.batch);
    const built = this.buildBatch();
    if (built) send(built.batch);
  }

  // ---- results --------------------------------------------------------------

  private applyResults(inflight: Inflight, results: PlanningCanvasOpResult[]) {
    const touched = new Set<string>();
    inflight.batch.ops.forEach((op, index) => {
      const result = results[index];
      if (!result) return this.markDirty(keyOf(op));
      if (result.status === "applied") this.applyApplied(op, result.version, inflight.sent.get(keyOf(op)), touched);
      else if (result.status === "conflict") this.applyConflict(op, result.current, result.conflictingFields, touched);
      else this.applyRejected(op, result.reason, touched);
    });
    // Edits made while the batch was out go in the next one.
    for (const key of inflight.sent.keys()) {
      const view = this.view.get(key);
      const base = this.base.get(key);
      if (view ? !base || base.deleted || changedFields(base.fields, view.fields).length > 0 : base && !base.deleted) this.markDirty(key);
    }
    return [...touched];
  }

  private applyApplied(op: PlanningCanvasOp, version: number, sent: ItemFields | undefined, touched: Set<string>) {
    if (op.op === "add") {
      const { itemType, key, ...fields } = op.item as unknown as { itemType: PlanningCanvasItemType; key: string } & ItemFields;
      this.base.set(key, { itemType, fields, version, deleted: false, deletedWithKey: null });
      return;
    }
    const base = this.base.get(op.key);
    switch (op.op) {
      case "update":
        if (base) {
          base.fields = { ...base.fields, ...op.set };
          base.version = version;
        }
        this.pinned.delete(op.key);
        return;
      case "delete":
        if (base) base.deleted = true;
        if (base?.itemType === "node") this.cascade(op.key, true, touched);
        return;
      case "restore":
        if (base) {
          base.deleted = false;
          base.deletedWithKey = null;
          base.version = version;
        }
        if (base?.itemType === "node") this.cascade(op.key, false, touched);
        return;
      default:
        if (base) {
          base.fields = { ...base.fields, data: sent?.data ?? base.fields.data };
          base.version = version;
        }
        this.pinned.delete(op.key);
    }
  }

  /** The server takes a node's connectors along on delete and brings them back on restore. */
  private cascade(nodeKey: string, deleting: boolean, touched: Set<string>) {
    for (const [key, item] of this.base) {
      if (item.itemType !== "connector") continue;
      const { fromKey, toKey } = item.fields as { fromKey?: string; toKey?: string };
      if (fromKey !== nodeKey && toKey !== nodeKey) continue;
      if (deleting && !item.deleted) {
        item.deleted = true;
        item.deletedWithKey = nodeKey;
        if (this.view.delete(key)) touched.add(key);
      } else if (!deleting && item.deleted && item.deletedWithKey === nodeKey) {
        const other = fromKey === nodeKey ? toKey : fromKey;
        if (other !== nodeKey && !this.isLiveNode(other)) continue;
        item.deleted = false;
        item.deletedWithKey = null;
        if (!this.view.has(key)) {
          this.view.set(key, { itemType: item.itemType, fields: { ...item.fields } });
          touched.add(key);
        }
      }
    }
  }

  private isLiveNode(key: string | undefined) {
    const base = key ? this.base.get(key) : undefined;
    return !!base && base.itemType === "node" && !base.deleted;
  }

  private applyConflict(op: PlanningCanvasOp, current: PlanningCanvasItem, conflicting: string[], touched: Set<string>) {
    const key = keyOf(op);
    const old = this.base.get(key);
    this.base.set(key, this.baseOf(current));
    this.pinned.delete(key);
    const view = this.view.get(key);
    if (!view || current.deletedAt) return this.markDirty(key);
    const theirs: StoreItem = { itemType: current.itemType, fields: { ...(current.data as unknown as ItemFields) } };
    // Fields we did not change take theirs; fields we changed stay ours.
    for (const field of Object.keys(theirs.fields)) {
      if (!old || sameValue(view.fields[field], old.fields[field])) view.fields[field] = theirs.fields[field];
    }
    if (op.op.startsWith("table.")) {
      // A row or column we edited is gone: take the server's table.
      view.fields = { ...view.fields, data: theirs.fields.data };
      touched.add(key);
      this.opts.onNotice?.("A table row or column you edited was removed by someone else.");
      return;
    }
    const next = { ...view.fields };
    for (const field of textFieldsOf(view, conflicting)) {
      const mine = draftValue(view, field);
      if (mine !== draftValue(theirs, field)) this.addDraft(key, field, view, theirs, "conflict");
      if (field === "markdown") next.data = theirs.fields.data;
      else next[field] = theirs.fields[field];
    }
    // Fields nobody else touched keep ours and go again on the new base; so do our non-text fields.
    view.fields = next;
    touched.add(key);
    this.markDirty(key);
  }

  private applyRejected(op: PlanningCanvasOp, reason: string, touched: Set<string>) {
    const key = keyOf(op);
    const base = this.base.get(key);
    if ((op.op === "delete" && reason === "deleted") || (op.op === "restore" && reason === "not_deleted")) {
      if (base) base.deleted = op.op === "delete";
      return;
    }
    const view = this.view.get(key);
    if (op.op === "add" && reason === "already_exists") {
      // Someone (or an earlier page of ours) has this key: learn it, then send our fields against it.
      this.unknownKeys = true;
      return;
    }
    if (reason === "deleted" || reason === "not_found") {
      if (view && base) {
        for (const field of textFieldsOf(view, changedFields(base.fields, view.fields))) this.addDraft(key, field, view, null, "deleted");
      }
      if (base) base.deleted = true;
      else this.base.delete(key);
      if (this.view.delete(key)) touched.add(key);
      this.opts.onNotice?.("An item you edited was deleted by someone else.");
      return;
    }
    // Anything else: the server will not take it; show what it has.
    if (base && !base.deleted) this.view.set(key, { itemType: base.itemType, fields: { ...base.fields } });
    else this.view.delete(key);
    touched.add(key);
    this.opts.onNotice?.(`A change could not be saved (${reason.replace(/_/g, " ")}).`);
  }

  private addDraft(key: string, field: DraftField, mine: StoreItem, theirs: StoreItem | null, reason: ConflictDraft["reason"]) {
    this.drafts = [
      ...this.drafts.filter((draft) => !(draft.key === key && draft.field === field)),
      {
        id: this.opts.newId(),
        key,
        field,
        mine: draftValue(mine, field),
        theirs: theirs ? draftValue(theirs, field) : "",
        reason,
        snapshot: { itemType: mine.itemType, fields: { ...mine.fields } },
      },
    ];
  }

  // ---- remote changes -------------------------------------------------------

  /** Pull what others wrote since `since` and merge it under our unsent edits. */
  async catchUp(since = this.revision) {
    if (this.catchingUp || this.disposed || this.inflight) return;
    this.catchingUp = true;
    try {
      const read = await this.opts.transport.readSince(since);
      if (this.disposed) return;
      if (read.resync) {
        this.opts.onResync?.();
        return;
      }
      this.mergeRemote(read.items);
      this.revision = Math.max(this.revision, read.revision);
    } catch {
      // The next batch or focus tries again.
    } finally {
      this.catchingUp = false;
      this.scheduleFlush();
    }
  }

  mergeRemote(items: PlanningCanvasItem[]) {
    const touched: string[] = [];
    for (const item of items) {
      const old = this.base.get(item.key);
      const next = this.baseOf(item);
      if (old && old.version === next.version && old.deleted === next.deleted && changedFields(old.fields, next.fields).length === 0) continue;
      const view = this.view.get(item.key);
      const ownEdits = this.inflight?.sent.has(item.key) || this.dirty.has(item.key);
      this.base.set(item.key, next);
      if (!ownEdits || !view) {
        if (next.deleted) {
          if (this.view.delete(item.key)) touched.push(item.key);
        } else if (!view || changedFields(view.fields, next.fields).length > 0) {
          this.view.set(item.key, { itemType: next.itemType, fields: { ...next.fields } });
          touched.push(item.key);
        }
        continue;
      }
      // Keep our edited fields, take theirs elsewhere, and send ours against the version we edited.
      const fields = { ...view.fields };
      for (const field of Object.keys(next.fields)) {
        if (old && sameValue(view.fields[field], old.fields[field])) fields[field] = next.fields[field];
      }
      view.fields = fields;
      if (old && next.version > old.version) this.pinned.set(item.key, Math.min(this.pinned.get(item.key) ?? old.version, old.version));
      this.markDirty(item.key);
      touched.push(item.key);
    }
    if (touched.length > 0) {
      this.emitView(touched);
      this.scheduleFlush();
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  dispose() {
    this.disposed = true;
    for (const timer of [this.flushTimer, this.retryTimer, this.groupTimer]) if (timer) clearTimeout(timer);
    this.flushTimer = null;
    this.retryTimer = null;
    this.groupTimer = null;
  }

  private setSaveState(state: SaveState) {
    if (this.saveState === state) return;
    this.saveState = state;
    this.emit();
  }

  private makeSnapshot(): OpStoreSnapshot {
    return {
      saveState: this.saveState,
      canUndo: this.undoStack.length > 0 || (this.open?.size ?? 0) > 0,
      canRedo: this.redoStack.length > 0,
      drafts: this.drafts,
    };
  }

  private emit() {
    const next = this.makeSnapshot();
    const prev = this.snapshot;
    if (prev.saveState === next.saveState && prev.canUndo === next.canUndo && prev.canRedo === next.canRedo && prev.drafts === next.drafts) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private emitView(keys: string[]) {
    for (const listener of this.viewListeners) listener(keys);
  }
}
