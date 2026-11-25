import { useState, useEffect } from 'react';
import Button from '@/components/Button';
import ExamHeader from '@/components/ExamHeader';
import type { DeviceCheck, User } from '@/types';
import { detectDevice, checkInternetSpeed } from '@/utils/permissions';
import {
  Monitor,
  Wifi,
  Globe,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowRight,
  ArrowLeft,
  Cpu,
  ScreenShare,
  Cookie,
} from 'lucide-react';

interface DeviceCheckProps {
  user: User;
  step: number;
  stepLabels: string[];
  onContinue: (device: DeviceCheck) => void;
  onBack: () => void;
  onLogout: () => void;
}

export default function DeviceCheckScreen({
  user,
  step,
  stepLabels,
  onContinue,
  onBack,
  onLogout,
}: DeviceCheckProps) {
  const [device, setDevice] = useState<DeviceCheck | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const base: DeviceCheck = {
      ...detectDevice(),
      internetSpeed: 'checking',
    };
    setDevice(base);
    checkInternetSpeed(controller.signal).then((speed) => {
      if (!controller.signal.aborted) {
        setDevice({ ...base, internetSpeed: speed });
      }
    });
    return () => controller.abort();
  }, []);

  if (!device) return null;

  const isSecureMediaContext = typeof window !== 'undefined' ? window.isSecureContext : true;

  const checks = [
    { icon: Globe, label: 'Browser', value: `${device.browser} ${device.browserVersion}`, ok: true },
    { icon: Cpu, label: 'Operating System', value: device.os, ok: true },
    { icon: Monitor, label: 'Screen Resolution', value: device.screenResolution, ok: true },
    {
      icon: Wifi,
      label: 'Internet Connection',
      value:
        device.internetSpeed === 'checking'
          ? 'Testing…'
          : device.internetSpeed === 'good'
            ? 'Good speed'
            : 'Slow — may affect experience',
      ok: device.internetSpeed !== 'poor',
      pending: device.internetSpeed === 'checking',
    },
    { icon: Cookie, label: 'Cookies', value: device.cookiesEnabled ? 'Enabled' : 'Disabled', ok: device.cookiesEnabled },
    {
      icon: ScreenShare,
      label: 'Media & HTTPS Context',
      value: isSecureMediaContext ? 'Secure context ready' : 'HTTPS required for camera/mic access',
      ok: isSecureMediaContext && device.jsEnabled,
    },
  ];

  const allPassed = checks.every((c) => c.ok && !c.pending);

  return (
    <div className="min-h-screen bg-neutral-50">
      <ExamHeader user={user} step={step} totalSteps={stepLabels.length} stepLabels={stepLabels} onLogout={onLogout} />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="mb-8 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-600 mb-2">
            <Monitor className="h-4 w-4" />
            DEVICE COMPATIBILITY CHECK
          </div>
          <h1 className="text-3xl font-bold text-neutral-900">System Verification</h1>
          <p className="text-neutral-500 mt-2">
            We're checking your device to make sure everything is ready for the exam.
          </p>
        </div>

        <div className="bg-white rounded-2xl card-shadow overflow-hidden animate-slide-up">
          <div className="divide-y divide-neutral-100">
            {checks.map((check) => (
              <div key={check.label} className="flex items-center gap-4 p-5">
                <div className="flex items-center justify-center h-11 w-11 rounded-xl bg-neutral-50 flex-shrink-0">
                  <check.icon className="h-5 w-5 text-neutral-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-neutral-900">{check.label}</p>
                  <p className="text-sm text-neutral-500 truncate">{check.value}</p>
                </div>
                {check.pending ? (
                  <Loader2 className="h-6 w-6 text-brand-500 animate-spin flex-shrink-0" />
                ) : check.ok ? (
                  <div className="flex items-center gap-1.5 text-success-600 flex-shrink-0">
                    <CheckCircle2 className="h-6 w-6" />
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-error-500 flex-shrink-0">
                    <XCircle className="h-6 w-6" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Overall status */}
        <div
          className={`mt-6 p-5 rounded-2xl border animate-fade-in ${
            allPassed
              ? 'bg-success-50 border-success-200'
              : device.internetSpeed === 'checking'
                ? 'bg-brand-50 border-brand-200'
                : 'bg-warning-50 border-warning-200'
          }`}
        >
          <div className="flex items-center gap-3">
            {allPassed ? (
              <CheckCircle2 className="h-6 w-6 text-success-600" />
            ) : device.internetSpeed === 'checking' ? (
              <Loader2 className="h-6 w-6 text-brand-500 animate-spin" />
            ) : (
              <XCircle className="h-6 w-6 text-warning-600" />
            )}
            <p
              className={`text-sm font-semibold ${
                allPassed
                  ? 'text-success-800'
                  : device.internetSpeed === 'checking'
                    ? 'text-brand-800'
                    : 'text-warning-800'
              }`}
            >
              {allPassed
                ? 'All checks passed! Your device is ready for the exam.'
                : device.internetSpeed === 'checking'
                  ? 'Running system checks…'
                  : 'Some checks need attention, but you can still continue.'}
            </p>
          </div>
        </div>

        {/* Navigation */}
        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            size="lg"
            onClick={() => onContinue(device)}
            disabled={device.internetSpeed === 'checking' || !isSecureMediaContext}
            className="group"
          >
            Continue
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
