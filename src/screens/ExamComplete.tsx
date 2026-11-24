import Button from '@/components/Button';
import Logo from '@/components/Logo';
import type { Exam, User } from '@/types';
import { formatTime } from '@/utils/permissions';
import {
  CheckCircle2,
  Clock,
  Award,
  FileText,
  ShieldCheck,
  TrendingUp,
  Home,
  Eye,
} from 'lucide-react';

interface ExamCompleteProps {
  user: User;
  exam: Exam;
  result: {
    score: number;
    totalMarks: number;
    percentage: number;
    correctAnswers: number;
    totalQuestions: number;
    timeUsedSeconds: number;
    proctoringFlags: number;
  };
  onHome: () => void;
}

export default function ExamComplete({ user, exam, result, onHome }: ExamCompleteProps) {
  const passed = result.percentage >= 50;
  const timeUsed = formatTime(result.timeUsedSeconds);

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Header */}
      <header className="bg-white border-b border-neutral-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Logo size="sm" />
          <div className="flex items-center gap-2">
            <div
              className="flex items-center justify-center h-8 w-8 rounded-full text-white text-sm font-bold"
              style={{ backgroundColor: user.avatarColor }}
            >
              {user.name.charAt(0).toUpperCase()}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        {/* Success banner */}
        <div className="text-center mb-8 animate-slide-up">
          <div
            className={`inline-flex items-center justify-center h-20 w-20 rounded-full mb-4 ${
              passed ? 'bg-success-100' : 'bg-warning-100'
            }`}
          >
            <CheckCircle2 className={`h-12 w-12 ${passed ? 'text-success-600' : 'text-warning-600'}`} />
          </div>
          <h1 className="text-3xl font-bold text-neutral-900">
            {passed ? 'Exam Completed!' : 'Exam Submitted'}
          </h1>
          <p className="text-neutral-500 mt-2">
            Your answers have been recorded and submitted successfully.
          </p>
        </div>

        {/* Score card */}
        <div className="bg-white rounded-2xl card-shadow-lg p-8 mb-6 animate-slide-up">
          <div className="flex flex-col items-center">
            {/* Circular score */}
            <div className="relative h-40 w-40 mb-4">
              <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120">
                <circle
                  cx="60" cy="60" r="52"
                  fill="none" stroke="#e2e8f0" strokeWidth="10"
                />
                <circle
                  cx="60" cy="60" r="52"
                  fill="none"
                  stroke={passed ? '#10b981' : '#f59e0b'}
                  strokeWidth="10"
                  strokeLinecap="round"
                  strokeDasharray={`${(result.percentage / 100) * 327} 327`}
                  className="transition-all duration-1000 ease-out"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-4xl font-bold text-neutral-900">{result.percentage}%</span>
                <span className="text-sm text-neutral-500">Score</span>
              </div>
            </div>

            <div className={`px-4 py-2 rounded-full text-sm font-bold ${passed ? 'bg-success-50 text-success-700' : 'bg-warning-50 text-warning-700'}`}>
              {passed ? 'PASSED' : 'DID NOT PASS'}
            </div>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-8">
            {[
              { icon: Award, label: 'Marks Earned', value: `${Math.round(result.score)}`, sub: `/${result.totalMarks}` },
              { icon: CheckCircle2, label: 'Correct', value: `${result.correctAnswers}`, sub: `/${result.totalQuestions}` },
              { icon: Clock, label: 'Time Used', value: timeUsed, sub: '' },
              { icon: ShieldCheck, label: 'Integrity', value: result.proctoringFlags === 0 ? 'Clean' : `${result.proctoringFlags} flags`, sub: '' },
            ].map((stat) => (
              <div key={stat.label} className="p-4 rounded-xl bg-neutral-50 border border-neutral-200 text-center">
                <stat.icon className="h-5 w-5 text-brand-600 mx-auto mb-2" />
                <p className="text-xs text-neutral-500 mb-1">{stat.label}</p>
                <p className="text-lg font-bold text-neutral-900">
                  {stat.value}
                  {stat.sub && <span className="text-sm text-neutral-400 font-medium">{stat.sub}</span>}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Exam info */}
        <div className="bg-white rounded-2xl card-shadow p-6 mb-6 animate-slide-up">
          <h3 className="text-sm font-bold text-neutral-900 uppercase tracking-wide mb-4">
            Exam Details
          </h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">Exam Title</span>
              <span className="font-semibold text-neutral-800">{exam.title}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">Course</span>
              <span className="font-semibold text-neutral-800">{exam.courseCode} — {exam.courseName}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">Submitted At</span>
              <span className="font-semibold text-neutral-800">
                {new Date().toLocaleString('en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">Student</span>
              <span className="font-semibold text-neutral-800">{user.name}</span>
            </div>
          </div>
        </div>

        {/* Info note */}
        <div className="bg-brand-50 rounded-2xl border border-brand-200 p-5 mb-8">
          <div className="flex items-start gap-3">
            <TrendingUp className="h-5 w-5 text-brand-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-brand-800">Detailed Results</p>
              <p className="text-sm text-brand-700 mt-1 leading-relaxed">
                A detailed breakdown of your answers and performance analytics will be available
                once your instructor reviews and publishes the final results.
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button variant="outline" size="lg" onClick={onHome}>
            <Home className="h-5 w-5" />
            Back to Home
          </Button>
          <Button variant="ghost" size="lg" onClick={() => window.print()}>
            <FileText className="h-5 w-5" />
            Print Receipt
          </Button>
        </div>
      </div>
    </div>
  );
}
