/*
# SmartExam Database Schema

## Overview
Creates the complete database schema for the SmartExam online examination platform.
Includes tables for exams, questions, student exam sessions, student answers,
and proctoring events. Seeded with the CS 401 exam and sample student sessions.

## New Tables
1. `exams` — Exam definitions (title, course, duration, marks, status, instructions).
2. `questions` — MCQ questions for an exam (text, options JSONB, correct answer, marks, section).
3. `exam_sessions` — Student exam attempts (status, timestamps, score, proctoring flags).
4. `student_answers` — Individual answers selected during a session.
5. `proctoring_events` — Proctoring flags recorded during a session.

## Security
- RLS enabled on all tables.
- Policies use `TO anon, authenticated` because the frontend currently uses mock auth.
- All CRUD operations allowed for anon + authenticated.

## Notes
- `questions.options` is a JSONB array of option strings.
- `questions.correct_answer` is a zero-indexed integer matching the options array.
- `exam_sessions.status`: 'not_started', 'in_progress', 'submitted', 'flagged'.
- `proctoring_events.event_type`: 'tab_switch', 'face_not_detected', 'multiple_faces', 'audio_detected', 'fullscreen_exit', 'browser_exit'.
- Seed data includes the CS 401 exam with 15 questions and 8 sample student sessions.
*/

-- ===== EXAMS TABLE =====
CREATE TABLE IF NOT EXISTS exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  course_code text NOT NULL,
  course_name text NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 90,
  total_questions integer NOT NULL DEFAULT 0,
  total_marks integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  instructions text[] NOT NULL DEFAULT '{}',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE exams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_exams" ON exams;
CREATE POLICY "anon_select_exams" ON exams FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_exams" ON exams;
CREATE POLICY "anon_insert_exams" ON exams FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_exams" ON exams;
CREATE POLICY "anon_update_exams" ON exams FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_exams" ON exams;
CREATE POLICY "anon_delete_exams" ON exams FOR DELETE
  TO anon, authenticated USING (true);

-- ===== QUESTIONS TABLE =====
CREATE TABLE IF NOT EXISTS questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  section text NOT NULL,
  question_text text NOT NULL,
  options jsonb NOT NULL,
  correct_answer integer NOT NULL,
  marks integer NOT NULL DEFAULT 1,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_questions" ON questions;
CREATE POLICY "anon_select_questions" ON questions FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_questions" ON questions;
CREATE POLICY "anon_insert_questions" ON questions FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_questions" ON questions;
CREATE POLICY "anon_update_questions" ON questions FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_questions" ON questions;
CREATE POLICY "anon_delete_questions" ON questions FOR DELETE
  TO anon, authenticated USING (true);

-- ===== EXAM_SESSIONS TABLE =====
CREATE TABLE IF NOT EXISTS exam_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_email text NOT NULL,
  student_name text NOT NULL,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'submitted', 'flagged')),
  started_at timestamptz,
  submitted_at timestamptz,
  time_used_seconds integer NOT NULL DEFAULT 0,
  score numeric NOT NULL DEFAULT 0,
  total_marks integer NOT NULL DEFAULT 0,
  percentage numeric NOT NULL DEFAULT 0,
  correct_answers integer NOT NULL DEFAULT 0,
  proctoring_flags integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE exam_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_sessions" ON exam_sessions;
CREATE POLICY "anon_select_sessions" ON exam_sessions FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_sessions" ON exam_sessions;
CREATE POLICY "anon_insert_sessions" ON exam_sessions FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_sessions" ON exam_sessions;
CREATE POLICY "anon_update_sessions" ON exam_sessions FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_sessions" ON exam_sessions;
CREATE POLICY "anon_delete_sessions" ON exam_sessions FOR DELETE
  TO anon, authenticated USING (true);

-- ===== STUDENT_ANSWERS TABLE =====
CREATE TABLE IF NOT EXISTS student_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected_option integer,
  answered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, question_id)
);

ALTER TABLE student_answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_answers" ON student_answers;
CREATE POLICY "anon_select_answers" ON student_answers FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_answers" ON student_answers;
CREATE POLICY "anon_insert_answers" ON student_answers FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_answers" ON student_answers;
CREATE POLICY "anon_update_answers" ON student_answers FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_answers" ON student_answers;
CREATE POLICY "anon_delete_answers" ON student_answers FOR DELETE
  TO anon, authenticated USING (true);

