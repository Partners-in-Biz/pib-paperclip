import { cleanFolderName, checkFolderName, folderKey, type NameProblem } from "./names.js";
import { type DriveEntityType, type EnsureBody } from "./broker.js";

export type DriveBranch = "client" | "product" | "book" | "marketing" | "company";

/**
 * The sub-folders of a client's folder: the pattern already in the Shared Drive (`02 Partners in Biz/Clients/<Company (Contact)>`,
 * DRIVE-SAVING-RULES.md). A client has ONE folder, shared by all of its projects: there is no per-project folder level.
 * Nested names ("Assets/Images") are paths below the folder.
 */
export const CLIENT_SUBFOLDERS = ["Assets/Images", "Assets/Video", "Assets/Brand", "Assets/Social", "Deliverables", "Contracts & Quotes", "Meetings & Notes", "Shared with client"] as const;

/** The sub-folders of a product folder (`02 Partners in Biz/Products/<Product>`). */
export const PRODUCT_SUBFOLDERS = ["Brand", "Design", "Marketing assets/Images", "Marketing assets/Video", "App store", "Shared externally"] as const;

/** Every sub-folder name a save may ask for (the tool schema enum and the validation). Client names first: that is also the display order. */
export const DRIVE_SUBFOLDERS = [...CLIENT_SUBFOLDERS, ...PRODUCT_SUBFOLDERS] as const;

export type DriveSubfolder = (typeof DRIVE_SUBFOLDERS)[number];

/**
 * The numbered names the producer plugins (SEO, Social, Ads, Billing, Campaigns, Cockpit, CRM reports) still send in their
 * `drive.save-requested` events. They are translated to the drive's own names until the producers are migrated.
 * "99 Archive" has no alias: it stays invalid_subfolder.
 */
export const LEGACY_SUBFOLDER_ALIASES: Readonly<Record<string, DriveSubfolder>> = {
  "01 Briefs": "Meetings & Notes",
  "02 Assets": "Assets/Social",
  "03 Deliverables": "Deliverables",
  "04 Reports": "Deliverables",
  "05 Evidence": "Meetings & Notes",
};

/** The drive's own name for a requested sub-folder: a legacy numbered name is translated, anything else is returned as given. */
export function translateSubfolder(name: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_SUBFOLDER_ALIASES, name) ? LEGACY_SUBFOLDER_ALIASES[name]! : name;
}

export interface DriveFacts {
  entityType: DriveEntityType;
  entityId: string;
  name: string;
  companyEntityId?: string;
  companyName?: string;
  contactName?: string;
  branch?: DriveBranch;
  scopeRef?: string | null;
}

export interface Sibling {
  entityType: DriveEntityType;
  entityId: string;
  name: string;
}

export type FolderPlan =
  | { kind: "ensure"; steps: EnsureBody[] }
  | { kind: "invalid_name"; entityType: DriveEntityType; entityId: string; name: string; problem: NameProblem }
  | { kind: "needs_human_look"; reason: string; conflictsWith: Sibling[] };

export function companyFolderName(companyName: string, contactName?: string): string {
  const cleaned = cleanFolderName(companyName);
  return contactName ? `${cleaned} (${cleanFolderName(contactName)})` : cleaned;
}

/** A client project (client branch with a company link): its folder IS the company's folder. */
function isClientProject(facts: DriveFacts): boolean {
  return facts.entityType !== "crm_company" && !!facts.companyEntityId && !!facts.companyName && (facts.branch ?? "client") === "client";
}

/**
 * The registry entity whose Drive folder a project saves into. A client project has no folder of its own: it uses the company's,
 * so every project of one client shares it. Every other project (product, book, marketing, company, no client) has its own.
 * `planFolders` plans exactly this folder as its last step.
 */
export function folderTarget(facts: DriveFacts): { entityType: DriveEntityType; entityId: string } {
  if (isClientProject(facts)) return { entityType: "crm_company", entityId: facts.companyEntityId! };
  return { entityType: facts.entityType, entityId: facts.entityId };
}

