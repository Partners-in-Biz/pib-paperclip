import { logger } from "../middleware/logger.js";

/**
 * Kill switches of Planning Canvas phase 2 (plan PAR-14257, C "Stage 0"). Same
 * pattern as `planningCanvasAgentGrantsOn`: read from the environment on every
 * call (never cached), on only for `on`, `true` or `1`, and a throw means off.
 * `PLANNING_CANVAS_GUESTS` is deliberately not here (no decision yet).
 */
export const PLANNING_CANVAS_CHAT_ENV = "PLANNING_CANVAS_CHAT";
export const PLANNING_CANVAS_FLOWS_ENV = "PLANNING_CANVAS_FLOWS";
export const PLANNING_CANVAS_ENGAGE_ENV = "PLANNING_CANVAS_ENGAGE";

const FLAG_ON_VALUES = new Set(["on", "true", "1"]);

function switchOn(name: string): boolean {
  try {
    const raw = process.env[name];
    return typeof raw === "string" && FLAG_ON_VALUES.has(raw.trim().toLowerCase());
  } catch (err) {
    logger.warn({ err, switch: name }, "planning canvas switch unreadable; treating it as off");
    return false;
  }
}

export const planningCanvasChatOn = () => switchOn(PLANNING_CANVAS_CHAT_ENV);
export const planningCanvasFlowsOn = () => switchOn(PLANNING_CANVAS_FLOWS_ENV);
export const planningCanvasEngageOn = () => switchOn(PLANNING_CANVAS_ENGAGE_ENV);
