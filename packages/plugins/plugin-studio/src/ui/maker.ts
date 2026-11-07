import { useEffect, useState } from "react";
import { loadDirectory, makerLabel, type MadeBy } from "./people.js";

/** "Made by" label for an asset: the person's name instead of their user id (PAR-8120). */
export function useMakerLabel(companyId: string | null | undefined, made: MadeBy): string {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  const wantsName = Boolean(companyId && made?.userId && !made?.agentId);
  useEffect(() => {
    if (!wantsName || !companyId) return;
    let live = true;
    void loadDirectory(companyId).then((found) => {
      if (live) setNames(found);
    });
    return () => {
      live = false;
    };
  }, [companyId, wantsName]);
  return makerLabel(made, names);
}
