import { supabase, toAppError } from '@/lib/supabase';
import { safeRandomUUID } from '@/utils/permissions';
import type {
  ActiveExamSessionPayload,
  Exam,
  ExamSubmissionResult,
  MediaHealthStatus,
  ProctoringConfig,
  ProctoringEventRecord,
  ProctoringEventType,
  ProctorWarning,
  Question,
  QuestionType,
  StudentAnswerDraft,
  StudentExamSummary,
} from '@/types';

export interface TeacherExamRow {
  id: string;
  title: string;
  course_code: string;
  course_name: string;
  duration_minutes: number;
  total_questions: number;
  total_marks: number;
  status: 'draft' | 'published' | 'ended' | 'archived';
  join_code: string | null;
  starts_at: string | null;
  ends_at: string | null;
  negative_marking_ratio: number;
  pass_percentage: number;
  max_attempts: number;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  access_mode: 'code' | 'assigned';
  show_results_immediately: boolean;
  results_published: boolean;
  results_published_at: string | null;
  proctoring_config: Partial<ProctoringConfig>;
  retention_days: number;
  instructions: string[];
  created_at: string;
}

export interface TeacherSessionSummary {
  id: string;
  exam_id: string;
  exam_title: string;
  course_code: string;
  student_id: string | null;
  student_name: string;
  student_email: string;
  attempt_no: number;
  status: 'not_started' | 'in_progress' | 'submitted' | 'flagged';
  live_state: 'not_started' | 'attending' | 'disconnected' | 'submitted' | 'flagged';
  started_at: string | null;
  deadline_at: string | null;
  submitted_at: string | null;
  last_heartbeat_at: string | null;
  time_used_seconds: number;
  score: number;
  objective_score: number;
  manual_score: number;
  total_marks: number;
  percentage: number;
  correct_answers: number;
  passed: boolean | null;
  grading_status: 'pending' | 'needs_manual' | 'graded';
  proctoring_flags: number;
  integrity_score: number;
  review_priority: 'low' | 'moderate' | 'high';
  camera_status: MediaHealthStatus;
  mic_status: MediaHealthStatus;
  screen_status: MediaHealthStatus;
  network_status: 'online' | 'offline' | 'unknown';
  answered_count: number;
  total_questions: number;
  pending_events: number;
}

export interface TeacherDashboardPayload {
  server_now: string;
  exams: TeacherExamRow[];
  sessions: TeacherSessionSummary[];
  unstarted_roster: Array<{
    exam_id: string;
    exam_title: string;
    course_code: string;
    student_id: string | null;
    student_email: string;
    student_name: string;
    state: 'not_started' | 'absent';
  }>;
  pending_alerts: number;
  question_analytics: Array<{
    question_id: string;
    exam_id: string;
    display_order: number;
    section: string;
    question_type: QuestionType;
    question_text: string;
    marks: number;
    attempts: number;
    correct_count: number;
    accuracy_pct: number;
    avg_marks: number;
  }>;
  section_analytics: Array<{
    section: string;
    questions: number;
    max_marks: number;
    avg_accuracy_pct: number;
  }>;
}

export interface TeacherSessionDetail {
  session: TeacherSessionSummary;
  exam: TeacherExamRow;
  answers: Array<{
    question_id: string;
    display_order: number;
    section: string;
    question_type: QuestionType;
    question_text: string;
    options: string[];
    correct_options: number[] | null;
    model_answer: string;
    marks: number;
    answer_id: string | null;
    selected_options: number[] | null;
    answer_text: string | null;
    is_correct: boolean | null;
    awarded_marks: number | null;
    feedback: string | null;
    graded_at: string | null;
  }>;
  events: ProctoringEventRecord[];
  warnings: ProctorWarning[];
}

export interface QuestionSaveInput {
  id?: string;
  section: string;
  question_type: QuestionType;
  question_text: string;
  options: string[];
  correct_options: number[];
  marks: number;
  explanation?: string;
  model_answer?: string;
  ai_generated?: boolean;
  approved?: boolean;
}

export interface AssignmentSaveInput {
  student_email: string;
  extra_time_minutes?: number;
  accommodations?: {
    exempt_face_absence?: boolean;
    exempt_voice?: boolean;
    allow_assistive_focus?: boolean;
  };
}

