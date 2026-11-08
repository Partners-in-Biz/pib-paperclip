/** Timeline. Stub (PAR-8313): a later ticket fills it. EditorPage mounts it as <Timeline store={store} />. */
import type { EditorStore } from "./editor-store.js";
import { clipCount } from "./editor-store.js";

export function Timeline({ store }: { store: EditorStore }) {
  const { doc } = store.getState();
  return (
    <section aria-label="Timeline" data-editor-panel="timeline" style={{ border: "1px dashed #8886", borderRadius: 8, padding: 16, minWidth: 0 }}>
      Timeline · {doc?.tracks.length ?? 0} tracks · {clipCount(doc)} clips
    </section>
  );
}
