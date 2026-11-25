import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { accessCompanyScope } from "../../src/access/switch.js";

export const CO = "co-1";
export const PLUGIN = "partnersinbiz.ads";
type Scope = { scopeId?: string; namespace?: string; stateKey: string };
const key = (s: Scope) => `${s.scopeId}|${s.namespace}|${s.stateKey}`;
export const ROW = key(accessCompanyScope(CO));
export const grantKey = (userId: string) => `${CO}|access|u:${userId}`;

/** A plugin context with state, events and a logger; reads and writes can be made to throw. */
export function accessFake() {
  const store = new Map<string, unknown>();
  const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
  const writes: string[] = [];
  const handlers = new Map<string, (e: PluginEvent) => Promise<void>>();
  const fail = { get: null as null | ((k: string) => boolean), set: null as null | ((k: string) => boolean) };
  let reads = 0;
  const ctx = {
    state: {
      get: async (s: Scope) => {
        reads++;
        if (fail.get?.(key(s))) throw new Error("read failed");
        return store.get(key(s)) ?? null;
      },
      set: async (s: Scope, v: unknown) => {
        if (fail.set?.(key(s))) throw new Error("write failed");
        writes.push(`set ${key(s)}`);
        store.set(key(s), v);
      },
      delete: async (s: Scope) => {
        writes.push(`delete ${key(s)}`);
        store.delete(key(s));
      },
    },
    events: {
      on: (name: string, fn: (e: PluginEvent) => Promise<void>) => void handlers.set(name, fn),
      emit: async (name: string, companyId: string, payload: Record<string, unknown>) => void emitted.push({ name, companyId, payload }),
    },
    logger: { info: () => undefined },
  } as unknown as PluginContext;
  const named = (name: string) => emitted.filter((e) => e.name === name);
  return { ctx, store, emitted, writes, handlers, fail, reads: () => reads, named };
}
