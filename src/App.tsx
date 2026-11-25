import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import type {
  ActiveExamSessionPayload,
  DeviceCheck,
  Exam,
  ExamSubmissionResult,
  Role,
  Screen,
  User,
} from '@/types';
import { supabase, AppError } from '@/lib/supabase';
import { authService } from '@/services/authService';
import { examService } from '@/services/examService';
import { offlineExamStore } from '@/utils/offlineExamStore';
import { stopStream } from '@/utils/permissions';
import type { GrantedMediaHandoff } from '@/screens/Permissions';
import { Loader2 } from 'lucide-react';

import Landing from '@/screens/Landing';
import LoginScreen from '@/screens/LoginScreen';
import ResetPasswordScreen from '@/screens/ResetPasswordScreen';
import StudentPortalScreen from '@/screens/StudentPortalScreen';
import Instructions from '@/screens/Instructions';
import DeviceCheckScreen from '@/screens/DeviceCheck';
import PermissionsScreen from '@/screens/Permissions';
import FaceVerify from '@/screens/FaceVerify';
import ExamComplete from '@/screens/ExamComplete';

const ExamScreen = lazy(() => import('@/screens/ExamScreen'));
const TeacherDashboard = lazy(() => import('@/screens/TeacherDashboard'));

const PRE_EXAM_STEPS = ['Instructions', 'Device', 'Permissions', 'Face ID'];

const SCREEN_TO_PATH: Record<Screen, string> = {
  landing: '/',
  'student-login': '/student/login',
  'teacher-login': '/teacher/login',
  'reset-password': '/reset-password',
  'student-portal': '/student/portal',
  instructions: '/student/instructions',
  'device-check': '/student/device-check',
  permissions: '/student/permissions',
  'face-verify': '/student/face-check',
  exam: '/student/exam',
  'exam-complete': '/student/complete',
  'teacher-dashboard': '/teacher/dashboard',
};

function pathToScreen(pathname: string): Screen {
  const clean = pathname.replace(/\/+$/, '') || '/';
  for (const [scr, p] of Object.entries(SCREEN_TO_PATH)) {
    if (p === clean) return scr as Screen;
  }
  return 'landing';
}

function ScreenFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 text-brand-600 animate-spin" />
        <p className="text-sm font-medium text-neutral-500">Loading secure workspace…</p>
      </div>
    </div>
  );
}

