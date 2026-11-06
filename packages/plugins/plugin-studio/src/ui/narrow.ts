import { useEffect, useState } from "react";

const NARROW_QUERY = "(max-width: 640px)";

/** True on a phone-width viewport; follows rotation and window resizes. Its own file so CanvasPage can use it without importing index.tsx. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
