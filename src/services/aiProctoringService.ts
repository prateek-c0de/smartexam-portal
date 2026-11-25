import type { ProctoringConfig, ProctoringEventType } from '@/types';

const LOCAL_WASM_ROOT = '/mediapipe/wasm';
const CDN_WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';

const LOCAL_FACE_MODEL = '/mediapipe/blaze_face_short_range.tflite';
const CDN_FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

const LOCAL_OBJECT_MODEL = '/mediapipe/efficientdet_lite0.tflite';
const CDN_OBJECT_MODEL =
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
      const vision = await loadVisionModule();
      const customWasm = String(import.meta.env.VITE_MEDIAPIPE_WASM_ROOT ?? '').trim();
      const customModel = String(import.meta.env.VITE_MEDIAPIPE_FACE_MODEL_URL ?? '').trim();

      const candidates: Array<{ wasm: string; model: string }> = [
        { wasm: customWasm || LOCAL_WASM_ROOT, model: customModel || LOCAL_FACE_MODEL },
        { wasm: CDN_WASM_ROOT, model: CDN_FACE_MODEL },
      ];

      for (const cand of candidates) {
        try {
          const fileset = await vision.FilesetResolver.forVisionTasks(cand.wasm);
          return await vision.FaceDetector.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: cand.model,
              delegate: 'CPU',
            },
            runningMode: 'IMAGE',
            minDetectionConfidence: 0.35,
          });
        } catch {
          // Try next candidate
        }
      }

      sharedFaceDetectorPromise = null;
      return null;
    })();
  }
  return sharedFaceDetectorPromise;
}

export async function getSharedObjectDetector(): Promise<ObjectDetectorInstance | null> {
  if (!sharedObjectDetectorPromise) {
    sharedObjectDetectorPromise = (async () => {
      const vision = await loadVisionModule();
      const customWasm = String(import.meta.env.VITE_MEDIAPIPE_WASM_ROOT ?? '').trim();
      const customModel = String(import.meta.env.VITE_MEDIAPIPE_OBJECT_MODEL_URL ?? '').trim();

      const candidates: Array<{ wasm: string; model: string }> = [
        { wasm: customWasm || LOCAL_WASM_ROOT, model: customModel || LOCAL_OBJECT_MODEL },
        { wasm: CDN_WASM_ROOT, model: CDN_OBJECT_MODEL },
      ];

      for (const cand of candidates) {
        try {
          const fileset = await vision.FilesetResolver.forVisionTasks(cand.wasm);
          return await vision.ObjectDetector.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: cand.model,
              delegate: 'CPU',
            },
            runningMode: 'IMAGE',
            scoreThreshold: 0.25,
            maxResults: 10,
            categoryAllowlist: ['person', 'cell phone', 'book', 'laptop'],
          });
        } catch {
          // Try next candidate
        }
      }

      sharedObjectDetectorPromise = null;
      return null;
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

  const isObstructed = mean < 14 || stdDev < 4.0;
  return { mean, stdDev, isObstructed };
}

interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxIoU(a: BBox, b: BBox): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.w, b.x + b.w);
  const iy2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
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
  canvas.width = 480;
  canvas.height = Math.max(270, Math.round((video.videoHeight / video.videoWidth) * 480));
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
    (d) => (d.categories?.[0]?.score ?? 0) >= 0.48
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
    centered = cx >= 0.15 && cx <= 0.85 && cy >= 0.12 && cy <= 0.88 && relWidth >= 0.10;
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

class RollingHitWindow {
  private readonly size: number;
  private buffer: boolean[] = [];

  constructor(size: number) {
    this.size = size;
  }

  push(hit: boolean): number {
    this.buffer.push(hit);
    if (this.buffer.length > this.size) {
      this.buffer.shift();
    }
    return this.buffer.filter(Boolean).length;
  }

  clear(): void {
    this.buffer = [];
  }
}

