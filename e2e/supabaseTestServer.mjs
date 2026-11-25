// Local Supabase-compatible Auth + PostgREST RPC test server backed by real
// PGlite PostgreSQL executing all SmartExam migrations (`supabase/migrations/*.sql`).
// Used exclusively by Playwright E2E tests (`npm run test:e2e`).

import http from 'node:http';
import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.env.TEST_SUPABASE_PORT || 54399);

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function makeJwt(uid, email) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      aud: 'authenticated',
      role: 'authenticated',
      sub: uid,
      email,
      iat: now,
      exp: now + 3600,
    })
  );
  const sig = base64Url(crypto.createHmac('sha256', 'e2e-test-secret').update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function decodeUidFromAuthHeader(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.role === 'authenticated' && payload.sub) {
      return String(payload.sub);
    }
  } catch {
    return null;
  }
  return null;
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(`smartexam:${pw}`).digest('hex');
}

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
for (const file of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(migDir, file), 'utf8'));
}

// Clear seed demo exams/sessions from initial legacy migration so TeacherDashboard starts clean & real,
// or assign seeded CS 401 to our provisioned teacher so baseline & upgraded dashboard comparison is realistic!
const TEACHER_ID = '10000000-0000-4000-8000-000000000001';
const STUDENT_ID = '10000000-0000-4000-8000-000000000002';

await db.query(
  `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
   VALUES
     ($1, 'faculty@university.edu', $2, now(), '{"full_name":"Prof. Ada Lovelace"}'::jsonb),
     ($3, 'student@university.edu', $4, now(), '{"full_name":"Alex Rivera"}'::jsonb)`,
  [TEACHER_ID, hashPassword('Faculty#2026!'), STUDENT_ID, hashPassword('Student#2026!')]
);
await db.query(`UPDATE public.profiles SET role = 'teacher' WHERE id = $1`, [TEACHER_ID]);
await db.query(
  `UPDATE public.exams
      SET created_by = $1,
          join_code = 'CS492FXN',
          status = 'published'
    WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'`,
  [TEACHER_ID]
);

// Introspect parameter order & types of every public RPC so PostgREST named-arg calls bind accurately
const fnMetaRows = await db.query(`
  SELECT p.proname AS name,
         pg_get_function_identity_arguments(p.oid) AS args_sig,
         p.proargnames AS arg_names,
         ARRAY(
           SELECT format_type(unnest_oid, NULL)
           FROM unnest(p.proargtypes) WITH ORDINALITY AS t(unnest_oid, ord)
           ORDER BY ord
         ) AS arg_types
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND NOT p.proname LIKE '\\_%'
`);

const rpcCatalog = new Map();
for (const row of fnMetaRows.rows) {
  rpcCatalog.set(row.name, {
    argNames: row.arg_names ?? [],
    argTypes: row.arg_types ?? [],
  });
}

function corsHeadersFor(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Headers':
      req.headers['access-control-request-headers'] ||
      'authorization, x-client-info, apikey, content-type, x-supabase-api-version, prefer, accept-profile, content-profile',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
}

function sendJson(req, res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeadersFor(req),
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
  });
}

function buildSessionPayload(userRow) {
  const accessToken = makeJwt(userRow.id, userRow.email);
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `rt-${userRow.id}`,
    user: {
      id: userRow.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: userRow.email,
      email_confirmed_at: userRow.email_confirmed_at,
      user_metadata: userRow.raw_user_meta_data ?? {},
      app_metadata: { provider: 'email' },
    },
  };
}

