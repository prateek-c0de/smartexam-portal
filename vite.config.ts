import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=()',
};

function localSupabaseBackendPlugin(useEmbeddedBackend: boolean): Plugin {
  let closeFn: (() => Promise<void>) | null = null;

  async function bootIfNeeded() {
    if (!useEmbeddedBackend || closeFn) return;
    // @ts-expect-error ESM server helper outside tsconfig.node include
    const mod = await import('./server/localSupabaseServer.mjs');
    const srv = await mod.startLocalSupabaseServer({
      port: 54321,
      seedTestAccounts: true,
    });
    closeFn = srv.close;
    console.log(`\n  ➜  SmartExam PostgreSQL + Auth + Realtime ready (${srv.url} via same-origin proxy)\n`);
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

const sameOriginSupabaseProxy = {
  '/auth/v1': { target: 'http://127.0.0.1:54321', changeOrigin: true },
  '/rest/v1': { target: 'http://127.0.0.1:54321', changeOrigin: true },
  '/storage/v1': { target: 'http://127.0.0.1:54321', changeOrigin: true },
  '/functions/v1': { target: 'http://127.0.0.1:54321', changeOrigin: true },
  '/realtime/v1': { target: 'http://127.0.0.1:54321', ws: true, changeOrigin: true },
};

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const rawUrl = (process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL || 'local').trim();
  const useEmbeddedBackend =
    rawUrl === 'local' ||
    rawUrl === '' ||
    /^https?:\/\/(127\.0\.0\.1|localhost):54321\b/i.test(rawUrl);

  return {
    plugins: [react(), localSupabaseBackendPlugin(useEmbeddedBackend)],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      headers: securityHeaders,
      proxy: useEmbeddedBackend ? sameOriginSupabaseProxy : undefined,
    },
    preview: {
      headers: securityHeaders,
      proxy: useEmbeddedBackend ? sameOriginSupabaseProxy : undefined,
    },
    // Pre-bundle lucide-react into one chunk so browser privacy/antivirus extensions
    // never block individual icon modules like `icons/fingerprint.js` (ERR_BLOCKED_BY_CLIENT).
    optimizeDeps: {
      include: ['lucide-react', '@supabase/supabase-js'],
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
