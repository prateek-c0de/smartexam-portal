/*
# SmartExam security foundation — authentication profiles & RBAC

Non-destructive, versioned migration. No user data is deleted.

1. Removes every unrestricted `TO anon, authenticated USING (true) / WITH CHECK (true)`
   policy created by the original schema. RLS stays enabled; new least-privilege
   policies are created in this and the following migrations.
2. Adds `profiles` (1:1 with auth.users). The role is ALWAYS `student` on sign-up.
   Teacher access requires an approved `teacher_requests` row (trusted provisioning).
   Roles can only be changed by an admin through `admin_review_teacher_request`
   or by the database owner (SQL editor / service role).
3. Adds `audit_logs` and a generic fixed-window `rate_limits` table used by RPCs.
4. Adds SECURITY DEFINER helpers (`current_app_role`, `is_teacher`, `is_admin`)
   that read the server-side profile (never user-editable JWT metadata).
*/

-- ---------------------------------------------------------------------------
-- 0. Drop the original permissive policies (policies only — data untouched)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "anon_select_exams" ON public.exams;
DROP POLICY IF EXISTS "anon_insert_exams" ON public.exams;
DROP POLICY IF EXISTS "anon_update_exams" ON public.exams;
DROP POLICY IF EXISTS "anon_delete_exams" ON public.exams;
DROP POLICY IF EXISTS "anon_select_questions" ON public.questions;
DROP POLICY IF EXISTS "anon_insert_questions" ON public.questions;
DROP POLICY IF EXISTS "anon_update_questions" ON public.questions;
DROP POLICY IF EXISTS "anon_delete_questions" ON public.questions;
DROP POLICY IF EXISTS "anon_select_sessions" ON public.exam_sessions;
DROP POLICY IF EXISTS "anon_insert_sessions" ON public.exam_sessions;
DROP POLICY IF EXISTS "anon_update_sessions" ON public.exam_sessions;
DROP POLICY IF EXISTS "anon_delete_sessions" ON public.exam_sessions;
DROP POLICY IF EXISTS "anon_select_answers" ON public.student_answers;
DROP POLICY IF EXISTS "anon_insert_answers" ON public.student_answers;
DROP POLICY IF EXISTS "anon_update_answers" ON public.student_answers;
DROP POLICY IF EXISTS "anon_delete_answers" ON public.student_answers;
DROP POLICY IF EXISTS "anon_select_events" ON public.proctoring_events;
DROP POLICY IF EXISTS "anon_insert_events" ON public.proctoring_events;
DROP POLICY IF EXISTS "anon_update_events" ON public.proctoring_events;
DROP POLICY IF EXISTS "anon_delete_events" ON public.proctoring_events;

-- The anonymous role never needs direct table access in SmartExam.
REVOKE ALL ON public.exams, public.questions, public.exam_sessions,
  public.student_answers, public.proctoring_events FROM anon;

-- All writes go through validated SECURITY DEFINER RPCs (prevents mass assignment).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.exams, public.questions,
  public.exam_sessions, public.student_answers, public.proctoring_events FROM authenticated;

-- ---------------------------------------------------------------------------
-- 1. Profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '' CHECK (char_length(full_name) <= 120),
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profiles_email_lower ON public.profiles (lower(email));
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles (role);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.teacher_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  institution text NOT NULL DEFAULT '' CHECK (char_length(institution) <= 200),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_teacher_requests_status ON public.teacher_requests (status, created_at);
ALTER TABLE public.teacher_requests ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Audit log & rate limiting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid,
  action text NOT NULL CHECK (char_length(action) <= 80),
  entity_type text NOT NULL CHECK (char_length(entity_type) <= 40),
  entity_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs (actor_id, created_at DESC);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;  -- no policies: RPC-only

REVOKE ALL ON public.profiles, public.teacher_requests, public.audit_logs, public.rate_limits FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.profiles, public.teacher_requests,
  public.audit_logs, public.rate_limits FROM authenticated;
