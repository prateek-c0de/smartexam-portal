# SmartExam — Secure AI-Proctored Online Examination Portal

SmartExam is a full-stack, security-hardened, AI-assisted online examination platform built with **React 18**, **TypeScript**, **Vite**, **Tailwind CSS**, **Supabase (PostgreSQL + Auth + Realtime + Private Storage + Edge Functions)**, **WebRTC**, **MediaPipe Tasks Vision**, and the **Web Audio API**.

---

## 1. Project Overview

SmartExam provides universities and academic institutions with two role-isolated portals while preserving a clean, accessible academic UI:

- **Student Examination Portal**: Email-verified authentication, 8-character examination joining codes, explicit privacy/consent check-in, device & HTTPS verification, camera/microphone/screen permission checks, client-side camera & face framing verification, server-authoritative countdown timers, debounced + offline-resilient answer saving (`MCQ`, `Multiple Select`, `True/False`, `Descriptive`), consent-based WebRTC + AI monitoring, idempotent exam submission, and post-publication performance breakdowns.
- **Faculty & Administration Dashboard**: Trusted faculty account provisioning, full examination lifecycle management (create, edit, draft, publish, manual end, join-code rotation, authorized roster & accessibility accommodations, question/option randomization, negative marking), real-time student status & media health telemetry, live on-demand WebRTC camera/screen/audio inspection, reviewable AI proctoring timelines (dismiss false positives, confirm, add remarks, send live student notices), manual grading for descriptive questions, optional AI draft question paper generation, and CSV / Excel / PDF result & proctoring report exports.

---

## 2. Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 18.3, TypeScript 5.5, Vite 5.4, Tailwind CSS 3.4, Lucide React |
| Backend & Auth | Supabase Auth, PostgreSQL Row Level Security (RLS), `SECURITY DEFINER` RPCs |
| Real-Time & Media | Supabase Realtime (Postgres Changes + Private Broadcast), WebRTC (`RTCPeerConnection`), MediaDevices API, Web Audio API |
| Client-Side AI Proctoring | `@mediapipe/tasks-vision` (`BlazeFace` short-range face detector + `EfficientDet-Lite0` int8 object detector) + Web Audio speech-band (`300–3400 Hz`) analyzer |
| Optional AI Question Authoring | Supabase Edge Function (`supabase/functions/generate-questions`) + Local **Ollama** (`llama3.2:3b` / `qwen2.5:3b`) or Gemini / OpenAI-compatible API |
| Automated QA | Vitest 3, `@electric-sql/pglite` (embedded PostgreSQL 16+), JSDOM, Playwright Chromium |

### Newly Introduced Dependencies & Rationale

| Package | Scope | Why It Is Necessary |
|---|---|---|
| `@mediapipe/tasks-vision` | `dependencies` | Provides genuine, lightweight client-side WASM/CPU `FaceDetector` and `ObjectDetector` models (~230 KB + ~4.4 MB int8) so ordinary student laptops without dedicated GPUs run real face-presence and prohibited-object detection without streaming raw video to servers. |
| `vitest` | `devDependencies` | Fast TypeScript unit and integration test runner. |
| `@electric-sql/pglite` | `devDependencies` | Runs a real embedded PostgreSQL engine in tests to execute and verify every SQL migration, RLS policy, trigger, and `SECURITY DEFINER` RPC without mocks. |
| `jsdom` | `devDependencies` | DOM/Storage environment for frontend security, offline cache, and report-export unit tests. |
| `@playwright/test` | `devDependencies` | Real Chromium browser end-to-end, responsive, offline-recovery, and visual-regression testing. |

---

## 3. System Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                        React + TypeScript SPA (Vite)                       │
│  ┌──────────────────────┐  ┌───────────────────────┐  ┌─────────────────┐  │
│  │ Auth & RBAC Guard    │  │ Reliable Exam Engine  │  │ Teacher Console │  │
│  │ • Strong passwords   │  │ • Server clock offset │  │ • Live Realtime │  │
│  │ • Lockout backoff    │  │ • Debounced auto-save │  │ • Review queue  │  │
│  │ • Route protection   │  │ • Offline localStorage│  │ • Manual grade  │  │
│  └──────────┬───────────┘  └───────────┬───────────┘  └────────┬────────┘  │
│             │                          │                       │           │
│  ┌──────────┴──────────────────────────┴───────────────────────┴────────┐  │
│  │ Consent-Gated Monitoring: MediaPipe Vision + Web Audio + WebRTC P2P  │  │
│  └──────────┬──────────────────────────────────────────────────┬────────┘  │
└─────────────┼──────────────────────────────────────────────────┼───────────┘
              │ HTTPS / WSS (Anon Key + User JWT)                │ P2P SRTP
              ▼                                                  ▼
