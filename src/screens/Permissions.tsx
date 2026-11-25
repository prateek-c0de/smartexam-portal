import { useState, useRef, useEffect } from 'react';
import Button from '@/components/Button';
import ExamHeader from '@/components/ExamHeader';
import type { PermissionState, User } from '@/types';
import {
  requestCameraPermission,
  requestMicrophonePermission,
  stopStream,
} from '@/utils/permissions';
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

export interface GrantedMediaHandoff {
  camera: PermissionState;
  microphone: PermissionState;
  screen: PermissionState;
  screenStream: MediaStream | null;
}

interface PermissionsProps {
  user: User;
  step: number;
  stepLabels: string[];
  onContinue: (handoff: GrantedMediaHandoff) => void;
  onBack: () => void;
  onLogout: () => void;
}

interface PermCheck {
  key: 'camera' | 'microphone' | 'screen';
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
      description: 'Required for live face presence monitoring during the exam.',
      state: 'pending',
    },
    {
      key: 'microphone',
      icon: Mic,
      label: 'Microphone Access',
      description: 'Required to detect sustained speech-band audio events.',
      state: 'pending',
    },
    {
      key: 'screen',
      icon: ScreenShare,
      label: 'Screen Sharing',
      description: 'Required to authorize live screen monitoring during the exam.',
      state: 'pending',
    },
  ]);
  const [requesting, setRequesting] = useState<string | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const handedOffRef = useRef(false);

  useEffect(() => {
    return () => {
      if (!handedOffRef.current) {
        stopStream(screenStreamRef.current);
        screenStreamRef.current = null;
      }
    };
  }, []);

  async function requestPermission(key: PermCheck['key']) {
    setRequesting(key);
    let result: PermissionState;

    if (key === 'camera') {
      result = await requestCameraPermission();
    } else if (key === 'microphone') {
      result = await requestMicrophonePermission();
    } else {
      stopStream(screenStreamRef.current);
      screenStreamRef.current = null;
      if (!navigator.mediaDevices?.getDisplayMedia) {
        result = 'unsupported';
      } else {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 6, max: 10 } },
          });
          screenStreamRef.current = stream;
          const videoTrack = stream.getVideoTracks()[0];
          if (videoTrack) {
            videoTrack.onended = () => {
              screenStreamRef.current = null;
              setChecks((prev) =>
                prev.map((c) => (c.key === 'screen' ? { ...c, state: 'pending' } : c))
              );
            };
          }
          result = 'granted';
        } catch {
          result = 'denied';
        }
      }
    }

    setChecks((prev) => prev.map((c) => (c.key === key ? { ...c, state: result } : c)));
    setRequesting(null);
  }

  function handleBack() {
    stopStream(screenStreamRef.current);
    screenStreamRef.current = null;
    onBack();
  }

  function handleLogout() {
    stopStream(screenStreamRef.current);
    screenStreamRef.current = null;
    onLogout();
  }

  function handleContinue() {
    handedOffRef.current = true;
    const byKey = Object.fromEntries(checks.map((c) => [c.key, c.state])) as Record<
      PermCheck['key'],
      PermissionState
    >;
    onContinue({
      camera: byKey.camera,
      microphone: byKey.microphone,
      screen: byKey.screen,
      screenStream: screenStreamRef.current,
    });
  }

  const allGranted = checks.every((c) => c.state === 'granted');
  const anyDenied = checks.some((c) => c.state === 'denied' || c.state === 'unsupported');

  return (
    <div className="min-h-screen bg-neutral-50">
      <ExamHeader user={user} step={step} totalSteps={stepLabels.length} stepLabels={stepLabels} onLogout={handleLogout} />

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
                <p className="text-sm font-semibold text-neutral-900">{check.label}</p>
                <p className="text-sm text-neutral-500">{check.description}</p>
              </div>

              <div className="flex-shrink-0">
                {check.state === 'pending' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void requestPermission(check.key)}
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
                        onClick={() => void requestPermission(check.key)}
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
                <p className="text-sm font-semibold text-warning-800">Permission Notice</p>
                <p className="text-sm text-warning-700 mt-1 leading-relaxed">
                  Some permissions were denied or unavailable. If you have an approved accessibility
                  accommodation you may continue; otherwise technical interruption events will be
                  logged for instructor review. Click retry or update your browser site settings.
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
                All permissions granted. You're ready for camera & face presence verification.
              </p>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            size="lg"
            onClick={handleContinue}
            disabled={checks.some((c) => c.state === 'pending')}
            className="group"
          >
            Continue to Camera Check
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
