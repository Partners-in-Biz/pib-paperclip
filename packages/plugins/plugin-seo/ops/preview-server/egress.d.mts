import type { Server } from "node:http";
import type { Resolver } from "./sweep.mjs";

export const EGRESS_IDLE_MS: number;
export interface EgressOptions {
  resolve?: Resolver;
  isPublic?: (ip: string) => boolean;
  ports?: readonly number[];
  idleMs?: number;
  log?: (line: string) => void;
}
export function createEgressProxy(options?: EgressOptions): Server;
export function startEgressProxy(options?: EgressOptions): Promise<{ port: number; close: () => Promise<void> }>;
