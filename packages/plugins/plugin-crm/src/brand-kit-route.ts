/**
 * The client brand kit for producer plugins (Studio, PAR-8134): kit's `requestBrandKit` over the event bus.
 * The company is the event's (host-set); the client is read only inside that company's profiles, so a ref from another
 * company finds nothing. The reply names the client it read, and the kit has only brand fields (no logo key yet).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { BRAND_KIT_EVENTS, BRAND_KIT_PRODUCER_PLUGINS, brandKitOf } from "@partnersinbiz/pib-plugin-kit";
import { registerProducerRoute } from "./drive/producer-route.js";
import { getClientProfile } from "./store.js";
import type { ClientKind } from "./refs.js";

type RouteCtx = Pick<PluginContext, "events" | "logger">;
type ProfileReader = (ctx: PluginContext, companyId: string, kind: ClientKind, ref: string) => Promise<unknown>;

const REF = /^[A-Za-z0-9_-]{1,128}$/;

export function registerBrandKitRoute(
  ctx: RouteCtx,
  readProfile: ProfileReader = (c, companyId, kind, ref) => getClientProfile(c, companyId, kind, ref),
  producers: readonly string[] = BRAND_KIT_PRODUCER_PLUGINS,
): void {
  registerProducerRoute(
    ctx,
    BRAND_KIT_EVENTS.requested,
    async ({ producer, companyId, requestId, payload, reply }) => {
      const kind = payload.clientKind;
      const ref = payload.clientRef;
      if ((kind !== "company" && kind !== "contact") || typeof ref !== "string" || !REF.test(ref)) {
        await reply(BRAND_KIT_EVENTS.failed, { reason: "invalid_input" });
        return;
      }
      try {
        const record = await readProfile(ctx as PluginContext, companyId, kind, ref);
        if (!record) {
          await reply(BRAND_KIT_EVENTS.failed, { reason: "no_profile", hint: "This client has no CRM profile yet (update-client-profile)." });
          return;
        }
        await reply(BRAND_KIT_EVENTS.read, { clientKind: kind, clientRef: ref, kit: brandKitOf(record) });
      } catch (e) {
        ctx.logger.info("Brand kit request failed", { requestId, producer, error: e instanceof Error ? e.message : String(e) });
        await reply(BRAND_KIT_EVENTS.failed, { reason: "failed" }).catch(() => undefined);
      }
    },
    producers,
  );
}