export default function App() {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [screen, setScreenState] = useState<Screen>(() => pathToScreen(window.location.pathname));
  const [user, setUser] = useState<User | null>(null);

  const [selectedExam, setSelectedExam] = useState<Exam | null>(null);
  const [consentGiven, setConsentGiven] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<DeviceCheck | null>(null);
  const [mediaHandoff, setMediaHandoff] = useState<GrantedMediaHandoff | null>(null);
  const [sessionPayload, setSessionPayload] = useState<ActiveExamSessionPayload | null>(null);
  const [startingExam, setStartingExam] = useState(false);
  const [startExamError, setStartExamError] = useState('');
  const [result, setResult] = useState<ExamSubmissionResult | null>(null);

  const navigate = useCallback((next: Screen, replace = false) => {
    setScreenState(next);
    const targetPath = SCREEN_TO_PATH[next] ?? '/';
    if (window.location.pathname !== targetPath) {
      if (replace) {
        window.history.replaceState({}, '', targetPath);
      } else {
        window.history.pushState({}, '', targetPath);
      }
    }
  }, []);

  // Sync browser back/forward navigation with RBAC route protection
  useEffect(() => {
    function onPopState() {
      const requested = pathToScreen(window.location.pathname);
      setScreenState(requested);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const resumeStudentSessionById = useCallback(
    async (examId: string, currentUser: User) => {
      setStartingExam(true);
      setStartExamError('');
      try {
        const payload = await examService.startOrResumeSession({
          examId,
          consentGiven: true,
        });
        offlineExamStore.setActiveExamForUser(currentUser.id, examId);
        setSelectedExam(payload.exam);
        setSessionPayload(payload);
        navigate('exam', true);
      } catch (err) {
        offlineExamStore.setActiveExamForUser(currentUser.id, null);
        const appErr = err instanceof AppError ? err : null;
        setStartExamError(appErr?.message ?? 'Session could not be resumed.');
        navigate('student-portal', true);
      } finally {
        setStartingExam(false);
      }
    },
    [navigate]
  );

  // Restore persistent Supabase Auth session & active exam session on page load/refresh
  useEffect(() => {
    let active = true;

    async function initAuth() {
      try {
        const current = await authService.fetchCurrentUser();
        if (!active) return;

        if (!current) {
          const initialScreen = pathToScreen(window.location.pathname);
          if (
            initialScreen !== 'landing' &&
            initialScreen !== 'student-login' &&
            initialScreen !== 'teacher-login' &&
            initialScreen !== 'reset-password'
          ) {
            navigate(initialScreen === 'teacher-dashboard' ? 'teacher-login' : 'landing', true);
          }
          return;
        }

        setUser(current);
        if (current.role === 'teacher') {
          navigate('teacher-dashboard', true);
          return;
        }

        // Student: check if refreshing mid-exam
        const cachedExamId = offlineExamStore.getActiveExamForUser(current.id);
        if (cachedExamId) {
          await resumeStudentSessionById(cachedExamId, current);
          return;
        }

        // Also check server for any in_progress session if URL is /student/exam
        if (pathToScreen(window.location.pathname) === 'exam') {
          const exams = await examService.listStudentExams().catch(() => []);
          const inProg = exams.find((e) => e.active_session_id);
          if (inProg && active) {
            await resumeStudentSessionById(inProg.id, current);
            return;
          }
        }

        navigate('student-portal', true);
      } finally {
        if (active) setBootstrapping(false);
      }
    }

    void initAuth();

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        navigate('reset-password');
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        setSessionPayload(null);
        setSelectedExam(null);
        setResult(null);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate, resumeStudentSessionById]);

  function handleSelectRole(role: Role) {
    navigate(role === 'student' ? 'student-login' : 'teacher-login');
  }

  function handleLogin(loggedInUser: User) {
    setUser(loggedInUser);
    if (loggedInUser.role === 'teacher') {
      navigate('teacher-dashboard');
    } else {
      navigate('student-portal');
    }
  }

  async function handleLogout() {
    stopStream(mediaHandoff?.screenStream);
    setMediaHandoff(null);
    if (user) {
      offlineExamStore.setActiveExamForUser(user.id, null);
    }
    await authService.signOut();
    setUser(null);
    setSelectedExam(null);
    setSessionPayload(null);
    setResult(null);
    navigate('landing');
  }

  async function handleLaunchExamSession() {
    if (!selectedExam || !user) return;
    setStartingExam(true);
    setStartExamError('');
    try {
      const payload = await examService.startOrResumeSession({
        examId: selectedExam.id,
        deviceInfo: deviceInfo ? { ...deviceInfo } : {},
        consentGiven,
        consentVersion: '1.0',
      });
      offlineExamStore.setActiveExamForUser(user.id, selectedExam.id);
      setSelectedExam(payload.exam);
      setSessionPayload(payload);
      navigate('exam');
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      setStartExamError(appErr?.message ?? 'Unable to start examination session.');
    } finally {
      setStartingExam(false);
    }
  }

  function handleExamSubmitted(subResult: ExamSubmissionResult) {
    setMediaHandoff(null);
    setSessionPayload(null);
    setResult(subResult);
    navigate('exam-complete');
  }

  if (bootstrapping) {
    return <ScreenFallback />;
  }

  if (screen === 'reset-password') {
    return (
      <ResetPasswordScreen
        emailHint={user?.email}
        onComplete={() => navigate(user ? (user.role === 'teacher' ? 'teacher-dashboard' : 'student-portal') : 'landing')}
      />
    );
  }

  if (screen === 'landing') {
    return <Landing onSelectRole={handleSelectRole} />;
  }

  if (screen === 'student-login' || screen === 'teacher-login') {
    return (
      <LoginScreen
        role={screen === 'student-login' ? 'student' : 'teacher'}
        onBack={() => navigate('landing')}
        onLogin={handleLogin}
      />
    );
  }

  // Strict RBAC guard for Teacher Dashboard: students can NEVER render TeacherDashboard
  if (screen === 'teacher-dashboard') {
    if (!user) {
      return (
        <LoginScreen
          role="teacher"
          onBack={() => navigate('landing')}
          onLogin={handleLogin}
        />
      );
    }
    if (user.role !== 'teacher') {
      return (
        <StudentPortalScreen
          user={user}
          onStartExamFlow={(ex) => {
            setSelectedExam(ex);
            setConsentGiven(false);
            navigate('instructions');
          }}
          onResumeActiveExam={(examId) => void resumeStudentSessionById(examId, user)}
          onViewResult={(ex, res) => {
            setSelectedExam(ex);
            setResult(res);
            navigate('exam-complete');
          }}
          onLogout={() => void handleLogout()}
        />
      );
    }
    return (
      <Suspense fallback={<ScreenFallback />}>
        <TeacherDashboard user={user} onLogout={() => void handleLogout()} />
      </Suspense>
    );
  }

  // Require authenticated student for all student portal & exam screens
  if (!user) {
    return <Landing onSelectRole={handleSelectRole} />;
  }
  if (user.role === 'teacher') {
    return (
      <Suspense fallback={<ScreenFallback />}>
        <TeacherDashboard user={user} onLogout={() => void handleLogout()} />
      </Suspense>
    );
  }

  const studentPortalElement = (
    <StudentPortalScreen
      user={user}
      onStartExamFlow={(exam) => {
        setSelectedExam(exam);
        setConsentGiven(false);
        setStartExamError('');
        navigate('instructions');
      }}
      onResumeActiveExam={(examId) => void resumeStudentSessionById(examId, user)}
      onViewResult={(exam, res) => {
        setSelectedExam(exam);
        setResult(res);
        navigate('exam-complete');
      }}
      onLogout={() => void handleLogout()}
    />
  );

  switch (screen) {
    case 'student-portal':
      return studentPortalElement;

    case 'instructions':
      if (!selectedExam) return studentPortalElement;
      return (
        <Instructions
          user={user}
          exam={selectedExam}
          step={0}
          stepLabels={PRE_EXAM_STEPS}
          onContinue={(consented) => {
            setConsentGiven(consented);
            navigate('device-check');
          }}
          onBack={() => navigate('student-portal')}
          onLogout={() => void handleLogout()}
        />
      );

    case 'device-check':
      if (!selectedExam) return studentPortalElement;
      return (
        <DeviceCheckScreen
          user={user}
          step={1}
          stepLabels={PRE_EXAM_STEPS}
          onContinue={(dev) => {
            setDeviceInfo(dev);
            navigate('permissions');
          }}
          onBack={() => navigate('instructions')}
          onLogout={() => void handleLogout()}
        />
      );

    case 'permissions':
      if (!selectedExam) return studentPortalElement;
      return (
        <PermissionsScreen
          user={user}
          step={2}
          stepLabels={PRE_EXAM_STEPS}
          onContinue={(handoff) => {
            setMediaHandoff(handoff);
            navigate('face-verify');
          }}
          onBack={() => navigate('device-check')}
          onLogout={() => void handleLogout()}
        />
      );

    case 'face-verify':
      if (!selectedExam) return studentPortalElement;
      return (
        <FaceVerify
          user={user}
          step={3}
          stepLabels={PRE_EXAM_STEPS}
          startingExam={startingExam}
          startError={startExamError}
          onContinue={() => void handleLaunchExamSession()}
          onBack={() => {
            stopStream(mediaHandoff?.screenStream);
            setMediaHandoff(null);
            navigate('permissions');
          }}
          onLogout={() => void handleLogout()}
        />
      );

    case 'exam':
      if (!sessionPayload) {
        return startingExam ? <ScreenFallback /> : studentPortalElement;
      }
      return (
        <Suspense fallback={<ScreenFallback />}>
          <ExamScreen
            user={user}
            sessionPayload={sessionPayload}
            initialScreenStream={mediaHandoff?.screenStream ?? null}
            onSubmitted={handleExamSubmitted}
            onLogout={() => void handleLogout()}
          />
        </Suspense>
      );

    case 'exam-complete':
      return result && selectedExam ? (
        <ExamComplete
          user={user}
          exam={selectedExam}
          result={result}
          onHome={() => navigate('student-portal')}
        />
      ) : (
        studentPortalElement
      );

    default:
      return <Landing onSelectRole={handleSelectRole} />;
  }
}
