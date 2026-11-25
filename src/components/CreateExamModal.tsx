import { useState, useEffect } from 'react';
import Button from '@/components/Button';
import { AppError } from '@/lib/supabase';
import {
  examService,
  type AssignmentSaveInput,
  type QuestionSaveInput,
  type TeacherExamRow,
} from '@/services/examService';
import { aiQuestionService } from '@/services/aiQuestionService';
import type { QuestionType } from '@/types';
import {
  X,
  Plus,
  Trash2,
  Check,
  AlertCircle,
  Loader2,
  ClipboardList,
  HelpCircle,
  Save,
  ArrowRight,
  ArrowLeft,
  FileText,
  Award,
  Sparkles,
  CheckCircle2,
} from 'lucide-react';

interface QuestionInput {
  id: string;
  dbId?: string;
  section: string;
  question_type: QuestionType;
  question_text: string;
  options: string[];
  correct_options: number[];
  marks: number;
  explanation: string;
  model_answer: string;
  ai_generated: boolean;
  approved: boolean;
}

interface CreateExamModalProps {
  editExamId?: string | null;
  onClose: () => void;
  onCreated: (savedExam: TeacherExamRow) => void;
}

const STEPS = ['Exam Details', 'Instructions', 'Questions'] as const;
type StepIndex = 0 | 1 | 2;

function toLocalDatetimeInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CreateExamModal({
  editExamId = null,
  onClose,
  onCreated,
}: CreateExamModalProps) {
  const [step, setStep] = useState<StepIndex>(0);
  const [loadingExisting, setLoadingExisting] = useState(Boolean(editExamId));

  // Step 1 — Exam details
  const [title, setTitle] = useState('');
  const [courseCode, setCourseCode] = useState('');
  const [courseName, setCourseName] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [passPercentage, setPassPercentage] = useState(40);
  const [negativeRatio, setNegativeRatio] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [shuffleQuestions, setShuffleQuestions] = useState(false);
  const [shuffleOptions, setShuffleOptions] = useState(false);
  const [accessMode, setAccessMode] = useState<'code' | 'assigned'>('code');
  const [assignedEmailsRaw, setAssignedEmailsRaw] = useState('');
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Step 2 — Instructions
  const [instructions, setInstructions] = useState<string[]>([
    'This exam contains graded assessment questions.',
    'The timer is server-controlled and cannot be paused once started.',
    'Read each question carefully before selecting or writing your answer.',
    'The exam will auto-submit when the countdown reaches zero.',
    'Your webcam, microphone, and screen will be monitored with your consent for integrity.',
  ]);
  const [newInstruction, setNewInstruction] = useState('');

  // Step 3 — Questions
  const [questions, setQuestions] = useState<QuestionInput[]>([
    {
      id: cryptoId(),
      section: 'Section A',
      question_type: 'mcq',
      question_text: '',
      options: ['', '', '', ''],
      correct_options: [0],
      marks: 5,
      explanation: '',
      model_answer: '',
      ai_generated: false,
      approved: true,
    },
  ]);
  const [newSection, setNewSection] = useState('Section A');

  // Optional AI Question Generator state
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [aiSubject, setAiSubject] = useState('');
  const [aiTopic, setAiTopic] = useState('');
  const [aiDifficulty, setAiDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [aiCount, setAiCount] = useState(3);
  const [aiQType, setAiQType] = useState<QuestionType>('mcq');
  const [aiMarks, setAiMarks] = useState(5);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiNotice, setAiNotice] = useState('');

  // Error / loading
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function cryptoId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  useEffect(() => {
    if (!editExamId) return;
    let active = true;
    setLoadingExisting(true);
    examService
      .getExamDetail(editExamId)
      .then((detail) => {
        if (!active) return;
        const e = detail.exam;
        setTitle(e.title);
        setCourseCode(e.course_code);
        setCourseName(e.course_name);
        setDurationMinutes(e.duration_minutes);
        setStartsAt(toLocalDatetimeInput(e.starts_at));
        setEndsAt(toLocalDatetimeInput(e.ends_at));
        setPassPercentage(Number(e.pass_percentage ?? 40));
        setNegativeRatio(Number(e.negative_marking_ratio ?? 0));
        setMaxAttempts(Number(e.max_attempts ?? 1));
        setShuffleQuestions(Boolean(e.shuffle_questions));
        setShuffleOptions(Boolean(e.shuffle_options));
        setAccessMode(e.access_mode ?? 'code');
        setPublishImmediately(e.status === 'published');
        if (Array.isArray(e.instructions) && e.instructions.length > 0) {
          setInstructions(e.instructions);
        }
        if (detail.assignments.length > 0) {
          setAssignedEmailsRaw(
            detail.assignments.map((a) => String(a.student_email ?? '')).filter(Boolean).join('\n')
          );
        }
        if (detail.questions.length > 0) {
          setQuestions(
            detail.questions.map((q) => ({
              id: cryptoId(),
              dbId: String(q.id),
              section: String(q.section ?? 'Section A'),
              question_type: (q.question_type as QuestionType) ?? 'mcq',
              question_text: String(q.question_text ?? ''),
              options: Array.isArray(q.options) ? (q.options as string[]) : ['', '', '', ''],
              correct_options: Array.isArray(q.correct_options)
                ? (q.correct_options as number[])
                : typeof q.correct_answer === 'number'
                  ? [q.correct_answer]
                  : [0],
              marks: Number(q.marks ?? 5),
              explanation: String(q.explanation ?? ''),
              model_answer: String(q.model_answer ?? ''),
              ai_generated: Boolean(q.ai_generated),
              approved: q.approved !== false,
            }))
          );
        }
      })
      .catch((err) => {
        if (!active) return;
        const appErr = err instanceof AppError ? err : null;
        setError(appErr?.message ?? 'Could not load examination details.');
      })
      .finally(() => {
        if (active) setLoadingExisting(false);
      });
    return () => {
      active = false;
    };
  }, [editExamId]);

  function validateStep(s: StepIndex): string | null {
    if (s === 0) {
      if (!title.trim()) return 'Exam title is required.';
      if (!courseCode.trim()) return 'Course code is required.';
      if (!courseName.trim()) return 'Course name is required.';
      if (durationMinutes < 1 || durationMinutes > 600) return 'Duration must be between 1 and 600 minutes.';
      if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
        return 'Ending time must be after starting time.';
      }
      if (accessMode === 'assigned' && parseAssignedList().length === 0) {
        return 'Enter at least one authorized student email when restricting access to a roster.';
      }
    }
    if (s === 1) {
      if (instructions.length === 0) return 'At least one instruction is required.';
    }
    if (s === 2) {
      if (questions.length === 0) return 'At least one question is required.';
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q.question_text.trim()) return `Question ${i + 1}: question text is required.`;
        if (q.marks < 1) return `Question ${i + 1}: marks must be at least 1.`;
        if (q.question_type !== 'descriptive') {
          if (q.options.length < 2) return `Question ${i + 1}: at least 2 options required.`;
          if (q.options.some((o) => !o.trim())) return `Question ${i + 1}: all options must be filled.`;
          if (q.correct_options.length === 0) return `Question ${i + 1}: select at least one correct option.`;
        }
        if (publishImmediately && !q.approved) {
          return `Question ${i + 1}: review and approve AI-generated drafts before publishing.`;
        }
      }
    }
    return null;
  }

  function parseAssignedList(): AssignmentSaveInput[] {
    return assignedEmailsRaw
      .split(/[\n,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s))
      .map((student_email) => ({ student_email }));
  }

  function nextStep() {
    const err = validateStep(step);
    if (err) {
      setError(err);
      return;
    }
    setError('');
    if (step < 2) setStep((step + 1) as StepIndex);
  }

  function prevStep() {
    setError('');
    if (step > 0) setStep((step - 1) as StepIndex);
  }

  function addInstruction() {
    if (newInstruction.trim()) {
      setInstructions([...instructions, newInstruction.trim()]);
      setNewInstruction('');
    }
  }

  function removeInstruction(i: number) {
    setInstructions(instructions.filter((_, idx) => idx !== i));
  }

  function addQuestion() {
    setQuestions([
      ...questions,
      {
        id: cryptoId(),
        section: newSection,
        question_type: 'mcq',
        question_text: '',
        options: ['', '', '', ''],
        correct_options: [0],
        marks: 5,
        explanation: '',
        model_answer: '',
        ai_generated: false,
        approved: true,
      },
    ]);
  }

  function removeQuestion(id: string) {
    setQuestions(questions.filter((q) => q.id !== id));
  }

  function updateQuestion(id: string, patch: Partial<QuestionInput>) {
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.id !== id) return q;
        const next = { ...q, ...patch };
        if (patch.question_type === 'true_false') {
          next.options = ['True', 'False'];
          next.correct_options = [next.correct_options[0] === 1 ? 1 : 0];
        } else if (patch.question_type === 'descriptive') {
          next.options = [];
          next.correct_options = [];
        } else if (
          (patch.question_type === 'mcq' || patch.question_type === 'multi_select') &&
          next.options.length < 2
        ) {
          next.options = ['', '', '', ''];
          next.correct_options = [0];
        }
        if (patch.question_type === 'mcq' && next.correct_options.length > 1) {
          next.correct_options = [next.correct_options[0]];
        }
        return next;
      })
    );
  }

  function toggleCorrectOption(qId: string, optIdx: number) {
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.id !== qId) return q;
        if (q.question_type === 'multi_select') {
          const exists = q.correct_options.includes(optIdx);
          const next = exists
            ? q.correct_options.filter((x) => x !== optIdx)
            : [...q.correct_options, optIdx].sort((a, b) => a - b);
          return { ...q, correct_options: next.length > 0 ? next : [optIdx] };
        }
        return { ...q, correct_options: [optIdx] };
      })
    );
  }

  function updateOption(qId: string, optIdx: number, value: string) {
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.id !== qId) return q;
        const opts = [...q.options];
        opts[optIdx] = value;
        return { ...q, options: opts };
      })
    );
  }

  function addOption(qId: string) {
    setQuestions((prev) =>
      prev.map((q) => (q.id === qId ? { ...q, options: [...q.options, ''] } : q))
    );
  }

  function removeOption(qId: string, optIdx: number) {
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.id !== qId || q.options.length <= 2) return q;
        const opts = q.options.filter((_, i) => i !== optIdx);
        const corr = q.correct_options
          .filter((c) => c !== optIdx)
          .map((c) => (c > optIdx ? c - 1 : c));
        return { ...q, options: opts, correct_options: corr.length > 0 ? corr : [0] };
      })
    );
  }

  async function handleGenerateAiQuestions() {
    setAiNotice('');
    setError('');
    setAiGenerating(true);
    try {
      const drafts = await aiQuestionService.generateDraftQuestions({
        subject: aiSubject || courseName || newSection,
        topic: aiTopic,
        difficulty: aiDifficulty,
        count: aiCount,
        questionType: aiQType,
        marks: aiMarks,
      });

      const mapped: QuestionInput[] = drafts.map((d) => ({
        id: cryptoId(),
        section: d.section || newSection,
        question_type: d.question_type,
        question_text: d.question_text,
        options: d.options,
        correct_options: d.correct_options,
        marks: d.marks,
        explanation: d.explanation ?? '',
        model_answer: d.model_answer ?? '',
        ai_generated: true,
        approved: false,
      }));

      // Replace initial blank starter row if untouched, else append
      setQuestions((prev) => {
        if (prev.length === 1 && !prev[0].question_text.trim()) {
          return mapped;
        }
        return [...prev, ...mapped];
      });
      setAiNotice(
        `Generated ${mapped.length} draft question${mapped.length === 1 ? '' : 's'}. Review, edit if needed, and click "Approve Draft" on each before publishing.`
      );
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      setAiNotice(appErr?.message ?? 'AI generator unavailable. Continue adding questions manually.');
    } finally {
      setAiGenerating(false);
    }
  }

  async function handleSave() {
    const err = validateStep(2);
    if (err) {
      setError(err);
      return;
    }

    setSaving(true);
    setError('');

    try {
      const questionPayload: QuestionSaveInput[] = questions.map((q) => ({
        id: q.dbId,
        section: q.section.trim() || 'Section A',
        question_type: q.question_type,
        question_text: q.question_text.trim(),
        options: q.question_type === 'descriptive' ? [] : q.options.map((o) => o.trim()),
        correct_options: q.question_type === 'descriptive' ? [] : q.correct_options,
        marks: q.marks,
        explanation: q.explanation.trim(),
        model_answer: q.model_answer.trim(),
        ai_generated: q.ai_generated,
        approved: q.approved,
      }));

      const saved = await examService.saveExam({
        exam: {
          id: editExamId ?? undefined,
          title: title.trim(),
          course_code: courseCode.trim(),
          course_name: courseName.trim(),
          duration_minutes: durationMinutes,
          starts_at: startsAt ? new Date(startsAt).toISOString() : null,
          ends_at: endsAt ? new Date(endsAt).toISOString() : null,
          negative_marking_ratio: negativeRatio,
          pass_percentage: passPercentage,
          max_attempts: maxAttempts,
          shuffle_questions: shuffleQuestions,
          shuffle_options: shuffleOptions,
          access_mode: accessMode,
          instructions,
          status: publishImmediately ? 'published' : 'draft',
        },
        questions: questionPayload,
        assignments: parseAssignedList(),
      });

      onCreated(saved);
    } catch (e) {
      const appErr = e instanceof AppError ? e : null;
      setError(appErr?.message ?? (e instanceof Error ? e.message : 'Failed to save exam. Please try again.'));
    } finally {
      setSaving(false);
    }
  }

  const computedMarks = questions.filter((q) => q.approved).reduce((sum, q) => sum + q.marks, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-neutral-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white rounded-2xl card-shadow-lg w-full max-w-3xl max-h-[90vh] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-neutral-200">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-10 w-10 rounded-xl bg-brand-50">
              <Plus className="h-5 w-5 text-brand-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-neutral-900">
                {editExamId ? 'Edit Examination' : 'Create New Exam'}
              </h2>
              <p className="text-sm text-neutral-500">Step {step + 1} of {STEPS.length} — {STEPS[step]}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-neutral-100 bg-neutral-50">
          {STEPS.map((label, i) => {
            const isActive = i === step;
            const isDone = i < step;
            return (
              <div key={label} className="flex items-center">
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${isActive ? 'bg-brand-600 text-white' : isDone ? 'bg-success-50 text-success-700' : 'text-neutral-400'}`}>
                  <span className={`flex items-center justify-center h-5 w-5 rounded-full text-xs ${isActive ? 'bg-white/25 text-white' : isDone ? 'bg-success-600 text-white' : 'bg-neutral-200 text-neutral-500'}`}>
                    {isDone ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  {label}
                </div>
                {i < STEPS.length - 1 && <div className={`w-4 h-px ${isDone ? 'bg-success-400' : 'bg-neutral-200'}`} />}
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loadingExisting ? (
            <div className="py-16 text-center">
              <Loader2 className="h-8 w-8 text-brand-500 animate-spin mx-auto mb-3" />
              <p className="text-sm text-neutral-500">Loading examination configuration…</p>
            </div>
          ) : (
            <>
              {error && (
                <div className="flex items-start gap-2 p-3 mb-5 rounded-xl bg-error-50 border border-error-200 text-error-700 text-sm animate-fade-in">
                  <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {/* Step 1 — Exam Details */}
              {step === 0 && (
                <div className="space-y-5 animate-fade-in">
                  <div className="flex items-center gap-2 text-sm font-semibold text-brand-600 mb-2">
                    <ClipboardList className="h-4 w-4" />
                    EXAM DETAILS
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-neutral-700 mb-1.5">Exam Title</label>
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="e.g. Data Structures & Algorithms — Final Examination"
                      className="w-full px-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-neutral-700 mb-1.5">Course Code</label>
                      <input
                        type="text"
                        value={courseCode}
                        onChange={(e) => setCourseCode(e.target.value)}
                        placeholder="e.g. CS 401"
                        className="w-full px-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-neutral-700 mb-1.5">Course Name</label>
                      <input
                        type="text"
                        value={courseName}
                        onChange={(e) => setCourseName(e.target.value)}
                        placeholder="e.g. Data Structures & Algorithms"
                        className="w-full px-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-semibold text-neutral-700 mb-1.5">Duration (minutes)</label>
                      <input
                        type="number"
                        value={durationMinutes}
                        onChange={(e) => setDurationMinutes(parseInt(e.target.value) || 0)}
                        min={1}
                        max={600}
                        className="w-full px-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-neutral-700 mb-1.5">Pass Percentage (%)</label>
                      <input
                        type="number"
                        value={passPercentage}
                        onChange={(e) => setPassPercentage(Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                        min={0}
                        max={100}
                        className="w-full px-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="text-xs font-semibold text-brand-600 hover:text-brand-700"
                    >
                      {showAdvanced ? 'Hide schedule, security & grading rules' : 'Configure schedule, negative marking, randomization & student access'}
                    </button>
                    <label className="flex items-center gap-2 text-xs font-semibold text-neutral-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={publishImmediately}
                        onChange={(e) => setPublishImmediately(e.target.checked)}
                        className="rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                      />
                      Publish immediately
                    </label>
                  </div>

                  {showAdvanced && (
                    <div className="p-4 rounded-xl bg-neutral-50 border border-neutral-200 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-semibold text-neutral-600 mb-1">Start Window (Optional)</label>
                          <input
                            type="datetime-local"
                            value={startsAt}
                            onChange={(e) => setStartsAt(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-900"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-neutral-600 mb-1">End Window (Optional)</label>
                          <input
                            type="datetime-local"
                            value={endsAt}
                            onChange={(e) => setEndsAt(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-900"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-neutral-600 mb-1">Negative Marking</label>
                          <select
                            value={String(negativeRatio)}
                            onChange={(e) => setNegativeRatio(Number(e.target.value))}
                            className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm bg-white"
                          >
                            <option value="0">None (0%)</option>
                            <option value="0.25">-25% per wrong</option>
                            <option value="0.333">-33% per wrong</option>
                            <option value="0.5">-50% per wrong</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-neutral-600 mb-1">Attempt Limit</label>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            value={maxAttempts}
                            onChange={(e) => setMaxAttempts(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                            className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm bg-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-neutral-600 mb-1">Student Access</label>
                          <select
                            value={accessMode}
                            onChange={(e) => setAccessMode(e.target.value as 'code' | 'assigned')}
                            className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm bg-white"
                          >
                            <option value="code">Any Student with Join Code</option>
                            <option value="assigned">Authorized Roster Only</option>
                          </select>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-5 pt-1">
                        <label className="flex items-center gap-2 text-xs font-medium text-neutral-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={shuffleQuestions}
                            onChange={(e) => setShuffleQuestions(e.target.checked)}
                            className="rounded border-neutral-300 text-brand-600"
                          />
                          Randomize question order
                        </label>
                        <label className="flex items-center gap-2 text-xs font-medium text-neutral-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={shuffleOptions}
                            onChange={(e) => setShuffleOptions(e.target.checked)}
                            className="rounded border-neutral-300 text-brand-600"
                          />
                          Randomize answer options
                        </label>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-neutral-600 mb-1">
                          Authorized Student Emails (one per line or comma-separated)
                        </label>
                        <textarea
                          rows={2}
                          value={assignedEmailsRaw}
                          onChange={(e) => setAssignedEmailsRaw(e.target.value)}
                          placeholder="student1@university.edu, student2@university.edu"
                          className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-xs bg-white"
                        />
                      </div>
                    </div>
                  )}

                  <div className="p-4 rounded-xl bg-neutral-50 border border-neutral-200">
                    <p className="text-xs text-neutral-500 leading-relaxed">
                      {publishImmediately ? (
                        <>
                          The exam will be <span className="font-semibold text-success-700">published</span> immediately with a unique 8-character joining code.
                        </>
                      ) : (
                        <>
                          The exam will be saved as a <span className="font-semibold text-neutral-700">draft</span>. You can publish it anytime from the dashboard when ready.
                        </>
                      )}
                    </p>
                  </div>
                </div>
              )}

              {/* Step 2 — Instructions */}
              {step === 1 && (
                <div className="space-y-5 animate-fade-in">
                  <div className="flex items-center gap-2 text-sm font-semibold text-brand-600 mb-2">
                    <FileText className="h-4 w-4" />
                    EXAM INSTRUCTIONS
                  </div>
                  <p className="text-sm text-neutral-500">These instructions will be shown to students before they begin the exam.</p>

                  <div className="space-y-2">
                    {instructions.map((inst, i) => (
                      <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-neutral-50 border border-neutral-200">
                        <span className="flex items-center justify-center h-6 w-6 rounded-full bg-brand-50 text-brand-700 text-xs font-bold flex-shrink-0 mt-0.5">{i + 1}</span>
                        <span className="flex-1 text-sm text-neutral-700 leading-relaxed">{inst}</span>
                        <button
                          onClick={() => removeInstruction(i)}
                          className="p-1 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 transition-colors flex-shrink-0"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newInstruction}
                      onChange={(e) => setNewInstruction(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addInstruction(); } }}
                      placeholder="Add a new instruction…"
                      className="flex-1 px-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                    />
                    <Button variant="outline" onClick={addInstruction}>
                      <Plus className="h-4 w-4" />
                      Add
                    </Button>
                  </div>
                </div>
              )}

              {/* Step 3 — Questions */}
              {step === 2 && (
                <div className="space-y-5 animate-fade-in">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 text-sm font-semibold text-brand-600">
                      <HelpCircle className="h-4 w-4" />
                      QUESTIONS ({questions.length})
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowAiPanel((v) => !v)}
                    >
                      <Sparkles className="h-4 w-4 text-brand-600" />
                      {showAiPanel ? 'Hide AI Generator' : 'AI Question Generator'}
                    </Button>
                  </div>

                  {/* Optional AI Question Paper Generator */}
                  {showAiPanel && (
                    <div className="p-4 rounded-2xl bg-brand-50/70 border border-brand-200 space-y-3">
                      <p className="text-xs font-semibold text-brand-800">
                        Generate draft questions via configured AI / Local Ollama — all drafts require instructor review and approval.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <input
                          type="text"
                          value={aiSubject}
                          onChange={(e) => setAiSubject(e.target.value)}
                          placeholder="Subject (e.g. Data Structures)"
                          className="px-3 py-2 rounded-lg border border-neutral-300 text-sm bg-white"
                        />
                        <input
                          type="text"
                          value={aiTopic}
                          onChange={(e) => setAiTopic(e.target.value)}
                          placeholder="Topic (e.g. Graph Shortest Paths)"
                          className="px-3 py-2 rounded-lg border border-neutral-300 text-sm bg-white"
                        />
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <select
                          value={aiDifficulty}
                          onChange={(e) => setAiDifficulty(e.target.value as 'easy' | 'medium' | 'hard')}
                          className="px-3 py-2 rounded-lg border border-neutral-300 text-xs bg-white"
                        >
                          <option value="easy">Easy</option>
                          <option value="medium">Medium</option>
                          <option value="hard">Hard</option>
                        </select>
                        <select
                          value={aiQType}
                          onChange={(e) => setAiQType(e.target.value as QuestionType)}
                          className="px-3 py-2 rounded-lg border border-neutral-300 text-xs bg-white"
                        >
                          <option value="mcq">Single Choice</option>
                          <option value="multi_select">Multiple Select</option>
                          <option value="true_false">True / False</option>
                          <option value="descriptive">Descriptive</option>
                        </select>
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={aiCount}
                          onChange={(e) => setAiCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                          title="Question count"
                          className="px-3 py-2 rounded-lg border border-neutral-300 text-xs bg-white"
                        />
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={aiMarks}
                          onChange={(e) => setAiMarks(Math.max(1, parseInt(e.target.value) || 1))}
                          title="Marks per question"
                          className="px-3 py-2 rounded-lg border border-neutral-300 text-xs bg-white"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        {aiNotice ? (
                          <span className="text-xs text-brand-800 flex-1">{aiNotice}</span>
                        ) : (
                          <span className="text-xs text-neutral-500">Count & marks configurable above.</span>
                        )}
                        <Button size="sm" onClick={() => void handleGenerateAiQuestions()} disabled={aiGenerating}>
                          {aiGenerating ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Generating…
                            </>
                          ) : (
                            <>
                              <Sparkles className="h-3.5 w-3.5" />
                              Generate Drafts
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Section input */}
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-semibold text-neutral-600">Default section:</label>
                    <input
                      type="text"
                      value={newSection}
                      onChange={(e) => setNewSection(e.target.value)}
                      placeholder="Section name"
                      className="flex-1 px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                    />
                  </div>

                  {questions.map((q, qi) => (
                    <div key={q.id} className="p-5 rounded-2xl border border-neutral-200 bg-neutral-50/50">
                      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-neutral-900">Question {qi + 1}</span>
                          {q.ai_generated && (
                            <span
                              className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                                q.approved
                                  ? 'bg-success-50 text-success-700'
                                  : 'bg-warning-50 text-warning-700'
                              }`}
                            >
                              {q.approved ? 'AI Draft · Approved' : 'AI Draft · Needs Approval'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {q.ai_generated && !q.approved && (
                            <Button
                              size="sm"
                              variant="success"
                              onClick={() => updateQuestion(q.id, { approved: true })}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Approve Draft
                            </Button>
                          )}
                          {questions.length > 1 && (
                            <button
                              onClick={() => removeQuestion(q.id)}
                              className="p-1.5 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 transition-colors"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="space-y-4">
                        {/* Section + type + marks */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs font-semibold text-neutral-500 mb-1">Section</label>
                            <input
                              type="text"
                              value={q.section}
                              onChange={(e) => updateQuestion(q.id, { section: e.target.value })}
                              className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-neutral-500 mb-1">Question Type</label>
                            <select
                              value={q.question_type}
                              onChange={(e) =>
                                updateQuestion(q.id, { question_type: e.target.value as QuestionType })
                              }
                              className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-900 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                            >
                              <option value="mcq">Multiple Choice (Single)</option>
                              <option value="multi_select">Multiple Select</option>
                              <option value="true_false">True / False</option>
                              <option value="descriptive">Descriptive (Manual Grade)</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-semibold text-neutral-500 mb-1">Marks</label>
                            <input
                              type="number"
                              value={q.marks}
                              onChange={(e) => updateQuestion(q.id, { marks: parseInt(e.target.value) || 1 })}
                              min={1}
                              className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                            />
                          </div>
                        </div>

                        {/* Question text */}
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 mb-1">Question Text</label>
                          <textarea
                            value={q.question_text}
                            onChange={(e) => updateQuestion(q.id, { question_text: e.target.value })}
                            rows={2}
                            placeholder="Enter your question…"
                            className="w-full px-3 py-2.5 rounded-lg border border-neutral-300 text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all resize-none"
                          />
                        </div>

                        {/* Options or Descriptive Rubric */}
                        {q.question_type === 'descriptive' ? (
                          <div>
                            <label className="block text-xs font-semibold text-neutral-500 mb-1">
                              Reference Answer / Grading Rubric (Visible only to Faculty)
                            </label>
                            <textarea
                              value={q.model_answer}
                              onChange={(e) => updateQuestion(q.id, { model_answer: e.target.value })}
                              rows={2}
                              placeholder="Key points required for full marks…"
                              className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-900 placeholder-neutral-400 resize-none"
                            />
                          </div>
                        ) : (
                          <div>
                            <label className="block text-xs font-semibold text-neutral-500 mb-2">
                              Options ({q.question_type === 'multi_select' ? 'select all correct answers' : 'select the correct answer'})
                            </label>
                            <div className="space-y-2">
                              {q.options.map((opt, oi) => {
                                const isCorrect = q.correct_options.includes(oi);
                                return (
                                  <div key={oi} className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => toggleCorrectOption(q.id, oi)}
                                      className={`flex items-center justify-center h-7 w-7 rounded-full border-2 text-xs font-bold flex-shrink-0 transition-all ${isCorrect ? 'border-success-600 bg-success-600 text-white' : 'border-neutral-300 text-neutral-400 hover:border-neutral-400'}`}
                                      title="Mark as correct answer"
                                    >
                                      {String.fromCharCode(65 + oi)}
                                    </button>
                                    <input
                                      type="text"
                                      value={opt}
                                      disabled={q.question_type === 'true_false'}
                                      onChange={(e) => updateOption(q.id, oi, e.target.value)}
                                      placeholder={`Option ${String.fromCharCode(65 + oi)}`}
                                      className={`flex-1 px-3 py-2 rounded-lg border text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:border-transparent transition-all ${isCorrect ? 'border-success-400 bg-success-50 focus:ring-success-500' : 'border-neutral-300 focus:ring-brand-500'}`}
                                    />
                                    {isCorrect && (
                                      <span className="flex items-center gap-1 text-xs font-semibold text-success-600 flex-shrink-0">
                                        <Check className="h-3.5 w-3.5" />
                                        Correct
                                      </span>
                                    )}
                                    {q.question_type !== 'true_false' && q.options.length > 2 && (
                                      <button
                                        type="button"
                                        onClick={() => removeOption(q.id, oi)}
                                        className="p-1 rounded text-neutral-400 hover:text-error-600 transition-colors flex-shrink-0"
                                      >
                                        <X className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            {q.question_type !== 'true_false' && q.options.length < 6 && (
                              <button
                                type="button"
                                onClick={() => addOption(q.id)}
                                className="mt-2 flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700 transition-colors"
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Add option
                              </button>
                            )}
                          </div>
                        )}

                        {/* Optional answer explanation */}
                        <div>
                          <label className="block text-xs font-semibold text-neutral-500 mb-1">
                            Explanation (Shown to students only after results are published)
                          </label>
                          <input
                            type="text"
                            value={q.explanation}
                            onChange={(e) => updateQuestion(q.id, { explanation: e.target.value })}
                            placeholder="Optional explanation for the correct answer…"
                            className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-xs text-neutral-900 placeholder-neutral-400"
                          />
                        </div>
                      </div>
                    </div>
                  ))}

                  <Button variant="outline" fullWidth onClick={addQuestion}>
                    <Plus className="h-4 w-4" />
                    Add Question
                  </Button>

                  {/* Summary */}
                  <div className="flex items-center gap-4 p-4 rounded-xl bg-brand-50 border border-brand-200">
                    <Award className="h-5 w-5 text-brand-600 flex-shrink-0" />
                    <div className="flex-1 text-sm">
                      <span className="font-semibold text-brand-800">{questions.length} questions</span>
                      <span className="text-brand-600"> · </span>
                      <span className="font-semibold text-brand-800">{computedMarks} approved marks</span>
                    </div>
                    <span className="text-xs text-brand-500">Auto-calculated</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-neutral-200">
          <Button variant="ghost" onClick={step === 0 ? onClose : prevStep}>
            {step === 0 ? (<><X className="h-4 w-4" />Cancel</>) : (<><ArrowLeft className="h-4 w-4" />Back</>)}
          </Button>
          {step < 2 ? (
            <Button onClick={nextStep} disabled={loadingExisting} className="group">
              Continue
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Button>
          ) : (
            <Button variant="success" onClick={handleSave} disabled={saving || loadingExisting}>
              {saving ? (
                <><Loader2 className="h-4 w-4 animate-spin" />Saving…</>
              ) : (
                <><Save className="h-4 w-4" />{editExamId ? 'Save Changes' : 'Create Exam'}</>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
