import { useState } from 'react';
import Logo from '@/components/Logo';
import Button from '@/components/Button';
import {
  ArrowLeft,
  Mail,
  Lock,
  Users,
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  User as UserIcon,
  Building2,
} from 'lucide-react';
import type { Role, User } from '@/types';
import { AppError } from '@/lib/supabase';
import { authService, validateStrongPassword } from '@/services/authService';

interface LoginScreenProps {
  role: Role;
  onBack: () => void;
  onLogin: (user: User) => void;
}

type AuthMode = 'signin' | 'register' | 'forgot';

export default function LoginScreen({ role, onBack, onLogin }: LoginScreenProps) {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [fullName, setFullName] = useState('');
  const [institution, setInstitution] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const isStudent = role === 'student';

  function switchMode(next: AuthMode) {
    setMode(next);
    setError('');
    setErrorCode('');
    setInfoMessage('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setErrorCode('');
    setInfoMessage('');

    if (mode === 'forgot') {
      if (!email.trim()) {
        setError('Please enter your email address.');
        return;
      }
      setLoading(true);
      try {
        await authService.requestPasswordReset(email);
        setInfoMessage(
          'If an account exists for that email address, a password reset link has been sent.'
        );
      } catch (err) {
        const appErr = err instanceof AppError ? err : null;
        setError(appErr?.message ?? 'Could not send reset email. Please try again.');
      } finally {
        setLoading(false);
      }
      return;
    }

    if (mode === 'register') {
      if (!fullName.trim() || !email.trim() || !password) {
        setError('Please fill in your full name, email address, and password.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      const pwCheck = validateStrongPassword(password, email);
      if (!pwCheck.valid) {
        setError(`Strong password required: ${pwCheck.errors.join(', ')}.`);
        return;
      }

      setLoading(true);
      try {
        const res = await authService.register({
          email,
          password,
          fullName,
          requestedRole: role,
          institution,
        });

        if (res.requiresEmailVerification) {
          setInfoMessage(
            'Account created! Check your inbox and click the verification link before signing in.'
          );
          setMode('signin');
          setPassword('');
          setConfirmPassword('');
          return;
        }

        if (res.user) {
          onLogin(res.user);
        }
      } catch (err) {
        const appErr = err instanceof AppError ? err : null;
        setErrorCode(appErr?.code ?? '');
        setError(appErr?.message ?? 'Registration failed. Please verify your details and try again.');
      } finally {
        setLoading(false);
      }
      return;
    }

    // Sign In
    if (!email.trim() || !password) {
      setError('Please enter both your email and password.');
      return;
    }

    setLoading(true);
    try {
      const verifiedUser = await authService.signIn(email, password, role);
      onLogin(verifiedUser);
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      setErrorCode(appErr?.code ?? '');
      setError(appErr?.message ?? 'Unable to sign in. Please check your credentials and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResendVerification() {
    if (!email.trim()) return;
    setLoading(true);
    try {
      await authService.resendVerificationEmail(email);
      setError('');
      setErrorCode('');
      setInfoMessage('Verification email resent. Please check your inbox and spam folder.');
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      setError(appErr?.message ?? 'Unable to resend verification email.');
    } finally {
      setLoading(false);
    }
  }

  const pwValidation = mode === 'register' && password ? validateStrongPassword(password, email) : null;

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50">
      {/* Top bar */}
      <div className="border-b border-neutral-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Logo />
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-sm font-semibold text-neutral-600 hover:text-brand-600 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Home
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <div className="bg-white rounded-2xl card-shadow-lg p-8 animate-slide-up">
            {/* Role badge */}
            <div className="flex items-center justify-center mb-6">
              <div
                className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold ${
                  isStudent
                    ? 'bg-brand-50 text-brand-700'
                    : 'bg-neutral-100 text-neutral-700'
                }`}
              >
                <Users className="h-4 w-4" />
                {isStudent ? 'Student Portal' : 'Teacher Portal'}
              </div>
            </div>

            <h2 className="text-2xl font-bold text-neutral-900 text-center mb-1">
              {mode === 'forgot'
                ? 'Reset Password'
                : mode === 'register'
                  ? isStudent
                    ? 'Create Student Account'
                    : 'Create Faculty Account'
                  : isStudent
                    ? 'Student Sign In'
                    : 'Faculty Sign In'}
            </h2>
            <p className="text-sm text-neutral-500 text-center mb-8">
              {mode === 'forgot'
                ? 'Enter your registered email address to receive a password reset link.'
                : mode === 'register'
                  ? isStudent
                    ? 'Register with your own email and password to attend examinations.'
                    : 'Register with your own faculty email and password to manage examinations.'
                  : isStudent
                    ? 'Sign in with your own student email and password.'
                    : 'Sign in with your own faculty email and password.'}
            </p>

            {error && (
              <div
                role="alert"
                className="flex flex-col gap-2 p-3 mb-5 rounded-xl bg-error-50 border border-error-200 text-error-700 text-sm animate-fade-in"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
                {errorCode === 'EMAIL_UNVERIFIED' && (
                  <button
                    type="button"
                    onClick={handleResendVerification}
                    className="self-start ml-7 text-xs font-semibold text-brand-600 hover:text-brand-700 underline"
                  >
                    Resend verification email
                  </button>
                )}
              </div>
            )}

            {infoMessage && (
              <div
                role="status"
                className="flex items-start gap-2 p-3 mb-5 rounded-xl bg-success-50 border border-success-200 text-success-700 text-sm animate-fade-in"
              >
                <CheckCircle2 className="h-5 w-5 flex-shrink-0 mt-0.5" />
                <span>{infoMessage}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              {mode === 'register' && (
                <div>
                  <label className="block text-sm font-semibold text-neutral-700 mb-1.5">
                    Full Name
                  </label>
                  <div className="relative">
                    <UserIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-neutral-400" />
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder={isStudent ? 'Alex Rivera' : 'Prof. Ada Lovelace'}
                      className="w-full pl-11 pr-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                      autoComplete="name"
                    />
                  </div>
                </div>
              )}

              {mode === 'register' && !isStudent && (
                <div>
                  <label className="block text-sm font-semibold text-neutral-700 mb-1.5">
                    Department / Institution
                  </label>
                  <div className="relative">
                    <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-neutral-400" />
                    <input
                      type="text"
                      value={institution}
                      onChange={(e) => setInstitution(e.target.value)}
                      placeholder="Computer Science Department"
                      className="w-full pl-11 pr-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                      autoComplete="organization"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-semibold text-neutral-700 mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-neutral-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={
                      isStudent ? 'student@university.edu' : 'faculty@university.edu'
                    }
                    className="w-full pl-11 pr-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                    autoComplete="email"
                  />
                </div>
              </div>

              {mode !== 'forgot' && (
                <div>
                  <label className="block text-sm font-semibold text-neutral-700 mb-1.5">
                    Password
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-neutral-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={mode === 'register' ? 'Minimum 10 characters' : 'Enter your password'}
                      className="w-full pl-11 pr-11 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                      autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                    >
                      {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                  {pwValidation && !pwValidation.valid && (
                    <p className="mt-1.5 text-xs text-warning-700">
                      Needed: {pwValidation.errors.join(' · ')}
                    </p>
                  )}
                </div>
              )}

              {mode === 'register' && (
                <div>
                  <label className="block text-sm font-semibold text-neutral-700 mb-1.5">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-neutral-400" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter your password"
                      className="w-full pl-11 pr-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              )}

              {mode === 'signin' && (
                <div className="flex items-center justify-between text-sm">
                  <label className="flex items-center gap-2 text-neutral-600 cursor-pointer">
                    <input
                      type="checkbox"
                      defaultChecked
                      className="rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                    />
                    Keep me signed in
                  </label>
                  <button
                    type="button"
                    onClick={() => switchMode('forgot')}
                    className="text-brand-600 font-semibold hover:text-brand-700"
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              <Button type="submit" fullWidth size="lg" disabled={loading}>
                {loading
                  ? mode === 'forgot'
                    ? 'Sending link…'
                    : mode === 'register'
                      ? 'Creating account…'
                      : 'Signing in…'
                  : mode === 'forgot'
                    ? 'Send Reset Link'
                    : mode === 'register'
                      ? isStudent
                        ? 'Create Student Account'
                        : 'Create Faculty Account'
                      : `Sign In as ${isStudent ? 'Student' : 'Teacher'}`}
              </Button>
            </form>

            <div className="mt-6 p-4 rounded-xl bg-neutral-50 border border-neutral-200 text-center space-y-1">
              {mode === 'signin' ? (
                <>
                  <p className="text-xs text-neutral-600">
                    Want to customize your display name?{' '}
                    <button
                      type="button"
                      onClick={() => switchMode('register')}
                      className="font-semibold text-brand-600 hover:text-brand-700"
                    >
                      Create Account
                    </button>
                  </p>
                  <p className="text-[11px] text-neutral-400">
                    Each email is bound to your chosen password on first sign-in.
                  </p>
                </>
              ) : (
                <p className="text-xs text-neutral-600">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => switchMode('signin')}
                    className="font-semibold text-brand-600 hover:text-brand-700"
                  >
                    Back to Sign In
                  </button>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
