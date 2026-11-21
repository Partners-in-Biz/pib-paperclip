import { z } from "zod";
import {
  CANVAS_NODE_COLORS,
  CANVAS_NODE_KINDS,
  CANVAS_SHAPE_VARIANTS,
} from "../types/planning-canvas.js";

export const canvasNodeSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(CANVAS_NODE_KINDS),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(40).max(4000),
  height: z.number().finite().min(30).max(4000),
  zIndex: z.number().int().min(0).max(100_000).default(1),
  color: z.enum(CANVAS_NODE_COLORS).default("yellow"),
  title: z.string().max(300).default(""),
  content: z.string().max(20_000).default(""),
  noteId: z.string().uuid().nullable().optional(),
  shape: z.enum(CANVAS_SHAPE_VARIANTS).optional(),
  handedOffIssueId: z.string().uuid().nullable().optional(),
  handedOffIssueIdentifier: z.string().max(64).nullable().optional(),
});

export const canvasConnectorSchema = z.object({
  id: z.string().min(1).max(100),
  fromNodeId: z.string().min(1).max(100),
  toNodeId: z.string().min(1).max(100),
  label: z.string().max(120).optional(),
  color: z.enum(CANVAS_NODE_COLORS).optional(),
  dashed: z.boolean().optional(),
});

export const canvasStrokeSchema = z.object({
  id: z.string().min(1).max(100),
  points: z
    .array(z.object({ x: z.number().finite(), y: z.number().finite() }))
    .min(1)
    .max(2000),
  color: z.enum(CANVAS_NODE_COLORS).default("slate"),
  width: z.number().min(1).max(32).default(3),
  highlighter: z.boolean().optional(),
});

export const canvasViewportSchema = z.object({
  x: z.number().finite().default(0),
  y: z.number().finite().default(0),
  zoom: z.number().finite().min(0.2).max(2.5).default(1),
});

export const planningCanvasDataSchema = z.object({
  nodes: z.array(canvasNodeSchema).max(500).default([]),
  connectors: z.array(canvasConnectorSchema).max(500).default([]),
  strokes: z.array(canvasStrokeSchema).max(500).optional(),
  viewport: canvasViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
});

export const createPlanningCanvasSchema = z.object({
  title: z.string().trim().min(1, "Board title is required").max(160),
  description: z.string().max(1000).optional().default(""),
  data: planningCanvasDataSchema.optional(),
});

export type CreatePlanningCanvas = z.infer<typeof createPlanningCanvasSchema>;

export const updatePlanningCanvasSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(1000).optional(),
  data: planningCanvasDataSchema.optional(),
});

export type UpdatePlanningCanvas = z.infer<typeof updatePlanningCanvasSchema>;
