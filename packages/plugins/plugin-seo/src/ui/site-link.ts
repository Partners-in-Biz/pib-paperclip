/**
 * What the SEO page's "Site repo" form sends to `link-site` (no React here, so tests can import it).
 *
 * The form always names the project it shows (`projectId`), so the server cannot tell "re-save" from "link": the
 * branch is therefore sent only when somebody typed it. A branch the form merely displays is never sent back, or a
 * project's work branch (its workspace policy) would lose to the value read earlier.
 */

export interface SiteLinkForm {
  sprintId: string;
  /** The select's value: a project id, `wp:<site id>`, `__none` or empty. */
  choice: string;
  branch: string;
  /** The branch field was typed in since the form last reset. */
  branchEdited: boolean;
  hosting: string;
  changePolicy: string;
}

export const WORDPRESS_PREFIX = "wp:";

/** The `link-site` params for the form. */
export function siteLinkParams(form: SiteLinkForm): Record<string, unknown> {
  const wordpressId = form.choice.startsWith(WORDPRESS_PREFIX) ? form.choice.slice(WORDPRESS_PREFIX.length) : null;
  return {
    sprintId: form.sprintId,
    ...(form.choice === "__none" ? { noRepo: true } : wordpressId ? { wordpressSiteId: wordpressId } : form.choice ? { projectId: form.choice } : {}),
    ...(form.branchEdited && form.branch.trim() && !wordpressId ? { defaultBranch: form.branch.trim() } : {}),
    ...(form.hosting ? { hosting: form.hosting } : {}),
    changePolicy: form.changePolicy,
  };
}

/**
 * The branch the field shows: what was typed, or the sprint's own branch while its project is picked, or the work
 * branch the server will use for a newly picked project.
 */
export function shownBranch(input: { branchEdited: boolean; choice: string; currentChoice: string; branch: string; pickedBranch: string | null }): string {
  return input.branchEdited || input.choice === input.currentChoice ? input.branch : input.pickedBranch ?? input.branch;
}
