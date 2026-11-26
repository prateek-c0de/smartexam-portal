/*
# Free Cloud Storage Recordings (`proctoring-recordings`), Snapshot Evidence & Cloud Portal Provisioning

1. Enables `capture_evidence: true` by default in `default_proctoring_config()` so AI proctoring
   camera snapshots automatically persist to the private `proctoring-evidence` Supabase Storage bucket.
2. Creates `public.proctoring_recordings` table + private `proctoring-recordings` Supabase Storage
   bucket (up to 50 MB per clip, `video/webm`, `audio/webm`, `video/mp4`) so Live Peek camera &
   microphone recordings save permanently in cloud storage with signed playback URLs.
3. Adds `public.provision_portal_account` so first-time student/faculty logins on Supabase Cloud
   bind their email + bcrypt password immediately without hitting free-tier 2-emails/hour SMTP limits,
   while existing accounts strictly enforce their registered password and role.
*/

-- 1. Enable cloud evidence snapshot capture by default
CREATE OR REPLACE FUNCTION public.default_proctoring_config()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT '{
    "require_camera": true,
    "require_microphone": true,
    "require_screen": true,
    "capture_evidence": true,
    "face_detection": true,
    "object_detection": true,
    "audio_monitoring": true,
    "weights": {
      "tab_switch": 5, "window_blur": 2, "fullscreen_exit": 3, "face_not_detected": 10,
      "multiple_faces": 15, "camera_obstructed": 8, "phone_detected": 20, "prohibited_object": 10,
      "voice_activity": 5, "audio_anomaly": 2, "copy_paste": 3, "screen_share_ended": 5,
      "page_reload": 1, "camera_interrupted": 0, "mic_interrupted": 0, "network_offline": 0,
      "network_restored": 0, "monitoring_error": 0
    },
    "thresholds": { "moderate": 15, "high": 40 },
    "min_confidence": {
      "multiple_faces": 0.35, "phone_detected": 0.32, "prohibited_object": 0.38,
      "voice_activity": 0.5, "face_not_detected": 0, "camera_obstructed": 0.65
    },
    "cooldown_seconds": {
      "default": 15, "tab_switch": 3, "window_blur": 10, "fullscreen_exit": 5,
      "face_not_detected": 15, "multiple_faces": 12, "phone_detected": 12,
      "prohibited_object": 25, "voice_activity": 30, "audio_anomaly": 45, "copy_paste": 10
    },
    "sustain_seconds": {
      "face_not_detected": 3, "multiple_faces": 1, "phone_detected": 1,
      "prohibited_object": 2, "voice_activity": 4, "camera_obstructed": 2
    }
  }'::jsonb;
$$;

