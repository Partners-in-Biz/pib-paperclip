import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { Resolver } from "./sweep.mjs";

export const RENDER_PORT: number;
export const RENDER_TIMEOUT_MS: number;
export const RENDER_MAX_BYTES: number;
export const RENDER_BODY_MAX: number;
export const SOURCE_BASIS_NOTICE: string;
export function killGroup(child: ChildProcess): void;
export interface RenderOptions {
  proxyPort: number;
  chrome: () => Promise<string>;
  withChromium: <T>(run: (dir: string) => Promise<T>) => Promise<T>;
  resolve?: Resolver;
  checkUrl?: (url: string) => Promise<{ url: string }>;
  spawn?: typeof nodeSpawn | ((...args: any[]) => any);
  kill?: (child: any) => void;
  timeoutMs?: number;
  maxBytes?: number;
  before?: () => Promise<void>;
  log?: (line: string) => void;
}
export function createRenderService(options: RenderOptions): {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  isBusy: () => boolean;
  stop: () => void;
};
export function keptTextFigure(stats: unknown): string;
export function wordsOf(html: string): string[];
