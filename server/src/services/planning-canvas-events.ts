import { EventEmitter } from "node:events";
import type { PlanningCanvasItem } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * In-process Planning Canvas event bus (plan PAR-13925 B.2, E). The ops engine
 * publishes here only after its transaction commits; the realtime hub (C11)
 * subscribes per board. Assumes one API process, like `live-events.ts` (Q13).
 * Canvas events stay off `LIVE_EVENT_TYPES`: they fan out per board, not per
 * company, and carry item bodies the company stream must not see.
 */

export type PlanningCanvasEventActor = { type: "user"; id: string } | { type: "agent"; id: string };

export interface PlanningCanvasOpsAppliedEvent {
  type: "ops.applied";
  companyId: string;
  boardId: string;
  revision: number;
  actor: PlanningCanvasEventActor;
  /** Every item the batch changed, including connectors taken along by delete/restore. */
  items: PlanningCanvasItem[];
  /** Tombstones purged in the batch transaction; `purgedThroughRevision` moved with them. */
  purgedThroughRevision: number;
}

/**
 * Who may open the board may have changed (C3 sharing, archive, restore,
 * delete, grant revoke). The realtime hub (C11) re-resolves every socket of
 * the board on it (plan E, revocation (a)). Carries no board content.
 */
export interface PlanningCanvasAccessChangedEvent {
  type: "access.changed";
  companyId: string;
  boardId: string;
  reason: "sharing" | "archived" | "restored" | "deleted" | "grant_revoked";
}

export type PlanningCanvasEvent = PlanningCanvasOpsAppliedEvent | PlanningCanvasAccessChangedEvent;
export type PlanningCanvasEventListener = (event: PlanningCanvasEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const allBoards = Symbol("all-planning-canvas-events");

function deliver(channel: string | symbol, event: PlanningCanvasEvent) {
  for (const listener of emitter.listeners(channel) as PlanningCanvasEventListener[]) {
    try {
      listener(event);
    } catch (err) {
      // A broken subscriber must never fail the write that already committed.
      logger.warn({ err, boardId: event.boardId, type: event.type }, "planning canvas event listener failed");
    }
  }
}

/** Call only after the writing transaction has committed. */
export function publishPlanningCanvasEvent(event: PlanningCanvasEvent) {
  deliver(event.boardId, event);
  deliver(allBoards, event);
}

export function subscribePlanningCanvasBoard(boardId: string, listener: PlanningCanvasEventListener) {
  emitter.on(boardId, listener);
  return () => {
    emitter.off(boardId, listener);
  };
}

export function subscribeAllPlanningCanvasEvents(listener: PlanningCanvasEventListener) {
  emitter.on(allBoards, listener);
  return () => {
    emitter.off(allBoards, listener);
  };
}
