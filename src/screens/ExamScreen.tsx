import { useState, useEffect, useRef, useCallback } from 'react';
import Button from '@/components/Button';
import QuestionNavigator from '@/components/QuestionNavigator';
import SubmitModal from '@/components/SubmitModal';
import type {
  ActiveExamSessionPayload,
  AnswerMap,
  ExamSubmissionResult,
  MediaHealthStatus,
  ProctoringEventType,
  ProctorWarning,
  QuestionStatus,
  StudentAnswerDraft,
  User,
} from '@/types';
import { captureFrame, formatTime, isQuestionAnswered, safeRandomUUID, stopStream } from '@/utils/permissions';
import { offlineExamStore } from '@/utils/offlineExamStore';
import { examService } from '@/services/examService';
import { StudentWebRTCResponder } from '@/services/webrtcService';
import { AIProctoringMonitor } from '@/services/aiProctoringService';
import { supabase, AppError } from '@/lib/supabase';
import {
  Clock,
  Flag,
  ChevronLeft,
  ChevronRight,
  Send,
  AlertCircle,
  Maximize2,
  Eye,
  WifiOff,
  Check,
  Mic,
  ScreenShare,
  Camera as CameraIcon,
  MessageSquareWarning,
} from 'lucide-react';

interface ExamScreenProps {
  user: User;
  sessionPayload: ActiveExamSessionPayload;
  initialScreenStream?: MediaStream | null;
  onSubmitted: (result: ExamSubmissionResult) => void;
  onLogout: () => void;
}

function buildInitialDrafts(
  payload: ActiveExamSessionPayload,
  userId: string
): { drafts: Record<string, StudentAnswerDraft>; dirtyIds: string[] } {
  const merged: Record<string, StudentAnswerDraft> = { ...payload.answers };
  const cached = offlineExamStore.loadSessionCache(payload.session.id, userId);
  const dirty = new Set<string>();

  if (cached) {
    for (const [qid, localDraft] of Object.entries(cached.answers)) {
      const serverRev = merged[qid]?.revision ?? 0;
      if (localDraft.revision > serverRev) {
        merged[qid] = localDraft;
        dirty.add(qid);
      }
    }
  }
  return { drafts: merged, dirtyIds: Array.from(dirty) };
}

function draftsToAnswerMap(
  questions: ActiveExamSessionPayload['exam']['questions'],
  drafts: Record<string, StudentAnswerDraft>
): AnswerMap {
  const map: AnswerMap = {};
  for (const q of questions) {
    const d = drafts[q.id];
    if (!d) continue;
    if (q.questionType === 'descriptive') {
      if (d.answerText.trim().length > 0) map[q.id] = d.answerText;
    } else if (q.questionType === 'multi_select') {
      if (d.selectedOptions.length > 0) map[q.id] = d.selectedOptions;
    } else if (d.selectedOptions.length > 0) {
      map[q.id] = d.selectedOptions[0];
    }
  }
  return map;
}

function buildInitialStatuses(
  questions: ActiveExamSessionPayload['exam']['questions'],
  drafts: Record<string, StudentAnswerDraft>
): QuestionStatus {
  const st: QuestionStatus = {};
  questions.forEach((q, idx) => {
    const d = drafts[q.id];
    const hasAns =
      d &&
      (q.questionType === 'descriptive'
        ? d.answerText.trim().length > 0
        : d.selectedOptions.length > 0);
    if (d?.markedForReview) {
      st[q.id] = hasAns ? 'answered-marked' : 'marked';
    } else if (hasAns) {
      st[q.id] = 'answered';
    } else if (idx === 0) {
      st[q.id] = 'seen';
    }
  });
  return st;
}

