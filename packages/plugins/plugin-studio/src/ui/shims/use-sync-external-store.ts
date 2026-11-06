/**
 * Stands in for the `use-sync-external-store` package in the page bundle (PAR-7750 settings). React Flow's store
 * (zustand 4) imports the old shim; React 18+ has `useSyncExternalStore` built in, and React itself is the host's copy,
 * so the bundle must not carry a second one. esbuild.config.mjs points every `use-sync-external-store/*` import here.
 * The selector version follows React's own `with-selector` implementation.
 */
import { useDebugValue, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

type Subscribe = (onChange: () => void) => () => void;

export { useSyncExternalStore };

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: Subscribe,
  getSnapshot: () => Snapshot,
  getServerSnapshot: undefined | null | (() => Snapshot),
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  const instRef = useRef<{ hasValue: boolean; value: Selection | null } | null>(null);
  if (instRef.current === null) instRef.current = { hasValue: false, value: null };
  const inst = instRef.current;

  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false;
    let memoSnapshot: Snapshot;
    let memoSelection: Selection;
    const memoSelector = (next: Snapshot): Selection => {
      if (!hasMemo) {
        hasMemo = true;
        memoSnapshot = next;
        const selection = selector(next);
        if (isEqual !== undefined && inst.hasValue && isEqual(inst.value as Selection, selection)) {
          memoSelection = inst.value as Selection;
          return memoSelection;
        }
        memoSelection = selection;
        return selection;
      }
      if (Object.is(memoSnapshot, next)) return memoSelection;
      const selection = selector(next);
      if (isEqual !== undefined && isEqual(memoSelection, selection)) {
        memoSnapshot = next;
        return memoSelection;
      }
      memoSnapshot = next;
      memoSelection = selection;
      return selection;
    };
    const server = getServerSnapshot ?? null;
    return [() => memoSelector(getSnapshot()), server === null ? undefined : () => memoSelector(server())] as const;
  }, [getSnapshot, getServerSnapshot, selector, isEqual]);

  const value = useSyncExternalStore(subscribe, getSelection, getServerSelection);
  useEffect(() => {
    inst.hasValue = true;
    inst.value = value;
  }, [value]);
  useDebugValue(value);
  return value;
}

export default { useSyncExternalStore, useSyncExternalStoreWithSelector };
