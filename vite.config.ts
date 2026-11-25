import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function localSupabaseBackendPlugin(supabaseUrl: string): Plugin {
  const isLocalBackend = /^https?:\/\/(127\.0\.0\.1|localhost):54321\b/i.test(supabaseUrl);
  let closeFn: (() => Promise<void>) | null = null;

  async function bootIfNeeded() {
    if (!isLocalBackend || closeFn) return;
    // @ts-expect-error ESM server helper outside tsconfig.node include
    const mod = await import('./server/localSupabaseServer.mjs');
    const srv = await mod.startLocalSupabaseServer({
      port: 54321,
      seedTestAccounts: true,
    });
    closeFn = srv.close;
    console.log(`\n  ➜  SmartExam PostgreSQL + Auth + Realtime: ${srv.url} (.smartexam-db/)\n`);
  }

  return {
    name: 'smartexam-local-supabase',
    async configureServer(server) {
      await bootIfNeeded();
      server.httpServer?.once('close', () => {
        void closeFn?.();
        closeFn = null;
      });
    },
    async configurePreviewServer(server) {
      await bootIfNeeded();
      server.httpServer?.once('close', () => {
        void closeFn?.();
        closeFn = null;
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const supabaseUrl = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';

  return {
    plugins: [react(), localSupabaseBackendPlugin(supabaseUrl)],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      headers: securityHeaders,
    },
    preview: {
      headers: securityHeaders,
    },
    optimizeDeps: {
      exclude: ['lucide-react'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('@mediapipe/tasks-vision')) return 'mediapipe-vision';
            if (id.includes('@supabase/supabase-js')) return 'supabase-vendor';
            return undefined;
          },
        },
      },
    },
  };
});
