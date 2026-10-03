/** Reading tool and action parameters: the same small helpers for every tool. */
import { CampaignError } from "./domain.js";

export function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CampaignError("Parameters must be an object");
  return value as Record<string, unknown>;
}

export function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new CampaignError(`${key} is required`);
  return value.trim();
}

export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new CampaignError(`${key} must be a string`);
  return value.trim();
}

export function stringList(params: Record<string, unknown>, key: string): string[] {
  if (params[key] == null) return [];
  const value = params[key];
  if (!Array.isArray(value)) throw new CampaignError(`${key} must be a list`);
  return value.filter((item): item is string => typeof item === "string");
}

export function integer(value: unknown, key: string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount)) throw new CampaignError(`${key} must be an integer`);
  return amount;
}
