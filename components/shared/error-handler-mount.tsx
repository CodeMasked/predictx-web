"use client";

import { useEffect } from "react";
import { installGlobalErrorHandlers } from "@/lib/error-reporter";

/**
 * Mounts window.onerror + unhandledrejection handlers once on the client.
 * Renders nothing — drop it anywhere in the layout tree.
 */
export function ErrorHandlerMount() {
  useEffect(() => {
    // installGlobalErrorHandlers is idempotent — safe under React Strict Mode.
    // The returned cleanup removes both listeners and resets the flag so a
    // subsequent mount (e.g. after a Fast Refresh) can re-install cleanly.
    return installGlobalErrorHandlers();
  }, []);

  return null;
}
