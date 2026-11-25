import { supabase, isSupabaseConfigured, AppError, toAppError } from '@/lib/supabase';
import type { AccountRole, Role, User } from '@/types';
import { pickAvatarColor } from '@/utils/permissions';

const LOCKOUT_STORAGE_KEY = 'smartexam.auth.attempts';

interface AttemptRecord {
  count: number;
  lockedUntil: number;
  lastAttemptAt: number;
}

export interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

export function validateStrongPassword(password: string, email = ''): PasswordValidation {
  const errors: string[] = [];
  if (password.length < 10) errors.push('At least 10 characters');
  if (!/[A-Z]/.test(password)) errors.push('One uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('One lowercase letter');
  if (!/\d/.test(password)) errors.push('One number');
  if (!/[^A-Za-z0-9\s]/.test(password)) errors.push('One special symbol (!@#$…)');

  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
    errors.push('Must not contain your email username');
  }

  return { valid: errors.length === 0, errors };
}

function readAttemptMap(): Record<string, AttemptRecord> {
  try {
    const raw = sessionStorage.getItem(LOCKOUT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, AttemptRecord>) : {};
  } catch {
    return {};
  }
}

function writeAttemptMap(map: Record<string, AttemptRecord>): void {
  try {
    sessionStorage.setItem(LOCKOUT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota errors
  }
}

export function checkLoginRateLimit(email: string): void {
  const key = email.trim().toLowerCase() || '__global__';
  const map = readAttemptMap();
  const rec = map[key];
  if (!rec) return;

  // Reset counter if idle for > 15 minutes
  if (Date.now() - rec.lastAttemptAt > 15 * 60 * 1000 && Date.now() > rec.lockedUntil) {
    delete map[key];
    writeAttemptMap(map);
    return;
  }

  if (rec.lockedUntil > Date.now()) {
    const secs = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    throw new AppError(
      'RATE_LIMITED',
      `Too many sign-in attempts. Please wait ${secs} second${secs === 1 ? '' : 's'} before trying again.`
    );
  }
}

function recordLoginFailure(email: string): void {
  const key = email.trim().toLowerCase() || '__global__';
  const map = readAttemptMap();
  const prev = map[key] ?? { count: 0, lockedUntil: 0, lastAttemptAt: 0 };
  const count = prev.count + 1;

  let cooldownMs = 0;
  if (count >= 10) cooldownMs = 5 * 60 * 1000;
  else if (count >= 7) cooldownMs = 90 * 1000;
  else if (count >= 5) cooldownMs = 30 * 1000;

  map[key] = {
    count,
    lockedUntil: cooldownMs > 0 ? Date.now() + cooldownMs : 0,
    lastAttemptAt: Date.now(),
  };
  writeAttemptMap(map);
}

export function clearLoginFailures(email: string): void {
  const key = email.trim().toLowerCase() || '__global__';
  const map = readAttemptMap();
  delete map[key];
  writeAttemptMap(map);
}

interface ServerProfile {
  id: string;
  email: string;
  full_name: string;
  role: AccountRole;
  teacher_request_status: 'pending' | 'approved' | 'rejected' | null;
}

function mapProfileToUser(p: ServerProfile): User {
  const portalRole: Role = p.role === 'teacher' || p.role === 'admin' ? 'teacher' : 'student';
  const fallbackName = p.email
    .split('@')[0]
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    id: p.id,
    email: p.email,
    name: p.full_name?.trim() || fallbackName,
    role: portalRole,
    accountRole: p.role,
    teacherRequestStatus: p.teacher_request_status,
    avatarColor: pickAvatarColor(p.email),
  };
}

function ensureConfigured(): void {
  if (!isSupabaseConfigured) {
    throw new AppError(
      'CONFIG_MISSING',
      'Authentication service is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.'
    );
  }
}

