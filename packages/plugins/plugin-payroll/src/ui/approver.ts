/**
 * "Who approves pay runs": the pure parts of the people picker (no React,
 * no fetch). People come from the host's user directory and show by name
 * (email as the muted detail), never by id. The choice is saved into
 * Payroll's own settings as `approval.defaultApproverUserId`, keeping every
 * other saved key (secret refs included).
 */

export interface DirectoryPerson {
  userId: string;
  name: string | null;
  email: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `GET /api/companies/:id/user-directory` (`{ users: [{ principalId, status, user }] }`) → the active people, once each. */
export function parseUserDirectory(body: unknown): DirectoryPerson[] {
  const users = Array.isArray(record(body).users) ? (record(body).users as unknown[]) : [];
  const seen = new Set<string>();
  const out: DirectoryPerson[] = [];
  for (const raw of users) {
    const row = record(raw);
    const userId = text(row.principalId);
    if (!userId || seen.has(userId)) continue;
    if (typeof row.status === "string" && row.status !== "active") continue;
    const user = record(row.user);
    seen.add(userId);
    out.push({ userId, name: text(user.name), email: text(user.email) });
  }
  return out;
}

/** A person as people read them: their name, else their email, else "You" or "A board member". Never an id. */
export function personName(person: { name?: string | null; email?: string | null } | null | undefined, isYou = false): string {
  return text(person?.name) ?? text(person?.email) ?? (isYou ? "You" : "A board member");
}

export interface ApproverOption {
  userId: string;
  name: string;
  /** The muted detail line (their email), when it adds something. */
  detail: string | null;
  isYou: boolean;
  /** Recent pay runs this person prepared. Nobody approves a run they prepared. */
  preparedRuns: number;
}

/** Everyone who can approve, by name, with how many recent runs each prepared. */
export function approverOptions(
  people: readonly DirectoryPerson[],
  input: { me: string | null; runs: ReadonlyArray<{ preparedBy: { kind: string; id: string } | null }> },
): ApproverOption[] {
  const prepared = new Map<string, number>();
  for (const run of input.runs) {
    if (run.preparedBy?.kind === "user") prepared.set(run.preparedBy.id, (prepared.get(run.preparedBy.id) ?? 0) + 1);
  }
  return people
    .map((person) => {
      const isYou = person.userId === input.me;
      const name = personName(person, isYou);
      return { userId: person.userId, name, detail: person.email && person.email !== name ? person.email : null, isYou, preparedRuns: prepared.get(person.userId) ?? 0 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a choice is a problem ("…prepared 2 recent pay runs…"), or null. */
export function approverWarning(option: Pick<ApproverOption, "name" | "isYou" | "preparedRuns"> | null | undefined): string | null {
  if (!option || option.preparedRuns <= 0) return null;
  const runs = `${option.preparedRuns} recent pay run${option.preparedRuns === 1 ? "" : "s"}`;
  const those = option.preparedRuns === 1 ? "it" : "those";
  return option.isYou
    ? `You prepared ${runs}, so you can't approve ${those}. Let the Payroll Clerk or someone else prepare the runs.`
    : `${option.name} prepared ${runs}, so they can't approve ${those}. Let the Payroll Clerk or someone else prepare the runs.`;
}

/** The chosen approver's name for use inside a sentence ("approved by …"), or null when nobody is chosen. */
export function approverName(userId: string | null | undefined, people: readonly DirectoryPerson[] | null, me: string | null): string | null {
  if (!userId) return null;
  const person = people?.find((p) => p.userId === userId);
  if (person) {
    const name = personName(person, userId === me);
    return name === "You" ? "you" : name;
  }
  if (userId === me) return "you";
  return people ? "someone who is no longer a member" : "the person chosen in the settings";
}

/**
 * The FULL saved settings with only `approval.defaultApproverUserId` changed
 * (`null` removes it). Every other key stays as saved, secret refs included.
 * The input is not changed.
 */
export function withDefaultApprover(config: Record<string, unknown>, userId: string | null): Record<string, unknown> {
  const approval: Record<string, unknown> = { ...record(config.approval) };
  if (userId) approval.defaultApproverUserId = userId;
  else delete approval.defaultApproverUserId;
  return { ...config, approval };
}

/** One plain sentence for a save the host refused. */
export function saveErrorText(status: number): string {
  if (status === 401 || status === 403) return "Only an instance admin can change this setting.";
  if (status === 400 || status === 422) return "The Payroll settings could not be saved as they are. Open the settings page and save them there once.";
  return "Couldn't save the approver. Try again.";
}
