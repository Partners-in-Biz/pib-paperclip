import { cleanFolderName, checkFolderName, folderKey, type NameProblem } from "./names.js";
import { type DriveEntityType, type EnsureBody } from "./broker.js";

export interface DriveFacts {
  entityType: DriveEntityType;
  entityId: string;
  name: string;
  companyEntityId?: string;
  companyName?: string;
  contactName?: string;
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
  const steps: Array<{ entity_type: DriveEntityType; entity_id: string; name: string; parent_entity_id?: string }> = [];

  if (facts.entityType === "crm_company") {
    steps.push({ entity_type: "crm_company", entity_id: facts.entityId, name: companyFolderName(facts.name, facts.contactName) });
  } else if (facts.companyEntityId && facts.companyName) {
    steps.push({ entity_type: "crm_company", entity_id: facts.companyEntityId, name: companyFolderName(facts.companyName, facts.contactName) });
    steps.push({ entity_type: "project", entity_id: facts.entityId, name: cleanFolderName(facts.name), parent_entity_id: facts.companyEntityId });
  } else {
    steps.push({ entity_type: "project", entity_id: facts.entityId, name: cleanFolderName(facts.name) });
  }

  for (const step of steps) {
    const problem = checkFolderName(step.name);
    if (problem) return { kind: "invalid_name", entityType: step.entity_type, entityId: step.entity_id, name: step.name, problem };
  }

  // Check all steps for collisions with appropriate siblings
  for (const step of steps) {
    const stepKey = folderKey(step.name);
    const relevantSiblings = siblings.filter((s) => s.entityType === step.entity_type && !(s.entityId === step.entity_id));
    const conflicts = relevantSiblings.filter((s) => folderKey(s.name) === stepKey);

    if (conflicts.length > 0) {
      return {
        kind: "needs_human_look",
        reason: `Folder name collision: "${step.name}" (${step.entity_type}) would have the same key as ${conflicts.map((c) => `${c.entityType} ${c.entityId}`).join(", ")}`,
        conflictsWith: conflicts,
      };
    }
  }

  return { kind: "ensure", steps: steps.map((s) => ({ ...s, created_by_run: runId })) };
}