function mapSubmissionResult(raw: Record<string, unknown>): ExamSubmissionResult {
  return {
    sessionId: String(raw.session_id ?? ''),
    examId: String(raw.exam_id ?? ''),
    examTitle: String(raw.exam_title ?? ''),
    courseCode: String(raw.course_code ?? ''),
    courseName: String(raw.course_name ?? ''),
    status: String(raw.status ?? 'submitted'),
    submittedAt: (raw.submitted_at as string | null) ?? null,
    timeUsedSeconds: Number(raw.time_used_seconds ?? 0),
    totalQuestions: Number(raw.total_questions ?? 0),
    totalMarks: Number(raw.total_marks ?? 0),
    passPercentage: Number(raw.pass_percentage ?? 40),
    proctoringFlags: Number(raw.proctoring_flags ?? 0),
    gradingStatus: (raw.grading_status as ExamSubmissionResult['gradingStatus']) ?? 'graded',
    resultsPublished: Boolean(raw.results_published),
    resultsVisible: Boolean(raw.results_visible),
    score: raw.score !== null && raw.score !== undefined ? Number(raw.score) : null,
    percentage: raw.percentage !== null && raw.percentage !== undefined ? Number(raw.percentage) : null,
    correctAnswers: raw.correct_answers !== null && raw.correct_answers !== undefined ? Number(raw.correct_answers) : null,
    passed: raw.passed !== null && raw.passed !== undefined ? Boolean(raw.passed) : null,
    breakdown: Array.isArray(raw.breakdown)
      ? (raw.breakdown as ExamSubmissionResult['breakdown'])
      : [],
  };
}

export function mapStudentSummaryToExam(meta: StudentExamSummary | Record<string, unknown>): Exam {
  return {
    id: String(meta.id),
    title: String(meta.title),
    courseCode: String(meta.course_code),
    courseName: String(meta.course_name),
    durationMinutes: Number(meta.duration_minutes),
    totalQuestions: Number(meta.total_questions),
    totalMarks: Number(meta.total_marks),
    negativeMarkingRatio: Number(meta.negative_marking_ratio ?? 0),
    passPercentage: Number(meta.pass_percentage ?? 40),
    maxAttempts: Number(meta.max_attempts ?? 1),
    startsAt: (meta.starts_at as string | null) ?? null,
    endsAt: (meta.ends_at as string | null) ?? null,
    status: (meta.status as Exam['status']) ?? 'published',
    resultsPublished: Boolean(meta.results_published),
    showResultsImmediately: Boolean(meta.show_results_immediately),
    proctoringConfig: meta.proctoring_config as ProctoringConfig | undefined,
    instructions: Array.isArray(meta.instructions) ? (meta.instructions as string[]) : [],
    questions: [],
  };
}

