// Thin wrapper launching the real PGlite PostgreSQL + Auth + Realtime server in ephemeral mode for Playwright E2E
import { startLocalSupabaseServer } from '../server/localSupabaseServer.mjs';

const PORT = Number(process.env.TEST_SUPABASE_PORT || 54399);

await startLocalSupabaseServer({
  port: PORT,
  inMemory: true,
  seedTestAccounts: true,
});

console.log(`E2E PGlite Supabase server listening on http://127.0.0.1:${PORT}`);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
