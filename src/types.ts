export type Role = 'student' | 'teacher';
export type AccountRole = 'student' | 'teacher' | 'admin';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  accountRole?: AccountRole;
  teacherRequestStatus?: 'pending' | 'approved' | 'rejected' | null;
  avatarColor: string;
}

export type QuestionType = 'mcq' | 'multi_select' | 'true_false' | 'descriptive';

export interface Question {
  id: string;
  displayIndex?: number;
  text: string;
  questionType?: QuestionType;
  options: string[];
  optionOrder?: number[];
  marks: number;
  section: string;
}

export interface ProctoringConfig {
  require_camera: boolean;
  require_microphone: boolean;
  require_screen: boolean;
  capture_evidence: boolean;
  face_detection: boolean;
  object_detection: boolean;
  audio_monitoring: boolean;
  weights: Record<string, number>;
  thresholds: { moderate: number; high: number };
  min_confidence: Record<string, number>;
  cooldown_seconds: Record<string, number>;
  sustain_seconds: Record<string, number>;
}

export interface Exam {
  id: string;
  title: string;
  courseCode: string;
  courseName: string;
  durationMinutes: number;
  totalQuestions: number;
  totalMarks: number;
  negativeMarkingRatio?: number;
  passPercentage?: number;
  maxAttempts?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  status?: 'draft' | 'published' | 'ended' | 'archived';
  joinCode?: string | null;
  accessMode?: 'code' | 'assigned';
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  showResultsImmediately?: boolean;
  resultsPublished?: boolean;
  proctoringConfig?: ProctoringConfig;
  retentionDays?: number;
  instructions: string[];
  questions: Question[];
}

export interface StudentExamSummary {
  id: string;
  title: string;
  course_code: string;
  course_name: string;
  duration_minutes: number;
  total_questions: number;
  total_marks: number;
  negative_marking_ratio: number;
  pass_percentage: number;
  max_attempts: number;
  starts_at: string | null;
  ends_at: string | null;
  status: 'published' | 'ended';
  instructions: string[];
  results_published: boolean;
  show_results_immediately: boolean;
  proctoring_config: ProctoringConfig;
  attempts_used: number;
  active_session_id: string | null;
  latest_session: {
    id: string;
    status: string;
    submitted_at: string | null;
    time_used_seconds: number;
    results_visible: boolean;
    score: number | null;
    total_marks: number;
    percentage: number | null;
    passed: boolean | null;
    grading_status: 'pending' | 'needs_manual' | 'graded';
  } | null;
}

export type Screen =
  | 'landing'
  | 'student-login'
  | 'teacher-login'
  | 'student-portal'
  | 'instructions'
  | 'device-check'
  | 'permissions'
  | 'face-verify'
  | 'exam'
  | 'exam-complete'
  | 'teacher-dashboard'
  | 'reset-password';

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

export interface StudentAnswerDraft {
  selectedOptions: number[];
  answerText: string;
  markedForReview: boolean;
  revision: number;
}

// Preserved map shape for QuestionNavigator & SubmitModal compatibility (keyed by question ID)
export interface AnswerMap {
  [questionId: string]: number | number[] | string;
}

export interface QuestionStatus {
  [questionId: string]: 'unseen' | 'seen' | 'answered' | 'marked' | 'answered-marked';
}

export type MediaHealthStatus = 'ok' | 'lost' | 'denied' | 'off' | 'unknown';

export type ProctoringEventType =
  | 'tab_switch'
  | 'window_blur'
  | 'fullscreen_exit'
  | 'face_not_detected'
  | 'multiple_faces'
  | 'camera_obstructed'
  | 'phone_detected'
  | 'prohibited_object'
  | 'voice_activity'
  | 'audio_anomaly'
  | 'copy_paste'
  | 'screen_share_ended'
  | 'page_reload'
  | 'camera_interrupted'
  | 'mic_interrupted'
  | 'network_offline'
  | 'network_restored'
  | 'monitoring_error';

export interface ProctoringEventRecord {
  id: string;
  session_id: string;
  exam_id: string;
  student_id: string | null;
  event_type: ProctoringEventType | string;
  category: 'suspicious' | 'technical' | 'info';
  description: string | null;
  severity: 'info' | 'warning' | 'critical';
  confidence: number | null;
  duration_ms: number | null;
  details: Record<string, unknown>;
  weight: number;
  occurrences: number;
  created_at: string;
  last_seen_at: string;
  review_status: 'pending' | 'acknowledged' | 'confirmed' | 'dismissed';
  reviewed_at: string | null;
  teacher_remarks: string | null;
  evidence_path: string | null;
}

export interface ProctorWarning {
  id: string;
  session_id: string;
  exam_id: string;
  student_id: string;
  message: string;
  created_at: string;
  acknowledged_at: string | null;
}

export interface ActiveExamSessionPayload {
  serverNow: string;
  clockOffsetMs: number;
  session: {
    id: string;
    examId: string;
    attemptNo: number;
    status: string;
    startedAt: string;
    deadlineAt: string;
    remainingSeconds: number;
    proctoringFlags: number;
    accommodations: Record<string, unknown>;
  };
  exam: Exam;
  answers: Record<string, StudentAnswerDraft>;
  warnings: ProctorWarning[];
}

export interface ExamSubmissionResult {
  sessionId: string;
  examId: string;
  examTitle: string;
  courseCode: string;
  courseName: string;
  status: string;
  submittedAt: string | null;
  timeUsedSeconds: number;
  totalQuestions: number;
  totalMarks: number;
  passPercentage: number;
  proctoringFlags: number;
  gradingStatus: 'pending' | 'needs_manual' | 'graded';
  resultsPublished: boolean;
  resultsVisible: boolean;
  score: number | null;
  percentage: number | null;
  correctAnswers: number | null;
  passed: boolean | null;
  breakdown: Array<{
    question_id: string;
    display_order: number;
    section: string;
    question_type: QuestionType;
    question_text: string;
    options: string[];
    marks: number;
    correct_options: number[] | null;
    explanation: string;
    selected_options: number[] | null;
    answer_text: string | null;
    is_correct: boolean | null;
    awarded_marks: number | null;
    feedback: string | null;
  }>;
}