REVOKE SELECT ON public.rate_limits FROM authenticated;
-- Users may only edit their display name (column privilege) — never role/email.
GRANT UPDATE (full_name) ON public.profiles TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Internal helpers
-- ---------------------------------------------------------------------------
-- Raise a client-safe error. `code` is machine-readable (returned as hint).
CREATE OR REPLACE FUNCTION public._raise(p_code text, p_message text)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION USING MESSAGE = p_message, HINT = p_code, ERRCODE = 'P0001';
END $$;

CREATE OR REPLACE FUNCTION public._audit(p_action text, p_entity_type text, p_entity_id uuid, p_details jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, details)
  VALUES (auth.uid(), p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

-- Fixed-window rate limiter. Raises RATE_LIMITED when exceeded.
CREATE OR REPLACE FUNCTION public._rate_limit(p_bucket text, p_max integer, p_window_seconds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_window timestamptz := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
BEGIN
  INSERT INTO public.rate_limits (bucket, window_start, hits)
  VALUES (p_bucket, v_window, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = public.rate_limits.hits + 1
  RETURNING hits INTO v_hits;
  IF v_hits > p_max THEN
    PERFORM public._raise('RATE_LIMITED', 'Too many requests. Please wait a moment and try again.');
  END IF;
  -- opportunistic cleanup of stale windows
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limits WHERE window_start < now() - interval '1 day';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.role FROM public.profiles p WHERE p.id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_teacher()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('teacher', 'admin'));
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin');
$$;

CREATE OR REPLACE FUNCTION public._require_user()
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v uuid := auth.uid();
BEGIN
  IF v IS NULL THEN PERFORM public._raise('UNAUTHENTICATED', 'You must be signed in.'); END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public._require_teacher()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v uuid := public._require_user();
BEGIN
  IF NOT public.is_teacher() THEN PERFORM public._raise('FORBIDDEN', 'Teacher access is required.'); END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public._require_student()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v uuid := public._require_user();
BEGIN
  IF coalesce(public.current_app_role(), '') <> 'student' THEN
    PERFORM public._raise('FORBIDDEN', 'Only student accounts can take examinations.');
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public._clean_text(p text, p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  -- strip control characters (except tab/newline) and trim to max length
  SELECT left(btrim(regexp_replace(coalesce(p, ''), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), p_max);
$$;

-- ---------------------------------------------------------------------------
-- 4. Profile provisioning triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_name text := public._clean_text(NEW.raw_user_meta_data ->> 'full_name', 120);
BEGIN
  -- Role is never taken from client-supplied metadata.
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (NEW.id, lower(coalesce(NEW.email, '')), v_name, 'student')
  ON CONFLICT (id) DO NOTHING;

  IF NEW.raw_user_meta_data ->> 'requested_role' = 'teacher' THEN
    INSERT INTO public.teacher_requests (user_id, institution)
    VALUES (NEW.id, public._clean_text(NEW.raw_user_meta_data ->> 'institution', 200))
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_user_email_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles SET email = lower(coalesce(NEW.email, '')), updated_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
CREATE TRIGGER on_auth_user_email_changed AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_email_change();

-- Defense in depth: block role/email changes from API roles even if grants change.
CREATE OR REPLACE FUNCTION public.guard_profile_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.role IS DISTINCT FROM OLD.role OR NEW.email IS DISTINCT FROM OLD.email OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION USING MESSAGE = 'Profile role and email cannot be changed by users.', HINT = 'FORBIDDEN';
    END IF;
  END IF;
  NEW.full_name := public._clean_text(NEW.full_name, 120);
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_profile_update ON public.profiles;
CREATE TRIGGER trg_guard_profile_update BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_update();

-- Backfill profiles for users that existed before this migration.
INSERT INTO public.profiles (id, email, full_name, role)
SELECT u.id, lower(coalesce(u.email, '')), public._clean_text(u.raw_user_meta_data ->> 'full_name', 120), 'student'
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. RLS policies
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select_own_or_admin" ON public.profiles;
CREATE POLICY "profiles_select_own_or_admin" ON public.profiles FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()) OR (SELECT public.is_admin()));

DROP POLICY IF EXISTS "profiles_update_own_name" ON public.profiles;
CREATE POLICY "profiles_update_own_name" ON public.profiles FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "teacher_requests_select_own_or_admin" ON public.teacher_requests;
CREATE POLICY "teacher_requests_select_own_or_admin" ON public.teacher_requests FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.is_admin()));

