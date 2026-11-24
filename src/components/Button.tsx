import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'success';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  children: ReactNode;
}

export default function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  children,
  className = '',
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    primary:
      'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 focus:ring-brand-500 shadow-sm hover:shadow-md',
    secondary:
      'bg-neutral-800 text-white hover:bg-neutral-900 active:bg-neutral-950 focus:ring-neutral-600 shadow-sm',
    outline:
      'border-2 border-neutral-300 text-neutral-700 hover:border-brand-500 hover:text-brand-600 active:border-brand-600 focus:ring-brand-500 bg-white',
    ghost:
      'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 active:bg-neutral-200 focus:ring-neutral-400',
    danger:
      'bg-error-600 text-white hover:bg-error-700 active:bg-error-800 focus:ring-error-500 shadow-sm hover:shadow-md',
    success:
      'bg-success-600 text-white hover:bg-success-700 active:bg-success-800 focus:ring-success-500 shadow-sm hover:shadow-md',
  };

  const sizes = {
    sm: 'text-sm px-4 py-2',
    md: 'text-sm px-5 py-2.5',
    lg: 'text-base px-7 py-3.5',
  };

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
