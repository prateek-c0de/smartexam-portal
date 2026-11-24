import { GraduationCap } from 'lucide-react';

interface LogoProps {
  variant?: 'light' | 'dark';
  size?: 'sm' | 'md' | 'lg';
}

export default function Logo({ variant = 'dark', size = 'md' }: LogoProps) {
  const textColor = variant === 'light' ? 'text-white' : 'text-neutral-900';
  const subColor = variant === 'light' ? 'text-brand-200' : 'text-brand-600';

  const iconSize = size === 'lg' ? 'h-11 w-11' : size === 'sm' ? 'h-8 w-8' : 'h-9 w-9';
  const titleSize = size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-lg' : 'text-xl';
  const subSize = size === 'lg' ? 'text-sm' : 'text-xs';

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-lg shadow-brand-500/20">
        <GraduationCap className={`${iconSize} p-2 text-white`} />
      </div>
      <div>
        <h1 className={`${titleSize} font-bold leading-none ${textColor}`}>
          Smart<span className="text-brand-500">Exam</span>
        </h1>
        <p className={`${subSize} font-medium tracking-wide ${subColor} mt-1`}>
          ONLINE EXAMINATION PLATFORM
        </p>
      </div>
    </div>
  );
}
