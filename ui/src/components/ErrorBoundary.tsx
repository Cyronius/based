// A small, reusable error boundary. React has no hook equivalent — catching a render/effect throw
// still requires a class component. Renders `fallback` in place of a subtree that threw, so one
// failing pane (e.g. a WebGL view whose context could not start) degrades locally instead of blanking
// the whole window via React's default uncaught-error handler.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown when a child throws. A function receives the error so callers can tailor the message. */
  fallback: ReactNode | ((error: Error) => ReactNode);
  /** Optional side effect (logging, telemetry) on the first catch. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return typeof this.props.fallback === "function" ? this.props.fallback(error) : this.props.fallback;
    }
    return this.props.children;
  }
}