-- ===== PROCTORING_EVENTS TABLE =====
CREATE TABLE IF NOT EXISTS proctoring_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('tab_switch', 'face_not_detected', 'multiple_faces', 'audio_detected', 'fullscreen_exit', 'browser_exit')),
  description text,
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE proctoring_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_events" ON proctoring_events;
CREATE POLICY "anon_select_events" ON proctoring_events FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_events" ON proctoring_events;
CREATE POLICY "anon_insert_events" ON proctoring_events FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_events" ON proctoring_events;
CREATE POLICY "anon_update_events" ON proctoring_events FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_events" ON proctoring_events;
CREATE POLICY "anon_delete_events" ON proctoring_events FOR DELETE
  TO anon, authenticated USING (true);

-- ===== INDEXES =====
CREATE INDEX IF NOT EXISTS idx_questions_exam_id ON questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_sessions_exam_id ON exam_sessions(exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_sessions_student_email ON exam_sessions(student_email);
CREATE INDEX IF NOT EXISTS idx_student_answers_session_id ON student_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_proctoring_events_session_id ON proctoring_events(session_id);

-- ===== SEED DATA: CS 401 Exam =====
INSERT INTO exams (id, title, course_code, course_name, duration_minutes, total_questions, total_marks, status, instructions)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Data Structures & Algorithms — Final Examination',
  'CS 401',
  'Data Structures & Algorithms',
  90,
  15,
  100,
  'active',
  ARRAY[
    'This examination contains 15 multiple-choice questions divided into 3 sections.',
    'The total duration is 90 minutes. The timer cannot be paused once started.',
    'Each question has exactly one correct answer. There is no negative marking.',
    'You may navigate between questions using the panel on the right.',
    'You can flag questions for review and return to them before submitting.',
    'The exam will auto-submit when the timer reaches zero.',
    'Your webcam, microphone, and screen will be monitored throughout the exam for integrity.',
    'Do not switch browser tabs or open new windows — this will be flagged by the proctoring system.',
    'Ensure you have a stable internet connection before beginning.',
    'Any attempt to leave full-screen mode will be recorded and reported.'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ===== SEED DATA: Questions =====
INSERT INTO questions (exam_id, section, question_text, options, correct_answer, marks, display_order) VALUES
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section A — Fundamentals', 'What is the time complexity of inserting an element at the beginning of a singly linked list?', '["O(1)", "O(n)", "O(log n)", "O(n log n)"]'::jsonb, 0, 5, 1),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section A — Fundamentals', 'Which data structure uses the LIFO (Last-In-First-Out) principle?', '["Queue", "Stack", "Linked List", "Binary Tree"]'::jsonb, 1, 5, 2),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section A — Fundamentals', 'What is the minimum number of stacks needed to implement a queue?', '["1", "2", "3", "4"]'::jsonb, 1, 5, 3),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section A — Fundamentals', 'In a binary search tree, which traversal yields elements in sorted order?', '["Pre-order", "Post-order", "In-order", "Level-order"]'::jsonb, 2, 5, 4),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section A — Fundamentals', 'What is the space complexity of an adjacency matrix representation of a graph with V vertices?', '["O(V)", "O(E)", "O(V²)", "O(V + E)"]'::jsonb, 2, 5, 5),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section B — Algorithms', 'Which sorting algorithm has an average time complexity of O(n log n) and is not stable?', '["Merge Sort", "Quick Sort", "Bubble Sort", "Insertion Sort"]'::jsonb, 1, 8, 6),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section B — Algorithms', 'What is the worst-case time complexity of QuickSort?', '["O(n log n)", "O(n²)", "O(n)", "O(log n)"]'::jsonb, 1, 8, 7),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section B — Algorithms', 'Which algorithm is used to find the shortest path in a weighted graph with non-negative weights?', '["Dijkstra''s Algorithm", "Bellman-Ford Algorithm", "BFS", "DFS"]'::jsonb, 0, 8, 8),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section B — Algorithms', 'Dynamic programming is most effective when the problem exhibits which property?', '["Only greedy choice property", "Optimal substructure and overlapping subproblems", "Only overlapping subproblems", "Only optimal substructure"]'::jsonb, 1, 8, 9),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section B — Algorithms', 'Which data structure is most efficient for implementing Dijkstra''s algorithm?', '["Array", "Linked List", "Min-Heap / Priority Queue", "Stack"]'::jsonb, 2, 8, 10),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section C — Advanced Concepts', 'What is the amortized time complexity of a dynamic array insertion when resizing doubles capacity?', '["O(n)", "O(log n)", "O(1)", "O(n²)"]'::jsonb, 2, 6, 11),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section C — Advanced Concepts', 'In a Red-Black tree with n nodes, what is the maximum height?', '["log₂(n)", "2 log₂(n + 1)", "n", "n/2"]'::jsonb, 1, 6, 12),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section C — Advanced Concepts', 'Which technique is used to resolve hash table collisions by chaining?', '["Linear probing", "Linked lists at each bucket", "Rehashing the key", "Quadratic probing"]'::jsonb, 1, 6, 13),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section C — Advanced Concepts', 'What is the time complexity of the Union-Find (Disjoint Set) with path compression and union by rank?', '["O(n)", "O(log n)", "O(α(n)) — inverse Ackermann", "O(1)"]'::jsonb, 2, 6, 14),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Section C — Advanced Concepts', 'In a Trie (prefix tree), what is the time complexity of searching for a key of length m?', '["O(m)", "O(m log n)", "O(n)", "O(n × m)"]'::jsonb, 0, 6, 15)
ON CONFLICT DO NOTHING;

