import { Component } from 'react';
import { logError } from '../lib/logger';

/**
 * ErrorBoundary - catches unhandled React errors and reports them.
 * Renders a recovery UI matching the dark theme.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    logError(`Unhandled React error: ${error.message}`, {
      component: 'ErrorBoundary',
      errorName: error.name,
      errorStack: error.stack,
      metadata: { componentStack: errorInfo?.componentStack?.slice(0, 1000) },
    });

    // Report to Sentry if available
    if (typeof window !== 'undefined' && window.__SENTRY__) {
      try {
        import('@sentry/react').then((Sentry) => {
          Sentry.captureException(error, { contexts: { react: { componentStack: errorInfo?.componentStack } } });
        });
      } catch {
        // Sentry not available
      }
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleDismiss = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#030303] p-6">
          <div className="bg-[#1a1a1b] border border-[#343536] rounded-lg p-8 max-w-md w-full text-center">
            <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">Something went wrong</h2>
            <p className="text-[#818384] mb-1">An unexpected error occurred in the application.</p>
            {this.state.error && (
              <p className="text-xs text-red-400 font-mono mb-4 break-all">
                {this.state.error.message}
              </p>
            )}
            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleReload}
                className="px-4 py-2 bg-[#ff4500] text-white rounded-lg hover:bg-[#ff5722] transition-colors text-sm"
              >
                Reload Page
              </button>
              <button
                onClick={this.handleDismiss}
                className="px-4 py-2 bg-[#272729] text-white rounded-lg hover:bg-[#343536] transition-colors text-sm"
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
