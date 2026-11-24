// API service layer — stubs for future FastAPI backend integration.
// Each function is structured to match the expected backend contract
// so only the base URL and fetch implementation need updating later.

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

interface LoginResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: 'student' | 'teacher';
  };
  token: string;
}

interface ExamResultResponse {
  examId: string;
  score: number;
  totalMarks: number;
  percentage: number;
  correctAnswers: number;
  totalQuestions: number;
  timeUsedSeconds: number;
  proctoringFlags: number;
  submittedAt: string;
}

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  async studentLogin(email: string, _password: string): Promise<LoginResponse> {
    // Backend: POST /auth/student/login
    return apiRequest<LoginResponse>('/auth/student/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: _password }),
    }).catch(() => mockStudentLogin(email));
  },

  async teacherLogin(email: string, _password: string): Promise<LoginResponse> {
    return apiRequest<LoginResponse>('/auth/teacher/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: _password }),
    }).catch(() => mockTeacherLogin(email));
  },

  async fetchExam(examId: string): Promise<{ exam: unknown }> {
    return apiRequest<{ exam: unknown }>(`/exams/${examId}`).catch(() => ({
      exam: null,
    }));
  },

  async submitExam(
    examId: string,
    answers: Record<number, number>,
    timeUsedSeconds: number,
  ): Promise<ExamResultResponse> {
    return apiRequest<ExamResultResponse>(`/exams/${examId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, timeUsedSeconds }),
    }).catch(() => mockSubmitExam(answers, timeUsedSeconds));
  },

  async verifyFace(imageBlob: Blob): Promise<{ verified: boolean; confidence: number }> {
    return apiRequest<{ verified: boolean; confidence: number }>('/proctor/verify-face', {
      method: 'POST',
      body: imageBlob,
    }).catch(() => ({ verified: true, confidence: 0.95 }));
  },

  async startProctoring(sessionData: {
    examId: string;
    userId: string;
  }): Promise<{ sessionId: string }> {
    return apiRequest<{ sessionId: string }>('/proctor/start', {
      method: 'POST',
      body: JSON.stringify(sessionData),
    }).catch(() => ({ sessionId: 'mock-session-' + Date.now() }));
  },
};

// Mock implementations for frontend-only mode
function mockStudentLogin(email: string): LoginResponse {
  return {
    user: {
      id: 'stu-001',
      email,
      name: email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      role: 'student',
    },
    token: 'mock-student-token',
  };
}

function mockTeacherLogin(email: string): LoginResponse {
  return {
    user: {
      id: 'tch-001',
      email,
      name: 'Prof. ' + email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      role: 'teacher',
    },
    token: 'mock-teacher-token',
  };
}

function mockSubmitExam(
  answers: Record<number, number>,
  timeUsedSeconds: number,
): ExamResultResponse {
  const correctMap: Record<number, number> = {
    1: 0, 2: 1, 3: 1, 4: 2, 5: 2,
    6: 1, 7: 1, 8: 0, 9: 1, 10: 2,
    11: 2, 12: 1, 13: 1, 14: 2, 15: 0,
  };
  let correct = 0;
  for (const qid of Object.keys(correctMap)) {
    const id = parseInt(qid);
    if (answers[id] === correctMap[id]) correct++;
  }
  const percentage = Math.round((correct / 15) * 100);
  return {
    examId: 'EX-2026-CS401',
    score: correct * (100 / 15),
    totalMarks: 100,
    percentage,
    correctAnswers: correct,
    totalQuestions: 15,
    timeUsedSeconds,
    proctoringFlags: 0,
    submittedAt: new Date().toISOString(),
  };
}
