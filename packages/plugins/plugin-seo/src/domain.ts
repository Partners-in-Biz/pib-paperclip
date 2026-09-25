export class SeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeoError";
  }
}

export function sprintTask(sprint: { id: string; name: string }, title: string): {
  title: string;
  description: string;
  originId: string;
  originKind: "plugin:partnersinbiz.seo";
} {
  const task = title.trim();
  if (!task) throw new SeoError("Task title is required");
  return {
    title: task,
    description: `Sprint ${sprint.id}: ${sprint.name}`,
    originId: sprint.id,
    originKind: "plugin:partnersinbiz.seo",
  };
}
