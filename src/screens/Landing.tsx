import Logo from '@/components/Logo';
import Button from '@/components/Button';
import {
  ShieldCheck,
  Camera,
  Clock,
  Monitor,
  FileCheck,
  Users,
  ArrowRight,
  Lock,
  Eye,
  Brain,
} from 'lucide-react';

interface LandingProps {
  onSelectRole: (role: 'student' | 'teacher') => void;
}

export default function Landing({ onSelectRole }: LandingProps) {
  return (
    <div className="min-h-screen university-pattern text-white">
      {/* Header */}
      <header className="border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <Logo variant="light" />
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-neutral-300">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-success-400" />
              AI-Proctored
            </span>
            <span className="flex items-center gap-1.5">
              <Lock className="h-4 w-4 text-brand-300" />
              Secure
            </span>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 grid-pattern opacity-50" />
        <div className="relative max-w-7xl mx-auto px-6 pt-20 pb-24 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass-card text-sm font-medium text-brand-200 mb-8 animate-fade-in">
            <Brain className="h-4 w-4" />
            Trusted by 200+ universities worldwide
          </div>
          <h1 className="text-4xl md:text-6xl font-bold leading-tight max-w-4xl mx-auto animate-slide-up">
            Secure. Intelligent. <span className="text-brand-400">Fair.</span>
            <br />
            The Future of Online Examinations.
          </h1>
          <p className="text-lg text-neutral-300 max-w-2xl mx-auto mt-6 leading-relaxed animate-slide-up">
            SmartExam delivers a complete, AI-proctored examination experience — from face
            verification to real-time monitoring, ensuring academic integrity at every step.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center mt-10 animate-slide-up">
            <Button size="lg" onClick={() => onSelectRole('student')} className="group">
              <Users className="h-5 w-5" />
              Student Portal
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Button>
            <Button
              size="lg"
              onClick={() => onSelectRole('teacher')}
              className="bg-transparent border-2 border-white/30 text-white hover:bg-white/10 hover:border-white/60 active:border-white/80 focus:ring-white/40"
            >
              <FileCheck className="h-5 w-5" />
              Teacher Portal
            </Button>
          </div>
        </div>
      </section>

      {/* Feature cards */}
      <section className="max-w-7xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {features.map((f) => (
            <div
              key={f.title}
              className="glass-card rounded-2xl p-6 hover:bg-white/10 transition-all duration-300 hover:-translate-y-1"
            >
              <div className="flex items-center justify-center h-12 w-12 rounded-xl bg-white/10 mb-4">
                <f.icon className="h-6 w-6 text-brand-300" />
              </div>
              <h3 className="text-lg font-bold text-white mb-2">{f.title}</h3>
              <p className="text-sm text-neutral-300 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Steps */}
      <section className="border-t border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-20">
          <h2 className="text-2xl md:text-3xl font-bold text-center text-white mb-12">
            How It Works
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            {steps.map((s, i) => (
              <div key={s.title} className="relative">
                <div className="flex items-center gap-3 mb-3">
                  <span className="flex items-center justify-center h-8 w-8 rounded-full bg-brand-500 text-white text-sm font-bold">
                    {i + 1}
                  </span>
                  {i < steps.length - 1 && (
                    <div className="hidden md:block flex-1 h-px bg-white/15" />
                  )}
                </div>
                <h3 className="text-base font-bold text-white mb-1">{s.title}</h3>
                <p className="text-sm text-neutral-400 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <Logo variant="light" size="sm" />
          <p className="text-sm text-neutral-400">
            © 2026 SmartExam. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}

const features = [
  {
    icon: Camera,
    title: 'Face Verification',
    desc: 'AI-powered identity confirmation before every exam starts.',
  },
  {
    icon: Eye,
    title: 'Live Proctoring',
    desc: 'Webcam, microphone, and screen monitoring throughout the exam.',
  },
  {
    icon: Clock,
    title: 'Precise Timing',
    desc: 'Auto-submit when time expires, with a clear countdown timer.',
  },
  {
    icon: Monitor,
    title: 'Device Check',
    desc: 'Pre-exam compatibility verification for a smooth experience.',
  },
];

const steps = [
  { title: 'Sign In', desc: 'Students log in with their university credentials.' },
  { title: 'Verify Identity', desc: 'Face recognition confirms who is taking the exam.' },
  { title: 'Take Exam', desc: 'Answer MCQs with real-time proctoring active.' },
  { title: 'Get Results', desc: 'Instant scoring and detailed performance breakdown.' },
];
