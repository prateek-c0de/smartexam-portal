// Persistent Local Supabase-Compatible Backend (PostgreSQL 16 via PGlite + Auth + Realtime WS + Private Storage)
// Runs all SQL migrations in `supabase/migrations/*.sql` on real PostgreSQL persisted in `.smartexam-db/`.

import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getServerSecret(dataDir) {
  if (!dataDir) return 'smartexam-ephemeral-jwt-secret';
  mkdirSync(dataDir, { recursive: true });
  const secretPath = join(dataDir, '.jwt-secret');
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, 'utf8').trim();
  }
  const generated = crypto.randomBytes(32).toString('hex');
  writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, expectedHex] = stored.split('$');
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function startLocalSupabaseServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? process.env.LOCAL_SUPABASE_PORT ?? 54321);
  const host = options.host ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const inMemory = Boolean(options.inMemory ?? process.env.IN_MEMORY_DB === '1');
  const dataDir = inMemory ? null : resolve(PROJECT_ROOT, options.dataDir ?? process.env.DATA_DIR ?? '.smartexam-db');
  const distDir = resolve(PROJECT_ROOT, 'dist');
  const hasBuiltDist = existsSync(join(distDir, 'index.html'));
  const jwtSecret = getServerSecret(dataDir);

  if (dataDir) {
    mkdirSync(join(dataDir, 'pgdata'), { recursive: true });
    mkdirSync(join(dataDir, 'evidence'), { recursive: true });
  }

  const db = inMemory ? new PGlite() : new PGlite(join(dataDir, 'pgdata'));

  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    CREATE SCHEMA IF NOT EXISTS auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated;
    CREATE TABLE IF NOT EXISTS auth.users (
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
    CREATE TABLE IF NOT EXISTS auth._applied_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const migDir = join(PROJECT_ROOT, 'supabase', 'migrations');
  const migFiles = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migFiles) {
    const already = await db.query(`SELECT 1 FROM auth._applied_migrations WHERE filename = $1`, [file]);
    if (already.rows.length === 0) {
      await db.exec(readFileSync(join(migDir, file), 'utf8'));
      await db.query(`INSERT INTO auth._applied_migrations (filename) VALUES ($1)`, [file]);
    }
  }

  // Ensure the seeded CS 401 exam has a valid join code (CS492FXN) so students can join it too
  await db.query(`
    UPDATE public.exams
       SET join_code = coalesce(join_code, 'CS492FXN'),
           status = CASE WHEN status = 'draft' THEN 'published' ELSE status END
     WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  `);

  if (options.seedTestAccounts) {
    const teacherId = '10000000-0000-4000-8000-000000000001';
    const studentId = '10000000-0000-4000-8000-000000000002';
    const lockId = '10000000-0000-4000-8000-000000000003';
    await db.query(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data)
       VALUES
         ($1, 'faculty@university.edu', $2, now(), '{"full_name":"Prof. Ada Lovelace","portal_role":"teacher"}'::jsonb),
         ($3, 'student@university.edu', $4, now(), '{"full_name":"Alex Rivera","portal_role":"student"}'::jsonb),
         ($5, 'locktest@university.edu', $6, now(), '{"full_name":"Lock Test","portal_role":"student"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        teacherId,
        hashPassword('Faculty#2026!'),
        studentId,
        hashPassword('Student#2026!'),
        lockId,
        hashPassword('CorrectLock#2026!'),
      ]
    );
    await db.query(
      `UPDATE public.exams SET created_by = $1 WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' AND created_by IS NULL`,
      [teacherId]
    );
  }

  // Introspect public RPC catalog
  const fnMetaRows = await db.query(`
    SELECT p.proname AS name,
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
        exp: now + 86400,
      })
    );
    const sig = base64Url(
      crypto.createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest()
    );
    return `${header}.${payload}.${sig}`;
  }

  function verifyJwtUid(token) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const expectedSig = base64Url(
        crypto.createHmac('sha256', jwtSecret).update(`${parts[0]}.${parts[1]}`).digest()
      );
      if (parts[2] !== expectedSig) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload.role === 'authenticated' && payload.sub && payload.exp > Math.floor(Date.now() / 1000)) {
        return String(payload.sub);
      }
    } catch {
      return null;
    }
    return null;
  }

  function decodeUidFromAuthHeader(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    return verifyJwtUid(authHeader.slice(7).trim());
  }

  function buildSessionPayload(userRow) {
    const accessToken = makeJwt(userRow.id, userRow.email);
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 86400,
      expires_at: Math.floor(Date.now() / 1000) + 86400,
      refresh_token: `rt$${userRow.id}$${crypto.createHmac('sha256', jwtSecret).update(userRow.id).digest('hex').slice(0, 24)}`,
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

  function readRawBuffer(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  async function readJsonBody(req) {
    const buf = await readRawBuffer(req);
    if (!buf.length) return {};
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return {};
    }
  }

  let dbQueue = Promise.resolve();
  function serializedDb(fn) {
    const next = dbQueue.then(fn, fn);
    dbQueue = next.catch(() => {});
    return next;
  }

  // --- Realtime Phoenix WebSocket Hub ---
  const topicSubscribers = new Map(); // topic -> Set<{ ws, joinRef, uid, pgBindings }>

  function notifyPostgresChange(table, eventType, newRow) {
    for (const [topic, subs] of topicSubscribers.entries()) {
      for (const sub of subs) {
        for (const bind of sub.pgBindings) {
          if (bind.table !== table) continue;
          if (bind.event !== '*' && bind.event !== eventType) continue;
          if (bind.filter) {
            const [col, expr] = bind.filter.split('=eq.');
            if (col && expr && String(newRow?.[col] ?? '') !== expr) continue;
          }
          if (sub.ws.readyState === 1) {
            sub.ws.send(
              JSON.stringify({
                topic,
                event: 'postgres_changes',
                payload: {
                  data: {
                    schema: 'public',
                    table,
                    commit_timestamp: new Date().toISOString(),
                    type: eventType,
                    columns: [],
                    record: newRow ?? {},
                    old_record: {},
                    errors: null,
                  },
                  ids: [bind.id ?? 1],
                },
                ref: null,
              })
            );
          }
        }
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeadersFor(req));
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;

    // --- Auth endpoints ---
    if (path === '/auth/v1/token' && req.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      const body = await readJsonBody(req);
      if (grant === 'password') {
        const email = String(body.email ?? '').trim().toLowerCase();
        const pw = String(body.password ?? '');
        const q = await serializedDb(() =>
          db.query(`SELECT * FROM auth.users WHERE lower(email) = $1`, [email])
        );
        const user = q.rows[0];
        if (!user) {
          return sendJson(req, res, 400, {
            code: 'user_not_found',
            error_code: 'user_not_found',
            message: 'User account not found',
          });
        }
        if (!verifyPassword(pw, user.encrypted_password)) {
          return sendJson(req, res, 400, {
            code: 'invalid_credentials',
            error_code: 'invalid_credentials',
            message: 'Invalid login credentials',
          });
        }
        return sendJson(req, res, 200, buildSessionPayload(user));
      }

      if (grant === 'refresh_token') {
        const parts = String(body.refresh_token ?? '').split('$');
        const uid = parts[1] ?? '';
        const expected = crypto.createHmac('sha256', jwtSecret).update(uid).digest('hex').slice(0, 24);
        if (!uid || parts[2] !== expected) {
          return sendJson(req, res, 400, { message: 'Invalid refresh token' });
        }
        const q = await serializedDb(() => db.query(`SELECT * FROM auth.users WHERE id = $1`, [uid]));
        if (!q.rows[0]) return sendJson(req, res, 400, { message: 'Invalid refresh token' });
        return sendJson(req, res, 200, buildSessionPayload(q.rows[0]));
      }
    }

    if (path === '/auth/v1/signup' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = String(body.email ?? '').trim().toLowerCase();
      const pw = String(body.password ?? '');
      const meta = body.data ?? {};
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || pw.length < 6) {
        return sendJson(req, res, 400, { message: 'Valid email and password (min 6 characters) required.' });
      }

      const existing = await serializedDb(() =>
        db.query(`SELECT 1 FROM auth.users WHERE lower(email) = $1`, [email])
      );
      if (existing.rows.length > 0) {
        return sendJson(req, res, 400, { code: 'user_already_exists', message: 'User already registered' });
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

    if (path === '/auth/v1/user' && req.method === 'PUT') {
      const uid = decodeUidFromAuthHeader(req.headers.authorization);
      if (!uid) return sendJson(req, res, 401, { message: 'Auth session missing' });
      const body = await readJsonBody(req);
      if (body.password && String(body.password).length >= 6) {
        await serializedDb(() =>
          db.query(`UPDATE auth.users SET encrypted_password = $1 WHERE id = $2`, [
            hashPassword(String(body.password)),
            uid,
          ])
        );
      }
      const q = await serializedDb(() => db.query(`SELECT * FROM auth.users WHERE id = $1`, [uid]));
      return sendJson(req, res, 200, { user: buildSessionPayload(q.rows[0]).user });
    }

    if (path === '/auth/v1/logout') {
      res.writeHead(204, corsHeadersFor(req));
      res.end();
      return;
    }

    if (path === '/auth/v1/recover' || path === '/auth/v1/resend' || path === '/health') {
      return sendJson(req, res, 200, { status: 'ok' });
    }

    // --- Private Evidence Storage endpoints ---
    if (path.startsWith('/storage/v1/object/proctoring-evidence/') && req.method === 'POST') {
      const uid = decodeUidFromAuthHeader(req.headers.authorization);
      if (!uid || !dataDir) return sendJson(req, res, 401, { message: 'Unauthorized' });
      const rel = path.slice('/storage/v1/object/proctoring-evidence/'.length);
      if (rel.includes('..')) return sendJson(req, res, 400, { message: 'Invalid path' });
      const buf = await readRawBuffer(req);
      if (buf.length > 524288) return sendJson(req, res, 413, { message: 'File too large' });
      const dest = join(dataDir, 'evidence', rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
      return sendJson(req, res, 200, { Key: `proctoring-evidence/${rel}` });
    }

    if (path.startsWith('/storage/v1/object/sign/proctoring-evidence/') && req.method === 'POST') {
      const uid = decodeUidFromAuthHeader(req.headers.authorization);
      if (!uid) return sendJson(req, res, 401, { message: 'Unauthorized' });
      const rel = path.slice('/storage/v1/object/sign/proctoring-evidence/'.length);
      const exp = Math.floor(Date.now() / 1000) + 120;
      const sig = crypto.createHmac('sha256', jwtSecret).update(`${rel}:${exp}`).digest('hex');
      return sendJson(req, res, 200, {
        signedURL: `/object/sign/proctoring-evidence/${rel}?exp=${exp}&sig=${sig}`,
      });
    }

    if (path.startsWith('/storage/v1/object/sign/proctoring-evidence/') && req.method === 'GET') {
      if (!dataDir) return sendJson(req, res, 404, {});
      const rel = path.slice('/storage/v1/object/sign/proctoring-evidence/'.length);
      const exp = Number(url.searchParams.get('exp') || 0);
      const sig = String(url.searchParams.get('sig') || '');
      const expected = crypto.createHmac('sha256', jwtSecret).update(`${rel}:${exp}`).digest('hex');
      if (exp < Math.floor(Date.now() / 1000) || sig !== expected || rel.includes('..')) {
        return sendJson(req, res, 403, { message: 'Signed URL expired' });
      }
      const file = join(dataDir, 'evidence', rel);
      if (!existsSync(file)) return sendJson(req, res, 404, {});
      res.writeHead(200, {
        'Content-Type': rel.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
        ...corsHeadersFor(req),
      });
      res.end(readFileSync(file));
      return;
    }

    // --- PostgREST RPC endpoints ---
    if (path.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
      const fnName = path.slice('/rest/v1/rpc/'.length);
      const meta = rpcCatalog.get(fnName);
      if (!meta) {
        return sendJson(req, res, 404, { code: 'PGRST202', message: `Function ${fnName} not found` });
      }

      const uid = decodeUidFromAuthHeader(req.headers.authorization);
      const body = await readJsonBody(req);

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

        // Broadcast Realtime postgres_changes notifications for live UI updates
        if (fnName === 'student_record_proctoring_event' && result?.accepted && result?.event) {
          notifyPostgresChange('proctoring_events', 'INSERT', result.event);
          notifyPostgresChange('exam_sessions', 'UPDATE', { id: body.p_session_id });
        } else if (fnName === 'teacher_send_warning' && result?.id) {
          notifyPostgresChange('proctor_warnings', 'INSERT', result);
        } else if (
          fnName === 'student_start_or_resume_session' ||
          fnName === 'student_submit_exam' ||
          fnName === 'student_heartbeat' ||
          fnName === 'teacher_set_exam_status'
        ) {
          notifyPostgresChange('exam_sessions', 'UPDATE', { id: body.p_session_id });
        }

        return sendJson(req, res, 200, result);
      } catch (err) {
        return sendJson(req, res, 400, {
          code: err.code || 'P0001',
          hint: err.hint || '',
          message: err.message || 'Database error',
        });
      }
    }

    if (path === '/realtime/v1/api/broadcast' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      for (const m of messages) {
        const fullTopic = String(m?.topic ?? '').startsWith('realtime:')
          ? String(m.topic)
          : `realtime:${m?.topic ?? ''}`;
        const subs = topicSubscribers.get(fullTopic);
        if (subs) {
          const frame = JSON.stringify({
            topic: fullTopic,
            event: 'broadcast',
            payload: { type: 'broadcast', event: m.event, payload: m.payload },
            ref: null,
          });
          for (const sub of subs) {
            if (sub.ws.readyState === 1) sub.ws.send(frame);
          }
        }
      }
      return sendJson(req, res, 202, { status: 'ok' });
    }

    if (path.startsWith('/functions/v1/')) {
      return sendJson(req, res, 503, { error: 'Use local Ollama or deploy Supabase Edge Function' });
    }

    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      return sendJson(req, res, 200, { status: 'ok' });
    }

    // Production static SPA + MediaPipe WASM/TFLite asset serving from `dist/`
    if (
      hasBuiltDist &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !path.startsWith('/auth/v1') &&
      !path.startsWith('/rest/v1') &&
      !path.startsWith('/storage/v1') &&
      !path.startsWith('/realtime/v1')
    ) {
      const MIME_TYPES = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.wasm': 'application/wasm',
        '.tflite': 'application/octet-stream',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf',
      };

      let decodedPath = '/';
      try {
        decodedPath = decodeURIComponent(path);
      } catch {
        decodedPath = '/';
      }
      const relPath = decodedPath.replace(/^\/+/, '');
      const candidate = resolve(distDir, relPath);

      if (!candidate.startsWith(distDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      let fileToServe = null;
      let isSpaIndex = false;
      if (relPath && existsSync(candidate) && statSync(candidate).isFile()) {
        fileToServe = candidate;
      } else if (!relPath || !extname(relPath)) {
        fileToServe = join(distDir, 'index.html');
        isSpaIndex = true;
      }

      if (fileToServe) {
        const ext = extname(fileToServe).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const isImmutableAsset =
          !isSpaIndex && (decodedPath.startsWith('/assets/') || decodedPath.startsWith('/mediapipe/'));
        const bodyBuf = readFileSync(fileToServe);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': bodyBuf.length,
          'Cache-Control': isImmutableAsset
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Permissions-Policy':
            'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=()',
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(bodyBuf);
        }
        return;
      }
    }

    sendJson(req, res, 200, []);
  });

  // Attach Realtime WebSocket server on `/realtime/v1/websocket`
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').startsWith('/realtime/v1/websocket')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    let socketUid = null;
    const joinedTopics = new Map(); // topic -> entry

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const { topic, event, payload, ref, join_ref } = msg;

      if (topic === 'phoenix' && event === 'heartbeat') {
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref }));
        return;
      }

      if (event === 'access_token') {
        socketUid = verifyJwtUid(payload?.access_token);
        ws.send(JSON.stringify({ topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref, join_ref }));
        return;
      }

      if (event === 'phx_join') {
        if (payload?.access_token) {
          socketUid = verifyJwtUid(payload.access_token) ?? socketUid;
        }
        const bareTopic = String(topic ?? '').replace(/^realtime:/, '');

        // Enforce WebRTC / Peek channel authorization in PostgreSQL
        if (bareTopic.startsWith('webrtc:') || bareTopic.startsWith('peek:')) {
          const allowed = await serializedDb(async () => {
            if (!socketUid) return false;
            await db.exec('BEGIN');
            try {
              await db.exec('SET LOCAL ROLE authenticated;');
              await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [socketUid]);
              const r = await db.query(`SELECT public.can_access_peek_channel($1) AS ok`, [bareTopic]);
              await db.exec('COMMIT');
              return Boolean(r.rows[0]?.ok);
            } catch {
              await db.exec('ROLLBACK');
              return false;
            }
          });
          if (!allowed) {
            ws.send(
              JSON.stringify({
                topic,
                event: 'phx_reply',
                payload: { status: 'error', response: { reason: 'unauthorized' } },
                ref,
                join_ref,
              })
            );
            return;
          }
        }

        const pgChangesCfg = Array.isArray(payload?.config?.postgres_changes)
          ? payload.config.postgres_changes.map((c, idx) => ({ ...c, id: idx + 1 }))
          : [];

        const entry = { ws, joinRef: join_ref, uid: socketUid, pgBindings: pgChangesCfg };
        joinedTopics.set(topic, entry);
        if (!topicSubscribers.has(topic)) topicSubscribers.set(topic, new Set());
        topicSubscribers.get(topic).add(entry);

        ws.send(
          JSON.stringify({
            topic,
            event: 'phx_reply',
            payload: {
              status: 'ok',
              response: {
                postgres_changes: pgChangesCfg.map((c) => ({ ...c })),
              },
            },
            ref,
            join_ref,
          })
        );
        return;
      }

      if (event === 'phx_leave') {
        const entry = joinedTopics.get(topic);
        if (entry) {
          topicSubscribers.get(topic)?.delete(entry);
          joinedTopics.delete(topic);
        }
        ws.send(JSON.stringify({ topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref, join_ref }));
        return;
      }

      if (event === 'broadcast') {
        const subs = topicSubscribers.get(topic);
        if (subs) {
          for (const sub of subs) {
            if (sub.ws !== ws && sub.ws.readyState === 1) {
              sub.ws.send(JSON.stringify({ topic, event: 'broadcast', payload, ref: null }));
            }
          }
        }
      }
    });

    ws.on('close', () => {
      for (const [topic, entry] of joinedTopics.entries()) {
        topicSubscribers.get(topic)?.delete(entry);
      }
      joinedTopics.clear();
    });
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolvePromise();
      } else {
        rejectPromise(err);
      }
    });
    server.listen(port, host, () => {
      resolvePromise();
    });
  });

  return {
    port,
    host,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    close: async () => {
      wss.close();
      await new Promise((r) => server.close(() => r()));
      await db.close();
    },
  };
}

// Allow standalone CLI execution (`node server/localSupabaseServer.mjs` / `npm start`)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inMemory = process.env.IN_MEMORY_DB === '1';
  const port = Number(process.env.PORT || process.env.LOCAL_SUPABASE_PORT || process.env.TEST_SUPABASE_PORT || 54321);
  const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const seedTestAccounts = process.env.SEED_TEST_ACCOUNTS !== '0';
  startLocalSupabaseServer({ port, host, inMemory, seedTestAccounts }).then((srv) => {
    console.log(`[SmartExam Server] Full-Stack Portal + PostgreSQL + Auth + Realtime listening on ${host}:${srv.port}`);
  });
}
