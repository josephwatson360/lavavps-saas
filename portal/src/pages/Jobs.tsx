import { useEffect, useState } from 'react';
import { useParams }   from 'react-router-dom';
import { Plus, Loader2, Play, Square, Clock, CheckCircle2, XCircle, Briefcase } from 'lucide-react';
import { clsx }         from 'clsx';
import { jobsApi }      from '@/api/client';
import { useStore, toast } from '@/store/useStore';
import type { Job }     from '@/api/types';
import { formatDistanceToNow } from 'date-fns';

export function Jobs() {
  const { agentId: paramId } = useParams<{ agentId: string }>();
  const { agents, tenant }   = useStore();
  const agentId = paramId ?? agents[0]?.agentId;
  const isPro   = tenant?.planCode === 'pro' || tenant?.planCode === 'business';

  const [jobs, setJobs]          = useState<Job[]>([]);
  const [loading, setLoading]    = useState(true);
  const [showForm, setShowForm]  = useState(false);
  const [title, setTitle]        = useState('');
  const [tasks, setTasks]        = useState('');
  const [maxIter, setMaxIter]    = useState(10);
  const [creating, setCreating]  = useState(false);

  async function loadJobs() {
    if (!agentId) return;
    setLoading(true);
    try {
      const { jobs: list } = await jobsApi.list(agentId);
      setJobs(list);
    } catch {
      toast.error('Failed to load jobs');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadJobs(); }, [agentId]); // eslint-disable-line

  async function handleCreate() {
    if (!agentId || !title.trim() || !tasks.trim()) return;
    setCreating(true);
    try {
      const job = await jobsApi.create(agentId, { title, tasks, maxIterations: maxIter });
      toast.success('Job created');
      setShowForm(false);
      setTitle(''); setTasks(''); setMaxIter(10);
      loadJobs();
    } catch {
      toast.error('Failed to create job');
    } finally {
      setCreating(false);
    }
  }

  async function handleCancel(jobId: string) {
    if (!agentId || !confirm('Cancel this job?')) return;
    try {
      await jobsApi.cancel(agentId, jobId);
      setJobs(prev => prev.map(j => j.jobId === jobId ? { ...j, status: 'CANCELLED' } : j));
    } catch {
      toast.error('Failed to cancel job');
    }
  }

  if (!isPro) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-16 text-center">
        <div className="w-14 h-14 rounded-2xl bg-obsidian-800 border border-border flex items-center justify-center mx-auto mb-4">
          <Briefcase size={24} className="text-muted" />
        </div>
        <h2 className="font-display text-xl font-bold text-text mb-2">Autonomous Tasks</h2>
        <p className="text-sm text-muted mb-6">
          Ralph Loop — autonomous task execution — is available on Pro and Business plans.
        </p>
        <button className="btn-primary" onClick={() => window.location.href = '/billing'}>
          Upgrade to Pro
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">Autonomous Tasks</h1>
          <p className="text-sm text-muted mt-1">Ralph Loop — let your agent work independently</p>
        </div>
        <button className="btn-primary" onClick={() => setShowForm(true)}>
          <Plus size={14} />
          New Job
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="card p-5 mb-6 animate-slide-up">
          <h2 className="text-sm font-semibold text-text mb-4">Create Job</h2>
          <div className="space-y-4">
            <div>
              <label className="label">Job Title</label>
              <input
                className="input"
                placeholder="e.g., Research competitor pricing"
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Task List (Markdown)</label>
              <textarea
                className="input"
                rows={6}
                placeholder={'- [ ] Research top 5 competitors\n- [ ] Summarize pricing models\n- [ ] Write comparison report'}
                value={tasks}
                onChange={e => setTasks(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Max Iterations ({maxIter})</label>
              <input
                type="range"
                min={1} max={50} step={1}
                value={maxIter}
                onChange={e => setMaxIter(parseInt(e.target.value))}
                className="w-full accent-lava-500"
              />
              <div className="flex justify-between text-[10px] text-muted">
                <span>1</span><span>50</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary flex-1" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn-primary flex-1" onClick={handleCreate} disabled={creating || !title || !tasks}>
                {creating ? <><Loader2 size={13} className="animate-spin" /> Creating...</> : <><Play size={13} /> Start Job</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Jobs list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin text-muted" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16">
          <Briefcase size={28} className="mx-auto text-muted mb-3" />
          <p className="text-sm text-muted">No jobs yet</p>
          <p className="text-xs text-muted mt-1">Create a task list and let your agent work autonomously</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => <JobCard key={job.jobId} job={job} onCancel={handleCancel} />)}
        </div>
      )}
    </div>
  );
}

function JobCard({ job, onCancel }: { job: Job; onCancel: (id: string) => void }) {
  const STATUS_ICON = {
    PENDING:   <Clock size={14} className="text-yellow-400" />,
    RUNNING:   <Loader2 size={14} className="text-blue-400 animate-spin" />,
    COMPLETED: <CheckCircle2 size={14} className="text-green-400" />,
    FAILED:    <XCircle size={14} className="text-red-400" />,
    CANCELLED: <Square size={14} className="text-muted" />,
  };

  return (
    <div className={clsx(
      'card p-4',
      job.status === 'RUNNING' && 'border-blue-900/30',
      job.status === 'COMPLETED' && 'border-green-900/20',
    )}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          {STATUS_ICON[job.status]}
          <h3 className="text-sm font-semibold text-text">{job.title}</h3>
        </div>
        {(job.status === 'RUNNING' || job.status === 'PENDING') && (
          <button
            className="btn-ghost text-xs text-red-400 hover:text-red-300 px-2 py-1"
            onClick={() => onCancel(job.jobId)}
          >
            Cancel
          </button>
        )}
      </div>

      {/* Progress */}
      {(job.status === 'RUNNING' || job.status === 'COMPLETED') && (
        <div className="mb-3">
          <div className="flex justify-between text-[10px] text-muted mb-1">
            <span>Progress</span>
            <span>{job.iterationCount}/{job.maxIterations} iterations</span>
          </div>
          <div className="w-full h-1 rounded-full bg-obsidian-700">
            <div
              className="h-1 rounded-full bg-blue-500 transition-all"
              style={{ width: `${(job.iterationCount / job.maxIterations) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Result */}
      {job.result && (
        <div className="mt-2 p-3 rounded-lg bg-obsidian-800 border border-border">
          <p className="text-xs text-muted mb-1">Result</p>
          <p className="text-xs text-text leading-relaxed">{job.result}</p>
        </div>
      )}

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
        <span className="text-xs text-muted">
          Created {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
        </span>
        {job.completedAt && (
          <span className="text-xs text-muted">
            Completed {formatDistanceToNow(new Date(job.completedAt), { addSuffix: true })}
          </span>
        )}
      </div>
    </div>
  );
}
