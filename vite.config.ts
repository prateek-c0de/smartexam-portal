import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const securityHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
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
});
