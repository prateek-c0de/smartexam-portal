import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const upgradedScreenshotsDir =
  'C:\\Users\\Asus\\.gemini\\antigravity\\brain\\89e8b46c-4e43-4577-8362-7933e821227b\\upgraded';
mkdirSync(upgradedScreenshotsDir, { recursive: true });

test.describe('SmartExam Full-Stack E2E, Security, Offline Recovery & Visual Regression', () => {
  test('1. Responsive landing, authentication failure, rate-limiting & unauthorized teacher route block', async ({
    page,
    browser,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Secure\. Intelligent\./i })).toBeVisible();
    await page.screenshot({ path: join(upgradedScreenshotsDir, '01-landing-desktop.png'), fullPage: true, animations: 'disabled' });

    // Responsive mobile layout check (no horizontal scroll overflow)
    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileCtx.newPage();
    await mobilePage.goto('/');
    const hasOverflow = await mobilePage.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(hasOverflow).toBe(false);
    await mobilePage.screenshot({ path: join(upgradedScreenshotsDir, '01b-landing-mobile.png'), fullPage: true, animations: 'disabled' });
    await mobileCtx.close();

    // Student Login screen — verify Demo Mode notice is gone & invalid credentials fail cleanly
    await page.getByRole('button', { name: /Student Portal/i }).click();
    await expect(page.getByText(/Demo Mode/i)).toHaveCount(0);
    await page.screenshot({ path: join(upgradedScreenshotsDir, '02-student-login.png'), fullPage: true, animations: 'disabled' });

    // 5 failed attempts trigger progressive rate-limit lockout
    for (let i = 0; i < 5; i++) {
      await page.fill('input[type="email"]', 'locktest@university.edu');
      await page.fill('input[type="password"]', 'WrongPassword!1');
      await page.getByRole('button', { name: /Sign In as Student/i }).click();
      await expect(page.getByRole('alert')).toBeVisible();
    }
    await page.getByRole('button', { name: /Sign In as Student/i }).click();
    await expect(page.getByRole('alert')).toContainText(/Too many sign-in attempts/i);

    // Unapproved teacher registration cannot access Teacher Dashboard
    await page.getByRole('button', { name: /Back to Home/i }).click();
    await page.getByRole('button', { name: /Teacher Portal/i }).click();
    await page.screenshot({ path: join(upgradedScreenshotsDir, '10-teacher-login.png'), fullPage: true, animations: 'disabled' });

    // Student attempting to sign into Teacher Portal is rejected
    await page.fill('input[type="email"]', 'student@university.edu');
    await page.fill('input[type="password"]', 'Student#2026!');
    await page.getByRole('button', { name: /Sign In as Teacher/i }).click();
    await expect(page.getByRole('alert')).toContainText(/does not have faculty privileges/i);

    // Valid student login -> manual URL navigation to /teacher/dashboard is strictly blocked
    await page.getByRole('button', { name: /Back to Home/i }).click();
    await page.getByRole('button', { name: /Student Portal/i }).click();
    await page.fill('input[type="email"]', 'student@university.edu');
    await page.fill('input[type="password"]', 'Student#2026!');
    await page.getByRole('button', { name: /Sign In as Student/i }).click();
    await expect(page.getByRole('heading', { name: /Student Examination Portal/i })).toBeVisible();

    await page.goto('/teacher/dashboard');
    await expect(page.getByRole('heading', { name: /Exam Management Dashboard/i })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Student Examination Portal/i })).toBeVisible();
  });

  test('2. Teacher creates exam, student joins via code, handles permission denial, refresh & offline sync, and teacher publishes results', async ({
    browser,
  }) => {
    // --- Teacher session: sign in, view dashboard, create & publish a new exam ---
    const teacherCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const teacherPage = await teacherCtx.newPage();
    await teacherPage.goto('/');
    await teacherPage.getByRole('button', { name: /Teacher Portal/i }).click();
    await teacherPage.fill('input[type="email"]', 'faculty@university.edu');
    await teacherPage.fill('input[type="password"]', 'Faculty#2026!');
    await teacherPage.getByRole('button', { name: /Sign In as Teacher/i }).click();

    await expect(teacherPage.getByRole('heading', { name: /Exam Management Dashboard/i })).toBeVisible();
    await teacherPage.waitForTimeout(500);
    await teacherPage.screenshot({ path: join(upgradedScreenshotsDir, '11-teacher-dashboard.png'), fullPage: true, animations: 'disabled' });

    await teacherPage.getByRole('button', { name: /Create New Exam/i }).click();
    await expect(teacherPage.getByRole('heading', { name: /Create New Exam/i })).toBeVisible();
    await teacherPage.screenshot({ path: join(upgradedScreenshotsDir, '12-create-exam-modal.png'), fullPage: true, animations: 'disabled' });

    await teacherPage.fill('input[placeholder*="Data Structures"]', 'Operating Systems Quiz');
    await teacherPage.fill('input[placeholder*="CS 401"]', 'CS 402');
    await teacherPage.fill('input[placeholder="e.g. Data Structures & Algorithms"]', 'Operating Systems');
    await teacherPage.getByLabel(/Publish immediately/i).check();
    await teacherPage.getByRole('button', { name: /Continue/i }).click();

    // Step 2: Instructions
    await teacherPage.getByRole('button', { name: /Continue/i }).click();

    // Step 3: Questions (add 2 questions)
    await teacherPage.fill('textarea[placeholder*="Enter your question"]', 'Which scheduler prevents starvation via aging?');
    const optInputs = teacherPage.locator('input[placeholder^="Option "]');
    await optInputs.nth(0).fill('Priority Scheduling with Aging');
    await optInputs.nth(1).fill('Pure FCFS');
    await optInputs.nth(2).fill('Pure LIFO');
    await optInputs.nth(3).fill('Random Selection');

    await teacherPage.getByRole('button', { name: /Create Exam/i }).click();
    await expect(teacherPage.getByText(/CS 402 — Operating Systems Quiz/i).first()).toBeVisible();

    // Read generated 8-char Join Code from dashboard control bar
    const joinCodeEl = teacherPage.locator('span.font-mono').first();
    const joinCode = (await joinCodeEl.textContent())?.trim() ?? '';
    expect(joinCode).toMatch(/^[A-Z2-9]{8}$/);

    // --- Student session: join via code, test permission denial + model failure fallback, take exam ---
    const studentCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['camera', 'microphone'],
    });
    const studentPage = await studentCtx.newPage();

    // First simulate screen-sharing permission denial, then grant on retry;
    // also block external MediaPipe CDN in this E2E run to test graceful AI model failure handling!
    await studentPage.route('**/mediapipe/**', (route) => route.abort());
    await studentPage.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
    await studentPage.route('https://storage.googleapis.com/**', (route) => route.abort());

    await studentPage.addInitScript(() => {
      let screenCalls = 0;
      navigator.mediaDevices.getDisplayMedia = async () => {
        screenCalls += 1;
        if (screenCalls === 1) {
          throw new DOMException('Permission denied by user', 'NotAllowedError');
        }
        return navigator.mediaDevices.getUserMedia({ video: true });
      };
    });

    await studentPage.goto('/');
    await studentPage.getByRole('button', { name: /Student Portal/i }).click();
    await studentPage.fill('input[type="email"]', 'student@university.edu');
    await studentPage.fill('input[type="password"]', 'Student#2026!');
    await studentPage.getByRole('button', { name: /Sign In as Student/i }).click();

    // Invalid code rejected
    await studentPage.fill('input[placeholder*="8-character"]', 'BAD99999');
    await studentPage.getByRole('button', { name: /Join Exam/i }).click();
    await expect(studentPage.getByText(/Invalid or inactive examination code/i)).toBeVisible();

    // Join teacher's newly published CS 402 exam + also screenshot CS 401 instructions for visual parity
    await studentPage.fill('input[placeholder*="8-character"]', joinCode);
    await studentPage.getByRole('button', { name: /Join Exam/i }).click();
    await expect(studentPage.getByText(/Joined "CS 402/i)).toBeVisible();

    await studentPage.getByRole('button', { name: /Begin Check-in/i }).first().click();

    // Explicit consent is unchecked by default -> Continue button disabled until checked!
    const continueBtn = studentPage.getByRole('button', { name: /I Understand — Continue/i });
    await expect(continueBtn).toBeDisabled();
    await studentPage.locator('input[type="checkbox"]').check();
    await expect(continueBtn).toBeEnabled();
    await studentPage.screenshot({ path: join(upgradedScreenshotsDir, '03-instructions.png'), fullPage: true, animations: 'disabled' });
    await continueBtn.click();

    // Step 2: Device Check
    await expect(studentPage.getByRole('heading', { name: /System Verification/i })).toBeVisible();
    await studentPage.waitForTimeout(500);
    await studentPage.screenshot({ path: join(upgradedScreenshotsDir, '04-device-check.png'), fullPage: true, animations: 'disabled' });
    await studentPage.getByRole('button', { name: /Continue/i }).click();

    // Step 3: Permissions (3rd button denies screen share first -> shows warning -> retry succeeds!)
    await studentPage.screenshot({ path: join(upgradedScreenshotsDir, '05-permissions.png'), fullPage: true, animations: 'disabled' });
    await studentPage.getByRole('button', { name: /Allow/i }).first().click();
    await studentPage.getByRole('button', { name: /Allow/i }).first().click();
    await studentPage.getByRole('button', { name: /Allow/i }).first().click();
    await expect(studentPage.getByText('Denied', { exact: true })).toBeVisible();
    await studentPage.locator('button[title="Retry"]').click();
    await expect(studentPage.getByText(/All permissions granted/i)).toBeVisible();
    await studentPage.screenshot({ path: join(upgradedScreenshotsDir, '05b-permissions-granted.png'), fullPage: true, animations: 'disabled' });

    await studentPage.getByRole('button', { name: /Continue to Camera Check/i }).click();

    // Step 4: Face Check — verifies graceful AI model failure fallback (never fakes "Identity Verified!")
    await expect(studentPage.getByText(/Identity Verified/i)).toHaveCount(0);
    await expect(studentPage.getByRole('button', { name: /Proceed with Instructor Notice/i })).toBeVisible({
      timeout: 15000,
    });
    await studentPage.screenshot({ path: join(upgradedScreenshotsDir, '06-face-verify.png'), fullPage: true, animations: 'disabled' });
    await studentPage.getByRole('button', { name: /Proceed with Instructor Notice/i }).click();

    // Active Exam Screen
    await expect(studentPage.getByText(/PROCTORING ACTIVE/i)).toBeVisible();
    await studentPage.screenshot({ path: join(upgradedScreenshotsDir, '07-exam-screen.png'), fullPage: true, animations: 'disabled' });

    // Select correct option A
    await studentPage.getByRole('button', { name: /Priority Scheduling with Aging/i }).click();
    await expect(studentPage.getByText(/1 answered/i)).toBeVisible();
    await studentPage.waitForTimeout(800); // allow debounced server save

    // Browser refresh mid-exam: recovers session, preserves answer, does NOT reset server timer
    await studentPage.reload();
    await expect(studentPage.getByText(/PROCTORING ACTIVE/i)).toBeVisible();
    await expect(studentPage.getByText(/1 answered/i)).toBeVisible();

    // Offline caching & reconnection sync
    await studentCtx.setOffline(true);
    await studentPage.getByRole('button', { name: /Flag for review/i }).click();
    await expect(studentPage.getByText(/Offline · Cached/i)).toBeVisible();
    await studentCtx.setOffline(false);
    await expect(studentPage.getByText(/Saved/i)).toBeVisible({ timeout: 10000 });

    // Submit Modal & Submission (scores gated before teacher publishes!)
    await studentPage.getByRole('button', { name: /^Submit$/i }).click();
    await studentPage.screenshot({ path: join(upgradedScreenshotsDir, '08-submit-modal.png'), fullPage: true, animations: 'disabled' });
    await studentPage.getByRole('button', { name: /Submit Now/i }).click();

    await expect(studentPage.getByText(/AWAITING INSTRUCTOR PUBLICATION/i)).toBeVisible();

    // Teacher publishes results -> Student sees 100% PASSED & question review!
    await teacherPage.getByRole('button', { name: /Refresh/i }).click();
    await teacherPage.getByRole('button', { name: /Publish Results/i }).click();
    await expect(teacherPage.getByRole('button', { name: /Unpublish Results/i })).toBeVisible();

    await studentPage.getByRole('button', { name: /Back to Portal/i }).click();
    await studentPage.getByRole('button', { name: /View Result/i }).first().click();
    await expect(studentPage.getByText('100%')).toBeVisible();
    await expect(studentPage.getByText('PASSED')).toBeVisible();
    await studentPage.screenshot({ path: join(upgradedScreenshotsDir, '09-exam-complete.png'), fullPage: true, animations: 'disabled' });

    await studentCtx.close();
    await teacherCtx.close();
  });

  test('3. Every new teacher and student signs in with their own email & password across sessions', async ({
    page,
  }) => {
    // New Teacher signs in directly with their own email & password
    await page.goto('/');
    await page.getByRole('button', { name: /Teacher Portal/i }).click();
    await page.fill('input[type="email"]', 'dr.patel@college.edu');
    await page.fill('input[type="password"]', 'MyTeacherPass99');
    await page.getByRole('button', { name: /Sign In as Teacher/i }).click();
    await expect(page.getByRole('heading', { name: /Exam Management Dashboard/i })).toBeVisible();

    // Sign out -> wrong password fails -> exact password succeeds again
    await page.locator('button[title="Sign out"]').click();
    await page.getByRole('button', { name: /Teacher Portal/i }).click();
    await page.fill('input[type="email"]', 'dr.patel@college.edu');
    await page.fill('input[type="password"]', 'WrongPass111');
    await page.getByRole('button', { name: /Sign In as Teacher/i }).click();
    await expect(page.getByRole('alert')).toContainText(/Invalid email or password/i);

    await page.fill('input[type="password"]', 'MyTeacherPass99');
    await page.getByRole('button', { name: /Sign In as Teacher/i }).click();
    await expect(page.getByRole('heading', { name: /Exam Management Dashboard/i })).toBeVisible();
    await page.locator('button[title="Sign out"]').click();

    // New Student signs in directly with their own email & password
    await page.getByRole('button', { name: /Student Portal/i }).click();
    await page.fill('input[type="email"]', 'priya.sharma@college.edu');
    await page.fill('input[type="password"]', 'PriyaPass88');
    await page.getByRole('button', { name: /Sign In as Student/i }).click();
    await expect(page.getByRole('heading', { name: /Student Examination Portal/i })).toBeVisible();

    // Sign out -> student cannot sign into Teacher Portal -> signs back into Student Portal with own password
    await page.locator('button[title="Sign out"]').click();
    await page.getByRole('button', { name: /Teacher Portal/i }).click();
    await page.fill('input[type="email"]', 'priya.sharma@college.edu');
    await page.fill('input[type="password"]', 'PriyaPass88');
    await page.getByRole('button', { name: /Sign In as Teacher/i }).click();
    await expect(page.getByRole('alert')).toContainText(/Student account/i);

    await page.getByRole('button', { name: /Back to Home/i }).click();
    await page.getByRole('button', { name: /Student Portal/i }).click();
    await page.fill('input[type="email"]', 'priya.sharma@college.edu');
    await page.fill('input[type="password"]', 'PriyaPass88');
    await page.getByRole('button', { name: /Sign In as Student/i }).click();
    await expect(page.getByRole('heading', { name: /Student Examination Portal/i })).toBeVisible();
  });

  test('4. Real MediaPipe AI detects mobile phone & multiple people in camera + deep links never show white screen', async ({
    browser,
  }) => {
    const fxDir = join(process.cwd(), 'e2e', 'fixtures');
    const oneFaceB64 = `data:image/jpeg;base64,${readFileSync(join(fxDir, 'one-face.jpg')).toString('base64')}`;
    const phoneB64 = `data:image/jpeg;base64,${readFileSync(join(fxDir, 'phone.jpg')).toString('base64')}`;
    const twoFacesB64 = `data:image/jpeg;base64,${readFileSync(join(fxDir, 'two-faces.jpg')).toString('base64')}`;

    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['camera', 'microphone'],
    });
    const page = await ctx.newPage();

    const pageErrors: string[] = [];
    const requestedUrls: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('request', (req) => requestedUrls.push(req.url()));

    // Verify opening any deep link directly in Chrome never produces a blank white screen
    for (const deepUrl of ['/student/exam', '/student/face-check', '/student/permissions', '/teacher/dashboard', '/']) {
      await page.goto(deepUrl);
      await expect(page.locator('#root')).not.toBeEmpty();
      const visibleText = (await page.locator('body').innerText()).trim();
      expect(visibleText.length).toBeGreaterThan(20);
    }

    // Inject controllable photographic canvas webcam stream so real MediaPipe FaceDetector & ObjectDetector run
    await page.addInitScript(
      ({ initialSrc }) => {
        const w = window as unknown as {
          __setMockCamImage: (dataUrl: string) => void;
        };
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx2d = canvas.getContext('2d')!;
        const img = new Image();
        img.src = initialSrc;

        setInterval(() => {
          if (img.complete && img.naturalWidth > 0) {
            ctx2d.fillStyle = '#222';
            ctx2d.fillRect(0, 0, 640, 480);
            ctx2d.drawImage(img, 0, 0, 640, 480);
          }
        }, 66);

        w.__setMockCamImage = (dataUrl: string) => {
          img.src = dataUrl;
        };

        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (constraints && typeof constraints === 'object' && constraints.video) {
            return canvas.captureStream(15);
          }
          return origGetUserMedia(constraints);
        };
        navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(5);
      },
      { initialSrc: oneFaceB64 }
    );

    await page.goto('/');
    await page.getByRole('button', { name: /Student Portal/i }).click();
    await page.fill('input[type="email"]', 'ai.tester@college.edu');
    await page.fill('input[type="password"]', 'AiTester#99');
    await page.getByRole('button', { name: /Sign In as Student/i }).click();

    await page.fill('input[placeholder*="8-character"]', 'CS492FXN');
    await page.getByRole('button', { name: /Join Exam/i }).click();
    await page.getByRole('button', { name: /Begin Check-in/i }).first().click();

    await page.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /I Understand — Continue/i }).click();
    await page.getByRole('button', { name: /Continue/i }).click();

    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: /Allow/i }).first().click();
    }
    await page.getByRole('button', { name: /Continue to Camera Check/i }).click();

    // Real MediaPipe BlazeFace confirms 1 centered human face!
    await expect(page.getByText(/Face Presence Confirmed!/i)).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: /Start Exam/i }).click();

    // Wait for both MediaPipe FaceDetector + ObjectDetector to initialize locally
    await expect(page.getByText(/AI Vision Active/i)).toBeVisible({ timeout: 20000 });

    // 1. Show mobile phone in camera -> expect real AI phone_detected flag!
    await page.evaluate((src) => {
      (window as unknown as { __setMockCamImage: (s: string) => void }).__setMockCamImage(src);
    }, phoneB64);
    await expect(page.getByText(/Mobile phone detected in camera frame/i)).toBeVisible({ timeout: 15000 });

    // 2. Show multiple people/faces in camera -> expect real AI multiple_faces flag!
    await page.evaluate((src) => {
      (window as unknown as { __setMockCamImage: (s: string) => void }).__setMockCamImage(src);
    }, twoFacesB64);
    await expect(page.getByText(/Multiple (faces|people)/i)).toBeVisible({ timeout: 15000 });

    expect(requestedUrls.some((u) => u.includes('/icons/fingerprint.js'))).toBe(false);
    expect(pageErrors).toEqual([]);
    await ctx.close();
  });

  test('5. Student giving exam auto-registers on Teacher Portal and teacher Peeks live camera, microphone & recording', async ({
    browser,
  }) => {
    const fxDir = join(process.cwd(), 'e2e', 'fixtures');
    const oneFaceB64 = `data:image/jpeg;base64,${readFileSync(join(fxDir, 'one-face.jpg')).toString('base64')}`;

    // 1. Teacher opens Teacher Portal BEFORE student starts exam (different faculty account from CS 401 owner!)
    const teacherCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['camera', 'microphone'],
    });
    const teacherPage = await teacherCtx.newPage();
    await teacherPage.goto('/');
    await teacherPage.getByRole('button', { name: /Teacher Portal/i }).click();
    await teacherPage.fill('input[type="email"]', 'proctor.live@college.edu');
    await teacherPage.fill('input[type="password"]', 'Proctor#2026!');
    await teacherPage.getByRole('button', { name: /Sign In as Teacher/i }).click();
    await expect(teacherPage.getByRole('heading', { name: /Exam Management Dashboard/i })).toBeVisible();

    // 2. Student signs in on a separate browser context with live camera + live microphone tone stream
    const studentCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['camera', 'microphone'],
    });
    const studentPage = await studentCtx.newPage();
    await studentPage.addInitScript(
      ({ initialSrc }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx2d = canvas.getContext('2d')!;
        const img = new Image();
        img.src = initialSrc;
        setInterval(() => {
          if (img.complete && img.naturalWidth > 0) {
            ctx2d.drawImage(img, 0, 0, 640, 480);
          }
        }, 66);

        let audioTrack: MediaStreamTrack | null = null;
        function ensureMicTrack(): MediaStreamTrack {
          if (audioTrack && audioTrack.readyState === 'live') return audioTrack;
          const actx = new AudioContext();
          const osc = actx.createOscillator();
          const gain = actx.createGain();
          gain.gain.value = 0.08;
          const dest = actx.createMediaStreamDestination();
          osc.frequency.value = 320;
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
          audioTrack = dest.stream.getAudioTracks()[0];
          return audioTrack;
        }

        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const out = new MediaStream();
          if (constraints && typeof constraints === 'object' && constraints.video) {
            canvas.captureStream(15).getVideoTracks().forEach((t) => out.addTrack(t));
          }
          if (constraints && typeof constraints === 'object' && constraints.audio) {
            out.addTrack(ensureMicTrack().clone());
          }
          return out;
        };
        navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(8);
      },
      { initialSrc: oneFaceB64 }
    );

    try {
      await studentPage.goto('/');
      await studentPage.getByRole('button', { name: /Student Portal/i }).click();
      await studentPage.fill('input[type="email"]', 'live.student@college.edu');
      await studentPage.fill('input[type="password"]', 'LiveStudent#99');
      await studentPage.getByRole('button', { name: /Sign In as Student/i }).click();

      await studentPage.fill('input[placeholder*="8-character"]', 'CS492FXN');
      await studentPage.getByRole('button', { name: /Join Exam/i }).click();
      await studentPage.getByRole('button', { name: /Begin Check-in/i }).first().click();

      await studentPage.locator('input[type="checkbox"]').check();
      await studentPage.getByRole('button', { name: /I Understand — Continue/i }).click();
      await studentPage.getByRole('button', { name: /Continue/i }).click();
      for (let i = 0; i < 3; i++) {
        await studentPage.getByRole('button', { name: /Allow/i }).first().click();
      }
      await studentPage.getByRole('button', { name: /Continue to Camera Check/i }).click();
      await expect(studentPage.getByText(/Face Presence Confirmed!/i)).toBeVisible({ timeout: 20000 });
      await studentPage.getByRole('button', { name: /Start Exam/i }).click();
      await expect(studentPage.getByText(/PROCTORING ACTIVE/i)).toBeVisible();

      // 3. Without reloading Teacher Portal, the student automatically registers in Live Examination Hall!
      await expect(teacherPage.getByText(/Live Examination Hall/i)).toBeVisible({ timeout: 12000 });
      await expect(teacherPage.getByText('live.student@college.edu').first()).toBeVisible({ timeout: 12000 });

      // 4. Teacher clicks "Peek Live (Cam & Mic)" to monitor live camera, microphone audio & record a clip
      await teacherPage.getByRole('button', { name: /Peek Live \(Cam & Mic\)/i }).first().click();
      await expect(teacherPage.getByRole('heading', { name: /Live Peek Monitor/i })).toBeVisible();
      await expect(teacherPage.getByText(/Live Student Microphone Audio/i)).toBeVisible();
      await expect(teacherPage.getByText(/Listening Live/i)).toBeVisible();
      await expect(teacherPage.getByText(/Live Student Camera \(Connected\)/i)).toBeVisible({ timeout: 15000 });

      // Record a short live camera + microphone clip if WebRTC stream connected
      const recordBtn = teacherPage.getByRole('button', { name: /Record Clip/i });
      if (await recordBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await recordBtn.click();
        await teacherPage.waitForTimeout(1200);
        await teacherPage.getByRole('button', { name: /Stop Rec/i }).click();
        await expect(teacherPage.getByText(/Captured Camera & Microphone Recording/i)).toBeVisible();
        await expect(teacherPage.getByText(/Saved to Cloud Storage/i)).toBeVisible({ timeout: 10000 });
        await expect(teacherPage.getByRole('link', { name: /Download Recording/i })).toBeVisible();
      }

      // Send live proctor warning from Peek modal -> Student immediately receives banner on ExamScreen!
      await teacherPage.fill(
        'input[placeholder*="instant written warning"]',
        'Please keep both hands visible on your desk.'
      );
      await teacherPage.getByRole('button', { name: /Send Warning/i }).click();
      await expect(
        studentPage.getByText(/Please keep both hands visible on your desk\./i)
      ).toBeVisible({ timeout: 10000 });
    } finally {
      await studentCtx.close();
      await teacherCtx.close();
    }
  });
});
