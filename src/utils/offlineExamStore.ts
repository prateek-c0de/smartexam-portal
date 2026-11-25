import type { StudentAnswerDraft } from '@/types';

const ACTIVE_EXAM_KEY_PREFIX = 'smartexam.active_exam.';
const SESSION_CACHE_PREFIX = 'smartexam.session_cache.';

export interface CachedSessionState {
  sessionId: string;
  examId: string;
  userId: string;
  dirtyQuestionIds: string[];
  answers: Record<string, StudentAnswerDraft>;
  updatedAt: number;
}

export const offlineExamStore = {
  setActiveExamForUser(userId: string, examId: string | null): void {
    try {
      const key = `${ACTIVE_EXAM_KEY_PREFIX}${userId}`;
      if (examId) {
        sessionStorage.setItem(key, examId);
      } else {
        sessionStorage.removeItem(key);
      }
    } catch {
      // Ignore storage errors
    }
  },

  getActiveExamForUser(userId: string): string | null {
    try {
      return sessionStorage.getItem(`${ACTIVE_EXAM_KEY_PREFIX}${userId}`);
    } catch {
      return null;
    }
  },

  loadSessionCache(sessionId: string, userId: string): CachedSessionState | null {
    try {
      const raw = localStorage.getItem(`${SESSION_CACHE_PREFIX}${sessionId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedSessionState;
      if (parsed.userId !== userId || parsed.sessionId !== sessionId) return null;
      return parsed;
    } catch {
      return null;
    }
  },

  saveSessionCache(state: CachedSessionState): void {
    try {
      localStorage.setItem(`${SESSION_CACHE_PREFIX}${state.sessionId}`, JSON.stringify(state));
    } catch {
      // Ignore quota errors
    }
  },

  markClean(sessionId: string, userId: string, syncedRevisions: Record<string, number>): void {
    const current = this.loadSessionCache(sessionId, userId);
    if (!current) return;
    const remainingDirty = current.dirtyQuestionIds.filter((qid) => {
      const localRev = current.answers[qid]?.revision ?? 0;
      const syncedRev = syncedRevisions[qid] ?? 0;
      return localRev > syncedRev;
    });
    this.saveSessionCache({
      ...current,
      dirtyQuestionIds: remainingDirty,
      updatedAt: Date.now(),
    });
  },

  clearSessionCache(sessionId: string): void {
    try {
      localStorage.removeItem(`${SESSION_CACHE_PREFIX}${sessionId}`);
    } catch {
      // Ignore
    }
  },
};
