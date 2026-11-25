import { createClient } from '@supabase/supabase-js';

const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const supabaseAnonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

export const isSupabaseConfigured =
  Boolean(supabaseUrl) &&
  Boolean(supabaseAnonKey) &&
  !supabaseUrl.includes('your-project-ref');

// Guard against accidentally placing a service_role JWT in a VITE_ variable
function assertNotServiceRole(jwt: string): void {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string };
    if (payload.role === 'service_role') {
      throw new Error('SECURITY VIOLATION: Never configure a Supabase service_role key in client env.');
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SECURITY VIOLATION')) {
      throw err;
    }
  }
}

assertNotServiceRole(supabaseAnonKey);

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.invalid',
  supabaseAnonKey || 'public-anon-placeholder',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'smartexam.auth.session',
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  }
);

export class AppError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

const SAFE_ERROR_CODES = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'PROFILE_MISSING',
  'RATE_LIMITED',
  'INVALID_INPUT',
  'INVALID_CODE',
  'EXAM_EXPIRED',
  'EXAM_NOT_STARTED',
  'EXAM_UNAVAILABLE',
  'EXAM_EMPTY',
  'NOT_ASSIGNED',
  'CONSENT_REQUIRED',
  'ATTEMPTS_EXHAUSTED',
  'SESSION_EXPIRED',
  'NOT_FOUND',
  'CONFLICT',
]);

export function toAppError(err: unknown, fallbackMessage = 'Unable to complete the request. Please try again.'): AppError {
  if (err instanceof AppError) return err;
  if (err && typeof err === 'object') {
    const rec = err as { code?: string; hint?: string; message?: string };
    const hint = String(rec.hint ?? '').trim();
    const msg = String(rec.message ?? '').trim();
    if (SAFE_ERROR_CODES.has(hint) && msg) {
      return new AppError(hint, redactSecrets(msg));
    }
    if (rec.code === 'P0001' && msg) {
      return new AppError(hint || 'VALIDATION_ERROR', redactSecrets(msg));
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return new AppError('NETWORK_ERROR', 'Network connection unavailable. Check your internet connection and try again.');
    }
    if (/JWT expired|invalid JWT|Auth session missing/i.test(msg)) {
      return new AppError('SESSION_EXPIRED_AUTH', 'Your sign-in session has expired. Please sign in again.');
    }
  }
  return new AppError('INTERNAL_ERROR', fallbackMessage);
}

export function redactSecrets(input: string): string {
  return input
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/(apikey|authorization|password|secret)=([^\s&]+)/gi, '$1=[REDACTED]');
}