export class AIProctoringMonitor {
  private readonly cb: AIProctoringCallbacks;
  private faceTimer: number | null = null;
  private objectTimer: number | null = null;
  private audioTimer: number | null = null;
  private frameCanvas: HTMLCanvasElement;
  private cropCanvas: HTMLCanvasElement;
  private lumCanvas: HTMLCanvasElement;

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private audioSource: MediaStreamAudioSourceNode | null = null;
  private boundAudioStreamId: string | null = null;
  private ambientFloor = 0.018;

  private conditionSince: Partial<Record<string, number>> = {};
  private lastEmittedAt: Partial<Record<ProctoringEventType, number>> = {};

  // Separate rolling windows so FaceDetector and ObjectDetector never cancel each other out
  private multiFaceWindow = new RollingHitWindow(3);
  private multiPersonWindow = new RollingHitWindow(3);
  private phoneWindow = new RollingHitWindow(4);
  private bookWindow = new RollingHitWindow(3);

  private faceBusy = false;
  private objectBusy = false;
  private disposed = false;

  constructor(callbacks: AIProctoringCallbacks) {
    this.cb = callbacks;
    this.frameCanvas = document.createElement('canvas');
    this.frameCanvas.width = 480;
    this.frameCanvas.height = 360;
    this.cropCanvas = document.createElement('canvas');
    this.cropCanvas.width = 320;
    this.cropCanvas.height = 240;
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
      }, 850);
    }

    if (enableObj && objDet) {
      this.objectTimer = window.setInterval(() => {
        void this.runObjectPass();
      }, 900);
    }

    if (enableAudio) {
      this.audioTimer = window.setInterval(() => {
        this.runAudioPass();
      }, 500);
    }
  }

  private getSustainMs(type: ProctoringEventType, fallbackSec: number): number {
    const sec = this.cb.config?.sustain_seconds?.[type] ?? fallbackSec;
    return Math.max(400, sec * 1000);
  }

  private getMinConfidence(type: ProctoringEventType, fallback: number): number {
    const configured = this.cb.config?.min_confidence?.[type];
    // Cap overly strict legacy thresholds so real webcam detections aren't discarded
    if (type === 'phone_detected') return Math.min(configured ?? fallback, 0.38);
    if (type === 'multiple_faces') return Math.min(configured ?? fallback, 0.42);
    return configured ?? fallback;
  }

  private getCooldownMs(type: ProctoringEventType, fallbackSec = 12): number {
    const sec =
      this.cb.config?.cooldown_seconds?.[type] ??
      this.cb.config?.cooldown_seconds?.default ??
      fallbackSec;
    return Math.max(2000, Math.min(sec, 15) * 1000);
  }

  private trackSustained(
    key: string,
    active: boolean,
    sustainMs: number,
    buildSignal: (durationMs: number) => DetectedProctoringSignal
  ): void {
    const now = Date.now();
    if (!active) {
      delete this.conditionSince[key];
      return;
    }
    const since = this.conditionSince[key] ?? now;
    this.conditionSince[key] = since;
    const elapsed = now - since;
    if (elapsed >= sustainMs) {
      this.emitWithCooldown(buildSignal(elapsed));
      this.conditionSince[key] = now;
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
        this.getSustainMs('camera_obstructed', 2),
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
        this.multiFaceWindow.clear();
        return;
      }

      const detector = await getSharedFaceDetector();
      if (!detector || this.disposed) return;

      const minMultiConf = this.getMinConfidence('multiple_faces', 0.35);
      const res = detector.detect(this.frameCanvas);
      const rawFaces = (res.detections ?? []).filter(
        (d) => (d.categories?.[0]?.score ?? 0) >= minMultiConf
      );

      // Deduplicate overlapping face boxes
      const uniqueFaces: Array<{ box: BBox; score: number }> = [];
      for (const det of rawFaces) {
        const b = det.boundingBox;
        const score = det.categories?.[0]?.score ?? 0;
        if (!b) continue;
        const candidate: BBox = { x: b.originX, y: b.originY, w: b.width, h: b.height };
        if (!uniqueFaces.some((u) => boxIoU(u.box, candidate) > 0.35)) {
          uniqueFaces.push({ box: candidate, score });
        }
      }

      // Secondary zoomed background scan when full-frame found 1 primary face:
      // Masks out the primary student's face and checks the upper room area so a smaller
      // 2nd face standing behind the student's left/right shoulder is detected!
      if (uniqueFaces.length === 1) {
        const primary = uniqueFaces[0].box;
        const cropCtx = this.cropCanvas.getContext('2d');
        if (cropCtx) {
          // Zoom into upper 78% of frame where background heads appear
          const srcH = Math.round(this.frameCanvas.height * 0.78);
          cropCtx.drawImage(
            this.frameCanvas,
            0,
            0,
            this.frameCanvas.width,
            srcH,
            0,
            0,
            this.cropCanvas.width,
            this.cropCanvas.height
          );
          const scaleX = this.cropCanvas.width / this.frameCanvas.width;
          const scaleY = this.cropCanvas.height / srcH;
          const padX = primary.w * 0.18;
          const padY = primary.h * 0.18;
          cropCtx.fillStyle = '#808080';
          cropCtx.fillRect(
            (primary.x - padX) * scaleX,
            (primary.y - padY) * scaleY,
            (primary.w + padX * 2) * scaleX,
            (primary.h + padY * 2) * scaleY
          );

          const bgRes = detector.detect(this.cropCanvas);
          for (const bgDet of bgRes.detections ?? []) {
            const bgScore = bgDet.categories?.[0]?.score ?? 0;
            const bb = bgDet.boundingBox;
            if (bgScore < Math.max(0.42, minMultiConf) || !bb) continue;
            // Map back to full-frame coordinates and ensure it does not overlap primary face
            const mapped: BBox = {
              x: bb.originX / scaleX,
              y: bb.originY / scaleY,
              w: bb.width / scaleX,
              h: bb.height / scaleY,
            };
            if (boxIoU(primary, mapped) < 0.15) {
              uniqueFaces.push({ box: mapped, score: bgScore });
              break;
            }
          }
        }
      }

      this.trackSustained(
        'face_not_detected',
        uniqueFaces.length === 0,
        this.getSustainMs('face_not_detected', 3),
        (durationMs) => ({
          eventType: 'face_not_detected',
          description: `No face detected in camera frame for ${Math.round(durationMs / 1000)}s.`,
          durationMs,
          captureSnapshot: true,
        })
      );

      const isMultiFace = uniqueFaces.length >= 2;
      const multiHits = this.multiFaceWindow.push(isMultiFace);
      const topMultiConf = uniqueFaces.reduce((m, f) => Math.max(m, f.score), 0);
      const strongImmediate =
        isMultiFace && uniqueFaces.every((f) => f.score >= 0.65);

      if (isMultiFace && (strongImmediate || multiHits >= 2)) {
        this.multiFaceWindow.clear();
        this.emitWithCooldown({
          eventType: 'multiple_faces',
          description: `Multiple faces (${uniqueFaces.length}) visible in camera frame.`,
          confidence: Number(topMultiConf.toFixed(3)),
          durationMs: 1500,
          details: { count: uniqueFaces.length, detector: 'face' },
          captureSnapshot: true,
        });
      }
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

      const phoneMin = this.getMinConfidence('phone_detected', 0.32);
      const objMin = this.getMinConfidence('prohibited_object', 0.38);
      const personMin = Math.max(0.36, this.getMinConfidence('multiple_faces', 0.35));

      let bestPhone = 0;
      let bestBook = 0;
      const personBoxes: Array<{ box: BBox; score: number }> = [];

      const fullRes = detector.detect(this.frameCanvas);
      for (const det of fullRes.detections ?? []) {
        const cat = det.categories?.[0];
        if (!cat) continue;
        const name = cat.categoryName?.toLowerCase() ?? '';
        const score = cat.score ?? 0;
        if (name === 'cell phone' && score >= phoneMin) {
          bestPhone = Math.max(bestPhone, score);
        } else if (name === 'book' && score >= objMin) {
          bestBook = Math.max(bestBook, score);
        } else if (name === 'person' && score >= personMin && det.boundingBox) {
          const cand: BBox = {
            x: det.boundingBox.originX,
            y: det.boundingBox.originY,
            w: det.boundingBox.width,
            h: det.boundingBox.height,
          };
          if (!personBoxes.some((p) => boxIoU(p.box, cand) > 0.50)) {
            personBoxes.push({ box: cand, score });
          }
        }
      }

      // Hand/desk lower-zone zoom scan if full-frame did not already detect a phone:
      // Catches smartphones held low near chest, chin, or desk edge!
      if (bestPhone < phoneMin) {
        const cropCtx = this.cropCanvas.getContext('2d');
        if (cropCtx) {
          const sx = Math.round(this.frameCanvas.width * 0.08);
          const sy = Math.round(this.frameCanvas.height * 0.22);
          const sw = Math.round(this.frameCanvas.width * 0.84);
          const sh = this.frameCanvas.height - sy;
          cropCtx.drawImage(
            this.frameCanvas,
            sx,
            sy,
            sw,
            sh,
            0,
            0,
            this.cropCanvas.width,
            this.cropCanvas.height
          );
          const zoomRes = detector.detect(this.cropCanvas);
          for (const det of zoomRes.detections ?? []) {
            const cat = det.categories?.[0];
            if (!cat) continue;
            const name = cat.categoryName?.toLowerCase() ?? '';
            const score = cat.score ?? 0;
            if (name === 'cell phone' && score >= phoneMin) {
              bestPhone = Math.max(bestPhone, score);
            }
          }
        }
      }

      // 1. Mobile Phone rolling-window confirmation (immediate if >= 0.50, or 2-of-4 recent frames)
      const hasPhone = bestPhone >= phoneMin;
      const phoneHits = this.phoneWindow.push(hasPhone);
      if (hasPhone && (bestPhone >= 0.50 || phoneHits >= 2)) {
        this.phoneWindow.clear();
        this.emitWithCooldown({
          eventType: 'phone_detected',
          description: 'Mobile phone detected in camera frame (flagged for instructor review).',
          confidence: Number(bestPhone.toFixed(3)),
          durationMs: 1200,
          details: { object: 'cell phone' },
          captureSnapshot: true,
        });
      }

      // 2. Reference Book rolling-window confirmation (2-of-3 recent frames)
      const hasBook = bestBook >= objMin;
      const bookHits = this.bookWindow.push(hasBook);
      if (hasBook && bookHits >= 2) {
        this.bookWindow.clear();
        this.emitWithCooldown({
          eventType: 'prohibited_object',
          description: 'Reference book/material detected in camera frame (flagged for review).',
          confidence: Number(bestBook.toFixed(3)),
          durationMs: 1800,
          details: { object: 'book' },
          captureSnapshot: true,
        });
      }

      // 3. Multi-person detection (independent from multiFaceWindow so neither cancels the other!)
      const hasMultiPerson = personBoxes.length >= 2;
      const personHits = this.multiPersonWindow.push(hasMultiPerson);
      if (hasMultiPerson && personHits >= 2) {
        const bestPerson = personBoxes.reduce((m, p) => Math.max(m, p.score), 0);
        this.multiPersonWindow.clear();
        this.emitWithCooldown({
          eventType: 'multiple_faces',
          description: `Multiple people (${personBoxes.length}) detected in the examination area.`,
          confidence: Number(bestPerson.toFixed(3)),
          durationMs: 1800,
          details: { personCount: personBoxes.length, detector: 'object_person' },
          captureSnapshot: true,
        });
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
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
