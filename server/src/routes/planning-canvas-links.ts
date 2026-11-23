import { Router } from "express";
import type { Db } from "@paperclipai/db";

/**
 * Planning Canvas refs hydration, handoff and issue query (plan PAR-13925, C8). Empty until C8
 * fills it; mounted by `app.ts` now so C8 edits only this file. Every
 * handler resolves the board with `planningCanvasForRequest` from
 * `./planning-canvases.js` (same 404 for denied and unknown boards).
 */
export function planningCanvasLinkRoutes(_db: Db) {
  return Router();
}
