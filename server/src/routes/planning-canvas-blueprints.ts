import { Router } from "express";
import type { Db } from "@paperclipai/db";

/**
 * Planning Canvas blueprint gallery and apply (plan PAR-13925, C14). Empty until C14
 * fills it; mounted by `app.ts` now so C14 edits only this file. Every
 * handler resolves the board with `planningCanvasForRequest` from
 * `./planning-canvases.js` (same 404 for denied and unknown boards).
 */
export function planningCanvasBlueprintRoutes(_db: Db) {
  return Router();
}
