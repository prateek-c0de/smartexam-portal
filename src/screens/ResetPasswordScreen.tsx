import { useState } from 'react';
import Logo from '@/components/Logo';
import Button from '@/components/Button';
import { Lock, AlertCircle, CheckCircle2, Eye, EyeOff, ArrowLeft } from 'lucide-react';
import { AppError } from '@/lib/supabase';
import { authService, validateStrongPassword } from '@/services/authService';

interface ResetPasswordScreenProps {
  emailHint?: string;
  onComplete: () => void;
}

export default function ResetPasswordScreen({ emailHint = '', onComplete }: ResetPasswordScreenProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const pwCheck = password ? validateStrongPassword(password, emailHint) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    const validation = validateStrongPassword(password, emailHint);
    if (!validation.valid) {
      setError(`Password requirements: ${validation.errors.join(', ')}.`);
      return;
    }

    setLoading(true);
    try {
      await authService.completePasswordReset(password, emailHint);
      setDone(true);
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      setError(appErr?.message ?? 'Could not update your password. Request a fresh reset link and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50">
      <div className="border-b border-neutral-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Logo />
          <button
            onClick={onComplete}
            className="flex items-center gap-2 text-sm font-semibold text-neutral-600 hover:text-brand-600 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Sign In
          </button>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md bg-white rounded-2xl card-shadow-lg p-8 animate-slide-up">
          <h2 className="text-2xl font-bold text-neutral-900 text-center mb-1">Set New Password</h2>
          <p className="text-sm text-neutral-500 text-center mb-8">
            Choose a strong password for your SmartExam account.
          </p>

          {error && (
            <div className="flex items-start gap-2 p-3 mb-5 rounded-xl bg-error-50 border border-error-200 text-error-700 text-sm animate-fade-in">
              <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {done ? (
            <div className="space-y-5 text-center">
              <div className="flex items-center justify-center gap-2 p-4 rounded-xl bg-success-50 border border-success-200 text-success-700 text-sm font-semibold">
                <CheckCircle2 className="h-5 w-5" />
                Your password has been updated securely.
              </div>
              <Button fullWidth size="lg" onClick={onComplete}>
                Continue
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-semibold text-neutral-700 mb-1.5">
                  New Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-neutral-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 10 characters"
                    className="w-full pl-11 pr-11 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
                {pwCheck && !pwCheck.valid && (
                  <p className="mt-1.5 text-xs text-warning-700">
                    Needed: {pwCheck.errors.join(' · ')}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-neutral-700 mb-1.5">
                  Confirm New Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-neutral-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    className="w-full pl-11 pr-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              <Button type="submit" fullWidth size="lg" disabled={loading}>
                {loading ? 'Updating…' : 'Update Password'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
