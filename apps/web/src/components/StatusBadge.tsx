import { statusLabel, type RunStatus, type NodeStatus } from '../types';

export function StatusBadge({ status }: { status: RunStatus | NodeStatus }) {
  return <span className={`status-badge status-${status}`}><span aria-hidden="true" />{statusLabel[status]}</span>;
}
