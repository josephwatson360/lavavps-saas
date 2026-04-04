import { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  Upload, Download, Trash2, File, FolderOpen, Loader2,
  AlertTriangle, HardDrive, Plus, X, AlertCircle,
} from 'lucide-react';
import { clsx }         from 'clsx';
import { filesApi }     from '@/api/client';
import { useStore, toast } from '@/store/useStore';
import type { WorkspaceFile } from '@/api/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024)          return `${bytes} B`;
  if (bytes < 1024 * 1024)   return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function FileManager() {
  const { agentId: paramId } = useParams<{ agentId: string }>();
  const { agents }  = useStore();
  const agentId     = paramId ?? agents[0]?.agentId;

  const [files, setFiles]         = useState<WorkspaceFile[]>([]);
  const [loading, setLoading]     = useState(true);
  const [uploading, setUploading] = useState(false);
  const [quotaGb, setQuotaGb]     = useState(5);
  const [usedGb, setUsedGb]       = useState(0);
  const [dragOver, setDragOver]   = useState(false);
  const fileInputRef              = useRef<HTMLInputElement>(null);

  async function loadFiles() {
    if (!agentId) return;
    setLoading(true);
    try {
      const res = await filesApi.list(agentId);
      setFiles(res.files);
      setQuotaGb(res.storageQuotaGb);
      setUsedGb(res.storageUsedGb);
    } catch {
      toast.error('Failed to load files');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadFiles(); }, [agentId]); // eslint-disable-line

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || !agentId) return;
    setUploading(true);
    let success = 0;
    for (const file of Array.from(fileList)) {
      try {
        const { uploadUrl } = await filesApi.getUploadUrl(agentId, file.name, file.size, file.type);
        await filesApi.uploadToS3(uploadUrl, file);
        success++;
      } catch (err: unknown) {
        const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
        if (msg?.includes('QUOTA')) {
          toast.error('Storage quota exceeded. Purchase additional storage.');
          break;
        }
        toast.error(`Failed to upload ${file.name}`);
      }
    }
    if (success > 0) {
      toast.success(`${success} file${success > 1 ? 's' : ''} uploaded`);
      loadFiles();
    }
    setUploading(false);
  }

  async function handleDownload(fileKey: string) {
    if (!agentId) return;
    try {
      const { downloadUrl } = await filesApi.getDownloadUrl(agentId, fileKey);
      window.open(downloadUrl, '_blank');
    } catch {
      toast.error('Failed to get download link');
    }
  }

  async function handleDelete(fileKey: string) {
    if (!agentId) return;
    if (!confirm(`Delete "${fileKey}"?`)) return;
    try {
      await filesApi.delete(agentId, fileKey);
      setFiles(prev => prev.filter(f => f.key !== fileKey));
      toast.success('File deleted');
    } catch {
      toast.error('Failed to delete file');
    }
  }

  const usedPct   = quotaGb > 0 ? (usedGb / quotaGb) * 100 : 0;
  const nearQuota = usedPct > 80;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* No agents warning */}
      {agents.length === 0 && (
        <div className="mb-6 p-4 rounded-xl border border-yellow-900/40 bg-yellow-900/10 flex items-start gap-3">
          <AlertCircle size={16} className="text-yellow-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-yellow-300">No agents provisioned yet</p>
            <p className="text-xs text-yellow-400/70 mt-0.5">
              File uploads require an active agent. Each agent has its own EFS workspace.{' '}
              <a href="/new-agent" className="underline hover:text-yellow-300 transition-colors">
                Create an agent first
              </a>{' '}
              to start uploading files.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">File Manager</h1>
          <p className="text-sm text-muted mt-1">Agent workspace — EFS storage</p>
        </div>

        {/* Agent selector */}
        {agents.length > 1 && (
          <select className="input w-48" value={agentId} onChange={() => {}}>
            {agents.map(a => (
              <option key={a.agentId} value={a.agentId}>
                {a.name || a.agentId.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Storage quota */}
      <div className="card p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <HardDrive size={15} className="text-muted" />
            <span className="text-sm font-medium text-text">Storage</span>
            {nearQuota && (
              <span className="flex items-center gap-1 text-xs text-yellow-400">
                <AlertTriangle size={11} /> Near limit
              </span>
            )}
          </div>
          <span className="text-xs text-muted font-mono">
            {usedGb.toFixed(2)} GB / {quotaGb} GB
          </span>
        </div>
        <div className="w-full h-1.5 rounded-full bg-obsidian-700">
          <div
            className={clsx(
              'h-1.5 rounded-full transition-all',
              nearQuota ? 'bg-yellow-500' : 'bg-lava-500',
            )}
            style={{ width: `${Math.min(usedPct, 100)}%` }}
          />
        </div>
        {nearQuota && (
          <button className="mt-3 btn-primary text-xs px-3 py-1.5">
            Purchase Additional Storage
          </button>
        )}
      </div>

      {/* Upload area */}
      <div
        className={clsx(
          'border-2 border-dashed rounded-xl p-8 text-center mb-6 transition-all cursor-pointer',
          dragOver
            ? 'border-lava-500/60 bg-lava-500/5'
            : 'border-border hover:border-obsidian-500',
        )}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); handleUpload(e.dataTransfer.files); }}
        onClick={() => fileInputRef.current?.click()}
      >
        {uploading ? (
          <div className="flex items-center justify-center gap-2 text-muted">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm">Uploading...</span>
          </div>
        ) : (
          <>
            <Upload size={20} className="mx-auto text-muted mb-2" />
            <p className="text-sm text-text font-medium">Drop files here or click to upload</p>
            <p className="text-xs text-muted mt-1">Max 100 MB per file</p>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          onChange={e => handleUpload(e.target.files)}
        />
      </div>

      {/* File list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="text-muted animate-spin" />
        </div>
      ) : files.length === 0 ? (
        <div className="text-center py-16">
          <FolderOpen size={32} className="mx-auto text-muted mb-3" />
          <p className="text-sm text-muted">No files in workspace yet</p>
          <p className="text-xs text-muted mt-1">
            Upload files to make them available to your agent
          </p>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {files.map(file => (
            <div
              key={file.key}
              className="flex items-center gap-3 px-4 py-3 hover:bg-obsidian-800/50 transition-colors group"
            >
              <File size={15} className="text-muted flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-text truncate">{file.key}</p>
                <p className="text-xs text-muted">
                  {formatBytes(file.size)} ·{' '}
                  {new Date(file.lastModified).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  className="btn-icon btn-ghost"
                  onClick={() => handleDownload(file.key)}
                  title="Download"
                >
                  <Download size={13} />
                </button>
                <button
                  className="btn-icon btn-danger"
                  onClick={() => handleDelete(file.key)}
                  title="Delete"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
