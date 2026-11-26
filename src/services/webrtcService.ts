import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { safeRandomUUID } from '@/utils/permissions';

export function buildIceServers(): RTCIceServer[] {
  const stunRaw = String(
    import.meta.env.VITE_STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
  );
  const stunUrls = stunRaw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const servers: RTCIceServer[] = [];
  if (stunUrls.length > 0) {
    servers.push({ urls: stunUrls });
  }

  const turnRaw = String(import.meta.env.VITE_TURN_URLS ?? '').trim();
  if (turnRaw) {
    const turnUrls = turnRaw
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    const username = String(import.meta.env.VITE_TURN_USERNAME ?? '').trim();
    const credential = String(import.meta.env.VITE_TURN_CREDENTIAL ?? '').trim();
    if (turnUrls.length > 0) {
      servers.push(username ? { urls: turnUrls, username, credential } : { urls: turnUrls });
    }
  }

  return servers;
}

export interface LiveTelemetryPayload {
  frameDataUrl: string | null;
  screenDataUrl?: string | null;
  micLevel: number; // 0..100
  hasCam: boolean;
  hasMic: boolean;
  hasScreen: boolean;
}

interface SignalEnvelope {
  type:
    | 'watch-request'
    | 'watch-stop'
    | 'offer'
    | 'answer'
    | 'ice'
    | 'telemetry'
    | 'teacher-voice'
    | 'teacher-speaking';
  viewerId: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  cameraStreamId?: string | null;
  screenStreamId?: string | null;
  telemetry?: LiveTelemetryPayload;
  audioDataUrl?: string;
  speaking?: boolean;
}

async function applyAdaptiveEncoding(
  pc: RTCPeerConnection,
  screenTrackId?: string | null
): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const isScreen = sender.track.id === screenTrackId;
      params.encodings[0].maxBitrate = isScreen ? 380_000 : 260_000;
      params.encodings[0].maxFramerate = isScreen ? 8 : 15;
      await sender.setParameters(params);
    } catch {
      // Non-fatal if browser ignores sender encoding updates
    }
  }
}

export interface StudentMediaProvider {
  getCameraStream: () => MediaStream | null;
  getMicStream: () => MediaStream | null;
  getScreenStream: () => MediaStream | null;
  onTeacherVoiceState?: (speaking: boolean) => void;
  onTeacherAudioStream?: (stream: MediaStream | null) => void;
}

export class StudentWebRTCResponder {
  private readonly sessionId: string;
  private readonly provider: StudentMediaProvider;
  private channel: RealtimeChannel | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private activeViewers = new Set<string>();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private telemetryTimer: number | null = null;
  private snapCanvas: HTMLCanvasElement;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private audioSource: MediaStreamAudioSourceNode | null = null;
  private boundMicId: string | null = null;
  private disposed = false;

  constructor(sessionId: string, provider: StudentMediaProvider) {
    this.sessionId = sessionId;
    this.provider = provider;
    this.snapCanvas = document.createElement('canvas');
    this.snapCanvas.width = 320;
    this.snapCanvas.height = 240;
  }

