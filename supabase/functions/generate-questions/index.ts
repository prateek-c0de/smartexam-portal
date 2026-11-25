// Supabase Edge Function: generate-questions
// Keeps external LLM API credentials strictly server-side while supporting
// local Ollama (lightweight models such as llama3.2:3b / qwen2.5:3b) and
// OpenAI-compatible / Gemini endpoints.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface GeneratePayload {
  subject: string;
  topic: string;
  difficulty: 'easy' | 'medium' | 'hard';
  count: number;
  question_type: 'mcq' | 'multi_select' | 'true_false' | 'descriptive';
  marks: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonResponse({ error: 'Missing authorization header' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userRes, error: authErr } = await supabase.auth.getUser();
    if (authErr || !userRes.user) {
      return jsonResponse({ error: 'Unauthorized session' }, 401);
    }

    const { data: isTeacher, error: roleErr } = await supabase.rpc('is_teacher');
    if (roleErr || !isTeacher) {
      return jsonResponse({ error: 'Teacher authorization required' }, 403);
    }

    const body = (await req.json()) as Partial<GeneratePayload>;
    const subject = String(body.subject ?? '').trim().slice(0, 120);
    const topic = String(body.topic ?? '').trim().slice(0, 200);
    const difficulty = (['easy', 'medium', 'hard'] as const).includes(body.difficulty as 'easy')
      ? (body.difficulty as 'easy' | 'medium' | 'hard')
      : 'medium';
    const qType = (['mcq', 'multi_select', 'true_false', 'descriptive'] as const).includes(
      body.question_type as 'mcq'
    )
      ? (body.question_type as GeneratePayload['question_type'])
      : 'mcq';
    const count = Math.min(20, Math.max(1, Math.floor(Number(body.count ?? 5))));
    const marks = Math.min(100, Math.max(1, Math.floor(Number(body.marks ?? 5))));

    if (!subject || !topic) {
      return jsonResponse({ error: 'Subject and topic are required.' }, 400);
    }

    const prompt = buildPrompt({ subject, topic, difficulty, count, question_type: qType, marks });
    const rawJson = await invokeConfiguredProvider(prompt);
    const parsed = sanitizeGeneratedQuestions(rawJson, qType, marks, subject);

    return jsonResponse({ questions: parsed }, 200);
  } catch (err) {
    console.error('[generate-questions] failure:', err instanceof Error ? err.message : 'unknown');
    return jsonResponse(
      { error: 'AI question generator is currently unavailable. You can continue creating questions manually.' },
      502
    );
  }
});

function buildPrompt(p: GeneratePayload): string {
  const typeSpec =
    p.question_type === 'mcq'
      ? 'Each item MUST have 4 distinct options and `correct_options` with exactly 1 zero-based index [0..3].'
      : p.question_type === 'multi_select'
        ? 'Each item MUST have 4 distinct options and `correct_options` with 2 or 3 zero-based indices.'
        : p.question_type === 'true_false'
          ? 'Each item MUST have options ["True", "False"] and `correct_options` with [0] or [1].'
          : 'Each item is descriptive: set `options` to [] and `correct_options` to [], and provide a concise `model_answer` rubric.';

  return [
    `Generate ${p.count} university-level ${p.difficulty} ${p.question_type} examination questions.`,
    `Subject: ${p.subject}`,
    `Topic: ${p.topic}`,
    typeSpec,
    'Return ONLY valid JSON with shape: {"questions":[{"question_text":"...","options":["..."],"correct_options":[0],"explanation":"...","model_answer":"..."}]}',
  ].join('\n');
}

async function invokeConfiguredProvider(prompt: string): Promise<unknown> {
  const provider = (Deno.env.get('AI_PROVIDER') || 'ollama').toLowerCase();

  if (provider === 'gemini') {
    const apiKey = Deno.env.get('GEMINI_API_KEY');
    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    return JSON.parse(text);
  }

  if (provider === 'openai_compatible') {
    const baseUrl = (Deno.env.get('OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/$/, '');
    const apiKey = Deno.env.get('OPENAI_API_KEY');
    const model = Deno.env.get('OPENAI_MODEL') || 'gpt-4o-mini';
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an academic assessment author. Output strict JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json();
    return JSON.parse(data?.choices?.[0]?.message?.content ?? '{}');
  }

  // Default: Ollama (local lightweight model)
  const ollamaUrl = (Deno.env.get('OLLAMA_BASE_URL') || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const ollamaModel = Deno.env.get('OLLAMA_MODEL') || 'llama3.2:3b';
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: 'You are an academic assessment author. Output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return JSON.parse(data?.message?.content ?? '{}');
}

function sanitizeGeneratedQuestions(
  raw: unknown,
  questionType: GeneratePayload['question_type'],
  marks: number,
  subject: string
) {
  const list = Array.isArray((raw as { questions?: unknown[] })?.questions)
    ? ((raw as { questions: unknown[] }).questions)
    : Array.isArray(raw)
      ? raw
      : [];

  return list
    .map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      const question_text = String(rec.question_text ?? '').trim().slice(0, 5000);
      if (!question_text) return null;

      let options: string[] = [];
      let correct_options: number[] = [];

      if (questionType === 'descriptive') {
        options = [];
        correct_options = [];
      } else if (questionType === 'true_false') {
        options = ['True', 'False'];
        const c = Array.isArray(rec.correct_options) ? Number(rec.correct_options[0]) : 0;
        correct_options = [c === 1 ? 1 : 0];
      } else {
        options = Array.isArray(rec.options)
          ? rec.options.map((o) => String(o ?? '').trim().slice(0, 1000)).filter(Boolean).slice(0, 6)
          : [];
        if (options.length < 2) return null;
        const rawCorr = Array.isArray(rec.correct_options)
          ? rec.correct_options.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < options.length)
          : [0];
        correct_options =
          questionType === 'multi_select'
            ? Array.from(new Set(rawCorr.length > 0 ? rawCorr : [0]))
            : [rawCorr[0] ?? 0];
      }

      return {
        section: subject,
        question_type: questionType,
        question_text,
        options,
        correct_options,
        correct_answer: correct_options[0] ?? null,
        marks,
        explanation: String(rec.explanation ?? '').trim().slice(0, 5000),
        model_answer: String(rec.model_answer ?? '').trim().slice(0, 10000),
        ai_generated: true,
        approved: false, // Teachers must review and approve before publication
      };
    })
    .filter(Boolean);
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
