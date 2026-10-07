import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { isActive, type Inputs, type Run, type Template } from '../types';

export function useStudio() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const submission = useRef<{ signature: string; key: string } | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const reads = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.health(controller.signal), api.templates(controller.signal)])
      .then(([health, response]) => {
        if (controller.signal.aborted) return;
        if (health.mode !== 'mock') throw new Error('当前工作台仅支持模拟演示服务。');
        setTemplates(response.templates); setConnected(true); setLoadError(null);
      })
      .catch((failure: Error) => { if (!controller.signal.aborted) { setConnected(false); setLoadError(failure.message); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let controller: AbortController | undefined;
    const poll = async () => {
      if (stopped || document.hidden) return;
      if (lock.current) { timer = setTimeout(poll, 2000); return; }
      controller = new AbortController(); reads.current = controller;
      try {
        const [history, detail] = await Promise.all([
          api.runs(controller.signal), selectedId ? api.run(selectedId, controller.signal) : Promise.resolve(null),
        ]);
        if (stopped || controller.signal.aborted) return;
        const next = detail ? [detail.run, ...history.runs.filter(run => run.id !== detail.run.id)] : history.runs;
        next.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        setRuns(next); setPollError(null); failures = 0;
        timer = setTimeout(poll, next.some(isActive) ? 2000 : 10000);
      } catch (failure) {
        if (stopped || controller.signal.aborted) return;
        setPollError((failure as Error).message);
        failures += 1; timer = setTimeout(poll, Math.min(30000, 3000 * 2 ** failures));
      }
    };
    const onVisibility = () => {
      clearTimeout(timer); controller?.abort();
      if (!document.hidden) void poll();
    };
    void poll(); document.addEventListener('visibilitychange', onVisibility);
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [selectedId, revision]);

  useEffect(() => () => { mutation.current?.abort(); }, []);

  const execute = async (operation: (signal: AbortSignal) => Promise<{ run: Run }>) => {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setActionError(null); reads.current?.abort();
    const controller = new AbortController(); mutation.current = controller;
    try {
      const { run } = await operation(controller.signal);
      if (controller.signal.aborted) return false;
      setRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
      setSelectedId(run.id); return true;
    } catch (failure) {
      if (!controller.signal.aborted) setActionError((failure as Error).message);
      return false;
    } finally {
      lock.current = false;
      if (!controller.signal.aborted) { setBusy(false); refresh(); }
    }
  };
  const createRun = async (templateId: string, inputs: Inputs, workflowRevision?: number) => {
    const signature = JSON.stringify({ templateId, inputs, ...(workflowRevision === undefined ? {} : { workflowRevision }) });
    if (submission.current?.signature !== signature) submission.current = { signature, key: crypto.randomUUID() };
    const key = submission.current.key;
    const success = await execute(signal => api.create(templateId, inputs, key, signal, workflowRevision));
    if (success) submission.current = null;
    return success;
  };
  const runAction = (id: string, action: 'retry' | 'cancel') => execute(signal => api.action(id, action, signal));
  return { templates, runs, selectedId, setSelectedId, loading, connected, error: loadError || pollError, actionError, busy, refresh, createRun, runAction };
}
