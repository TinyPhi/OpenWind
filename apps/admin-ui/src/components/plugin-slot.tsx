/**
 * <PluginSlot> — renders a plugin's UI contribution to a named slot, isolated
 * behind its own error boundary (3B Phase 3, R7). A failure loading or
 * rendering one plugin's component must never take down the host page or any
 * other slot/plugin on it.
 *
 * `load` is injected rather than this component calling
 * lib/plugin-remote-loader.ts directly — that keeps the isolation/boundary
 * logic (the part R7 actually cares about and the part this file tests for
 * real) decoupled from the Module Federation wiring (which needs a real
 * remote to meaningfully exercise, covered separately in
 * plugin-remote-loader.test.ts).
 */

import React from "react";
import { logPluginSlotError } from "../lib/plugin-slot-errors.js";

export interface PluginSlotProps {
  pluginSlug: string;
  slotName: string;
  load: () => Promise<React.ComponentType>;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

interface ErrorBoundaryProps {
  pluginSlug: string;
  slotName: string;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

class PluginErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    logPluginSlotError(this.props.pluginSlug, this.props.slotName, error);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}

/**
 * Loads `load()` on mount and renders the result once resolved. Deliberately
 * not React.lazy/Suspense: React.lazy's own rule is "always define lazy
 * components outside your components" — its loader is meant to be a single,
 * module-scope-stable reference, not something re-created per (pluginSlug,
 * slotName) pair at render time the way a dynamic plugin remote requires.
 * A load() rejection is stored in state and re-thrown synchronously on the
 * next render — the standard way to get an error boundary to catch an async
 * failure, since boundaries only catch synchronous render-time throws.
 */
function LazyPluginComponent({
  load,
}: Pick<PluginSlotProps, "load">): React.ReactElement | null {
  const [Component, setComponent] = React.useState<React.ComponentType | null>(
    null,
  );
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    load().then(
      (Loaded) => {
        if (!cancelled) setComponent(() => Loaded);
      },
      (err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // Deliberately empty deps: `load` is expected to be stable per
    // (pluginSlug, slotName) pair from the caller; re-running on every
    // render would re-fetch the remote each time.
  }, []);

  if (error) throw error;
  if (!Component) return null;
  return <Component />;
}

export function PluginSlot({
  pluginSlug,
  slotName,
  load,
  fallback,
}: PluginSlotProps): React.ReactElement {
  return (
    <PluginErrorBoundary
      pluginSlug={pluginSlug}
      slotName={slotName}
      fallback={fallback}
    >
      <LazyPluginComponent load={load} />
    </PluginErrorBoundary>
  );
}
