/**
 * The data-processing register text for one company.
 *
 * `docs/data-processing-register.md` is a template: the few phrases that name Partners in Biz (its domain, its repositories, its older
 * platform) are `{{tokens}}`. The owner company (the `ownerCompany` setting, ticked on Partners in Biz's own company only) gets the
 * original wording back, byte for byte. Every other company gets the same table with its own name in place of ours and without our
 * internals, so an agent in a client company never reads "Partners in Biz" in its register.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig } from "@partnersinbiz/pib-plugin-kit";
import { brandName } from "./refs.js";
import { REGISTER_DOC } from "./register-doc.generated.js";

export interface RegisterParty {
  /** True for Partners in Biz's own company only. */
  owner: boolean;
  /** The company's name; used for every other company. */
  name: string | null;
}

const FALLBACK_NAME = "this company";

/** One line of plain words that cannot break the register's table (`|`) or smuggle in a token or markup. */
export function cleanPartyName(name: string | null | undefined): string {
  const clean = (name ?? "").replace(/[|{}\r\n\t`<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return clean || FALLBACK_NAME;
}

const OWNER_NAME = "Partners in Biz";

/** [owner wording, client wording] for each token; the owner wording is exactly what the file said before it was a template. */
const TOKENS: Record<string, readonly [string, (party: string) => string]> = {
  party_scope: ["Partners in Biz and its clients", (party) => party],
  mail_domain: ["partnersinbiz.online", (party) => `${party}'s mail domain`],
  resend_dkim: ["the domain already has its DKIM selector from the PiB web app; ", () => "the sending domain needs its own DKIM selector before anything is sent; "],
  resend_team: [", and choose a separate team from the PiB web app", () => ""],
  github_hosts: ["the client and Partners in Biz repositories", (party) => `the code repositories of ${party}`],
  vercel_hosts: ["partnersinbiz.online and several client websites", (party) => `the websites of ${party}`],
  firebase_users: ["The older Partners in Biz platform and some client apps", (party) => `Some apps of ${party}`],
  firebase_data: ["app users, contact and lead records of the older platform", () => "app users, contact and lead records"],
};

/** The register markdown for a company. Throws on an unknown token, so a typo in the file fails the build's test, not production. */
export function renderRegisterDoc(template: string, party: RegisterParty): string {
  const name = party.owner ? OWNER_NAME : cleanPartyName(party.name);
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_match, key: string) => {
    const token = TOKENS[key];
    if (!token) throw new Error(`The register file has an unknown token {{${key}}}`);
    return party.owner ? token[0] : token[1](name);
  });
}

export function tokensIn(template: string): string[] {
  return [...template.matchAll(/\{\{([a-z_]+)\}\}/g)].map((match) => match[1]!);
}

/** Who the register is for: the owner flag from the CRM setting (fails closed to a client company) and the company's name. */
export async function partyOf(ctx: PluginContext, companyId: string): Promise<RegisterParty> {
  const config = await readConfig(ctx, companyId).catch(() => ({} as Record<string, unknown>));
  const owner = config.ownerCompany === true;
  return { owner, name: owner ? OWNER_NAME : await brandName(ctx, companyId) };
}

export async function registerDocFor(ctx: PluginContext, companyId: string): Promise<string> {
  return renderRegisterDoc(REGISTER_DOC, await partyOf(ctx, companyId));
}
