import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useStore, type Toast } from '@/store/useStore';

const TOAST_CONFIG = {
  success: { icon: CheckCircle, className: 'border-green-900/40 bg-green-900/10 text-green-400' },
  error:   { icon: XCircle,     className: 'border-red-900/40   bg-red-900/10   text-red-400' },
  warning: { icon: AlertTriangle, className: 'border-yellow-900/40 bg-yellow-900/10 text-yellow-400' },
  info:    { icon: Info,        className: 'border-blue-900/40  bg-blue-900/10  text-blue-400' },
};

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useStore(s => s.removeToast);
  const { icon: Icon, className } = TOAST_CONFIG[toast.type];

  return (
    <div className={clsx(
      'flex items-start gap-3 p-3 pr-4 rounded-xl border shadow-card',
      'animate-slide-up min-w-[280px] max-w-sm',
      className,
    )}>
      <Icon size={16} className="flex-shrink-0 mt-0.5" />
      <p className="text-sm text-text flex-1 leading-relaxed">{toast.message}</p>
      <button
        onClick={() => removeToast(toast.id)}
        className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useStore(s => s.toasts);

  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(t => <ToastItem key={t.id} toast={t} />)}
    </div>
  );
}
