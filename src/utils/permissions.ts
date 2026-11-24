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

export async function checkInternetSpeed(): Promise<'good' | 'poor'> {
  const start = performance.now();
  try {
    await fetch('https://www.gstatic.com/generate_204', { mode: 'no-cors', cache: 'no-store' })
      .catch(() => {});
    const elapsed = performance.now() - start;
    return elapsed < 500 ? 'good' : 'poor';
  } catch {
    return 'poor';
  }
}

export async function requestCameraPermission(): Promise<PermissionState> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

export async function requestMicrophonePermission(): Promise<PermissionState> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

export async function requestScreenPermission(): Promise<PermissionState> {
  if (!navigator.mediaDevices?.getDisplayMedia) return 'unsupported';
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch {
    return 'denied';
  }
}

export async function startCameraStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true });
  } catch {
    return null;
  }
}

export function stopStream(stream: MediaStream | null): void {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

export function captureFrame(video: HTMLVideoElement): Blob | null {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 320;
  canvas.height = video.videoHeight || 240;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.8);
  }) as unknown as Blob | null;
}

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
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
