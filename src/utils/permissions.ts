import type { DeviceCheck, PermissionState } from '@/types';

export function detectDevice(): Omit<DeviceCheck, 'internetSpeed'> {
  const ua = navigator.userAgent;
  let browser = 'Unknown';
  let browserVersion = '';

  if (/Edg\/([\d.]+)/.test(ua)) {
    browser = 'Microsoft Edge';
    browserVersion = (ua.match(/Edg\/([\d.]+)/) || [])[1] || '';
  } else if (/Chrome\/([\d.]+)/.test(ua)) {
    browser = 'Google Chrome';
    browserVersion = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '';
  } else if (/Firefox\/([\d.]+)/.test(ua)) {
    browser = 'Mozilla Firefox';
    browserVersion = (ua.match(/Firefox\/([\d.]+)/) || [])[1] || '';
  } else if (/Safari\/([\d.]+)/.test(ua)) {
    browser = 'Safari';
    browserVersion = (ua.match(/Version\/([\d.]+)/) || [])[1] || '';
  }

  let os = 'Unknown';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  return {
    browser,
    browserVersion,
    os,
    screenResolution: `${window.screen.width} × ${window.screen.height}`,
    cookiesEnabled: navigator.cookieEnabled,
    jsEnabled: true,
  };
}

export async function checkInternetSpeed(signal?: AbortSignal): Promise<'good' | 'poor'> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'poor';
  const start = performance.now();
  try {
    await fetch('https://www.gstatic.com/generate_204', {
      mode: 'no-cors',
      cache: 'no-store',
      signal,
    });
    const elapsed = performance.now() - start;
    return elapsed < 800 ? 'good' : 'poor';
  } catch {
    return navigator.onLine ? 'good' : 'poor';
  }
}

export async function requestCameraPermission(): Promise<PermissionState> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } },
    });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

export async function requestMicrophonePermission(): Promise<PermissionState> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

export async function requestScreenPermission(): Promise<PermissionState> {
  if (!navigator.mediaDevices?.getDisplayMedia) return 'unsupported';
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 5, max: 10 } },
    });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

export async function startCameraStream(): Promise<MediaStream | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 480, max: 640 }, height: { ideal: 360, max: 480 }, frameRate: { ideal: 15, max: 20 } },
    });
  } catch {
    return null;
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  if (stream) {
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // Ignore already-stopped tracks
      }
    });
  }
}

export async function captureFrame(video: HTMLVideoElement, maxWidth = 480): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.72);
  });
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

const avatarColors = [
  '#3366f0', '#059669', '#d97706', '#dc2626', '#7c3aed',
  '#0891b2', '#db2777', '#2563eb',
];

export function pickAvatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return avatarColors[Math.abs(hash) % avatarColors.length];
}

export function isQuestionAnswered(val: number | number[] | string | undefined | null): boolean {
  if (val === undefined || val === null) return false;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'string') return val.trim().length > 0;
  return true;
}
