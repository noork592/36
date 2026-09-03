import React from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

/**
 * App-wide error boundary.
 *
 * Previously, any runtime error thrown while rendering a page would unmount
 * the whole React tree and leave the user staring at a BLANK WHITE SCREEN.
 * This boundary catches those errors and shows a friendly recovery card with
 * "Try again" and "Go to Dashboard" actions instead, so the app never dies
 * silently. It also auto-recovers on route change via the `resetKey` prop.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Surface the error for debugging without crashing the UI.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] Caught render error:", error, info);
  }

  componentDidUpdate(prevProps) {
    // Reset the boundary when the route (resetKey) changes so navigating
    // away from a broken page restores a working screen automatically.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  handleHome = () => {
    window.location.href = "/";
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg shadow-sm p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center mb-5">
            <AlertTriangle className="w-7 h-7 text-amber-600" />
          </div>
          <h1 className="text-lg font-bold text-slate-900">Something went wrong</h1>
          <p className="text-sm text-slate-600 mt-2 leading-relaxed">
            The screen hit an unexpected error. Your data is safe — you can
            reload this page or head back to the dashboard.
          </p>
          {this.state.error?.message && (
            <p className="mt-3 text-[11px] font-mono text-slate-400 break-words">
              {String(this.state.error.message).slice(0, 200)}
            </p>
          )}
          <div className="mt-6 flex flex-col sm:flex-row gap-2.5 justify-center">
            <button
              onClick={this.handleReload}
              data-testid="error-boundary-reload"
              className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-sm bg-[#E65100] hover:bg-[#CC4800] text-white text-sm font-bold transition-colors"
            >
              <RefreshCw className="w-4 h-4" /> Try again
            </button>
            <button
              onClick={this.handleHome}
              data-testid="error-boundary-home"
              className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-sm border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-semibold transition-colors"
            >
              <Home className="w-4 h-4" /> Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
