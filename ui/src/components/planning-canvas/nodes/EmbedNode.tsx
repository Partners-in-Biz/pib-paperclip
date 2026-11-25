import { memo, useMemo } from "react";
import type { PlanningCanvasEmbedData } from "@paperclipai/shared";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { PlaceholderCard } from "@/components/planning-canvas/nodes/node-renderers";
import { useCanvasPluginProps } from "@/components/planning-canvas/nodes/useCanvasPluginProps";

/**
 * An embed node: the card of a plugin's `canvasNode` slot. Whether it can be drawn depends only on
 * the installed plugin list (plugin key and slot id), never on `props`. Without the plugin the node
 * is the placeholder card; it still moves, resizes and deletes. The plugin receives `props` as data
 * to draw as text; the host mounts no iframe and no raw HTML.
 */
export const EmbedNode = memo(function EmbedNode({ nodeKey, data, isSelected }: { nodeKey: string; data: PlanningCanvasEmbedData; isSelected: boolean }) {
  const c = useLatestCanvas().current;
  const { slots } = usePluginSlots({ slotTypes: ["canvasNode"], companyId: c.selectedCompanyId });
  const slot = useMemo(() => slots.find((s) => s.pluginKey === data.plugin && s.id === data.type), [slots, data.plugin, data.type]);
  const board = useCanvasPluginProps(c, isSelected ? [nodeKey] : []);

  if (!slot) {
    return <PlaceholderCard kind="embed" label="Plugin not installed" />;
  }
  return (
    <div className="h-full min-w-0 overflow-hidden rounded-xl" data-canvas-embed={data.plugin}>
      <PluginSlotMount
        slot={slot}
        context={{ companyId: c.selectedCompanyId, projectId: board.boardProjectId, entityId: board.boardId }}
        componentProps={{ ...board, nodeKey, assetId: data.assetId ?? null, props: data.props }}
        fallback={<PlaceholderCard kind="embed" label="Plugin not installed" />}
      />
    </div>
  );
});
