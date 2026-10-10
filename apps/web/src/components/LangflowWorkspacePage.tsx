import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, CircleHelp, Clock3, ExternalLink, LoaderCircle, PlugZap, RefreshCw, Save, Send, Workflow as WorkflowIcon, XCircle } from 'lucide-react';
import { ApiError, api } from '../api';
import { isLangflowRunActive, langflowRunStatusDescription, langflowRunStatusLabel, safeEditorHref, validateLangflowConfig, validateLangflowInput } from '../langflowUtils';
import type { LangflowConfig, LangflowConfigResponse, LangflowFlow, LangflowRun, LangflowStatus } from '../types';

const copy = <T,>(value: T): T => structuredClone(value);
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未知';
const defaultConfig: LangflowConfig = { baseUrl: 'http://127.0.0.1:7860', authMode: 'local-development', secretEnv: '', timeoutMs: 30000 };

const errorText = (failure: unknown, fallback: string) => failure instanceof Error && failure.message ? failure.message : fallback;
const isOutcomeUncertain = (failure: unknown) => failure instanceof ApiError && (failure.status === 0 || failure.status >= 500);

export function LangflowWorkspacePage() {
  const [configResponse, setConfigResponse] = useState<LangflowConfigResponse | null>(null);
  const [config, setConfig] = useState<LangflowConfig>(copy(defaultConfig));
  const [baseConfig, setBaseConfig] = useState<LangflowConfig | null>(null);
  const [status, setStatus] = useState<LangflowStatus | null>(null);
  const [flows, setFlows] = useState<LangflowFlow[]>([]);
  const [selectedFlowId, setSelectedFlowId] = useState('');
  const [runs, setRuns] = useState<LangflowRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [flowBusy, setFlowBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [unknownSignatures, setUnknownSignatures] = useState<string[]>([]);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const historyController = useRef<AbortController | null>(null);
  const flowController = useRef<AbortController | null>(null);

  const dirty = !!baseConfig && JSON.stringify(config) !== JSON.stringify(baseConfig);
  const busy = refreshing || saving || submitting || flowBusy;
  const selectedFlow = flows.find(flow => flow.id === selectedFlowId) || null;
  const selectedRun = runs.find(run => run.id === selectedRunId) || null;
  const activeRuns = runs.some(run => isLangflowRunActive(run.status));
  const runSignature = selectedFlow && input.trim() ? `${selectedFlow.id}\u0000${input.trim()}` : '';
  const historyHasUnknown = runs.some(run => run.status === 'outcome_unknown' && run.flowId === selectedFlowId && run.input.trim() === input.trim());
  const repeatedUnknown = !!runSignature && (unknownSignatures.includes(runSignature) || historyHasUnknown);
  const editorHref = status ? safeEditorHref(status.editorUrl) : null;
  const configIssue = useMemo(() => validateLangflowConfig(config), [config]);

  const installConfig = (next: LangflowConfigResponse) => {
    setConfigResponse(next);
    setConfig(copy(next.config));
    setBaseConfig(copy(next.config));
    setConfigError(null);
    setConflict(false);
  };

  const loadWorkspace = useCallback(async (signal: AbortSignal) => {
    const [configResult, statusResult, historyResult] = await Promise.allSettled([
      api.langflowConfig(signal), api.langflowStatus(signal), api.langflowRuns(signal),
    ]);
    if (signal.aborted) return;

    if (configResult.status === 'fulfilled') installConfig(configResult.value);
    else setConfigError(errorText(configResult.reason, '无法读取 Langflow 连接配置。'));

    if (statusResult.status === 'fulfilled') {
      setStatus(statusResult.value);
      setStatusError(null);
      if (statusResult.value.connected) {
        try {
          const flowResponse = await api.langflowFlows(signal);
          if (!signal.aborted) {
            setFlows(flowResponse.flows);
            setFlowError(null);
            setSelectedFlowId(current => flowResponse.flows.some(flow => flow.id === current) ? current : flowResponse.flows[0]?.id || '');
          }
        } catch (failure) {
          if (!signal.aborted) { setFlows([]); setSelectedFlowId(''); setFlowError(errorText(failure, '无法读取 Langflow 原生流程列表。')); }
        }
      } else {
        setFlows([]); setSelectedFlowId(''); setFlowError(null);
      }
    } else {
      setStatus(null); setFlows([]); setSelectedFlowId(''); setStatusError(errorText(statusResult.reason, '无法读取 Langflow 连接状态。'));
    }

    if (historyResult.status === 'fulfilled') {
      setRuns(historyResult.value.runs);
      setSelectedRunId(current => historyResult.value.runs.some(run => run.id === current) ? current : historyResult.value.runs[0]?.id || '');
      setHistoryError(null);
    } else setHistoryError(errorText(historyResult.reason, '无法读取 Langflow 运行历史。'));
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    readController.current = controller;
    void loadWorkspace(controller.signal);
    return () => {
      controller.abort(); historyController.current?.abort(); writeController.current?.abort(); flowController.current?.abort();
    };
  }, [loadWorkspace]);

  const refreshHistory = useCallback(async (showBusy = false) => {
    historyController.current?.abort();
    const controller = new AbortController();
    historyController.current = controller;
    if (showBusy) setHistoryBusy(true);
    try {
      const response = await api.langflowRuns(controller.signal);
      if (!controller.signal.aborted) {
        setRuns(response.runs);
        setSelectedRunId(current => response.runs.some(run => run.id === current) ? current : response.runs[0]?.id || '');
        setHistoryError(null);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setHistoryError(errorText(failure, '无法刷新 Langflow 运行历史。'));
    } finally {
      if (!controller.signal.aborted && showBusy) setHistoryBusy(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const poll = async () => {
      if (disposed) return;
      if (document.hidden) { timer = setTimeout(poll, 10000); return; }
      await refreshHistory();
      if (!disposed) timer = setTimeout(poll, activeRuns ? 3000 : 15000);
    };
    const onVisibility = () => {
      if (!document.hidden) { if (timer) clearTimeout(timer); void poll(); }
    };
    timer = setTimeout(poll, activeRuns ? 3000 : 15000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { disposed = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); historyController.current?.abort(); };
  }, [activeRuns, refreshHistory]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    const guardNavigation = (event: MouseEvent) => {
      if ((!dirty && !busy) || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href^="#"]');
      if (!link || link.hash === '#workflows') return;
      event.preventDefault();
      if (busy) return;
      if (window.confirm('Langflow 连接配置有未保存修改，离开会丢弃这些内容。确定离开吗？')) window.location.hash = link.hash;
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', guardNavigation, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', guardNavigation, true); };
  }, [dirty, busy]);

  const confirmDiscard = () => !dirty || window.confirm('Langflow 连接配置有未保存修改，继续会丢弃这些内容。确定继续吗？');
  const refreshWorkspace = async () => {
    if (busy || !confirmDiscard()) return;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    setRefreshing(true); setLoading(true);
    try { await loadWorkspace(controller.signal); }
    finally { if (!controller.signal.aborted) setRefreshing(false); }
  };

  const refreshFlows = async () => {
    if (busy || !status?.connected) return;
    flowController.current?.abort();
    const controller = new AbortController(); flowController.current = controller;
    setFlowBusy(true);
    setFlowError(null);
    try {
      const response = await api.langflowFlows(controller.signal);
      if (!controller.signal.aborted) {
        setFlows(response.flows);
        setSelectedFlowId(current => response.flows.some(flow => flow.id === current) ? current : response.flows[0]?.id || '');
      }
    } catch (failure) { if (!controller.signal.aborted) setFlowError(errorText(failure, '无法刷新 Langflow 流程列表。')); }
    finally { if (!controller.signal.aborted) setFlowBusy(false); }
  };

  const refreshConnection = async (signal: AbortSignal) => {
    try {
      const nextStatus = await api.langflowStatus(signal);
      if (signal.aborted) return;
      setStatus(nextStatus); setStatusError(null);
      if (nextStatus.connected) {
        try {
          const response = await api.langflowFlows(signal);
          if (!signal.aborted) { setFlows(response.flows); setFlowError(null); setSelectedFlowId(current => response.flows.some(flow => flow.id === current) ? current : response.flows[0]?.id || ''); }
        } catch (failure) { if (!signal.aborted) { setFlows([]); setSelectedFlowId(''); setFlowError(errorText(failure, '无法读取 Langflow 原生流程列表。')); } }
      } else { setFlows([]); setSelectedFlowId(''); setFlowError(null); }
    } catch (failure) { if (!signal.aborted) setStatusError(errorText(failure, '无法读取 Langflow 连接状态。')); }
  };

  const saveConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!configResponse || busy || !dirty) return;
    const issue = validateLangflowConfig(config);
    if (issue) { setConfigError(issue); return; }
    const controller = new AbortController(); writeController.current = controller;
    setSaving(true); setConfigError(null); setConflict(false);
    try {
      const response = await api.saveLangflowConfig(configResponse.revision, config, controller.signal);
      if (controller.signal.aborted) return;
      installConfig(response);
      await refreshConnection(controller.signal);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true); setConfigError('连接配置版本已变化；当前编辑内容已保留。重新加载后再保存。');
      } else setConfigError(errorText(failure, '保存 Langflow 连接配置失败。'));
    } finally { if (!controller.signal.aborted) setSaving(false); }
  };

  const reloadConfig = async () => {
    if (busy || !confirmDiscard()) return;
    const controller = new AbortController(); readController.current?.abort(); readController.current = controller;
    setConfigError(null); setLoading(true);
    try {
      const response = await api.langflowConfig(controller.signal);
      if (controller.signal.aborted) return;
      installConfig(response); await refreshConnection(controller.signal);
    } catch (failure) { if (!controller.signal.aborted) setConfigError(errorText(failure, '重新加载连接配置失败。')); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };

  const submitRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const issue = validateLangflowInput(input);
    setInputError(issue);
    if (issue) return;
    if (!selectedFlow || !status?.connected || busy || repeatedUnknown) return;
    const controller = new AbortController(); writeController.current = controller;
    setSubmitting(true); setHistoryError(null);
    try {
      const response = await api.createLangflowRun(selectedFlow.id, input.trim(), crypto.randomUUID(), controller.signal);
      if (controller.signal.aborted) return;
      setRuns(current => [response.run, ...current.filter(run => run.id !== response.run.id)]);
      setSelectedRunId(response.run.id);
      if (response.run.status === 'outcome_unknown') setUnknownSignatures(current => current.includes(`${response.run.flowId}\u0000${response.run.input.trim()}`) ? current : [...current, `${response.run.flowId}\u0000${response.run.input.trim()}`]);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (isOutcomeUncertain(failure)) {
        setUnknownSignatures(current => current.includes(`${selectedFlow.id}\u0000${input.trim()}`) ? current : [...current, `${selectedFlow.id}\u0000${input.trim()}`]);
        setHistoryError('提交结果暂时无法确认。请刷新运行历史；为避免重复执行，本次相同流程和输入已暂时锁定。');
      } else setHistoryError(errorText(failure, '提交 Langflow 运行失败。'));
    } finally { if (!controller.signal.aborted) setSubmitting(false); }
  };

  const cancelRun = async (id: string) => {
    if (!status?.connected || busy) return;
    const controller = new AbortController(); writeController.current = controller;
    setSubmitting(true); setHistoryError(null);
    try {
      const response = await api.cancelLangflowRun(id, controller.signal);
      if (controller.signal.aborted) return;
      setRuns(current => [response.run, ...current.filter(run => run.id !== response.run.id)]);
      setSelectedRunId(response.run.id);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setHistoryError(errorText(failure, '取消 Langflow 运行失败。'));
    } finally { if (!controller.signal.aborted) setSubmitting(false); }
  };

  const statusClass = (run: LangflowRun) => `langflow-run-status status-${run.status.replace('_', '-')}`;

  return <section className="langflow-workspace" aria-labelledby="langflow-title">
    <div className="page-heading langflow-heading"><div><div className="eyebrow">Langflow 原生流程 · 独立运行记录</div><h1 id="langflow-title">Langflow 工作区</h1><p>流程图由本机 Langflow 编辑器管理；本页连接服务、选择原生流程、提交明确输入并查看结果。</p></div><span className="mock-badge"><WorkflowIcon size={13} />不混用本地素材模拟</span></div>

    <section className="panel langflow-connection" aria-labelledby="langflow-connection-title">
      <div className="langflow-section-heading"><div><h2 id="langflow-connection-title"><PlugZap size={16} />连接与访问</h2><p>仅保存本机地址和认证方式；密钥只通过 API 进程环境变量引用。</p></div><button className="secondary-button" type="button" onClick={() => void refreshWorkspace()} disabled={busy}><RefreshCw size={14} />刷新连接与流程</button></div>
      {statusError && <p className="inline-error" role="alert">{statusError}</p>}
      <div className={`langflow-status-card ${status?.connected ? 'connected' : 'disconnected'}`} role="status" aria-label="Langflow 连接状态">
        {status?.connected ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
        <div><strong>{status?.connected ? 'Langflow 已连接' : 'Langflow 连接未就绪'}</strong><p>{status?.message || (loading ? '正在读取连接状态…' : '尚未读取 Langflow 连接状态。服务未就绪时不会显示虚构流程。')}</p></div>
        {status?.version && <span className="langflow-version">版本 {status.version}</span>}
      </div>
      {configError && <div className="inline-error langflow-error" role="alert">{configError}{conflict && <button className="secondary-button" type="button" onClick={() => void reloadConfig()} disabled={busy}><RefreshCw size={13} />重新加载配置</button>}</div>}
      {loading && !configResponse ? <p className="workflow-loading" role="status"><LoaderCircle size={15} className="spin" />正在读取 Langflow 配置…</p> : configResponse && <form className="langflow-config-form" onSubmit={event => void saveConfig(event)}>
        <div className="langflow-config-grid">
          <label className="langflow-field langflow-field-wide">Langflow 服务地址<input aria-label="Langflow 服务地址" type="url" value={config.baseUrl} onChange={event => { setConfig(current => ({ ...current, baseUrl: event.target.value })); setConfigError(null); }} disabled={busy} /><small>仅允许本机回环 HTTP(S)，默认 http://127.0.0.1:7860。</small></label>
          <label className="langflow-field">认证方式<select aria-label="Langflow 认证方式" value={config.authMode} onChange={event => { setConfig(current => ({ ...current, authMode: event.target.value as LangflowConfig['authMode'] })); setConfigError(null); }} disabled={busy}><option value="local-development">本地开发免密</option><option value="api-key-env">API 密钥环境变量</option></select></label>
          <label className="langflow-field">API 密钥环境变量名<input aria-label="API 密钥环境变量名" value={config.secretEnv} onChange={event => { setConfig(current => ({ ...current, secretEnv: event.target.value.toUpperCase() })); setConfigError(null); }} autoComplete="off" spellCheck={false} placeholder="例如 LANGFLOW_API_KEY" disabled={busy || config.authMode !== 'api-key-env'} /><small>{configResponse.credentialConfigured ? 'API 进程环境变量已配置；密钥值不会返回到浏览器。' : '填写变量名，不要填写密钥值。'}</small></label>
          <label className="langflow-field">请求超时<input aria-label="Langflow 请求超时" type="number" min={1000} max={120000} step={1000} value={config.timeoutMs} onChange={event => { setConfig(current => ({ ...current, timeoutMs: event.target.valueAsNumber })); setConfigError(null); }} disabled={busy} /><small>1000–120000 毫秒。</small></label>
        </div>
        <div className="langflow-savebar"><p role="status">{dirty ? '连接配置尚未保存' : `配置修订 ${configResponse.revision} · ${config.authMode === 'api-key-env' ? 'API 密钥由服务端环境变量读取' : '本地开发认证'}`}</p><button className="primary-button" type="submit" disabled={busy || !dirty || !!configIssue}><Save size={14} />{saving ? '正在保存…' : '保存连接配置'}</button></div>
        {configIssue && <p className="inline-error" role="alert">{configIssue}</p>}
      </form>}
    </section>

    <div className="langflow-main-grid">
      <section className="panel langflow-flows" aria-label="Langflow 原生流程列表">
        <div className="langflow-section-heading"><div><h2><WorkflowIcon size={16} />原生流程</h2><p>{status?.connected ? `${flows.length} 个流程 · 仅显示名称与说明` : '连接就绪后读取 Langflow 流程'}</p></div><button className="icon-button" type="button" aria-label="刷新 Langflow 流程" onClick={() => void refreshFlows()} disabled={!status?.connected || busy || flowBusy}>{flowBusy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}</button></div>
        {flowError && <p className="inline-error" role="alert">{flowError}</p>}
        {!status?.connected ? <div className="langflow-empty"><AlertCircle size={20} /><strong>连接未就绪</strong><span>{status?.message || '先检查服务状态和连接配置，再读取原生流程。'}</span></div>
          : flows.length === 0 ? <div className="langflow-empty"><WorkflowIcon size={20} /><strong>没有可用流程</strong><span>请在 Langflow 原生编辑器中创建流程，再刷新列表。</span></div>
            : <ul className="langflow-flow-list">{flows.map(flow => <li key={flow.id}><button type="button" className={`langflow-flow-item ${flow.id === selectedFlowId ? 'selected' : ''}`} aria-pressed={flow.id === selectedFlowId} onClick={() => setSelectedFlowId(flow.id)} disabled={busy}><strong>{flow.name}</strong><span>{flow.description || '暂无说明'}</span><small>更新于 {dateLabel(flow.updatedAt)}</small></button></li>)}</ul>}
      </section>

      <div className="langflow-run-column">
        <section className="panel langflow-selected-flow" aria-labelledby="selected-flow-title">
          <div className="langflow-section-heading"><div><h2 id="selected-flow-title">选中流程</h2><p>流程内容和组件仅由 Langflow 原生编辑器读取与保存。</p></div></div>
          {selectedFlow ? <div className="langflow-flow-summary"><strong>{selectedFlow.name}</strong><p>{selectedFlow.description || '暂无流程说明。'}</p><code>{selectedFlow.id}</code></div> : <p className="muted small">连接并选择一个原生流程后，可在此查看摘要并打开编辑器。</p>}
          {status?.connected && editorHref ? <a className="secondary-button langflow-editor-link" href={editorHref} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />打开 Langflow 原生编辑器<span className="sr-only">（在新标签页打开）</span></a> : <p className="langflow-editor-unavailable">编辑器入口在 Langflow 连接就绪且地址安全时开放。</p>}
        </section>

        <section className="panel langflow-run-form-panel" aria-labelledby="langflow-run-title">
          <div className="langflow-section-heading"><div><h2 id="langflow-run-title"><Send size={15} />明确输入并运行</h2><p>只有点击运行才会向 Langflow 提交；连接、保存配置和读取列表不会执行流程。</p></div></div>
          <form className="langflow-run-form" onSubmit={event => void submitRun(event)} noValidate>
            <label className="langflow-field">本次运行输入<textarea aria-label="本次运行输入" rows={4} maxLength={2000} value={input} onChange={event => { setInput(event.target.value); setInputError(null); }} placeholder="填写要发送给所选 Langflow 流程的文本输入…" disabled={!status?.connected || !selectedFlow || busy} /><small>{input.trim().length}/2000 字符 · 将作为 Langflow 的 chat 输入提交。</small></label>
            {inputError && <p className="inline-error" role="alert">{inputError}</p>}
            {repeatedUnknown && <p className="langflow-unknown-note" role="alert"><CircleHelp size={15} />相同流程和输入已有结果待确认记录；请先刷新运行历史，避免重复执行。</p>}
            <div className="langflow-submit-row"><span>{selectedFlow ? `目标流程：${selectedFlow.name}` : '请先选择已连接的原生流程。'}</span><button type="submit" className="primary-button" disabled={!status?.connected || !selectedFlow || busy || repeatedUnknown}>{submitting ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}{submitting ? '正在提交…' : '运行 Langflow 流程'}</button></div>
          </form>
        </section>
      </div>
    </div>

    <section className="panel langflow-history" aria-label="Langflow 运行历史与结果">
      <div className="langflow-section-heading"><div><h2><Clock3 size={16} />运行历史与结果</h2><p>独立于本地 SVG 创作记录；结果仅来自 Langflow API。</p></div><button className="secondary-button" type="button" onClick={() => void refreshHistory(true)} disabled={historyBusy}><RefreshCw size={14} />刷新运行历史</button></div>
      {historyError && <p className="inline-error" role="alert">{historyError}</p>}
      {runs.length === 0 ? <div className="langflow-empty langflow-history-empty"><Clock3 size={19} /><strong>还没有 Langflow 运行记录</strong><span>明确提交一个流程输入后，运行状态和结果会显示在这里。</span></div> : <div className="langflow-history-layout">
        <ol className="langflow-run-list">{runs.map(run => <li key={run.id}><button type="button" className={`langflow-run-item ${run.id === selectedRunId ? 'selected' : ''}`} aria-pressed={run.id === selectedRunId} aria-label={`查看运行：${run.flowName}，${langflowRunStatusLabel[run.status]}`} onClick={() => setSelectedRunId(run.id)}><span><strong>{run.flowName}</strong><em className={statusClass(run)}>{langflowRunStatusLabel[run.status]}</em></span><small>{dateLabel(run.createdAt)}</small><code>{run.id}</code></button></li>)}</ol>
        {selectedRun && <article className="langflow-run-detail" aria-label="运行结果详情">
          <div className="langflow-run-detail-heading"><div><h3>{selectedRun.flowName}</h3><span className={statusClass(selectedRun)}>{langflowRunStatusLabel[selectedRun.status]}</span></div><small>{dateLabel(selectedRun.updatedAt)}</small></div>
          <p className="langflow-run-description">{langflowRunStatusDescription[selectedRun.status]}</p>
          {isLangflowRunActive(selectedRun.status) && <div className="langflow-run-actions"><button type="button" className="secondary-button" onClick={() => void cancelRun(selectedRun.id)} disabled={busy}>{submitting ? <LoaderCircle size={14} className="spin" /> : <XCircle size={14} />}取消运行</button></div>}
          <div className="langflow-run-input"><strong>提交输入</strong><p>{selectedRun.input}</p></div>
          {selectedRun.status === 'succeeded' ? <div className="langflow-run-output"><strong>Langflow 输出</strong><pre>{selectedRun.output ?? '流程已完成，但没有返回可显示的文本输出。'}</pre></div> : selectedRun.error && <div className="inline-error" role="alert">{selectedRun.error}</div>}
          {selectedRun.status === 'outcome_unknown' && <p className="langflow-unknown-note"><CircleHelp size={15} />执行结果未知，不提供重试或取消操作。</p>}
          <code className="langflow-run-id">运行 ID：{selectedRun.id}</code>
        </article>}
      </div>}
    </section>
  </section>;
}
