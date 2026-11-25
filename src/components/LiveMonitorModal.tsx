import { useEffect, useRef, useState } from 'react';
import Button from '@/components/Button';
import { TeacherWebRTCViewer } from '@/services/webrtcService';
import { examService, type TeacherSessionSummary } from '@/services/examService';
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
} from 'lucide-react';

interface LiveMonitorModalProps {
  session: TeacherSessionSummary;
  onClose: () => void;
}

export default function LiveMonitorModal({ session, onClose }: LiveMonitorModalProps) {
  const camVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<TeacherWebRTCViewer | null>(null);

  const [connState, setConnState] = useState<string>('connecting');
  const [hasCamStream, setHasCamStream] = useState(false);
  const [hasScreenStream, setHasScreenStream] = useState(false);
  const [audioMuted, setAudioMuted] = useState(true);
  const [warningText, setWarningText] = useState('');
  const [sendingWarn, setSendingWarn] = useState(false);
  const [warnSent, setWarnSent] = useState(false);

  useEffect(() => {
    const viewer = new TeacherWebRTCViewer(session.id, {
      onCameraStream: (stream) => {
        setHasCamStream(Boolean(stream));
        if (camVideoRef.current) {
          camVideoRef.current.srcObject = stream;
          if (stream) void camVideoRef.current.play().catch(() => {});
        }
      },
      onScreenStream: (stream) => {
        setHasScreenStream(Boolean(stream));
        if (screenVideoRef.current) {
          screenVideoRef.current.srcObject = stream;
          if (stream) void screenVideoRef.current.play().catch(() => {});
        }
      },
      onStateChange: (state) => setConnState(state),
    });
    viewerRef.current = viewer;
    viewer.start();

    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [session.id]);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-neutral-900/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-white rounded-2xl card-shadow-lg w-full max-w-4xl max-h-[90vh] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-neutral-200">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-10 w-10 rounded-xl bg-brand-50">
              <Radio className="h-5 w-5 text-brand-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-neutral-900">
                Live Stream Monitor — {session.student_name}
              </h2>
              <p className="text-xs text-neutral-500">
                {session.student_email} · WebRTC state:{' '}
                <span className="font-semibold text-neutral-700 capitalize">{connState}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAudioMuted((m) => !m)}
              title="Toggle authorized student microphone monitoring"
            >
              {audioMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4 text-success-600" />}
              {audioMuted ? 'Mic Muted' : 'Listening'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => viewerRef.current?.requestStream()}>
              <RefreshCw className="h-4 w-4" />
              Reconnect
            </Button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Streams */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Webcam */}
            <div className="space-y-2">
              <p className="text-xs font-bold text-neutral-600 uppercase tracking-wide flex items-center gap-1.5">
                <Camera className="h-3.5 w-3.5 text-brand-600" />
                Student Webcam ({session.camera_status})
              </p>
              <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-900 flex items-center justify-center">
                <video
                  ref={camVideoRef}
                  className="absolute inset-0 w-full h-full object-cover"
                  playsInline
                  muted={audioMuted}
                />
                {!hasCamStream && (
                  <div className="relative z-10 text-center text-neutral-400 text-xs px-4">
                    {connState === 'connecting' ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin text-brand-400" />
                        Negotiating encrypted peer stream…
                      </span>
                    ) : (
                      'No live camera track received from student device.'
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Screen Share */}
            <div className="space-y-2">
              <p className="text-xs font-bold text-neutral-600 uppercase tracking-wide flex items-center gap-1.5">
                <ScreenShare className="h-3.5 w-3.5 text-brand-600" />
                Authorized Screen Share ({session.screen_status})
              </p>
              <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-900 flex items-center justify-center">
                <video
                  ref={screenVideoRef}
                  className="absolute inset-0 w-full h-full object-contain"
                  playsInline
                  muted
                />
                {!hasScreenStream && (
                  <div className="relative z-10 text-center text-neutral-400 text-xs px-4">
                    Screen-sharing track is not currently active.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Direct live warning box */}
          <form onSubmit={handleSendWarning} className="flex flex-col sm:flex-row gap-2.5 pt-2">
            <input
              type="text"
              value={warningText}
              onChange={(e) => setWarningText(e.target.value)}
              placeholder="Send a live proctoring notice to this student (e.g. Please keep your face centered in the camera)…"
              className="flex-1 px-4 py-2.5 rounded-xl border border-neutral-300 text-sm text-neutral-900 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <Button type="submit" size="sm" disabled={sendingWarn || !warningText.trim()}>
              <Send className="h-4 w-4" />
              {sendingWarn ? 'Sending…' : warnSent ? 'Sent!' : 'Send Notice'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
