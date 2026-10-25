/** Growth experiment spend gate: blocks agent-initiated experiments above owner threshold. */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { type GrowthActor, type GrowthToolName, type GrowthToolHandler } from "@partnersinbiz/pib-plugin-kit";
import { AdsError } from "./domain.js";
import { formatMoney } from "./money.js";
import { OWN_SCOPE, type ScopeKey } from "./platforms.js";
import { routeForSpend } from "./owner-route.js";
import type { ScopeRow } from "./db.js";

/** One arm's added spend. */
export interface ArmSpend {
  key: "control" | "variant";
  addedMinor: number;
}

/** Parse and validate armSpend parameter. */
export function parseArmSpend(value: unknown): ArmSpend[] {
  if (!Array.isArray(value)) {
    throw new AdsError("armSpend is required: the extra spend per arm in minor units, 0 if the arm adds none");
  }

  const result: ArmSpend[] = [];
  const keys = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== "object") {
      throw new AdsError("armSpend items must be objects with key (control|variant) and addedMinor (non-negative integer)");
    }

    const obj = item as Record<string, unknown>;
    const key = obj.key;
    const addedMinor = obj.addedMinor;

    if (key !== "control" && key !== "variant") {
      throw new AdsError("armSpend key must be control or variant");
    }
    if (typeof addedMinor !== "number" || !Number.isInteger(addedMinor) || addedMinor < 0) {
      throw new AdsError("armSpend addedMinor must be a non-negative integer");
    }
    if (keys.has(key)) {
      throw new AdsError("armSpend has duplicate keys");
    }

    keys.add(key);
    result.push({ key, addedMinor });
  }

  return result;
}

/** Sum of added spend across all arms. */
export function experimentSpendIncreaseMinor(arms: ArmSpend[]): number {
  return arms.reduce((sum, arm) => sum + arm.addedMinor, 0);
}

/** Recorded spend for an experiment. */
export interface SpendRecord {
  scopeKey: string;
  increaseMinor: number;
}

/** Spend ledger: save and load experiment spending records. */
export interface SpendLedger {
  save(companyId: string, experimentId: string, record: SpendRecord): Promise<void>;
  load(companyId: string, experimentId: string): Promise<SpendRecord | null>;
}

/** Dependencies for the spend gate. */
export interface SpendGateDeps {
  ledger: SpendLedger;
  getScope(companyId: string, scopeKey: string): Promise<ScopeRow | null>;
}

/**
 * Wrap growth handlers to gate propose-experiment on spend.
 * Other handlers pass through unchanged.
 */
export function gateGrowthHandlers<
  A extends GrowthActor,
  H extends Record<string, (actor: A, params: Record<string, unknown>) => Promise<unknown>>,
>(handlers: H, deps: SpendGateDeps): H {
  const result = { ...handlers } as H;

  (result as any)["propose-experiment"] = async (actor: A, params: Record<string, unknown>) => {
    const arms = parseArmSpend(params.armSpend);
    const increase = experimentSpendIncreaseMinor(arms);
    const scopeKey: ScopeKey = params.client ? String(params.client) : OWN_SCOPE;

    const scope = await deps.getScope(actor.companyId, scopeKey);
    if (!scope) {
      throw new AdsError(`Scope ${scopeKey} not found`);
    }

    const route = routeForSpend(scope, increase);

    if (actor.isAgent && route.route === "owner_required") {
      throw new AdsError(
        `This experiment's spend increase of ${formatMoney(increase, scope.currency)} exceeds the owner threshold of ${formatMoney(route.thresholdMinor, scope.currency)}. ` +
          `Raise it with the owner through ask-owner; a person can start it.`,
        "owner_required",
      );
    }

    const paramsWithoutSpend = { ...params };
    delete paramsWithoutSpend.armSpend;

    const innerResult = await handlers["propose-experiment"](actor, paramsWithoutSpend);
    const experimentId = (innerResult as { id?: unknown }).id;

    if (typeof experimentId !== "string") {
      throw new AdsError("propose-experiment did not return an experiment id");
    }

    // Saved after the kit starts or queues it; an agent's later approve fails closed without a record.
    await deps.ledger.save(actor.companyId, experimentId, { scopeKey, increaseMinor: increase });

    return innerResult;
  };

  (result as any)["approve-experiment"] = async (actor: A, params: Record<string, unknown>) => {
    const experimentId = String(params.experimentId);

    if (actor.isAgent) {
      const record = await deps.ledger.load(actor.companyId, experimentId);
      if (!record) {
        throw new AdsError("No spend record found for this experiment");
      }

      const scope = await deps.getScope(actor.companyId, record.scopeKey);
      if (!scope) {
        throw new AdsError(`Scope ${record.scopeKey} not found`);
      }

      const route = routeForSpend(scope, record.increaseMinor);

      if (route.route === "owner_required") {
        throw new AdsError(
          `This experiment's spend increase of ${formatMoney(record.increaseMinor, scope.currency)} exceeds the owner threshold of ${formatMoney(route.thresholdMinor, scope.currency)}. ` +
            `Raise it with the owner through ask-owner; a person can start it.`,
          "owner_required",
        );
      }
    }

    return await handlers["approve-experiment"](actor, params);
  };

  return result;
}

/** Add armSpend as a required parameter to the propose-experiment tool. */
export function growthSpendDeclarations(tools: PluginToolDeclaration[]): PluginToolDeclaration[] {
  return tools.map((tool) => {
    if (tool.name === "propose-experiment") {
      const schema = (tool.parametersSchema as Record<string, unknown>) ?? {};
      const properties = (schema.properties as Record<string, JsonSchema>) ?? {};
      const required = (schema.required as string[]) ?? [];

      return {
        ...tool,
        parametersSchema: {
          ...schema,
          properties: {
            ...properties,
            armSpend: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: "string", enum: ["control", "variant"] },
                  addedMinor: { type: "integer", minimum: 0 },
                },
                required: ["key", "addedMinor"],
                additionalProperties: false,
              },
              description: "Extra spend per arm in minor units (0 if none). E.g. [{key: control, addedMinor: 40000}]",
            },
          },
          required: [...new Set([...required, "armSpend"])],
        } as JsonSchema,
      };
    }

    return tool;
  });
}
