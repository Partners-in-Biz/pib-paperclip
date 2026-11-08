/** Render panel. Stub (PAR-8313): a later ticket fills it. EditorPage mounts it as <RenderPanel store={store} />. */
import type { EditorStore } from "./editor-store.js";

export function RenderPanel({ store }: { store: EditorStore }) {
  const { revision } = store.getState();
  return (
    <section aria-label="Render" data-editor-panel="render" style={{ border: "1px dashed #8886", borderRadius: 8, padding: 16, minWidth: 0 }}>
      Render{revision !== null ? ` · revision ${revision}` : ""}
    </section>
  );
}
