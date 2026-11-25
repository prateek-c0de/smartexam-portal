import { supabase, AppError } from '@/lib/supabase';
import type { QuestionType } from '@/types';
import type { QuestionSaveInput } from '@/services/examService';

export interface AIQuestionGenerateParams {
  subject: string;
  topic: string;
  difficulty: 'easy' | 'medium' | 'hard';
  count: number;
  questionType: QuestionType;
  marks: number;
  provider?: 'edge' | 'ollama_local';
  ollamaModel?: string;
  signal?: AbortSignal;
}

function buildLocalOllamaPrompt(p: AIQuestionGenerateParams): string {
  const typeSpec =
    p.questionType === 'mcq'
      ? 'Each item MUST have 4 distinct options and `correct_options` with 1 zero-based index [0..3].'
      : p.questionType === 'multi_select'
        ? 'Each item MUST have 4 distinct options and `correct_options` with 2 or 3 zero-based indices.'
        : p.questionType === 'true_false'
          ? 'Each item MUST have options ["True", "False"] and `correct_options` with [0] or [1].'
          : 'Each item is descriptive: set `options` to [] and `correct_options` to [], and provide a concise `model_answer` rubric.';

  return [
    `Generate ${p.count} university-level ${p.difficulty} ${p.questionType} examination questions.`,
    `Subject: ${p.subject}`,
    `Topic: ${p.topic}`,
    typeSpec,
    'Return ONLY valid JSON with shape: {"questions":[{"question_text":"...","options":["..."],"correct_options":[0],"explanation":"...","model_answer":"..."}]}',
  ].join('\n');
}

function normalizeDraftQuestions(
  rawList: unknown[],
  p: AIQuestionGenerateParams
): QuestionSaveInput[] {
  const out: QuestionSaveInput[] = [];

  for (const item of rawList) {
    const rec = (item ?? {}) as Record<string, unknown>;
    const text = String(rec.question_text ?? '').trim().slice(0, 5000);
    if (!text) continue;

    let options: string[] = [];
    let correctOptions: number[] = [];

    if (p.questionType === 'descriptive') {
      options = [];
      correctOptions = [];
    } else if (p.questionType === 'true_false') {
      options = ['True', 'False'];
      const rawIdx = Array.isArray(rec.correct_options) ? Number(rec.correct_options[0]) : 0;
      correctOptions = [rawIdx === 1 ? 1 : 0];
    } else {
      options = Array.isArray(rec.options)
        ? rec.options
            .map((o) => String(o ?? '').trim().slice(0, 1000))
            .filter(Boolean)
            .slice(0, 6)
        : [];
      if (options.length < 2) continue;
      const validIndices = Array.isArray(rec.correct_options)
        ? rec.correct_options
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n >= 0 && n < options.length)
        : [0];
      correctOptions =
        p.questionType === 'multi_select'
          ? Array.from(new Set(validIndices.length > 0 ? validIndices : [0]))
          : [validIndices[0] ?? 0];
    }

    out.push({
      section: p.subject.trim() || 'Section A',
      question_type: p.questionType,
      question_text: text,
      options,
      correct_options: correctOptions,
      marks: Math.max(1, Math.min(100, Math.round(p.marks))),
      explanation: String(rec.explanation ?? '').trim().slice(0, 5000),
      model_answer: String(rec.model_answer ?? '').trim().slice(0, 10000),
      ai_generated: true,
      approved: false, // Always requires explicit teacher review & approval
    });
  }

  return out;
}

export const aiQuestionService = {
  async generateDraftQuestions(params: AIQuestionGenerateParams): Promise<QuestionSaveInput[]> {
    const subject = params.subject.trim();
    const topic = params.topic.trim();
    if (!subject || !topic) {
      throw new AppError('INVALID_INPUT', 'Please enter both a subject and topic for AI generation.');
    }

    const count = Math.max(1, Math.min(20, Math.round(params.count)));
    const marks = Math.max(1, Math.min(100, Math.round(params.marks)));
    const normalizedParams = { ...params, subject, topic, count, marks };

    // 1. Try server-side Edge Function first unless teacher explicitly selected local Ollama
    if (params.provider !== 'ollama_local') {
      const { data, error } = await supabase.functions.invoke('generate-questions', {
        body: {
          subject,
          topic,
          difficulty: params.difficulty,
          count,
          question_type: params.questionType,
          marks,
        },
      });

      if (!error && data?.questions && Array.isArray(data.questions)) {
        const drafts = normalizeDraftQuestions(data.questions as unknown[], normalizedParams);
        if (drafts.length > 0) return drafts;
      }

      // If teacher explicitly requested Edge only, surface the unavailable error cleanly
      if (params.provider === 'edge') {
        throw new AppError(
          'AI_UNAVAILABLE',
          'Server AI provider is unavailable or not configured. You can switch to Local Ollama or add questions manually.'
        );
      }
    }

    // 2. Local Ollama fallback / direct local lightweight model (no external API keys)
    const ollamaBase = String(import.meta.env.VITE_OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(
      /\/$/,
      ''
    );
    const ollamaModel =
      params.ollamaModel?.trim() || String(import.meta.env.VITE_OLLAMA_MODEL || 'llama3.2:3b');

    try {
      const res = await fetch(`${ollamaBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: params.signal,
        body: JSON.stringify({
          model: ollamaModel,
          stream: false,
          format: 'json',
          messages: [
            {
              role: 'system',
              content: 'You are an academic assessment author. Output strict JSON only.',
            },
            {
              role: 'user',
              content: buildLocalOllamaPrompt(normalizedParams),
            },
          ],
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = (await res.json()) as { message?: { content?: string } };
      const parsed = JSON.parse(json?.message?.content ?? '{}') as { questions?: unknown[] };
      const rawList = Array.isArray(parsed.questions)
        ? parsed.questions
        : Array.isArray(parsed)
          ? (parsed as unknown[])
          : [];

      const drafts = normalizeDraftQuestions(rawList, normalizedParams);
      if (drafts.length === 0) {
        throw new Error('Empty model output');
      }
      return drafts;
    } catch {
      throw new AppError(
        'AI_UNAVAILABLE',
        `AI provider is currently unreachable (checked Supabase Edge Function and local Ollama model "${ollamaModel}"). Start Ollama locally or continue adding questions manually.`
      );
    }
  },
};
