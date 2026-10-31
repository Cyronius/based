// Traces: BASED-UI-ERROR-BOUNDARY — a render error replaces one region, never the whole window.
import { Component, type ReactNode } from "react";
import { ErrorDetail } from "./ErrorDetail";

interface Props {
  /** A new key clears a caught error (another tab, another view). */
  resetKey?: unknown;
  fallback: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error) => void;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null; key: unknown }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; key: unknown }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  render() {
    if (this.state.error) return this.props.fallback(this.state.error, () => this.setState({ error: null }));
    return this.props.children;
  }
}

export function ErrorPanel({ title, error, children }: { title: string; error: Error; children?: ReactNode }) {
  const text = error.stack && !error.stack.startsWith(error.message) ? `${error.message}\n${error.stack}` : (error.stack ?? error.message);
  return (
    <div role="alert" className="flex-1 min-h-0 overflow-auto p-6">
      <div className="max-w-2xl space-y-3 text-[length:var(--fs-base)]">
        <div className="text-paper font-semibold">{title}</div>
        <ErrorDetail message={text} />
        {children && <div className="flex gap-2 pt-1">{children}</div>}
      </div>
    </div>
  );
}

export const panelBtn = "px-3 py-1 rounded border border-line text-paper-dim hover:text-paper hover:border-brass-soft";
