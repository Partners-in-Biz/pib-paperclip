// Smallest worker the host accepts: newline-delimited JSON-RPC on stdio, no SDK import (no build).
import { createInterface } from "node:readline";

const reply = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.id === null || !message.method) return;
  if (message.method === "initialize") return reply(message.id, { result: { ok: true, supportedMethods: [] } });
  if (message.method === "health") return reply(message.id, { result: { status: "ok" } });
  if (message.method === "shutdown") {
    reply(message.id, { result: null });
    return setTimeout(() => process.exit(0), 10);
  }
  return reply(message.id, { error: { code: -32601, message: `Method not found: ${message.method}` } });
});
