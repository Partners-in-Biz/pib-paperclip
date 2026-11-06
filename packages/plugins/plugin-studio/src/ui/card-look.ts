/**
 * Pure helpers behind the canvas look (PAR-8046): the status pill on a card, the media frame's ratio, the running
 * edge, and the credits line. Kept free of React so the tests can run in node.
 */
import type { Edge } from "@xyflow/react";
import type { CardData } from "./board.js";

export type CardTone = "running" | "done" | "draft" | "approved" | "rejected";

/** The pill on a card: generating wins, then the review decision, then Draft for a result card or Done for a made one. */
export function cardStatus(kind: string, data: CardData, assetStatus: string | undefined): { label: string; tone: CardTone } | null {
  if (data.groupId) return { label: "Generating", tone: "running" };
  if (!data.assetId) return null;
  if (assetStatus === "approved") return { label: "Approved", tone: "approved" };
  if (assetStatus === "rejected") return { label: "Rejected", tone: "rejected" };
  if (kind === "output") return { label: "Draft", tone: "draft" };
  return kind === "image" || kind === "video" ? { label: "Done", tone: "done" } : null;
}

/** "16:9" -> "16 / 9" for CSS aspect-ratio; anything else falls back to a square. */
export function aspectCss(ratio: string | undefined): string {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio ?? "");
  return m && Number(m[1]) > 0 && Number(m[2]) > 0 ? `${m[1]} / ${m[2]}` : "1 / 1";
}

/** Edges into a card that is generating run dashed in the accent colour. */
export function markRunning(nodes: ReadonlyArray<{ id: string; data?: CardData }>, edges: Edge[]): Edge[] {
  const running = new Set(nodes.filter((n) => n.data?.groupId).map((n) => n.id));
  if (!running.size) return edges;
  return edges.map((e) => (running.has(e.target) ? { ...e, animated: true, className: "studio-edge-running" } : e));
}

/** Credits left this month, never below zero, to two decimals (0.62 of 50). */
export function creditsLeft(used: number, cap: number): number {
  return Math.max(0, Math.round((cap - used) * 100) / 100);
}