let dbQueue = Promise.resolve();
function serializedDb(fn) {
  const next = dbQueue.then(fn, fn);
  dbQueue = next.catch(() => {});
  return next;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeadersFor(req));
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // --- Auth endpoints ---
  if (path === '/auth/v1/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    const body = await readBody(req);
    if (grant === 'password') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const pw = String(body.password ?? '');
      const q = await serializedDb(() =>
        db.query(`SELECT * FROM auth.users WHERE lower(email) = $1`, [email])
      );
      const user = q.rows[0];
      if (!user || user.encrypted_password !== hashPassword(pw)) {
        return sendJson(req, res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', message: 'Invalid login credentials' });
      }
      if (!user.email_confirmed_at) {
        return sendJson(req, res, 400, { error: 'email_not_confirmed', message: 'Email not confirmed' });
      }
      return sendJson(req, res, 200, buildSessionPayload(user));
    }
    if (grant === 'refresh_token') {
      const uid = String(body.refresh_token ?? '').replace(/^rt-/, '');
      const q = await serializedDb(() => db.query(`SELECT * FROM auth.users WHERE id = $1`, [uid]));
      if (!q.rows[0]) return sendJson(req, res, 400, { message: 'Invalid refresh token' });
      return sendJson(req, res, 200, buildSessionPayload(q.rows[0]));
    }
  }

  if (path === '/auth/v1/signup' && req.method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email ?? '').trim().toLowerCase();
    const pw = String(body.password ?? '');
    const meta = body.data ?? {};
    const existing = await serializedDb(() =>
      db.query(`SELECT 1 FROM auth.users WHERE lower(email) = $1`, [email])
    );
    if (existing.rows.length > 0) {
      return sendJson(req, res, 400, { message: 'User already registered' });
    }
    const id = crypto.randomUUID();
    const ins = await serializedDb(() =>
      db.query(
        `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
         VALUES ($1, $2, $3, now(), $4::jsonb) RETURNING *`,
        [id, email, hashPassword(pw), JSON.stringify(meta)]
      )
    );
    return sendJson(req, res, 200, buildSessionPayload(ins.rows[0]));
  }

  if (path === '/auth/v1/user' && req.method === 'GET') {
    const uid = decodeUidFromAuthHeader(req.headers.authorization);
    if (!uid) return sendJson(req, res, 401, { message: 'Auth session missing' });
    const q = await serializedDb(() => db.query(`SELECT * FROM auth.users WHERE id = $1`, [uid]));
    if (!q.rows[0]) return sendJson(req, res, 401, { message: 'User not found' });
    return sendJson(req, res, 200, buildSessionPayload(q.rows[0]).user);
  }

  if (path === '/auth/v1/logout') {
    res.writeHead(204, corsHeadersFor(req));
    res.end();
    return;
  }

  if (path === '/auth/v1/recover' || path === '/auth/v1/resend') {
    return sendJson(req, res, 200, {});
  }

  // --- PostgREST RPC endpoints ---
  if (path.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
    const fnName = path.slice('/rest/v1/rpc/'.length);
    const meta = rpcCatalog.get(fnName);
    if (!meta) {
      return sendJson(req, res, 404, { code: 'PGRST202', message: `Function ${fnName} not found` });
    }

    const uid = decodeUidFromAuthHeader(req.headers.authorization);
    const body = await readBody(req);

    try {
      const result = await serializedDb(async () => {
        await db.exec('BEGIN');
        try {
          if (uid) {
            await db.exec('SET LOCAL ROLE authenticated;');
            await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid]);
          } else {
            await db.exec("SET LOCAL ROLE anon; SELECT set_config('request.jwt.claim.sub', '', true);");
          }

          // Build named-argument call for supplied parameters so PostgreSQL defaults work naturally
          const callParts = [];
          const params = [];
          for (let i = 0; i < meta.argNames.length; i++) {
            const aName = meta.argNames[i];
            const aType = meta.argTypes[i];
            if (Object.prototype.hasOwnProperty.call(body, aName)) {
              const rawVal = body[aName];
              params.push(
                aType === 'jsonb' && rawVal !== null && rawVal !== undefined
                  ? JSON.stringify(rawVal)
                  : rawVal
              );
              callParts.push(`${aName} := $${params.length}::${aType}`);
            }
          }

          const sql = `SELECT public.${fnName}(${callParts.join(', ')}) AS data`;
          const r = await db.query(sql, params);
          await db.exec('COMMIT');
          return r.rows[0]?.data ?? null;
        } catch (err) {
          await db.exec('ROLLBACK');
          throw err;
        }
      });

      return sendJson(req, res, 200, result);
    } catch (err) {
      return sendJson(req, res, 400, {
        code: err.code || 'P0001',
        hint: err.hint || '',
        message: err.message || 'Database error',
      });
    }
  }

  // Edge function fallback in E2E
  if (path.startsWith('/functions/v1/')) {
    return sendJson(req, res, 503, { error: 'Edge runtime not active in local E2E harness' });
  }

  sendJson(req, res, 200, []);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`E2E PGlite Supabase server listening on http://127.0.0.1:${PORT}`);
});
