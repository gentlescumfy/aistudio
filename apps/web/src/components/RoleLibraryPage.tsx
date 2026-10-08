import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Archive, BookOpen, Bot, Clock3, Copy, History, LoaderCircle, Plus, RotateCcw, Save, ShieldAlert, Wrench } from 'lucide-react';
import { ApiError, api } from '../api';
import { bindingValue, emptyRoleDefinition, lifecycleLabels, modelBindingOptions, modelStatusLabel, resolveBinding, roleCategoryLabels, roleCategoryOptions, roleDefinition, toolRiskLabels, validateRoleDefinition } from '../roleUtils';
import type { Role, RoleCategory, RoleDefinition, RoleLibrary, RoleLifecycle, RoleLimits, SettingsResponse } from '../types';

const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const clone = <T,>(value: T): T => structuredClone(value);
const categoryFilterLabels: Record<RoleCategory | 'all', string> = { all: '全部分类', ...roleCategoryLabels };
const builtInNames: Record<string, string> = {
  scriptwriter: '脚本编剧', 'storyboard-director': '分镜导演', 'continuity-reviewer': '连贯性审查员',
  editor: '剪辑审校', architect: '架构师', developer: '开发工程师', 'code-reviewer': '代码审查员',
};
const toolNames: Record<string, string> = {
  'assets.read': '读取素材', 'context.search': '搜索上下文', 'images.generate': '生成图像',
  'media.render': '媒体渲染', 'code.read': '读取代码', 'code.edit': '编辑代码', 'code.test': '运行测试',
};
const roleName = (role: Role) => role.builtIn ? builtInNames[role.id] || role.name : role.name;
const toolName = (id: string, fallback: string) => toolNames[id] || fallback;
type SourceFilter = 'all' | 'builtin' | 'custom';
type LifecycleFilter = 'unarchived' | 'all' | RoleLifecycle;

