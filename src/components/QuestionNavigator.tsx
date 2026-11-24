import type { AnswerMap, QuestionStatus } from '@/types';
import { Flag, CheckCircle2, Circle } from 'lucide-react';

interface QuestionNavigatorProps {
  questions: { id: number; section: string }[];
  answers: AnswerMap;
  statuses: QuestionStatus;
  currentIndex: number;
  onJump: (index: number) => void;
}

export default function QuestionNavigator({
  questions,
  answers,
  statuses,
  currentIndex,
  onJump,
}: QuestionNavigatorProps) {
  // Group by section
  const sections: Record<string, number[]> = {};
  questions.forEach((q) => {
    if (!sections[q.section]) sections[q.section] = [];
    sections[q.section].push(q.id);
  });

  function getButtonClass(qid: number) {
    const isAnswered = answers[qid] !== undefined;
    const isMarked = statuses[qid] === 'marked' || statuses[qid] === 'answered-marked';
    const isCurrent = questions[currentIndex]?.id === qid;

    let bg = 'bg-white border-neutral-300 text-neutral-600 hover:border-neutral-400';
    if (isAnswered) bg = 'bg-success-500 border-success-500 text-white hover:bg-success-600';
    if (isMarked && !isAnswered) bg = 'bg-warning-400 border-warning-400 text-warning-900 hover:bg-warning-500';
    if (isMarked && isAnswered) bg = 'bg-success-500 border-success-500 text-white hover:bg-success-600';
    if (isCurrent) bg += ' ring-2 ring-brand-500 ring-offset-1';

    return bg;
  }

  const answeredCount = Object.keys(answers).length;

  return (
    <div className="flex flex-col h-full">
      {/* Summary */}
      <div className="p-4 border-b border-neutral-200">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-neutral-900">Question Navigator</h3>
          <span className="text-xs font-semibold text-neutral-500">
            {answeredCount}/{questions.length}
          </span>
        </div>
        {/* Legend */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-neutral-600">
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded bg-success-500" />
            Answered
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded bg-warning-400" />
            Flagged
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded border border-neutral-300 bg-white" />
            Unseen
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded border-2 border-brand-500" />
            Current
          </div>
        </div>
      </div>

      {/* Question grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {Object.entries(sections).map(([section, qids]) => (
          <div key={section} className="mb-5 last:mb-0">
            <p className="text-xs font-bold text-neutral-500 uppercase tracking-wide mb-2.5">
              {section}
            </p>
            <div className="grid grid-cols-5 gap-2">
              {qids.map((qid) => {
                const qIndex = questions.findIndex((q) => q.id === qid);
                const isMarked = statuses[qid] === 'marked' || statuses[qid] === 'answered-marked';
                return (
                  <button
                    key={qid}
                    onClick={() => onJump(qIndex)}
                    className={`relative h-10 rounded-lg border-2 text-sm font-bold transition-all ${getButtonClass(qid)}`}
                  >
                    {qIndex + 1}
                    {isMarked && (
                      <Flag className="absolute -top-1 -right-1 h-3.5 w-3.5 text-warning-600 fill-warning-400" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer summary icons */}
      <div className="p-4 border-t border-neutral-200 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 text-neutral-600">
            <CheckCircle2 className="h-4 w-4 text-success-500" />
            Answered
          </span>
          <span className="font-bold text-neutral-900">{answeredCount}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 text-neutral-600">
            <Circle className="h-4 w-4 text-neutral-300" />
            Remaining
          </span>
          <span className="font-bold text-neutral-900">{questions.length - answeredCount}</span>
        </div>
      </div>
    </div>
  );
}
