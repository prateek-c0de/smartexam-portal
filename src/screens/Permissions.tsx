import { useState } from 'react';
import Button from '@/components/Button';
import ExamHeader from '@/components/ExamHeader';
import type { PermissionState, User } from '@/types';
import {
  Camera,
  Mic,
  ScreenShare,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';

interface PermissionsProps {
  user: User;
  step: number;
  stepLabels: string[];
  onContinue: () => void;
  onBack: () => void;
  onLogout: () => void;
}

interface PermCheck {
  key: string;
  icon: typeof Camera;
  label: string;
  description: string;
  state: PermissionState;
}

export default function PermissionsScreen({
  user,
  step,
  stepLabels,
  onContinue,
  onBack,
  onLogout,
}: PermissionsProps) {
  const [checks, setChecks] = useState<PermCheck[]>([
    {
      key: 'camera',
      icon: Camera,
      label: 'Webcam Access',
      description: 'Required for live face monitoring during the exam.',
      state: 'pending',
    },
    {
      key: 'microphone',
      icon: Mic,
      label: 'Microphone Access',
      description: 'Required to detect voices and background audio.',
      state: 'pending',
    },
    {
      key: 'screen',
      icon: ScreenShare,
      label: 'Screen Sharing',
      description: 'Required to monitor for tab switching and external apps.',
      state: 'pending',
    },
  ]);
  const [requesting, setRequesting] = useState<string | null>(null);

  async function requestPermission(key: string) {
    setRequesting(key);
    let result: PermissionState;

    if (key === 'camera') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => t.stop());
        result = 'granted';
      } catch {
        result = 'denied';
      }
    } else if (key === 'microphone') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        result = 'granted';
      } catch {
        result = 'denied';
      }
    } else {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        result = 'unsupported';
      } else {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
          stream.getTracks().forEach((t) => t.stop());
          result = 'granted';
        } catch {
          result = 'denied';
        }
      }
    }

    setChecks((prev) => prev.map((c) => (c.key === key ? { ...c, state: result } : c)));
    setRequesting(null);
  }

  const allGranted = checks.every((c) => c.state === 'granted');
  const anyDenied = checks.some((c) => c.state === 'denied' || c.state === 'unsupported');

  return (
    <div className="min-h-screen bg-neutral-50">
      <ExamHeader user={user} step={step} totalSteps={stepLabels.length} stepLabels={stepLabels} onLogout={onLogout} />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-600 mb-2">
            <ShieldCheck className="h-4 w-4" />
            PERMISSIONS
          </div>
          <h1 className="text-3xl font-bold text-neutral-900">Grant Exam Permissions</h1>
          <p className="text-neutral-500 mt-2">
            SmartExam needs access to your camera, microphone, and screen for proctoring.
            Click each button below to grant permission.
          </p>
        </div>

        {/* Permission cards */}
        <div className="space-y-4">
          {checks.map((check) => (
            <div
              key={check.key}
              className={`bg-white rounded-2xl card-shadow p-5 flex items-center gap-4 transition-all animate-slide-up ${
                check.state === 'granted' ? 'ring-2 ring-success-300' : ''
              }`}
            >
              <div
                className={`flex items-center justify-center h-12 w-12 rounded-xl flex-shrink-0 transition-colors ${
                  check.state === 'granted'
                    ? 'bg-success-50'
                    : check.state === 'denied' || check.state === 'unsupported'
                      ? 'bg-error-50'
                      : 'bg-brand-50'
                }`}
              >
                <check.icon
                  className={`h-6 w-6 ${
                    check.state === 'granted'
                      ? 'text-success-600'
                      : check.state === 'denied' || check.state === 'unsupported'
                        ? 'text-error-500'
                        : 'text-brand-600'
                  }`}
                />
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-neutral-900">{check.label}</p>
                <p className="text-sm text-neutral-500">{check.description}</p>
              </div>

              <div className="flex-shrink-0">
                {check.state === 'pending' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => requestPermission(check.key)}
                    disabled={requesting !== null}
                  >
                    {requesting === check.key ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Camera className="h-4 w-4" />
                    )}
                    Allow
                  </Button>
                ) : check.state === 'granted' ? (
                  <div className="flex items-center gap-1.5 text-success-600 font-semibold text-sm">
                    <CheckCircle2 className="h-5 w-5" />
                    Granted
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 text-error-500 font-semibold text-sm">
                      <XCircle className="h-5 w-5" />
                      {check.state === 'unsupported' ? 'N/A' : 'Denied'}
                    </div>
                    {check.state === 'denied' && (
                      <button
                        onClick={() => requestPermission(check.key)}
                        className="p-1.5 rounded-lg text-neutral-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                        title="Retry"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Status message */}
        {anyDenied && (
          <div className="mt-6 p-4 rounded-xl bg-warning-50 border border-warning-200 animate-fade-in">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-warning-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-warning-800">Permission Required</p>
                <p className="text-sm text-warning-700 mt-1 leading-relaxed">
                  Some permissions were denied. You can still continue, but the proctoring system
                  may flag your session. To fix this, click the retry icon or update your browser
                  site settings.
                </p>
              </div>
            </div>
          </div>
        )}

        {allGranted && (
          <div className="mt-6 p-4 rounded-xl bg-success-50 border border-success-200 animate-fade-in">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 text-success-600" />
              <p className="text-sm font-semibold text-success-800">
                All permissions granted. You're ready for face verification.
              </p>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            size="lg"
            onClick={onContinue}
            disabled={checks.some((c) => c.state === 'pending')}
            className="group"
          >
            Continue to Face Verification
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
