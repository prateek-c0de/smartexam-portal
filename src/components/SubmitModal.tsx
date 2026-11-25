import Button from '@/components/Button';
import { isQuestionAnswered } from '@/utils/permissions';
import type { AnswerMap, Exam } from '@/types';
import { AlertTriangle, CheckCircle2, Flag, Loader2, X } from 'lucide-react';

interface SubmitModalProps {
  exam: Exam;
  answers: AnswerMap;
  timeRemaining: number;
  submitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function SubmitModal({
  exam,
  answers,
  timeRemaining,
  submitting = false,
  onConfirm,
  onCancel,
}: SubmitModalProps) {
  const answered = exam.questions.filter((q) => isQuestionAnswered(answers[q.id])).length;
  const unanswered = Math.max(0, exam.totalQuestions - answered);
  const safeRemaining = Math.max(0, Math.floor(timeRemaining));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-neutral-900/60 backdrop-blur-sm"
        onClick={submitting ? undefined : onCancel}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl card-shadow-lg w-full max-w-md p-6 animate-slide-up">
        <button
          onClick={onCancel}
          disabled={submitting}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3 mb-5">
          <div className="flex items-center justify-center h-12 w-12 rounded-xl bg-warning-50">
            <AlertTriangle className="h-6 w-6 text-warning-600" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-neutral-900">Submit Exam?</h2>
            <p className="text-sm text-neutral-500">This action cannot be undone.</p>
          </div>
        </div>

        {/* Summary */}
        <div className="space-y-2.5 mb-5">
          <div className="flex items-center justify-between p-3 rounded-xl bg-success-50">
            <span className="flex items-center gap-2 text-sm font-semibold text-success-700">
              <CheckCircle2 className="h-4 w-4" />
              Answered Questions
            </span>
            <span className="text-lg font-bold text-success-700">{answered}</span>
          </div>
          {unanswered > 0 && (
            <div className="flex items-center justify-between p-3 rounded-xl bg-error-50">
              <span className="flex items-center gap-2 text-sm font-semibold text-error-700">
                <AlertTriangle className="h-4 w-4" />
                Unanswered Questions
              </span>
              <span className="text-lg font-bold text-error-700">{unanswered}</span>
            </div>
          )}
          <div className="flex items-center justify-between p-3 rounded-xl bg-neutral-50">
            <span className="flex items-center gap-2 text-sm font-semibold text-neutral-600">
              <Flag className="h-4 w-4 text-warning-500" />
              Time Remaining
            </span>
            <span className="text-lg font-bold text-neutral-700">
              {Math.floor(safeRemaining / 60)}:{(safeRemaining % 60).toString().padStart(2, '0')}
            </span>
          </div>
        </div>

        {unanswered > 0 && (
          <div className="p-3 mb-5 rounded-xl bg-warning-50 border border-warning-200">
            <p className="text-sm text-warning-700 leading-relaxed">
              You have <span className="font-bold">{unanswered}</span> unanswered
              question{unanswered !== 1 ? 's' : ''}. Are you sure you want to submit?
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <Button variant="outline" fullWidth onClick={onCancel} disabled={submitting}>
            Continue Exam
          </Button>
          <Button variant="success" fullWidth onClick={onConfirm} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Submitting…
              </>
            ) : (
              'Submit Now'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
