/*
# SmartExam proctoring review engine, Realtime channel security, private evidence storage & function privilege hardening

1. Validates untrusted client proctoring signals server-side (confidence thresholds,
   cooldown deduplication, accessibility accommodations, technical vs suspicious
   classification, server-assigned severity & configurable weights).
2. Teacher review workflow: dismiss false positives, confirm/acknowledge alerts,
   add remarks, send live warnings, export proctoring reports, enforce retention.
3. Private Supabase Realtime channel RLS for exam alerts and per-session WebRTC signaling.
4. Private `proctoring-evidence` storage bucket (disabled by default; opt-in per exam).
5. Revokes EXECUTE on internal `_` helper functions from `PUBLIC`, `anon`, and `authenticated`.
*/

-- ---------------------------------------------------------------------------
-- 1. Session integrity & review-priority calculation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._recompute_session_integrity(p_session_id uuid)
RETURNS public.exam_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.exam_sessions;
  e public.exams;
  v_cfg jsonb;
  v_flags integer := 0;
  v_score numeric(8,2) := 0;
  v_mod numeric;
  v_high numeric;
  v_prio text;
  v_new_status text;
BEGIN
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._raise('NOT_FOUND', 'Session not found.'); END IF;
  SELECT * INTO e FROM public.exams WHERE id = s.exam_id;
  v_cfg := public.effective_proctoring_config(e.proctoring_config);

  SELECT count(*)::int,
         coalesce(round(sum(pe.weight * least(pe.occurrences, 5)), 2), 0)
    INTO v_flags, v_score
    FROM public.proctoring_events pe
   WHERE pe.session_id = s.id
     AND pe.category = 'suspicious'
     AND pe.review_status <> 'dismissed';

  v_mod := coalesce((v_cfg #>> '{thresholds,moderate}')::numeric, 15);
  v_high := coalesce((v_cfg #>> '{thresholds,high}')::numeric, 40);

  v_prio := CASE
    WHEN v_score >= v_high THEN 'high'
    WHEN v_score >= v_mod THEN 'moderate'
    ELSE 'low'
  END;

  -- Never auto-disqualify or alter marks; `flagged` on completed sessions only
  -- surfaces high-priority sessions in the teacher's review filter.
  v_new_status := CASE
    WHEN s.status IN ('submitted', 'flagged') THEN
      CASE WHEN v_prio = 'high' THEN 'flagged' ELSE 'submitted' END
    ELSE s.status
  END;

  UPDATE public.exam_sessions
     SET proctoring_flags = v_flags,
         integrity_score = v_score,
         review_priority = v_prio,
         status = v_new_status,
         updated_at = now()
   WHERE id = s.id
   RETURNING * INTO s;

  RETURN s;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Student proctoring event ingestion (treats client payload as untrusted)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.student_record_proctoring_event(
  p_session_id uuid,
  p_event_type text,
  p_description text DEFAULT '',
  p_confidence numeric DEFAULT NULL,
  p_duration_ms integer DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_client_event_id uuid DEFAULT NULL,
  p_client_ts timestamptz DEFAULT NULL,
  p_evidence_path text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
  s public.exam_sessions;
  e public.exams;
  v_cfg jsonb;
  v_category text;
  v_severity text;
  v_min_conf numeric;
  v_cooldown integer;
  v_weight numeric(6,2);
  v_existing public.proctoring_events;
  v_ev public.proctoring_events;
  v_clean_details jsonb;
  v_clean_evidence text := NULL;
BEGIN
  PERFORM public._rate_limit('proc_ev:' || v_uid::text, 60, 60);

  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id AND student_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._raise('FORBIDDEN', 'Active examination session not found.'); END IF;

  IF s.status <> 'in_progress' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'session_closed');
  END IF;
  IF now() > s.deadline_at + interval '10 seconds' THEN
    PERFORM public._finalize_session(s.id, 'server_expiry', NULL);
    RETURN jsonb_build_object('accepted', false, 'reason', 'session_expired');
  END IF;

  IF p_event_type NOT IN (
    'tab_switch', 'window_blur', 'fullscreen_exit', 'face_not_detected', 'multiple_faces',
    'camera_obstructed', 'phone_detected', 'prohibited_object', 'voice_activity', 'audio_anomaly',
    'copy_paste', 'screen_share_ended', 'page_reload', 'camera_interrupted', 'mic_interrupted',
    'network_offline', 'network_restored', 'monitoring_error'
  ) THEN
    PERFORM public._raise('INVALID_INPUT', 'Unsupported proctoring event type.');
  END IF;

  -- Idempotency check on client_event_id
  IF p_client_event_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.proctoring_events
     WHERE session_id = s.id AND client_event_id = p_client_event_id;
    IF FOUND THEN
      RETURN jsonb_build_object('accepted', true, 'deduplicated', true, 'event', to_jsonb(v_existing));
    END IF;
  END IF;

  SELECT * INTO e FROM public.exams WHERE id = s.exam_id;
  v_cfg := public.effective_proctoring_config(e.proctoring_config);

  -- Classify technical vs suspicious (and respect student accessibility accommodations)
  IF p_event_type IN ('camera_interrupted', 'mic_interrupted', 'network_offline', 'monitoring_error') THEN
    v_category := 'technical';
  ELSIF p_event_type IN ('network_restored', 'page_reload') THEN
    v_category := CASE WHEN p_event_type = 'network_restored' THEN 'info' ELSE 'technical' END;
  ELSE
    v_category := 'suspicious';
  END IF;

  IF coalesce((s.accommodations ->> 'exempt_face_absence')::boolean, false)
     AND p_event_type IN ('face_not_detected', 'camera_obstructed') THEN
    v_category := 'info';
  END IF;
  IF coalesce((s.accommodations ->> 'exempt_voice')::boolean, false)
     AND p_event_type IN ('voice_activity', 'audio_anomaly') THEN
    v_category := 'info';
  END IF;
  IF coalesce((s.accommodations ->> 'allow_assistive_focus')::boolean, false)
     AND p_event_type IN ('window_blur', 'fullscreen_exit') THEN
    v_category := 'info';
  END IF;

  -- Confidence gate for AI detections
  IF (v_cfg -> 'min_confidence') ? p_event_type THEN
    v_min_conf := coalesce((v_cfg -> 'min_confidence' ->> p_event_type)::numeric, 0);
    IF v_min_conf > 0 AND p_confidence IS NOT NULL AND p_confidence < v_min_conf THEN
      RETURN jsonb_build_object('accepted', false, 'reason', 'below_confidence_threshold');
    END IF;
  END IF;

  -- Cooldown & deduplication window
  v_cooldown := coalesce(
    (v_cfg -> 'cooldown_seconds' ->> p_event_type)::int,
    (v_cfg -> 'cooldown_seconds' ->> 'default')::int,
    20
  );

  IF v_cooldown > 0 THEN
    SELECT * INTO v_existing
      FROM public.proctoring_events pe
     WHERE pe.session_id = s.id
       AND pe.event_type = p_event_type
       AND pe.review_status <> 'dismissed'
       AND pe.last_seen_at >= now() - make_interval(secs => v_cooldown)
     ORDER BY pe.last_seen_at DESC
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.proctoring_events
         SET occurrences = occurrences + 1,
             last_seen_at = now(),
             duration_ms = CASE
               WHEN p_duration_ms IS NOT NULL THEN greatest(coalesce(duration_ms, 0), least(p_duration_ms, 86400000))
               ELSE duration_ms
             END,
             confidence = CASE
               WHEN p_confidence IS NOT NULL THEN greatest(coalesce(confidence, 0), least(greatest(p_confidence, 0), 1))
               ELSE confidence
             END
       WHERE id = v_existing.id
       RETURNING * INTO v_ev;

      s := public._recompute_session_integrity(s.id);
      RETURN jsonb_build_object(
        'accepted', true,
        'deduplicated', true,
        'event', to_jsonb(v_ev),
        'proctoring_flags', s.proctoring_flags,
        'integrity_score', s.integrity_score,
        'review_priority', s.review_priority
      );
    END IF;
  END IF;

  v_weight := CASE
    WHEN v_category = 'suspicious' THEN coalesce((v_cfg -> 'weights' ->> p_event_type)::numeric, 5)
    ELSE 0
  END;

  v_severity := CASE
    WHEN v_category <> 'suspicious' THEN 'info'
    WHEN v_weight >= 15 THEN 'critical'
    WHEN v_weight >= 3 THEN 'warning'
    ELSE 'info'
  END;

  v_clean_details := CASE
    WHEN jsonb_typeof(p_details) = 'object' AND pg_column_size(p_details) <= 2048 THEN p_details
    ELSE '{}'::jsonb
  END;

  -- Accept evidence path only when exam explicitly enables evidence capture and path matches session prefix
  IF coalesce((v_cfg ->> 'capture_evidence')::boolean, false)
     AND p_evidence_path IS NOT NULL
     AND p_evidence_path LIKE (s.exam_id::text || '/' || s.id::text || '/%')
     AND char_length(p_evidence_path) <= 240
     AND p_evidence_path !~ '\.\.' THEN
    v_clean_evidence := p_evidence_path;
  END IF;

  INSERT INTO public.proctoring_events (
    session_id, exam_id, student_id, event_type, category, description,
    severity, confidence, duration_ms, details, client_event_id, client_ts,
    weight, occurrences, last_seen_at, review_status, evidence_path
  ) VALUES (
    s.id, s.exam_id, v_uid, p_event_type, v_category,
    public._clean_text(p_description, 500),
    v_severity,
    CASE WHEN p_confidence IS NOT NULL THEN round(least(greatest(p_confidence, 0), 1), 3) ELSE NULL END,
    CASE WHEN p_duration_ms IS NOT NULL THEN least(greatest(p_duration_ms, 0), 86400000) ELSE NULL END,
    v_clean_details,
    p_client_event_id,
    p_client_ts,
    v_weight,
    1,
    now(),
    CASE WHEN v_category = 'suspicious' THEN 'pending' ELSE 'acknowledged' END,
    v_clean_evidence
  ) RETURNING * INTO v_ev;

  s := public._recompute_session_integrity(s.id);

  RETURN jsonb_build_object(
    'accepted', true,
    'deduplicated', false,
    'event', to_jsonb(v_ev),
    'proctoring_flags', s.proctoring_flags,
    'integrity_score', s.integrity_score,
    'review_priority', s.review_priority
  );
END $$;

-- ---------------------------------------------------------------------------
-- 3. Teacher proctoring review, warnings, export & retention RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.teacher_review_proctoring_event(
  p_event_id uuid,
  p_review_status text,
  p_remarks text DEFAULT ''
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_teacher();
  ev public.proctoring_events;
  s public.exam_sessions;
BEGIN
  IF p_review_status NOT IN ('pending', 'acknowledged', 'confirmed', 'dismissed') THEN
    PERFORM public._raise('INVALID_INPUT', 'Unsupported review status.');
  END IF;

  SELECT * INTO ev FROM public.proctoring_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._raise('NOT_FOUND', 'Proctoring event not found.'); END IF;
  IF NOT public.owns_exam(ev.exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to review this event.');
  END IF;

  UPDATE public.proctoring_events
     SET review_status = p_review_status,
         teacher_remarks = public._clean_text(p_remarks, 2000),
         reviewed_by = v_uid,
         reviewed_at = now()
   WHERE id = p_event_id
   RETURNING * INTO ev;

  s := public._recompute_session_integrity(ev.session_id);
  PERFORM public._audit('proctoring.review.' || p_review_status, 'proctoring_event', ev.id, '{}'::jsonb);

  RETURN jsonb_build_object(
    'event', to_jsonb(ev),
    'session', jsonb_build_object(
      'id', s.id,
      'status', s.status,
      'proctoring_flags', s.proctoring_flags,
      'integrity_score', s.integrity_score,
      'review_priority', s.review_priority
    )
  );
END $$;

CREATE OR REPLACE FUNCTION public.teacher_acknowledge_all_alerts(p_exam_id uuid, p_session_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_teacher();
  v_count integer;
BEGIN
  IF NOT public.owns_exam(p_exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to manage this examination.');
  END IF;

  UPDATE public.proctoring_events
     SET review_status = 'acknowledged',
         reviewed_by = v_uid,
         reviewed_at = now()
   WHERE exam_id = p_exam_id
     AND (p_session_id IS NULL OR session_id = p_session_id)
     AND review_status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('acknowledged_count', v_count);
END $$;

CREATE OR REPLACE FUNCTION public.teacher_send_warning(p_session_id uuid, p_message text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_teacher();
  s public.exam_sessions;
  v_msg text := public._clean_text(p_message, 500);
  w public.proctor_warnings;
BEGIN
  PERFORM public._rate_limit('warn:' || v_uid::text, 30, 60);
  IF char_length(v_msg) < 2 THEN
    PERFORM public._raise('INVALID_INPUT', 'Please enter a warning message.');
  END IF;

  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN PERFORM public._raise('NOT_FOUND', 'Session not found.'); END IF;
  IF NOT public.owns_exam(s.exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to message this student.');
  END IF;
  IF s.student_id IS NULL THEN
    PERFORM public._raise('INVALID_INPUT', 'Cannot send live warning to a legacy session without a user account.');
  END IF;

  INSERT INTO public.proctor_warnings (session_id, exam_id, student_id, teacher_id, message)
  VALUES (s.id, s.exam_id, s.student_id, v_uid, v_msg)
  RETURNING * INTO w;

  PERFORM public._audit('proctoring.warn', 'exam_session', s.id, '{}'::jsonb);
  RETURN to_jsonb(w);
END $$;

CREATE OR REPLACE FUNCTION public.teacher_export_exam_report(p_exam_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  e public.exams;
BEGIN
  PERFORM public._require_teacher();
  IF NOT public.owns_exam(p_exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to export data for this examination.');
  END IF;
  SELECT * INTO e FROM public.exams WHERE id = p_exam_id;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'exam', to_jsonb(e),
    'results', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'session_id', s.id,
        'student_name', s.student_name,
        'student_email', s.student_email,
        'attempt_no', s.attempt_no,
        'status', s.status,
        'started_at', s.started_at,
        'submitted_at', s.submitted_at,
        'time_used_seconds', s.time_used_seconds,
        'objective_score', s.objective_score,
        'manual_score', s.manual_score,
        'score', s.score,
        'total_marks', s.total_marks,
        'percentage', s.percentage,
        'correct_answers', s.correct_answers,
        'passed', s.passed,
        'grading_status', s.grading_status,
        'proctoring_flags', s.proctoring_flags,
        'integrity_score', s.integrity_score,
        'review_priority', s.review_priority
      ) ORDER BY s.percentage DESC, s.student_name ASC)
      FROM public.exam_sessions s WHERE s.exam_id = p_exam_id
    ), '[]'::jsonb),
    'proctoring_events', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'event_id', pe.id,
        'session_id', pe.session_id,
        'student_name', s.student_name,
        'student_email', s.student_email,
        'event_type', pe.event_type,
        'category', pe.category,
        'severity', pe.severity,
        'confidence', pe.confidence,
        'duration_ms', pe.duration_ms,
        'occurrences', pe.occurrences,
        'weight', pe.weight,
        'review_status', pe.review_status,
        'teacher_remarks', pe.teacher_remarks,
        'created_at', pe.created_at,
        'last_seen_at', pe.last_seen_at
      ) ORDER BY pe.created_at DESC)
      FROM public.proctoring_events pe
      JOIN public.exam_sessions s ON s.id = pe.session_id
      WHERE pe.exam_id = p_exam_id
    ), '[]'::jsonb)
  );
END $$;

CREATE OR REPLACE FUNCTION public.teacher_purge_expired_evidence(p_exam_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_teacher();
  e public.exams;
  v_cleared integer;
BEGIN
  IF NOT public.owns_exam(p_exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to manage retention for this examination.');
  END IF;
  SELECT * INTO e FROM public.exams WHERE id = p_exam_id;

  UPDATE public.proctoring_events
     SET evidence_path = NULL,
         details = '{}'::jsonb
   WHERE exam_id = p_exam_id
     AND created_at < now() - make_interval(days => e.retention_days)
     AND (evidence_path IS NOT NULL OR details <> '{}'::jsonb);
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  PERFORM public._audit('proctoring.retention_purge', 'exam', p_exam_id,
    jsonb_build_object('cleared_events', v_cleared));
  RETURN jsonb_build_object('cleared_events', v_cleared, 'retention_days', e.retention_days);
END $$;

-- ---------------------------------------------------------------------------
-- 4. Realtime authorization helper & publication / channel RLS (Supabase Cloud)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_webrtc_channel(p_topic text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sid uuid;
  s public.exam_sessions;
BEGIN
  IF v_uid IS NULL OR p_topic IS NULL THEN RETURN false; END IF;
  IF p_topic ~* '^webrtc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_sid := substring(p_topic FROM 8)::uuid;
    SELECT * INTO s FROM public.exam_sessions WHERE id = v_sid;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN (s.student_id = v_uid AND s.status = 'in_progress') OR public.owns_exam(s.exam_id);
  ELSIF p_topic ~* '^exam:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_sid := substring(p_topic FROM 6)::uuid;
    RETURN public.owns_exam(v_sid) OR EXISTS (
      SELECT 1 FROM public.exam_sessions es
       WHERE es.exam_id = v_sid AND es.student_id = v_uid AND es.status = 'in_progress'
    );
  END IF;
  RETURN false;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'exam_sessions') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.exam_sessions;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'proctoring_events') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.proctoring_events;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'proctor_warnings') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.proctor_warnings;
    END IF;
  END IF;

  -- Lock down private Realtime Broadcast/Presence channels when realtime.messages is installed
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'realtime' AND table_name = 'messages'
  ) THEN
    EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "smartexam_realtime_read" ON realtime.messages';
    EXECUTE 'CREATE POLICY "smartexam_realtime_read" ON realtime.messages FOR SELECT TO authenticated USING (public.can_access_webrtc_channel(realtime.topic()))';
    EXECUTE 'DROP POLICY IF EXISTS "smartexam_realtime_write" ON realtime.messages';
    EXECUTE 'CREATE POLICY "smartexam_realtime_write" ON realtime.messages FOR INSERT TO authenticated WITH CHECK (public.can_access_webrtc_channel(realtime.topic()))';
  END IF;

  -- Private proctoring evidence bucket (opt-in only; never public)
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('proctoring-evidence', 'proctoring-evidence', false, 524288, ARRAY['image/jpeg', 'image/webp'])
    ON CONFLICT (id) DO UPDATE
      SET public = false,
          file_size_limit = 524288,
          allowed_mime_types = ARRAY['image/jpeg', 'image/webp'];

    EXECUTE 'DROP POLICY IF EXISTS "evidence_student_upload" ON storage.objects';
    EXECUTE $pol$
      CREATE POLICY "evidence_student_upload" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'proctoring-evidence'
        AND split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
        AND split_part(name, '/', 2) ~* '^[0-9a-f-]{36}$'
        AND EXISTS (
          SELECT 1 FROM public.exam_sessions s
          JOIN public.exams e ON e.id = s.exam_id
          WHERE s.id = split_part(name, '/', 2)::uuid
            AND s.exam_id = split_part(name, '/', 1)::uuid
            AND s.student_id = auth.uid()
            AND s.status = 'in_progress'
            AND coalesce((public.effective_proctoring_config(e.proctoring_config) ->> 'capture_evidence')::boolean, false) = true
        )
      )
    $pol$;

    EXECUTE 'DROP POLICY IF EXISTS "evidence_teacher_read" ON storage.objects';
    EXECUTE $pol$
      CREATE POLICY "evidence_teacher_read" ON storage.objects FOR SELECT TO authenticated
      USING (
        bucket_id = 'proctoring-evidence'
        AND split_part(name, '/', 1) ~* '^[0-9a-f-]{36}$'
        AND public.owns_exam(split_part(name, '/', 1)::uuid)
      )
    $pol$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Strict function execution privileges (revoke internal `_` helpers)
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.current_app_role(),
  public.is_teacher(),
  public.is_admin(),
  public.owns_exam(uuid),
  public.can_access_webrtc_channel(text),
  public.default_proctoring_config(),
  public.effective_proctoring_config(jsonb),
  public.get_my_profile(),
  public.update_my_name(text),
  public.request_teacher_access(text),
  public.admin_list_teacher_requests(text),
  public.admin_review_teacher_request(uuid, boolean),
  public.teacher_save_exam(jsonb, jsonb, jsonb),
  public.teacher_set_exam_status(uuid, text),
  public.teacher_regenerate_join_code(uuid),
  public.teacher_publish_results(uuid, boolean),
  public.teacher_grade_descriptive_answer(uuid, numeric, text),
  public.teacher_get_exam_detail(uuid),
  public.teacher_get_dashboard(uuid),
  public.teacher_get_session_detail(uuid),
  public.teacher_review_proctoring_event(uuid, text, text),
  public.teacher_acknowledge_all_alerts(uuid, uuid),
  public.teacher_send_warning(uuid, text),
  public.teacher_export_exam_report(uuid),
  public.teacher_purge_expired_evidence(uuid),
  public.student_join_exam_by_code(text),
  public.student_list_exams(),
  public.student_start_or_resume_session(uuid, jsonb, boolean, text),
  public.student_save_answers(uuid, jsonb),
  public.student_heartbeat(uuid, text, text, text, text),
  public.student_submit_exam(uuid, uuid, jsonb, text),
  public.student_get_result(uuid),
  public.student_list_results(),
  public.student_acknowledge_warning(uuid),
  public.student_record_proctoring_event(uuid, text, text, numeric, integer, jsonb, uuid, timestamptz, text)
TO authenticated;