┌──────────────────────────────────────────────────────────┐  ┌──────────────┐
│                 Supabase Backend Platform                │  │ STUN / TURN  │
│  • Auth (Email verification, password reset, JWT)        │  │ Relay Server │
│  • PostgreSQL + Strict RLS + Validated RPCs (No direct   │  └──────────────┘
│    client table writes; answer keys hidden pre-publish)  │
│  • Realtime (`exam_sessions`, `proctoring_events`,       │
│    private `webrtc:<session_id>` signaling ACLs)         │
│  • Private Storage (`proctoring-evidence`, signed URLs)  │
│  • Edge Function (`generate-questions` -> Ollama / LLM)  │
└──────────────────────────────────────────────────────────┘
```

---

## 4. Folder Structure

```text
project/
├── e2e/
│   ├── smartexam.spec.ts              # End-to-end & visual regression browser suite
│   └── supabaseTestServer.mjs         # PGlite-backed Supabase HTTP harness for E2E
├── public/
│   └── _headers                       # Production HTTP security headers (HSTS, XFO, Permissions-Policy)
├── src/
│   ├── components/
│   │   ├── Button.tsx                 # Design-system button
│   │   ├── CreateExamModal.tsx        # 3-step exam editor + AI draft question generator
│   │   ├── ExamHeader.tsx             # Pre-exam step header
│   │   ├── LiveMonitorModal.tsx       # Teacher on-demand WebRTC live stream viewer
│   │   ├── Logo.tsx                   # SmartExam brand mark
│   │   ├── ProgressBar.tsx            # Progress bar indicator
│   │   ├── QuestionNavigator.tsx      # Section-grouped question palette
│   │   ├── SessionReviewModal.tsx     # Proctoring timeline review & descriptive grading
│   │   └── SubmitModal.tsx            # Idempotent exam submission confirmation modal
│   ├── lib/
│   │   └── supabase.ts                # Hardened Supabase client, service-role guard & error mapper
│   ├── screens/
│   │   ├── DeviceCheck.tsx            # Browser, OS, latency & HTTPS context check
│   │   ├── ExamComplete.tsx           # Publication-gated score ring & question breakdown
│   │   ├── ExamScreen.tsx             # Server-timed exam engine + offline sync + AI/WebRTC proctor
│   │   ├── FaceVerify.tsx             # Genuine MediaPipe camera & single-face framing check
│   │   ├── Instructions.tsx           # Instructions + explicit privacy disclosure & consent
│   │   ├── Landing.tsx                # Landing page
│   │   ├── LoginScreen.tsx            # Sign-in, registration, verification resend & forgot password
│   │   ├── Permissions.tsx            # Webcam, microphone & screen-share authorization
│   │   ├── ResetPasswordScreen.tsx    # Recovery password update screen
│   │   ├── StudentPortalScreen.tsx    # Join-by-code, assigned exams & result history
│   │   └── TeacherDashboard.tsx       # Live telemetry, alerts, grading, analytics & exports
│   ├── services/
│   │   ├── aiProctoringService.ts     # MediaPipe Face/Object detection + Web Audio speech analyzer
│   │   ├── aiQuestionService.ts       # Edge Function + local Ollama question generator client
│   │   ├── api.ts                     # Clean production façade (zero mock fallbacks)
│   │   ├── authService.ts             # Supabase Auth, password strength & login rate-limiting
│   │   ├── examService.ts             # Typed RPC client + server clock offset synchronization
│   │   └── webrtcService.ts           # Session-scoped WebRTC P2P responder & viewer
│   ├── tests/
│   │   ├── helpers/pgHarness.ts       # Embedded PostgreSQL test helper
│   │   ├── database-security.test.ts  # SQL schema, RLS, RBAC, grading & rate-limit tests
│   │   └── frontend-services.test.ts  # Password, redaction, offline store, AI & export tests
│   ├── utils/
│   │   ├── offlineExamStore.ts        # User-scoped localStorage answer queue & revision tracker
│   │   ├── permissions.ts             # Media stream lifecycle, frame capture & formatting helpers
│   │   └── reportExport.ts            # Formula-safe CSV, Excel (.xls) & PDF 1.4 generators
│   ├── App.tsx                        # Auth listener, URL router, RBAC guards & session recovery
│   ├── index.css                      # Tailwind & typography styles
│   ├── main.tsx                       # Application entry point
│   └── types.ts                       # Shared domain models
├── supabase/
│   ├── functions/generate-questions/  # Server-side AI question generator Edge Function
│   └── migrations/                    # Versioned, non-destructive PostgreSQL migrations
├── .env.example                       # Placeholder environment variables
├── playwright.config.ts               # Playwright E2E configuration
├── vite.config.ts                     # Security headers & vendor chunk splitting
└── vitest.config.ts                   # Vitest configuration
```

---

## 5. Installation & Environment Configuration

### Prerequisites
- **Node.js** `>= 20` and **npm** `>= 10`
- A **Supabase** project (Cloud or local `supabase start` via Docker)
- *(Optional)* **Ollama** installed locally (`ollama pull llama3.2:3b`) for local AI draft question generation

### Step 1 — Install Dependencies
```bash
npm install
```

### Step 2 — Configure Environment Variables
Copy `.env.example` to `.env` and fill in your Supabase project URL and public `anon` key:
```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | Yes | Your Supabase project URL (`https://<project-ref>.supabase.co`) |
| `VITE_SUPABASE_ANON_KEY` | Yes | Public `anon` JWT key (**never** place `service_role` here — `src/lib/supabase.ts` actively rejects it) |
| `VITE_STUN_URLS` | Optional | Comma-separated STUN servers (defaults to Google public STUN) |
| `VITE_TURN_URLS` | Recommended in prod | Comma-separated TURN/TURNS relay URLs for symmetric NAT traversal |
| `VITE_TURN_USERNAME` | Conditional | TURN credential username |
| `VITE_TURN_CREDENTIAL` | Conditional | TURN credential secret / ephemeral token |
| `VITE_OLLAMA_BASE_URL` | Optional | Local Ollama URL (`http://127.0.0.1:11434`) |
| `VITE_OLLAMA_MODEL` | Optional | Lightweight Ollama model (`llama3.2:3b` or `qwen2.5:3b`) |
| `VITE_MEDIAPIPE_WASM_ROOT` | Optional | Self-hosted path for MediaPipe WASM files on air-gapped networks |
| `VITE_MEDIAPIPE_FACE_MODEL_URL` | Optional | Self-hosted path for `blaze_face_short_range.tflite` |
| `VITE_MEDIAPIPE_OBJECT_MODEL_URL` | Optional | Self-hosted path for `efficientdet_lite0.tflite` |

