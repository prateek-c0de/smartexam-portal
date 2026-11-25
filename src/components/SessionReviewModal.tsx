import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/Button';
import { examService, type TeacherSessionDetail } from '@/services/examService';
import { formatTime } from '@/utils/permissions';
import {
  X,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Send,
  FileText,
  Image as ImageIcon,
  Check,
  Ban,
} from 'lucide-react';

interface SessionReviewModalProps {
  sessionId: string;
  onClose: () => void;
  onUpdated: () => void;
}

export default function SessionReviewModal({
  sessionId,
  onClose,
  onUpdated,
}: SessionReviewModalProps) {
  const [detail, setDetail] = useState<TeacherSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'timeline' | 'answers'>('timeline');
  const [remarksDraft, setRemarksDraft] = useState<Record<string, string>>({});
  const [gradeDraft, setGradeDraft] = useState<Record<string, { marks: string; feedback: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [warningMsg, setWarningMsg] = useState('');
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const d = await examService.getSessionDetail(sessionId);
      setDetail(d);
      const rMap: Record<string, string> = {};
      for (const ev of d.events) {
        rMap[ev.id] = ev.teacher_remarks ?? '';
      }
      setRemarksDraft(rMap);

      const gMap: Record<string, { marks: string; feedback: string }> = {};
      for (const ans of d.answers) {
        if (ans.answer_id) {
          gMap[ans.answer_id] = {
            marks: ans.awarded_marks !== null ? String(ans.awarded_marks) : '0',
            feedback: ans.feedback ?? '',
          };
        }
      }
      setGradeDraft(gMap);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  async function handleReviewEvent(
    eventId: string,
    status: 'acknowledged' | 'confirmed' | 'dismissed'
  ) {
    setSavingId(eventId);
    try {
      await examService.reviewProctoringEvent(eventId, status, remarksDraft[eventId] ?? '');
      await loadDetail();
      onUpdated();
    } finally {
      setSavingId(null);
    }
  }

  async function handleSaveDescriptiveGrade(answerId: string, maxMarks: number) {
    const draft = gradeDraft[answerId];
    if (!draft) return;
    const numeric = Math.max(0, Math.min(maxMarks, Number(draft.marks) || 0));
    setSavingId(answerId);
    try {
      await examService.gradeDescriptiveAnswer(answerId, numeric, draft.feedback);
      await loadDetail();
      onUpdated();
    } finally {
      setSavingId(null);
    }
  }

  async function handleSendWarning(e: React.FormEvent) {
    e.preventDefault();
    if (!warningMsg.trim()) return;
    setSavingId('warn');
    try {
      await examService.sendWarning(sessionId, warningMsg);
      setWarningMsg('');
      await loadDetail();
    } finally {
      setSavingId(null);
    }
  }

  async function handleLoadEvidence(eventId: string, path: string) {
    const url = await examService.getSignedEvidenceUrl(path);
    if (url) {
      setEvidenceUrls((prev) => ({ ...prev, [eventId]: url }));
    }
  }

  const priorityBadge = (prio?: string) => {
    if (prio === 'high') return 'bg-error-50 text-error-700';
    if (prio === 'moderate') return 'bg-warning-50 text-warning-700';
    return 'bg-success-50 text-success-700';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-neutral-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white rounded-2xl card-shadow-lg w-full max-w-4xl max-h-[90vh] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-neutral-200">
          <div>
            <h2 className="text-lg font-bold text-neutral-900">
              {detail ? `${detail.session.student_name} — Session Review` : 'Loading Session…'}
            </h2>
            {detail && (
              <p className="text-xs text-neutral-500 mt-0.5">
                {detail.session.student_email} · {detail.exam.course_code} · Time used:{' '}
                {formatTime(detail.session.time_used_seconds)}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading || !detail ? (
          <div className="p-16 text-center">
            <Loader2 className="h-8 w-8 text-brand-500 animate-spin mx-auto mb-3" />
            <p className="text-sm text-neutral-500">Loading proctoring timeline & answers…</p>
          </div>
        ) : (
          <>
            {/* Summary strip */}
            <div className="px-6 py-4 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3 flex-wrap text-xs font-semibold">
                <span className={`px-3 py-1 rounded-full uppercase ${priorityBadge(detail.session.review_priority)}`}>
                  {detail.session.review_priority} Review Priority ({detail.session.integrity_score} pts)
                </span>
                <span className="px-3 py-1 rounded-full bg-white border border-neutral-200 text-neutral-700">
                  Score: {detail.session.score}/{detail.session.total_marks} ({detail.session.percentage}%)
                </span>
                <span className="px-3 py-1 rounded-full bg-white border border-neutral-200 text-neutral-700">
                  Active Flags: {detail.session.proctoring_flags}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setTab('timeline')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    tab === 'timeline'
                      ? 'bg-brand-600 text-white'
                      : 'bg-white text-neutral-600 border border-neutral-200'
                  }`}
                >
                  Activity Timeline ({detail.events.length})
                </button>
                <button
                  onClick={() => setTab('answers')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    tab === 'answers'
                      ? 'bg-brand-600 text-white'
                      : 'bg-white text-neutral-600 border border-neutral-200'
                  }`}
                >
                  Answers & Grading ({detail.answers.length})
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {tab === 'timeline' ? (
                <>
                  {detail.session.status === 'in_progress' && (
                    <form onSubmit={handleSendWarning} className="flex gap-2">
                      <input
                        type="text"
                        value={warningMsg}
                        onChange={(e) => setWarningMsg(e.target.value)}
                        placeholder="Send live warning message to student…"
                        className="flex-1 px-4 py-2.5 rounded-xl border border-neutral-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <Button type="submit" size="sm" disabled={savingId === 'warn' || !warningMsg.trim()}>
                        <Send className="h-4 w-4" />
                        Warn Student
                      </Button>
                    </form>
                  )}

                  {detail.events.length === 0 ? (
                    <div className="p-10 text-center bg-neutral-50 rounded-2xl border border-neutral-200">
                      <ShieldCheck className="h-10 w-10 text-success-500 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-neutral-800">No Proctoring Events Recorded</p>
                      <p className="text-xs text-neutral-500 mt-1">
                        This examination session has a clean monitoring log.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {detail.events.map((ev) => (
                        <div
                          key={ev.id}
                          className={`p-4 rounded-xl border ${
                            ev.review_status === 'dismissed'
                              ? 'bg-neutral-50 border-neutral-200 opacity-75'
                              : ev.category === 'technical' || ev.category === 'info'
                                ? 'bg-white border-neutral-200'
                                : 'bg-white border-warning-200'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-bold uppercase tracking-wide text-neutral-900">
                                  {ev.event_type.replace(/_/g, ' ')}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                                    ev.category === 'suspicious'
                                      ? 'bg-warning-50 text-warning-700'
                                      : 'bg-neutral-100 text-neutral-600'
                                  }`}
                                >
                                  {ev.category} · {ev.weight} pts × {ev.occurrences}
                                </span>
                                {ev.confidence !== null && (
                                  <span className="text-xs text-neutral-500">
                                    Confidence: {Math.round(Number(ev.confidence) * 100)}%
                                  </span>
                                )}
                                <span className="text-xs text-neutral-400">
                                  {new Date(ev.created_at).toLocaleTimeString()}
                                </span>
                              </div>
                              <p className="text-sm text-neutral-700">{ev.description}</p>
                            </div>

                            <span
                              className={`px-2.5 py-0.5 rounded-full text-xs font-bold capitalize ${
                                ev.review_status === 'dismissed'
                                  ? 'bg-neutral-200 text-neutral-600'
                                  : ev.review_status === 'confirmed'
                                    ? 'bg-error-50 text-error-700'
                                    : ev.review_status === 'acknowledged'
                                      ? 'bg-brand-50 text-brand-700'
                                      : 'bg-warning-50 text-warning-700'
                              }`}
                            >
                              {ev.review_status}
                            </span>
                          </div>

                          {ev.evidence_path && (
                            <div className="mt-3">
                              {evidenceUrls[ev.id] ? (
                                <img
                                  src={evidenceUrls[ev.id]}
                                  alt="Authorized proctoring snapshot"
                                  className="h-36 rounded-lg border border-neutral-200 object-cover"
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void handleLoadEvidence(ev.id, ev.evidence_path!)}
                                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-600 hover:text-brand-700"
                                >
                                  <ImageIcon className="h-3.5 w-3.5" />
                                  View Short-Lived Signed Snapshot
                                </button>
                              )}
                            </div>
                          )}

                          <div className="mt-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                            <input
                              type="text"
                              value={remarksDraft[ev.id] ?? ''}
                              onChange={(e) =>
                                setRemarksDraft((prev) => ({ ...prev, [ev.id]: e.target.value }))
                              }
                              placeholder="Instructor review remarks…"
                              className="flex-1 px-3 py-1.5 rounded-lg border border-neutral-300 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
                            />
                            <div className="flex items-center gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={savingId === ev.id}
                                onClick={() => void handleReviewEvent(ev.id, 'dismissed')}
                              >
                                <Ban className="h-3.5 w-3.5" />
                                Dismiss False Positive
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={savingId === ev.id}
                                onClick={() => void handleReviewEvent(ev.id, 'acknowledged')}
                              >
                                <Check className="h-3.5 w-3.5" />
                                Acknowledge
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={savingId === ev.id}
                                onClick={() => void handleReviewEvent(ev.id, 'confirmed')}
                              >
                                <AlertTriangle className="h-3.5 w-3.5" />
                                Confirm
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-4">
                  {detail.answers.map((ans, idx) => (
                    <div key={ans.question_id} className="p-4 rounded-xl border border-neutral-200 bg-neutral-50/50 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-brand-600 uppercase">
                          Q{idx + 1} · {ans.section} ({ans.question_type})
                        </span>
                        <span className="text-xs font-bold text-neutral-700">
                          {ans.awarded_marks ?? 0} / {ans.marks} marks
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-neutral-900">{ans.question_text}</p>

                      {ans.question_type === 'descriptive' ? (
                        <div className="space-y-3">
                          <div className="p-3 rounded-lg bg-white border border-neutral-200 text-sm text-neutral-800 whitespace-pre-wrap">
                            {ans.answer_text || '(No written answer submitted)'}
                          </div>
                          {ans.model_answer && (
                            <p className="text-xs text-neutral-500">
                              <span className="font-semibold text-neutral-700">Reference Rubric:</span>{' '}
                              {ans.model_answer}
                            </p>
                          )}
                          {ans.answer_id && (
                            <div className="flex flex-col sm:flex-row gap-2 pt-1">
                              <input
                                type="number"
                                min={0}
                                max={ans.marks}
                                step="0.5"
                                value={gradeDraft[ans.answer_id]?.marks ?? '0'}
                                onChange={(e) =>
                                  setGradeDraft((prev) => ({
                                    ...prev,
                                    [ans.answer_id!]: {
                                      marks: e.target.value,
                                      feedback: prev[ans.answer_id!]?.feedback ?? '',
                                    },
                                  }))
                                }
                                className="w-28 px-3 py-1.5 rounded-lg border border-neutral-300 text-xs font-bold"
                              />
                              <input
                                type="text"
                                value={gradeDraft[ans.answer_id]?.feedback ?? ''}
                                onChange={(e) =>
                                  setGradeDraft((prev) => ({
                                    ...prev,
                                    [ans.answer_id!]: {
                                      marks: prev[ans.answer_id!]?.marks ?? '0',
                                      feedback: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="Grading feedback for student…"
                                className="flex-1 px-3 py-1.5 rounded-lg border border-neutral-300 text-xs"
                              />
                              <Button
                                size="sm"
                                variant="success"
                                disabled={savingId === ans.answer_id}
                                onClick={() => void handleSaveDescriptiveGrade(ans.answer_id!, ans.marks)}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Save Grade
                              </Button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs space-y-1 bg-white p-3 rounded-lg border border-neutral-200">
                          <p className="text-neutral-700">
                            <span className="font-semibold">Student answer:</span>{' '}
                            {ans.selected_options && ans.selected_options.length > 0
                              ? ans.selected_options.map((i) => ans.options[i]).join(', ')
                              : '(Unanswered)'}
                          </p>
                          <p className="text-success-700">
                            <span className="font-semibold">Correct answer:</span>{' '}
                            {(ans.correct_options ?? []).map((i) => ans.options[i]).join(', ')}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-neutral-200 flex justify-end">
              <Button variant="outline" onClick={onClose}>
                <FileText className="h-4 w-4" />
                Close Review
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
