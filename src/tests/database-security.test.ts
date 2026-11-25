import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createSupabaseLikeDb, runAs } from './helpers/pgHarness';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const TEACHER_A = '00000000-0000-4000-8000-000000000002';
const TEACHER_B = '00000000-0000-4000-8000-000000000003';
const STUDENT_A = '00000000-0000-4000-8000-000000000004';
const STUDENT_B = '00000000-0000-4000-8000-000000000005';

describe('SmartExam PostgreSQL Schema, RLS, RBAC & Exam Engine', () => {
  let db: PGlite;

  async function asUser<T = unknown>(uid: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    return runAs<T>(db, uid, sql, params);
  }

  beforeAll(async () => {
    db = await createSupabaseLikeDb();
    // Create users via auth.users (triggers handle_new_user)
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        ($1, 'admin@university.edu', '{"full_name":"Platform Admin"}'::jsonb),
        ($2, 'prof.ada@university.edu', '{"full_name":"Prof. Ada Lovelace","requested_role":"teacher","institution":"CS Dept","role":"admin"}'::jsonb),
        ($3, 'prof.turing@university.edu', '{"full_name":"Prof. Alan Turing","requested_role":"teacher","institution":"Math Dept"}'::jsonb),
        ($4, 'student.a@university.edu', '{"full_name":"Student Alpha","role":"teacher"}'::jsonb),
        ($5, 'student.b@university.edu', '{"full_name":"Student Beta"}'::jsonb)`,
      [ADMIN_ID, TEACHER_A, TEACHER_B, STUDENT_A, STUDENT_B]
    );

    // Promote ADMIN_ID via DB owner (trusted provisioning)
    await db.query(`UPDATE public.profiles SET role = 'admin' WHERE id = $1`, [ADMIN_ID]);
  });

  afterAll(async () => {
    await db.close();
  });

  it('blocks anonymous access on all application tables and RPCs', async () => {
    await expect(asUser(null, 'SELECT * FROM public.exams')).rejects.toThrow(/permission denied/i);
    await expect(asUser(null, 'SELECT * FROM public.questions')).rejects.toThrow(/permission denied/i);
    await expect(asUser(null, 'SELECT * FROM public.exam_sessions')).rejects.toThrow(/permission denied/i);
    await expect(asUser(null, 'SELECT public.get_my_profile()')).rejects.toThrow(/permission denied/i);
  });

  it('prevents self-role escalation at signup and via direct profile updates', async () => {
    // Even though TEACHER_A & STUDENT_A injected role metadata at signup, both start as student
    const [profA] = await asUser<{ p: { role: string; teacher_request_status: string } }>(
      TEACHER_A,
      'SELECT public.get_my_profile() AS p'
    );
    expect(profA.p.role).toBe('student');
    expect(profA.p.teacher_request_status).toBe('pending');

    const [stuA] = await asUser<{ p: { role: string } }>(STUDENT_A, 'SELECT public.get_my_profile() AS p');
    expect(stuA.p.role).toBe('student');

    // Direct role update by authenticated user is blocked by column privileges & trigger
    await expect(
      asUser(STUDENT_A, `UPDATE public.profiles SET role = 'teacher' WHERE id = $1`, [STUDENT_A])
    ).rejects.toThrow();

    // Student cannot approve teacher requests
    await expect(
      asUser(STUDENT_A, `SELECT public.admin_list_teacher_requests('pending')`)
    ).rejects.toThrow(/Administrator access/i);

    // Admin approves TEACHER_A and TEACHER_B
    const [{ list }] = await asUser<{ list: Array<{ id: string; user_id: string }> }>(
      ADMIN_ID,
      `SELECT public.admin_list_teacher_requests('pending') AS list`
    );
    expect(list.length).toBe(2);
    for (const req of list) {
      await asUser(ADMIN_ID, `SELECT public.admin_review_teacher_request($1, true)`, [req.id]);
    }

    const [promoted] = await asUser<{ p: { role: string } }>(TEACHER_A, 'SELECT public.get_my_profile() AS p');
    expect(promoted.p.role).toBe('teacher');
  });

  let examId = '';
  let joinCode = '';
  let questionIds: string[] = [];
  let sessionId = '';

  it('enforces teacher exam ownership isolation and hides answer keys from students', async () => {
    // Student cannot create exams
    await expect(
      asUser(STUDENT_A, `SELECT public.teacher_save_exam($1::jsonb, '[]'::jsonb, '[]'::jsonb)`, [
        JSON.stringify({ title: 'Hack Exam', course_code: 'HK101', course_name: 'Hacking' }),
      ])
    ).rejects.toThrow(/Teacher access/i);

    // Teacher A creates a multi-type exam with negative marking and assigned roster
    const questions = [
      {
        section: 'Section A â€” Core',
        question_type: 'mcq',
        question_text: 'Time complexity of binary search?',
        options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
        correct_options: [1],
        marks: 4,
        explanation: 'Halves search space each step.',
      },
      {
        section: 'Section A â€” Core',
        question_type: 'multi_select',
        question_text: 'Select all stable sorting algorithms:',
        options: ['Merge Sort', 'Quick Sort', 'Insertion Sort', 'Heap Sort'],
        correct_options: [0, 2],
        marks: 4,
      },
      {
        section: 'Section B â€” Logic',
        question_type: 'true_false',
        question_text: 'A tree with V vertices has V-1 edges.',
        options: ['True', 'False'],
        correct_options: [0],
        marks: 2,
      },
      {
        section: 'Section C â€” Theory',
        question_type: 'descriptive',
        question_text: 'Explain amortized analysis of dynamic arrays.',
        options: [],
        marks: 10,
        model_answer: 'Doubling strategy yields O(1) amortized push.',
      },
    ];

    const [{ exam }] = await asUser<{ exam: { id: string; join_code: string; total_marks: number } }>(
      TEACHER_A,
      `SELECT public.teacher_save_exam($1::jsonb, $2::jsonb, $3::jsonb) AS exam`,
      [
        JSON.stringify({
          title: 'Algorithms Midterm',
          course_code: 'CS 301',
          course_name: 'Algorithms',
          duration_minutes: 45,
          negative_marking_ratio: 0.25,
          pass_percentage: 50,
          max_attempts: 1,
          shuffle_questions: true,
          shuffle_options: true,
          access_mode: 'assigned',
          status: 'published',
        }),
        JSON.stringify(questions),
        JSON.stringify([
          {
            student_email: 'student.a@university.edu',
            extra_time_minutes: 5,
            accommodations: { exempt_voice: true },
          },
        ]),
      ]
    );

    examId = exam.id;
    joinCode = exam.join_code;
    expect(exam.total_marks).toBe(20);
    expect(joinCode).toMatch(/^[A-Z2-9]{8}$/);

    // Teacher B cannot read or modify Teacher A's exam
    const bRows = await asUser(TEACHER_B, `SELECT * FROM public.exams WHERE id = $1`, [examId]);
    expect(bRows.length).toBe(0);
    await expect(
      asUser(TEACHER_B, `SELECT public.teacher_get_exam_detail($1)`, [examId])
    ).rejects.toThrow(/not authorized/i);

    // Student A cannot read `questions` table directly to steal `correct_options`
    const stuQRows = await asUser(STUDENT_A, `SELECT * FROM public.questions WHERE exam_id = $1`, [examId]);
    expect(stuQRows.length).toBe(0);

    // Unassigned Student B cannot join an assigned-only exam even with the valid join code
    const [{ bDenied }] = await asUser<{ bDenied: { ok: boolean; code: string } }>(
      STUDENT_B,
      `SELECT public.student_join_exam_by_code($1) AS "bDenied"`,
      [joinCode]
    );
    expect(bDenied.ok).toBe(false);
    expect(bDenied.code).toBe('NOT_ASSIGNED');

    // Invalid code rejected
    const [{ badCode }] = await asUser<{ badCode: { ok: boolean; code: string } }>(
      STUDENT_A,
      `SELECT public.student_join_exam_by_code('ZZZZ9999') AS "badCode"`
    );
    expect(badCode.ok).toBe(false);
    expect(badCode.code).toBe('INVALID_CODE');

    // Authorized Student A joins and starts session (must give explicit consent)
    await expect(
      asUser(STUDENT_A, `SELECT public.student_start_or_resume_session($1, '{}'::jsonb, false)`, [examId])
    ).rejects.toThrow(/consent is required/i);

    const [{ payload }] = await asUser<{
      payload: {
        session: { id: string; deadline_at: string };
        questions: Array<Record<string, unknown>>;
      };
    }>(STUDENT_A, `SELECT public.student_start_or_resume_session($1, '{"os":"Windows"}'::jsonb, true) AS payload`, [
      examId,
    ]);

    sessionId = payload.session.id;
    questionIds = payload.questions.map((q) => String(q.id));
    expect(questionIds.length).toBe(4);

    // Verify ZERO answer-key fields exist in student payload
    for (const q of payload.questions) {
      expect(q).not.toHaveProperty('correct_answer');
      expect(q).not.toHaveProperty('correct_options');
      expect(q).not.toHaveProperty('model_answer');
      expect(q).not.toHaveProperty('explanation');
    }

    // Refreshing / resuming returns exact same session ID and deadline (no timer reset!)
    const [{ resumed }] = await asUser<{ resumed: { session: { id: string; deadline_at: string } } }>(
      STUDENT_A,
      `SELECT public.student_start_or_resume_session($1, '{}'::jsonb, false) AS resumed`,
      [examId]
    );
    expect(resumed.session.id).toBe(sessionId);
    expect(resumed.session.deadline_at).toBe(payload.session.deadline_at);
  });

  it('validates answer revisions, blocks cross-student tampering, grades server-side & gates answer keys until published', async () => {
    // Map question types from teacher detail so we know which question ID is which
    const [{ detail }] = await asUser<{
      detail: { questions: Array<{ id: string; question_type: string }> };
    }>(TEACHER_A, `SELECT public.teacher_get_exam_detail($1) AS detail`, [examId]);

    const byType = Object.fromEntries(detail.questions.map((q) => [q.question_type, q.id]));

    // Save answers with revision 2 on MCQ (correct: [1])
    await asUser(STUDENT_A, `SELECT public.student_save_answers($1, $2::jsonb)`, [
      sessionId,
      JSON.stringify([
        { question_id: byType.mcq, selected_options: [1], revision: 2 },
        // Multi-select wrong answer ([0, 1] instead of [0, 2]) -> -25% of 4 = -1 mark!
        { question_id: byType.multi_select, selected_options: [0, 1], revision: 1 },
        // True/False correct ([0]) -> +2 marks
        { question_id: byType.true_false, selected_options: [0], revision: 1 },
        // Descriptive answer
        {
          question_id: byType.descriptive,
          answer_text: 'When full, allocate 2x array and copy; total cost across n pushes is < 3n = O(1) amortized.',
          revision: 1,
        },
      ]),
    ]);

    // Stale offline packet (revision 1 on MCQ with wrong option [3]) MUST NOT overwrite revision 2!
    await asUser(STUDENT_A, `SELECT public.student_save_answers($1, $2::jsonb)`, [
      sessionId,
      JSON.stringify([{ question_id: byType.mcq, selected_options: [3], revision: 1 }]),
    ]);

    // Student B cannot read/write Student A's answers or session
    await expect(
      asUser(STUDENT_B, `SELECT public.student_save_answers($1, '[]'::jsonb)`, [sessionId])
    ).rejects.toThrow(/access denied/i);
    await expect(
      asUser(STUDENT_A, `UPDATE public.exam_sessions SET score = 100 WHERE id = $1`, [sessionId])
    ).rejects.toThrow(/permission denied/i);

    // Proctoring events:
    // 1. Low-confidence phone detection (0.30 < 0.55) rejected
    const [{ evLow }] = await asUser<{ evLow: { accepted: boolean; reason: string } }>(
      STUDENT_A,
      `SELECT public.student_record_proctoring_event($1, 'phone_detected', 'Phone?', 0.30, 2000) AS "evLow"`,
      [sessionId]
    );
    expect(evLow.accepted).toBe(false);

    // 2. High-confidence phone detection (0.88) accepted (weight 20) + second call within cooldown deduplicated
    const [{ ev1 }] = await asUser<{
      ev1: { accepted: boolean; deduplicated: boolean; event: { id: string }; proctoring_flags: number; integrity_score: number };
    }>(
      STUDENT_A,
      `SELECT public.student_record_proctoring_event($1, 'phone_detected', 'Mobile phone visible', 0.88, 2500) AS ev1`,
      [sessionId]
    );
    expect(ev1.accepted).toBe(true);
    expect(ev1.deduplicated).toBe(false);
    expect(ev1.proctoring_flags).toBe(1);
    expect(Number(ev1.integrity_score)).toBe(20);

    const [{ ev2 }] = await asUser<{ ev2: { deduplicated: boolean; proctoring_flags: number } }>(
      STUDENT_A,
      `SELECT public.student_record_proctoring_event($1, 'phone_detected', 'Mobile phone visible', 0.91, 3000) AS ev2`,
      [sessionId]
    );
    expect(ev2.deduplicated).toBe(true);
    expect(ev2.proctoring_flags).toBe(1);

    // 3. Accommodated voice event (`exempt_voice: true` on Student A) is classified as info (0 flags added)
    const [{ evVoice }] = await asUser<{ evVoice: { proctoring_flags: number } }>(
      STUDENT_A,
      `SELECT public.student_record_proctoring_event($1, 'voice_activity', 'Speech', 0.85, 5000) AS "evVoice"`,
      [sessionId]
    );
    expect(evVoice.proctoring_flags).toBe(1);

    // WebRTC channel authorization: Student A + Teacher A allowed; Student B + Teacher B denied
    const [{ okStu }] = await asUser<{ okStu: boolean }>(
      STUDENT_A,
      `SELECT public.can_access_webrtc_channel($1) AS "okStu"`,
      [`webrtc:${sessionId}`]
    );
    const [{ okTch }] = await asUser<{ okTch: boolean }>(
      TEACHER_A,
      `SELECT public.can_access_webrtc_channel($1) AS "okTch"`,
      [`webrtc:${sessionId}`]
    );
    const [{ badStu }] = await asUser<{ badStu: boolean }>(
      STUDENT_B,
      `SELECT public.can_access_webrtc_channel($1) AS "badStu"`,
      [`webrtc:${sessionId}`]
    );
    const [{ badTch }] = await asUser<{ badTch: boolean }>(
      TEACHER_B,
      `SELECT public.can_access_webrtc_channel($1) AS "badTch"`,
      [`webrtc:${sessionId}`]
    );
    expect(okStu).toBe(true);
    expect(okTch).toBe(true);
    expect(badStu).toBe(false);
    expect(badTch).toBe(false);

    // Teacher dismisses false-positive phone event -> flags drop to 0!
    await asUser(TEACHER_A, `SELECT public.teacher_review_proctoring_event($1, 'dismissed', 'Calculator approved')`, [
      ev1.event.id,
    ]);

    // Submit exam (idempotent across duplicate calls!)
    const idemKey = '11111111-2222-4333-8444-555555555555';
    const [{ sub1 }] = await asUser<{
      sub1: { results_visible: boolean; score: number | null; breakdown: unknown[]; proctoring_flags: number };
    }>(STUDENT_A, `SELECT public.student_submit_exam($1, $2::uuid, NULL, 'student') AS sub1`, [sessionId, idemKey]);

    const [{ sub2 }] = await asUser<{ sub2: { status: string } }>(
      STUDENT_A,
      `SELECT public.student_submit_exam($1, $2::uuid, NULL, 'student') AS sub2`,
      [sessionId, idemKey]
    );
    expect(sub2.status).toBe('submitted');
    expect(sub1.proctoring_flags).toBe(0);
    // Before publication, scores and answer keys are hidden!
    expect(sub1.results_visible).toBe(false);
    expect(sub1.score).toBeNull();
    expect(sub1.breakdown).toEqual([]);

    // Second attempt blocked by max_attempts = 1
    await expect(
      asUser(STUDENT_A, `SELECT public.student_start_or_resume_session($1, '{}'::jsonb, true)`, [examId])
    ).rejects.toThrow(/used all permitted attempts/i);

    // Teacher grades descriptive question (8 / 10 marks) and publishes results
    // Expected total: MCQ (+4) + MultiSelect (-1) + TrueFalse (+2) + Descriptive (+8) = 13 / 20 (65%, PASSED)
    const [{ sDetail }] = await asUser<{
      sDetail: { answers: Array<{ question_type: string; answer_id: string }> };
    }>(TEACHER_A, `SELECT public.teacher_get_session_detail($1) AS "sDetail"`, [sessionId]);
    const descAns = sDetail.answers.find((a) => a.question_type === 'descriptive')!;

    await asUser(TEACHER_A, `SELECT public.teacher_grade_descriptive_answer($1, 8, 'Clear amortized proof.')`, [
      descAns.answer_id,
    ]);
    await asUser(TEACHER_A, `SELECT public.teacher_publish_results($1, true)`, [examId]);

    // Now Student A can view score AND full breakdown!
    const [{ pubRes }] = await asUser<{
      pubRes: {
        results_visible: boolean;
        score: number;
        total_marks: number;
        percentage: number;
        passed: boolean;
        grading_status: string;
        breakdown: unknown[];
      };
    }>(STUDENT_A, `SELECT public.student_get_result($1) AS "pubRes"`, [sessionId]);

    expect(pubRes.results_visible).toBe(true);
    expect(Number(pubRes.score)).toBe(13);
    expect(pubRes.total_marks).toBe(20);
    expect(Number(pubRes.percentage)).toBe(65);
    expect(pubRes.passed).toBe(true);
    expect(pubRes.grading_status).toBe('graded');
    expect(pubRes.breakdown.length).toBe(4);
  });

  it('handles empty teacher dashboards, simultaneous sessions, server timer expiry & brute-force rate limits', async () => {
    // 1. Empty dashboard for Teacher B (0 exams) returns clean empty lists without fake rows
    const [{ emptyDash }] = await asUser<{
      emptyDash: { exams: unknown[]; sessions: unknown[]; pending_alerts: number };
    }>(TEACHER_B, `SELECT public.teacher_get_dashboard(NULL) AS "emptyDash"`);
    expect(emptyDash.exams).toEqual([]);
    expect(emptyDash.sessions).toEqual([]);
    expect(emptyDash.pending_alerts).toBe(0);

    // 2. Teacher B creates an open-code exam; Student A & Student B attend simultaneously
    const [{ openExam }] = await asUser<{ openExam: { id: string; join_code: string } }>(
      TEACHER_B,
      `SELECT public.teacher_save_exam($1::jsonb, $2::jsonb, '[]'::jsonb) AS "openExam"`,
      [
        JSON.stringify({
          title: 'Concurrent Quiz',
          course_code: 'MA 201',
          course_name: 'Discrete Math',
          duration_minutes: 30,
          access_mode: 'code',
          status: 'published',
        }),
        JSON.stringify([
          {
            section: 'Part 1',
            question_type: 'mcq',
            question_text: '2 + 2 = ?',
            options: ['3', '4', '5'],
            correct_options: [1],
            marks: 10,
          },
        ]),
      ]
    );

    await asUser(STUDENT_A, `SELECT public.student_join_exam_by_code($1)`, [openExam.join_code]);
    await asUser(STUDENT_B, `SELECT public.student_join_exam_by_code($1)`, [openExam.join_code]);

    const [{ sessA }] = await asUser<{ sessA: { session: { id: string }; questions: Array<{ id: string }> } }>(
      STUDENT_A,
      `SELECT public.student_start_or_resume_session($1, '{}'::jsonb, true) AS "sessA"`,
      [openExam.id]
    );
    const [{ sessB }] = await asUser<{ sessB: { session: { id: string } } }>(
      STUDENT_B,
      `SELECT public.student_start_or_resume_session($1, '{}'::jsonb, true) AS "sessB"`,
      [openExam.id]
    );
    expect(sessA.session.id).not.toBe(sessB.session.id);

    // 3. Simulate Student A's server deadline expiring in the past (client timer manipulation attempt)
    await db.query(
      `UPDATE public.exam_sessions SET deadline_at = now() - interval '20 seconds' WHERE id = $1`,
      [sessA.session.id]
    );
    const [{ lateSave }] = await asUser<{ lateSave: { saved: number; session_status: string } }>(
      STUDENT_A,
      `SELECT public.student_save_answers($1, $2::jsonb) AS "lateSave"`,
      [
        sessA.session.id,
        JSON.stringify([{ question_id: sessA.questions[0].id, selected_options: [1], revision: 5 }]),
      ]
    );
    // Late answer after deadline+5s grace is rejected and session is auto-submitted by server!
    expect(lateSave.saved).toBe(0);
    expect(lateSave.session_status).toBe('submitted');

    // 4. Teacher B manually ends the exam -> Student B's active session is auto-finalized!
    await asUser(TEACHER_B, `SELECT public.teacher_set_exam_status($1, 'ended')`, [openExam.id]);
    const [{ bRes }] = await asUser<{ bRes: { status: string } }>(
      STUDENT_B,
      `SELECT public.student_get_result($1) AS "bRes"`,
      [sessB.session.id]
    );
    expect(bRes.status).toBe('submitted');

    // 5. Brute-force join code rate limiting (max 10 attempts per 5 minutes)
    let rateLimited = false;
    for (let i = 0; i < 12; i++) {
      try {
        await asUser(STUDENT_B, `SELECT public.student_join_exam_by_code('BADCODE2')`);
      } catch (err) {
        if (/Too many requests/i.test(String(err))) {
          rateLimited = true;
          break;
        }
      }
    }
    expect(rateLimited).toBe(true);
  });
});