-- 2. Cloud recordings metadata table
CREATE TABLE IF NOT EXISTS public.proctoring_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.exam_sessions(id) ON DELETE CASCADE,
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  storage_path text NOT NULL CHECK (char_length(storage_path) BETWEEN 5 AND 300 AND storage_path !~ '\.\.'),
  mime_type text NOT NULL DEFAULT 'video/webm' CHECK (mime_type IN ('video/webm', 'audio/webm', 'video/mp4')),
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds BETWEEN 0 AND 7200),
  size_bytes integer NOT NULL DEFAULT 0 CHECK (size_bytes BETWEEN 0 AND 52428800),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proctoring_recordings_session ON public.proctoring_recordings (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proctoring_recordings_exam ON public.proctoring_recordings (exam_id);
CREATE INDEX IF NOT EXISTS idx_proctoring_recordings_recorded_by ON public.proctoring_recordings (recorded_by);

ALTER TABLE public.proctoring_recordings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.proctoring_recordings FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.proctoring_recordings FROM authenticated;
GRANT SELECT ON public.proctoring_recordings TO authenticated;

DROP POLICY IF EXISTS "recordings_teacher_select_row" ON public.proctoring_recordings;
CREATE POLICY "recordings_teacher_select_row" ON public.proctoring_recordings
  FOR SELECT TO authenticated
  USING (
    (SELECT public.owns_exam(exam_id))
    OR (
      (SELECT public.is_teacher())
      AND EXISTS (
        SELECT 1 FROM public.exam_sessions s
         WHERE s.id = session_id AND s.status = 'in_progress'
      )
    )
  );

CREATE OR REPLACE FUNCTION public.teacher_register_recording(
  p_session_id uuid,
  p_storage_path text,
  p_mime_type text DEFAULT 'video/webm',
  p_duration_seconds integer DEFAULT 0,
  p_size_bytes integer DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_teacher();
  s public.exam_sessions;
  v_rec public.proctoring_recordings;
  v_mime text := CASE WHEN p_mime_type IN ('video/webm', 'audio/webm', 'video/mp4') THEN p_mime_type ELSE 'video/webm' END;
BEGIN
  PERFORM public._rate_limit('reg_rec:' || v_uid::text, 30, 60);
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN PERFORM public._raise('NOT_FOUND', 'Session not found.'); END IF;

  IF NOT (public.owns_exam(s.exam_id) OR s.status = 'in_progress') THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to record this session.');
  END IF;

  IF p_storage_path IS NULL
     OR p_storage_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]+$'
     OR split_part(p_storage_path, '/', 1)::uuid <> s.exam_id
     OR split_part(p_storage_path, '/', 2)::uuid <> s.id THEN
    PERFORM public._raise('INVALID_INPUT', 'Invalid cloud storage recording path.');
  END IF;

  INSERT INTO public.proctoring_recordings (
    session_id, exam_id, recorded_by, storage_path, mime_type, duration_seconds, size_bytes
  ) VALUES (
    s.id, s.exam_id, v_uid, p_storage_path, v_mime,
    least(greatest(coalesce(p_duration_seconds, 0), 0), 7200),
    least(greatest(coalesce(p_size_bytes, 0), 0), 52428800)
  ) RETURNING * INTO v_rec;

  PERFORM public._audit('proctoring.recording_saved', 'exam_session', s.id,
    jsonb_build_object('recording_id', v_rec.id, 'size_bytes', v_rec.size_bytes));
  RETURN to_jsonb(v_rec);
END $$;

CREATE OR REPLACE FUNCTION public.teacher_list_session_recordings(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.exam_sessions;
BEGIN
  PERFORM public._require_teacher();
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN PERFORM public._raise('NOT_FOUND', 'Session not found.'); END IF;
  IF NOT (public.owns_exam(s.exam_id) OR s.status = 'in_progress') THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to view recordings for this session.');
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(to_jsonb(pr) ORDER BY pr.created_at DESC)
      FROM public.proctoring_recordings pr
     WHERE pr.session_id = s.id
  ), '[]'::jsonb);
END $$;

-- 3. Provision private `proctoring-recordings` & `proctoring-evidence` buckets in Supabase Cloud Storage
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'proctoring-recordings',
      'proctoring-recordings',
      false,
      52428800,
      ARRAY['video/webm', 'audio/webm', 'video/mp4']
    )
    ON CONFLICT (id) DO UPDATE
      SET public = false,
          file_size_limit = 52428800,
          allowed_mime_types = ARRAY['video/webm', 'audio/webm', 'video/mp4'];

    EXECUTE 'DROP POLICY IF EXISTS "evidence_teacher_read" ON storage.objects';
    EXECUTE $pol$
      CREATE POLICY "evidence_teacher_read" ON storage.objects FOR SELECT TO authenticated
      USING (
        bucket_id = 'proctoring-evidence'
        AND split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
        AND split_part(name, '/', 2) ~* '^[0-9a-f-]{36}$'
        AND (
          (SELECT public.owns_exam(split_part(name, '/', 1)::uuid))
          OR (
            (SELECT public.is_teacher())
            AND EXISTS (
              SELECT 1 FROM public.exam_sessions s
               WHERE s.id = split_part(name, '/', 2)::uuid AND s.status = 'in_progress'
            )
          )
        )
      )
    $pol$;

    EXECUTE 'DROP POLICY IF EXISTS "recordings_teacher_insert" ON storage.objects';
    EXECUTE $pol$
      CREATE POLICY "recordings_teacher_insert" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'proctoring-recordings'
        AND (SELECT public.is_teacher())
        AND split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
        AND split_part(name, '/', 2) ~* '^[0-9a-f-]{36}$'
        AND EXISTS (
          SELECT 1 FROM public.exam_sessions s
           WHERE s.id = split_part(name, '/', 2)::uuid
             AND s.exam_id = split_part(name, '/', 1)::uuid
             AND ((SELECT public.owns_exam(s.exam_id)) OR s.status = 'in_progress')
        )
      )
    $pol$;

    EXECUTE 'DROP POLICY IF EXISTS "recordings_teacher_select" ON storage.objects';
    EXECUTE $pol$
      CREATE POLICY "recordings_teacher_select" ON storage.objects FOR SELECT TO authenticated
      USING (
        bucket_id = 'proctoring-recordings'
        AND (SELECT public.is_teacher())
        AND split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
        AND split_part(name, '/', 2) ~* '^[0-9a-f-]{36}$'
        AND EXISTS (
          SELECT 1 FROM public.exam_sessions s
           WHERE s.id = split_part(name, '/', 2)::uuid
             AND s.exam_id = split_part(name, '/', 1)::uuid
             AND ((SELECT public.owns_exam(s.exam_id)) OR s.status = 'in_progress')
        )
      )
    $pol$;

    EXECUTE 'DROP POLICY IF EXISTS "recordings_teacher_update" ON storage.objects';
    EXECUTE $pol$
      CREATE POLICY "recordings_teacher_update" ON storage.objects FOR UPDATE TO authenticated
      USING (
        bucket_id = 'proctoring-recordings'
        AND (SELECT public.is_teacher())
        AND split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
      )
      WITH CHECK (
        bucket_id = 'proctoring-recordings'
        AND (SELECT public.is_teacher())
        AND split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
      )
    $pol$;
  END IF;
