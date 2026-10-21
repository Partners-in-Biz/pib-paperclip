import { cleanFolderName, checkFolderName, folderKey, type NameProblem } from "./names.js";
import { type DriveEntityType, type EnsureBody } from "./broker.js";

export type DriveBranch = "client" | "product" | "book" | "marketing" | "company";

export const DRIVE_SUBFOLDERS = ["01 Briefs", "02 Assets", "03 Deliverables", "04 Reports", "05 Evidence", "99 Archive"] as const;

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
    // Company folder (client branch only)
    steps.push({ entity_type: "crm_company", entity_id: facts.entityId, name: companyFolderName(facts.name, facts.contactName) });
  } else if (facts.companyEntityId && facts.companyName && branch === "client") {
    // Client branch: company + project
    steps.push({ entity_type: "crm_company", entity_id: facts.companyEntityId, name: companyFolderName(facts.companyName, facts.contactName) });
    steps.push({
      entity_type: "project",
      entity_id: facts.entityId,
      name: cleanFolderName(facts.name),
      parent_entity_id: facts.companyEntityId,
      subfolders: [...DRIVE_SUBFOLDERS],
    });
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
      subfolders: [...DRIVE_SUBFOLDERS],
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
      subfolders: [...DRIVE_SUBFOLDERS],
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
      subfolders: [...DRIVE_SUBFOLDERS],
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
      subfolders: [...DRIVE_SUBFOLDERS],
    });
  } else {
    // Fallback for client branch without company link
    steps.push({
      entity_type: "project",
      entity_id: facts.entityId,
      name: cleanFolderName(facts.name),
      subfolders: [...DRIVE_SUBFOLDERS],
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
