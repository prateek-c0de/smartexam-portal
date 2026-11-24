import { useState } from 'react';
import Logo from '@/components/Logo';
import Button from '@/components/Button';
import {
  ArrowLeft,
  Mail,
  Lock,
  Users,
  AlertCircle,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { Role, User } from '@/types';
import { api } from '@/services/api';
import { pickAvatarColor } from '@/utils/permissions';

interface LoginScreenProps {
  role: Role;
  onBack: () => void;
  onLogin: (user: User) => void;
}

export default function LoginScreen({ role, onBack, onLogin }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const isStudent = role === 'student';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Please enter both your email and password.');
      return;
    }

    setLoading(true);
    try {
      const result = isStudent
        ? await api.studentLogin(email, password)
        : await api.teacherLogin(email, password);
      onLogin({
        ...result.user,
        avatarColor: pickAvatarColor(result.user.email),
      });
    } catch {
      setError('Unable to sign in. Please check your credentials and try again.');
    } finally {
      setLoading(false);
    }
  }

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
              {isStudent ? 'Student Sign In' : 'Faculty Sign In'}
            </h2>
            <p className="text-sm text-neutral-500 text-center mb-8">
              {isStudent
                ? 'Enter your university credentials to access your exams.'
                : 'Sign in to manage exams and view student results.'}
            </p>

            {error && (
              <div className="flex items-start gap-2 p-3 mb-5 rounded-xl bg-error-50 border border-error-200 text-error-700 text-sm animate-fade-in">
                <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
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
                    placeholder="Enter your password"
                    className="w-full pl-11 pr-11 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between text-sm">
                <label className="flex items-center gap-2 text-neutral-600 cursor-pointer">
                  <input type="checkbox" className="rounded border-neutral-300 text-brand-600 focus:ring-brand-500" />
                  Remember me
                </label>
                <button type="button" className="text-brand-600 font-semibold hover:text-brand-700">
                  Forgot password?
                </button>
              </div>

              <Button type="submit" fullWidth size="lg" disabled={loading}>
                {loading ? 'Signing in…' : `Sign In as ${isStudent ? 'Student' : 'Teacher'}`}
              </Button>
            </form>

            <div className="mt-6 p-4 rounded-xl bg-neutral-50 border border-neutral-200">
              <p className="text-xs text-neutral-500 leading-relaxed text-center">
                <span className="font-semibold text-neutral-700">Demo Mode:</span> Enter any email
                and password to continue. The app is fully functional in frontend-only mode.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
