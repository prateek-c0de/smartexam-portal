import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function createSupabaseLikeDb(): Promise<PGlite> {
  const db = new PGlite();

  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY,
      email text UNIQUE NOT NULL,
      encrypted_password text NOT NULL DEFAULT '',
      email_confirmed_at timestamptz,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
  `);

  const migDir = join(process.cwd(), 'supabase', 'migrations');
  const files = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const f of files) {
    const sql = readFileSync(join(migDir, f), 'utf8');
    await db.exec(sql);
  }

  return db;
}

export async function runAs<T = unknown>(
  db: PGlite,
  uid: string | null,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  await db.exec('BEGIN');
  try {
    if (uid === null) {
      await db.exec(`SET LOCAL ROLE anon; SELECT set_config('request.jwt.claim.sub', '', true);`);
    } else {
      await db.exec(`SET LOCAL ROLE authenticated;`);
      await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    }
    const res = await db.query<T>(sql, params);
    await db.exec('COMMIT');
    return res.rows;
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}