DROP POLICY IF EXISTS "audit_logs_admin_select" ON public.audit_logs;
CREATE POLICY "audit_logs_admin_select" ON public.audit_logs FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- ---------------------------------------------------------------------------
-- 6. RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uid uuid := public._require_user(); v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'id', p.id, 'email', p.email, 'full_name', p.full_name, 'role', p.role,
    'teacher_request_status', tr.status
  ) INTO v
  FROM public.profiles p LEFT JOIN public.teacher_requests tr ON tr.user_id = p.id
  WHERE p.id = v_uid;
  IF v IS NULL THEN PERFORM public._raise('PROFILE_MISSING', 'Your account profile could not be found.'); END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.update_my_name(p_full_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uid uuid := public._require_user(); v_name text := public._clean_text(p_full_name, 120);
BEGIN
  IF char_length(v_name) < 2 THEN PERFORM public._raise('INVALID_INPUT', 'Please enter your full name.'); END IF;
  UPDATE public.profiles SET full_name = v_name WHERE id = v_uid;
  RETURN public.get_my_profile();
END $$;

CREATE OR REPLACE FUNCTION public.admin_list_teacher_requests(p_status text DEFAULT 'pending')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._require_user();
  IF NOT public.is_admin() THEN PERFORM public._raise('FORBIDDEN', 'Administrator access is required.'); END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', tr.id, 'user_id', tr.user_id, 'email', p.email, 'full_name', p.full_name,
      'institution', tr.institution, 'status', tr.status, 'created_at', tr.created_at
    ) ORDER BY tr.created_at)
    FROM public.teacher_requests tr JOIN public.profiles p ON p.id = tr.user_id
    WHERE p_status IS NULL OR tr.status = p_status
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.admin_review_teacher_request(p_request_id uuid, p_approve boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uid uuid := public._require_user(); v_req public.teacher_requests;
BEGIN
  IF NOT public.is_admin() THEN PERFORM public._raise('FORBIDDEN', 'Administrator access is required.'); END IF;
  SELECT * INTO v_req FROM public.teacher_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._raise('NOT_FOUND', 'Teacher request not found.'); END IF;
  UPDATE public.teacher_requests
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         reviewed_by = v_uid, reviewed_at = now()
   WHERE id = p_request_id;
  -- Runs as the function owner, so the profile guard trigger allows the role change.
  UPDATE public.profiles
     SET role = CASE WHEN p_approve THEN 'teacher' ELSE 'student' END
   WHERE id = v_req.user_id AND role <> 'admin';
  PERFORM public._audit(CASE WHEN p_approve THEN 'teacher.approve' ELSE 'teacher.reject' END,
                        'profile', v_req.user_id, '{}'::jsonb);
  RETURN jsonb_build_object('id', p_request_id, 'status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END $$;

-- Allow an existing student to request teacher access later.
CREATE OR REPLACE FUNCTION public.request_teacher_access(p_institution text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uid uuid := public._require_user();
BEGIN
  PERFORM public._rate_limit('teacher_req:' || v_uid::text, 3, 3600);
  INSERT INTO public.teacher_requests (user_id, institution)
  VALUES (v_uid, public._clean_text(p_institution, 200))
  ON CONFLICT (user_id) DO UPDATE SET status = 'pending', institution = EXCLUDED.institution,
     reviewed_by = NULL, reviewed_at = NULL, created_at = now()
  WHERE public.teacher_requests.status = 'rejected';
  RETURN public.get_my_profile();
END $$;
