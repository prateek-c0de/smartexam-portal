import { useState, useRef, useEffect, useCallback } from 'react';
import Button from '@/components/Button';
import ExamHeader from '@/components/ExamHeader';
import type { User } from '@/types';
import { inspectVideoForFaceCheck } from '@/services/aiProctoringService';
import {
  Camera,
  CheckCircle2,
  Loader2,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  AlertCircle,
  UserCheck,
} from 'lucide-react';

interface FaceVerifyProps {
  user: User;
  step: number;
  stepLabels: string[];
  startingExam?: boolean;
  startError?: string;
  onContinue: () => void;
  onBack: () => void;
  onLogout: () => void;
}

type Phase = 'idle' | 'starting' | 'scanning' | 'verifying' | 'success' | 'failed';

const REQUIRED_CLEAN_FRAMES = 5;

export default function FaceVerify({
  user,
  step,
  stepLabels,
  startingExam = false,
  startError = '',
  onContinue,
  onBack,
  onLogout,
}: FaceVerifyProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const [phase, setPhase] = useState<Phase>('idle');
  const [scanProgress, setScanProgress] = useState(0);
  const [guidance, setGuidance] = useState('Center your face inside the oval guide…');
  const [failReason, setFailReason] = useState('Camera access failed');
  const [modelUnavailable, setModelUnavailable] = useState(false);

  const cleanup = useCallback(() => {
    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const beginRealFaceScan = useCallback(() => {
    setScanProgress(0);
    setGuidance('Loading client-side face detector…');
    let cleanCount = 0;
    let totalAttempts = 0;
    let busy = false;

    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
    }

    scanTimerRef.current = window.setInterval(async () => {
      if (busy || !mountedRef.current || !videoRef.current) return;
      busy = true;
      totalAttempts += 1;

      try {
        const check = await inspectVideoForFaceCheck(videoRef.current);
        if (!mountedRef.current) return;

        if (!check.modelLoaded) {
          setModelUnavailable(true);
          setFailReason('AI face model could not be loaded (network/firewall restriction).');
          setGuidance('You may retry or proceed with technical notice logged for your instructor.');
          setPhase('failed');
          cleanup();
          return;
        }

        if (check.isObstructed) {
          cleanCount = Math.max(0, cleanCount - 1);
          setGuidance('Camera appears dark or obstructed — uncover lens and improve lighting.');
        } else if (check.faceCount === 0) {
          cleanCount = Math.max(0, cleanCount - 1);
          setGuidance('No face detected — look directly toward the camera.');
        } else if (check.faceCount > 1) {
          cleanCount = 0;
          setGuidance('Multiple faces detected — ensure only you are visible in frame.');
        } else if (!check.centered) {
          setGuidance('Move slightly closer and center your face inside the oval.');
        } else {
          cleanCount += 1;
          setGuidance('Hold steady — confirming single-person camera presence…');
        }

        const pct = Math.min(100, Math.round((cleanCount / REQUIRED_CLEAN_FRAMES) * 100));
        setScanProgress(pct);

        if (cleanCount >= REQUIRED_CLEAN_FRAMES) {
          setPhase('verifying');
          cleanup();
          if (mountedRef.current) {
            setPhase('success');
          }
          return;
        }

        // Timeout after ~24 seconds so the student gets a clear retry button
        if (totalAttempts >= 45) {
          setFailReason('Could not confirm a clear single-person face frame in time.');
          setPhase('failed');
          cleanup();
        }
      } finally {
        busy = false;
      }
    }, 520);
  }, [cleanup]);

  const startCamera = useCallback(async () => {
    setPhase('starting');
    setModelUnavailable(false);
    setScanProgress(0);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase('scanning');
      beginRealFaceScan();
    } catch {
      if (mountedRef.current) {
        setFailReason('Camera access denied or unavailable.');
        setPhase('failed');
      }
    }
  }, [beginRealFaceScan]);

  useEffect(() => {
    mountedRef.current = true;
    void startCamera();
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [startCamera, cleanup]);

  function retry() {
    cleanup();
    void startCamera();
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <ExamHeader
        user={user}
        step={step}
        totalSteps={stepLabels.length}
        stepLabels={stepLabels}
        onLogout={() => {
          cleanup();
          onLogout();
        }}
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-600 mb-2">
            <ScanFace className="h-4 w-4" />
            CAMERA & FACE PRESENCE CHECK
          </div>
          <h1 className="text-3xl font-bold text-neutral-900">Pre-Exam Camera Check</h1>
          <p className="text-neutral-500 mt-2">
            Look directly at the camera so we can confirm clear lighting and single-person face presence before starting.
          </p>
        </div>

        {startError && (
          <div className="flex items-start gap-2 p-4 mb-6 rounded-xl bg-error-50 border border-error-200 text-error-700 text-sm animate-fade-in">
            <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <span>{startError}</span>
          </div>
        )}

        {/* Camera view */}
        <div className="bg-white rounded-2xl card-shadow-lg p-6 sm:p-8 animate-slide-up">
          <div className="relative aspect-video max-w-2xl mx-auto rounded-2xl overflow-hidden bg-neutral-900">
            {/* Video feed */}
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover"
              playsInline
              muted
            />

            {/* Overlay states */}
            {phase === 'idle' || phase === 'starting' ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3">
                <Loader2 className="h-10 w-10 animate-spin text-brand-400" />
                <p className="text-sm text-neutral-300">Starting camera…</p>
              </div>
            ) : null}

            {phase === 'failed' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3 px-6 text-center bg-neutral-900/90">
                <AlertCircle className="h-10 w-10 text-error-400" />
                <p className="text-sm font-semibold">{failReason}</p>
                <p className="text-xs text-neutral-400">
                  Ensure you are in a well-lit area with your webcam unobstructed, or retry below.
                </p>
              </div>
            )}

            {/* Face frame overlay */}
            {(phase === 'scanning' || phase === 'verifying') && (
              <div className="absolute inset-0 pointer-events-none">
                {/* Face guide oval */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                  <div className="w-48 h-60 rounded-[50%] border-2 border-brand-400/70 animate-pulse-ring" />
                </div>
                {/* Corner brackets */}
                {[
                  'top-4 left-4 border-t-2 border-l-2 rounded-tl-lg',
                  'top-4 right-4 border-t-2 border-r-2 rounded-tr-lg',
                  'bottom-4 left-4 border-b-2 border-l-2 rounded-bl-lg',
                  'bottom-4 right-4 border-b-2 border-r-2 rounded-br-lg',
                ].map((pos) => (
                  <div key={pos} className={`absolute w-10 h-10 border-brand-400/80 ${pos}`} />
                ))}
                {/* Scan line */}
                {phase === 'scanning' && (
                  <div
                    className="absolute left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-brand-400 to-transparent shadow-lg shadow-brand-400/50"
                    style={{ top: `${scanProgress}%`, transition: 'top 0.15s linear' }}
                  />
                )}
                {/* Status text */}
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/65 backdrop-blur-sm max-w-[90%]">
                  <p className="text-xs sm:text-sm font-semibold text-white flex items-center gap-2 truncate">
                    {phase === 'scanning' ? (
                      <>
                        <ScanFace className="h-4 w-4 text-brand-400 flex-shrink-0" />
                        <span className="truncate">{guidance} ({scanProgress}%)</span>
                      </>
                    ) : (
                      <>
                        <Loader2 className="h-4 w-4 text-brand-400 animate-spin flex-shrink-0" />
                        <span>Finalizing check…</span>
                      </>
                    )}
                  </p>
                </div>
              </div>
            )}

            {phase === 'success' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-success-600/90 gap-4 animate-fade-in">
                <div className="flex items-center justify-center h-20 w-20 rounded-full bg-white/20">
                  <CheckCircle2 className="h-12 w-12 text-white" />
                </div>
                <p className="text-lg font-bold text-white">Face Presence Confirmed!</p>
                <p className="text-sm text-success-100">
                  Single-person camera framing and lighting check passed.
                </p>
              </div>
            )}
          </div>

          {/* Progress bar during scan */}
          {(phase === 'scanning' || phase === 'verifying') && (
            <div className="mt-6 max-w-2xl mx-auto">
              <div className="w-full h-2 bg-neutral-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-brand-500 to-brand-600 rounded-full transition-all duration-150"
                  style={{ width: `${phase === 'verifying' ? 100 : scanProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Info row */}
          <div className="mt-6 grid grid-cols-3 gap-3 max-w-2xl mx-auto">
            {[
              { icon: UserCheck, label: 'Face Detected', active: scanProgress >= 20 || phase === 'success' },
              { icon: ShieldCheck, label: 'Lighting & Frame', active: scanProgress >= 60 || phase === 'success' },
              { icon: CheckCircle2, label: 'Camera Ready', active: phase === 'success' },
            ].map((item) => (
              <div
                key={item.label}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl transition-colors ${
                  item.active ? 'bg-success-50' : 'bg-neutral-50'
                }`}
              >
                <item.icon className={`h-5 w-5 ${item.active ? 'text-success-600' : 'text-neutral-400'}`} />
                <span className={`text-xs font-semibold ${item.active ? 'text-success-700' : 'text-neutral-400'}`}>
                  {item.label}
                </span>
              </div>
            ))}
          </div>

          {/* Actions */}
          {phase === 'failed' && (
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button variant="outline" onClick={retry}>
                <RefreshCw className="h-4 w-4" />
                Try Again
              </Button>
              {modelUnavailable && (
                <Button variant="ghost" onClick={onContinue} disabled={startingExam}>
                  Proceed with Instructor Notice
                </Button>
              )}
            </div>
          )}

          {/* Privacy note */}
          <div className="mt-6 p-4 rounded-xl bg-neutral-50 border border-neutral-200 max-w-2xl mx-auto">
            <div className="flex items-start gap-3">
              <Camera className="h-5 w-5 text-neutral-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-neutral-500 leading-relaxed">
                Face presence detection runs locally in your browser using lightweight AI vision
                and confirms camera framing — it does not store biometric templates or perform
                automated disciplinary decisions.
              </p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <div className="mt-8 flex items-center justify-between">
          <Button
            variant="ghost"
            disabled={startingExam}
            onClick={() => {
              cleanup();
              onBack();
            }}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            size="lg"
            onClick={onContinue}
            disabled={(phase !== 'success' && !modelUnavailable) || startingExam}
            className="group"
          >
            {startingExam ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting Session…
              </>
            ) : (
              <>
                Start Exam
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
