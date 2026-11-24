import { useState, useRef, useEffect, useCallback } from 'react';
import Button from '@/components/Button';
import ExamHeader from '@/components/ExamHeader';
import type { User } from '@/types';
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
  onContinue: () => void;
  onBack: () => void;
  onLogout: () => void;
}

type Phase = 'idle' | 'starting' | 'scanning' | 'verifying' | 'success' | 'failed';

export default function FaceVerify({
  user,
  step,
  stepLabels,
  onContinue,
  onBack,
  onLogout,
}: FaceVerifyProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [scanProgress, setScanProgress] = useState(0);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopStream();
  }, [stopStream]);

  async function startCamera() {
    setPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase('scanning');
      runScan();
    } catch {
      setPhase('failed');
    }
  }

  function runScan() {
    setScanProgress(0);
    const interval = setInterval(() => {
      setScanProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setPhase('verifying');
          // Simulate face verification
          setTimeout(() => {
            stopStream();
            setPhase('success');
          }, 1500);
          return 100;
        }
        return prev + 4;
      });
    }, 80);
  }

  function retry() {
    stopStream();
    setPhase('idle');
    setScanProgress(0);
  }

  useEffect(() => {
    if (phase === 'idle') {
      startCamera();
    }
  }, []);

  return (
    <div className="min-h-screen bg-neutral-50">
      <ExamHeader user={user} step={step} totalSteps={stepLabels.length} stepLabels={stepLabels} onLogout={onLogout} />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-600 mb-2">
            <ScanFace className="h-4 w-4" />
            FACE VERIFICATION
          </div>
          <h1 className="text-3xl font-bold text-neutral-900">Identity Confirmation</h1>
          <p className="text-neutral-500 mt-2">
            Look directly at the camera. We'll verify your identity before the exam begins.
          </p>
        </div>

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
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-3">
                <AlertCircle className="h-10 w-10 text-error-400" />
                <p className="text-sm font-semibold">Camera access failed</p>
                <p className="text-xs text-neutral-400">Please allow camera access and try again.</p>
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
                    style={{ top: `${scanProgress}%`, transition: 'top 0.08s linear' }}
                  />
                )}
                {/* Status text */}
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm">
                  <p className="text-sm font-semibold text-white flex items-center gap-2">
                    {phase === 'scanning' ? (
                      <>
                        <ScanFace className="h-4 w-4 text-brand-400" />
                        Scanning… {scanProgress}%
                      </>
                    ) : (
                      <>
                        <Loader2 className="h-4 w-4 text-brand-400 animate-spin" />
                        Verifying identity…
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
                <p className="text-lg font-bold text-white">Identity Verified!</p>
                <p className="text-sm text-success-100">You're cleared to start the exam.</p>
              </div>
            )}
          </div>

          {/* Progress bar during scan */}
          {(phase === 'scanning' || phase === 'verifying') && (
            <div className="mt-6 max-w-2xl mx-auto">
              <div className="w-full h-2 bg-neutral-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-brand-500 to-brand-600 rounded-full transition-all duration-100"
                  style={{ width: `${phase === 'verifying' ? 100 : scanProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Info row */}
          <div className="mt-6 grid grid-cols-3 gap-3 max-w-2xl mx-auto">
            {[
              { icon: UserCheck, label: 'Face Detected', active: phase !== 'idle' && phase !== 'starting' },
              { icon: ShieldCheck, label: 'Liveness Check', active: phase === 'scanning' || phase === 'verifying' || phase === 'success' },
              { icon: CheckCircle2, label: 'Verified', active: phase === 'success' },
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
            <div className="mt-6 flex justify-center">
              <Button variant="outline" onClick={retry}>
                <RefreshCw className="h-4 w-4" />
                Try Again
              </Button>
            </div>
          )}

          {/* Privacy note */}
          <div className="mt-6 p-4 rounded-xl bg-neutral-50 border border-neutral-200 max-w-2xl mx-auto">
            <div className="flex items-start gap-3">
              <Camera className="h-5 w-5 text-neutral-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-neutral-500 leading-relaxed">
                Your facial data is processed securely and is only used for identity verification
                and proctoring during this exam session. Data is not stored permanently.
              </p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" onClick={() => { stopStream(); onBack(); }}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            size="lg"
            onClick={onContinue}
            disabled={phase !== 'success'}
            className="group"
          >
            Start Exam
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