---

## 6. Supabase Setup & Database Migrations

Apply all migrations in chronological order (`supabase/migrations/`):

1. `20260923055300_create_smartexam_schema.sql` — Base tables & indexes
2. `20261124100000_auth_profiles_rbac.sql` — Drops permissive `USING (true)` policies, creates `profiles`, `teacher_requests`, `audit_logs`, `rate_limits`, and RBAC helpers
3. `20261124100100_exam_schema.sql` — Non-destructive exam/question/session/proctoring columns, constraints, ownership RLS, and configurable proctoring weights
4. `20261124100200_exam_rpcs.sql` — Server-controlled exam management, join codes, persistent sessions, monotonic answer sync, and grading RPCs
5. `20261124100300_proctoring_realtime_storage.sql` — Server-validated proctoring events, review/warning RPCs, `realtime.messages` channel ACLs, private `proctoring-evidence` bucket, and function `EXECUTE` privilege lockdown

### Applying via Supabase CLI
```bash
supabase link --project-ref <your-project-ref>
supabase db push
```
Or paste each migration file in order into the **Supabase Dashboard → SQL Editor** and run.

### Provisioning the First Administrator / Faculty Account
Self-registration NEVER grants `teacher` or `admin` privileges automatically. Promote your initial administrator in the **Supabase SQL Editor**:
```sql
UPDATE public.profiles
   SET role = 'admin'
 WHERE lower(email) = 'admin@your-university.edu';
```
Once signed in to the **Teacher Portal**, administrators see the **Pending Faculty Provisioning Requests** queue and can approve faculty accounts in one click.

### Enabling Auth Email Verification & Realtime
- In **Supabase Dashboard → Authentication → Providers → Email**, enable **Confirm email** and configure your institutional SMTP server.
- Add `${SITE_URL}/reset-password` to **Authentication → URL Configuration → Redirect URLs**.
- In **Project Settings → Realtime**, enable **Authorize channel access via RLS** (private channels) so `realtime.messages` policies on `webrtc:<session_id>` are enforced.

---

## 7. AI Proctoring & AI Question Generator Setup

