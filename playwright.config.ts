import { defineConfig } from '@playwright/test';

const TEST_ANON_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ.' +
  'public-anon-test-sig';

export default defineConfig({
  testDir: './e2e',
  reporter: 'list',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5198',
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
    permissions: ['camera', 'microphone'],
  },
  webServer: [
    {
      command: 'node e2e/supabaseTestServer.mjs',
      url: 'http://127.0.0.1:54399/auth/v1/recover',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'npx vite --port 5198 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:5198/',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: {
        VITE_SUPABASE_URL: 'http://127.0.0.1:54399',
        VITE_SUPABASE_ANON_KEY: TEST_ANON_JWT,
      },
    },
  ],
});
