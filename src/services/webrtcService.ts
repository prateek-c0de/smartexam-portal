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
      servers.push(
        username
          ? { urls: turnUrls, username, credential }
          : { urls: turnUrls }
      );
    }
  }

  return servers;
}

interface SignalEnvelope {
  type: 'watch-request' | 'watch-stop' | 'offer' | 'answer' | 'ice';
  viewerId: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  cameraStreamId?: string | null;
  screenStreamId?: string | null;
}

async function applyAdaptiveEncoding(pc: RTCPeerConnection, screenTrackId?: string | null): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const isScreen = sender.track.id === screenTrackId;
      params.encodings[0].maxBitrate = isScreen ? 380_000 : 220_000;
      params.encodings[0].maxFramerate = isScreen ? 8 : 15;
      if (!isScreen) {
        params.encodings[0].scaleResolutionDownBy = 1;
      }
      await sender.setParameters(params);
    } catch {
      // Browser may not support runtime encoding adjustments — safe to continue
    }
  }
}

export interface StudentMediaProvider {
  getCameraStream: () => MediaStream | null;
  getMicStream: () => MediaStream | null;
  getScreenStream: () => MediaStream | null;
}

export class StudentWebRTCResponder {
  private readonly sessionId: string;
  private readonly provider: StudentMediaProvider;
  private channel: RealtimeChannel | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private disposed = false;

  constructor(sessionId: string, provider: StudentMediaProvider) {
    this.sessionId = sessionId;
    this.provider = provider;
  }

  start(): void {
    if (this.disposed || this.channel || typeof RTCPeerConnection === 'undefined') return;

    const topic = `webrtc:${this.sessionId}`;
    this.channel = supabase.channel(topic, {
      config: { broadcast: { self: false } },
    });

    this.channel
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        void this.handleSignal(payload as SignalEnvelope);
      })
      .subscribe();
  }

  private async handleSignal(msg: SignalEnvelope): Promise<void> {
    if (this.disposed || !msg?.viewerId) return;

    if (msg.type === 'watch-request') {
      await this.createOfferForViewer(msg.viewerId);
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
        // Ignore stale SDP answer
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
    } else if (msg.type === 'watch-stop') {
      this.closePeer(msg.viewerId);
    }
  }

  private async createOfferForViewer(viewerId: string): Promise<void> {
    this.closePeer(viewerId);
    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    this.peers.set(viewerId, pc);

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
      const offer = await pc.createOffer();
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
    // Re-negotiate for any currently connected teacher viewers when a stream recovers
    for (const viewerId of Array.from(this.peers.keys())) {
      void this.createOfferForViewer(viewerId);
    }
  }

  private closePeer(viewerId: string): void {
    const pc = this.peers.get(viewerId);
    this.peers.delete(viewerId);
    this.pendingIce.delete(viewerId);
    if (pc) {
      try {
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
    for (const viewerId of Array.from(this.peers.keys())) {
      this.closePeer(viewerId);
    }
    if (this.channel) {
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }
}

export interface TeacherViewerCallbacks {
  onCameraStream: (stream: MediaStream | null) => void;
  onScreenStream: (stream: MediaStream | null) => void;
  onStateChange: (state: RTCPeerConnectionState | 'connecting' | 'disconnected') => void;
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
  private retryTimer: number | null = null;
  private disposed = false;

  constructor(sessionId: string, callbacks: TeacherViewerCallbacks) {
    this.sessionId = sessionId;
    this.viewerId = safeRandomUUID();
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.disposed || typeof RTCPeerConnection === 'undefined') return;
    this.callbacks.onStateChange('connecting');

    const topic = `webrtc:${this.sessionId}`;
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
        }
      });
  }

  requestStream(): void {
    if (this.disposed || !this.channel) return;
    this.callbacks.onStateChange('connecting');
    void this.channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: {
        type: 'watch-request',
        viewerId: this.viewerId,
      } satisfies SignalEnvelope,
    });
  }

  private async handleSignal(msg: SignalEnvelope): Promise<void> {
    if (this.disposed || msg.viewerId !== this.viewerId) return;

    if (msg.type === 'offer' && msg.sdp) {
      this.closePeerOnly();
      this.cameraStreamId = msg.cameraStreamId ?? null;
      this.screenStreamId = msg.screenStreamId ?? null;

      const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
      this.pc = pc;

      let receivedVideoStreams = 0;
      pc.ontrack = (ev) => {
        const stream = ev.streams[0];
        if (!stream) return;
        if (this.screenStreamId && stream.id === this.screenStreamId) {
          this.callbacks.onScreenStream(stream);
        } else if (this.cameraStreamId && stream.id === this.cameraStreamId) {
          this.callbacks.onCameraStream(stream);
        } else if (ev.track.kind === 'video') {
          receivedVideoStreams += 1;
          if (receivedVideoStreams === 1) this.callbacks.onCameraStream(stream);
          else this.callbacks.onScreenStream(stream);
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