### Client-Side AI Proctoring
- Runs automatically in the student's browser using `@mediapipe/tasks-vision` (`CPU` delegate for broad laptop compatibility) and the **Web Audio API**.
- For air-gapped university networks without internet CDN access, host the `@mediapipe/tasks-vision/wasm` directory and `.tflite` model files under `public/models/` and set `VITE_MEDIAPIPE_WASM_ROOT=/models/wasm`, `VITE_MEDIAPIPE_FACE_MODEL_URL=/models/blaze_face_short_range.tflite`, and `VITE_MEDIAPIPE_OBJECT_MODEL_URL=/models/efficientdet_lite0.tflite`.

### Optional AI Question Paper Generator
- **Option A — Local Ollama (zero API keys)**:
  ```bash
  ollama pull llama3.2:3b
  OLLAMA_ORIGINS="*" ollama serve
  ```
- **Option B — Supabase Edge Function (server-side credentials)**:
  ```bash
  supabase secrets set AI_PROVIDER=gemini GEMINI_API_KEY=<your-key>
  supabase functions deploy generate-questions
  ```

---

## 8. WebRTC & TURN Server Configuration

Peer-to-peer WebRTC streams (`webrtc:<session_id>`) negotiate on demand **only** when the owning instructor opens **Live Stream Monitor** for a specific student, capped at ~220 kbps (webcam) and ~380 kbps (screen share). For campus firewalls with symmetric NATs, configure a `coturn` or managed TURN relay in `VITE_TURN_URLS`, `VITE_TURN_USERNAME`, and `VITE_TURN_CREDENTIAL`.

---

## 9. Local Development, Testing & Production Build

```bash
# Start local dev server
npm run dev

# TypeScript check + ESLint
npm run typecheck
npm run lint

# Run PostgreSQL RLS/RBAC/grading tests + frontend unit tests
npm test

# Run full Chromium E2E & visual regression tests
npm run test:e2e

# Create production bundle in dist/
npm run build
npm run preview
```

### Production Deployment
Deploy `dist/` over **HTTPS** (mandatory for `navigator.mediaDevices.getUserMedia` and `getDisplayMedia`). `public/_headers` configures `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, and `Permissions-Policy`.

---

## 10. Security Architecture Summary

1. **Zero Unrestricted RLS**: All `TO anon, authenticated USING (true)` policies are dropped; `anon` has zero table or function privileges.
2. **RPC-Only Mutations**: `INSERT`, `UPDATE`, `DELETE`, and `TRUNCATE` on exam tables are revoked from `authenticated`; all writes pass through input-validated `SECURITY DEFINER` RPCs with `SET search_path = ''` and `audit_logs` entries.
3. **Trusted Role Provisioning**: `handle_new_user()` always assigns `role = 'student'`; `guard_profile_update()` blocks privilege escalation even if column grants are misconfigured.
4. **Answer-Key & Pre-Publication Confidentiality**: Students cannot `SELECT` from `public.questions`; `student_start_or_resume_session` strips `correct_options`, `model_answer`, and `explanation`, and `student_get_result` withholds scores/keys until `exams.results_published = true`.
5. **Anti-Tampering Timer & Idempotent Grading**: Deadlines are enforced on the server (`deadline_at`) and synchronized via server clock offset (`server_now`); duplicate submissions are idempotent and all objective + negative + descriptive totals are calculated server-side.
6. **Privacy-First Proctoring**: Explicit unchecked-by-default consent, no continuous raw video/audio recording, configurable retention purge (`teacher_purge_expired_evidence`), short-lived 120s signed URLs for optional snapshots, and guaranteed media-track shutdown on submission/exit.

---

## 11. Known Limitations & Troubleshooting

- **Browser-Sandbox Scope**: Standard web browsers cannot enumerate OS-level background processes, secondary physical monitors outside a shared screen, or external hardware capture cards. All automated detections are surfaced strictly as **reviewable signals** with configurable weights and cooldowns — never automatic disqualification.
- **Pre-Exam Camera Check**: Confirms live single-person face presence and adequate lighting locally; full biometric identity verification against university ID cards would require an institutional photo-enrollment pipeline.
- **Troubleshooting**:
  - *"Camera/Screen access denied"*: Ensure the site is accessed via `https://` (or `http://localhost`) and check browser site permissions.
  - *"Account profile could not be verified"*: Confirm all 5 SQL migrations in `supabase/migrations/` have been applied to your Supabase project.
  - *"AI provider is currently unreachable"*: Verify `ollama serve` is running with `OLLAMA_ORIGINS="*"` or deploy `supabase/functions/generate-questions`; manual question authoring remains available at all times.