export function RoleLibraryPage() {
  const [library, setLibrary] = useState<RoleLibrary | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<RoleCategory | 'all'>('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>('unarchived');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RoleDefinition | null>(null);
  const [editBase, setEditBase] = useState<RoleDefinition | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [historyRoleId, setHistoryRoleId] = useState<string | null>(null);
  const [history, setHistory] = useState<Role[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const dirty = !!editing && !!draft && JSON.stringify(draft) !== JSON.stringify(editBase);
  const selected = library?.roles.find(role => role.id === selectedId) || null;
  const bindingOptions = useMemo(() => settings ? modelBindingOptions(settings.settings) : [], [settings]);
  const draftBinding = draft?.modelSelection.kind === 'binding' ? draft.modelSelection.binding : null;
  const draftBindingValue = draftBinding ? bindingValue(draftBinding) : null;
  const draftBindingOption = draftBindingValue ? bindingOptions.find(item => item.value === draftBindingValue) : undefined;
  const archivedCount = library?.roles.filter(role => role.lifecycle === 'archived' && !role.builtIn).length || 0;
  const customCount = library?.roles.filter(role => !role.builtIn).length || 0;

  const newReadController = () => {
    readController.current?.abort();
    const next = new AbortController(); readController.current = next;
    return next;
  };
  const newWriteController = () => {
    writeController.current?.abort();
    const next = new AbortController(); writeController.current = next;
    return next;
  };
  const load = async () => {
    if (busy) return;
    const current = newReadController();
    setLoading(true); setHistoryLoading(false); setError(null); setConflict(false);
    try {
      const [roles, currentSettings] = await Promise.all([api.roles(current.signal), api.settings(current.signal)]);
      if (current.signal.aborted) return;
      setLibrary(roles); setSettings(currentSettings);
      setSelectedId(previous => roles.roles.some(role => role.id === previous) ? previous : roles.roles.find(role => role.lifecycle !== 'archived')?.id || null);
      setHistory(null); setHistoryRoleId(null);
    } catch (failure) {
      if (!current.signal.aborted) setError((failure as Error).message || '角色库暂不可用。');
    } finally { if (!current.signal.aborted) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { readController.current?.abort(); writeController.current?.abort(); }; }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } };
    const navigate = (event: MouseEvent) => {
      if ((!dirty && !busy) || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href^="#"]');
      if (!link || link.hash === '#roles') return;
      event.preventDefault();
      if (busy) return;
      if (window.confirm('角色草稿有未保存的修改。离开此页会丢弃修改，确定离开吗？')) window.location.hash = link.hash;
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', navigate, true); };
  }, [dirty, busy]);

  const resetEditor = () => { setEditing(false); setCreating(false); setDraft(null); setEditBase(null); setFormError(null); };
  const selectRole = (id: string) => {
    if (busy) return;
    if (dirty && !window.confirm('角色草稿有未保存的修改，切换角色会丢弃修改。确定继续吗？')) return;
    readController.current?.abort();
    resetEditor(); setSelectedId(id); setHistoryRoleId(null); setHistory(null); setHistoryLoading(false); setError(null);
  };
  const startCreate = () => {
    const initial = emptyRoleDefinition(); setSelectedId(null); setHistory(null); setHistoryRoleId(null);
    setDraft(clone(initial)); setEditBase(clone(initial)); setCreating(true); setEditing(true); setFormError(null); setError(null);
  };
  const startEdit = (role: Role) => {
    const initial = roleDefinition(role); setDraft(clone(initial)); setEditBase(clone(initial));
    setCreating(false); setEditing(true); setFormError(null); setError(null);
  };
  const cancelEdit = () => {
    if (dirty && !window.confirm('放弃当前未保存的角色草稿修改？')) return;
    resetEditor();
  };
  const updateDraft = (update: (current: RoleDefinition) => RoleDefinition) => {
    setDraft(current => current ? update(current) : current); setFormError(null); setError(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!library || !settings || !draft || busy) return;
    const validation = validateRoleDefinition(draft, library.tools, settings.settings);
    setFormError(validation);
    if (validation) return;
    const current = newWriteController(); setBusy(true); setError(null); setConflict(false);
    try {
      const response = creating
        ? await api.createRole(library.revision, draft, current.signal)
        : selectedId ? await api.updateRole(selectedId, library.revision, draft, current.signal) : null;
      if (!response || current.signal.aborted) return;
      setLibrary(previous => previous && ({ ...previous, revision: response.revision, roles: previous.roles.some(role => role.id === response.role.id)
        ? previous.roles.map(role => role.id === response.role.id ? response.role : role)
        : [...previous.roles, response.role] }));
      setSelectedId(response.role.id); resetEditor(); setHistory(null); setHistoryRoleId(null);
    } catch (failure) {
      if (!current.signal.aborted) {
        const apiFailure = failure as ApiError;
        if (apiFailure.status === 409) { setConflict(true); setError('角色库版本已变化。当前草稿仍保留；可复制草稿内容后重新加载最新版本。'); }
        else setError(apiFailure.message || '保存角色失败，请稍后重试。');
      }
    } finally { if (!current.signal.aborted) setBusy(false); }
  };

  const copyBuiltIn = async (role: Role) => {
    if (!library || busy || customCount >= 64) return;
    const copied = roleDefinition(role);
    copied.name = `${roleName(role)} 副本`.slice(0, 80);
    const current = newWriteController(); setBusy(true); setError(null); setConflict(false);
    try {
      const response = await api.createRole(library.revision, copied, current.signal);
      if (current.signal.aborted) return;
      setLibrary(previous => previous && ({ ...previous, revision: response.revision, roles: [...previous.roles, response.role] }));
      setSelectedId(response.role.id); resetEditor(); setHistory(null); setHistoryRoleId(null);
    } catch (failure) {
      if (!current.signal.aborted) {
        const apiFailure = failure as ApiError;
        if (apiFailure.status === 409) { setConflict(true); setError('角色库版本已变化。请重新加载后再复制此角色。'); }
        else setError(apiFailure.message || '复制角色失败，请稍后重试。');
      }
    } finally { if (!current.signal.aborted) setBusy(false); }
  };

  const archiveRole = async (role: Role) => {
    if (!library || busy || role.builtIn || role.lifecycle === 'archived') return;
    if (!window.confirm(`归档“${role.name}”将保留其修订历史，但默认从角色列表隐藏。确定归档吗？`)) return;
    const current = newWriteController(); setBusy(true); setError(null); setConflict(false);
    try {
      const response = await api.archiveRole(role.id, library.revision, current.signal);
      if (current.signal.aborted) return;
      setLibrary(previous => previous && ({ ...previous, revision: response.revision, roles: previous.roles.map(item => item.id === role.id ? response.role : item) }));
      resetEditor();
    } catch (failure) {
      if (!current.signal.aborted) {
        const apiFailure = failure as ApiError;
        if (apiFailure.status === 409) { setConflict(true); setError('角色库版本已变化。请重新加载最新版本后再归档。'); }
        else setError(apiFailure.message || '归档角色失败，请稍后重试。');
      }
    } finally { if (!current.signal.aborted) setBusy(false); }
  };

  const toggleHistory = async (role: Role) => {
    if (busy || historyLoading) return;
    if (historyRoleId === role.id) { setHistoryRoleId(null); return; }
    setHistoryRoleId(role.id); setHistory(null); setHistoryLoading(true); setError(null);
    const current = newReadController();
    try {
      const response = await api.roleRevisions(role.id, current.signal);
      if (!current.signal.aborted) setHistory(response.revisions);
    } catch (failure) { if (!current.signal.aborted) setError((failure as Error).message || '读取修订历史失败。'); }
    finally { if (!current.signal.aborted) setHistoryLoading(false); }
  };

  const reloadLatest = () => {
    if (busy) return;
    if (dirty && !window.confirm('重新加载会丢弃当前未保存的角色草稿，建议先复制需要保留的内容。确定重新加载吗？')) return;
    resetEditor(); void load();
  };

  const filteredRoles = useMemo(() => (library?.roles || []).filter(role => {
    if (lifecycle === 'unarchived' && role.lifecycle === 'archived') return false;
    if (lifecycle !== 'unarchived' && lifecycle !== 'all' && role.lifecycle !== lifecycle) return false;
    if (category !== 'all' && role.category !== category) return false;
    if (source === 'builtin' && !role.builtIn || source === 'custom' && role.builtIn) return false;
    const normalized = search.trim().toLocaleLowerCase();
    if (normalized && !`${roleName(role)} ${role.name} ${role.description} ${role.systemPrompt} ${role.inputContract} ${role.outputContract}`.toLocaleLowerCase().includes(normalized)) return false;
    return true;
  }), [library, lifecycle, category, source, search]);

  const bindingLabel = (role: Role) => settings ? modelStatusLabel(role, settings.settings) : role.modelSelection.kind === 'inherit' ? '继承工作区默认' : `绑定：${bindingValue(role.modelSelection.binding)}`;
  const updateLimit = (key: keyof RoleLimits, value: number) => updateDraft(current => ({ ...current, limits: { ...current.limits, [key]: value } }));

  return <section className="role-library-page" aria-labelledby="roles-title">
    <div className="page-heading role-page-heading"><div><div className="eyebrow">可复用代理角色 · 单轮文本调用</div><h1 id="roles-title">代理角色</h1><p>维护角色系统提示词、输入输出契约和模型绑定，再在工作流提示词节点中选择“调用代理”。</p></div><span className="mock-badge"><Bot size={13} />支持文本调用</span></div>
    <div className="role-runtime-note" role="note"><ShieldAlert size={17} /><p><strong>代理运行需在工作流节点中显式开启。</strong>系统提示词与契约会发送到绑定的文本模型；工具声明、编码沙箱和自动预算控制仍未启用。模型费用由供应商计算。</p></div>
    {error && <div className="inline-error role-error" role="alert">{error}{conflict && <button type="button" className="secondary-button" onClick={reloadLatest} disabled={busy}><RotateCcw size={14} />重新加载最新版本</button>}</div>}
    {!library || !settings ? loading ? <p className="role-loading" role="status"><LoaderCircle size={16} className="spin" />正在加载角色库与模型配置…</p> : <div className="role-load-error"><p>角色库或模型配置暂不可用。</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw size={14} />重新连接</button></div> : <>
      <div className="role-toolbar">
        <label className="catalog-search role-search"><span className="sr-only">搜索角色</span><input type="search" aria-label="搜索角色" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称、描述、系统提示词…" /></label>
        <label><span className="sr-only">角色分类筛选</span><select aria-label="角色分类筛选" value={category} onChange={event => setCategory(event.target.value as RoleCategory | 'all')}><option value="all">全部分类</option>{roleCategoryOptions.map(item => <option key={item} value={item}>{categoryFilterLabels[item]}</option>)}</select></label>
        <label><span className="sr-only">角色来源筛选</span><select aria-label="角色来源筛选" value={source} onChange={event => setSource(event.target.value as SourceFilter)}><option value="all">全部来源</option><option value="builtin">内置角色</option><option value="custom">自定义角色</option></select></label>
        <label><span className="sr-only">角色状态筛选</span><select aria-label="角色状态筛选" value={lifecycle} onChange={event => setLifecycle(event.target.value as LifecycleFilter)}><option value="unarchived">未归档</option><option value="all">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="archived">已归档</option></select></label>
        <button type="button" className="primary-button role-create-button" onClick={startCreate} disabled={busy || editing || customCount >= 64}><Plus size={15} />新建自定义角色</button>
      </div>
      <div className="role-library-layout">
        <section className="panel role-list-panel" aria-label="角色列表">
          <div className="role-list-heading"><div><strong>角色目录</strong><span>{filteredRoles.length} 项 · 目录修订 {library.revision}</span></div><button className="icon-button role-refresh" type="button" aria-label="刷新角色库" onClick={reloadLatest} disabled={busy}><RotateCcw size={15} /></button></div>
          {loading ? <p className="role-list-empty" role="status">正在加载角色…</p> : filteredRoles.length === 0 ? <div className="role-list-empty"><BookOpen size={19} /><strong>{library.roles.length ? '没有匹配的角色' : '角色目录为空'}</strong><span>{library.roles.length ? '调整搜索词或筛选条件。' : '服务端还没有提供角色定义。'}</span></div> : <ul className="role-card-list">{filteredRoles.map(role => <li key={role.id}><button type="button" className={`role-card ${role.id === selectedId && !editing ? 'selected' : ''}`} aria-pressed={role.id === selectedId && !editing} onClick={() => selectRole(role.id)} disabled={busy}>
            <span className="role-card-top"><span className={`role-source-badge ${role.builtIn ? 'builtin' : 'custom'}`}>{role.builtIn ? '内置' : '自定义'}</span><span className={`role-life life-${role.lifecycle}`}>{lifecycleLabels[role.lifecycle]}</span></span>
            <strong>{roleName(role)}</strong><span className="role-card-description">{role.description}</span><span className="role-card-meta">{roleCategoryLabels[role.category]} · v{role.revision}</span>
            {role.modelStatus === 'unavailable' && <span className="role-unavailable">绑定不可用</span>}
          </button></li>)}</ul>}
          {library.roles.filter(role => role.builtIn).length > 0 && <p className="builtin-count">内置模板 {library.roles.filter(role => role.builtIn).length} 个 · 自定义 {customCount} 个{archivedCount ? ` · 已归档 ${archivedCount} 个` : ''}</p>}
        </section>
        <section className="role-detail-column" aria-label={editing ? '角色编辑器' : '角色详情'}>
          {editing && draft ? <form className="panel role-editor" noValidate onSubmit={event => void save(event)}>
            <div className="role-detail-heading"><div><span className="role-source-badge custom">{creating ? '新建草稿' : '自定义草稿'}</span><h2>{creating ? '新建自定义角色' : '编辑角色草稿'}</h2><p>保存后生成新的角色修订，不会启动角色运行。</p></div></div>
            {formError && <p className="inline-error" role="alert">{formError}</p>}
            <div className="role-form-grid">
              <label className="role-field">角色名称<input required maxLength={80} value={draft.name} onChange={event => updateDraft(current => ({ ...current, name: event.target.value }))} placeholder="例如：品牌文案策划" /><span>{draft.name.length}/80</span></label>
              <label className="role-field">角色分类<select value={draft.category} onChange={event => updateDraft(current => ({ ...current, category: event.target.value as RoleCategory }))}>{roleCategoryOptions.map(item => <option key={item} value={item}>{roleCategoryLabels[item]}</option>)}</select></label>
              <label className="role-field role-field-wide">角色描述<textarea required maxLength={1000} rows={2} value={draft.description} onChange={event => updateDraft(current => ({ ...current, description: event.target.value }))} placeholder="说明这个角色负责什么、适用于哪些任务。" /><span>{draft.description.length}/1000</span></label>
              <label className="role-field role-field-wide">系统提示词<textarea required maxLength={6000} rows={7} value={draft.systemPrompt} onChange={event => updateDraft(current => ({ ...current, systemPrompt: event.target.value }))} placeholder="描述角色职责、表达方式与工作原则。工作流调用此角色时会作为模型系统提示词。" /><span>{draft.systemPrompt.length}/6000</span></label>
              <label className="role-field">输入契约说明<textarea required maxLength={4000} rows={5} value={draft.inputContract} onChange={event => updateDraft(current => ({ ...current, inputContract: event.target.value }))} placeholder="描述期望输入，不是可执行 JSON Schema。" /><span>{draft.inputContract.length}/4000</span></label>
              <label className="role-field">输出契约说明<textarea required maxLength={4000} rows={5} value={draft.outputContract} onChange={event => updateDraft(current => ({ ...current, outputContract: event.target.value }))} placeholder="描述期望输出，不是可执行 JSON Schema。" /><span>{draft.outputContract.length}/4000</span></label>
            </div>
            <fieldset className="role-tool-fieldset"><legend>工具意图声明</legend><p id="role-tools-note">勾选仅记录未来意图，不会授予或执行任何工具权限。</p>
              {library.tools.length === 0 ? <p className="role-list-empty">服务端未提供工具声明目录。</p> : <div className="role-tool-grid">{library.tools.map(tool => <label className="role-tool-choice" key={tool.id}><input type="checkbox" checked={draft.tools.includes(tool.id)} onChange={event => updateDraft(current => ({ ...current, tools: event.target.checked ? [...current.tools, tool.id] : current.tools.filter(id => id !== tool.id) }))} /><span><strong>{toolName(tool.id, tool.name)}</strong><code>{tool.id}</code><small>{tool.description}</small><em className={`risk-${tool.risk}`}>{toolRiskLabels[tool.risk]} · 不可执行</em></span></label>)}</div>}
            </fieldset>
            <div className="role-model-section"><div><h3>默认模型选择</h3><p>仅允许继承工作区文本路由，或选择启用账号下的文本/代码模型。</p></div>
              <label className="role-field">模型选择<select aria-label="角色默认模型" value={draft.modelSelection.kind === 'inherit' ? 'inherit' : bindingValue(draft.modelSelection.binding)} onChange={event => updateDraft(current => {
                if (event.target.value === 'inherit') return { ...current, modelSelection: { kind: 'inherit' } };
                const option = bindingOptions.find(item => item.value === event.target.value);
                return option ? { ...current, modelSelection: { kind: 'binding', binding: option.binding } } : current;
              })}>
                <option value="inherit">继承工作区默认文本路由</option>
                {draftBinding && !draftBindingOption && <option value={draftBindingValue!} disabled>不可用绑定：{draftBinding.providerId} / {draftBinding.accountId} / {draftBinding.modelId}</option>}
                {bindingOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select></label>
              <p className={`role-model-status ${draftBinding && !draftBindingOption ? 'unavailable' : ''}`}>{draft.modelSelection.kind === 'inherit' ? settings.settings.routes.text ? `当前继承：${resolveBinding(settings.settings, settings.settings.routes.text).label}` : '当前工作区尚未配置默认文本路由。' : draftBindingOption ? `保存后角色将指定：${draftBindingOption.label}` : '当前完整绑定已失效。选择新的启用文本/代码模型，或改回工作区默认。'}</p>
            </div>
            <fieldset className="role-limits-fieldset"><legend>执行上限</legend><div className="role-limits-grid">
              <label className="role-field">最大步骤数<input aria-label="最大步骤数" type="number" min={1} max={100} step={1} value={Number.isNaN(draft.limits.maxSteps) ? '' : draft.limits.maxSteps} onChange={event => updateLimit('maxSteps', event.target.valueAsNumber)} /></label>
              <label className="role-field">最大工具调用数<input aria-label="最大工具调用数" type="number" min={0} max={1000} step={1} value={Number.isNaN(draft.limits.maxToolCalls) ? '' : draft.limits.maxToolCalls} onChange={event => updateLimit('maxToolCalls', event.target.valueAsNumber)} /></label>
              <label className="role-field">截止时间（毫秒）<input aria-label="截止时间（毫秒）" type="number" min={1000} max={3600000} step={1000} value={Number.isNaN(draft.limits.deadlineMs) ? '' : draft.limits.deadlineMs} onChange={event => updateLimit('deadlineMs', event.target.valueAsNumber)} /></label>
              <label className="role-field">预算上限（¥）<input aria-label="预算上限（¥）" type="number" min={0} max={1000} step={0.01} value={Number.isNaN(draft.limits.maxCost) ? '' : draft.limits.maxCost} onChange={event => updateLimit('maxCost', event.target.valueAsNumber)} /></label>
            </div><p>单轮调用会使用截止时间；步骤数、工具调用数和预算上限尚未实现强制控制。</p></fieldset>
            <div className="role-editor-actions"><p role="status">{dirty ? '有未保存的修改' : creating ? '填写草稿内容后保存' : '未修改'}</p><button type="button" className="secondary-button" onClick={cancelEdit} disabled={busy}>取消编辑</button><button type="submit" className="primary-button" disabled={busy || !dirty}>{busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{creating ? '创建角色草稿' : '保存角色草稿'}</button></div>
          </form> : selected ? <>
            <article className="panel role-detail">
              <div className="role-detail-heading"><div><div className="role-detail-tags"><span className={`role-source-badge ${selected.builtIn ? 'builtin' : 'custom'}`}>{selected.builtIn ? '内置角色' : '自定义角色'}</span><span className={`role-life life-${selected.lifecycle}`}>{lifecycleLabels[selected.lifecycle]}</span><span className="role-revision">修订 v{selected.revision}</span></div><h2>{roleName(selected)}</h2><p>{selected.description}</p></div>
                <div className="role-actions">{selected.builtIn && <button type="button" className="primary-button" onClick={() => void copyBuiltIn(selected)} disabled={busy || customCount >= 64}><Copy size={15} />复制为自定义角色</button>}{!selected.builtIn && selected.lifecycle === 'draft' && <button type="button" className="secondary-button" onClick={() => startEdit(selected)} disabled={busy}>编辑草稿</button>}{!selected.builtIn && selected.lifecycle !== 'archived' && <button type="button" className="secondary-button destructive-icon" onClick={() => void archiveRole(selected)} disabled={busy}><Archive size={14} />归档角色</button>}</div>
              </div>
              <div className="role-detail-meta"><span>{roleCategoryLabels[selected.category]}</span><span>创建于 {formatDate(selected.createdAt)}</span><span>更新于 {formatDate(selected.updatedAt)}</span><span>角色修订 v{selected.revision}</span></div>
              <div className="role-model-summary"><Bot size={16} /><span><strong>模型来源</strong>{bindingLabel(selected)}</span>{selected.modelStatus === 'unavailable' && <span className="role-unavailable">绑定不可用</span>}</div>
              <div className="role-contract-grid">
                <section><h3>系统提示词</h3><pre>{selected.systemPrompt}</pre></section>
                <section><h3>输入契约说明</h3><pre>{selected.inputContract}</pre></section>
                <section><h3>输出契约说明</h3><pre>{selected.outputContract}</pre></section>
              </div>
              <section className="role-tool-summary"><h3><Wrench size={15} />工具声明 <small>当前不授予权限</small></h3>{selected.tools.length === 0 ? <p>未声明工具。</p> : <ul>{selected.tools.map(id => { const tool = library.tools.find(item => item.id === id); return <li key={id}><span><strong>{toolName(id, tool?.name || id)}</strong><code>{id}</code></span><em className={tool ? `risk-${tool.risk}` : 'risk-unknown'}>{tool ? `${toolRiskLabels[tool.risk]} · 不可执行` : '目录中未找到'}</em>{tool && <small>{tool.description}</small>}</li>; })}</ul>}</section>
              <section className="role-limit-summary"><h3>执行上限声明</h3><dl><div><dt>最大步骤</dt><dd>{selected.limits.maxSteps}</dd></div><div><dt>最大工具调用</dt><dd>{selected.limits.maxToolCalls}</dd></div><div><dt>截止时间</dt><dd>{selected.limits.deadlineMs} 毫秒</dd></div><div><dt>预算上限</dt><dd>¥{selected.limits.maxCost}</dd></div></dl></section>
              <div className="role-detail-footer"><span>角色 ID <code>{selected.id}</code></span><button type="button" className="secondary-button" onClick={() => void toggleHistory(selected)} disabled={historyLoading || busy}><History size={14} />{historyRoleId === selected.id ? '隐藏修订历史' : '查看修订历史'}</button></div>
              {historyRoleId === selected.id && <section className="role-history" aria-label="角色修订历史"><h3><Clock3 size={15} />修订历史</h3>{historyLoading ? <p role="status">正在加载历史…</p> : !history?.length ? <p>没有可显示的修订记录。</p> : <ol>{history.map(revision => <li key={`${revision.id}-${revision.revision}`}><details><summary><span>v{revision.revision} · {roleName(revision)}</span><span>{formatDate(revision.updatedAt)}</span><span>{lifecycleLabels[revision.lifecycle]}</span></summary><div className="role-history-content"><p>{revision.description}</p><h4>系统提示词</h4><pre>{revision.systemPrompt}</pre><div className="role-contract-grid"><section><h4>输入</h4><pre>{revision.inputContract}</pre></section><section><h4>输出</h4><pre>{revision.outputContract}</pre></section></div><p>模型：{modelStatusLabel(revision, settings.settings)}</p><p>工具声明：{revision.tools.map(toolId => toolName(toolId, library.tools.find(tool => tool.id === toolId)?.name || toolId)).join('、') || '无'}</p><p>执行上限：{revision.limits.maxSteps} 步 · {revision.limits.maxToolCalls} 次工具调用 · {revision.limits.deadlineMs} 毫秒 · ¥{revision.limits.maxCost}</p></div></details></li>)}</ol>}</section>}
            </article>
          </> : <div className="panel role-detail-empty"><Bot size={25} /><h2>选择一个角色查看详情</h2><p>内置角色是只读模板；可以复制成自定义草稿，再维护系统提示词、契约、模型绑定和执行上限。</p><span>在工作流画布把提示词节点切换为“调用代理”后即可调用。</span></div>}
        </section>
      </div>
    </>}
  </section>;
}
