import Button from '@/components/Button';
import ExamHeader from '@/components/ExamHeader';
import type { Exam, User } from '@/types';
import {
  ClipboardList,
  Clock,
  FileText,
  Award,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Monitor,
  Camera,
  Mic,
  ScreenShare,
} from 'lucide-react';

interface InstructionsProps {
  user: User;
  exam: Exam;
  step: number;
  stepLabels: string[];
  onContinue: () => void;
  onLogout: () => void;
}

export default function Instructions({
  user,
  exam,
  step,
  stepLabels,
  onContinue,
  onLogout,
}: InstructionsProps) {
  return (
    <div className="min-h-screen bg-neutral-50">
      <ExamHeader user={user} step={step} totalSteps={stepLabels.length} stepLabels={stepLabels} onLogout={onLogout} />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* Title */}
        <div className="mb-8 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-600 mb-2">
            <ClipboardList className="h-4 w-4" />
            EXAM INSTRUCTIONS
          </div>
          <h1 className="text-3xl font-bold text-neutral-900">{exam.title}</h1>
          <p className="text-neutral-500 mt-2">{exam.courseCode} · {exam.courseName}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Instructions list */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-2xl card-shadow p-6 sm:p-8 animate-slide-up">
              <h2 className="text-lg font-bold text-neutral-900 mb-5 flex items-center gap-2">
                <FileText className="h-5 w-5 text-brand-600" />
                Please Read Carefully
              </h2>
              <ul className="space-y-3">
                {exam.instructions.map((inst, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="flex items-center justify-center h-6 w-6 rounded-full bg-brand-50 text-brand-700 text-xs font-bold flex-shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    <span className="text-sm text-neutral-700 leading-relaxed">{inst}</span>
                  </li>
                ))}
              </ul>

              {/* Warning box */}
              <div className="mt-6 p-4 rounded-xl bg-warning-50 border border-warning-200">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-warning-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-warning-800">Academic Integrity Notice</p>
                    <p className="text-sm text-warning-700 mt-1 leading-relaxed">
                      Any violation of exam rules — including tab switching, leaving full-screen
                      mode, or suspicious behavior — will be recorded and may result in
                      disqualification.
                    </p>
                  </div>
                </div>
              </div>

              {/* Monitoring icons */}
              <div className="mt-6 grid grid-cols-3 gap-3">
                {[
                  { icon: Camera, label: 'Webcam' },
                  { icon: Mic, label: 'Microphone' },
                  { icon: ScreenShare, label: 'Screen Share' },
                ].map((m) => (
                  <div key={m.label} className="flex items-center gap-2 p-3 rounded-xl bg-neutral-50 border border-neutral-200">
                    <m.icon className="h-5 w-5 text-neutral-600" />
                    <span className="text-sm font-medium text-neutral-700">{m.label}</span>
                  </div>
                ))}
              </div>

              {/* Consent checkbox */}
              <label className="flex items-start gap-3 mt-6 cursor-pointer">
                <input type="checkbox" defaultChecked className="mt-1 rounded border-neutral-300 text-brand-600 focus:ring-brand-500" />
                <span className="text-sm text-neutral-700 leading-relaxed">
                  I have read and understood all instructions. I consent to webcam, microphone,
                  and screen monitoring during this examination.
                </span>
              </label>

              <div className="mt-6 flex justify-end">
                <Button size="lg" onClick={onContinue} className="group">
                  I Understand — Continue
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Button>
              </div>
            </div>
          </div>

          {/* Summary sidebar */}
          <div className="space-y-4">
            <div className="bg-white rounded-2xl card-shadow p-6 animate-slide-up">
              <h3 className="text-sm font-bold text-neutral-900 uppercase tracking-wide mb-4">
                Exam Summary
              </h3>
              <div className="space-y-4">
                {[
                  { icon: Clock, label: 'Duration', value: `${exam.durationMinutes} minutes` },
                  { icon: FileText, label: 'Questions', value: `${exam.totalQuestions} MCQs` },
                  { icon: Award, label: 'Total Marks', value: `${exam.totalMarks}` },
                  { icon: Monitor, label: 'Format', value: 'Online Proctored' },
                ].map((item) => (
                  <div key={item.label} className="flex items-center gap-3">
                    <div className="flex items-center justify-center h-10 w-10 rounded-xl bg-brand-50">
                      <item.icon className="h-5 w-5 text-brand-600" />
                    </div>
                    <div>
                      <p className="text-xs text-neutral-500">{item.label}</p>
                      <p className="text-sm font-bold text-neutral-900">{item.value}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-success-50 rounded-2xl border border-success-200 p-5">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="h-5 w-5 text-success-600" />
                <p className="text-sm font-bold text-success-800">You're Prepared!</p>
              </div>
              <p className="text-xs text-success-700 leading-relaxed">
                Make sure you're in a quiet, well-lit room. Have a stable internet connection
                and close all other applications before starting.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
