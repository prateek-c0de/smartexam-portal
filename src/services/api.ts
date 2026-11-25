// Production API façade delegating directly to Supabase-backed services.
// All mock fallbacks have been removed; authentication and examination
// mutations are strictly validated server-side.

import { authService } from '@/services/authService';
import { examService } from '@/services/examService';

export const api = {
  studentLogin: (email: string, password: string) =>
    authService.signIn(email, password, 'student'),
  teacherLogin: (email: string, password: string) =>
    authService.signIn(email, password, 'teacher'),
  listStudentExams: () => examService.listStudentExams(),
  joinExamByCode: (code: string) => examService.joinExamByCode(code),
};
