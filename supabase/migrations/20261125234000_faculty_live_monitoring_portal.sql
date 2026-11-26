/*
# Live Examination Hall Registration & Faculty Proctoring Peek Authorization

1. `teacher_get_live_hall_sessions()` — registers every student currently giving
   an active (`in_progress`) examination onto the Teacher Portal in real time so
   authorized faculty proctors can monitor live sessions across the portal.
2. `can_access_peek_channel(p_topic)` — authorizes session-scoped `peek:<session_id>`
   Realtime WebRTC + live telemetry channels strictly for the active student and
   authenticated faculty (`public.is_teacher()`), blocking all other students and
   unauthenticated callers.
3. Allows faculty proctors to send live notices (`teacher_send_warning`) and review
   live events (`teacher_get_session_detail`) during an active `in_progress` session,
   while keeping exam editing, publishing, and archived records strictly owner-isolated.
*/

CREATE OR REPLACE FUNCTION public.teacher_get_live_hall_sessions()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM public._require_teacher();
  PERFORM public._sweep_expired_sessions(NULL, NULL);

  RETURN coalesce((
    SELECT jsonb_agg(row_json ORDER BY started_at DESC NULLS LAST)
    FROM (
      SELECT s.started_at,
        jsonb_build_object(
          'id', s.id,
          'exam_id', s.exam_id,
          'exam_title', e.title,
          'course_code', e.course_code,
          'student_id', s.student_id,
          'student_name', s.student_name,
          'student_email', s.student_email,
          'attempt_no', s.attempt_no,
          'status', s.status,
          'live_state', CASE
            WHEN s.network_status = 'offline'
              OR (s.last_heartbeat_at IS NOT NULL AND s.last_heartbeat_at < now() - interval '45 seconds')
              THEN 'disconnected'
            ELSE 'attending'
          END,
          'started_at', s.started_at,
          'deadline_at', s.deadline_at,
          'submitted_at', s.submitted_at,
          'last_heartbeat_at', s.last_heartbeat_at,
          'time_used_seconds', greatest(0, coalesce(extract(epoch FROM (now() - s.started_at))::int, s.time_used_seconds)),
          'score', s.score,
          'objective_score', s.objective_score,
          'manual_score', s.manual_score,
          'total_marks', s.total_marks,
          'percentage', s.percentage,
          'correct_answers', s.correct_answers,
          'passed', s.passed,
          'grading_status', s.grading_status,
          'proctoring_flags', s.proctoring_flags,
          'integrity_score', s.integrity_score,
          'review_priority', s.review_priority,
          'camera_status', s.camera_status,
          'mic_status', s.mic_status,
          'screen_status', s.screen_status,
          'network_status', s.network_status,
          'answered_count', (SELECT count(*)::int FROM public.student_answers sa
                             WHERE sa.session_id = s.id
                               AND (cardinality(coalesce(sa.selected_options, '{}'::int[])) > 0
                                    OR char_length(btrim(coalesce(sa.answer_text, ''))) > 0)),
          'total_questions', e.total_questions,
          'pending_events', (SELECT count(*)::int FROM public.proctoring_events pe
                             WHERE pe.session_id = s.id AND pe.review_status = 'pending')
        ) AS row_json
      FROM public.exam_sessions s
      JOIN public.exams e ON e.id = s.exam_id
      WHERE s.status = 'in_progress'
        AND s.student_id IS NOT NULL
    ) sub
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.can_access_peek_channel(p_topic text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sid uuid;
  s public.exam_sessions;
BEGIN
  IF v_uid IS NULL OR p_topic IS NULL THEN RETURN false; END IF;
  IF p_topic ~* '^peek:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_sid := substring(p_topic FROM 6)::uuid;
    SELECT * INTO s FROM public.exam_sessions WHERE id = v_sid;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN s.status = 'in_progress' AND (s.student_id = v_uid OR public.is_teacher());
  END IF;
  RETURN public.can_access_webrtc_channel(p_topic);
END $$;

-- Allow live proctoring notice & live timeline inspection on active in_progress sessions by faculty
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
  IF NOT (public.owns_exam(s.exam_id) OR s.status = 'in_progress') THEN
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

CREATE OR REPLACE FUNCTION public.teacher_get_session_detail(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.exam_sessions;
  e public.exams;
BEGIN
  PERFORM public._require_teacher();
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN PERFORM public._raise('NOT_FOUND', 'Session not found.'); END IF;
  IF NOT (public.owns_exam(s.exam_id) OR s.status = 'in_progress') THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to inspect this session.');
  END IF;
  SELECT * INTO e FROM public.exams WHERE id = s.exam_id;

  RETURN jsonb_build_object(
    'session', to_jsonb(s),
    'exam', to_jsonb(e),
    'answers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'question_id', q.id,
        'display_order', q.display_order,
        'section', q.section,
        'question_type', q.question_type,
        'question_text', q.question_text,
        'options', q.options,
        'correct_options', CASE WHEN public.owns_exam(s.exam_id) THEN q.correct_options ELSE '{}'::integer[] END,
        'model_answer', CASE WHEN public.owns_exam(s.exam_id) THEN q.model_answer ELSE NULL END,
        'marks', q.marks,
        'answer_id', sa.id,
        'selected_options', sa.selected_options,
        'answer_text', sa.answer_text,
        'is_correct', sa.is_correct,
        'awarded_marks', sa.awarded_marks,
        'feedback', sa.feedback,
        'graded_at', sa.graded_at
      ) ORDER BY q.display_order)
      FROM public.questions q
      LEFT JOIN public.student_answers sa ON sa.session_id = s.id AND sa.question_id = q.id
      WHERE q.exam_id = s.exam_id AND q.approved = true
    ), '[]'::jsonb),
    'events', coalesce((
      SELECT jsonb_agg(to_jsonb(pe) ORDER BY pe.created_at DESC)
        FROM public.proctoring_events pe WHERE pe.session_id = s.id
    ), '[]'::jsonb),
    'warnings', coalesce((
      SELECT jsonb_agg(to_jsonb(pw) ORDER BY pw.created_at DESC)
        FROM public.proctor_warnings pw WHERE pw.session_id = s.id
    ), '[]'::jsonb)
  );
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'realtime' AND table_name = 'messages'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "smartexam_realtime_read" ON realtime.messages';
    EXECUTE 'CREATE POLICY "smartexam_realtime_read" ON realtime.messages FOR SELECT TO authenticated USING (public.can_access_peek_channel(realtime.topic()))';
    EXECUTE 'DROP POLICY IF EXISTS "smartexam_realtime_write" ON realtime.messages';
    EXECUTE 'CREATE POLICY "smartexam_realtime_write" ON realtime.messages FOR INSERT TO authenticated WITH CHECK (public.can_access_peek_channel(realtime.topic()))';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.teacher_get_live_hall_sessions(), public.can_access_peek_channel(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teacher_get_live_hall_sessions(), public.can_access_peek_channel(text) TO authenticated;
