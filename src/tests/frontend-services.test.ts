// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateStrongPassword,
  checkLoginRateLimit,
  clearLoginFailures,
} from '@/services/authService';
import { redactSecrets, toAppError } from '@/lib/supabase';
import { offlineExamStore } from '@/utils/offlineExamStore';
import {
  buildPdfBytes,
  neutralizeSpreadsheetFormula,
  type TabularSheet,
} from '@/utils/reportExport';
import { aiQuestionService } from '@/services/aiQuestionService';

describe('SmartExam Frontend Security, Offline Caching, AI Fallback & Exports', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('enforces strong password rules and blocks email username reuse', () => {
    expect(validateStrongPassword('short1!', 'alice@uni.edu').valid).toBe(false);
    expect(validateStrongPassword('alllowercase123!', 'bob@uni.edu').valid).toBe(false);
    expect(validateStrongPassword('AliceStrong123!', 'alice@uni.edu').valid).toBe(false);
    expect(validateStrongPassword('Secur3#Pass99', 'alice@uni.edu').valid).toBe(true);
  });

  it('redacts sensitive tokens and maps internal errors without leaking stack details', () => {
    const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactSecrets(`Bearer ${fakeJwt} apikey=mysecret123`)).toBe(
      'Bearer [REDACTED_TOKEN] apikey=[REDACTED]'
    );

    const mapped = toAppError({ code: '42P01', message: 'relation "internal_table" does not exist' });
    expect(mapped.code).toBe('INTERNAL_ERROR');
    expect(mapped.message).not.toContain('internal_table');

    const safeHint = toAppError({ code: 'P0001', hint: 'FORBIDDEN', message: 'Teacher access is required.' });
    expect(safeHint.code).toBe('FORBIDDEN');
    expect(safeHint.message).toBe('Teacher access is required.');

    clearLoginFailures('test@uni.edu');
    expect(() => checkLoginRateLimit('test@uni.edu')).not.toThrow();
  });

  it('caches offline exam answers scoped to userId and retains unsynced higher revisions', () => {
    const sessionId = 'sess-100';
    const userId = 'user-100';

    offlineExamStore.saveSessionCache({
      sessionId,
      examId: 'exam-1',
      userId,
      dirtyQuestionIds: ['q1', 'q2'],
      answers: {
        q1: { selectedOptions: [2], answerText: '', markedForReview: false, revision: 3 },
        q2: { selectedOptions: [0], answerText: '', markedForReview: true, revision: 1 },
      },
      updatedAt: Date.now(),
    });

    // Another user on the same shared browser cannot read user-100's cache
    expect(offlineExamStore.loadSessionCache(sessionId, 'other-user')).toBeNull();

    // Mark q1 synced at rev 2 (while local is already rev 3!) and q2 synced at rev 1
    offlineExamStore.markClean(sessionId, userId, { q1: 2, q2: 1 });
    const afterPartial = offlineExamStore.loadSessionCache(sessionId, userId)!;
    expect(afterPartial.dirtyQuestionIds).toEqual(['q1']);

    offlineExamStore.markClean(sessionId, userId, { q1: 3 });
    const afterFull = offlineExamStore.loadSessionCache(sessionId, userId)!;
    expect(afterFull.dirtyQuestionIds).toEqual([]);
  });

  it('neutralizes CSV/Excel formula injection and produces valid PDF 1.4 documents', () => {
    expect(neutralizeSpreadsheetFormula('=cmd|\' /C calc\'!A0')).toBe('\'=cmd|\' /C calc\'!A0');
    expect(neutralizeSpreadsheetFormula('+SUM(A1:A5)')).toBe('\'+SUM(A1:A5)');
    expect(neutralizeSpreadsheetFormula('@HYPERLINK("http://evil")')).toBe('\'@HYPERLINK("http://evil")');
    expect(neutralizeSpreadsheetFormula('Alice Johnson')).toBe('Alice Johnson');

    const sheet: TabularSheet = {
      name: 'Results',
      headers: ['Student', 'Score'],
      rows: [['Alice Johnson', 95]],
    };
    const pdf = buildPdfBytes('CS 401 Final', 'Generated Report', [sheet]);
    const header = new TextDecoder().decode(pdf.slice(0, 8));
    const tail = new TextDecoder().decode(pdf.slice(-12));
    expect(header).toContain('%PDF-1.4');
    expect(tail).toContain('%%EOF');
  });

  it('fails gracefully when AI question provider is unreachable without crashing exam creation', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));
    await expect(
      aiQuestionService.generateDraftQuestions({
        subject: 'Algorithms',
        topic: 'Dynamic Programming',
        difficulty: 'medium',
        count: 3,
        questionType: 'mcq',
        marks: 5,
        provider: 'ollama_local',
      })
    ).rejects.toThrow(/AI provider is currently unreachable/i);
  });
});