  start(): void {
    if (this.disposed || this.channel) return;

    const topic = `peek:${this.sessionId}`;
    this.channel = supabase.channel(topic, {
      config: { broadcast: { self: false } },
    });

    this.channel
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        void this.handleSignal(payload as SignalEnvelope);
      })
      .subscribe();
  }

  private ensureTelemetryLoop(): void {
    if (this.telemetryTimer !== null || this.disposed) return;

    const camVideo = document.createElement('video');
    camVideo.muted = true;
    camVideo.playsInline = true;

    const scrVideo = document.createElement('video');
    scrVideo.muted = true;
    scrVideo.playsInline = true;

    this.telemetryTimer = window.setInterval(() => {
      if (this.disposed || this.activeViewers.size === 0 || !this.channel) {
        if (this.activeViewers.size === 0 && this.telemetryTimer !== null) {
          window.clearInterval(this.telemetryTimer);
          this.telemetryTimer = null;
        }
        return;
      }

      const camStream = this.provider.getCameraStream();
      const micStream = this.provider.getMicStream();
      const scrStream = this.provider.getScreenStream();

      let frameDataUrl: string | null = null;
      if (camStream && camStream.getVideoTracks().some((t) => t.readyState === 'live')) {
        if (camVideo.srcObject !== camStream) {
          camVideo.srcObject = camStream;
          void camVideo.play().catch(() => {});
        }
        if (camVideo.readyState >= 2 && camVideo.videoWidth > 0) {
          const ctx = this.snapCanvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(camVideo, 0, 0, 320, 240);
            frameDataUrl = this.snapCanvas.toDataURL('image/jpeg', 0.55);
          }
        }
      }

      let screenDataUrl: string | null = null;
      if (scrStream && scrStream.getVideoTracks().some((t) => t.readyState === 'live')) {
        if (scrVideo.srcObject !== scrStream) {
          scrVideo.srcObject = scrStream;
          void scrVideo.play().catch(() => {});
        }
        if (scrVideo.readyState >= 2 && scrVideo.videoWidth > 0) {
          const ctx = this.snapCanvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(scrVideo, 0, 0, 320, 240);
            screenDataUrl = this.snapCanvas.toDataURL('image/jpeg', 0.5);
          }
        }
      }

      const micLevel = this.readMicLevel(micStream);
      const telemetry: LiveTelemetryPayload = {
        frameDataUrl,
        screenDataUrl,
        micLevel,
        hasCam: Boolean(camStream?.getVideoTracks().some((t) => t.readyState === 'live')),
        hasMic: Boolean(micStream?.getAudioTracks().some((t) => t.readyState === 'live')),
        hasScreen: Boolean(scrStream?.getVideoTracks().some((t) => t.readyState === 'live')),
      };

      for (const viewerId of this.activeViewers) {
        void this.channel.send({
          type: 'broadcast',
          event: 'signal',
          payload: {
            type: 'telemetry',
            viewerId,
            telemetry,
          } satisfies SignalEnvelope,
        });
      }
    }, 750);
  }

  private readMicLevel(micStream: MediaStream | null): number {
    if (!micStream || micStream.getAudioTracks().length === 0) return 0;
    try {
      if (this.boundMicId !== micStream.id || !this.analyser) {
        this.audioSource?.disconnect();
        if (!this.audioCtx) {
          const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          if (!Ctx) return 0;
          this.audioCtx = new Ctx();
        }
        if (this.audioCtx.state === 'suspended') {
          void this.audioCtx.resume().catch(() => {});
        }
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.audioSource = this.audioCtx.createMediaStreamSource(micStream);
        this.audioSource.connect(this.analyser);
        this.boundMicId = micStream.id;
      }
      const data = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(data);
      let sumSq = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / data.length);
      return Math.min(100, Math.round(rms * 320));
    } catch {
      return 0;
    }
  }

  private async handleSignal(msg: SignalEnvelope): Promise<void> {
    if (this.disposed || !msg?.viewerId) return;

    if (msg.type === 'watch-request') {
      this.activeViewers.add(msg.viewerId);
      this.ensureTelemetryLoop();
      if (typeof RTCPeerConnection !== 'undefined') {
        await this.createOfferForViewer(msg.viewerId);
      }
    } else if (msg.type === 'answer' && msg.sdp) {
      const pc = this.peers.get(msg.viewerId);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const queued = this.pendingIce.get(msg.viewerId) ?? [];
        this.pendingIce.delete(msg.viewerId);
        for (const cand of queued) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
      } catch {
        // Ignore stale SDP
      }
    } else if (msg.type === 'ice' && msg.candidate) {
      const pc = this.peers.get(msg.viewerId);
      if (!pc) return;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      } else {
        const list = this.pendingIce.get(msg.viewerId) ?? [];
        list.push(msg.candidate);
        this.pendingIce.set(msg.viewerId, list);
      }
    } else if (msg.type === 'teacher-speaking') {
      this.provider.onTeacherVoiceState?.(Boolean(msg.speaking));
    } else if (msg.type === 'teacher-voice' && msg.audioDataUrl) {
      try {
        const audio = new Audio(msg.audioDataUrl);
        void audio.play().catch(() => {});
      } catch {
        // Ignore playback block
      }
    } else if (msg.type === 'watch-stop') {
      this.activeViewers.delete(msg.viewerId);
      this.provider.onTeacherVoiceState?.(false);
      this.closePeer(msg.viewerId);
    }
  }

  private async createOfferForViewer(viewerId: string): Promise<void> {
    this.closePeer(viewerId);
    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    this.peers.set(viewerId, pc);

    // Receive-capable audio transceiver so teacher push-to-talk WebRTC audio can also play directly
    pc.ontrack = (ev) => {
      if (ev.track.kind === 'audio' && ev.streams[0]) {
        this.provider.onTeacherAudioStream?.(ev.streams[0]);
      }
    };

    const camMicBundle = new MediaStream();
    const camStream = this.provider.getCameraStream();
    const micStream = this.provider.getMicStream();
    const screenStream = this.provider.getScreenStream();

    camStream?.getVideoTracks().forEach((t) => {
      if (t.readyState === 'live') camMicBundle.addTrack(t);
    });
    micStream?.getAudioTracks().forEach((t) => {
      if (t.readyState === 'live') camMicBundle.addTrack(t);
    });

    for (const track of camMicBundle.getTracks()) {
      pc.addTrack(track, camMicBundle);
    }

    let screenVideoTrackId: string | null = null;
    if (screenStream) {
      for (const track of screenStream.getVideoTracks()) {
        if (track.readyState === 'live') {
          screenVideoTrackId = track.id;
          pc.addTrack(track, screenStream);
        }
      }
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.channel && !this.disposed) {
        void this.channel.send({
          type: 'broadcast',
          event: 'signal',
          payload: {
            type: 'ice',
            viewerId,
            candidate: ev.candidate.toJSON(),
          } satisfies SignalEnvelope,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.closePeer(viewerId);
      }
    };

    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await applyAdaptiveEncoding(pc, screenVideoTrackId);

      await this.channel?.send({
        type: 'broadcast',
        event: 'signal',
        payload: {
          type: 'offer',
          viewerId,
          sdp: pc.localDescription ?? offer,
          cameraStreamId: camMicBundle.getTracks().length > 0 ? camMicBundle.id : null,
          screenStreamId: screenVideoTrackId ? screenStream?.id ?? null : null,
        } satisfies SignalEnvelope,
      });
    } catch {
      this.closePeer(viewerId);
    }
  }

  notifyStreamsUpdated(): void {
    for (const viewerId of Array.from(this.activeViewers)) {
      if (typeof RTCPeerConnection !== 'undefined') {
        void this.createOfferForViewer(viewerId);
      }
    }
  }

  private closePeer(viewerId: string): void {
    const pc = this.peers.get(viewerId);
    this.peers.delete(viewerId);
    this.pendingIce.delete(viewerId);
    if (pc) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch {
        // Ignore
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.telemetryTimer !== null) {
      window.clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    this.audioSource?.disconnect();
    this.audioSource = null;
    this.analyser = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    for (const viewerId of Array.from(this.peers.keys())) {
      this.closePeer(viewerId);
    }
    this.activeViewers.clear();
    if (this.channel) {
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }
}

export interface TeacherViewerCallbacks {
  onCameraStream: (stream: MediaStream | null) => void;
  onScreenStream: (stream: MediaStream | null) => void;
  onTelemetry?: (telemetry: LiveTelemetryPayload) => void;
  onStateChange: (state: RTCPeerConnectionState | 'connecting' | 'live-telemetry' | 'disconnected') => void;
}

export class TeacherWebRTCViewer {
  private readonly sessionId: string;
  private readonly viewerId: string;
  private readonly callbacks: TeacherViewerCallbacks;
  private channel: RealtimeChannel | null = null;
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private cameraStreamId: string | null = null;
  private screenStreamId: string | null = null;
  private teacherMicStream: MediaStream | null = null;
  private voiceRelayRecorder: MediaRecorder | null = null;
  private voiceRelayInterval: number | null = null;
  private handshakeInterval: number | null = null;
  private receivedMediaOrTelemetry = false;
  private retryTimer: number | null = null;
  private disposed = false;

  constructor(sessionId: string, callbacks: TeacherViewerCallbacks) {
    this.sessionId = sessionId;
    this.viewerId = safeRandomUUID();
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.disposed) return;
    this.callbacks.onStateChange('connecting');

    const topic = `peek:${this.sessionId}`;
    this.channel = supabase.channel(topic, {
      config: { broadcast: { self: false } },
    });

    this.channel
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        void this.handleSignal(payload as SignalEnvelope);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.requestStream();
          if (this.handshakeInterval === null) {
            this.handshakeInterval = window.setInterval(() => {
              if (this.disposed) return;
              if (!this.receivedMediaOrTelemetry) {
                this.sendWatchRequest();
              }
            }, 1500);
          }
        }
      });
  }

  private sendWatchRequest(): void {
    if (this.disposed || !this.channel) return;
    void this.channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: {
        type: 'watch-request',
        viewerId: this.viewerId,
      } satisfies SignalEnvelope,
    });
  }

  requestStream(): void {
    if (this.disposed || !this.channel) return;
    this.receivedMediaOrTelemetry = false;
    this.callbacks.onStateChange('connecting');
    this.sendWatchRequest();
  }

  async startSpeakingToStudent(): Promise<boolean> {
    if (this.disposed || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.teacherMicStream = mic;
      void this.channel?.send({
        type: 'broadcast',
        event: 'signal',
        payload: {
          type: 'teacher-speaking',
          viewerId: this.viewerId,
          speaking: true,
        } satisfies SignalEnvelope,
      });

      // Relay short 900ms Opus audio chunks over Realtime so two-way teacher voice works
      // reliably even without renegotiating WebRTC ICE across NATs!
      if (typeof MediaRecorder !== 'undefined') {
        const startChunk = () => {
          if (!this.teacherMicStream || this.disposed) return;
          const rec = new MediaRecorder(this.teacherMicStream);
          this.voiceRelayRecorder = rec;
          const parts: BlobPart[] = [];
          rec.ondataavailable = (e) => {
            if (e.data.size > 0) parts.push(e.data);
          };
          rec.onstop = () => {
            if (parts.length === 0 || this.disposed) return;
            const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
            const reader = new FileReader();
            reader.onloadend = () => {
              if (typeof reader.result === 'string' && this.channel && !this.disposed) {
                void this.channel.send({
                  type: 'broadcast',
                  event: 'signal',
                  payload: {
                    type: 'teacher-voice',
                    viewerId: this.viewerId,
                    audioDataUrl: reader.result,
                  } satisfies SignalEnvelope,
                });
              }
            };
            reader.readAsDataURL(blob);
          };
          rec.start();
          window.setTimeout(() => {
            if (rec.state === 'recording') rec.stop();
          }, 900);
        };

        startChunk();
        this.voiceRelayInterval = window.setInterval(startChunk, 950);
      }
      return true;
    } catch {
      return false;
    }
  }

  stopSpeakingToStudent(): void {
    if (this.voiceRelayInterval !== null) {
      window.clearInterval(this.voiceRelayInterval);
      this.voiceRelayInterval = null;
    }
    if (this.voiceRelayRecorder && this.voiceRelayRecorder.state === 'recording') {
      try {
        this.voiceRelayRecorder.stop();
      } catch {
        // Ignore
      }
    }
    this.voiceRelayRecorder = null;
    if (this.teacherMicStream) {
      this.teacherMicStream.getTracks().forEach((t) => t.stop());
      this.teacherMicStream = null;
    }
    void this.channel?.send({
      type: 'broadcast',
      event: 'signal',
      payload: {
        type: 'teacher-speaking',
        viewerId: this.viewerId,
        speaking: false,
      } satisfies SignalEnvelope,
    });
  }

  private async handleSignal(msg: SignalEnvelope): Promise<void> {
    if (this.disposed || msg.viewerId !== this.viewerId) return;

    if (msg.type === 'telemetry' && msg.telemetry) {
      this.receivedMediaOrTelemetry = true;
      this.callbacks.onTelemetry?.(msg.telemetry);
      if (!this.pc || this.pc.connectionState !== 'connected') {
        this.callbacks.onStateChange('live-telemetry');
      }
      return;
    }

    if (msg.type === 'offer' && msg.sdp && typeof RTCPeerConnection !== 'undefined') {
      this.receivedMediaOrTelemetry = true;
      this.closePeerOnly();
      this.cameraStreamId = msg.cameraStreamId ?? null;
      this.screenStreamId = msg.screenStreamId ?? null;

      const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
      this.pc = pc;

      const combinedCamMic = new MediaStream();
      let receivedVideoStreams = 0;

      pc.ontrack = (ev) => {
        const stream = ev.streams[0];
        if (this.screenStreamId && stream && stream.id === this.screenStreamId) {
          this.callbacks.onScreenStream(stream);
          return;
        }
        if (ev.track.kind === 'audio') {
          combinedCamMic.addTrack(ev.track);
          this.callbacks.onCameraStream(combinedCamMic);
          return;
        }
        if (this.cameraStreamId && stream && stream.id === this.cameraStreamId) {
          stream.getTracks().forEach((t) => {
            if (!combinedCamMic.getTracks().some((x) => x.id === t.id)) {
              combinedCamMic.addTrack(t);
            }
          });
          this.callbacks.onCameraStream(combinedCamMic);
        } else if (ev.track.kind === 'video') {
          receivedVideoStreams += 1;
          if (receivedVideoStreams === 1) {
            combinedCamMic.addTrack(ev.track);
            this.callbacks.onCameraStream(combinedCamMic);
          } else if (stream) {
            this.callbacks.onScreenStream(stream);
          }
        }
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate && this.channel && !this.disposed) {
          void this.channel.send({
            type: 'broadcast',
            event: 'signal',
            payload: {
              type: 'ice',
              viewerId: this.viewerId,
              candidate: ev.candidate.toJSON(),
            } satisfies SignalEnvelope,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (this.disposed) return;
        this.callbacks.onStateChange(pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          if (this.retryTimer === null) {
            this.retryTimer = window.setTimeout(() => {
              this.retryTimer = null;
              if (!this.disposed) this.requestStream();
            }, 3500);
          }
        }
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        for (const cand of this.pendingIce) {
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        this.pendingIce = [];

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.channel?.send({
          type: 'broadcast',
          event: 'signal',
          payload: {
            type: 'answer',
            viewerId: this.viewerId,
            sdp: pc.localDescription ?? answer,
          } satisfies SignalEnvelope,
        });
      } catch {
        this.callbacks.onStateChange('failed');
      }
    } else if (msg.type === 'ice' && msg.candidate) {
      if (this.pc?.remoteDescription) {
        await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      } else {
        this.pendingIce.push(msg.candidate);
      }
    }
  }

  private closePeerOnly(): void {
    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      } catch {
        // Ignore
      }
      this.pc = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopSpeakingToStudent();
    if (this.handshakeInterval !== null) {
      window.clearInterval(this.handshakeInterval);
      this.handshakeInterval = null;
    }
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.channel) {
      void this.channel.send({
        type: 'broadcast',
        event: 'signal',
        payload: { type: 'watch-stop', viewerId: this.viewerId } satisfies SignalEnvelope,
      });
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }
    this.closePeerOnly();
    this.callbacks.onCameraStream(null);
    this.callbacks.onScreenStream(null);
  }
}
