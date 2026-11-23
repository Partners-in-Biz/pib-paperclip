import { Router } from "express";
import type { Db } from "@paperclipai/db";

/**
 * Planning Canvas node comments, @agent mentions and thread reads (plan PAR-13925, C6). Empty until C6
 * fills it; mounted by `app.ts` now so C6 edits only this file. Every
 * handler resolves the board with `planningCanvasForRequest` from
 * `./planning-canvases.js` (same 404 for denied and unknown boards).
 */
export function planningCanvasCommentRoutes(_db: Db) {
  return Router();
}
