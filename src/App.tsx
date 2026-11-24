import { useState } from 'react';
import type { AnswerMap, Role, Screen, User } from '@/types';
import { mockExam } from '@/data/mockExam';
import { api } from '@/services/api';

import Landing from '@/screens/Landing';
import LoginScreen from '@/screens/LoginScreen';
import Instructions from '@/screens/Instructions';
import DeviceCheckScreen from '@/screens/DeviceCheck';
import PermissionsScreen from '@/screens/Permissions';
import FaceVerify from '@/screens/FaceVerify';
import ExamScreen from '@/screens/ExamScreen';
import ExamComplete from '@/screens/ExamComplete';
import TeacherDashboard from '@/screens/TeacherDashboard';

const PRE_EXAM_STEPS = ['Instructions', 'Device', 'Permissions', 'Face ID'];

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [user, setUser] = useState<User | null>(null);
  const [result, setResult] = useState<{
    score: number;
    totalMarks: number;
    percentage: number;
    correctAnswers: number;
    totalQuestions: number;
    timeUsedSeconds: number;
    proctoringFlags: number;
  } | null>(null);

  function handleSelectRole(role: Role) {
    setScreen(role === 'student' ? 'student-login' : 'teacher-login');
  }

  function handleLogin(loggedInUser: User) {
    setUser(loggedInUser);
    if (loggedInUser.role === 'student') {
      setScreen('instructions');
    } else {
      setScreen('teacher-dashboard');
    }
  }

  function handleLogout() {
    setUser(null);
    setResult(null);
    setScreen('landing');
  }

  async function handleExamSubmit(answers: AnswerMap, timeUsedSeconds: number) {
    const res = await api.submitExam(mockExam.id, answers, timeUsedSeconds);
    setResult(res);
    setScreen('exam-complete');
  }

  if (screen === 'landing') {
    return <Landing onSelectRole={handleSelectRole} />;
  }

  if (screen === 'student-login' || screen === 'teacher-login') {
    return (
      <LoginScreen
        role={screen === 'student-login' ? 'student' : 'teacher'}
        onBack={() => setScreen('landing')}
        onLogin={handleLogin}
      />
    );
  }

  if (screen === 'teacher-dashboard') {
    return user ? <TeacherDashboard user={user} onLogout={handleLogout} /> : <Landing onSelectRole={handleSelectRole} />;
  }

  // Student exam flow — require a logged-in user for all following screens
  if (!user) {
    return <Landing onSelectRole={handleSelectRole} />;
  }
  const currentStepIndex = PRE_EXAM_STEPS.findIndex((_, i) => {
    const stepScreenMap: Screen[] = ['instructions', 'device-check', 'permissions', 'face-verify'];
    return stepScreenMap[i] === screen;
  });

  switch (screen) {
    case 'instructions':
      return (
        <Instructions
          user={user}
          exam={mockExam}
          step={0}
          stepLabels={PRE_EXAM_STEPS}
          onContinue={() => setScreen('device-check')}
          onLogout={handleLogout}
        />
      );

    case 'device-check':
      return (
        <DeviceCheckScreen
          user={user}
          step={1}
          stepLabels={PRE_EXAM_STEPS}
          onContinue={() => setScreen('permissions')}
          onBack={() => setScreen('instructions')}
          onLogout={handleLogout}
        />
      );

    case 'permissions':
      return (
        <PermissionsScreen
          user={user}
          step={2}
          stepLabels={PRE_EXAM_STEPS}
          onContinue={() => setScreen('face-verify')}
          onBack={() => setScreen('device-check')}
          onLogout={handleLogout}
        />
      );

    case 'face-verify':
      return (
        <FaceVerify
          user={user}
          step={3}
          stepLabels={PRE_EXAM_STEPS}
          onContinue={() => setScreen('exam')}
          onBack={() => setScreen('permissions')}
          onLogout={handleLogout}
        />
      );

    case 'exam':
      return (
        <ExamScreen
          user={user}
          exam={mockExam}
          onSubmit={handleExamSubmit}
          onLogout={handleLogout}
        />
      );

    case 'exam-complete':
      return result ? (
        <ExamComplete
          user={user}
          exam={mockExam}
          result={result}
          onHome={handleLogout}
        />
      ) : null;

    default:
      return <Landing onSelectRole={handleSelectRole} />;
  }
}