export const authService = {
  async fetchCurrentUser(): Promise<User | null> {
    if (!isSupabaseConfigured) return null;
    const { data: sessionRes, error: sessErr } = await supabase.auth.getSession();
    if (sessErr || !sessionRes.session?.user) return null;

    const { data, error } = await supabase.rpc('get_my_profile');
    if (error || !data) {
      return null;
    }
    return mapProfileToUser(data as ServerProfile);
  },

  async signIn(email: string, password: string, expectedRole: Role): Promise<User> {
    ensureConfigured();
    const normalizedEmail = email.trim().toLowerCase();
    checkLoginRateLimit(normalizedEmail);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (error || !data.user) {
      recordLoginFailure(normalizedEmail);
      const msg = error?.message ?? '';
      if (/Email not confirmed/i.test(msg)) {
        throw new AppError(
          'EMAIL_UNVERIFIED',
          'Please verify your email address using the confirmation link sent to your inbox before signing in.'
        );
      }
      if (/rate limit|too many/i.test(msg)) {
        throw new AppError('RATE_LIMITED', 'Too many login attempts. Please wait a moment and try again.');
      }
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password. Please verify your credentials and try again.');
    }

    const { data: profData, error: profErr } = await supabase.rpc('get_my_profile');
    if (profErr || !profData) {
      await supabase.auth.signOut({ scope: 'local' });
      throw toAppError(profErr, 'Account profile could not be verified. Ensure database migrations have been applied.');
    }

    const user = mapProfileToUser(profData as ServerProfile);

    // Strict server-side RBAC enforcement per portal
    if (expectedRole === 'teacher' && user.role !== 'teacher') {
      await supabase.auth.signOut({ scope: 'local' });
      if (user.teacherRequestStatus === 'pending') {
        throw new AppError(
          'TEACHER_PENDING_APPROVAL',
          'Your faculty account request is awaiting administrator approval. You cannot access the Teacher Portal yet.'
        );
      }
      throw new AppError(
        'FORBIDDEN',
        'Access denied: this account does not have faculty privileges.'
      );
    }

    if (expectedRole === 'student' && user.role !== 'student') {
      await supabase.auth.signOut({ scope: 'local' });
      throw new AppError(
        'ROLE_MISMATCH',
        'This is a faculty/administrator account. Please sign in through the Teacher Portal.'
      );
    }

    clearLoginFailures(normalizedEmail);
    return user;
  },

  async register(params: {
    email: string;
    password: string;
    fullName: string;
    requestedRole: Role;
    institution?: string;
  }): Promise<{ requiresEmailVerification: boolean; pendingTeacherApproval: boolean; user: User | null }> {
    ensureConfigured();
    const normalizedEmail = params.email.trim().toLowerCase();
    const cleanName = params.fullName.trim();

    if (cleanName.length < 2) {
      throw new AppError('INVALID_INPUT', 'Please enter your full name.');
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      throw new AppError('INVALID_INPUT', 'Please enter a valid email address.');
    }

    const pwCheck = validateStrongPassword(params.password, normalizedEmail);
    if (!pwCheck.valid) {
      throw new AppError('WEAK_PASSWORD', `Password requirements: ${pwCheck.errors.join(', ')}.`);
    }

    const { data, error } = await supabase.auth.signUp({
      email: normalizedEmail,
      password: params.password,
      options: {
        emailRedirectTo: `${window.location.origin}/`,
        data: {
          full_name: cleanName,
          // Role is NEVER trusted on the server; `requested_role: 'teacher'` only opens a pending request.
          requested_role: params.requestedRole,
          institution: params.institution?.trim() ?? '',
        },
      },
    });

    if (error) {
      if (/already registered/i.test(error.message)) {
        throw new AppError('ALREADY_EXISTS', 'An account with this email already exists. Please sign in instead.');
      }
      if (/rate limit/i.test(error.message)) {
        throw new AppError('RATE_LIMITED', 'Too many registration requests. Please wait before trying again.');
      }
      throw new AppError('REGISTER_FAILED', 'Registration could not be completed. Please verify your details and try again.');
    }

    const requiresEmailVerification = !data.session;
    const pendingTeacherApproval = params.requestedRole === 'teacher';

    if (data.session && pendingTeacherApproval) {
      // Do not keep a newly registered unapproved teacher logged in on the Teacher Portal
      await supabase.auth.signOut({ scope: 'local' });
      return { requiresEmailVerification, pendingTeacherApproval: true, user: null };
    }

    let user: User | null = null;
    if (data.session) {
      user = await this.fetchCurrentUser();
    }

    return { requiresEmailVerification, pendingTeacherApproval, user };
  },

  async resendVerificationEmail(email: string): Promise<void> {
    ensureConfigured();
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    if (error) {
      throw new AppError('RESEND_FAILED', 'Could not resend verification email right now. Please wait a minute and try again.');
    }
  },

  async requestPasswordReset(email: string): Promise<void> {
    ensureConfigured();
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      throw new AppError('INVALID_INPUT', 'Please enter a valid email address.');
    }
    const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error && /rate limit/i.test(error.message)) {
      throw new AppError('RATE_LIMITED', 'Too many reset requests. Please try again shortly.');
    }
  },

  async completePasswordReset(newPassword: string, emailHint = ''): Promise<void> {
    ensureConfigured();
    const pwCheck = validateStrongPassword(newPassword, emailHint);
    if (!pwCheck.valid) {
      throw new AppError('WEAK_PASSWORD', `Password requirements: ${pwCheck.errors.join(', ')}.`);
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      throw new AppError('RESET_FAILED', 'Could not update password. Your reset link may have expired.');
    }
  },

  async signOut(): Promise<void> {
    if (!isSupabaseConfigured) return;
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  },

  async listTeacherRequests(status: 'pending' | 'approved' | 'rejected' = 'pending'): Promise<
    Array<{
      id: string;
      user_id: string;
      email: string;
      full_name: string;
      institution: string;
      status: string;
      created_at: string;
    }>
  > {
    const { data, error } = await supabase.rpc('admin_list_teacher_requests', { p_status: status });
    if (error) throw toAppError(error);
    return (data ?? []) as Array<{
      id: string;
      user_id: string;
      email: string;
      full_name: string;
      institution: string;
      status: string;
      created_at: string;
    }>;
  },

  async reviewTeacherRequest(requestId: string, approve: boolean): Promise<void> {
    const { error } = await supabase.rpc('admin_review_teacher_request', {
      p_request_id: requestId,
      p_approve: approve,
    });
    if (error) throw toAppError(error);
  },
};
