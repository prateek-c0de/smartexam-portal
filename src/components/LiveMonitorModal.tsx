import { useEffect, useRef, useState } from 'react';
import Button from '@/components/Button';
import { TeacherWebRTCViewer, type LiveTelemetryPayload } from '@/services/webrtcService';
import {
  examService,
  type ProctoringRecordingRow,
  type TeacherSessionSummary,
} from '@/services/examService';
import {
  X,
  Camera,
  ScreenShare,
  Volume2,
  VolumeX,
  RefreshCw,
  Send,
  Loader2,
  Radio,
  Mic,
  MicOff,
  CircleDot,
  Square,
  Download,
  Cloud,
  CheckCircle2,
} from 'lucide-react';

interface LiveMonitorModalProps {
  session: TeacherSessionSummary;
  onClose: () => void;
}

export default function LiveMonitorModal({ session, onClose }: LiveMonitorModalProps) {
  const camVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const audioElRef = useRef<HTMLAudioElement>(null);
  const viewerRef = useRef<TeacherWebRTCViewer | null>(null);
  const activeMediaStreamRef = useRef<MediaStream | null>(null);
  const clipRecorderRef = useRef<MediaRecorder | null>(null);
  const clipChunksRef = useRef<BlobPart[]>([]);

  const [connState, setConnState] = useState<string>('connecting');
  const [hasWebRTCCam, setHasWebRTCCam] = useState(false);
  const [hasWebRTCScreen, setHasWebRTCScreen] = useState(false);
  const [telemetry, setTelemetry] = useState<LiveTelemetryPayload | null>(null);

  // Live student microphone listening (enabled immediately upon teacher's Peek click)
  const [audioMuted, setAudioMuted] = useState(false);
  const [liveMicLevel, setLiveMicLevel] = useState(0);

  // Two-way teacher voice ("Speak to Student")
  const [speakingToStudent, setSpeakingToStudent] = useState(false);

  // On-demand camera + microphone clip recording & permanent Cloud Storage sync
  const [isRecordingClip, setIsRecordingClip] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recordingSecondsRef = useRef(0);
  const [recordedClipUrl, setRecordedClipUrl] = useState<string | null>(null);
  const [uploadingCloud, setUploadingCloud] = useState(false);
  const [cloudSaved, setCloudSaved] = useState(false);
  const [cloudRecordings, setCloudRecordings] = useState<ProctoringRecordingRow[]>([]);

  useEffect(() => {
    examService
      .listSessionRecordings(session.id)
      .then((list) => setCloudRecordings(list))
      .catch(() => {});
  }, [session.id]);

  const [warningText, setWarningText] = useState('');
  const [sendingWarn, setSendingWarn] = useState(false);
  const [warnSent, setWarnSent] = useState(false);

  useEffect(() => {
    let audioMeterTimer: number | null = null;
    let rxAudioCtx: AudioContext | null = null;
    let rxAnalyser: AnalyserNode | null = null;

    function attachIncomingAudioMeter(stream: MediaStream | null) {
      if (audioMeterTimer !== null) {
        window.clearInterval(audioMeterTimer);
        audioMeterTimer = null;
      }
      if (rxAudioCtx) {
        void rxAudioCtx.close().catch(() => {});
        rxAudioCtx = null;
        rxAnalyser = null;
      }
      if (!stream || stream.getAudioTracks().length === 0) return;

      try {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        rxAudioCtx = new Ctx();
        rxAnalyser = rxAudioCtx.createAnalyser();
        rxAnalyser.fftSize = 256;
        const src = rxAudioCtx.createMediaStreamSource(stream);
        src.connect(rxAnalyser);

        audioMeterTimer = window.setInterval(() => {
          if (!rxAnalyser) return;
          const buf = new Uint8Array(rxAnalyser.fftSize);
          rxAnalyser.getByteTimeDomainData(buf);
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / buf.length);
          setLiveMicLevel(Math.min(100, Math.round(rms * 340)));
        }, 120);
      } catch {
        // Fallback uses student telemetry.micLevel
      }
    }

    const viewer = new TeacherWebRTCViewer(session.id, {
      onCameraStream: (stream) => {
        activeMediaStreamRef.current = stream;
        const hasVid = Boolean(stream && stream.getVideoTracks().length > 0);
        setHasWebRTCCam(hasVid);
        if (camVideoRef.current) {
          camVideoRef.current.srcObject = stream;
          if (stream) void camVideoRef.current.play().catch(() => {});
        }
        if (audioElRef.current) {
          audioElRef.current.srcObject = stream;
          if (stream) void audioElRef.current.play().catch(() => {});
        }
        attachIncomingAudioMeter(stream);
      },
      onScreenStream: (stream) => {
        setHasWebRTCScreen(Boolean(stream && stream.getVideoTracks().length > 0));
        if (screenVideoRef.current) {
          screenVideoRef.current.srcObject = stream;
          if (stream) void screenVideoRef.current.play().catch(() => {});
        }
      },
      onTelemetry: (t) => {
        setTelemetry(t);
        setLiveMicLevel((prev) => (rxAnalyser ? prev : t.micLevel));
      },
      onStateChange: (state) => setConnState(state),
    });

    viewerRef.current = viewer;
    viewer.start();

    return () => {
      if (audioMeterTimer !== null) window.clearInterval(audioMeterTimer);
      if (rxAudioCtx) void rxAudioCtx.close().catch(() => {});
      if (clipRecorderRef.current && clipRecorderRef.current.state === 'recording') {
        try {
          clipRecorderRef.current.stop();
        } catch {
          // Ignore
        }
      }
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [session.id]);

  // Revoke recorded blob URL on unmount
  useEffect(() => {
    return () => {
      if (recordedClipUrl) URL.revokeObjectURL(recordedClipUrl);
    };
  }, [recordedClipUrl]);

  // Recording duration counter
  useEffect(() => {
    if (!isRecordingClip) return;
    const id = window.setInterval(() => {
      setRecordingSeconds((s) => {
        const next = s + 1;
        recordingSecondsRef.current = next;
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [isRecordingClip]);

  async function toggleSpeakToStudent() {
    if (!viewerRef.current) return;
    if (speakingToStudent) {
      viewerRef.current.stopSpeakingToStudent();
      setSpeakingToStudent(false);
    } else {
      const ok = await viewerRef.current.startSpeakingToStudent();
      setSpeakingToStudent(ok);
    }
  }

  function toggleClipRecording() {
    if (isRecordingClip) {
      if (clipRecorderRef.current && clipRecorderRef.current.state === 'recording') {
        clipRecorderRef.current.stop();
      }
      setIsRecordingClip(false);
      return;
    }

    const stream = activeMediaStreamRef.current;
    if (!stream || stream.getTracks().length === 0 || typeof MediaRecorder === 'undefined') {
      return;
    }

    if (recordedClipUrl) {
      URL.revokeObjectURL(recordedClipUrl);
      setRecordedClipUrl(null);
    }

    clipChunksRef.current = [];
    setRecordingSeconds(0);
    recordingSecondsRef.current = 0;
    setCloudSaved(false);
    try {
      const recorder = new MediaRecorder(stream);
      clipRecorderRef.current = recorder;
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) clipChunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        if (clipChunksRef.current.length > 0) {
          const blob = new Blob(clipChunksRef.current, {
            type: recorder.mimeType || 'video/webm',
          });
          setRecordedClipUrl(URL.createObjectURL(blob));
          setUploadingCloud(true);
          void examService
            .uploadProctoringRecording({
              examId: session.exam_id,
              sessionId: session.id,
              blob,
              durationSeconds: Math.max(1, recordingSecondsRef.current),
            })
            .then((saved) => {
              if (saved) {
                setCloudSaved(true);
                setCloudRecordings((prev) => [saved, ...prev.filter((r) => r.id !== saved.id)]);
              }
            })
            .finally(() => setUploadingCloud(false));
        }
      };
      recorder.start(500);
      setIsRecordingClip(true);
    } catch {
      setIsRecordingClip(false);
    }
  }

  async function handleSendWarning(e: React.FormEvent) {
    e.preventDefault();
    if (!warningText.trim()) return;
    setSendingWarn(true);
    setWarnSent(false);
    try {
      await examService.sendWarning(session.id, warningText);
      setWarningText('');
      setWarnSent(true);
      window.setTimeout(() => setWarnSent(false), 3000);
    } finally {
      setSendingWarn(false);
    }
  }

  const effectiveMicLevel = Math.max(liveMicLevel, telemetry?.micLevel ?? 0);
  const canRecordWebRTC = Boolean(
    activeMediaStreamRef.current && activeMediaStreamRef.current.getTracks().length > 0
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-neutral-900/60 backdrop-blur-sm" onClick={onClose} />

      {/* Dedicated live student microphone audio sink */}
      <audio ref={audioElRef} autoPlay muted={audioMuted} className="hidden" />

      <div className="relative bg-white rounded-2xl card-shadow-lg w-full max-w-4xl max-h-[92vh] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-neutral-200 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-10 w-10 rounded-xl bg-brand-50">
              <Radio className="h-5 w-5 text-brand-600 animate-pulse" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-neutral-900">
                Live Peek Monitor — {session.student_name}
              </h2>
              <p className="text-xs text-neutral-500">
                {session.student_email} · {session.course_code} · Stream:{' '}
                <span className="font-semibold text-success-600 capitalize">
                  {connState === 'live-telemetry' ? 'Live Active' : connState}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant={audioMuted ? 'outline' : 'success'}
              onClick={() => setAudioMuted((m) => !m)}
              title="Listen to student's live microphone"
            >
              {audioMuted ? (
                <>
                  <VolumeX className="h-4 w-4" />
                  Student Mic Muted
                </>
              ) : (
                <>
                  <Volume2 className="h-4 w-4" />
                  Listening Live
                </>
              )}
            </Button>

            <Button
              size="sm"
              variant={speakingToStudent ? 'danger' : 'outline'}
              onClick={() => void toggleSpeakToStudent()}
              title="Speak live to this student through your microphone"
            >
              {speakingToStudent ? (
                <>
                  <Mic className="h-4 w-4 animate-pulse" />
                  Speaking… (Stop)
                </>
              ) : (
                <>
                  <MicOff className="h-4 w-4" />
                  Speak to Student
                </>
              )}
            </Button>

            {canRecordWebRTC && (
              <Button
                size="sm"
                variant={isRecordingClip ? 'danger' : 'outline'}
                onClick={toggleClipRecording}
                title="Record live camera + microphone clip"
              >
                {isRecordingClip ? (
                  <>
                    <Square className="h-3.5 w-3.5" />
                    Stop Rec ({recordingSeconds}s)
                  </>
                ) : (
                  <>
                    <CircleDot className="h-4 w-4 text-error-600" />
                    Record Clip
                  </>
                )}
              </Button>
            )}

            <Button size="sm" variant="ghost" onClick={() => viewerRef.current?.requestStream()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Streams + Live Microphone Level Bar */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Live Microphone Audio Waveform / Level Indicator */}
          <div className="p-3.5 rounded-xl bg-neutral-50 border border-neutral-200 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2.5">
              <Mic
                className={`h-4 w-4 ${
                  effectiveMicLevel > 8 ? 'text-success-600' : 'text-neutral-400'
                }`}
              />
              <span className="text-xs font-bold text-neutral-700 uppercase tracking-wide">
                Live Student Microphone Audio
              </span>
              <span className="text-xs text-neutral-500">
                ({audioMuted ? 'Muted on your speaker' : 'Live audio active'})
              </span>
            </div>

            <div className="flex items-end gap-1 h-5" aria-label="Live microphone level meter">
              {Array.from({ length: 16 }).map((_, idx) => {
                const threshold = (idx + 1) * 6;
                const active = effectiveMicLevel >= threshold;
                const barColor =
                  idx >= 12 ? 'bg-error-500' : idx >= 8 ? 'bg-warning-500' : 'bg-success-500';
                return (
                  <div
                    key={idx}
                    style={{ height: `${Math.max(25, ((idx + 3) / 18) * 100)}%` }}
                    className={`w-1.5 rounded-full transition-colors duration-100 ${
                      active ? barColor : 'bg-neutral-200'
                    }`}
                  />
                );
              })}
              <span className="ml-2 text-xs font-mono font-bold text-neutral-600 w-9 text-right">
                {effectiveMicLevel}%
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Webcam */}
            <div className="space-y-2">
              <p className="text-xs font-bold text-neutral-600 uppercase tracking-wide flex items-center gap-1.5">
                <Camera className="h-3.5 w-3.5 text-brand-600" />
                Live Student Camera ({telemetry?.hasCam || hasWebRTCCam ? 'Connected' : session.camera_status})
              </p>
              <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-900 flex items-center justify-center">
                <video
                  ref={camVideoRef}
                  className={`absolute inset-0 w-full h-full object-cover ${
                    hasWebRTCCam ? 'opacity-100' : 'opacity-0'
                  }`}
                  autoPlay
                  playsInline
                  muted
                />
                {!hasWebRTCCam && telemetry?.frameDataUrl && (
                  <img
                    src={telemetry.frameDataUrl}
                    alt="Student live camera feed"
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                )}
                <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-error-600/85">
                  <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
                  <span className="text-[11px] font-bold text-white">LIVE CAM</span>
                </div>
                {!hasWebRTCCam && !telemetry?.frameDataUrl && (
                  <div className="relative z-10 text-center text-neutral-400 text-xs px-4">
                    {connState === 'connecting' ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin text-brand-400" />
                        Connecting to student camera & microphone…
                      </span>
                    ) : (
                      'Student camera feed is currently unavailable.'
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Screen Share */}
            <div className="space-y-2">
              <p className="text-xs font-bold text-neutral-600 uppercase tracking-wide flex items-center gap-1.5">
                <ScreenShare className="h-3.5 w-3.5 text-brand-600" />
                Live Student Screen ({telemetry?.hasScreen || hasWebRTCScreen ? 'Sharing' : session.screen_status})
              </p>
              <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-900 flex items-center justify-center">
                <video
                  ref={screenVideoRef}
                  className={`absolute inset-0 w-full h-full object-contain ${
                    hasWebRTCScreen ? 'opacity-100' : 'opacity-0'
                  }`}
                  autoPlay
                  playsInline
                  muted
                />
                {!hasWebRTCScreen && telemetry?.screenDataUrl && (
                  <img
                    src={telemetry.screenDataUrl}
                    alt="Student live screen share"
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                )}
                {!hasWebRTCScreen && !telemetry?.screenDataUrl && (
                  <div className="relative z-10 text-center text-neutral-400 text-xs px-4">
                    Screen sharing is not active on student device.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Recorded Camera + Microphone Clip Playback */}
          {recordedClipUrl && (
            <div className="p-4 rounded-xl bg-brand-50/60 border border-brand-200 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold text-brand-900 uppercase tracking-wide">
                    Captured Camera & Microphone Recording
                  </span>
                  {uploadingCloud ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-100 text-brand-700 text-[11px] font-semibold">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Saving to Cloud Storage…
                    </span>
                  ) : cloudSaved ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success-50 text-success-700 text-[11px] font-semibold">
                      <CheckCircle2 className="h-3 w-3" />
                      Saved to Cloud Storage
                    </span>
                  ) : null}
                </div>
                <a
                  href={recordedClipUrl}
                  download={`proctor-recording-${session.student_name.replace(/\s+/g, '_')}-${Date.now()}.webm`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download Recording (.webm)
                </a>
              </div>
              <video
                src={recordedClipUrl}
                controls
                className="w-full max-h-56 rounded-lg bg-neutral-900"
              />
            </div>
          )}

          {/* Previously Saved Cloud Storage Recordings */}
          {cloudRecordings.length > 0 && (
            <div className="p-4 rounded-xl bg-neutral-50 border border-neutral-200 space-y-2.5">
              <div className="flex items-center gap-2">
                <Cloud className="h-4 w-4 text-brand-600" />
                <span className="text-xs font-bold text-neutral-700 uppercase tracking-wide">
                  Cloud Storage Recordings ({cloudRecordings.length})
                </span>
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {cloudRecordings.map((rec) => (
                  <div
                    key={rec.id}
                    className="p-2.5 rounded-lg bg-white border border-neutral-200 flex items-center justify-between gap-3 flex-wrap text-xs"
                  >
                    <div className="text-neutral-700">
                      <span className="font-semibold">
                        {new Date(rec.created_at).toLocaleTimeString()}
                      </span>{' '}
                      · {rec.duration_seconds}s · {Math.max(1, Math.round(rec.size_bytes / 1024))} KB
                    </div>
                    {rec.signedUrl && (
                      <a
                        href={rec.signedUrl}
                        target="_blank"
                        rel="noreferrer"
                        download
                        className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:text-brand-700"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Open / Download from Cloud
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Direct live warning box */}
          <form onSubmit={handleSendWarning} className="flex flex-col sm:flex-row gap-2.5 pt-1">
            <input
              type="text"
              value={warningText}
              onChange={(e) => setWarningText(e.target.value)}
              placeholder="Send an instant written warning banner to this student's exam screen…"
              className="flex-1 px-4 py-2.5 rounded-xl border border-neutral-300 text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <Button type="submit" size="sm" disabled={sendingWarn || !warningText.trim()}>
              <Send className="h-4 w-4" />
              {sendingWarn ? 'Sending…' : warnSent ? 'Sent!' : 'Send Warning'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
