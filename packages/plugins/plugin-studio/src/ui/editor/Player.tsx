/** Preview player. Stub (PAR-8313): a later ticket fills it. EditorPage mounts it as <Player store={store} />. */
import type { EditorStore } from "./editor-store.js";

export function Player({ store }: { store: EditorStore }) {
  const { doc } = store.getState();
  return (
    <section aria-label="Player" data-editor-panel="player" style={{ border: "1px dashed #8886", borderRadius: 8, padding: 16, minWidth: 0 }}>
      Player{doc ? ` · ${doc.project.width}×${doc.project.height}` : ""}
    </section>
  );
}
