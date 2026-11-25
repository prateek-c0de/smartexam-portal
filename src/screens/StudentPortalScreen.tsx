import { useState, useEffect, useCallback } from 'react';
import Logo from '@/components/Logo';
import Button from '@/components/Button';
import { AppError } from '@/lib/supabase';
import { examService, mapStudentSummaryToExam } from '@/services/examService';
import type { Exam, ExamSubmissionResult, StudentExamSummary, User } from '@/types';
import {
  LogOut,
  KeyRound,
  Clock,
  FileText,
  Award,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  History,
  PlayCircle,
} from 'lucide-react';

interface StudentPortalScreenProps {
  user: User;
  onStartExamFlow: (exam: Exam) => void;
  onResumeActiveExam: (examId: string) => void;
  onViewResult: (exam: Exam, result: ExamSubmissionResult) => void;
  onLogout: () => void;
}

export default function StudentPortalScreen({
  user,
  onStartExamFlow,
  onResumeActiveExam,
  onViewResult,
  onLogout,
}: StudentPortalScreenProps) {
  const [exams, setExams] = useState<StudentExamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinFeedback, setJoinFeedback] = useState<{ type: 'error' | 'success'; text: string } | null>(
    null
  );
  const [openingResultId, setOpeningResultId] = useState<string | null>(null);

  const loadExams = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await examService.listStudentExams();
      setExams(list);
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      setError(appErr?.message ?? 'Failed to load your examinations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadExams();
  }, [loadExams]);

  async function handleJoinByCode(e: React.FormEvent) {
    e.preventDefault();
    setJoinFeedback(null);
    const cleaned = joinCode.trim().toUpperCase();
    if (!cleaned) {
      setJoinFeedback({ type: 'error', text: 'Please enter an 8-character examination code.' });
      return;
    }

    setJoining(true);
    try {
      const joinedExam = await examService.joinExamByCode(cleaned);
      setJoinCode('');
      setJoinFeedback({
        type: 'success',
        text: `Joined "${joinedExam.courseCode} — ${joinedExam.title}".`,
      });
      await loadExams();
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      setJoinFeedback({
        type: 'error',
        text: appErr?.message ?? 'Invalid or expired examination code.',
      });
    } finally {
      setJoining(false);
    }
  }

  async function handleInspectResult(summary: StudentExamSummary) {
    if (!summary.latest_session) return;
    setOpeningResultId(summary.latest_session.id);
    try {
      const detail = await examService.getStudentResult(summary.latest_session.id);
      onViewResult(mapStudentSummaryToExam(summary), detail);
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      setError(appErr?.message ?? 'Could not open examination result.');
    } finally {
      setOpeningResultId(null);
    }
  }

  const completedList = exams.filter((e) => e.latest_session !== null);

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Header */}
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <Logo size="sm" />
          <div className="flex items-center gap-3">
            <div className="hidden sm:block text-right">
              <p className="text-sm font-semibold text-neutral-800 leading-none">{user.name}</p>
              <p className="text-xs text-neutral-500 mt-0.5">Student · {user.email}</p>
            </div>
            <div
              className="flex items-center justify-center h-9 w-9 rounded-full text-white text-sm font-bold"
              style={{ backgroundColor: user.avatarColor }}
            >
              {user.name.charAt(0).toUpperCase()}
            </div>
            <button
              onClick={onLogout}
              className="p-2 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 transition-colors"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Welcome + Join by Code */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900">Student Examination Portal</h1>
            <p className="text-neutral-500 mt-1">
              Join an examination with your instructor’s code or launch an assigned assessment.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void loadExams()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Join Exam Card */}
        <div className="bg-white rounded-2xl card-shadow p-6 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-600 mb-3">
            <KeyRound className="h-4 w-4" />
            JOIN EXAMINATION BY CODE
          </div>
          <form onSubmit={handleJoinByCode} className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="Enter 8-character exam code (e.g. K7M4P9X2)"
              className="flex-1 px-4 py-3 rounded-xl border border-neutral-300 font-mono tracking-widest uppercase text-neutral-900 placeholder-neutral-400 placeholder:font-sans placeholder:tracking-normal placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
            />
            <Button type="submit" size="lg" disabled={joining}>
              {joining ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Joining…
                </>
              ) : (
                <>
                  Join Exam
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </form>

          {joinFeedback && (
            <div
              className={`mt-4 flex items-center gap-2 p-3 rounded-xl text-sm animate-fade-in ${
                joinFeedback.type === 'success'
                  ? 'bg-success-50 border border-success-200 text-success-700'
                  : 'bg-error-50 border border-error-200 text-error-700'
              }`}
            >
              {joinFeedback.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
              )}
              <span>{joinFeedback.text}</span>
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 p-4 rounded-xl bg-error-50 border border-error-200 text-error-700 text-sm">
            <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Available Examinations */}
        <div>
          <h2 className="text-lg font-bold text-neutral-900 mb-4 flex items-center gap-2">
            <FileText className="h-5 w-5 text-brand-600" />
            Available Examinations
          </h2>

          {loading ? (
            <div className="bg-white rounded-2xl card-shadow p-12 text-center">
              <Loader2 className="h-8 w-8 text-brand-500 animate-spin mx-auto mb-3" />
              <p className="text-sm text-neutral-500">Loading your examinations…</p>
            </div>
          ) : exams.length === 0 ? (
            <div className="bg-white rounded-2xl card-shadow p-12 text-center">
              <FileText className="h-12 w-12 text-neutral-300 mx-auto mb-3" />
              <p className="text-base font-semibold text-neutral-700">No examinations enrolled yet</p>
              <p className="text-sm text-neutral-500 mt-1">
                Enter the 8-character joining code shared by your instructor above to enroll.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {exams.map((item) => {
                const now = Date.now();
                const notYetOpen = item.starts_at ? Date.parse(item.starts_at) > now : false;
                const closed =
                  item.status === 'ended' || (item.ends_at ? Date.parse(item.ends_at) <= now : false);
                const attemptsLeft = Math.max(0, item.max_attempts - item.attempts_used);
                const canStartNew = !item.active_session_id && !notYetOpen && !closed && attemptsLeft > 0;

                return (
                  <div
                    key={item.id}
                    className="bg-white rounded-2xl card-shadow p-6 flex flex-col md:flex-row md:items-center justify-between gap-5 animate-slide-up"
                  >
                    <div className="space-y-2 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-brand-50 text-brand-700">
                          {item.course_code}
                        </span>
                        {item.active_session_id && (
                          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-warning-50 text-warning-700">
                            In Progress — Ready to Resume
                          </span>
                        )}
                        {closed && !item.active_session_id && (
                          <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-neutral-100 text-neutral-600">
                            Closed
                          </span>
                        )}
                      </div>
                      <h3 className="text-lg font-bold text-neutral-900">{item.title}</h3>
                      <p className="text-sm text-neutral-500">{item.course_name}</p>

                      <div className="flex items-center gap-4 flex-wrap text-xs font-medium text-neutral-600 pt-1">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5 text-brand-600" />
                          {item.duration_minutes} mins
                        </span>
                        <span className="flex items-center gap-1">
                          <FileText className="h-3.5 w-3.5 text-brand-600" />
                          {item.total_questions} questions
                        </span>
                        <span className="flex items-center gap-1">
                          <Award className="h-3.5 w-3.5 text-brand-600" />
                          {item.total_marks} marks
                        </span>
                        <span>
                          Attempts: {item.attempts_used}/{item.max_attempts}
                        </span>
                        {item.starts_at && (
                          <span>
                            Opens: {new Date(item.starts_at).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5 flex-shrink-0">
                      {item.latest_session && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={openingResultId === item.latest_session.id}
                          onClick={() => void handleInspectResult(item)}
                        >
                          {openingResultId === item.latest_session.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <History className="h-4 w-4" />
                          )}
                          {item.latest_session.results_visible ? 'View Result' : 'Submission Receipt'}
                        </Button>
                      )}

                      {item.active_session_id ? (
                        <Button
                          variant="primary"
                          onClick={() => onResumeActiveExam(item.id)}
                          className="group"
                        >
                          <PlayCircle className="h-4 w-4" />
                          Resume Exam
                        </Button>
                      ) : canStartNew ? (
                        <Button
                          onClick={() => onStartExamFlow(mapStudentSummaryToExam(item))}
                          className="group"
                        >
                          Begin Check-in
                          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                        </Button>
                      ) : (
                        <span className="text-xs font-semibold text-neutral-400 px-3 py-2">
                          {notYetOpen
                            ? 'Not yet open'
                            : attemptsLeft === 0
                              ? 'Completed'
                              : 'Window closed'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Result History Summary */}
        {completedList.length > 0 && (
          <div className="bg-white rounded-2xl card-shadow overflow-hidden">
            <div className="p-5 border-b border-neutral-200 flex items-center gap-2">
              <History className="h-5 w-5 text-brand-600" />
              <h3 className="text-base font-bold text-neutral-900">Your Submission & Result History</h3>
            </div>
            <div className="divide-y divide-neutral-100">
              {completedList.map((item) => {
                const sess = item.latest_session!;
                return (
                  <div
                    key={sess.id}
                    className="p-4 sm:px-6 flex items-center justify-between gap-4 flex-wrap"
                  >
                    <div>
                      <p className="text-sm font-semibold text-neutral-900">
                        {item.course_code} — {item.title}
                      </p>
                      <p className="text-xs text-neutral-500 mt-0.5">
                        Submitted{' '}
                        {sess.submitted_at
                          ? new Date(sess.submitted_at).toLocaleString('en-US', {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : 'recently'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {sess.results_visible && sess.percentage !== null ? (
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-bold ${
                            sess.passed
                              ? 'bg-success-50 text-success-700'
                              : 'bg-warning-50 text-warning-700'
                          }`}
                        >
                          {sess.percentage}% ({sess.score}/{sess.total_marks})
                        </span>
                      ) : (
                        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-neutral-100 text-neutral-600">
                          Awaiting Publication
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleInspectResult(item)}
                      >
                        Details
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
