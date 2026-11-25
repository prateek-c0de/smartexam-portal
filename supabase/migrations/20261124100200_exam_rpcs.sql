/*
# SmartExam server-side examination & grading RPCs

All mutations and student reads flow through SECURITY DEFINER functions with
`SET search_path = ''`, explicit role/ownership checks, rate limiting, and
server-controlled timestamps and score calculation.

Students never receive `correct_answer`, `correct_options`, `model_answer`, or
`explanation` until the owning teacher explicitly publishes results.
*/

-- ---------------------------------------------------------------------------
-- 1. Join code generator (unambiguous 8-char alphabet: A-HJ-NP-Z2-9)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._generate_join_code()
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
  i integer;
  tries integer := 0;
BEGIN
  LOOP
    tries := tries + 1;
    code := '';
    FOR i IN 1..8 LOOP
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.exams e WHERE e.join_code = code);
    IF tries > 25 THEN
      PERFORM public._raise('CODE_GEN_FAILED', 'Unable to generate a unique examination code.');
    END IF;
  END LOOP;
  RETURN code;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Internal session grading & finalisation (idempotent, row-locked)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._recompute_session_scores(p_session_id uuid)
RETURNS public.exam_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.exam_sessions;
  e public.exams;
  v_total_marks integer := 0;
  v_total_questions integer := 0;
  v_obj_score numeric(10,2) := 0;
  v_man_score numeric(10,2) := 0;
  v_correct integer := 0;
  v_ungraded_desc integer := 0;
  v_total numeric(10,2);
  v_pct numeric(5,2);
  rec record;
  v_sel integer[];
  v_corr integer[];
  v_is_correct boolean;
  v_award numeric(10,2);
BEGIN
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public._raise('NOT_FOUND', 'Examination session not found.');
  END IF;
  SELECT * INTO e FROM public.exams WHERE id = s.exam_id;

  FOR rec IN
    SELECT q.id AS qid, q.question_type, q.marks, q.correct_options,
           sa.id AS aid, sa.selected_options, sa.answer_text, sa.awarded_marks, sa.graded_at
      FROM public.questions q
      LEFT JOIN public.student_answers sa
        ON sa.session_id = s.id AND sa.question_id = q.id
     WHERE q.exam_id = s.exam_id AND q.approved = true
     ORDER BY q.display_order
  LOOP
    v_total_questions := v_total_questions + 1;
    v_total_marks := v_total_marks + rec.marks;

    IF rec.question_type = 'descriptive' THEN
      IF rec.aid IS NOT NULL AND rec.graded_at IS NOT NULL AND rec.awarded_marks IS NOT NULL THEN
        v_man_score := v_man_score + rec.awarded_marks;
        IF rec.awarded_marks >= rec.marks AND rec.marks > 0 THEN
          v_correct := v_correct + 1;
        END IF;
      ELSIF rec.aid IS NOT NULL AND char_length(btrim(coalesce(rec.answer_text, ''))) > 0 THEN
        v_ungraded_desc := v_ungraded_desc + 1;
      ELSE
        -- Blank descriptive answer: 0 marks, still allow teacher override if desired,
        -- but mark needs_manual if descriptive questions exist and aren't graded yet.
        v_ungraded_desc := v_ungraded_desc + 1;
      END IF;
    ELSE
      -- Objective question (mcq, true_false, multi_select)
      v_sel := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(rec.selected_options, '{}'::int[])) x ORDER BY x);
      v_corr := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(rec.correct_options, '{}'::int[])) x ORDER BY x);

      IF cardinality(v_sel) = 0 THEN
        v_is_correct := false;
        v_award := 0;
      ELSIF v_sel = v_corr THEN
        v_is_correct := true;
        v_award := rec.marks;
        v_correct := v_correct + 1;
      ELSE
        v_is_correct := false;
        v_award := - round((rec.marks::numeric * e.negative_marking_ratio), 2);
      END IF;

      v_obj_score := v_obj_score + v_award;

      IF rec.aid IS NOT NULL THEN
        UPDATE public.student_answers
           SET is_correct = v_is_correct,
               awarded_marks = v_award,
               updated_at = now()
         WHERE id = rec.aid;
      END IF;
    END IF;
  END LOOP;

  v_total := greatest(0, round(v_obj_score + v_man_score, 2));
  v_pct := CASE WHEN v_total_marks > 0 THEN round((v_total / v_total_marks::numeric) * 100, 2) ELSE 0 END;

  UPDATE public.exam_sessions
     SET objective_score = round(v_obj_score, 2),
         manual_score = round(v_man_score, 2),
         score = v_total,
         total_marks = v_total_marks,
         percentage = v_pct,
         correct_answers = v_correct,
         passed = (v_pct >= e.pass_percentage),
         grading_status = CASE WHEN v_ungraded_desc > 0 THEN 'needs_manual' ELSE 'graded' END,
         updated_at = now()
   WHERE id = s.id
   RETURNING * INTO s;

  RETURN s;
END $$;

