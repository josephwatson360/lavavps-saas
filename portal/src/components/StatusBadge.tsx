import { clsx } from 'clsx';
import type { AgentStatus } from '@/api/types';

interface StatusBadgeProps {
  status: AgentStatus;
  showDot?: boolean;
  size?: 'sm' | 'md';
}

const STATUS_CONFIG: Record<AgentStatus, {
  label: string;
  className: string;
  dotClass: string;
  animate?: boolean;
}> = {
  RUNNING:      { label: 'Running',      className: 'badge-running',      dotClass: 'bg-green-400',  animate: true },
  STOPPED:      { label: 'Stopped',      className: 'badge-stopped',      dotClass: 'bg-muted' },
  STARTING:     { label: 'Starting',     className: 'badge-starting',     dotClass: 'bg-blue-400',   animate: true },
  PROVISIONING: { label: 'Provisioning', className: 'badge-provisioning', dotClass: 'bg-yellow-400', animate: true },
  SUSPENDED:    { label: 'Suspended',    className: 'badge-suspended',    dotClass: 'bg-red-400' },
  DELETING:     { label: 'Deleting',     className: 'badge-suspended',    dotClass: 'bg-red-400',    animate: true },
};

export function StatusBadge({ status, showDot = true, size = 'md' }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.STOPPED;

  return (
    <span className={clsx(config.className, size === 'sm' && 'text-[10px] px-1.5 py-0')}>
      {showDot && (
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full',
            config.dotClass,
            config.animate && 'animate-pulse',
          )}
        />
      )}
      {config.label}
    </span>
  );
}