export default function ExamScreen({
  user,
  sessionPayload,
  initialScreenStream = null,
  onSubmitted,
}: ExamScreenProps) {
  const { exam, session } = sessionPayload;
  const initialState = useRef(buildInitialDrafts(sessionPayload, user.id));

  const [currentIndex, setCurrentIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, StudentAnswerDraft>>(initialState.current.drafts);
  const [statuses, setStatuses] = useState<QuestionStatus>(() =>
    buildInitialStatuses(exam.questions, initialState.current.drafts)
  );
  const [showSubmit, setShowSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [showProctorCam, setShowProctorCam] = useState(true);
  const [tabWarnings, setTabWarnings] = useState(session.proctoringFlags);
  const [latestFlagReason, setLatestFlagReason] = useState('');
  const [aiVisionReady, setAiVisionReady] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [syncState, setSyncState] = useState<'synced' | 'saving' | 'cached'>('synced');
  const [warnings, setWarnings] = useState<ProctorWarning[]>(sessionPayload.warnings);

  const [camHealth, setCamHealth] = useState<MediaHealthStatus>('unknown');
  const [micHealth, setMicHealth] = useState<MediaHealthStatus>('unknown');
  const [screenHealth, setScreenHealth] = useState<MediaHealthStatus>(
    initialScreenStream ? 'ok' : 'off'
  );

  // Server-authoritative timer refs (anti-tampering against local clock edits)
  const deadlineMsRef = useRef<number>(Date.parse(session.deadlineAt));
  const clockOffsetMsRef = useRef<number>(sessionPayload.clockOffsetMs);
  const computeRemaining = useCallback(() => {
    const authoritativeNow = Date.now() + clockOffsetMsRef.current;
    return Math.max(0, Math.floor((deadlineMsRef.current - authoritativeNow) / 1000));
  }, []);
  const [timeRemaining, setTimeRemaining] = useState<number>(() => computeRemaining());

  // Mutable refs to prevent stale closures in timers/listeners
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const dirtySetRef = useRef<Set<string>>(new Set(initialState.current.dirtyIds));
  const saveTimerRef = useRef<number | null>(null);
  const submitKeyRef = useRef<string>(safeRandomUUID());
  const isFinishedRef = useRef(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(initialScreenStream);
  const webrtcRef = useRef<StudentWebRTCResponder | null>(null);
  const aiMonitorRef = useRef<AIProctoringMonitor | null>(null);

  const camHealthRef = useRef(camHealth);
  camHealthRef.current = camHealth;
  const micHealthRef = useRef(micHealth);
  micHealthRef.current = micHealth;
  const screenHealthRef = useRef(screenHealth);
  screenHealthRef.current = screenHealth;
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const stopAllMonitoring = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    aiMonitorRef.current?.dispose();
    aiMonitorRef.current = null;
    webrtcRef.current?.dispose();
    webrtcRef.current = null;
    stopStream(camStreamRef.current);
    stopStream(micStreamRef.current);
    stopStream(screenStreamRef.current);
    camStreamRef.current = null;
    micStreamRef.current = null;
    screenStreamRef.current = null;
  }, []);

  const reportEvent = useCallback(
    async (
      eventType: ProctoringEventType,
      description: string,
      opts?: {
        confidence?: number;
        durationMs?: number;
        details?: Record<string, unknown>;
        captureSnapshot?: boolean;
      }
    ) => {
      if (isFinishedRef.current) return;
      const isSuspicious = ![
        'camera_interrupted',
        'mic_interrupted',
        'network_offline',
        'network_restored',
        'monitoring_error',
        'page_reload',
      ].includes(eventType);

      if (isSuspicious) {
        setLatestFlagReason(description);
        setTabWarnings((prev) => Math.max(1, prev + 1));
      }

      try {
        let evidencePath: string | null = null;
        if (
          opts?.captureSnapshot &&
          exam.proctoringConfig?.capture_evidence &&
          videoRef.current
        ) {
          const blob = await captureFrame(videoRef.current, 360);
          if (blob) {
            evidencePath = await examService.uploadEvidenceSnapshot(exam.id, session.id, blob);
          }
        }

        const res = await examService.recordProctoringEvent({
          sessionId: session.id,
          eventType,
          description,
          confidence: opts?.confidence ?? null,
          durationMs: opts?.durationMs ?? null,
          details: opts?.details,
          evidencePath,
        });
        if (res.proctoringFlags !== undefined) {
          setTabWarnings(res.proctoringFlags);
        }
      } catch {
        // Ignore transient offline error for proctoring telemetry
      }
    },
    [exam.id, exam.proctoringConfig?.capture_evidence, session.id]
  );

  // Flush dirty answers to server
  const flushDirtyAnswers = useCallback(async () => {
    if (isFinishedRef.current) return;
    const ids = Array.from(dirtySetRef.current);
    if (ids.length === 0) return;

    if (!navigator.onLine) {
      setSyncState('cached');
      return;
    }

    setSyncState('saving');
    const currentDrafts = draftsRef.current;
    const payload = ids
      .filter((qid) => currentDrafts[qid])
      .map((qid) => ({
        question_id: qid,
        selected_options: currentDrafts[qid].selectedOptions,
        answer_text: currentDrafts[qid].answerText,
        marked_for_review: currentDrafts[qid].markedForReview,
        revision: currentDrafts[qid].revision,
      }));

    try {
      const res = await examService.saveAnswers(session.id, payload);
      if (res.deadlineAt) {
        deadlineMsRef.current = Date.parse(res.deadlineAt);
        clockOffsetMsRef.current = res.clockOffsetMs;
      }

      const syncedRevs: Record<string, number> = {};
      for (const item of payload) {
        syncedRevs[item.question_id] = item.revision;
        if ((draftsRef.current[item.question_id]?.revision ?? 0) <= item.revision) {
          dirtySetRef.current.delete(item.question_id);
        }
      }
      offlineExamStore.markClean(session.id, user.id, syncedRevs);
      setSyncState(dirtySetRef.current.size === 0 ? 'synced' : 'cached');

      if (res.sessionStatus !== 'in_progress' && !isFinishedRef.current) {
        // Server auto-expired or teacher ended the exam
        const finalResult = await examService.getStudentResult(session.id);
        isFinishedRef.current = true;
        offlineExamStore.clearSessionCache(session.id);
        stopAllMonitoring();
        onSubmitted(finalResult);
      }
    } catch {
      setSyncState('cached');
    }
  }, [onSubmitted, session.id, stopAllMonitoring, user.id]);

  const scheduleDebouncedSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushDirtyAnswers();
    }, 650);
  }, [flushDirtyAnswers]);

  const handleFinalSubmit = useCallback(
    async (via: 'student' | 'timeout') => {
      if (isFinishedRef.current) return;
      setSubmitting(true);
      setSubmitError('');

      const allItems = Object.entries(draftsRef.current).map(([qid, d]) => ({
        question_id: qid,
        selected_options: d.selectedOptions,
        answer_text: d.answerText,
        marked_for_review: d.markedForReview,
        revision: d.revision,
      }));

      try {
        const res = await examService.submitExam({
          sessionId: session.id,
          idempotencyKey: submitKeyRef.current,
          finalAnswers: allItems,
          submittedVia: via,
        });
        isFinishedRef.current = true;
        offlineExamStore.clearSessionCache(session.id);
        offlineExamStore.setActiveExamForUser(user.id, null);
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => {});
        }
        stopAllMonitoring();
        onSubmitted(res);
      } catch (err) {
        const appErr = err instanceof AppError ? err : null;
        setSubmitError(
          appErr?.message ??
            'Submission could not reach the server. Your answers remain safely cached; check your connection and click Submit Now again.'
        );
        setSubmitting(false);
        setShowSubmit(true);
      }
    },
    [onSubmitted, session.id, stopAllMonitoring, user.id]
  );

  const submitExamRef = useRef(handleFinalSubmit);
  submitExamRef.current = handleFinalSubmit;

  // Flush any cached offline answers recovered from before a refresh
  useEffect(() => {
    if (dirtySetRef.current.size > 0) {
      void flushDirtyAnswers();
    }
  }, [flushDirtyAnswers]);

  // Detect unexpected page reload mid-session
  useEffect(() => {
    const markerKey = `smartexam.reload_guard.${session.id}`;
    if (sessionStorage.getItem(markerKey) === '1') {
      void reportEvent('page_reload', 'Examination page was reloaded during active session.');
    }
    sessionStorage.setItem(markerKey, '1');
    return () => {
      if (isFinishedRef.current) {
        sessionStorage.removeItem(markerKey);
      }
    };
  }, [reportEvent, session.id]);

  // Server-controlled countdown timer
  useEffect(() => {
    const timer = window.setInterval(() => {
      const rem = computeRemaining();
      setTimeRemaining(rem);
      if (rem <= 0 && !isFinishedRef.current) {
        window.clearInterval(timer);
        void submitExamRef.current('timeout');
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [computeRemaining]);

  // Initialize camera, microphone, screen stream listeners, WebRTC responder & AI proctoring
  useEffect(() => {
    let cancelled = false;

    async function attachCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamHealth('denied');
        return;
      }
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 480, max: 640 }, height: { ideal: 360, max: 480 }, frameRate: { ideal: 15, max: 20 } },
        });
        if (cancelled) {
          stopStream(cam);
          return;
        }
        stopStream(camStreamRef.current);
        camStreamRef.current = cam;
        setCamHealth('ok');
        if (videoRef.current) {
          videoRef.current.srcObject = cam;
          void videoRef.current.play().catch(() => {});
        }
        const vTrack = cam.getVideoTracks()[0];
        if (vTrack) {
          vTrack.onended = () => {
            if (cancelled || isFinishedRef.current) return;
            setCamHealth('lost');
            void reportEvent('camera_interrupted', 'Webcam video track disconnected.');
            // Attempt automatic recovery after 2.5s
            window.setTimeout(() => {
              if (!cancelled && !isFinishedRef.current) void attachCamera();
            }, 2500);
          };
        }
        webrtcRef.current?.notifyStreamsUpdated();
      } catch {
        if (!cancelled) {
          setCamHealth('denied');
          void reportEvent('camera_interrupted', 'Webcam access denied or unavailable during exam.');
        }
      }
    }

    async function attachMic() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicHealth('denied');
        return;
      }
      try {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (cancelled) {
          stopStream(mic);
          return;
        }
        stopStream(micStreamRef.current);
        micStreamRef.current = mic;
        setMicHealth('ok');
        const aTrack = mic.getAudioTracks()[0];
        if (aTrack) {
          aTrack.onended = () => {
            if (cancelled || isFinishedRef.current) return;
            setMicHealth('lost');
            void reportEvent('mic_interrupted', 'Microphone audio track disconnected.');
            window.setTimeout(() => {
              if (!cancelled && !isFinishedRef.current) void attachMic();
            }, 2500);
          };
        }
        webrtcRef.current?.notifyStreamsUpdated();
      } catch {
        if (!cancelled) {
          setMicHealth('denied');
          void reportEvent('mic_interrupted', 'Microphone access denied or unavailable during exam.');
        }
      }
    }

    // Bind handed-off screen stream if present
    if (screenStreamRef.current) {
      const sTrack = screenStreamRef.current.getVideoTracks()[0];
      if (sTrack && sTrack.readyState === 'live') {
        setScreenHealth('ok');
        sTrack.onended = () => {
          if (cancelled || isFinishedRef.current) return;
          screenStreamRef.current = null;
          setScreenHealth('lost');
          void reportEvent('screen_share_ended', 'Student stopped screen sharing during examination.');
          webrtcRef.current?.notifyStreamsUpdated();
        };
      } else {
        screenStreamRef.current = null;
        setScreenHealth('off');
      }
    }

    const responder = new StudentWebRTCResponder(session.id, {
      getCameraStream: () => camStreamRef.current,
      getMicStream: () => micStreamRef.current,
      getScreenStream: () => screenStreamRef.current,
    });
    webrtcRef.current = responder;
    responder.start();

    const aiMonitor = new AIProctoringMonitor({
      getVideoElement: () => videoRef.current,
      getAudioStream: () => micStreamRef.current,
      config: exam.proctoringConfig,
      onStatusChange: (st) => {
        setAiVisionReady(st.faceModelReady && st.objectModelReady);
      },
      onSignal: (sig) => {
        void reportEvent(sig.eventType, sig.description, {
          confidence: sig.confidence,
          durationMs: sig.durationMs,
          details: sig.details,
          captureSnapshot: sig.captureSnapshot,
        });
      },
    });
    aiMonitorRef.current = aiMonitor;

    void (async () => {
      await Promise.all([attachCamera(), attachMic()]);
      if (!cancelled) {
        await aiMonitor.start();
      }
    })();

    return () => {
      cancelled = true;
      stopAllMonitoring();
    };
  }, [exam.proctoringConfig, reportEvent, session.id, stopAllMonitoring]);

  // Re-bind videoRef whenever showProctorCam toggles back on
  useEffect(() => {
    if (showProctorCam && videoRef.current && camStreamRef.current) {
      videoRef.current.srcObject = camStreamRef.current;
      void videoRef.current.play().catch(() => {});
    }
  }, [showProctorCam]);

  // Browser activity & network monitoring
  useEffect(() => {
    function handleVisibility() {
      if (document.hidden && !isFinishedRef.current) {
        void reportEvent('tab_switch', 'Student switched away from the examination tab.');
      }
    }
    function handleBlur() {
      if (!document.hidden && !isFinishedRef.current) {
        void reportEvent('window_blur', 'Examination browser window lost focus.');
      }
    }
    function handleFullscreenChange() {
      if (!document.fullscreenElement && !isFinishedRef.current) {
        void reportEvent('fullscreen_exit', 'Student exited full-screen examination mode.');
      }
    }
    function handleClipboard(ev: ClipboardEvent) {
      const target = ev.target as HTMLElement | null;
      // Allow normal editing inside descriptive answer textareas while still logging external paste
      if (ev.type === 'paste') {
        void reportEvent('copy_paste', `Paste action detected${target?.tagName === 'TEXTAREA' ? ' in answer editor' : ''}.`);
      } else if (ev.type === 'copy' && target?.tagName !== 'TEXTAREA') {
        void reportEvent('copy_paste', 'Copy action attempted on examination question content.');
      }
    }
    function handleOffline() {
      setIsOnline(false);
      setSyncState('cached');
      void reportEvent('network_offline', 'Internet connection interrupted.');
    }
    function handleOnline() {
      setIsOnline(true);
      void reportEvent('network_restored', 'Internet connection restored.');
      void flushDirtyAnswers();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('copy', handleClipboard);
    document.addEventListener('paste', handleClipboard);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('copy', handleClipboard);
      document.removeEventListener('paste', handleClipboard);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [flushDirtyAnswers, reportEvent]);

  // Periodic server heartbeat + Realtime warning subscription
  useEffect(() => {
    const hbInterval = window.setInterval(async () => {
      if (isFinishedRef.current || !isOnlineRef.current) return;
      try {
        const hb = await examService.heartbeat({
          sessionId: session.id,
          camera: camHealthRef.current,
          mic: micHealthRef.current,
          screen: screenHealthRef.current,
          network: isOnlineRef.current ? 'online' : 'offline',
        });
        if (hb.deadlineAt) {
          deadlineMsRef.current = Date.parse(hb.deadlineAt);
          clockOffsetMsRef.current = hb.clockOffsetMs;
        }
        if (hb.warnings.length > 0) {
          setWarnings(hb.warnings);
        }
        if (hb.sessionStatus !== 'in_progress' && !isFinishedRef.current) {
          const finalResult = await examService.getStudentResult(session.id);
          isFinishedRef.current = true;
          offlineExamStore.clearSessionCache(session.id);
          stopAllMonitoring();
          onSubmitted(finalResult);
        }
      } catch {
        // Ignore transient network errors
      }
    }, 15000);

    const warnChannel = supabase
      .channel(`warnings:${session.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'proctor_warnings',
          filter: `session_id=eq.${session.id}`,
        },
        (payload) => {
          const w = payload.new as ProctorWarning;
          setWarnings((prev) => (prev.some((x) => x.id === w.id) ? prev : [w, ...prev]));
        }
      )
      .subscribe();

    return () => {
      window.clearInterval(hbInterval);
      void supabase.removeChannel(warnChannel);
    };
  }, [onSubmitted, session.id, stopAllMonitoring]);

  const requestFullScreen = useCallback(async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Full-screen may be blocked — non-fatal
    }
  }, []);

  const resumeScreenShare = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 6, max: 10 } },
      });
      stopStream(screenStreamRef.current);
      screenStreamRef.current = stream;
      setScreenHealth('ok');
      const sTrack = stream.getVideoTracks()[0];
      if (sTrack) {
        sTrack.onended = () => {
          if (isFinishedRef.current) return;
          screenStreamRef.current = null;
          setScreenHealth('lost');
          void reportEvent('screen_share_ended', 'Student stopped screen sharing during examination.');
          webrtcRef.current?.notifyStreamsUpdated();
        };
      }
      webrtcRef.current?.notifyStreamsUpdated();
    } catch {
      // Student cancelled picker
    }
  }, [reportEvent]);

  const persistDraftUpdate = useCallback(
    (qid: string, updater: (prev: StudentAnswerDraft) => StudentAnswerDraft, qType?: string) => {
      setDrafts((prev) => {
        const existing = prev[qid] ?? {
          selectedOptions: [],
          answerText: '',
          markedForReview: false,
          revision: 0,
        };
        const updated = updater({ ...existing, revision: existing.revision + 1 });
        const nextDrafts = { ...prev, [qid]: updated };

        dirtySetRef.current.add(qid);
        offlineExamStore.saveSessionCache({
          sessionId: session.id,
          examId: exam.id,
          userId: user.id,
          dirtyQuestionIds: Array.from(dirtySetRef.current),
          answers: nextDrafts,
          updatedAt: Date.now(),
        });

        const hasAns =
          qType === 'descriptive'
            ? updated.answerText.trim().length > 0
            : updated.selectedOptions.length > 0;

        setStatuses((st) => ({
          ...st,
          [qid]: updated.markedForReview
            ? hasAns
              ? 'answered-marked'
              : 'marked'
            : hasAns
              ? 'answered'
              : 'seen',
        }));

        return nextDrafts;
      });
      scheduleDebouncedSave();
    },
    [exam.id, scheduleDebouncedSave, session.id, user.id]
  );

  function selectSingleOption(qid: string, canonicalOptionIdx: number) {
    persistDraftUpdate(qid, (prev) => ({
      ...prev,
      selectedOptions: [canonicalOptionIdx],
    }));
  }

  function toggleMultiOption(qid: string, canonicalOptionIdx: number) {
    persistDraftUpdate(qid, (prev) => {
      const exists = prev.selectedOptions.includes(canonicalOptionIdx);
      const next = exists
        ? prev.selectedOptions.filter((i) => i !== canonicalOptionIdx)
        : [...prev.selectedOptions, canonicalOptionIdx].sort((a, b) => a - b);
      return { ...prev, selectedOptions: next };
    });
  }

  function updateDescriptiveText(qid: string, value: string) {
    persistDraftUpdate(
      qid,
      (prev) => ({ ...prev, answerText: value }),
      'descriptive'
    );
  }

  function toggleFlag(qid: string, qType?: string) {
    persistDraftUpdate(
      qid,
      (prev) => ({ ...prev, markedForReview: !prev.markedForReview }),
      qType
    );
  }

  function goToQuestion(index: number) {
    if (index < 0 || index >= exam.questions.length) return;
    const qid = exam.questions[index].id;
    if (statuses[qid] === undefined || statuses[qid] === 'unseen') {
      setStatuses((prev) => ({ ...prev, [qid]: 'seen' }));
    }
    setCurrentIndex(index);
  }

  async function dismissWarning(id: string) {
    setWarnings((prev) => prev.filter((w) => w.id !== id));
    await examService.acknowledgeWarning(id).catch(() => {});
  }

  const currentQ = exam.questions[currentIndex];
  const answerMap = draftsToAnswerMap(exam.questions, drafts);
  const answeredCount = exam.questions.filter((q) => isQuestionAnswered(answerMap[q.id])).length;
  const isLowTime = timeRemaining <= 300;
  const isCriticalTime = timeRemaining <= 60;

  const timerColor = isCriticalTime
    ? 'text-error-600 bg-error-50'
    : isLowTime
      ? 'text-warning-600 bg-warning-50'
      : 'text-neutral-700 bg-neutral-100';

  const currentDraft = currentQ ? drafts[currentQ.id] : undefined;
  const displayedOptionIndices =
    currentQ?.optionOrder && currentQ.optionOrder.length === currentQ.options.length
      ? currentQ.optionOrder
      : currentQ?.options.map((_, i) => i) ?? [];

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col">
      {/* Exam top bar */}
      <header className="bg-white border-b border-neutral-200 px-4 py-3 flex items-center justify-between gap-3 sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <div className="hidden sm:block min-w-0">
            <p className="text-sm font-bold text-neutral-900 truncate">{exam.courseCode}</p>
            <p className="text-xs text-neutral-500 truncate">{exam.title}</p>
          </div>
          {!isOnline ? (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-warning-50 text-warning-700">
              <WifiOff className="h-3.5 w-3.5" />
              Offline · Cached
            </span>
          ) : syncState === 'saving' ? (
            <span className="hidden md:inline-flex text-xs font-medium text-neutral-400">Saving…</span>
          ) : syncState === 'synced' ? (
            <span className="hidden md:inline-flex items-center gap-1 text-xs font-medium text-success-600">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          ) : null}
        </div>

        {/* Timer */}
        <div className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold tabular-nums ${timerColor} ${isCriticalTime ? 'animate-pulse-ring' : ''}`}>
          <Clock className="h-5 w-5" />
          <span className="text-base sm:text-lg">{formatTime(timeRemaining)}</span>
        </div>

        {/* Submit button */}
        <Button size="sm" variant="success" onClick={() => setShowSubmit(true)}>
          <Send className="h-4 w-4" />
          <span className="hidden sm:inline">Submit</span>
        </Button>
      </header>

      {/* Live instructor warning banner */}
      {warnings.length > 0 && (
        <div className="bg-warning-500 text-white px-4 py-2.5 flex items-center justify-between gap-3 text-sm font-semibold animate-fade-in">
          <div className="flex items-center gap-2">
            <MessageSquareWarning className="h-4 w-4 flex-shrink-0" />
            <span>Instructor Notice: {warnings[0].message}</span>
          </div>
          <button
            onClick={() => void dismissWarning(warnings[0].id)}
            className="px-3 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-xs font-bold transition-colors flex-shrink-0"
          >
            Acknowledge
          </button>
        </div>
      )}

      {/* Proctoring warning bar */}
      {tabWarnings > 0 && (
        <div className="bg-error-600 text-white px-4 py-2 flex items-center gap-2 text-sm font-semibold animate-fade-in">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>
            {latestFlagReason ? `${latestFlagReason} — ` : ''}
            {tabWarnings} proctoring flag{tabWarnings > 1 ? 's' : ''} recorded during this session.
          </span>
        </div>
      )}

      {submitError && (
        <div className="bg-error-50 border-b border-error-200 text-error-700 px-4 py-2.5 text-sm font-medium flex items-center justify-between gap-3">
          <span>{submitError}</span>
          <Button size="sm" variant="danger" onClick={() => void handleFinalSubmit('student')}>
            Retry Submit
          </Button>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-7xl mx-auto w-full gap-0">
        {/* Question area */}
        <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
          {currentQ && (
            <div className="max-w-3xl mx-auto">
              {/* Progress */}
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-neutral-600">
                    Question {currentIndex + 1} of {exam.totalQuestions}
                  </span>
                  <span className="text-sm font-semibold text-neutral-600">
                    {answeredCount} answered
                  </span>
                </div>
                <div className="w-full h-2 bg-neutral-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand-500 rounded-full transition-all duration-300"
                    style={{ width: `${((currentIndex + 1) / Math.max(1, exam.totalQuestions)) * 100}%` }}
                  />
                </div>
              </div>

              {/* Question card */}
              <div className="bg-white rounded-2xl card-shadow p-6 sm:p-8 animate-slide-in-right" key={currentQ.id}>
                {/* Section + marks */}
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs font-bold text-brand-600 uppercase tracking-wide">
                    {currentQ.section}
                    {currentQ.questionType === 'multi_select' ? ' · Select All That Apply' : ''}
                    {currentQ.questionType === 'descriptive' ? ' · Written Response' : ''}
                  </span>
                  <span className="text-xs font-bold text-neutral-500 px-2.5 py-1 rounded-full bg-neutral-100">
                    {currentQ.marks} marks
                  </span>
                </div>

                {/* Question text */}
                <h2 className="text-lg sm:text-xl font-bold text-neutral-900 leading-relaxed mb-6">
                  {currentQ.text}
                </h2>

                {/* Answer Controls */}
                {currentQ.questionType === 'descriptive' ? (
                  <div>
                    <textarea
                      value={currentDraft?.answerText ?? ''}
                      onChange={(e) => updateDescriptiveText(currentQ.id, e.target.value)}
                      rows={7}
                      placeholder="Write your detailed answer here. Your response is saved automatically…"
                      className="w-full p-4 rounded-xl border-2 border-neutral-200 text-neutral-900 placeholder-neutral-400 focus:outline-none focus:border-brand-500 transition-all leading-relaxed"
                    />
                    <p className="mt-2 text-xs text-neutral-400 text-right">
                      {(currentDraft?.answerText ?? '').trim().split(/\s+/).filter(Boolean).length} words
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {displayedOptionIndices.map((canonicalIdx, displayPos) => {
                      const option = currentQ.options[canonicalIdx] ?? '';
                      const isSelected = Boolean(
                        currentDraft?.selectedOptions.includes(canonicalIdx)
                      );
                      return (
                        <button
                          key={canonicalIdx}
                          onClick={() =>
                            currentQ.questionType === 'multi_select'
                              ? toggleMultiOption(currentQ.id, canonicalIdx)
                              : selectSingleOption(currentQ.id, canonicalIdx)
                          }
                          className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                            isSelected
                              ? 'border-brand-500 bg-brand-50'
                              : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50'
                          }`}
                        >
                          <span
                            className={`flex items-center justify-center h-7 w-7 ${
                              currentQ.questionType === 'multi_select' ? 'rounded-lg' : 'rounded-full'
                            } border-2 text-sm font-bold flex-shrink-0 transition-colors ${
                              isSelected
                                ? 'border-brand-600 bg-brand-600 text-white'
                                : 'border-neutral-300 text-neutral-500'
                            }`}
                          >
                            {String.fromCharCode(65 + displayPos)}
                          </span>
                          <span className={`text-sm sm:text-base ${isSelected ? 'text-brand-900 font-semibold' : 'text-neutral-700'}`}>
                            {option}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Flag button */}
                <button
                  onClick={() => toggleFlag(currentQ.id, currentQ.questionType)}
                  className={`mt-5 flex items-center gap-2 text-sm font-semibold transition-colors ${
                    statuses[currentQ.id] === 'marked' || statuses[currentQ.id] === 'answered-marked'
                      ? 'text-warning-600'
                      : 'text-neutral-400 hover:text-warning-500'
                  }`}
                >
                  <Flag className={`h-4 w-4 ${(statuses[currentQ.id] === 'marked' || statuses[currentQ.id] === 'answered-marked') ? 'fill-warning-400' : ''}`} />
                  {(statuses[currentQ.id] === 'marked' || statuses[currentQ.id] === 'answered-marked')
                    ? 'Flagged for review'
                    : 'Flag for review'}
                </button>
              </div>

              {/* Navigation buttons */}
              <div className="mt-6 flex items-center justify-between">
                <Button
                  variant="outline"
                  onClick={() => goToQuestion(currentIndex - 1)}
                  disabled={currentIndex === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                {currentIndex === exam.questions.length - 1 ? (
                  <Button variant="success" onClick={() => setShowSubmit(true)}>
                    <Send className="h-4 w-4" />
                    Submit Exam
                  </Button>
                ) : (
                  <Button onClick={() => goToQuestion(currentIndex + 1)} className="group">
                    Next
                    <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar: navigator + proctoring */}
        <aside className="lg:w-80 xl:w-96 bg-white border-l border-neutral-200 flex flex-col">
          {/* Proctoring camera */}
          <div className="p-4 border-b border-neutral-200">
            <div className="flex items-center justify-between mb-2">
              <span className="flex items-center gap-1.5 text-xs font-bold text-neutral-600">
                <Eye className="h-3.5 w-3.5 text-success-500" />
                PROCTORING ACTIVE
              </span>
              <button
                onClick={() => setShowProctorCam(!showProctorCam)}
                className="text-xs text-neutral-400 hover:text-neutral-600"
              >
                {showProctorCam ? 'Hide' : 'Show'}
              </button>
            </div>
            {showProctorCam && (
              <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-900">
                <video
                  ref={videoRef}
                  className="absolute inset-0 w-full h-full object-cover"
                  playsInline
                  muted
                />
                <div className="absolute top-2 left-2 flex items-center gap-1 px-2 py-1 rounded-full bg-error-600/80">
                  <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                  <span className="text-xs font-bold text-white">LIVE</span>
                </div>
                <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-black/65 backdrop-blur-sm">
                  <span className={`text-[10px] font-bold ${aiVisionReady ? 'text-success-400' : 'text-neutral-300'}`}>
                    {aiVisionReady ? 'AI Vision Active' : 'Initializing AI…'}
                  </span>
                </div>
              </div>
            )}

            {/* Active monitoring device status indicators */}
            <div className="mt-2 grid grid-cols-3 gap-1.5 text-[11px] font-semibold">
              <div
                className={`flex items-center justify-center gap-1 py-1 rounded-lg ${
                  camHealth === 'ok' ? 'bg-success-50 text-success-700' : 'bg-error-50 text-error-700'
                }`}
              >
                <CameraIcon className="h-3 w-3" />
                Cam
              </div>
              <div
                className={`flex items-center justify-center gap-1 py-1 rounded-lg ${
                  micHealth === 'ok' ? 'bg-success-50 text-success-700' : 'bg-error-50 text-error-700'
                }`}
              >
                <Mic className="h-3 w-3" />
                Mic
              </div>
              <button
                type="button"
                onClick={() => {
                  if (screenHealth !== 'ok') void resumeScreenShare();
                }}
                className={`flex items-center justify-center gap-1 py-1 rounded-lg ${
                  screenHealth === 'ok'
                    ? 'bg-success-50 text-success-700'
                    : 'bg-warning-50 text-warning-700 hover:bg-warning-100'
                }`}
                title={screenHealth === 'ok' ? 'Screen share active' : 'Click to share screen'}
              >
                <ScreenShare className="h-3 w-3" />
                {screenHealth === 'ok' ? 'Screen' : 'Share'}
              </button>
            </div>

            <button
              onClick={requestFullScreen}
              className="mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-neutral-50 hover:bg-neutral-100 text-xs font-semibold text-neutral-600 transition-colors"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Enter Full Screen
            </button>
          </div>

          {/* Navigator */}
          <div className="flex-1 overflow-hidden">
            <QuestionNavigator
              questions={exam.questions}
              answers={answerMap}
              statuses={statuses}
              currentIndex={currentIndex}
              onJump={goToQuestion}
            />
          </div>
        </aside>
      </div>

      {/* Submit modal */}
      {showSubmit && (
        <SubmitModal
          exam={exam}
          answers={answerMap}
          timeRemaining={timeRemaining}
          submitting={submitting}
          onConfirm={() => void handleFinalSubmit('student')}
          onCancel={() => setShowSubmit(false)}
        />
      )}
    </div>
  );
}
