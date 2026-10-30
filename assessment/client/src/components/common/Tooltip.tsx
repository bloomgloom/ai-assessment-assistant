import { ReactNode } from 'react';

interface TooltipProps {
  content?: ReactNode;
  children: ReactNode;
  align?: 'center' | 'end';
}

export function Tooltip({ content, children, align = 'center' }: TooltipProps) {
  if (!content) return <>{children}</>;

  const positionClass = align === 'end'
    ? 'right-0'
    : 'left-1/2 -translate-x-1/2';

  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none invisible absolute top-full z-[100] mt-2 w-max max-w-72 rounded bg-gray-900 px-2 py-1 text-center text-xs font-normal leading-4 text-white opacity-0 shadow-lg transition-opacity delay-150 group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-focus-within/tooltip:visible group-focus-within/tooltip:opacity-100 ${positionClass}`}
      >
        {content}
      </span>
    </span>
  );
}
