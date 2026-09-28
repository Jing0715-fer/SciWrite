"use client";

import * as React from "react";

/**
 * ErrorBoundary — catches render errors in child components and shows
 * a retry button instead of crashing the whole app.
 * Used around lazy-loaded dialogs that may fail to load their chunk.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex items-center justify-center p-8 text-center">
          <div>
            <p className="text-sm text-muted-foreground mb-2">
              Failed to load this component.
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: undefined })}
              className="text-xs text-primary hover:underline"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
