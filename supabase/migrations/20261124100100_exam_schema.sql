/*
# SmartExam exam engine — schema extensions

Non-destructive: only ADD COLUMN / new tables / constraint replacement. Existing rows
are preserved (legacy `active` exams are mapped to `published`).

Adds: join codes, schedules, negative marking, pass mark, attempt limits, randomisation,
access restriction (assigned students), result publication, proctoring configuration,
question types (mcq / multi_select / true_false / descriptive), per-session server
deadlines and randomised orders, revisioned answers, enrolments/assignments,
structured proctoring events and teacher warnings.
*/

-- ---------------------------------------------------------------------------
-- exams
-- ---------------------------------------------------------------------------
ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS exams_status_check;
UPDATE public.exams SET status = 'published' WHERE status = 'active';
ALTER TABLE public.exams ADD CONSTRAINT exams_status_check
  CHECK (status IN ('draft', 'published', 'ended', 'archived'));
ALTER TABLE public.exams ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS join_code text,
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS negative_marking_ratio numeric(4,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pass_percentage numeric(5,2) NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS shuffle_questions boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shuffle_options boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'code',
  ADD COLUMN IF NOT EXISTS show_results_immediately boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS results_published boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS results_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_at timestamptz,
  ADD COLUMN IF NOT EXISTS proctoring_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS retention_days integer NOT NULL DEFAULT 30;

ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS exams_created_by_fkey;
ALTER TABLE public.exams ADD CONSTRAINT exams_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS exams_field_checks;
ALTER TABLE public.exams ADD CONSTRAINT exams_field_checks CHECK (
  char_length(title) BETWEEN 1 AND 200
  AND char_length(course_code) BETWEEN 1 AND 40
  AND char_length(course_name) BETWEEN 1 AND 120
  AND duration_minutes BETWEEN 1 AND 600
  AND negative_marking_ratio BETWEEN 0 AND 1
  AND pass_percentage BETWEEN 0 AND 100
  AND max_attempts BETWEEN 1 AND 10
  AND access_mode IN ('code', 'assigned')
  AND retention_days BETWEEN 1 AND 365
  AND (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
  AND (join_code IS NULL OR join_code ~ '^[A-Z2-9]{8}$')
) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_exams_join_code ON public.exams (join_code) WHERE join_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exams_created_by ON public.exams (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exams_status ON public.exams (status);

-- ---------------------------------------------------------------------------
-- questions
-- ---------------------------------------------------------------------------
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS question_type text NOT NULL DEFAULT 'mcq',
  ADD COLUMN IF NOT EXISTS correct_options integer[],
  ADD COLUMN IF NOT EXISTS explanation text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS model_answer text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.questions ALTER COLUMN correct_answer DROP NOT NULL;
UPDATE public.questions SET correct_options = ARRAY[correct_answer]
 WHERE correct_options IS NULL AND correct_answer IS NOT NULL;

ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_field_checks;
ALTER TABLE public.questions ADD CONSTRAINT questions_field_checks CHECK (
  question_type IN ('mcq', 'multi_select', 'true_false', 'descriptive')
  AND char_length(question_text) BETWEEN 1 AND 5000
  AND char_length(section) BETWEEN 1 AND 120
  AND marks BETWEEN 0 AND 1000
  AND jsonb_typeof(options) = 'array'
  AND char_length(explanation) <= 5000
  AND char_length(model_answer) <= 10000
) NOT VALID;
CREATE INDEX IF NOT EXISTS idx_questions_exam_order ON public.questions (exam_id, display_order);

-- Integrity validation for question content (runs for every insert/update).
CREATE OR REPLACE FUNCTION public.validate_question()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE n integer; i integer; opt text;
BEGIN
  IF jsonb_typeof(NEW.options) <> 'array' THEN
    RAISE EXCEPTION USING MESSAGE = 'Options must be a list.', HINT = 'INVALID_INPUT';
  END IF;
  n := jsonb_array_length(NEW.options);
  IF NEW.question_type = 'descriptive' THEN
    NEW.options := '[]'::jsonb; NEW.correct_options := NULL; NEW.correct_answer := NULL;
  ELSE
    IF NEW.question_type = 'true_false' THEN
      NEW.options := '["True", "False"]'::jsonb; n := 2;
    ELSIF n < 2 OR n > 8 THEN
      RAISE EXCEPTION USING MESSAGE = 'Objective questions need between 2 and 8 options.', HINT = 'INVALID_INPUT';
    END IF;
    FOR i IN 0 .. n - 1 LOOP
      IF jsonb_typeof(NEW.options -> i) <> 'string' THEN
        RAISE EXCEPTION USING MESSAGE = 'Every option must be text.', HINT = 'INVALID_INPUT';
      END IF;
      opt := NEW.options ->> i;
      IF char_length(btrim(opt)) = 0 OR char_length(opt) > 1000 THEN
        RAISE EXCEPTION USING MESSAGE = 'Options must be between 1 and 1000 characters.', HINT = 'INVALID_INPUT';
      END IF;
    END LOOP;
    IF NEW.correct_options IS NULL OR cardinality(NEW.correct_options) = 0 THEN
      RAISE EXCEPTION USING MESSAGE = 'Select the correct answer for every objective question.', HINT = 'INVALID_INPUT';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(NEW.correct_options) c WHERE c < 0 OR c >= n) THEN
      RAISE EXCEPTION USING MESSAGE = 'Correct answer refers to a missing option.', HINT = 'INVALID_INPUT';
    END IF;
    NEW.correct_options := ARRAY(SELECT DISTINCT c FROM unnest(NEW.correct_options) c ORDER BY c);
    IF NEW.question_type <> 'multi_select' AND cardinality(NEW.correct_options) <> 1 THEN
      RAISE EXCEPTION USING MESSAGE = 'Single-answer questions must have exactly one correct option.', HINT = 'INVALID_INPUT';
    END IF;
    NEW.correct_answer := NEW.correct_options[1];
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_validate_question ON public.questions;
CREATE TRIGGER trg_validate_question BEFORE INSERT OR UPDATE ON public.questions
  FOR EACH ROW EXECUTE FUNCTION public.validate_question();

-- ---------------------------------------------------------------------------
-- assignments (authorised students) & enrolments (joined via code)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  student_email text NOT NULL CHECK (student_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND char_length(student_email) <= 254),
  extra_time_minutes integer NOT NULL DEFAULT 0 CHECK (extra_time_minutes BETWEEN 0 AND 300),
  accommodations jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_assignments_email ON public.exam_assignments (exam_id, lower(student_email));
CREATE INDEX IF NOT EXISTS idx_exam_assignments_email ON public.exam_assignments (lower(student_email));
ALTER TABLE public.exam_assignments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.exam_enrollments (
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exam_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_exam_enrollments_student ON public.exam_enrollments (student_id);
ALTER TABLE public.exam_enrollments ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- exam_sessions
-- ---------------------------------------------------------------------------
ALTER TABLE public.exam_sessions
  ADD COLUMN IF NOT EXISTS student_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS attempt_no integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS question_order uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS option_orders jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS submitted_via text,
  ADD COLUMN IF NOT EXISTS submit_idempotency_key uuid,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS camera_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS mic_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS screen_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS network_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS device_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS integrity_score numeric(8,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_priority text NOT NULL DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS grading_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS objective_score numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_score numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS passed boolean,
  ADD COLUMN IF NOT EXISTS consent_given_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_version text,
  ADD COLUMN IF NOT EXISTS accommodations jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.exam_sessions DROP CONSTRAINT IF EXISTS exam_sessions_field_checks;
ALTER TABLE public.exam_sessions ADD CONSTRAINT exam_sessions_field_checks CHECK (
  attempt_no BETWEEN 1 AND 10
  AND camera_status IN ('ok', 'lost', 'denied', 'off', 'unknown')
  AND mic_status IN ('ok', 'lost', 'denied', 'off', 'unknown')
  AND screen_status IN ('ok', 'lost', 'denied', 'off', 'unknown')
  AND network_status IN ('online', 'offline', 'unknown')
  AND review_priority IN ('low', 'moderate', 'high')
  AND grading_status IN ('pending', 'needs_manual', 'graded')
  AND (submitted_via IS NULL OR submitted_via IN ('student', 'timeout', 'teacher_end', 'server_expiry'))
) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_active_attempt
  ON public.exam_sessions (exam_id, student_id) WHERE status = 'in_progress' AND student_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_attempt_no
  ON public.exam_sessions (exam_id, student_id, attempt_no) WHERE student_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_student ON public.exam_sessions (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_exam_status ON public.exam_sessions (exam_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_deadline_open ON public.exam_sessions (deadline_at) WHERE status = 'in_progress';

-- ---------------------------------------------------------------------------
-- student_answers
-- ---------------------------------------------------------------------------
ALTER TABLE public.student_answers
  ADD COLUMN IF NOT EXISTS selected_options integer[],
  ADD COLUMN IF NOT EXISTS answer_text text,
  ADD COLUMN IF NOT EXISTS marked_for_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_correct boolean,
  ADD COLUMN IF NOT EXISTS awarded_marks numeric(10,2),
  ADD COLUMN IF NOT EXISTS feedback text,
  ADD COLUMN IF NOT EXISTS graded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS graded_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE public.student_answers SET selected_options = ARRAY[selected_option]
 WHERE selected_options IS NULL AND selected_option IS NOT NULL;
ALTER TABLE public.student_answers DROP CONSTRAINT IF EXISTS student_answers_field_checks;
ALTER TABLE public.student_answers ADD CONSTRAINT student_answers_field_checks CHECK (
  (answer_text IS NULL OR char_length(answer_text) <= 20000)
  AND (feedback IS NULL OR char_length(feedback) <= 2000)
  AND (selected_options IS NULL OR cardinality(selected_options) <= 8)
) NOT VALID;

-- ---------------------------------------------------------------------------
-- proctoring_events (structured, reviewable) & teacher warnings
-- ---------------------------------------------------------------------------
ALTER TABLE public.proctoring_events DROP CONSTRAINT IF EXISTS proctoring_events_event_type_check;
ALTER TABLE public.proctoring_events
  ADD COLUMN IF NOT EXISTS exam_id uuid REFERENCES public.exams(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS student_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'suspicious',
  ADD COLUMN IF NOT EXISTS confidence numeric(4,3),
  ADD COLUMN IF NOT EXISTS duration_ms integer,
  ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS client_event_id uuid,
  ADD COLUMN IF NOT EXISTS client_ts timestamptz,
  ADD COLUMN IF NOT EXISTS weight numeric(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS occurrences integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS teacher_remarks text,
  ADD COLUMN IF NOT EXISTS evidence_path text;

UPDATE public.proctoring_events pe SET exam_id = s.exam_id, student_id = s.student_id
  FROM public.exam_sessions s WHERE s.id = pe.session_id AND pe.exam_id IS NULL;

ALTER TABLE public.proctoring_events ADD CONSTRAINT proctoring_events_event_type_check CHECK (event_type IN (
  'tab_switch', 'window_blur', 'fullscreen_exit', 'face_not_detected', 'multiple_faces',
  'camera_obstructed', 'phone_detected', 'prohibited_object', 'voice_activity', 'audio_anomaly',
  'copy_paste', 'screen_share_ended', 'page_reload', 'camera_interrupted', 'mic_interrupted',
  'network_offline', 'network_restored', 'monitoring_error',
  -- legacy values from the original schema
  'audio_detected', 'browser_exit'
)) NOT VALID;
ALTER TABLE public.proctoring_events DROP CONSTRAINT IF EXISTS proctoring_events_field_checks;
ALTER TABLE public.proctoring_events ADD CONSTRAINT proctoring_events_field_checks CHECK (
  category IN ('suspicious', 'technical', 'info')
  AND (confidence IS NULL OR confidence BETWEEN 0 AND 1)
  AND (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000)
  AND review_status IN ('pending', 'acknowledged', 'confirmed', 'dismissed')
  AND (teacher_remarks IS NULL OR char_length(teacher_remarks) <= 2000)
  AND (description IS NULL OR char_length(description) <= 500)
  AND pg_column_size(details) <= 4096
) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_client_id ON public.proctoring_events (session_id, client_event_id) WHERE client_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_exam_time ON public.proctoring_events (exam_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_type ON public.proctoring_events (session_id, event_type, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_pending ON public.proctoring_events (exam_id) WHERE review_status = 'pending';

CREATE TABLE IF NOT EXISTS public.proctor_warnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.exam_sessions(id) ON DELETE CASCADE,
  exam_id uuid NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  teacher_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_warnings_session ON public.proctor_warnings (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warnings_student ON public.proctor_warnings (student_id) WHERE acknowledged_at IS NULL;
ALTER TABLE public.proctor_warnings ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Privileges: read via RLS, write via RPC only
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.exam_assignments, public.exam_enrollments, public.proctor_warnings FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.exam_assignments, public.exam_enrollments,
  public.proctor_warnings FROM authenticated;
GRANT SELECT ON public.exams, public.questions, public.exam_sessions, public.student_answers,
  public.proctoring_events, public.exam_assignments, public.exam_enrollments, public.proctor_warnings
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Ownership helpers & RLS policies
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.owns_exam(p_exam_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.exams e WHERE e.id = p_exam_id AND e.created_by = auth.uid())
     AND public.is_teacher();
$$;

-- Teachers: only their own examinations. Students: no direct table reads
-- (they use RPCs that never return correct answers or unpublished scores).
DROP POLICY IF EXISTS "exams_owner_select" ON public.exams;
CREATE POLICY "exams_owner_select" ON public.exams FOR SELECT TO authenticated
  USING (created_by = (SELECT auth.uid()) AND (SELECT public.is_teacher()));

DROP POLICY IF EXISTS "questions_owner_select" ON public.questions;
CREATE POLICY "questions_owner_select" ON public.questions FOR SELECT TO authenticated
  USING ((SELECT public.owns_exam(exam_id)));

DROP POLICY IF EXISTS "assignments_owner_select" ON public.exam_assignments;
CREATE POLICY "assignments_owner_select" ON public.exam_assignments FOR SELECT TO authenticated
  USING ((SELECT public.owns_exam(exam_id)));

DROP POLICY IF EXISTS "enrollments_owner_or_self_select" ON public.exam_enrollments;
CREATE POLICY "enrollments_owner_or_self_select" ON public.exam_enrollments FOR SELECT TO authenticated
  USING (student_id = (SELECT auth.uid()) OR (SELECT public.owns_exam(exam_id)));

DROP POLICY IF EXISTS "sessions_owner_select" ON public.exam_sessions;
CREATE POLICY "sessions_owner_select" ON public.exam_sessions FOR SELECT TO authenticated
  USING ((SELECT public.owns_exam(exam_id)));

DROP POLICY IF EXISTS "answers_owner_select" ON public.student_answers;
CREATE POLICY "answers_owner_select" ON public.student_answers FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.exam_sessions s WHERE s.id = session_id AND public.owns_exam(s.exam_id)));

DROP POLICY IF EXISTS "events_owner_select" ON public.proctoring_events;
CREATE POLICY "events_owner_select" ON public.proctoring_events FOR SELECT TO authenticated
  USING ((SELECT public.owns_exam(exam_id)));

DROP POLICY IF EXISTS "warnings_owner_or_student_select" ON public.proctor_warnings;
CREATE POLICY "warnings_owner_or_student_select" ON public.proctor_warnings FOR SELECT TO authenticated
  USING (student_id = (SELECT auth.uid()) OR (SELECT public.owns_exam(exam_id)));

-- ---------------------------------------------------------------------------
-- Proctoring configuration (experimental, configurable weights)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.default_proctoring_config()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT '{
    "require_camera": true,
    "require_microphone": true,
    "require_screen": true,
    "capture_evidence": false,
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
      "multiple_faces": 0.6, "phone_detected": 0.55, "prohibited_object": 0.6,
      "voice_activity": 0.6, "face_not_detected": 0, "camera_obstructed": 0.7
    },
    "cooldown_seconds": {
      "default": 20, "tab_switch": 3, "window_blur": 10, "fullscreen_exit": 5,
      "face_not_detected": 30, "multiple_faces": 30, "phone_detected": 30,
      "prohibited_object": 45, "voice_activity": 45, "audio_anomaly": 60, "copy_paste": 10
    },
    "sustain_seconds": {
      "face_not_detected": 5, "multiple_faces": 2, "phone_detected": 2,
      "prohibited_object": 3, "voice_activity": 4, "camera_obstructed": 3
    }
  }'::jsonb;
$$;

CREATE OR REPLACE FUNCTION public.effective_proctoring_config(p_cfg jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE d jsonb := public.default_proctoring_config(); c jsonb := coalesce(p_cfg, '{}'::jsonb); k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['require_camera','require_microphone','require_screen','capture_evidence',
                           'face_detection','object_detection','audio_monitoring'] LOOP
    IF jsonb_typeof(c -> k) = 'boolean' THEN d := jsonb_set(d, ARRAY[k], c -> k); END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['weights','thresholds','min_confidence','cooldown_seconds','sustain_seconds'] LOOP
    IF jsonb_typeof(c -> k) = 'object' THEN d := jsonb_set(d, ARRAY[k], (d -> k) || (c -> k)); END IF;
  END LOOP;
  RETURN d;
END $$;

-- Validate a teacher-supplied config: numeric ranges and allowed keys only.
CREATE OR REPLACE FUNCTION public._validate_proctoring_config(p_cfg jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE c jsonb := coalesce(p_cfg, '{}'::jsonb); out jsonb := '{}'::jsonb; k text; v jsonb; grp text;
  lim numeric[];
BEGIN
  IF jsonb_typeof(c) <> 'object' THEN
    RAISE EXCEPTION USING MESSAGE = 'Invalid proctoring configuration.', HINT = 'INVALID_INPUT';
  END IF;
  FOREACH k IN ARRAY ARRAY['require_camera','require_microphone','require_screen','capture_evidence',
                           'face_detection','object_detection','audio_monitoring'] LOOP
    IF jsonb_typeof(c -> k) = 'boolean' THEN out := out || jsonb_build_object(k, c -> k); END IF;
  END LOOP;
  FOREACH grp IN ARRAY ARRAY['weights','thresholds','min_confidence','cooldown_seconds','sustain_seconds'] LOOP
    lim := CASE grp WHEN 'weights' THEN ARRAY[0,100] WHEN 'thresholds' THEN ARRAY[1,10000]
                    WHEN 'min_confidence' THEN ARRAY[0,1] WHEN 'cooldown_seconds' THEN ARRAY[0,3600]
                    ELSE ARRAY[0,600] END;
    IF jsonb_typeof(c -> grp) = 'object' THEN
      out := out || jsonb_build_object(grp, '{}'::jsonb);
      FOR k, v IN SELECT * FROM jsonb_each(c -> grp) LOOP
        IF NOT (public.default_proctoring_config() -> grp) ? k THEN CONTINUE; END IF;
        IF jsonb_typeof(v) <> 'number' OR v::text::numeric < lim[1] OR v::text::numeric > lim[2] THEN
          RAISE EXCEPTION USING MESSAGE = format('Invalid value for %s.%s', grp, k), HINT = 'INVALID_INPUT';
        END IF;
        out := jsonb_set(out, ARRAY[grp, k], v);
      END LOOP;
    END IF;
  END LOOP;
  IF (public.effective_proctoring_config(out) #>> '{thresholds,moderate}')::numeric
     >= (public.effective_proctoring_config(out) #>> '{thresholds,high}')::numeric THEN
    RAISE EXCEPTION USING MESSAGE = 'The high-priority threshold must exceed the moderate threshold.', HINT = 'INVALID_INPUT';
  END IF;
  RETURN out;
END $$;
