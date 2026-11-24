import { useState, useEffect, useRef, useCallback } from 'react';
import Button from '@/components/Button';
import QuestionNavigator from '@/components/QuestionNavigator';
import SubmitModal from '@/components/SubmitModal';
import type { AnswerMap, Exam, QuestionStatus, User } from '@/types';
import { formatTime, startCameraStream, stopStream } from '@/utils/permissions';
import {
  Clock,
  Flag,
  ChevronLeft,
  ChevronRight,
  Send,
  Camera,
  AlertCircle,
  Maximize2,
  Eye,
} from 'lucide-react';

interface ExamScreenProps {
  user: User;
  exam: Exam;
  onSubmit: (answers: AnswerMap, timeUsedSeconds: number) => void;
  onLogout: () => void;
}

export default function ExamScreen({ user, exam, onSubmit }: ExamScreenProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [statuses, setStatuses] = useState<QuestionStatus>({});
  const [timeRemaining, setTimeRemaining] = useState(exam.durationMinutes * 60);
  const [showSubmit, setShowSubmit] = useState(false);
  const [showProctorCam, setShowProctorCam] = useState(true);
  const [tabWarnings, setTabWarnings] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const currentQ = exam.questions[currentIndex];

  // Timer
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          handleSubmit();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Start proctoring camera
  useEffect(() => {
    async function initCam() {
      const stream = await startCameraStream();
      streamRef.current = stream;
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
    }
    initCam();
    return () => stopStream(streamRef.current);
  }, []);

  // Tab visibility monitoring
  useEffect(() => {
    function handleVisibility() {
      if (document.hidden) {
        setTabWarnings((w) => w + 1);
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Full-screen request
  const requestFullScreen = useCallback(async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Full-screen may be blocked — not critical
    }
  }, []);

  function selectAnswer(qid: number, optionIndex: number) {
    setAnswers((prev) => ({ ...prev, [qid]: optionIndex }));
    setStatuses((prev) => {
      const wasMarked = prev[qid] === 'marked' || prev[qid] === 'answered-marked';
      return { ...prev, [qid]: wasMarked ? 'answered-marked' : 'answered' };
    });
  }

  function toggleFlag(qid: number) {
    setStatuses((prev) => {
      const isAnswered = answers[qid] !== undefined;
      const isMarked = prev[qid] === 'marked' || prev[qid] === 'answered-marked';
      if (isMarked) {
        return { ...prev, [qid]: isAnswered ? 'answered' : 'seen' };
      }
      return { ...prev, [qid]: isAnswered ? 'answered-marked' : 'marked' };
    });
  }

  function goToQuestion(index: number) {
    if (index < 0 || index >= exam.questions.length) return;
    const qid = exam.questions[index].id;
    if (statuses[qid] === undefined || statuses[qid] === 'unseen') {
      setStatuses((prev) => ({ ...prev, [qid]: 'seen' }));
    }
    setCurrentIndex(index);
  }

  function handleSubmit() {
    const timeUsed = exam.durationMinutes * 60 - timeRemaining;
    stopStream(streamRef.current);
    onSubmit(answers, timeUsed);
  }

  const answeredCount = Object.keys(answers).length;
  const isLowTime = timeRemaining <= 300;
  const isCriticalTime = timeRemaining <= 60;

  const timerColor = isCriticalTime
    ? 'text-error-600 bg-error-50'
    : isLowTime
      ? 'text-warning-600 bg-warning-50'
      : 'text-neutral-700 bg-neutral-100';

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col">
      {/* Exam top bar */}
      <header className="bg-white border-b border-neutral-200 px-4 py-3 flex items-center justify-between gap-3 sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <div className="hidden sm:block">
            <p className="text-sm font-bold text-neutral-900 truncate">{exam.courseCode}</p>
            <p className="text-xs text-neutral-500 truncate">{exam.title}</p>
          </div>
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

      {/* Warning bar */}
      {tabWarnings > 0 && (
        <div className="bg-error-600 text-white px-4 py-2 flex items-center gap-2 text-sm font-semibold animate-fade-in">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          Warning: You switched away from the exam tab {tabWarnings} time{tabWarnings > 1 ? 's' : ''}.
          This has been recorded by the proctoring system.
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-7xl mx-auto w-full gap-0">
        {/* Question area */}
        <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
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
                  style={{ width: `${((currentIndex + 1) / exam.totalQuestions) * 100}%` }}
                />
              </div>
            </div>

            {/* Question card */}
            <div className="bg-white rounded-2xl card-shadow p-6 sm:p-8 animate-slide-in-right" key={currentQ.id}>
              {/* Section + marks */}
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-bold text-brand-600 uppercase tracking-wide">
                  {currentQ.section}
                </span>
                <span className="text-xs font-bold text-neutral-500 px-2.5 py-1 rounded-full bg-neutral-100">
                  {currentQ.marks} marks
                </span>
              </div>

              {/* Question text */}
              <h2 className="text-lg sm:text-xl font-bold text-neutral-900 leading-relaxed mb-6">
                {currentQ.text}
              </h2>

              {/* Options */}
              <div className="space-y-3">
                {currentQ.options.map((option, i) => {
                  const isSelected = answers[currentQ.id] === i;
                  return (
                    <button
                      key={i}
                      onClick={() => selectAnswer(currentQ.id, i)}
                      className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                        isSelected
                          ? 'border-brand-500 bg-brand-50'
                          : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50'
                      }`}
                    >
                      <span
                        className={`flex items-center justify-center h-7 w-7 rounded-full border-2 text-sm font-bold flex-shrink-0 transition-colors ${
                          isSelected
                            ? 'border-brand-600 bg-brand-600 text-white'
                            : 'border-neutral-300 text-neutral-500'
                        }`}
                      >
                        {String.fromCharCode(65 + i)}
                      </span>
                      <span className={`text-sm sm:text-base ${isSelected ? 'text-brand-900 font-semibold' : 'text-neutral-700'}`}>
                        {option}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Flag button */}
              <button
                onClick={() => toggleFlag(currentQ.id)}
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
              </div>
            )}
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
              answers={answers}
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
          answers={answers}
          timeRemaining={timeRemaining}
          onConfirm={handleSubmit}
          onCancel={() => setShowSubmit(false)}
        />
      )}
    </div>
  );
}
