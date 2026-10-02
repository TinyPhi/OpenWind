import React from "react";

type State = { error: Error | null };

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

  componentDidUpdate(prev: { resetKey?: string }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          padding: "32px",
          color: "var(--text-muted)",
          fontSize: "14px",
        }}
      >
        <p style={{ marginBottom: "12px" }}>
          This page failed to load. It may have been updated — reload to get the
          latest version.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ cursor: "pointer" }}
        >
          Reload
        </button>
      </div>
    );
  }
}
