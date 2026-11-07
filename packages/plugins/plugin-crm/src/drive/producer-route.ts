/**
 * One way for the CRM to answer a producer plugin's Drive request (save, list, read), PAR-8114.
 *
 * The host delivers a plugin's emit as `plugin.<emitterId>.<name>`, has only a trailing wildcard, and refuses emits
 * whose name starts with `plugin.`. So every route subscribes once per known producer, drops events from any plugin
 * not on the kit's DRIVE_PRODUCER_PLUGINS list, and replies with bare names (delivered to the producer as
 * `plugin.partnersinbiz.crm.<name>`, which is what the kit listens on). The company is the event's, which the host
 * sets, never one from the payload; it decides which Drive (and which clients) a request can reach.
 * Add a new Drive route through `registerProducerRoute`, never with a raw `ctx.events.on`.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { DRIVE_PRODUCER_PLUGINS, knownProducerOf, producerEventName } from "@partnersinbiz/pib-plugin-kit";

type RouteCtx = Pick<PluginContext, "events" | "logger">;

export interface ProducerRequest {
  producer: string;
  /** From the host-set event, never the payload. */
  companyId: string;
  requestId: string;
  payload: Record<string, unknown>;
  event: PluginEvent;
  /** Emits `name` (bare) to the producer for this company. */
  reply: (name: string, payload: Record<string, unknown>) => Promise<void>;
}

function assertBare(name: string): void {
  if (name.startsWith("plugin.")) throw new Error(`Drive route event "${name}" must be a bare name; the host adds plugin.<id>.`);
}

export function registerProducerRoute(
  ctx: RouteCtx,
  name: string,
  handler: (req: ProducerRequest) => Promise<void>,
  producers: readonly string[] = DRIVE_PRODUCER_PLUGINS,
): void {
  assertBare(name);
  const handle = async (event: PluginEvent) => {
    const producer = knownProducerOf(event, name, producers);
    if (!producer) return;
    const { companyId } = event;
    if (!companyId) return;
    const payload = (event.payload as Record<string, unknown> | undefined) ?? {};
    const requestId = payload.requestId;
    if (typeof requestId !== "string" || !requestId) return;
    const reply = async (replyName: string, body: Record<string, unknown>) => {
      assertBare(replyName);
      await ctx.events.emit(replyName, companyId, { ...body, requestId });
    };
    await handler({ producer, companyId, requestId, payload, event, reply });
  };
  for (const producer of producers) ctx.events.on(producerEventName(producer, name), handle);
}
