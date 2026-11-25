import type { ProctoringConfig, ProctoringEventType } from '@/types';

const DEFAULT_WASM_ROOT =
  String(import.meta.env.VITE_MEDIAPIPE_WASM_ROOT ?? '').trim() ||
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';

const DEFAULT_FACE_MODEL =
  String(import.meta.env.VITE_MEDIAPIPE_FACE_MODEL_URL ?? '').trim() ||
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

const DEFAULT_OBJECT_MODEL =
  String(import.meta.env.VITE_MEDIAPIPE_OBJECT_MODEL_URL ?? '').trim() ||
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';

type VisionModule = typeof import('@mediapipe/tasks-vision');
type FaceDetectorInstance = import('@mediapipe/tasks-vision').FaceDetector;
type ObjectDetectorInstance = import('@mediapipe/tasks-vision').ObjectDetector;

let visionPromise: Promise<VisionModule> | null = null;
let sharedFaceDetectorPromise: Promise<FaceDetectorInstance | null> | null = null;
let sharedObjectDetectorPromise: Promise<ObjectDetectorInstance | null> | null = null;

async function loadVisionModule(): Promise<VisionModule> {
  if (!visionPromise) {
    visionPromise = import('@mediapipe/tasks-vision');
  }
  return visionPromise;
}

export async function getSharedFaceDetector(): Promise<FaceDetectorInstance | null> {
  if (!sharedFaceDetectorPromise) {
    sharedFaceDetectorPromise = (async () => {
      try {
        const vision = await loadVisionModule();
        const fileset = await vision.FilesetResolver.forVisionTasks(DEFAULT_WASM_ROOT);
        return await vision.FaceDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: DEFAULT_FACE_MODEL,
            delegate: 'CPU',
          },
          runningMode: 'IMAGE',
          minDetectionConfidence: 0.55,
        });
      } catch {
        sharedFaceDetectorPromise = null;
        return null;
      }
    })();
  }
  return sharedFaceDetectorPromise;
}

export async function getSharedObjectDetector(): Promise<ObjectDetectorInstance | null> {
  if (!sharedObjectDetectorPromise) {
    sharedObjectDetectorPromise = (async () => {
      try {
        const vision = await loadVisionModule();
        const fileset = await vision.FilesetResolver.forVisionTasks(DEFAULT_WASM_ROOT);
        return await vision.ObjectDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: DEFAULT_OBJECT_MODEL,
            delegate: 'CPU',
          },
          runningMode: 'IMAGE',
          scoreThreshold: 0.45,
          maxResults: 6,
          categoryAllowlist: ['person', 'cell phone', 'book', 'laptop'],
        });
      } catch {
        sharedObjectDetectorPromise = null;
        return null;
      }
    })();
  }
  return sharedObjectDetectorPromise;
}

export interface FrameLuminanceStats {
  mean: number;
  stdDev: number;
  isObstructed: boolean;
}

export function analyzeFrameLuminance(
  source: HTMLVideoElement | HTMLCanvasElement,
  scratchCanvas?: HTMLCanvasElement
): FrameLuminanceStats {
  const canvas = scratchCanvas ?? document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { mean: 0, stdDev: 0, isObstructed: true };

  ctx.drawImage(source, 0, 0, 64, 48);
  const { data } = ctx.getImageData(0, 0, 64, 48);
  const pixelCount = 64 * 48;

  let sum = 0;
  const lumas = new Float32Array(pixelCount);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    lumas[p] = y;
    sum += y;
  }
  const mean = sum / pixelCount;
  let varianceSum = 0;
  for (let p = 0; p < pixelCount; p++) {
    const diff = lumas[p] - mean;
    varianceSum += diff * diff;
  }
  const stdDev = Math.sqrt(varianceSum / pixelCount);

  // Very dark frame OR near-uniform covered/taped camera lens
  const isObstructed = mean < 14 || stdDev < 4.0;
  return { mean, stdDev, isObstructed };
}

