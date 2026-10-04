/**
 * Cross-plugin contract: the Mailbox announces `mail.delivery` under the kit's event name with the kit's types, and Campaigns (the consumer)
 * listens to that same name and knows every type. Plugins cannot call each other, so a name or a type that drifts on one side only would
 * leave the other side listening to nothing: delivered, bounce and complaint reports would silently stop reaching the campaign report.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAIL_DELIVERY_TYPES, MAIL_EVENTS } from "../src/index.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const mailboxEvents = read("../../plugin-mailbox/src/esp/events.ts");
const campaignsWorker = read("../../plugin-campaigns/src/worker.ts");
const campaignsDelivery = read("../../plugin-campaigns/src/delivery.ts");

describe("mail.delivery between the Mailbox and Campaigns", () => {
  it("the Mailbox emits it under the kit's event name, never a literal of its own", () => {
    expect(MAIL_EVENTS.delivery).toBe("mail.delivery");
    expect(mailboxEvents).toMatch(/export const ESP_DELIVERY_EVENT = MAIL_EVENTS\.delivery;/);
    expect(mailboxEvents).toMatch(/ctx\.events\.emit\(ESP_DELIVERY_EVENT,/);
  });

  it("the Mailbox announces exactly the types the kit names (the provider's own `sent` is not announced: the send result says it)", () => {
    const table = /const TYPE_OF: Record<[^>]+> = \{([^]*?)\n\};/.exec(mailboxEvents)?.[1];
    expect(table, "the Mailbox's event table moved: update this contract test with it").toBeTruthy();
    const produced = new Set([...table!.matchAll(/:\s*"([a-z_]+)"/g)].map((match) => match[1]!));
    produced.delete("sent");
    expect([...produced].sort()).toEqual([...MAIL_DELIVERY_TYPES].sort());
    expect(mailboxEvents).toMatch(/if \(type !== "sent"\) \{\s*await announceDelivery\(/);
  });

  it("Campaigns listens to the Mailbox's event by the kit's name", () => {
    expect(campaignsWorker).toMatch(/ctx\.events\.on\(pluginEvent\(PIB_PLUGINS\.mailbox, MAIL_EVENTS\.delivery\)/);
  });

  it("Campaigns has an answer for every type the kit names (a type it ignores on purpose maps to null)", () => {
    const table = /const EVENT_OF: Record<MailDeliveryType, [^>]+> = \{([^]*?)\n\};/.exec(campaignsDelivery)?.[1];
    expect(table, "Campaigns' delivery table moved: update this contract test with it").toBeTruthy();
    const handled = [...table!.matchAll(/^\s*([a-z_]+):/gm)].map((match) => match[1]!);
    expect(handled.sort()).toEqual([...MAIL_DELIVERY_TYPES].sort());
  });
});
