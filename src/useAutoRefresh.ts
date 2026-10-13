import { useEffect, useRef } from "react";

/** Read-only refresh; never replay a purchase/stock mutation in the background. */
export function useAutoRefresh(
  refresh: () => Promise<unknown>,
  canRefresh: () => boolean,
) {
  const latest = useRef({ refresh, canRefresh });
  latest.current = { refresh, canRefresh };
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible" && latest.current.canRefresh())
        void latest.current.refresh().catch(() => {});
    };
    window.addEventListener("focus", update);
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", update);
    const timer = window.setInterval(update, 60000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
}