CREATE OR REPLACE FUNCTION public._finalize_session(
  p_session_id uuid,
  p_via text,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS public.exam_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.exam_sessions;
  e public.exams;
  v_used integer;
  v_max_seconds integer;
BEGIN
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public._raise('NOT_FOUND', 'Examination session not found.');
  END IF;

  -- Idempotent: if already finalised, return existing record untouched.
  IF s.status IN ('submitted', 'flagged') THEN
    RETURN s;
  END IF;

  SELECT * INTO e FROM public.exams WHERE id = s.exam_id;
  v_max_seconds := greatest(60, coalesce(
    extract(epoch FROM (s.deadline_at - s.started_at))::int,
    e.duration_minutes * 60
  ));
  v_used := least(
    v_max_seconds,
    greatest(0, coalesce(extract(epoch FROM (now() - s.started_at))::int, 0))
  );

  UPDATE public.exam_sessions
     SET status = CASE WHEN s.review_priority = 'high' THEN 'flagged' ELSE 'submitted' END,
         submitted_at = coalesce(s.submitted_at, now()),
         submitted_via = coalesce(p_via, 'student'),
         submit_idempotency_key = coalesce(p_idempotency_key, s.submit_idempotency_key),
         time_used_seconds = v_used,
         camera_status = 'off',
         mic_status = 'off',
         screen_status = 'off',
         updated_at = now()
   WHERE id = s.id;

  s := public._recompute_session_scores(s.id);
  PERFORM public._audit('session.submit', 'exam_session', s.id,
    jsonb_build_object('via', coalesce(p_via, 'student'), 'exam_id', s.exam_id));
  RETURN s;
END $$;

CREATE OR REPLACE FUNCTION public._sweep_expired_sessions(p_exam_id uuid DEFAULT NULL, p_student_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  rec record;
  n integer := 0;
BEGIN
  FOR rec IN
    SELECT s.id
      FROM public.exam_sessions s
     WHERE s.status = 'in_progress'
       AND s.deadline_at IS NOT NULL
       AND s.deadline_at <= now()
       AND (p_exam_id IS NULL OR s.exam_id = p_exam_id)
       AND (p_student_id IS NULL OR s.student_id = p_student_id)
  LOOP
    PERFORM public._finalize_session(rec.id, 'server_expiry', NULL);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Teacher examination management RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.teacher_save_exam(
  p_exam jsonb,
  p_questions jsonb DEFAULT NULL,
  p_assignments jsonb DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_teacher();
  v_exam_id uuid := NULLIF(p_exam ->> 'id', '')::uuid;
  v_is_new boolean := (v_exam_id IS NULL);
  v_title text := public._clean_text(p_exam ->> 'title', 200);
  v_code text := public._clean_text(p_exam ->> 'course_code', 40);
  v_course text := public._clean_text(p_exam ->> 'course_name', 120);
  v_dur integer := coalesce((p_exam ->> 'duration_minutes')::int, 60);
  v_starts timestamptz := NULLIF(p_exam ->> 'starts_at', '')::timestamptz;
  v_ends timestamptz := NULLIF(p_exam ->> 'ends_at', '')::timestamptz;
  v_neg numeric(4,3) := coalesce((p_exam ->> 'negative_marking_ratio')::numeric, 0);
  v_pass numeric(5,2) := coalesce((p_exam ->> 'pass_percentage')::numeric, 40);
  v_attempts integer := coalesce((p_exam ->> 'max_attempts')::int, 1);
  v_shuf_q boolean := coalesce((p_exam ->> 'shuffle_questions')::boolean, false);
  v_shuf_o boolean := coalesce((p_exam ->> 'shuffle_options')::boolean, false);
  v_access text := coalesce(NULLIF(p_exam ->> 'access_mode', ''), 'code');
  v_imm boolean := coalesce((p_exam ->> 'show_results_immediately')::boolean, false);
  v_ret integer := coalesce((p_exam ->> 'retention_days')::int, 30);
  v_pcfg jsonb := public._validate_proctoring_config(coalesce(p_exam -> 'proctoring_config', '{}'::jsonb));
  v_instr text[] := '{}'::text[];
  v_status text := coalesce(NULLIF(p_exam ->> 'status', ''), 'draft');
  v_join_code text;
  v_has_sessions boolean := false;
  q jsonb;
  v_qid uuid;
  v_kept_qids uuid[] := '{}'::uuid[];
  v_idx integer := 0;
  v_qtype text;
  v_opts jsonb;
  v_corr integer[];
  a jsonb;
  v_email text;
  v_kept_emails text[] := '{}'::text[];
  v_tot_q integer;
  v_tot_m integer;
  v_out public.exams;
BEGIN
  PERFORM public._rate_limit('save_exam:' || v_uid::text, 30, 60);

  IF char_length(v_title) < 1 THEN PERFORM public._raise('INVALID_INPUT', 'Exam title is required.'); END IF;
  IF char_length(v_code) < 1 THEN PERFORM public._raise('INVALID_INPUT', 'Course code is required.'); END IF;
  IF char_length(v_course) < 1 THEN PERFORM public._raise('INVALID_INPUT', 'Course name is required.'); END IF;
  IF v_dur < 1 OR v_dur > 600 THEN PERFORM public._raise('INVALID_INPUT', 'Duration must be between 1 and 600 minutes.'); END IF;
  IF v_ends IS NOT NULL AND v_starts IS NOT NULL AND v_ends <= v_starts THEN
    PERFORM public._raise('INVALID_INPUT', 'Ending time must be after starting time.');
  END IF;
  IF v_status NOT IN ('draft', 'published') THEN v_status := 'draft'; END IF;

  IF jsonb_typeof(p_exam -> 'instructions') = 'array' THEN
    SELECT coalesce(array_agg(cleaned), '{}'::text[]) INTO v_instr
    FROM (
      SELECT public._clean_text(x, 500) AS cleaned
      FROM jsonb_array_elements_text(p_exam -> 'instructions') x
    ) t WHERE char_length(cleaned) > 0;
  END IF;

  IF v_is_new THEN
    v_join_code := public._generate_join_code();
    INSERT INTO public.exams (
      title, course_code, course_name, duration_minutes, starts_at, ends_at,
      negative_marking_ratio, pass_percentage, max_attempts, shuffle_questions,
      shuffle_options, access_mode, show_results_immediately, proctoring_config,
      retention_days, instructions, status, join_code, created_by, published_at
    ) VALUES (
      v_title, v_code, v_course, v_dur, v_starts, v_ends,
      v_neg, v_pass, v_attempts, v_shuf_q,
      v_shuf_o, v_access, v_imm, v_pcfg,
      v_ret, v_instr, 'draft', v_join_code, v_uid, NULL
    ) RETURNING id INTO v_exam_id;
  ELSE
    IF NOT public.owns_exam(v_exam_id) THEN
      PERFORM public._raise('FORBIDDEN', 'You are not authorized to edit this examination.');
    END IF;
    SELECT EXISTS (SELECT 1 FROM public.exam_sessions s WHERE s.exam_id = v_exam_id) INTO v_has_sessions;

    UPDATE public.exams
       SET title = v_title,
           course_code = v_code,
           course_name = v_course,
           duration_minutes = CASE WHEN v_has_sessions THEN duration_minutes ELSE v_dur END,
           starts_at = v_starts,
           ends_at = v_ends,
           negative_marking_ratio = v_neg,
           pass_percentage = v_pass,
           max_attempts = v_attempts,
           shuffle_questions = v_shuf_q,
           shuffle_options = v_shuf_o,
           access_mode = v_access,
           show_results_immediately = v_imm,
           proctoring_config = v_pcfg,
           retention_days = v_ret,
           instructions = v_instr,
           join_code = coalesce(join_code, public._generate_join_code()),
           updated_at = now()
     WHERE id = v_exam_id;
  END IF;

  -- Upsert questions if supplied
  IF p_questions IS NOT NULL AND jsonb_typeof(p_questions) = 'array' THEN
    FOR q IN SELECT * FROM jsonb_array_elements(p_questions) LOOP
      v_idx := v_idx + 1;
      v_qid := NULL;
      BEGIN
        IF coalesce(q ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          v_qid := (q ->> 'id')::uuid;
        END IF;
      EXCEPTION WHEN OTHERS THEN v_qid := NULL;
      END;

      v_qtype := coalesce(NULLIF(q ->> 'question_type', ''), 'mcq');
      v_opts := coalesce(q -> 'options', '[]'::jsonb);
      IF jsonb_typeof(q -> 'correct_options') = 'array' THEN
        SELECT coalesce(array_agg(x::int), '{}'::int[]) INTO v_corr
          FROM jsonb_array_elements_text(q -> 'correct_options') x;
      ELSIF (q ->> 'correct_answer') IS NOT NULL THEN
        v_corr := ARRAY[(q ->> 'correct_answer')::int];
      ELSE
        v_corr := NULL;
      END IF;

      IF v_qid IS NOT NULL AND EXISTS (SELECT 1 FROM public.questions WHERE id = v_qid AND exam_id = v_exam_id) THEN
        UPDATE public.questions
           SET section = coalesce(NULLIF(public._clean_text(q ->> 'section', 120), ''), 'Section A'),
               question_type = v_qtype,
               question_text = public._clean_text(q ->> 'question_text', 5000),
               options = v_opts,
               correct_options = v_corr,
               marks = coalesce((q ->> 'marks')::int, 1),
               explanation = public._clean_text(q ->> 'explanation', 5000),
               model_answer = public._clean_text(q ->> 'model_answer', 10000),
               ai_generated = coalesce((q ->> 'ai_generated')::boolean, false),
               approved = coalesce((q ->> 'approved')::boolean, true),
               display_order = v_idx
         WHERE id = v_qid AND exam_id = v_exam_id;
      ELSE
        INSERT INTO public.questions (
          exam_id, section, question_type, question_text, options, correct_options,
          marks, explanation, model_answer, ai_generated, approved, display_order
        ) VALUES (
          v_exam_id,
          coalesce(NULLIF(public._clean_text(q ->> 'section', 120), ''), 'Section A'),
          v_qtype,
          public._clean_text(q ->> 'question_text', 5000),
          v_opts,
          v_corr,
          coalesce((q ->> 'marks')::int, 1),
          public._clean_text(q ->> 'explanation', 5000),
          public._clean_text(q ->> 'model_answer', 10000),
          coalesce((q ->> 'ai_generated')::boolean, false),
          coalesce((q ->> 'approved')::boolean, true),
          v_idx
        ) RETURNING id INTO v_qid;
      END IF;
      v_kept_qids := array_append(v_kept_qids, v_qid);
    END LOOP;

    -- Remove unreferenced questions omitted from the list (never delete answered questions)
    DELETE FROM public.questions qd
     WHERE qd.exam_id = v_exam_id
       AND NOT (qd.id = ANY(v_kept_qids))
       AND NOT EXISTS (SELECT 1 FROM public.student_answers sa WHERE sa.question_id = qd.id);
  END IF;

  -- Sync authorised student assignments if supplied
  IF p_assignments IS NOT NULL AND jsonb_typeof(p_assignments) = 'array' THEN
    FOR a IN SELECT * FROM jsonb_array_elements(p_assignments) LOOP
      v_email := lower(btrim(coalesce(
        CASE WHEN jsonb_typeof(a) = 'string' THEN a #>> '{}' ELSE a ->> 'student_email' END, ''
      )));
      IF v_email = '' THEN CONTINUE; END IF;
      INSERT INTO public.exam_assignments (exam_id, student_email, extra_time_minutes, accommodations)
      VALUES (
        v_exam_id,
        v_email,
        CASE WHEN jsonb_typeof(a) = 'object' THEN coalesce((a ->> 'extra_time_minutes')::int, 0) ELSE 0 END,
        CASE WHEN jsonb_typeof(a) = 'object' AND jsonb_typeof(a -> 'accommodations') = 'object'
             THEN a -> 'accommodations' ELSE '{}'::jsonb END
      )
      ON CONFLICT (exam_id, lower(student_email)) DO UPDATE
        SET extra_time_minutes = EXCLUDED.extra_time_minutes,
            accommodations = EXCLUDED.accommodations;
      v_kept_emails := array_append(v_kept_emails, v_email);
    END LOOP;
    DELETE FROM public.exam_assignments ea
     WHERE ea.exam_id = v_exam_id AND NOT (lower(ea.student_email) = ANY(v_kept_emails));
  END IF;

  SELECT count(*)::int, coalesce(sum(marks), 0)::int
    INTO v_tot_q, v_tot_m
    FROM public.questions WHERE exam_id = v_exam_id AND approved = true;

  IF v_status = 'published' AND v_tot_q < 1 THEN
    PERFORM public._raise('INVALID_INPUT', 'Add at least one approved question before publishing.');
  END IF;

  UPDATE public.exams
     SET total_questions = v_tot_q,
         total_marks = v_tot_m,
         status = CASE WHEN v_status = 'published' THEN 'published' ELSE status END,
         published_at = CASE WHEN v_status = 'published' THEN coalesce(published_at, now()) ELSE published_at END,
         updated_at = now()
   WHERE id = v_exam_id
   RETURNING * INTO v_out;

  PERFORM public._audit(CASE WHEN v_is_new THEN 'exam.create' ELSE 'exam.update' END,
    'exam', v_exam_id, jsonb_build_object('status', v_out.status, 'questions', v_tot_q));

  RETURN to_jsonb(v_out);
END $$;

CREATE OR REPLACE FUNCTION public.teacher_set_exam_status(p_exam_id uuid, p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_teacher();
  e public.exams;
  rec record;
BEGIN
  IF NOT public.owns_exam(p_exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to manage this examination.');
  END IF;
  IF p_status NOT IN ('draft', 'published', 'ended', 'archived') THEN
    PERFORM public._raise('INVALID_INPUT', 'Unsupported examination status.');
  END IF;

  SELECT * INTO e FROM public.exams WHERE id = p_exam_id FOR UPDATE;

  IF p_status = 'published' THEN
    IF (SELECT count(*) FROM public.questions WHERE exam_id = p_exam_id AND approved = true) < 1 THEN
      PERFORM public._raise('INVALID_INPUT', 'Cannot publish an examination with zero approved questions.');
    END IF;
    UPDATE public.exams
       SET status = 'published',
           join_code = coalesce(join_code, public._generate_join_code()),
           published_at = coalesce(published_at, now()),
           ended_at = NULL,
           updated_at = now()
     WHERE id = p_exam_id RETURNING * INTO e;
  ELSIF p_status = 'ended' THEN
    FOR rec IN SELECT id FROM public.exam_sessions WHERE exam_id = p_exam_id AND status = 'in_progress' LOOP
      PERFORM public._finalize_session(rec.id, 'teacher_end', NULL);
    END LOOP;
    UPDATE public.exams
       SET status = 'ended', ended_at = now(), updated_at = now()
     WHERE id = p_exam_id RETURNING * INTO e;
  ELSE
    IF p_status = 'draft' AND EXISTS (SELECT 1 FROM public.exam_sessions WHERE exam_id = p_exam_id AND status = 'in_progress') THEN
      PERFORM public._raise('CONFLICT', 'Cannot revert to draft while students are actively taking the exam.');
    END IF;
    UPDATE public.exams SET status = p_status, updated_at = now() WHERE id = p_exam_id RETURNING * INTO e;
  END IF;

  PERFORM public._audit('exam.status.' || p_status, 'exam', p_exam_id, '{}'::jsonb);
  RETURN to_jsonb(e);
END $$;

CREATE OR REPLACE FUNCTION public.teacher_regenerate_join_code(p_exam_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_code text;
BEGIN
  PERFORM public._require_teacher();
  IF NOT public.owns_exam(p_exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to manage this examination.');
  END IF;
  v_code := public._generate_join_code();
  UPDATE public.exams SET join_code = v_code, updated_at = now() WHERE id = p_exam_id;
  PERFORM public._audit('exam.regenerate_code', 'exam', p_exam_id, '{}'::jsonb);
  RETURN jsonb_build_object('exam_id', p_exam_id, 'join_code', v_code);
END $$;

CREATE OR REPLACE FUNCTION public.teacher_publish_results(p_exam_id uuid, p_publish boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  e public.exams;
  rec record;
BEGIN
  PERFORM public._require_teacher();
  IF NOT public.owns_exam(p_exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to publish results for this examination.');
  END IF;

  IF p_publish THEN
    PERFORM public._sweep_expired_sessions(p_exam_id, NULL);
    FOR rec IN SELECT id FROM public.exam_sessions WHERE exam_id = p_exam_id AND status IN ('submitted', 'flagged') LOOP
      PERFORM public._recompute_session_scores(rec.id);
    END LOOP;
  END IF;

  UPDATE public.exams
     SET results_published = p_publish,
         results_published_at = CASE WHEN p_publish THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = p_exam_id
   RETURNING * INTO e;

  PERFORM public._audit(CASE WHEN p_publish THEN 'exam.results.publish' ELSE 'exam.results.unpublish' END,
    'exam', p_exam_id, '{}'::jsonb);
  RETURN to_jsonb(e);
END $$;

CREATE OR REPLACE FUNCTION public.teacher_grade_descriptive_answer(
  p_answer_id uuid,
  p_awarded_marks numeric,
  p_feedback text DEFAULT ''
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_teacher();
  v_ans public.student_answers;
  v_q public.questions;
  v_sess public.exam_sessions;
BEGIN
  SELECT * INTO v_ans FROM public.student_answers WHERE id = p_answer_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._raise('NOT_FOUND', 'Answer not found.'); END IF;
  SELECT * INTO v_q FROM public.questions WHERE id = v_ans.question_id;
  IF NOT public.owns_exam(v_q.exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to grade this answer.');
  END IF;
  IF p_awarded_marks < 0 OR p_awarded_marks > v_q.marks THEN
    PERFORM public._raise('INVALID_INPUT', format('Awarded marks must be between 0 and %s.', v_q.marks));
  END IF;

  UPDATE public.student_answers
     SET awarded_marks = round(p_awarded_marks, 2),
         is_correct = (p_awarded_marks > 0),
         feedback = public._clean_text(p_feedback, 2000),
         graded_by = v_uid,
         graded_at = now(),
         updated_at = now()
   WHERE id = p_answer_id;

  v_sess := public._recompute_session_scores(v_ans.session_id);
  PERFORM public._audit('answer.grade', 'student_answer', p_answer_id,
    jsonb_build_object('awarded_marks', round(p_awarded_marks, 2)));
  RETURN to_jsonb(v_sess);
END $$;

CREATE OR REPLACE FUNCTION public.teacher_get_exam_detail(p_exam_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  e public.exams;
BEGIN
  PERFORM public._require_teacher();
  IF NOT public.owns_exam(p_exam_id) THEN
    PERFORM public._raise('FORBIDDEN', 'You are not authorized to view this examination.');
  END IF;
  SELECT * INTO e FROM public.exams WHERE id = p_exam_id;
  RETURN jsonb_build_object(
    'exam', to_jsonb(e),
    'questions', coalesce((
      SELECT jsonb_agg(to_jsonb(q) ORDER BY q.display_order)
        FROM public.questions q WHERE q.exam_id = p_exam_id
    ), '[]'::jsonb),
    'assignments', coalesce((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.student_email)
        FROM public.exam_assignments a WHERE a.exam_id = p_exam_id
    ), '[]'::jsonb)
  );
END $$;

CREATE OR REPLACE FUNCTION public.teacher_get_dashboard(p_exam_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_teacher();
  v_target_exam uuid := p_exam_id;
  v_exams jsonb;
  v_sessions jsonb;
  v_pending_alerts integer;
  v_question_stats jsonb;
  v_section_stats jsonb;
  v_registered_roster jsonb;
BEGIN
  -- Sweep expired open sessions for teacher's exams so statuses are fresh
  FOR v_target_exam IN
    SELECT e.id FROM public.exams e
     WHERE e.created_by = v_uid AND (p_exam_id IS NULL OR e.id = p_exam_id)
  LOOP
    PERFORM public._sweep_expired_sessions(v_target_exam, NULL);
  END LOOP;
  v_target_exam := p_exam_id;

  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC), '[]'::jsonb)
    INTO v_exams
    FROM public.exams e WHERE e.created_by = v_uid;

  SELECT coalesce(jsonb_agg(row_json ORDER BY sort_ts DESC NULLS LAST), '[]'::jsonb)
    INTO v_sessions
    FROM (
      SELECT coalesce(s.submitted_at, s.started_at, s.created_at) AS sort_ts,
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
            WHEN s.status IN ('submitted', 'flagged') THEN s.status
            WHEN s.status = 'not_started' THEN 'not_started'
            WHEN s.network_status = 'offline'
              OR (s.last_heartbeat_at IS NOT NULL AND s.last_heartbeat_at < now() - interval '45 seconds')
              THEN 'disconnected'
            ELSE 'attending'
          END,
          'started_at', s.started_at,
          'deadline_at', s.deadline_at,
          'submitted_at', s.submitted_at,
          'last_heartbeat_at', s.last_heartbeat_at,
          'time_used_seconds', s.time_used_seconds,
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
      WHERE e.created_by = v_uid
        AND (v_target_exam IS NULL OR s.exam_id = v_target_exam)
    ) sub;

  -- Enrolled or assigned students who have NOT created a session yet (not_started / absent)
  SELECT coalesce(jsonb_agg(r_json), '[]'::jsonb) INTO v_registered_roster
  FROM (
    SELECT DISTINCT ON (e.id, lower(stu_email))
      jsonb_build_object(
        'exam_id', e.id,
        'exam_title', e.title,
        'course_code', e.course_code,
        'student_id', stu_id,
        'student_email', lower(stu_email),
        'student_name', coalesce(NULLIF(stu_name, ''), split_part(stu_email, '@', 1)),
        'state', CASE
          WHEN e.status = 'ended' OR (e.ends_at IS NOT NULL AND e.ends_at < now()) THEN 'absent'
          ELSE 'not_started'
        END
      ) AS r_json
    FROM public.exams e
    JOIN (
      SELECT en.exam_id, p.id AS stu_id, p.email AS stu_email, p.full_name AS stu_name
        FROM public.exam_enrollments en JOIN public.profiles p ON p.id = en.student_id
      UNION ALL
      SELECT ea.exam_id, p.id AS stu_id, ea.student_email AS stu_email, coalesce(p.full_name, '') AS stu_name
        FROM public.exam_assignments ea LEFT JOIN public.profiles p ON lower(p.email) = lower(ea.student_email)
    ) roster ON roster.exam_id = e.id
    WHERE e.created_by = v_uid
      AND (v_target_exam IS NULL OR e.id = v_target_exam)
      AND NOT EXISTS (
        SELECT 1 FROM public.exam_sessions s
         WHERE s.exam_id = e.id
           AND (s.student_id = roster.stu_id OR lower(s.student_email) = lower(roster.stu_email))
      )
  ) sub2;

  SELECT count(*)::int INTO v_pending_alerts
    FROM public.proctoring_events pe
    JOIN public.exams e ON e.id = pe.exam_id
   WHERE e.created_by = v_uid
     AND (v_target_exam IS NULL OR pe.exam_id = v_target_exam)
     AND pe.review_status = 'pending';

  -- Question-wise & section-wise analytics when a specific exam is selected (or across owned exams)
  SELECT coalesce(jsonb_agg(q_row ORDER BY display_order), '[]'::jsonb) INTO v_question_stats
  FROM (
    SELECT q.display_order,
      jsonb_build_object(
        'question_id', q.id,
        'exam_id', q.exam_id,
        'display_order', q.display_order,
        'section', q.section,
        'question_type', q.question_type,
        'question_text', left(q.question_text, 160),
        'marks', q.marks,
        'attempts', count(sa.id)::int,
        'correct_count', count(*) FILTER (WHERE sa.is_correct = true)::int,
        'accuracy_pct', CASE WHEN count(sa.id) > 0
          THEN round((count(*) FILTER (WHERE sa.is_correct = true)::numeric / count(sa.id)::numeric) * 100, 1)
          ELSE 0 END,
        'avg_marks', coalesce(round(avg(sa.awarded_marks), 2), 0)
      ) AS q_row
    FROM public.questions q
    JOIN public.exams e ON e.id = q.exam_id
    LEFT JOIN public.student_answers sa ON sa.question_id = q.id
      AND EXISTS (SELECT 1 FROM public.exam_sessions s WHERE s.id = sa.session_id AND s.status IN ('submitted', 'flagged'))
    WHERE e.created_by = v_uid
      AND (v_target_exam IS NULL OR q.exam_id = v_target_exam)
    GROUP BY q.id
  ) qsub;

  SELECT coalesce(jsonb_agg(sec_row), '[]'::jsonb) INTO v_section_stats
  FROM (
    SELECT jsonb_build_object(
      'section', q.section,
      'questions', count(DISTINCT q.id)::int,
      'max_marks', sum(DISTINCT q.marks)::int,
      'avg_accuracy_pct', CASE WHEN count(sa.id) > 0
        THEN round((count(*) FILTER (WHERE sa.is_correct = true)::numeric / count(sa.id)::numeric) * 100, 1)
        ELSE 0 END
    ) AS sec_row
    FROM public.questions q
    JOIN public.exams e ON e.id = q.exam_id
    LEFT JOIN public.student_answers sa ON sa.question_id = q.id
      AND EXISTS (SELECT 1 FROM public.exam_sessions s WHERE s.id = sa.session_id AND s.status IN ('submitted', 'flagged'))
    WHERE e.created_by = v_uid
      AND (v_target_exam IS NULL OR q.exam_id = v_target_exam)
    GROUP BY q.section
  ) ssub;

  RETURN jsonb_build_object(
    'server_now', now(),
    'exams', v_exams,
    'sessions', v_sessions,
    'unstarted_roster', v_registered_roster,
    'pending_alerts', v_pending_alerts,
    'question_analytics', v_question_stats,
    'section_analytics', v_section_stats
  );
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
  IF NOT public.owns_exam(s.exam_id) THEN
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
        'correct_options', q.correct_options,
        'model_answer', q.model_answer,
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

-- ---------------------------------------------------------------------------
-- 4. Student examination RPCs (strictly zero leakage of answer keys)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._student_is_authorized_for_exam(p_exam public.exams, p_uid uuid, p_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN p_exam.access_mode = 'assigned' THEN
      EXISTS (SELECT 1 FROM public.exam_assignments ea
               WHERE ea.exam_id = p_exam.id AND lower(ea.student_email) = lower(p_email))
    ELSE
      EXISTS (SELECT 1 FROM public.exam_enrollments en
               WHERE en.exam_id = p_exam.id AND en.student_id = p_uid)
      OR EXISTS (SELECT 1 FROM public.exam_assignments ea
                  WHERE ea.exam_id = p_exam.id AND lower(ea.student_email) = lower(p_email))
  END;
$$;

CREATE OR REPLACE FUNCTION public._student_exam_metadata(p_exam public.exams)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', p_exam.id,
    'title', p_exam.title,
    'course_code', p_exam.course_code,
    'course_name', p_exam.course_name,
    'duration_minutes', p_exam.duration_minutes,
    'total_questions', p_exam.total_questions,
    'total_marks', p_exam.total_marks,
    'negative_marking_ratio', p_exam.negative_marking_ratio,
    'pass_percentage', p_exam.pass_percentage,
    'max_attempts', p_exam.max_attempts,
    'starts_at', p_exam.starts_at,
    'ends_at', p_exam.ends_at,
    'status', p_exam.status,
    'instructions', p_exam.instructions,
    'results_published', p_exam.results_published,
    'show_results_immediately', p_exam.show_results_immediately,
    'proctoring_config', public.effective_proctoring_config(p_exam.proctoring_config)
  );
$$;

CREATE OR REPLACE FUNCTION public.student_join_exam_by_code(p_join_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
  v_prof public.profiles;
  v_code text := upper(regexp_replace(coalesce(p_join_code, ''), '[^A-Za-z0-9]', '', 'g'));
  e public.exams;
BEGIN
  -- Rate limit executes first; returning structured failure JSON below commits the transaction
  -- so every failed code guess persists its rate-limit counter in `public.rate_limits`.
  PERFORM public._rate_limit('join_code:' || v_uid::text, 10, 300);
  IF char_length(v_code) <> 8 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INVALID_CODE',
      'message', 'Please enter a valid 8-character examination code.'
    );
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_uid;
  SELECT * INTO e FROM public.exams WHERE join_code = v_code;
  IF NOT FOUND OR e.status <> 'published' THEN
    PERFORM public._audit('exam.join_failed', 'exam', NULL, jsonb_build_object('reason', 'invalid_code'));
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INVALID_CODE',
      'message', 'Invalid or inactive examination code.'
    );
  END IF;
  IF e.ends_at IS NOT NULL AND e.ends_at <= now() THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'EXAM_EXPIRED',
      'message', 'This examination window has already closed.'
    );
  END IF;
  IF e.access_mode = 'assigned' AND NOT EXISTS (
    SELECT 1 FROM public.exam_assignments ea
     WHERE ea.exam_id = e.id AND lower(ea.student_email) = lower(v_prof.email)
  ) THEN
    PERFORM public._audit('exam.join_denied', 'exam', e.id, jsonb_build_object('reason', 'not_assigned'));
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'NOT_ASSIGNED',
      'message', 'Your account is not on the authorized roster for this examination.'
    );
  END IF;

  INSERT INTO public.exam_enrollments (exam_id, student_id)
  VALUES (e.id, v_uid)
  ON CONFLICT (exam_id, student_id) DO NOTHING;

  PERFORM public._audit('exam.join', 'exam', e.id, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'exam', public._student_exam_metadata(e));
END $$;

CREATE OR REPLACE FUNCTION public.student_list_exams()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
  v_prof public.profiles;
BEGIN
  PERFORM public._sweep_expired_sessions(NULL, v_uid);
  SELECT * INTO v_prof FROM public.profiles WHERE id = v_uid;

  RETURN coalesce((
    SELECT jsonb_agg(item ORDER BY sort_ts DESC)
    FROM (
      SELECT coalesce(e.starts_at, e.created_at) AS sort_ts,
        public._student_exam_metadata(e) || jsonb_build_object(
          'attempts_used', (SELECT count(*)::int FROM public.exam_sessions s
                             WHERE s.exam_id = e.id AND s.student_id = v_uid
                               AND s.status IN ('submitted', 'flagged')),
          'active_session_id', (SELECT s.id FROM public.exam_sessions s
                                 WHERE s.exam_id = e.id AND s.student_id = v_uid
                                   AND s.status = 'in_progress' LIMIT 1),
          'latest_session', (
            SELECT jsonb_build_object(
              'id', s.id,
              'status', s.status,
              'submitted_at', s.submitted_at,
              'time_used_seconds', s.time_used_seconds,
              'results_visible', (e.results_published OR e.show_results_immediately),
              'score', CASE WHEN e.results_published OR e.show_results_immediately THEN s.score ELSE NULL END,
              'total_marks', s.total_marks,
              'percentage', CASE WHEN e.results_published OR e.show_results_immediately THEN s.percentage ELSE NULL END,
              'passed', CASE WHEN e.results_published OR e.show_results_immediately THEN s.passed ELSE NULL END,
              'grading_status', s.grading_status
            )
            FROM public.exam_sessions s
            WHERE s.exam_id = e.id AND s.student_id = v_uid AND s.status IN ('submitted', 'flagged')
            ORDER BY s.submitted_at DESC NULLS LAST LIMIT 1
          )
        ) AS item
      FROM public.exams e
      WHERE (
        EXISTS (SELECT 1 FROM public.exam_enrollments en WHERE en.exam_id = e.id AND en.student_id = v_uid)
        OR EXISTS (SELECT 1 FROM public.exam_assignments ea WHERE ea.exam_id = e.id AND lower(ea.student_email) = lower(v_prof.email))
        OR EXISTS (SELECT 1 FROM public.exam_sessions s WHERE s.exam_id = e.id AND s.student_id = v_uid)
      )
      AND e.status IN ('published', 'ended')
    ) sub
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public._build_student_session_payload(p_session public.exam_sessions, p_exam public.exams)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_questions jsonb;
  v_answers jsonb;
  v_warnings jsonb;
BEGIN
  -- Return questions in `p_session.question_order`, stripping correct_answer/correct_options/model_answer/explanation!
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', q.id,
      'display_index', ord.pos,
      'section', q.section,
      'question_type', q.question_type,
      'question_text', q.question_text,
      'marks', q.marks,
      -- Send canonical options + per-question option_order permutation so UI renders shuffled
      -- choices while submitting canonical option indices for deterministic server grading.
      'options', q.options,
      'option_order', coalesce(p_session.option_orders -> (q.id::text), to_jsonb(
        CASE WHEN jsonb_array_length(q.options) > 0
             THEN ARRAY(SELECT generate_series(0, jsonb_array_length(q.options) - 1))
             ELSE '{}'::int[] END
      ))
    ) ORDER BY ord.pos
  ), '[]'::jsonb)
  INTO v_questions
  FROM unnest(p_session.question_order) WITH ORDINALITY AS ord(qid, pos)
  JOIN public.questions q ON q.id = ord.qid;

  SELECT coalesce(jsonb_object_agg(
    sa.question_id::text,
    jsonb_build_object(
      'selected_options', coalesce(sa.selected_options, '{}'::int[]),
      'answer_text', coalesce(sa.answer_text, ''),
      'marked_for_review', sa.marked_for_review,
      'revision', sa.revision
    )
  ), '{}'::jsonb)
  INTO v_answers
  FROM public.student_answers sa WHERE sa.session_id = p_session.id;

  SELECT coalesce(jsonb_agg(to_jsonb(pw) ORDER BY pw.created_at DESC), '[]'::jsonb)
    INTO v_warnings
    FROM public.proctor_warnings pw
   WHERE pw.session_id = p_session.id AND pw.acknowledged_at IS NULL;

  RETURN jsonb_build_object(
    'server_now', now(),
    'session', jsonb_build_object(
      'id', p_session.id,
      'exam_id', p_session.exam_id,
      'attempt_no', p_session.attempt_no,
      'status', p_session.status,
      'started_at', p_session.started_at,
      'deadline_at', p_session.deadline_at,
      'remaining_seconds', greatest(0, floor(extract(epoch FROM (p_session.deadline_at - now())))::int),
      'proctoring_flags', p_session.proctoring_flags,
      'accommodations', p_session.accommodations
    ),
    'exam', public._student_exam_metadata(p_exam),
    'questions', v_questions,
    'answers', v_answers,
    'warnings', v_warnings
  );
END $$;

CREATE OR REPLACE FUNCTION public.student_start_or_resume_session(
  p_exam_id uuid,
  p_device_info jsonb DEFAULT '{}'::jsonb,
  p_consent_given boolean DEFAULT false,
  p_consent_version text DEFAULT '1.0'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
  v_prof public.profiles;
  e public.exams;
  s public.exam_sessions;
  v_assign public.exam_assignments;
  v_used_attempts integer;
  v_extra_min integer := 0;
  v_accomm jsonb := '{}'::jsonb;
  v_deadline timestamptz;
  v_qorder uuid[];
  v_opt_orders jsonb := '{}'::jsonb;
  rec record;
BEGIN
  PERFORM public._rate_limit('start_session:' || v_uid::text, 15, 60);
  PERFORM public._sweep_expired_sessions(p_exam_id, v_uid);

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_uid;
  SELECT * INTO e FROM public.exams WHERE id = p_exam_id;
  IF NOT FOUND THEN PERFORM public._raise('NOT_FOUND', 'Examination not found.'); END IF;

  -- Check for an existing active in_progress session FIRST (resume after refresh/reconnect)
  SELECT * INTO s FROM public.exam_sessions
   WHERE exam_id = p_exam_id AND student_id = v_uid AND status = 'in_progress'
   FOR UPDATE;

  IF FOUND THEN
    IF e.status = 'ended' OR s.deadline_at <= now() THEN
      PERFORM public._finalize_session(s.id, 'server_expiry', NULL);
      PERFORM public._raise('SESSION_EXPIRED', 'Your examination time has expired and your answers were submitted.');
    END IF;
    UPDATE public.exam_sessions
       SET last_heartbeat_at = now(),
           network_status = 'online',
           updated_at = now()
     WHERE id = s.id RETURNING * INTO s;
    PERFORM public._audit('session.resume', 'exam_session', s.id, '{}'::jsonb);
    RETURN public._build_student_session_payload(s, e);
  END IF;

  -- Starting a brand-new attempt: validate schedule, status, roster, attempts, and explicit consent
  IF e.status <> 'published' THEN
    PERFORM public._raise('EXAM_UNAVAILABLE', 'This examination is not currently open.');
  END IF;
  IF e.starts_at IS NOT NULL AND now() < e.starts_at THEN
    PERFORM public._raise('EXAM_NOT_STARTED', 'This examination has not started yet.');
  END IF;
  IF e.ends_at IS NOT NULL AND now() >= e.ends_at THEN
    PERFORM public._raise('EXAM_EXPIRED', 'The window for starting this examination has closed.');
  END IF;
  IF NOT public._student_is_authorized_for_exam(e, v_uid, v_prof.email) THEN
    PERFORM public._raise('FORBIDDEN', 'Join the examination with a valid code before starting.');
  END IF;
  IF NOT coalesce(p_consent_given, false) THEN
    PERFORM public._raise('CONSENT_REQUIRED', 'Explicit monitoring consent is required before starting the examination.');
  END IF;

  SELECT count(*)::int INTO v_used_attempts
    FROM public.exam_sessions
   WHERE exam_id = p_exam_id AND student_id = v_uid AND status IN ('submitted', 'flagged');

  IF v_used_attempts >= e.max_attempts THEN
    PERFORM public._raise('ATTEMPTS_EXHAUSTED', 'You have already used all permitted attempts for this examination.');
  END IF;

  SELECT * INTO v_assign FROM public.exam_assignments
   WHERE exam_id = p_exam_id AND lower(student_email) = lower(v_prof.email);
  IF FOUND THEN
    v_extra_min := v_assign.extra_time_minutes;
    v_accomm := v_assign.accommodations;
  END IF;

  v_deadline := now() + make_interval(mins => (e.duration_minutes + v_extra_min));
  IF e.ends_at IS NOT NULL AND e.ends_at < v_deadline THEN
    v_deadline := e.ends_at;
  END IF;

  IF e.shuffle_questions THEN
    SELECT array_agg(q.id ORDER BY random()) INTO v_qorder
      FROM public.questions q WHERE q.exam_id = p_exam_id AND q.approved = true;
  ELSE
    SELECT array_agg(q.id ORDER BY q.display_order) INTO v_qorder
      FROM public.questions q WHERE q.exam_id = p_exam_id AND q.approved = true;
  END IF;

  IF v_qorder IS NULL OR cardinality(v_qorder) = 0 THEN
    PERFORM public._raise('EXAM_EMPTY', 'This examination has no questions configured.');
  END IF;

  FOR rec IN
    SELECT q.id, jsonb_array_length(q.options) AS n
      FROM public.questions q WHERE q.exam_id = p_exam_id AND q.approved = true AND jsonb_array_length(q.options) > 0
  LOOP
    IF e.shuffle_options THEN
      v_opt_orders := v_opt_orders || jsonb_build_object(
        rec.id::text,
        to_jsonb(ARRAY(SELECT x FROM generate_series(0, rec.n - 1) x ORDER BY random()))
      );
    ELSE
      v_opt_orders := v_opt_orders || jsonb_build_object(
        rec.id::text,
        to_jsonb(ARRAY(SELECT x FROM generate_series(0, rec.n - 1) x ORDER BY x))
      );
    END IF;
  END LOOP;

  INSERT INTO public.exam_sessions (
    exam_id, student_id, student_email, student_name, attempt_no, status,
    started_at, deadline_at, total_marks, question_order, option_orders,
    last_heartbeat_at, network_status, device_info, consent_given_at,
    consent_version, accommodations
  ) VALUES (
    p_exam_id, v_uid, v_prof.email,
    coalesce(NULLIF(v_prof.full_name, ''), split_part(v_prof.email, '@', 1)),
    v_used_attempts + 1, 'in_progress',
    now(), v_deadline, e.total_marks, v_qorder, v_opt_orders,
    now(), 'online',
    CASE WHEN jsonb_typeof(p_device_info) = 'object' AND pg_column_size(p_device_info) <= 2048
         THEN p_device_info ELSE '{}'::jsonb END,
    now(), public._clean_text(p_consent_version, 20), v_accomm
  ) RETURNING * INTO s;

  PERFORM public._audit('session.start', 'exam_session', s.id,
    jsonb_build_object('exam_id', p_exam_id, 'attempt_no', s.attempt_no));
  RETURN public._build_student_session_payload(s, e);
END $$;

-- Internal helper to apply a batch of answers safely (used by both save and final submit)
CREATE OR REPLACE FUNCTION public._apply_student_answers(p_session public.exam_sessions, p_answers jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  item jsonb;
  v_qid uuid;
  v_q public.questions;
  v_sel integer[];
  v_txt text;
  v_marked boolean;
  v_rev bigint;
  v_saved integer := 0;
  v_n integer;
BEGIN
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'array' THEN RETURN 0; END IF;
  IF jsonb_array_length(p_answers) > 250 THEN
    PERFORM public._raise('INVALID_INPUT', 'Too many answers in a single batch.');
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_answers) LOOP
    v_qid := (item ->> 'question_id')::uuid;
    SELECT * INTO v_q FROM public.questions
     WHERE id = v_qid AND exam_id = p_session.exam_id AND approved = true;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_marked := coalesce((item ->> 'marked_for_review')::boolean, false);
    v_rev := greatest(1, coalesce((item ->> 'revision')::bigint, 1));

    IF v_q.question_type = 'descriptive' THEN
      v_sel := NULL;
      v_txt := public._clean_text(item ->> 'answer_text', 20000);
    ELSE
      v_txt := NULL;
      v_n := jsonb_array_length(v_q.options);
      IF jsonb_typeof(item -> 'selected_options') = 'array' THEN
        SELECT coalesce(array_agg(DISTINCT x::int ORDER BY x::int), '{}'::int[]) INTO v_sel
          FROM jsonb_array_elements_text(item -> 'selected_options') x
         WHERE x::int >= 0 AND x::int < v_n;
      ELSIF (item ->> 'selected_option') IS NOT NULL THEN
        IF (item ->> 'selected_option')::int BETWEEN 0 AND v_n - 1 THEN
          v_sel := ARRAY[(item ->> 'selected_option')::int];
        ELSE
          v_sel := '{}'::int[];
        END IF;
      ELSE
        v_sel := '{}'::int[];
      END IF;
      IF v_q.question_type <> 'multi_select' AND cardinality(v_sel) > 1 THEN
        v_sel := ARRAY[v_sel[1]];
      END IF;
    END IF;

    INSERT INTO public.student_answers (
      session_id, question_id, selected_option, selected_options, answer_text,
      marked_for_review, revision, answered_at, updated_at
    ) VALUES (
      p_session.id, v_qid,
      CASE WHEN v_sel IS NOT NULL AND cardinality(v_sel) > 0 THEN v_sel[1] ELSE NULL END,
      v_sel, v_txt, v_marked, v_rev, now(), now()
    )
    ON CONFLICT (session_id, question_id) DO UPDATE
      SET selected_option = EXCLUDED.selected_option,
          selected_options = EXCLUDED.selected_options,
          answer_text = EXCLUDED.answer_text,
          marked_for_review = EXCLUDED.marked_for_review,
          revision = EXCLUDED.revision,
          answered_at = now(),
          updated_at = now()
      -- Monotonic revision prevents stale out-of-order offline retries overwriting newer edits
      WHERE EXCLUDED.revision >= public.student_answers.revision;

    v_saved := v_saved + 1;
  END LOOP;
  RETURN v_saved;
END $$;

CREATE OR REPLACE FUNCTION public.student_save_answers(
  p_session_id uuid,
  p_answers jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
  s public.exam_sessions;
  v_saved integer;
BEGIN
  PERFORM public._rate_limit('save_ans:' || v_uid::text, 120, 60);
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id AND student_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._raise('FORBIDDEN', 'Session not found or access denied.'); END IF;

  IF s.status <> 'in_progress' THEN
    RETURN jsonb_build_object(
      'saved', 0, 'session_status', s.status, 'server_now', now(), 'deadline_at', s.deadline_at
    );
  END IF;

  IF now() > s.deadline_at + interval '5 seconds' THEN
    s := public._finalize_session(s.id, 'server_expiry', NULL);
    RETURN jsonb_build_object(
      'saved', 0, 'session_status', s.status, 'server_now', now(), 'deadline_at', s.deadline_at
    );
  END IF;

  v_saved := public._apply_student_answers(s, p_answers);
  UPDATE public.exam_sessions
     SET last_heartbeat_at = now(),
         network_status = 'online',
         time_used_seconds = greatest(0, coalesce(extract(epoch FROM (now() - s.started_at))::int, 0)),
         updated_at = now()
   WHERE id = s.id;

  RETURN jsonb_build_object(
    'saved', v_saved,
    'session_status', 'in_progress',
    'server_now', now(),
    'deadline_at', s.deadline_at,
    'remaining_seconds', greatest(0, floor(extract(epoch FROM (s.deadline_at - now())))::int)
  );
END $$;

CREATE OR REPLACE FUNCTION public.student_heartbeat(
  p_session_id uuid,
  p_camera text DEFAULT 'unknown',
  p_mic text DEFAULT 'unknown',
  p_screen text DEFAULT 'unknown',
  p_network text DEFAULT 'online'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
  s public.exam_sessions;
  v_cam text := CASE WHEN p_camera IN ('ok','lost','denied','off','unknown') THEN p_camera ELSE 'unknown' END;
  v_mic text := CASE WHEN p_mic IN ('ok','lost','denied','off','unknown') THEN p_mic ELSE 'unknown' END;
  v_scr text := CASE WHEN p_screen IN ('ok','lost','denied','off','unknown') THEN p_screen ELSE 'unknown' END;
  v_net text := CASE WHEN p_network IN ('online','offline','unknown') THEN p_network ELSE 'online' END;
BEGIN
  PERFORM public._rate_limit('hb:' || v_uid::text, 60, 60);
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id AND student_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._raise('FORBIDDEN', 'Session not found.'); END IF;

  IF s.status = 'in_progress' AND now() >= s.deadline_at THEN
    s := public._finalize_session(s.id, 'server_expiry', NULL);
  ELSIF s.status = 'in_progress' THEN
    UPDATE public.exam_sessions
       SET last_heartbeat_at = now(),
           camera_status = v_cam,
           mic_status = v_mic,
           screen_status = v_scr,
           network_status = v_net,
           time_used_seconds = greatest(0, coalesce(extract(epoch FROM (now() - s.started_at))::int, 0)),
           updated_at = now()
     WHERE id = s.id RETURNING * INTO s;
  END IF;

  RETURN jsonb_build_object(
    'server_now', now(),
    'session_status', s.status,
    'deadline_at', s.deadline_at,
    'remaining_seconds', greatest(0, floor(extract(epoch FROM (s.deadline_at - now())))::int),
    'warnings', coalesce((
      SELECT jsonb_agg(to_jsonb(pw) ORDER BY pw.created_at DESC)
        FROM public.proctor_warnings pw
       WHERE pw.session_id = s.id AND pw.acknowledged_at IS NULL
    ), '[]'::jsonb)
  );
END $$;

CREATE OR REPLACE FUNCTION public._format_student_result(p_session public.exam_sessions, p_exam public.exams, p_include_breakdown boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_visible boolean := (p_exam.results_published OR p_exam.show_results_immediately);
  v_breakdown jsonb := '[]'::jsonb;
BEGIN
  -- Detailed answer key & explanations are ONLY exposed after explicit teacher result publication
  IF p_include_breakdown AND p_exam.results_published THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'question_id', q.id,
      'display_order', q.display_order,
      'section', q.section,
      'question_type', q.question_type,
      'question_text', q.question_text,
      'options', q.options,
      'marks', q.marks,
      'correct_options', q.correct_options,
      'explanation', q.explanation,
      'selected_options', sa.selected_options,
      'answer_text', sa.answer_text,
      'is_correct', sa.is_correct,
      'awarded_marks', sa.awarded_marks,
      'feedback', sa.feedback
    ) ORDER BY q.display_order), '[]'::jsonb)
    INTO v_breakdown
    FROM public.questions q
    LEFT JOIN public.student_answers sa ON sa.session_id = p_session.id AND sa.question_id = q.id
    WHERE q.exam_id = p_exam.id AND q.approved = true;
  END IF;

  RETURN jsonb_build_object(
    'session_id', p_session.id,
    'exam_id', p_exam.id,
    'exam_title', p_exam.title,
    'course_code', p_exam.course_code,
    'course_name', p_exam.course_name,
    'status', p_session.status,
    'submitted_at', p_session.submitted_at,
    'time_used_seconds', p_session.time_used_seconds,
    'total_questions', p_exam.total_questions,
    'total_marks', p_session.total_marks,
    'pass_percentage', p_exam.pass_percentage,
    'proctoring_flags', p_session.proctoring_flags,
    'grading_status', p_session.grading_status,
    'results_published', p_exam.results_published,
    'results_visible', v_visible,
    'score', CASE WHEN v_visible THEN p_session.score ELSE NULL END,
    'percentage', CASE WHEN v_visible THEN p_session.percentage ELSE NULL END,
    'correct_answers', CASE WHEN v_visible THEN p_session.correct_answers ELSE NULL END,
    'passed', CASE WHEN v_visible THEN p_session.passed ELSE NULL END,
    'breakdown', v_breakdown
  );
END $$;

CREATE OR REPLACE FUNCTION public.student_submit_exam(
  p_session_id uuid,
  p_idempotency_key uuid DEFAULT NULL,
  p_final_answers jsonb DEFAULT NULL,
  p_submitted_via text DEFAULT 'student'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
  s public.exam_sessions;
  e public.exams;
  v_via text := CASE WHEN p_submitted_via IN ('student', 'timeout') THEN p_submitted_via ELSE 'student' END;
BEGIN
  PERFORM public._rate_limit('submit_exam:' || v_uid::text, 20, 60);
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id AND student_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._raise('FORBIDDEN', 'Session not found or access denied.'); END IF;
  SELECT * INTO e FROM public.exams WHERE id = s.exam_id;

  IF s.status = 'in_progress' THEN
    -- Accept final buffered answers only within the server deadline (+5s network flight grace)
    IF p_final_answers IS NOT NULL AND now() <= s.deadline_at + interval '5 seconds' THEN
      PERFORM public._apply_student_answers(s, p_final_answers);
    END IF;
    s := public._finalize_session(s.id, v_via, p_idempotency_key);
  END IF;

  RETURN public._format_student_result(s, e, false);
END $$;

CREATE OR REPLACE FUNCTION public.student_get_result(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
  s public.exam_sessions;
  e public.exams;
BEGIN
  SELECT * INTO s FROM public.exam_sessions WHERE id = p_session_id AND student_id = v_uid;
  IF NOT FOUND THEN PERFORM public._raise('FORBIDDEN', 'Result not found or access denied.'); END IF;
  IF s.status NOT IN ('submitted', 'flagged') THEN
    PERFORM public._raise('CONFLICT', 'Examination has not been submitted yet.');
  END IF;
  SELECT * INTO e FROM public.exams WHERE id = s.exam_id;
  RETURN public._format_student_result(s, e, true);
END $$;

CREATE OR REPLACE FUNCTION public.student_list_results()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(public._format_student_result(s, e, false) ORDER BY s.submitted_at DESC NULLS LAST)
      FROM public.exam_sessions s
      JOIN public.exams e ON e.id = s.exam_id
     WHERE s.student_id = v_uid AND s.status IN ('submitted', 'flagged')
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.student_acknowledge_warning(p_warning_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid uuid := public._require_student();
BEGIN
  UPDATE public.proctor_warnings
     SET acknowledged_at = coalesce(acknowledged_at, now())
   WHERE id = p_warning_id AND student_id = v_uid;
  RETURN jsonb_build_object('acknowledged', true);
END $$;
