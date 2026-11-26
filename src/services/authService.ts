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
  if (password.length < 8) errors.push('At least 8 characters');
  if (!/[A-Z]/.test(password)) errors.push('One uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('One lowercase letter');
  if (!/\d/.test(password)) errors.push('One number');

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

function deriveNameFromEmail(email: string, role: Role): string {
  const base = email
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  if (role === 'teacher' && !/^prof\b/i.test(base)) {
    return `Prof. ${base || 'Faculty'}`;
  }
  return base || 'Student';
}

function mapProfileToUser(p: ServerProfile): User {
  const portalRole: Role = p.role === 'teacher' || p.role === 'admin' ? 'teacher' : 'student';
  return {
    id: p.id,
    email: p.email,
    name: p.full_name?.trim() || deriveNameFromEmail(p.email, portalRole),
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      throw new AppError('INVALID_INPUT', 'Please enter a valid email address.');
    }
    if (password.length < 6) {
      throw new AppError('INVALID_INPUT', 'Password must be at least 6 characters long.');
    }

    checkLoginRateLimit(normalizedEmail);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (error || !data.user) {
      const errCode = String((error as { code?: string } | null)?.code ?? '');
      const msg = error?.message ?? '';

      // First-time sign-in check: if this email has never been registered, bind it permanently
      // to this password & portal role (works on both Supabase Cloud and local PGlite).
      let provData: { created?: boolean; exists?: boolean; mode?: string } | null = null;
      try {
        const provRes = await supabase.rpc('provision_portal_account', {
          p_email: normalizedEmail,
          p_password: password,
          p_full_name: deriveNameFromEmail(normalizedEmail, expectedRole),
          p_portal_role: expectedRole,
        });
        provData = (provRes.data as { created?: boolean; exists?: boolean; mode?: string } | null) ?? null;
      } catch {
        provData = null;
      }

      if (provData?.created) {
        const { data: retryData, error: retryErr } = await supabase.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
        if (retryErr || !retryData.user) {
          recordLoginFailure(normalizedEmail);
          throw new AppError(
            'INVALID_CREDENTIALS',
            retryErr?.message || 'Unable to sign in. Please verify your email and password.'
          );
        }
      } else if (
        !provData?.exists &&
        (provData?.mode === 'local_signup' || errCode === 'user_not_found' || /user account not found/i.test(msg))
      ) {
        const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: {
              full_name: deriveNameFromEmail(normalizedEmail, expectedRole),
              portal_role: expectedRole,
            },
          },
        });

        if (signUpErr || !signUpData.session) {
          recordLoginFailure(normalizedEmail);
          throw new AppError(
            'INVALID_CREDENTIALS',
            signUpErr?.message || 'Unable to sign in. Please verify your email and password.'
          );
        }
      } else {
        recordLoginFailure(normalizedEmail);
        if (/Email not confirmed/i.test(msg)) {
          throw new AppError(
            'EMAIL_UNVERIFIED',
            'Please verify your email address using the confirmation link sent to your inbox before signing in.'
          );
        }
        if (/rate limit|too many/i.test(msg)) {
          throw new AppError('RATE_LIMITED', 'Too many login attempts. Please wait a moment and try again.');
        }
        throw new AppError(
          'INVALID_CREDENTIALS',
          'Invalid email or password. Please enter the exact password registered for this account.'
        );
      }
    }

    const { data: profData, error: profErr } = await supabase.rpc('get_my_profile');
    if (profErr || !profData) {
      await supabase.auth.signOut({ scope: 'local' });
      throw toAppError(profErr, 'Account profile could not be verified.');
    }

    const user = mapProfileToUser(profData as ServerProfile);

    // Strict server-side RBAC enforcement per portal
    if (expectedRole === 'teacher' && user.role !== 'teacher') {
      await supabase.auth.signOut({ scope: 'local' });
      throw new AppError(
        'FORBIDDEN',
        'Access denied: this email is registered as a Student account and does not have faculty privileges.'
      );
    }

    if (expectedRole === 'student' && user.role !== 'student') {
      await supabase.auth.signOut({ scope: 'local' });
      throw new AppError(
        'ROLE_MISMATCH',
        'This email is registered as a Faculty account. Please sign in through the Teacher Portal.'
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
  }): Promise<{ requiresEmailVerification: boolean; user: User | null }> {
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
          portal_role: params.requestedRole,
          institution: params.institution?.trim() ?? '',
        },
      },
    });

    if (error) {
      if (/already registered|already_exists/i.test(error.message)) {
        throw new AppError('ALREADY_EXISTS', 'An account with this email already exists. Please sign in with your password.');
      }
      if (/rate limit/i.test(error.message)) {
        throw new AppError('RATE_LIMITED', 'Too many registration requests. Please wait before trying again.');
      }
      throw new AppError('REGISTER_FAILED', 'Registration could not be completed. Please verify your details and try again.');
    }

    const requiresEmailVerification = !data.session;
    let user: User | null = null;
    if (data.session) {
      user = await this.fetchCurrentUser();
    }

    return { requiresEmailVerification, user };
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
