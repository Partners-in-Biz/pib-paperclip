export class PartnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartnerError";
  }
}

export type LinkStatus = "pending" | "active";
export type GrantStatus = "proposed" | "active";
export type ShareRecordType = "contact" | "company" | "deal" | "invoice";

export function orderCompanies(left: string, right: string): [string, string] {
  if (left === right) throw new PartnerError("A company cannot link to itself");
  return left < right ? [left, right] : [right, left];
}

export function linkStatus(acceptedA: boolean, acceptedB: boolean): LinkStatus {
  return acceptedA && acceptedB ? "active" : "pending";
}

export function proposeGrant(input: { linkStatus: LinkStatus; recordId: string; recordType: ShareRecordType }): {
  recordId: string;
  recordType: ShareRecordType;
  status: "proposed";
  copiedRecord: null;
} {
  if (input.linkStatus !== "active") throw new PartnerError("Both companies must accept the link before a grant");
  return { recordId: input.recordId, recordType: input.recordType, status: "proposed", copiedRecord: null };
}

export function acceptGrant(input: {
  linkStatus: LinkStatus;
  sourceCompanyId: string;
  actorCompanyId: string;
  recordId: string;
  recordType: ShareRecordType;
}): { recordId: string; recordType: ShareRecordType; status: "active"; copiedRecord: null } {
  if (input.linkStatus !== "active") throw new PartnerError("Both companies must accept the link before a grant");
  if (input.actorCompanyId !== input.sourceCompanyId) {
    throw new PartnerError("Only the company that owns the record can accept the grant");
  }
  return { recordId: input.recordId, recordType: input.recordType, status: "active", copiedRecord: null };
}

export function assertRecordType(value: string): ShareRecordType {
  if (value !== "contact" && value !== "company" && value !== "deal" && value !== "invoice") {
    throw new PartnerError("Record type must be contact, company, deal, or invoice");
  }
  return value;
}
