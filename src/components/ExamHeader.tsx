import Logo from '@/components/Logo';
import type { User } from '@/types';
import { LogOut } from 'lucide-react';

interface ExamHeaderProps {
  user: User;
  step: number;
  totalSteps: number;
  stepLabels: string[];
  onLogout: () => void;
}

export default function ExamHeader({ user, step, totalSteps, stepLabels, onLogout }: ExamHeaderProps) {
  return (
    <header className="border-b border-neutral-200 bg-white sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        <Logo size="sm" />

        {/* Step indicator */}
        <div className="hidden lg:flex items-center gap-2">
          {stepLabels.map((label, i) => {
            const isActive = i === step;
            const isDone = i < step;
    return (
              <div key={label} className="flex items-center">
                <div
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                    isActive
                      ? 'bg-brand-600 text-white'
                      : isDone
                        ? 'bg-success-50 text-success-700'
                        : 'text-neutral-400'
                  }`}
                >
                  <span
                    className={`flex items-center justify-center h-5 w-5 rounded-full text-xs ${
                      isActive
                        ? 'bg-white/25 text-white'
                        : isDone
                          ? 'bg-success-600 text-white'
                          : 'bg-neutral-200 text-neutral-500'
                    }`}
                  >
                    {isDone ? '✓' : i + 1}
                  </span>
                  {label}
                </div>
                {i < totalSteps - 1 && (
                  <div className={`w-6 h-px ${isDone ? 'bg-success-400' : 'bg-neutral-200'}`} />
                )}
              </div>
            );
          })}
        </div>

        {/* User + logout */}
        <div className="flex items-center gap-3">
          {/* Mobile step indicator */}
          <div className="lg:hidden text-sm font-semibold text-neutral-600">
            Step {step + 1}/{totalSteps}
          </div>
          <div className="flex items-center gap-2 pl-3 border-l border-neutral-200">
            <div
              className="flex items-center justify-center h-8 w-8 rounded-full text-white text-sm font-bold"
              style={{ backgroundColor: user.avatarColor }}
            >
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="hidden sm:block">
              <p className="text-sm font-semibold text-neutral-800 leading-none">{user.name}</p>
              <p className="text-xs text-neutral-500 mt-0.5">{user.email}</p>
            </div>
            <button
              onClick={onLogout}
              className="ml-1 p-2 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 transition-colors"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
