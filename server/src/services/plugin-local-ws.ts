import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isAbsolute } from "node:path";

/**
 * Signed local unix-socket targets for plugin WebSocket routes (PAR-14514 S1).
 *
 * The key pair is made when the server starts; the private half lives only in
 * this process's memory and is never written anywhere. The public half is
 * served by `GET /api/plugins/local-ws-key`, so the local service behind the
 * socket can check that an upgrade passed the server's sign-in checks.
 */
const keyPair = generateKeyPairSync("ed25519");

export const PLUGIN_LOCAL_WS_SIGNATURE_HEADER = "x-paperclip-local-ws-signature";
export const PLUGIN_LOCAL_WS_CAPABILITY = "websocket.local";
export const PLUGIN_LOCAL_WS_TARGETS_ENV = "PAPERCLIP_PLUGIN_LOCAL_WS_TARGETS";

/** The public half, as the public route returns it. */
export function pluginLocalWsPublicKey() {
  return {
    algorithm: "Ed25519" as const,
    header: PLUGIN_LOCAL_WS_SIGNATURE_HEADER,
    publicKey: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export interface PluginLocalWsStatement {
  v: 1;
  pluginKey: string;
  socket: string;
  path: string;
  userId: string;
  /** Unix time in milliseconds. */
  ts: number;
  /** 16 random bytes, base64url. */
  nonce: string;
}

/**
 * Header value: `<base64url(JSON statement)>.<base64url(Ed25519 signature)>`.
 * The signature covers the ASCII bytes of the first part, so a verifier never
 * re-serialises JSON.
 */
export function signPluginLocalWsUpgrade(
  input: { pluginKey: string; socket: string; path: string; userId: string },
  now = Date.now(),
): string {
  const statement: PluginLocalWsStatement = { v: 1, ...input, ts: now, nonce: randomBytes(16).toString("base64url") };
  const body = Buffer.from(JSON.stringify(statement)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), keyPair.privateKey).toString("base64url")}`;
}

/** `pluginKey=socketPath` pairs, separated by commas or whitespace. Empty by default. */
export function pluginLocalWsTargets(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env[PLUGIN_LOCAL_WS_TARGETS_ENV] ?? "").split(/[\s,]+/).filter(Boolean));
}

export function isPluginLocalWsSocketPath(socket: unknown): socket is string {
  return typeof socket === "string" && isAbsolute(socket) && !/[\0\s]/.test(socket);
}

/** A request path only: one leading `/`, printable ASCII, no scheme, host or fragment. */
export function isPluginLocalWsPath(path: unknown): path is string {
  return typeof path === "string" && /^\/(?!\/)[\x21-\x7e]*$/.test(path) && !path.includes("#") && !path.includes("\\");
}

type LocalWsActor = { type?: string; source?: string; userId?: string | null };

/**
 * Decides a worker-returned `{ local: { socket, path } }` target. Returns the
 * signed target, or null when any rule fails (the caller answers today's 502):
 * (a) the plugin holds `websocket.local`, (b) the exact pair is on the operator
 * list, (c) the upgrade comes from a person signed in with a session. A board
 * key, the local board, an agent key and a run token never get one.
 */
export function resolvePluginLocalWsTarget(input: {
  pluginKey: string;
  capabilities: readonly string[];
  actor: LocalWsActor;
  websocket: unknown;
  env?: NodeJS.ProcessEnv;
}): { local: { socket: string; path: string }; signature: { name: string; value: string } } | null {
  const { websocket, actor } = input;
  if (!websocket || typeof websocket !== "object") return null;
  // A local target takes no plugin-supplied headers and nothing besides `local`.
  if (Object.keys(websocket).length !== 1) return null;
  const local = (websocket as { local?: unknown }).local;
  if (!local || typeof local !== "object" || Object.keys(local).length !== 2) return null;
  const { socket, path } = local as { socket?: unknown; path?: unknown };
  if (!isPluginLocalWsSocketPath(socket) || !isPluginLocalWsPath(path)) return null;
  if (!input.capabilities.includes(PLUGIN_LOCAL_WS_CAPABILITY)) return null;
  if (!pluginLocalWsTargets(input.env).has(`${input.pluginKey}=${socket}`)) return null;
  if (actor.type !== "board" || actor.source !== "session" || typeof actor.userId !== "string" || !actor.userId) return null;
  return {
    local: { socket, path },
    signature: {
      name: PLUGIN_LOCAL_WS_SIGNATURE_HEADER,
      value: signPluginLocalWsUpgrade({ pluginKey: input.pluginKey, socket, path, userId: actor.userId }),
    },
  };
}
