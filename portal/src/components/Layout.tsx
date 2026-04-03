import { NavLink, useNavigate, Outlet } from 'react-router-dom';
import {
  LayoutGrid, MessageSquare, Settings, FolderOpen,
  Briefcase, CreditCard, LogOut, ChevronLeft, User, Bot,
  Flame, Menu, X,
} from 'lucide-react';
import { clsx }       from 'clsx';
import { useAuth }    from '@/hooks/useAuth';
import { useStore }   from '@/store/useStore';
import { ToastContainer } from './Toast';

const NAV_ITEMS = [
  { to: '/dashboard', icon: LayoutGrid,  label: 'Agents' },
  { to: '/chat',      icon: MessageSquare, label: 'Chat' },
  { to: '/files',     icon: FolderOpen,  label: 'Files' },
  { to: '/jobs',      icon: Briefcase,   label: 'Jobs' },
  { to: '/billing',   icon: CreditCard,  label: 'Billing' },
  { to: '/settings',  icon: Settings,    label: 'Settings' },
];

export function Layout() {
  const { logout, tenant }              = useAuth();
  const { sidebarOpen, setSidebarOpen } = useStore();

  return (
    <div className="flex h-screen bg-obsidian-950 overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={clsx(
        'fixed lg:relative inset-y-0 left-0 z-30',
        'flex flex-col w-56 bg-obsidian-900 border-r border-border',
        'transition-transform duration-200 lg:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      )}>
        {/* Logo */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-lava-500/10 border border-lava-500/30 flex items-center justify-center">
              <Flame size={14} className="text-lava-400" />
            </div>
            <span className="font-display font-bold text-text text-sm tracking-wide">LavaVPS</span>
          </div>
          <button
            className="lg:hidden btn-icon btn-ghost"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={14} />
          </button>
        </div>

        {/* Plan badge */}
        {tenant && (
          <div className="px-4 py-2.5 border-b border-border">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded bg-lava-500/10 flex items-center justify-center">
                <Bot size={10} className="text-lava-400" />
              </div>
              <div>
                <p className="text-[10px] text-muted uppercase tracking-wider">Plan</p>
                <p className="text-xs font-medium text-text capitalize">{tenant.planCode}</p>
              </div>
            </div>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) => clsx(
                'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all',
                isActive
                  ? 'bg-lava-500/10 text-lava-400 border border-lava-500/20'
                  : 'text-muted hover:text-text hover:bg-obsidian-800',
              )}
            >
              <Icon size={15} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Bottom: user + logout */}
        <div className="px-2 py-3 border-t border-border space-y-0.5">
          <NavLink
            to="/account"
            className={({ isActive }) => clsx(
              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all',
              isActive
                ? 'bg-lava-500/10 text-lava-400'
                : 'text-muted hover:text-text hover:bg-obsidian-800',
            )}
          >
            <User size={15} />
            Account
          </NavLink>
          <button
            onClick={logout}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted hover:text-red-400 hover:bg-red-900/10 transition-all"
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar (mobile) */}
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-obsidian-900">
          <button
            className="btn-icon btn-ghost"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={18} />
          </button>
          <div className="flex items-center gap-2">
            <Flame size={14} className="text-lava-400" />
            <span className="font-display font-bold text-sm text-text">LavaVPS</span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto bg-mesh">
          <Outlet />
        </main>
      </div>

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  );
}
