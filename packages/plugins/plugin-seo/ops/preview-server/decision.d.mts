export const SCHEMA: string;
export const DECISION_SQL: string;
export const DECISION_STATE_SQL: string;
export const ALREADY_ANSWERED: string;
export const NOT_READY: string;
export const DECLINED_PAGE: string;
export function refusedAnswer(status: string | null | undefined): string;
