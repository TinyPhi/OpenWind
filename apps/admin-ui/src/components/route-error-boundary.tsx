import React from "react";

type State = { error: Error | null };

const CHUNK_ERROR_PATTERN =
  /Loading chunk|dynamically imported module|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

function isChunkLoadError(error: Error | null): boolean {
  if (!error) return false;
  if (error.name === "ChunkLoadError") return true;
  return CHUNK_ERROR_PATTERN.test(error.message || "");
}

/**
 * Catches render/lazy-chunk errors for a single route outlet so the app shell
 * (sidebar, header) stays usable. A failed dynamic import after a redeploy is
 * the common case: the old tab references chunk hashes that no longer exist.
 */
export class RouteErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: string },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("RouteErrorBoundary caught error:", error, errorInfo);
  }

  componentDidUpdate(prev: { resetKey?: string }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isChunk = isChunkLoadError(error);

    return (
      <div
        role="alert"
        style={{
          padding: "32px",
          color: "var(--text-muted)",
          fontSize: "14px",
        }}
      >
        {isChunk ? (
          <>
            <p style={{ marginBottom: "12px" }}>
              This page may have been updated. Reload to get the latest version.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ cursor: "pointer" }}
            >
              Reload
            </button>
          </>
        ) : (
          <>
            <p style={{ marginBottom: "12px" }}>
              Something went wrong while loading this page.
            </p>
            <button
              type="button"
              onClick={this.handleRetry}
              style={{ cursor: "pointer" }}
            >
              Retry
            </button>
          </>
        )}
      </div>
    );
  }
}
