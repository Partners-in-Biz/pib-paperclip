export interface ShotOptions {
  url: string | null;
  out: string | null;
  viewport: string;
  wait: number;
  timeout: number;
  expect: string[];
  json: boolean;
  help: boolean;
}
export interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
}
export interface ShotResult {
  ok: boolean;
  path: string;
  bytes: number;
  sha256: string;
  url: string;
  viewport: string;
  expected: Array<{ text: string; found: boolean }>;
}
export interface ShotDone {
  code: number;
  message: string;
  result?: ShotResult;
}
export interface ShotDeps {
  chrome?: string | null;
  fs?: unknown;
  run?: (file: string, args: string[], timeoutMs: number, isDone?: (stdout: string) => boolean) => Promise<{ error: unknown; stdout: string; stderr: string }>;
  now?: () => Date;
}
export class UsageError extends Error {}
export const MIN_BYTES: number;
export function parseArgs(argv: string[]): ShotOptions;
export function viewportOf(value: string): Viewport;
export function checkUrl(value: string): URL;
export function defaultOut(url: string, viewportName: string, now?: Date): string;
export function outputProblem(fsx: unknown, out: string): string | null;
export function isHeadlessShell(file: string): boolean;
export function chromeCandidates(env?: Record<string, string | undefined>, platform?: string, home?: string, readdir?: (dir: string) => string[]): string[];
export function findChrome(candidates?: string[], exists?: (p: string) => boolean): string | null;
export function buildChromeArgs(opts: ShotOptions, outFile: string, viewport: Viewport, userDataDir: string, dom?: boolean, shell?: boolean): string[];
export function loadError(dom: string): string | null;
export function checkExpected(dom: string, expect: string[]): Array<{ text: string; found: boolean }>;
export function shoot(opts: ShotOptions, deps?: ShotDeps): Promise<ShotDone>;
export function main(argv: string[], io?: { out: (s: string) => void; err: (s: string) => void }, deps?: ShotDeps): Promise<number>;