END $$;

-- 4. Cloud-compatible first-time portal account provisioning (avoids 2/hr SMTP throttle on free tier)
CREATE OR REPLACE FUNCTION public.provision_portal_account(
  p_email text,
  p_password text,
  p_full_name text DEFAULT '',
  p_portal_role text DEFAULT 'student'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_role text := CASE WHEN p_portal_role = 'teacher' THEN 'teacher' ELSE 'student' END;
  v_name text := public._clean_text(p_full_name, 120);
  v_uid uuid := gen_random_uuid();
  v_hash text;
BEGIN
  PERFORM public._rate_limit('prov_acct:' || left(v_email, 64), 8, 300);

  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 254 THEN
    PERFORM public._raise('INVALID_INPUT', 'Please enter a valid email address.');
  END IF;
  IF coalesce(char_length(p_password), 0) < 6 OR char_length(p_password) > 128 THEN
    PERFORM public._raise('INVALID_INPUT', 'Password must be between 6 and 128 characters.');
  END IF;

  -- Never overwrite an existing account! Existing users must pass GoTrue password verification.
  IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = v_email) THEN
    RETURN jsonb_build_object('created', false, 'exists', true);
  END IF;

  -- Only run direct bcrypt provisioning when Supabase GoTrue (`auth.identities` + `extensions.crypt`) is present
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'auth' AND table_name = 'identities'
  ) THEN
    RETURN jsonb_build_object('created', false, 'exists', false, 'mode', 'local_signup');
  END IF;

  EXECUTE 'SELECT extensions.crypt($1, extensions.gen_salt(''bf'', 10))'
     INTO v_hash
    USING p_password;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_uid,
    'authenticated',
    'authenticated',
    v_email,
    v_hash,
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', v_name, 'portal_role', v_role),
    now(),
    now(),
    '', '', '', ''
  );

  INSERT INTO auth.identities (
    provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) VALUES (
    v_uid::text,
    v_uid,
    jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
    'email',
    now(),
    now(),
    now()
  );

  RETURN jsonb_build_object('created', true, 'exists', false);
END $$;

-- Ensure default CS 401 exam has join code CS492FXN and published status
UPDATE public.exams
   SET join_code = coalesce(join_code, 'CS492FXN'),
       status = CASE WHEN status IN ('draft', 'active') THEN 'published' ELSE status END
 WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

REVOKE EXECUTE ON FUNCTION
  public._apply_student_answers(public.exam_sessions, jsonb),
  public._audit(text, text, uuid, jsonb),
  public._build_student_session_payload(public.exam_sessions, public.exams),
  public._finalize_session(uuid, text, uuid),
  public._format_student_result(public.exam_sessions, public.exams, boolean),
  public._generate_join_code(),
  public._rate_limit(text, integer, integer),
  public._recompute_session_integrity(uuid),
  public._recompute_session_scores(uuid),
  public._require_student(),
  public._require_teacher(),
  public._require_user(),
  public._student_is_authorized_for_exam(public.exams, uuid, text),
  public._sweep_expired_sessions(uuid, uuid),
  public.teacher_register_recording(uuid, text, text, integer, integer),
  public.teacher_list_session_recordings(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.teacher_register_recording(uuid, text, text, integer, integer),
  public.teacher_list_session_recordings(uuid)
TO authenticated;

REVOKE EXECUTE ON FUNCTION public.provision_portal_account(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_portal_account(text, text, text, text) TO anon, authenticated;
