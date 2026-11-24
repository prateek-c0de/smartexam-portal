export type Role = 'student' | 'teacher';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarColor: string;
}

export interface Question {
  id: number;
  text: string;
  options: string[];
  marks: number;
  section: string;
}

export interface Exam {
  id: string;
  title: string;
  courseCode: string;
  courseName: string;
  durationMinutes: number;
  totalQuestions: number;
  totalMarks: number;
  instructions: string[];
  questions: Question[];
}

export type Screen =
  | 'landing'
  | 'student-login'
  | 'teacher-login'
  | 'instructions'
  | 'device-check'
  | 'permissions'
  | 'face-verify'
  | 'exam'
  | 'exam-complete'
  | 'teacher-dashboard';

export type PermissionState = 'pending' | 'granted' | 'denied' | 'unsupported';

export interface DeviceCheck {
  browser: string;
  browserVersion: string;
  os: string;
  screenResolution: string;
  internetSpeed: 'checking' | 'good' | 'poor';
  cookiesEnabled: boolean;
  jsEnabled: boolean;
}

export interface AnswerMap {
  [questionId: number]: number;
}

export interface QuestionStatus {
  [questionId: number]: 'unseen' | 'seen' | 'answered' | 'marked' | 'answered-marked';
}
