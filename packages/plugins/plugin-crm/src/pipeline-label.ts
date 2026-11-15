/** "Open pipeline · Sales" once a company has more than one pipeline, so the figure says which one it counts. */
export function openPipelineLabel(summary: { defaultPipelineName?: string | null; pipelineCount?: number } | undefined): string {
  return summary?.pipelineCount && summary.pipelineCount > 1 && summary.defaultPipelineName ? `Open pipeline · ${summary.defaultPipelineName}` : "Open pipeline";
}
