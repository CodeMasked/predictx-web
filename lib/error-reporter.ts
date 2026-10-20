/**
 * lib/error-reporter.ts
 *
 * Lightweight, dependency-free error reporter.
 * Sends a structured payload to /api/report-error via navigator.sendBeacon
 * (falls back to fetch) so the report fires even during page unload.
 *
 * Context (route, component) is attached to every report.
 */

export interface ErrorContext {
  route?: string;
  component?: string;
  extra?: Record<string, unknown>;
}

export interface ErrorPayload {
  type: "caught-error" | "uncaught-error" | "unhandled-rejection";
  message: string;
  digest?: string;
  stack?: string;
  route?: string;
  component?: string;
  extra?: Record<string, unknown>;
  timestamp: string;
  userAgent?: string;
}

/** Report a caught error (React error boundary or try/catch). */
export function reportError(
  error: Error & { digest?: string },
  ctx: ErrorContext = {},
): void {
  if (typeof window === "undefined") return; // SSR — skip

  const payload: ErrorPayload = {
    type: "caught-error",
    message: error.message,
    digest: error.digest,
    stack: error.stack,
    route: ctx.route ?? window.location.pathname,
    component: ctx.component,
    extra: ctx.extra,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };

  _send(payload);
}

/**
 * Module-level flag that prevents double-registration.
 *
 * Set to `true` the first time {@link installGlobalErrorHandlers} runs and
 * reset to `false` when the returned cleanup function is called.  This makes
 * the function safe to call from React Strict Mode (which double-invokes
 * effects in development) and from any Fast Refresh remount.
 */
let _handlersInstalled = false;

/**
 * Install global window.onerror + unhandledrejection handlers.
 *
 * Idempotent: a second call while the handlers are already registered is a
 * no-op and returns a no-op cleanup so callers can always call the returned
 * function safely.
 *
 * Chains to any pre-existing `window.onerror` so third-party libraries that
 * set their own handler before this call are not clobbered.
 *
 * @returns A cleanup function that removes both handlers and resets the
 *   idempotency flag so the handlers can be re-installed if needed (e.g. in
 *   tests).  Pass it as the return value of the `useEffect` that calls this
 *   function.
 */
export function installGlobalErrorHandlers(): () => void {
  if (typeof window === "undefined") return () => {};

  // Guard: already installed — return a no-op cleanup.
  if (_handlersInstalled) return () => {};

  _handlersInstalled = true;

  // ── window.onerror ───────────────────────────────────────────────────────
  // Preserve any handler registered by another library before us so we can
  // forward to it after reporting.
  const previousOnerror = window.onerror ?? null;

  const onerrorHandler: OnErrorEventHandler = (
    message,
    source,
    lineno,
    colno,
    error,
  ) => {
    const payload: ErrorPayload = {
      type: "uncaught-error",
      message: String(message),
      stack: error?.stack,
      route: window.location.pathname,
      extra: { source, lineno, colno },
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
    };
    _send(payload);

    // Chain to the previous handler if one existed.
    if (typeof previousOnerror === "function") {
      return previousOnerror(message, source, lineno, colno, error);
    }

    // Return false so the browser's default error handling still fires.
    return false;
  };

  window.onerror = onerrorHandler;

  // ── unhandledrejection ───────────────────────────────────────────────────
  const rejectionHandler = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const payload: ErrorPayload = {
      type: "unhandled-rejection",
      message:
        reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      route: window.location.pathname,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
    };
    _send(payload);
  };

  window.addEventListener("unhandledrejection", rejectionHandler);

  // ── cleanup ──────────────────────────────────────────────────────────────
  return () => {
    window.removeEventListener("unhandledrejection", rejectionHandler);

    // Restore the handler that was in place before we installed ours.
    window.onerror = previousOnerror;

    _handlersInstalled = false;
  };
}

// ─── internal ────────────────────────────────────────────────────────────────

function _send(payload: ErrorPayload): void {
  try {
    const body = JSON.stringify(payload);

    if (navigator.sendBeacon) {
      // Preferred: fires even during page unload
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon("/api/report-error", blob);
    } else {
      // Fallback: fire-and-forget fetch
      fetch("/api/report-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        // Swallow — reporting must never throw
      });
    }
  } catch {
    // Swallow — reporting must never throw
  }
}
