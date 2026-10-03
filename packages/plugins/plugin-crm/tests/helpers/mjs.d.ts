// Build scripts written as plain .mjs (the Connector zip builder and the bundle-constants writer).
declare module "*/build.mjs" {
  export function buildConnectorZip(outPath?: string): Promise<{ path: string; sha256: string; bytes: number; files: string[] }>;
}
declare module "*/connector-bundle.mjs" {
  export function connectorHeaderVersion(): Promise<string>;
  export function writeConnectorBundle(zipPath: string): Promise<{ version: string; sha256: string; bytes: number; path: string }>;
}
