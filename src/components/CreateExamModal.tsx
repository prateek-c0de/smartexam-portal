import { useState } from 'react';
import Button from '@/components/Button';
import { supabase } from '@/lib/supabase';
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
} from 'lucide-react';

interface QuestionInput {
  id: string;
  section: string;
  question_text: string;
  options: string[];
  correct_answer: number;
  marks: number;
}

interface CreateExamModalProps {
  onClose: () => void;
  onCreated: () => void;
}

const STEPS = ['Exam Details', 'Instructions', 'Questions'] as const;
type StepIndex = 0 | 1 | 2;

export default function CreateExamModal({ onClose, onCreated }: CreateExamModalProps) {
  const [step, setStep] = useState<StepIndex>(0);

  // Step 1 — Exam details
  const [title, setTitle] = useState('');
  const [courseCode, setCourseCode] = useState('');
  const [courseName, setCourseName] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [totalMarks, setTotalMarks] = useState(100);

  // Step 2 — Instructions
  const [instructions, setInstructions] = useState<string[]>([
    'This exam contains multiple-choice questions.',
    'The timer cannot be paused once started.',
    'Each question has exactly one correct answer.',
    'The exam will auto-submit when the timer reaches zero.',
    'Your webcam, microphone, and screen will be monitored for integrity.',
  ]);
  const [newInstruction, setNewInstruction] = useState('');

  // Step 3 — Questions
  const [questions, setQuestions] = useState<QuestionInput[]>([
    { id: cryptoId(), section: 'Section A', question_text: '', options: ['', '', '', ''], correct_answer: 0, marks: 5 },
  ]);
  const [newSection, setNewSection] = useState('Section A');

  // Error / loading
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function cryptoId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // --- Validation ---
  function validateStep(s: StepIndex): string | null {
    if (s === 0) {
      if (!title.trim()) return 'Exam title is required.';
      if (!courseCode.trim()) return 'Course code is required.';
      if (!courseName.trim()) return 'Course name is required.';
      if (durationMinutes < 1) return 'Duration must be at least 1 minute.';
      if (totalMarks < 1) return 'Total marks must be at least 1.';
    }
    if (s === 1) {
      if (instructions.length === 0) return 'At least one instruction is required.';
    }
    if (s === 2) {
      if (questions.length === 0) return 'At least one question is required.';
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q.question_text.trim()) return `Question ${i + 1}: question text is required.`;
        if (q.options.some((o) => !o.trim())) return `Question ${i + 1}: all options must be filled.`;
        if (q.options.length < 2) return `Question ${i + 1}: at least 2 options required.`;
        if (q.marks < 1) return `Question ${i + 1}: marks must be at least 1.`;
      }
    }
    return null;
  }

  function nextStep() {
    const err = validateStep(step);
    if (err) { setError(err); return; }
    setError('');
    if (step < 2) setStep((step + 1) as StepIndex);
  }

  function prevStep() {
    setError('');
    if (step > 0) setStep((step - 1) as StepIndex);
  }

  // --- Instructions ---
  function addInstruction() {
    if (newInstruction.trim()) {
      setInstructions([...instructions, newInstruction.trim()]);
      setNewInstruction('');
    }
  }

  function removeInstruction(i: number) {
    setInstructions(instructions.filter((_, idx) => idx !== i));
  }

  // --- Questions ---
  function addQuestion() {
    setQuestions([
      ...questions,
      { id: cryptoId(), section: newSection, question_text: '', options: ['', '', '', ''], correct_answer: 0, marks: 5 },
    ]);
  }

  function removeQuestion(id: string) {
    setQuestions(questions.filter((q) => q.id !== id));
  }

  function updateQuestion(id: string, field: keyof QuestionInput, value: unknown) {
    setQuestions(questions.map((q) => (q.id === id ? { ...q, [field]: value } : q)));
  }

  function updateOption(qId: string, optIdx: number, value: string) {
    setQuestions(questions.map((q) => {
      if (q.id !== qId) return q;
      const opts = [...q.options];
      opts[optIdx] = value;
      return { ...q, options: opts };
    }));
  }

  function addOption(qId: string) {
    setQuestions(questions.map((q) => (q.id === qId ? { ...q, options: [...q.options, ''] } : q)));
  }

  function removeOption(qId: string, optIdx: number) {
    setQuestions(questions.map((q) => {
      if (q.id !== qId) return q;
      if (q.options.length <= 2) return q;
      const opts = q.options.filter((_, i) => i !== optIdx);
      let correct = q.correct_answer;
      if (optIdx === correct) correct = 0;
      else if (optIdx < correct) correct -= 1;
      return { ...q, options: opts, correct_answer: correct };
    }));
  }

  // --- Submit ---
  async function handleSave() {
    const err = validateStep(2);
    if (err) { setError(err); return; }

    setSaving(true);
    setError('');

    try {
      const { data: exam, error: examErr } = await supabase
        .from('exams')
        .insert({
          title: title.trim(),
          course_code: courseCode.trim(),
          course_name: courseName.trim(),
          duration_minutes: durationMinutes,
          total_questions: questions.length,
          total_marks: questions.reduce((sum, q) => sum + q.marks, 0),
          status: 'draft',
          instructions,
        })
        .select()
        .single();

      if (examErr) throw new Error(examErr.message);
      if (!exam) throw new Error('Failed to create exam — no data returned.');

      const questionRows = questions.map((q, i) => ({
        exam_id: exam.id,
        section: q.section.trim() || 'Section A',
        question_text: q.question_text.trim(),
        options: q.options.map((o) => o.trim()),
        correct_answer: q.correct_answer,
        marks: q.marks,
        display_order: i + 1,
      }));

      const { error: qErr } = await supabase.from('questions').insert(questionRows);
      if (qErr) throw new Error(qErr.message);

      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create exam. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const computedMarks = questions.reduce((sum, q) => sum + q.marks, 0);

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
              <h2 className="text-lg font-bold text-neutral-900">Create New Exam</h2>
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
                    className="w-full px-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-neutral-700 mb-1.5">Total Marks</label>
                  <input
                    type="number"
                    value={totalMarks}
                    onChange={(e) => setTotalMarks(parseInt(e.target.value) || 0)}
                    min={1}
                    className="w-full px-4 py-3 rounded-xl border border-neutral-300 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                  />
                </div>
              </div>
              <div className="p-4 rounded-xl bg-neutral-50 border border-neutral-200">
                <p className="text-xs text-neutral-500 leading-relaxed">
                  The exam will be saved as a <span className="font-semibold text-neutral-700">draft</span>. You can activate it later from the dashboard once you're ready for students to access it.
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
              <div className="flex items-center gap-2 text-sm font-semibold text-brand-600 mb-2">
                <HelpCircle className="h-4 w-4" />
                QUESTIONS ({questions.length})
              </div>

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
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-sm font-bold text-neutral-900">Question {qi + 1}</span>
                    {questions.length > 1 && (
                      <button
                        onClick={() => removeQuestion(q.id)}
                        className="p-1.5 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <div className="space-y-4">
                    {/* Section + marks */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-neutral-500 mb-1">Section</label>
                        <input
                          type="text"
                          value={q.section}
                          onChange={(e) => updateQuestion(q.id, 'section', e.target.value)}
                          className="w-full px-3 py-2 rounded-lg border border-neutral-300 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-neutral-500 mb-1">Marks</label>
                        <input
                          type="number"
                          value={q.marks}
                          onChange={(e) => updateQuestion(q.id, 'marks', parseInt(e.target.value) || 1)}
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
                        onChange={(e) => updateQuestion(q.id, 'question_text', e.target.value)}
                        rows={2}
                        placeholder="Enter your question…"
                        className="w-full px-3 py-2.5 rounded-lg border border-neutral-300 text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all resize-none"
                      />
                    </div>

                    {/* Options */}
                    <div>
                      <label className="block text-xs font-semibold text-neutral-500 mb-2">Options (select the correct answer)</label>
                      <div className="space-y-2">
                        {q.options.map((opt, oi) => {
                          const isCorrect = q.correct_answer === oi;
                          return (
                            <div key={oi} className="flex items-center gap-2">
                              <button
                                onClick={() => updateQuestion(q.id, 'correct_answer', oi)}
                                className={`flex items-center justify-center h-7 w-7 rounded-full border-2 text-xs font-bold flex-shrink-0 transition-all ${isCorrect ? 'border-success-600 bg-success-600 text-white' : 'border-neutral-300 text-neutral-400 hover:border-neutral-400'}`}
                                title="Mark as correct answer"
                              >
                                {String.fromCharCode(65 + oi)}
                              </button>
                              <input
                                type="text"
                                value={opt}
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
                              {q.options.length > 2 && (
                                <button
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
                      {q.options.length < 6 && (
                        <button
                          onClick={() => addOption(q.id)}
                          className="mt-2 flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700 transition-colors"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add option
                        </button>
                      )}
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
                  <span className="font-semibold text-brand-800">{computedMarks} total marks</span>
                </div>
                <span className="text-xs text-brand-500">Auto-calculated</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-neutral-200">
          <Button variant="ghost" onClick={step === 0 ? onClose : prevStep}>
            {step === 0 ? (<><X className="h-4 w-4" />Cancel</>) : (<><ArrowLeft className="h-4 w-4" />Back</>)}
          </Button>
          {step < 2 ? (
            <Button onClick={nextStep} className="group">
              Continue
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Button>
          ) : (
            <Button variant="success" onClick={handleSave} disabled={saving}>
              {saving ? (<><Loader2 className="h-4 w-4 animate-spin" />Saving…</>) : (<><Save className="h-4 w-4" />Create Exam</>)}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
