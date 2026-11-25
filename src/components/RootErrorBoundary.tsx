import { Component, type ErrorInfo, type ReactNode } from 'react';
import Logo from '@/components/Logo';
import Button from '@/components/Button';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export default class RootErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[SmartExam] Recoverable UI boundary caught error:', error.message, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-50 px-6">
          <div className="w-full max-w-md bg-white rounded-2xl card-shadow-lg p-8 text-center space-y-5">
            <div className="flex justify-center">
              <Logo size="sm" />
            </div>
            <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-error-50 text-error-600 mx-auto">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-neutral-900">Something interrupted the page</h2>
              <p className="text-sm text-neutral-500 mt-1">
                Your session and saved answers remain intact. Click below to reload SmartExam.
              </p>
            </div>
            <Button
              fullWidth
              onClick={() => {
                this.setState({ hasError: false });
                window.location.href = '/';
              }}
            >
              <RefreshCw className="h-4 w-4" />
              Reload SmartExam
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