-- ===== SEED DATA: Sample exam sessions (submitted students) =====
INSERT INTO exam_sessions (exam_id, student_email, student_name, status, started_at, submitted_at, time_used_seconds, score, total_marks, percentage, correct_answers, proctoring_flags)
VALUES
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'alice@university.edu', 'Alice Johnson', 'submitted', '2026-09-01 14:00:00+00', '2026-09-01 14:32:00+00', 1920, 92, 100, 92, 14, 0),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'bob@university.edu', 'Bob Smith', 'submitted', '2026-09-01 14:00:00+00', '2026-09-01 14:28:00+00', 1680, 78, 100, 78, 12, 0),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'charlie@university.edu', 'Charlie Brown', 'submitted', '2026-09-01 14:00:00+00', '2026-09-01 14:35:00+00', 2100, 65, 100, 65, 10, 2),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'diana@university.edu', 'Diana Prince', 'submitted', '2026-09-01 14:00:00+00', '2026-09-01 14:30:00+00', 1800, 88, 100, 88, 13, 0),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'fiona@university.edu', 'Fiona Green', 'submitted', '2026-09-01 14:00:00+00', '2026-09-01 14:25:00+00', 1500, 95, 100, 95, 14, 0),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'george@university.edu', 'George King', 'flagged', '2026-09-01 14:00:00+00', '2026-09-01 14:40:00+00', 2400, 54, 100, 54, 8, 3),
('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'hannah@university.edu', 'Hannah Lee', 'submitted', '2026-09-01 14:00:00+00', '2026-09-01 14:33:00+00', 1980, 82, 100, 82, 12, 0)
ON CONFLICT DO NOTHING;

-- ===== SEED DATA: In-progress session (separate insert for NULL submitted_at) =====
INSERT INTO exam_sessions (exam_id, student_email, student_name, status, started_at, time_used_seconds, score, total_marks, percentage, correct_answers, proctoring_flags)
VALUES ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'evan@university.edu', 'Evan Wright', 'in_progress', '2026-09-01 14:00:00+00', 0, 0, 100, 0, 0, 0)
ON CONFLICT DO NOTHING;

-- ===== SEED DATA: Proctoring events for flagged sessions =====
INSERT INTO proctoring_events (session_id, event_type, description, severity)
SELECT es.id, 'tab_switch', 'Student switched away from exam tab', 'warning'
FROM exam_sessions es
WHERE es.student_email = 'charlie@university.edu'
AND NOT EXISTS (SELECT 1 FROM proctoring_events pe WHERE pe.session_id = es.id AND pe.event_type = 'tab_switch')
LIMIT 2;

INSERT INTO proctoring_events (session_id, event_type, description, severity)
SELECT es.id, 'tab_switch', 'Student switched away from exam tab', 'warning'
FROM exam_sessions es
WHERE es.student_email = 'george@university.edu'
AND NOT EXISTS (SELECT 1 FROM proctoring_events pe WHERE pe.session_id = es.id AND pe.event_type = 'tab_switch')
LIMIT 1;

INSERT INTO proctoring_events (session_id, event_type, description, severity)
SELECT es.id, 'fullscreen_exit', 'Student exited full-screen mode', 'critical'
FROM exam_sessions es
WHERE es.student_email = 'george@university.edu'
AND NOT EXISTS (SELECT 1 FROM proctoring_events pe WHERE pe.session_id = es.id AND pe.event_type = 'fullscreen_exit')
LIMIT 1;

INSERT INTO proctoring_events (session_id, event_type, description, severity)
SELECT es.id, 'face_not_detected', 'Face not detected in camera feed for 10 seconds', 'warning'
FROM exam_sessions es
WHERE es.student_email = 'george@university.edu'
AND NOT EXISTS (SELECT 1 FROM proctoring_events pe WHERE pe.session_id = es.id AND pe.event_type = 'face_not_detected')
LIMIT 1;