export function planFolders(facts: DriveFacts, siblings: Sibling[], runId?: string): FolderPlan {
  const branch = facts.branch ?? "client";
  const steps: Array<{
    entity_type: DriveEntityType;
    entity_id: string;
    name: string;
    parent_entity_id?: string;
    parent_entity_type?: DriveEntityType;
    subfolders?: string[];
  }> = [];

  if (facts.entityType === "crm_company") {
    // A client's folder, asked for by the company itself
    steps.push({ entity_type: "crm_company", entity_id: facts.entityId, name: companyFolderName(facts.name, facts.contactName), subfolders: [...CLIENT_SUBFOLDERS] });
  } else if (isClientProject(facts)) {
    // Client branch: ONE step, the company's folder. The project's folder is the company's (no per-project level).
    steps.push({ entity_type: "crm_company", entity_id: facts.companyEntityId!, name: companyFolderName(facts.companyName!, facts.contactName), subfolders: [...CLIENT_SUBFOLDERS] });
  } else if (branch === "product") {
    // Product branch: root -> project
    steps.push({
      entity_type: "root",
      entity_id: "root:products",
      name: "Products",
    });
    steps.push({
      entity_type: "project",
      entity_id: facts.entityId,
      name: cleanFolderName(facts.name),
      parent_entity_id: "root:products",
      parent_entity_type: "root",
      subfolders: [...PRODUCT_SUBFOLDERS],
    });
  } else if (branch === "book") {
    // Book branch: root -> project
    steps.push({
      entity_type: "root",
      entity_id: "root:books",
      name: "Books",
    });
    steps.push({
      entity_type: "project",
      entity_id: facts.entityId,
      name: cleanFolderName(facts.name),
      parent_entity_id: "root:books",
      parent_entity_type: "root",
    });
  } else if (branch === "company") {
    // Company branch: root -> project (named area)
    steps.push({
      entity_type: "root",
      entity_id: "root:company",
      name: "Company",
    });
    steps.push({
      entity_type: "project",
      entity_id: facts.entityId,
      name: cleanFolderName(facts.name),
      parent_entity_id: "root:company",
      parent_entity_type: "root",
    });
  } else if (branch === "marketing") {
    // Marketing branch: root -> scope -> campaign
    const scope = facts.scopeRef || "PiB";
    const scopeKey = folderKey(scope);
    steps.push({
      entity_type: "root",
      entity_id: "root:marketing",
      name: "Marketing",
    });
    steps.push({
      entity_type: "root",
      entity_id: `root:marketing:${scopeKey}`,
      name: scope,
      parent_entity_id: "root:marketing",
      parent_entity_type: "root",
    });
    steps.push({
      entity_type: "campaign",
      entity_id: facts.entityId,
      name: cleanFolderName(facts.name),
      parent_entity_id: `root:marketing:${scopeKey}`,
      parent_entity_type: "root",
    });
  } else {
    // Fallback for client branch without company link (Own projects): the client pattern
    steps.push({
      entity_type: "project",
      entity_id: facts.entityId,
      name: cleanFolderName(facts.name),
      subfolders: [...CLIENT_SUBFOLDERS],
    });
  }

  for (const step of steps) {
    const problem = checkFolderName(step.name);
    if (problem) return { kind: "invalid_name", entityType: step.entity_type, entityId: step.entity_id, name: step.name, problem };
  }

  // Check all steps for collisions with appropriate siblings (leaf only)
  const leafStep = steps[steps.length - 1];
  if (leafStep) {
    const leafKey = folderKey(leafStep.name);
    const relevantSiblings = siblings.filter((s) => s.entityType === leafStep.entity_type && !(s.entityId === leafStep.entity_id));
    const conflicts = relevantSiblings.filter((s) => folderKey(s.name) === leafKey);

    if (conflicts.length > 0) {
      return {
        kind: "needs_human_look",
        reason: `Folder name collision: "${leafStep.name}" (${leafStep.entity_type}) would have the same key as ${conflicts.map((c) => `${c.entityType} ${c.entityId}`).join(", ")}`,
        conflictsWith: conflicts,
      };
    }
  }

  return { kind: "ensure", steps: steps.map((s) => ({ ...s, created_by_run: runId })) };
}