export const examService = {
  // -------------------------------------------------------------------------
  // Student operations
  // -------------------------------------------------------------------------
  async listStudentExams(): Promise<StudentExamSummary[]> {
    const { data, error } = await supabase.rpc('student_list_exams');
    if (error) throw toAppError(error, 'Failed to load available examinations.');
    return (data ?? []) as StudentExamSummary[];
  },

  async joinExamByCode(code: string): Promise<Exam> {
    const { data, error } = await supabase.rpc('student_join_exam_by_code', {
      p_join_code: code,
    });
    if (error) throw toAppError(error, 'Unable to join examination with that code.');
    const raw = (data ?? {}) as { ok?: boolean; code?: string; message?: string; exam?: Record<string, unknown> };
    if (raw.ok === false) {
      throw toAppError(
        { code: 'P0001', hint: raw.code ?? 'INVALID_CODE', message: raw.message ?? 'Invalid examination code.' },
        'Invalid examination code.'
      );
    }
    return mapStudentSummaryToExam((raw.exam ?? raw) as Record<string, unknown>);
  },

  async startOrResumeSession(params: {
    examId: string;
    deviceInfo?: Record<string, unknown>;
    consentGiven: boolean;
    consentVersion?: string;
  }): Promise<ActiveExamSessionPayload> {
    const clientSentAt = Date.now();
    const { data, error } = await supabase.rpc('student_start_or_resume_session', {
      p_exam_id: params.examId,
      p_device_info: params.deviceInfo ?? {},
      p_consent_given: params.consentGiven,
      p_consent_version: params.consentVersion ?? '1.0',
    });
    if (error) throw toAppError(error, 'Could not start or resume the examination session.');

    const raw = data as {
      server_now: string;
      session: Record<string, unknown>;
      exam: Record<string, unknown>;
      questions: Array<Record<string, unknown>>;
      answers: Record<string, Record<string, unknown>>;
      warnings: ProctorWarning[];
    };

    const midpointNow = (clientSentAt + Date.now()) / 2;
    const serverMs = Date.parse(raw.server_now);
    const clockOffsetMs = Number.isFinite(serverMs) ? serverMs - midpointNow : 0;

    const questions: Question[] = (raw.questions ?? []).map((q, idx) => ({
      id: String(q.id),
      displayIndex: Number(q.display_index ?? idx + 1),
      section: String(q.section ?? 'Section A'),
      questionType: (q.question_type as QuestionType) ?? 'mcq',
      text: String(q.question_text ?? ''),
      options: Array.isArray(q.options) ? (q.options as string[]) : [],
      optionOrder: Array.isArray(q.option_order) ? (q.option_order as number[]) : undefined,
      marks: Number(q.marks ?? 1),
    }));

    const exam = mapStudentSummaryToExam(raw.exam);
    exam.questions = questions;
    exam.totalQuestions = questions.length;

    const answers: Record<string, StudentAnswerDraft> = {};
    for (const [qid, a] of Object.entries(raw.answers ?? {})) {
      answers[qid] = {
        selectedOptions: Array.isArray(a.selected_options) ? (a.selected_options as number[]) : [],
        answerText: String(a.answer_text ?? ''),
        markedForReview: Boolean(a.marked_for_review),
        revision: Number(a.revision ?? 1),
      };
    }

    return {
      serverNow: raw.server_now,
      clockOffsetMs,
      session: {
        id: String(raw.session.id),
        examId: String(raw.session.exam_id),
        attemptNo: Number(raw.session.attempt_no ?? 1),
        status: String(raw.session.status),
        startedAt: String(raw.session.started_at),
        deadlineAt: String(raw.session.deadline_at),
        remainingSeconds: Number(raw.session.remaining_seconds ?? 0),
        proctoringFlags: Number(raw.session.proctoring_flags ?? 0),
        accommodations: (raw.session.accommodations as Record<string, unknown>) ?? {},
      },
      exam,
      answers,
      warnings: raw.warnings ?? [],
    };
  },

  async saveAnswers(
    sessionId: string,
    items: Array<{
      question_id: string;
      selected_options: number[];
      answer_text: string;
      marked_for_review: boolean;
      revision: number;
    }>
  ): Promise<{
    saved: number;
    sessionStatus: string;
    serverNow: string;
    deadlineAt: string;
    clockOffsetMs: number;
  }> {
    const sentAt = Date.now();
    const { data, error } = await supabase.rpc('student_save_answers', {
      p_session_id: sessionId,
      p_answers: items,
    });
    if (error) throw toAppError(error, 'Could not sync answers to server.');

    const raw = data as Record<string, unknown>;
    const midpoint = (sentAt + Date.now()) / 2;
    const srvMs = Date.parse(String(raw.server_now ?? ''));
    return {
      saved: Number(raw.saved ?? 0),
      sessionStatus: String(raw.session_status ?? 'in_progress'),
      serverNow: String(raw.server_now ?? ''),
      deadlineAt: String(raw.deadline_at ?? ''),
      clockOffsetMs: Number.isFinite(srvMs) ? srvMs - midpoint : 0,
    };
  },

  async heartbeat(params: {
    sessionId: string;
    camera: MediaHealthStatus;
    mic: MediaHealthStatus;
    screen: MediaHealthStatus;
    network: 'online' | 'offline';
  }): Promise<{
    sessionStatus: string;
    deadlineAt: string;
    clockOffsetMs: number;
    warnings: ProctorWarning[];
  }> {
    const sentAt = Date.now();
    const { data, error } = await supabase.rpc('student_heartbeat', {
      p_session_id: params.sessionId,
      p_camera: params.camera,
      p_mic: params.mic,
      p_screen: params.screen,
      p_network: params.network,
    });
    if (error) throw toAppError(error);
    const raw = data as Record<string, unknown>;
    const midpoint = (sentAt + Date.now()) / 2;
    const srvMs = Date.parse(String(raw.server_now ?? ''));

    return {
      sessionStatus: String(raw.session_status ?? 'in_progress'),
      deadlineAt: String(raw.deadline_at ?? ''),
      clockOffsetMs: Number.isFinite(srvMs) ? srvMs - midpoint : 0,
      warnings: Array.isArray(raw.warnings) ? (raw.warnings as ProctorWarning[]) : [],
    };
  },

  async submitExam(params: {
    sessionId: string;
    idempotencyKey: string;
    finalAnswers?: Array<{
      question_id: string;
      selected_options: number[];
      answer_text: string;
      marked_for_review: boolean;
      revision: number;
    }>;
    submittedVia?: 'student' | 'timeout';
  }): Promise<ExamSubmissionResult> {
    const { data, error } = await supabase.rpc('student_submit_exam', {
      p_session_id: params.sessionId,
      p_idempotency_key: params.idempotencyKey,
      p_final_answers: params.finalAnswers ?? null,
      p_submitted_via: params.submittedVia ?? 'student',
    });
    if (error) throw toAppError(error, 'Failed to submit examination. Your answers remain cached locally; please retry.');
    return mapSubmissionResult(data as Record<string, unknown>);
  },

  async getStudentResult(sessionId: string): Promise<ExamSubmissionResult> {
    const { data, error } = await supabase.rpc('student_get_result', {
      p_session_id: sessionId,
    });
    if (error) throw toAppError(error, 'Could not load examination result.');
    return mapSubmissionResult(data as Record<string, unknown>);
  },

  async listStudentResults(): Promise<ExamSubmissionResult[]> {
    const { data, error } = await supabase.rpc('student_list_results');
    if (error) throw toAppError(error, 'Could not load result history.');
    return Array.isArray(data)
      ? data.map((r) => mapSubmissionResult(r as Record<string, unknown>))
      : [];
  },

  async acknowledgeWarning(warningId: string): Promise<void> {
    const { error } = await supabase.rpc('student_acknowledge_warning', {
      p_warning_id: warningId,
    });
    if (error) throw toAppError(error);
  },

  async recordProctoringEvent(params: {
    sessionId: string;
    eventType: ProctoringEventType;
    description: string;
    confidence?: number | null;
    durationMs?: number | null;
    details?: Record<string, unknown>;
    clientEventId?: string;
    evidencePath?: string | null;
  }): Promise<{
    accepted: boolean;
    deduplicated?: boolean;
    proctoringFlags?: number;
    reviewPriority?: 'low' | 'moderate' | 'high';
  }> {
    const { data, error } = await supabase.rpc('student_record_proctoring_event', {
      p_session_id: params.sessionId,
      p_event_type: params.eventType,
      p_description: params.description,
      p_confidence: params.confidence ?? null,
      p_duration_ms: params.durationMs ?? null,
      p_details: params.details ?? {},
      p_client_event_id: params.clientEventId ?? safeRandomUUID(),
      p_client_ts: new Date().toISOString(),
      p_evidence_path: params.evidencePath ?? null,
    });
    if (error) throw toAppError(error);
    const raw = data as Record<string, unknown>;
    return {
      accepted: Boolean(raw.accepted),
      deduplicated: Boolean(raw.deduplicated),
      proctoringFlags: raw.proctoring_flags !== undefined ? Number(raw.proctoring_flags) : undefined,
      reviewPriority: raw.review_priority as 'low' | 'moderate' | 'high' | undefined,
    };
  },

  async uploadEvidenceSnapshot(examId: string, sessionId: string, jpegBlob: Blob): Promise<string | null> {
    if (jpegBlob.size > 512 * 1024 || !['image/jpeg', 'image/webp'].includes(jpegBlob.type)) {
      return null;
    }
    const ext = jpegBlob.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `${examId}/${sessionId}/${Date.now()}-${safeRandomUUID().slice(0, 8)}.${ext}`;
    const { error } = await supabase.storage.from('proctoring-evidence').upload(path, jpegBlob, {
      contentType: jpegBlob.type,
      upsert: false,
    });
    if (error) return null;
    return path;
  },

  // -------------------------------------------------------------------------
  // Teacher operations
  // -------------------------------------------------------------------------
  async getLiveHallSessions(): Promise<TeacherSessionSummary[]> {
    const { data, error } = await supabase.rpc('teacher_get_live_hall_sessions');
    if (error) throw toAppError(error, 'Unable to load active examination sessions.');
    return Array.isArray(data) ? (data as TeacherSessionSummary[]) : [];
  },

  async getTeacherDashboard(examId?: string | null): Promise<TeacherDashboardPayload> {
    const { data, error } = await supabase.rpc('teacher_get_dashboard', {
      p_exam_id: examId ?? null,
    });
    if (error) throw toAppError(error, 'Unable to load dashboard data.');
    return data as TeacherDashboardPayload;
  },

  async getExamDetail(examId: string): Promise<{
    exam: TeacherExamRow;
    questions: Array<Record<string, unknown>>;
    assignments: Array<Record<string, unknown>>;
  }> {
    const { data, error } = await supabase.rpc('teacher_get_exam_detail', {
      p_exam_id: examId,
    });
    if (error) throw toAppError(error, 'Unable to load examination details.');
    return data as {
      exam: TeacherExamRow;
      questions: Array<Record<string, unknown>>;
      assignments: Array<Record<string, unknown>>;
    };
  },

  async saveExam(params: {
    exam: Record<string, unknown>;
    questions: QuestionSaveInput[];
    assignments: AssignmentSaveInput[];
  }): Promise<TeacherExamRow> {
    const { data, error } = await supabase.rpc('teacher_save_exam', {
      p_exam: params.exam,
      p_questions: params.questions,
      p_assignments: params.assignments,
    });
    if (error) throw toAppError(error, 'Failed to save examination.');
    return data as TeacherExamRow;
  },

  async setExamStatus(examId: string, status: 'draft' | 'published' | 'ended' | 'archived'): Promise<TeacherExamRow> {
    const { data, error } = await supabase.rpc('teacher_set_exam_status', {
      p_exam_id: examId,
      p_status: status,
    });
    if (error) throw toAppError(error, 'Failed to update examination status.');
    return data as TeacherExamRow;
  },

  async regenerateJoinCode(examId: string): Promise<string> {
    const { data, error } = await supabase.rpc('teacher_regenerate_join_code', {
      p_exam_id: examId,
    });
    if (error) throw toAppError(error, 'Failed to regenerate joining code.');
    return String((data as Record<string, unknown>).join_code ?? '');
  },

  async publishResults(examId: string, publish: boolean): Promise<TeacherExamRow> {
    const { data, error } = await supabase.rpc('teacher_publish_results', {
      p_exam_id: examId,
      p_publish: publish,
    });
    if (error) throw toAppError(error, 'Failed to update result publication status.');
    return data as TeacherExamRow;
  },

  async getSessionDetail(sessionId: string): Promise<TeacherSessionDetail> {
    const { data, error } = await supabase.rpc('teacher_get_session_detail', {
      p_session_id: sessionId,
    });
    if (error) throw toAppError(error, 'Unable to load student session details.');
    return data as TeacherSessionDetail;
  },

  async gradeDescriptiveAnswer(answerId: string, awardedMarks: number, feedback = ''): Promise<void> {
    const { error } = await supabase.rpc('teacher_grade_descriptive_answer', {
      p_answer_id: answerId,
      p_awarded_marks: awardedMarks,
      p_feedback: feedback,
    });
    if (error) throw toAppError(error, 'Failed to save manual marks.');
  },

  async reviewProctoringEvent(
    eventId: string,
    reviewStatus: 'pending' | 'acknowledged' | 'confirmed' | 'dismissed',
    remarks = ''
  ): Promise<void> {
    const { error } = await supabase.rpc('teacher_review_proctoring_event', {
      p_event_id: eventId,
      p_review_status: reviewStatus,
      p_remarks: remarks,
    });
    if (error) throw toAppError(error, 'Failed to update event review status.');
  },

  async acknowledgeAllAlerts(examId: string, sessionId?: string): Promise<number> {
    const { data, error } = await supabase.rpc('teacher_acknowledge_all_alerts', {
      p_exam_id: examId,
      p_session_id: sessionId ?? null,
    });
    if (error) throw toAppError(error);
    return Number((data as Record<string, unknown>).acknowledged_count ?? 0);
  },

  async sendWarning(sessionId: string, message: string): Promise<void> {
    const { error } = await supabase.rpc('teacher_send_warning', {
      p_session_id: sessionId,
      p_message: message,
    });
    if (error) throw toAppError(error, 'Failed to send warning to student.');
  },

  async exportExamReport(examId: string): Promise<{
    generated_at: string;
    exam: TeacherExamRow;
    results: Array<Record<string, unknown>>;
    proctoring_events: Array<Record<string, unknown>>;
  }> {
    const { data, error } = await supabase.rpc('teacher_export_exam_report', {
      p_exam_id: examId,
    });
    if (error) throw toAppError(error, 'Failed to generate examination report.');
    return data as {
      generated_at: string;
      exam: TeacherExamRow;
      results: Array<Record<string, unknown>>;
      proctoring_events: Array<Record<string, unknown>>;
    };
  },

  async getSignedEvidenceUrl(evidencePath: string): Promise<string | null> {
    const { data, error } = await supabase.storage
      .from('proctoring-evidence')
      .createSignedUrl(evidencePath, 120); // Short-lived 120-second signed URL
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  },
};
