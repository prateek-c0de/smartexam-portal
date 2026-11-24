interface ProgressBarProps {
  value: number;
  max: number;
  variant?: 'brand' | 'success' | 'warning' | 'error';
  showLabel?: boolean;
  height?: 'sm' | 'md';
}

export default function ProgressBar({
  value,
  max,
  variant = 'brand',
  showLabel = false,
  height = 'md',
}: ProgressBarProps) {
  const pct = Math.min(100, Math.round((value / max) * 100));

  const colors = {
    brand: 'bg-brand-500',
    success: 'bg-success-500',
    warning: 'bg-warning-500',
    error: 'bg-error-500',
  };

  return (
    <div className="w-full">
      <div
        className={`w-full ${height === 'sm' ? 'h-1.5' : 'h-2.5'} bg-neutral-200 rounded-full overflow-hidden`}
      >
        <div
          className={`h-full ${colors[variant]} rounded-full transition-all duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <div className="flex justify-between mt-1.5 text-xs font-medium text-neutral-500">
          <span>{value} of {max}</span>
          <span>{pct}%</span>
        </div>
      )}
    </div>
  );
}