export interface FaceCheckFrameResult {
  modelLoaded: boolean;
  faceCount: number;
  confidence: number;
  centered: boolean;
  isObstructed: boolean;
  luminance: number;
}

export async function inspectVideoForFaceCheck(video: HTMLVideoElement): Promise<FaceCheckFrameResult> {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
    return {
      modelLoaded: true,
      faceCount: 0,
      confidence: 0,
      centered: false,
      isObstructed: false,
      luminance: 0,
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = Math.max(180, Math.round((video.videoHeight / video.videoWidth) * 320));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { modelLoaded: false, faceCount: 0, confidence: 0, centered: false, isObstructed: true, luminance: 0 };
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const lum = analyzeFrameLuminance(canvas);
  if (lum.isObstructed) {
    return {
      modelLoaded: true,
      faceCount: 0,
      confidence: 0,
      centered: false,
      isObstructed: true,
      luminance: lum.mean,
    };
  }

  const detector = await getSharedFaceDetector();
  if (!detector) {
    return {
      modelLoaded: false,
      faceCount: 0,
      confidence: 0,
      centered: false,
      isObstructed: false,
      luminance: lum.mean,
    };
  }

  const res = detector.detect(canvas);
  const validFaces = (res.detections ?? []).filter(
    (d) => (d.categories?.[0]?.score ?? 0) >= 0.55
  );

  if (validFaces.length !== 1) {
    const maxScore = validFaces.reduce((m, d) => Math.max(m, d.categories?.[0]?.score ?? 0), 0);
    return {
      modelLoaded: true,
      faceCount: validFaces.length,
      confidence: maxScore,
      centered: false,
      isObstructed: false,
      luminance: lum.mean,
    };
  }

  const face = validFaces[0];
  const score = face.categories?.[0]?.score ?? 0;
  const box = face.boundingBox;
  let centered = true;
  if (box) {
    const cx = (box.originX + box.width / 2) / canvas.width;
    const cy = (box.originY + box.height / 2) / canvas.height;
    const relWidth = box.width / canvas.width;
    centered = cx >= 0.2 && cx <= 0.8 && cy >= 0.15 && cy <= 0.85 && relWidth >= 0.12;
  }

  return {
    modelLoaded: true,
    faceCount: 1,
    confidence: score,
    centered,
    isObstructed: false,
    luminance: lum.mean,
  };
}

export interface DetectedProctoringSignal {
  eventType: ProctoringEventType;
  description: string;
  confidence?: number;
  durationMs?: number;
  details?: Record<string, unknown>;
  captureSnapshot?: boolean;
}

export interface AIProctoringCallbacks {
  getVideoElement: () => HTMLVideoElement | null;
  getAudioStream: () => MediaStream | null;
  config?: Partial<ProctoringConfig>;
  onSignal: (signal: DetectedProctoringSignal) => void;
  onStatusChange?: (status: { faceModelReady: boolean; objectModelReady: boolean; audioReady: boolean }) => void;
}

export class AIProctoringMonitor {
  private readonly cb: AIProctoringCallbacks;
  private faceTimer: number | null = null;
  private objectTimer: number | null = null;
  private audioTimer: number | null = null;
  private frameCanvas: HTMLCanvasElement;
  private lumCanvas: HTMLCanvasElement;

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private audioSource: MediaStreamAudioSourceNode | null = null;
  private boundAudioStreamId: string | null = null;
  private ambientFloor = 0.018;

  private conditionSince: Partial<Record<ProctoringEventType, number>> = {};
  private lastEmittedAt: Partial<Record<ProctoringEventType, number>> = {};
  private faceBusy = false;
  private objectBusy = false;
  private disposed = false;

  constructor(callbacks: AIProctoringCallbacks) {
    this.cb = callbacks;
    this.frameCanvas = document.createElement('canvas');
    this.frameCanvas.width = 320;
    this.frameCanvas.height = 240;
    this.lumCanvas = document.createElement('canvas');
  }

  async start(): Promise<void> {
    if (this.disposed) return;

    const cfg = this.cb.config;
    const enableFace = cfg?.face_detection !== false;
    const enableObj = cfg?.object_detection !== false;
    const enableAudio = cfg?.audio_monitoring !== false;

    const [faceDet, objDet] = await Promise.all([
      enableFace ? getSharedFaceDetector() : Promise.resolve(null),
      enableObj ? getSharedObjectDetector() : Promise.resolve(null),
    ]);

    if (this.disposed) return;

    if ((enableFace && !faceDet) || (enableObj && !objDet)) {
      this.emitWithCooldown({
        eventType: 'monitoring_error',
        description:
          'One or more client-side AI vision models could not be initialized; browser and device monitoring remain active.',
        details: { faceLoaded: Boolean(faceDet), objectLoaded: Boolean(objDet) },
      });
    }

    if (enableAudio) {
      this.ensureAudioGraph();
    }

    this.cb.onStatusChange?.({
      faceModelReady: Boolean(faceDet),
      objectModelReady: Boolean(objDet),
      audioReady: Boolean(this.analyser),
    });

    if (enableFace) {
      this.faceTimer = window.setInterval(() => {
        void this.runFacePass();
      }, 1200);
    }

    if (enableObj && objDet) {
      this.objectTimer = window.setInterval(() => {
        void this.runObjectPass();
      }, 2600);
    }

    if (enableAudio) {
      this.audioTimer = window.setInterval(() => {
        this.runAudioPass();
      }, 500);
    }
  }

  private getSustainMs(type: ProctoringEventType, fallbackSec: number): number {
    const sec = this.cb.config?.sustain_seconds?.[type] ?? fallbackSec;
    return Math.max(500, sec * 1000);
  }

  private getMinConfidence(type: ProctoringEventType, fallback: number): number {
    return this.cb.config?.min_confidence?.[type] ?? fallback;
  }

  private getCooldownMs(type: ProctoringEventType, fallbackSec = 25): number {
    const sec =
      this.cb.config?.cooldown_seconds?.[type] ??
      this.cb.config?.cooldown_seconds?.default ??
      fallbackSec;
    return Math.max(2000, sec * 1000);
  }

  private trackSustained(
    type: ProctoringEventType,
    active: boolean,
    sustainMs: number,
    buildSignal: (durationMs: number) => DetectedProctoringSignal
  ): void {
    const now = Date.now();
    if (!active) {
      delete this.conditionSince[type];
      return;
    }
    const since = this.conditionSince[type] ?? now;
    this.conditionSince[type] = since;
    const elapsed = now - since;
    if (elapsed >= sustainMs) {
      this.emitWithCooldown(buildSignal(elapsed));
      // Reset sustain timer after emission so next alert requires another sustained window
      this.conditionSince[type] = now;
    }
  }

  private emitWithCooldown(signal: DetectedProctoringSignal): void {
    if (this.disposed) return;
    const now = Date.now();
    const last = this.lastEmittedAt[signal.eventType] ?? 0;
    if (now - last < this.getCooldownMs(signal.eventType)) {
      return;
    }
    this.lastEmittedAt[signal.eventType] = now;
    this.cb.onSignal(signal);
  }

  private drawCurrentVideoFrame(): boolean {
    const video = this.cb.getVideoElement();
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return false;
    }
    const ctx = this.frameCanvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, this.frameCanvas.width, this.frameCanvas.height);
    return true;
  }

  private async runFacePass(): Promise<void> {
    if (this.disposed || this.faceBusy) return;
    this.faceBusy = true;
    try {
      if (!this.drawCurrentVideoFrame()) return;

      const lum = analyzeFrameLuminance(this.frameCanvas, this.lumCanvas);
      this.trackSustained(
        'camera_obstructed',
        lum.isObstructed,
        this.getSustainMs('camera_obstructed', 3),
        (durationMs) => ({
          eventType: 'camera_obstructed',
          description: 'Camera feed appears dark or obstructed for a sustained period.',
          confidence: 0.85,
          durationMs,
          details: { meanLuminance: Math.round(lum.mean), stdDev: Number(lum.stdDev.toFixed(1)) },
          captureSnapshot: true,
        })
      );

      if (lum.isObstructed) {
        delete this.conditionSince.face_not_detected;
        delete this.conditionSince.multiple_faces;
        return;
      }

      const detector = await getSharedFaceDetector();
      if (!detector || this.disposed) return;

      const res = detector.detect(this.frameCanvas);
      const minMultiConf = this.getMinConfidence('multiple_faces', 0.6);
      const faces = (res.detections ?? []).filter((d) => (d.categories?.[0]?.score ?? 0) >= 0.52);
      const highConfFaces = faces.filter((d) => (d.categories?.[0]?.score ?? 0) >= minMultiConf);

      this.trackSustained(
        'face_not_detected',
        faces.length === 0,
        this.getSustainMs('face_not_detected', 5),
        (durationMs) => ({
          eventType: 'face_not_detected',
          description: `No face detected in camera frame for ${Math.round(durationMs / 1000)}s.`,
          durationMs,
          captureSnapshot: true,
        })
      );

      const topMultiConf = highConfFaces.reduce(
        (m, d) => Math.max(m, d.categories?.[0]?.score ?? 0),
        0
      );
      this.trackSustained(
        'multiple_faces',
        highConfFaces.length >= 2,
        this.getSustainMs('multiple_faces', 2),
        (durationMs) => ({
          eventType: 'multiple_faces',
          description: `Multiple faces (${highConfFaces.length}) visible in camera frame.`,
          confidence: Number(topMultiConf.toFixed(3)),
          durationMs,
          details: { count: highConfFaces.length },
          captureSnapshot: true,
        })
      );
    } catch {
      // Non-fatal frame error
    } finally {
      this.faceBusy = false;
    }
  }

  private async runObjectPass(): Promise<void> {
    if (this.disposed || this.objectBusy) return;
    this.objectBusy = true;
    try {
      if (!this.drawCurrentVideoFrame()) return;
      const detector = await getSharedObjectDetector();
      if (!detector || this.disposed) return;

      const res = detector.detect(this.frameCanvas);
      const detections = res.detections ?? [];

      const phoneMin = this.getMinConfidence('phone_detected', 0.55);
      const objMin = this.getMinConfidence('prohibited_object', 0.6);
      const personMin = this.getMinConfidence('multiple_faces', 0.6);

      let bestPhone = 0;
      let bestBook = 0;
      let personCount = 0;
      let bestPerson = 0;

      for (const det of detections) {
        const cat = det.categories?.[0];
        if (!cat) continue;
        const name = cat.categoryName?.toLowerCase() ?? '';
        const score = cat.score ?? 0;
        if (name === 'cell phone' && score >= phoneMin) {
          bestPhone = Math.max(bestPhone, score);
        } else if (name === 'book' && score >= objMin) {
          bestBook = Math.max(bestBook, score);
        } else if (name === 'person' && score >= personMin) {
          personCount += 1;
          bestPerson = Math.max(bestPerson, score);
        }
      }

      this.trackSustained(
        'phone_detected',
        bestPhone >= phoneMin,
        this.getSustainMs('phone_detected', 2),
        (durationMs) => ({
          eventType: 'phone_detected',
          description: 'Mobile phone detected in camera frame (flagged for instructor review).',
          confidence: Number(bestPhone.toFixed(3)),
          durationMs,
          details: { object: 'cell phone' },
          captureSnapshot: true,
        })
      );

      this.trackSustained(
        'prohibited_object',
        bestBook >= objMin,
        this.getSustainMs('prohibited_object', 3),
        (durationMs) => ({
          eventType: 'prohibited_object',
          description: 'Reference book/material detected in camera frame (flagged for review).',
          confidence: Number(bestBook.toFixed(3)),
          durationMs,
          details: { object: 'book' },
          captureSnapshot: true,
        })
      );

      if (personCount >= 2) {
        this.trackSustained(
          'multiple_faces',
          true,
          this.getSustainMs('multiple_faces', 2),
          (durationMs) => ({
            eventType: 'multiple_faces',
            description: `Multiple people (${personCount}) detected in the examination area.`,
            confidence: Number(bestPerson.toFixed(3)),
            durationMs,
            details: { personCount },
            captureSnapshot: true,
          })
        );
      }
    } catch {
      // Non-fatal frame error
    } finally {
      this.objectBusy = false;
    }
  }

  private ensureAudioGraph(): void {
    const stream = this.cb.getAudioStream();
    if (!stream || stream.getAudioTracks().length === 0) return;
    if (this.boundAudioStreamId === stream.id && this.analyser) return;

    this.teardownAudioGraph();
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.audioCtx = new AudioCtx();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;
      this.audioSource = this.audioCtx.createMediaStreamSource(stream);
      this.audioSource.connect(this.analyser);
      this.boundAudioStreamId = stream.id;
    } catch {
      this.teardownAudioGraph();
    }
  }

  private runAudioPass(): void {
    if (this.disposed) return;
    this.ensureAudioGraph();
    if (!this.analyser || !this.audioCtx) return;
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {});
      return;
    }

    const binCount = this.analyser.frequencyBinCount;
    const freqBins = new Uint8Array(binCount);
    this.analyser.getByteFrequencyData(freqBins);

    const nyquist = this.audioCtx.sampleRate / 2;
    const binHz = nyquist / binCount;
    const lowBin = Math.max(1, Math.floor(300 / binHz));
    const highBin = Math.min(binCount - 1, Math.ceil(3400 / binHz));

    let speechSum = 0;
    let totalSum = 0;
    for (let i = 1; i < binCount; i++) {
      const norm = freqBins[i] / 255;
      totalSum += norm;
      if (i >= lowBin && i <= highBin) {
        speechSum += norm;
      }
    }

    const speechAvg = speechSum / Math.max(1, highBin - lowBin + 1);
    const totalAvg = totalSum / Math.max(1, binCount - 1);

    // Slowly adapt ambient noise floor during quiet moments
    if (speechAvg < this.ambientFloor * 1.6) {
      this.ambientFloor = Math.max(0.012, Math.min(0.08, this.ambientFloor * 0.95 + speechAvg * 0.05));
    }

    const speechRatio = totalAvg > 0.005 ? speechAvg / totalAvg : 0;
    const isSpeechLike = speechAvg > Math.max(0.055, this.ambientFloor * 2.8) && speechRatio > 1.25;
    const confidence = Math.min(0.98, Math.max(0.5, speechAvg * 4));

    this.trackSustained(
      'voice_activity',
      isSpeechLike,
      this.getSustainMs('voice_activity', 4),
      (durationMs) => ({
        eventType: 'voice_activity',
        description: `Sustained speech-band audio detected for ${Math.round(durationMs / 1000)}s (reviewable signal, not automatic proof of misconduct).`,
        confidence: Number(confidence.toFixed(3)),
        durationMs,
        details: { speechBandEnergy: Number(speechAvg.toFixed(3)) },
      })
    );
  }

  private teardownAudioGraph(): void {
    try {
      this.audioSource?.disconnect();
    } catch {
      // Ignore
    }
    this.audioSource = null;
    this.analyser = null;
    this.boundAudioStreamId = null;
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.faceTimer !== null) window.clearInterval(this.faceTimer);
    if (this.objectTimer !== null) window.clearInterval(this.objectTimer);
    if (this.audioTimer !== null) window.clearInterval(this.audioTimer);
    this.faceTimer = null;
    this.objectTimer = null;
    this.audioTimer = null;
    this.teardownAudioGraph();
  }
}
