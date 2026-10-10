import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Bot, Box, Check, ChevronRight, Clock3, ExternalLink, FlaskConical, Image, Layers3, LoaderCircle, Plus, RotateCcw, Settings2, Sparkles, Square, WandSparkles, Wifi, WifiOff, Workflow as WorkflowIcon } from 'lucide-react';
import { api, validateInputs, getProjectId, setProjectId } from './api';
import { AssetGallery } from './components/AssetGallery';
import { StatusBadge } from './components/StatusBadge';
import { TemplatePicker } from './components/TemplatePicker';
import { Workflow } from './components/Workflow';
import { SettingsPage } from './components/SettingsPage';
import { RoleLibraryPage } from './components/RoleLibraryPage';
import { useStudio } from './hooks/useStudio';
import { useAppearanceTheme, type AppearanceTheme } from './hooks/useAppearanceTheme';
import { errorMessage, isActive, type Role, type Run } from './types';

const LangflowWorkspacePage = lazy(() => import('./components/LangflowWorkspacePage').then(module => ({ default: module.LangflowWorkspacePage })));
const WorkflowConfigPage = lazy(() => import('./components/WorkflowConfigPage').then(module => ({ default: module.WorkflowConfigPage })));

const suggestions = ['极简咖啡品牌，暖米色与森林绿，纸质包装质感', '户外生活方式品牌，自然光、山野与探索精神', '现代护肤品牌，柔和光影、纯净构图与淡紫色调'];
const formatDate = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const localRoleName = (role: Role) => ({ scriptwriter: '脚本编剧', 'storyboard-director': '分镜导演', 'continuity-reviewer': '连贯性审查员', editor: '剪辑审校', architect: '架构师', developer: '开发工程师', 'code-reviewer': '代码审查员' }[role.id] || role.name);
const roleModelSource = (role: Role) => {
  const selection = role.modelSelection.kind === 'inherit'
    ? '继承工作台默认路由'
    : `角色绑定 ${role.modelSelection.binding.providerId} / ${role.modelSelection.binding.accountId} / ${role.modelSelection.binding.modelId}`;
  return `${selection}${role.modelStatus === 'unavailable' ? ' · 当前配置不可用' : ''}`;
};

function RunProgress({ run }: { run: Run }) {
  const complete = run.nodes.filter(node => node.status === 'succeeded').length;
  const progress = run.nodes.length ? Math.round(complete / run.nodes.length * 100) : 0;
  return <div className="run-progress"><div><span>{run.status === 'succeeded' ? '创作已完成' : run.status === 'failed' ? '创作遇到问题' : run.status === 'cancelled' ? '创作已取消' : '正在将灵感变成素材'} · {complete}/{run.nodes.length} 个节点完成</span><strong>{progress}%</strong></div>
    <progress value={progress} max={100} aria-label="工作流完成进度" /><span className="muted small">{run.mode === 'mixed' ? '文本模型费用由供应商计费；AI Studio 未返回实际费用。' : '本地模拟费用：预计 ¥0 · 实际 ¥0'}</span>
  </div>;
}

export default function App() {
  const studio = useStudio();
  const appearance = useAppearanceTheme();
  const [settingsOpen, setSettingsOpen] = useState(() => window.location.hash === '#settings');
  const [rolesOpen, setRolesOpen] = useState(() => window.location.hash === '#roles');
  const [workflowsOpen, setWorkflowsOpen] = useState(() => window.location.hash === '#workflows');
  const [workflowCanvasOpen, setWorkflowCanvasOpen] = useState(() => window.location.hash === '#workflow-canvas');
  const [configurationMenuOpen, setConfigurationMenuOpen] = useState(() => ['#settings', '#roles', '#workflows', '#workflow-canvas'].includes(window.location.hash));
  const [activeNavigation, setActiveNavigation] = useState(() => window.location.hash || '#main');
  const navigationHash = useRef(window.location.hash || '#main');
  const [templateId, setTemplateId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(4);
  const [validation, setValidation] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const template = studio.templates.find(item => item.id === templateId);
  const selectedRun = studio.runs.find(run => run.id === studio.selectedId);
  const runTemplate = studio.templates.find(item => item.id === selectedRun?.templateId);
  const completed = studio.runs.filter(run => run.status === 'succeeded').length;
  const totalAssets = studio.runs.reduce((total, run) => total + run.assets.length, 0);

  useEffect(() => {
    const navigate = () => {
      const hash = window.location.hash || '#main';
      setSettingsOpen(hash === '#settings');
      setRolesOpen(hash === '#roles');
      setWorkflowsOpen(hash === '#workflows');
      setWorkflowCanvasOpen(hash === '#workflow-canvas');
      if (['#settings', '#roles', '#workflows', '#workflow-canvas'].includes(hash)) setConfigurationMenuOpen(true);
      setActiveNavigation(hash);
      if (navigationHash.current === '#workflows' && hash !== '#workflows') studio.refresh();
      navigationHash.current = hash;
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, [studio.refresh]);
  useEffect(() => {
    if (settingsOpen || rolesOpen || workflowsOpen || workflowCanvasOpen) return;
    const controller = new AbortController();
    api.settings(controller.signal).then(response => { if (!controller.signal.aborted) setCount(response.settings.defaultCount); }).catch(() => undefined);
    return () => controller.abort();
  }, [settingsOpen, rolesOpen, workflowsOpen, workflowCanvasOpen]);

  useEffect(() => {
    if (!studio.templates.some(item => item.id === templateId && item.enabled && item.category === 'image')) {
      setTemplateId(studio.templates.find(item => item.enabled && item.category === 'image')?.id || '');
    }
  }, [studio.templates, templateId]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const issue = validateInputs(prompt, count); setValidation(issue);
    if (issue) { promptRef.current?.focus(); return; }
    if (!template?.enabled) return;
    if (await studio.createRun(template.id, { prompt: prompt.trim(), count }, template.workflowRevision)) resultRef.current?.focus();
  };
  const newCreation = () => { studio.setSelectedId(null); setValidation(null); promptRef.current?.focus(); };

  return <div className="studio-shell">
    <a href="#main" className="skip-link">跳到工作台内容</a>
    <aside className="sidebar">
      <a className="brand" href="#main" aria-label="AI Studio 工作台"><span className="brand-symbol"><Layers3 size={24} /></span><span>AI Studio<small>把灵感，变成作品</small></span></a>
      <div className="workspace-label"><span className="workspace-avatar">S</span><div>我的创作空间<small>本地工作空间</small></div><ChevronRight size={14} /></div>
      <nav aria-label="工作台导航"><a className={`nav-item ${!settingsOpen && !rolesOpen && !workflowsOpen && !workflowCanvasOpen && !['#templates', '#history'].includes(activeNavigation) ? 'active' : ''}`} href="#main" aria-current={!settingsOpen && !rolesOpen && !workflowsOpen && !workflowCanvasOpen && !['#templates', '#history'].includes(activeNavigation) ? 'page' : undefined}><Box size={18} />创作工作台<span>01</span></a><a className={`nav-item ${activeNavigation === '#templates' ? 'active' : ''}`} href="#templates" aria-current={activeNavigation === '#templates' ? 'page' : undefined}><Layers3 size={18} />模板库</a><a className={`nav-item ${activeNavigation === '#history' ? 'active' : ''}`} href="#history" aria-current={activeNavigation === '#history' ? 'page' : undefined}><Clock3 size={18} />本地运行历史<span>{studio.runs.length}</span></a>
        <details className={`nav-group ${settingsOpen || rolesOpen || workflowsOpen || workflowCanvasOpen ? 'has-active-route' : ''}`} open={configurationMenuOpen} onToggle={event => setConfigurationMenuOpen(event.currentTarget.open)}>
          <summary className="nav-item nav-group-trigger"><Settings2 size={18} />配置与工作流<span className="nav-group-chevron"><ChevronRight size={14} /></span></summary>
          <div className="nav-submenu">
            <a className={`nav-item nav-subitem ${workflowCanvasOpen ? 'active' : ''}`} href="#workflow-canvas" aria-current={workflowCanvasOpen ? 'page' : undefined}><WorkflowIcon size={17} />工作流画布</a>
            <a className={`nav-item nav-subitem ${rolesOpen ? 'active' : ''}`} href="#roles" aria-current={rolesOpen ? 'page' : undefined}><Bot size={17} />代理角色</a>
            <a className={`nav-item nav-subitem ${workflowsOpen ? 'active' : ''}`} href="#workflows" aria-current={workflowsOpen ? 'page' : undefined}><WorkflowIcon size={17} />Langflow 工作区</a>
            <a className={`nav-item nav-subitem ${settingsOpen ? 'active' : ''}`} href="#settings" aria-current={settingsOpen ? 'page' : undefined}><Settings2 size={17} />配置中心</a>
          </div>
        </details>
      </nav>
      <section id="history" className="history-section" aria-labelledby="history-title"><div className="history-heading"><h2 id="history-title">最近的创作</h2><button className="sidebar-add" type="button" onClick={newCreation} aria-label="新建创作"><Plus size={17} /></button></div>
        {studio.loading && <p className="sidebar-empty">正在加载本地素材记录…</p>}
        {!studio.loading && studio.runs.length === 0 && <p className="sidebar-empty">还没有本地素材记录<br />从你的第一个灵感开始</p>}
        <ul className="run-list">{studio.runs.map(run => <li key={run.id}><button className={`history-item ${run.id === studio.selectedId ? 'selected' : ''}`} type="button" aria-pressed={run.id === studio.selectedId} onClick={() => studio.setSelectedId(run.id)}>
          <span className="history-icon"><Image size={16} /></span><span className="history-copy"><strong>{run.inputs.prompt}</strong><small>{formatDate(run.createdAt)} · {run.inputs.count} 张素材{run.workflowSnapshot ? ` · 工作流 v${run.workflowSnapshot.revision}` : ''}{run.expectedAssetCount ? ` · 预计 ${run.expectedAssetCount} 件` : ''}</small><StatusBadge status={run.status} /></span>
        </button></li>)}</ul>
      </section>
      <div className="sidebar-bottom"><div className="local-note"><FlaskConical size={19} /><strong>代理与本地 SVG</strong><p>画布代理节点可调用文本模型。<br />图像仍由本地 SVG 模拟。</p><span>代理调用需配置服务端密钥</span></div><span className="sidebar-footer">AI Studio <span>创作工作台</span></span></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">创作空间 <ChevronRight size={13} /><strong>{settingsOpen ? '配置中心' : rolesOpen ? '代理角色' : workflowCanvasOpen ? '工作流画布' : workflowsOpen ? 'Langflow 工作区' : '工作台'}</strong></div><div className="topbar-right"><span className="mock-badge">{workflowsOpen || workflowCanvasOpen ? <WorkflowIcon size={13} /> : <FlaskConical size={13} />}{workflowsOpen ? 'Langflow 原生运行' : workflowCanvasOpen ? '代理与 SVG 混合执行' : '工作流运行'}</span><label className="theme-control">项目 ID <input type="text" style={{width: '80px', padding: '2px 4px', fontSize: '12px'}} defaultValue={getProjectId()} onBlur={e => { if (e.target.value !== getProjectId()) { setProjectId(e.target.value); window.location.reload(); } }} /></label><label className="theme-control">界面主题<select aria-label="界面主题" value={appearance.theme} onChange={event => appearance.setTheme(event.target.value as AppearanceTheme)}><option value="dark">暗色</option><option value="light">浅色</option><option value="system">跟随系统</option></select></label><span role="status" aria-label={studio.connected && !studio.error ? 'Studio API 已连接' : '等待 Studio API'} className={`connection ${studio.connected && !studio.error ? 'online' : ''}`}>{studio.connected && !studio.error ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{studio.connected && !studio.error ? 'Studio API 已连接' : '等待 Studio API'}</span></span><span className="user-avatar" aria-label="本地用户">S</span></div></header>
      <main id="main" className="main-content">
        {settingsOpen ? <SettingsPage /> : rolesOpen ? <RoleLibraryPage /> : workflowCanvasOpen ? <Suspense fallback={<p className="workflow-loading" role="status">正在加载工作流画布…</p>}><WorkflowConfigPage /></Suspense> : workflowsOpen ? <Suspense fallback={<p className="workflow-loading" role="status">正在连接 Langflow 工作区…</p>}><LangflowWorkspacePage /></Suspense> : <>
        <div className="page-heading"><div><div className="eyebrow">品牌素材 · 代理文本与本地 SVG</div><h1>创作工作台</h1><p>选择已发布工作流、描述灵感，并查看实际代理输出与生成素材。</p></div><button className="secondary-button new-button" type="button" onClick={newCreation}><Plus size={16} /> 新建创作</button></div>
        <div className="stats-row"><div><span className="stat-icon"><Layers3 size={17} /></span><span>可用图像模板<strong>{studio.templates.filter(item => item.enabled && item.category === 'image').length}</strong></span></div><div><span className="stat-icon green"><Check size={17} /></span><span>已完成创作<strong>{completed}</strong></span></div><div><span className="stat-icon orange"><Image size={17} /></span><span>已产出模拟素材<strong>{totalAssets}</strong></span></div><p><FlaskConical size={15} />模拟费用 <strong>¥0</strong></p></div>
        {studio.error && <div className="service-error" role="alert"><WifiOff size={19} /><div><strong>服务连接需要检查</strong><p>{studio.error} 已加载的结果仍可查看。</p></div><button type="button" className="secondary-button" onClick={studio.refresh}><RotateCcw size={14} />重新连接</button></div>}
        <TemplatePicker templates={studio.templates} selectedId={templateId} loading={studio.loading} onSelect={setTemplateId} />
        <div className="creation-layout"><section id="create" className="panel creation-panel" aria-labelledby="create-title"><div className="section-heading"><h2 id="create-title"><WandSparkles size={18} /> 描述你的灵感</h2><span className="subtle-tag">品牌素材</span></div><p className="panel-description">写下品牌、风格和画面细节，开启一次视觉探索。</p>
          <form onSubmit={event => void submit(event)} noValidate><label className="field-label" htmlFor="prompt">素材描述 <span>必填</span></label><div className={`prompt-wrap ${validation ? 'invalid' : ''}`}><textarea ref={promptRef} id="prompt" value={prompt} maxLength={2000} onChange={event => { setPrompt(event.target.value); setValidation(null); }} placeholder="例如：为云南浅烘焙咖啡设计上市主视觉，花香与柑橘尾韵，温暖安静的手冲场景…" aria-invalid={!!validation} aria-describedby={`prompt-hint${validation ? ' form-error' : ''}`} /><div className="prompt-footer"><span id="prompt-hint">描述越具体，创作方向越清晰</span><span>{prompt.length}/2000</span></div></div>
            <div className="suggestions"><span>试试这些灵感</span>{suggestions.map((suggestion, index) => <button key={suggestion} type="button" onClick={() => { setPrompt(suggestion); setValidation(null); promptRef.current?.focus(); }}>{['☕ 极简咖啡', '↗ 户外生活', '✧ 现代护肤'][index]}</button>)}</div>
            <div className="count-field"><div><label className="field-label" htmlFor="count">生成数量</label><p>每次交付 1–8 件图像素材（当前图像节点输出本地 SVG）</p></div><div className="count-control"><input id="count" type="number" min={1} max={8} step={1} value={Number.isNaN(count) ? '' : count} onChange={event => { setCount(event.target.valueAsNumber); setValidation(null); }} aria-describedby="count-unit" /><span id="count-unit">张</span></div></div>
            {validation && <p id="form-error" className="inline-error" role="alert">{validation}</p>}
            {studio.actionError && <p className="inline-error" role="alert">{studio.actionError}</p>}
            <div className="submit-area"><div className="cost-note"><FlaskConical size={14} /><span>{template?.agentNodeCount ? `${template.agentNodeCount} 个代理节点 · 供应商费用另计` : '本地模拟 · 预计费用 '}<strong>{template?.agentNodeCount ? '' : '¥0'}</strong></span></div><button className="primary-button" type="submit" disabled={studio.busy || !template?.enabled || !studio.connected}>{studio.busy ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{studio.busy ? '正在提交…' : '开始创作'}<ArrowRight size={16} /></button></div>
          </form>
        </section><Workflow run={selectedRun} template={template} /></div>
        <section className="execution-section" aria-labelledby="result-title"><div className="section-heading result-heading"><div><h2 id="result-title" tabIndex={-1} ref={resultRef}>{selectedRun ? '本次创作' : '创作结果'}</h2>{selectedRun && <span className="run-meta">{runTemplate?.name || '品牌素材'} · {formatDate(selectedRun.createdAt)}{selectedRun.workflowSnapshot ? ` · 工作流修订 v${selectedRun.workflowSnapshot.revision}` : ''}{selectedRun.expectedAssetCount ? ` · 预计 ${selectedRun.expectedAssetCount} 件` : ''} · {selectedRun.id}</span>}</div><div className="run-actions">{selectedRun && <StatusBadge status={selectedRun.status} />}{selectedRun && isActive(selectedRun) && <button className="secondary-button" type="button" disabled={studio.busy} onClick={() => void studio.runAction(selectedRun.id, 'cancel')}><Square size={13} />取消运行</button>}{selectedRun?.status === 'failed' && <button className="secondary-button" type="button" disabled={studio.busy} onClick={() => void studio.runAction(selectedRun.id, 'retry')}><RotateCcw size={14} />重试失败节点</button>}{selectedRun && <button type="button" className="text-button" onClick={newCreation}><ArrowLeft size={14} />新的创作</button>}</div></div>
          {selectedRun && <><p className="run-prompt">{selectedRun.inputs.prompt}</p><RunProgress run={selectedRun} /><p className="run-announcement sr-only" role="status">当前运行状态：{selectedRun.status === 'running' ? '执行中' : selectedRun.status === 'succeeded' ? '已完成' : selectedRun.status === 'failed' ? '失败，可重试' : selectedRun.status === 'cancelled' ? '已取消' : '排队中'}，已生成 {selectedRun.assets.length} 个素材。</p>{selectedRun.error && <div className="inline-error" role="alert">{errorMessage(selectedRun.error)}</div>}{selectedRun.status === 'cancelled' && <p className="muted small">已停止安排后续节点，已产出的素材仍可下载。</p>}</>}
          <AssetGallery assets={selectedRun?.assets || EMPTY_ASSETS} />
        </section>
        </>}
      </main>
    </div>
    <aside className="inspector" aria-labelledby="inspector-title">
      {workflowsOpen || workflowCanvasOpen ? <><div className="inspector-heading"><span className="inspector-kicker">{workflowsOpen ? 'Langflow 原生运行' : 'React Flow 本地编辑'}</span><h2 id="inspector-title">{workflowsOpen ? '流程检查器' : '画布使用说明'}</h2></div><div className="inspector-empty"><div className="inspector-empty-icon"><WorkflowIcon size={20} /></div><strong>{workflowsOpen ? '运行记录位于工作区' : '在画布中编排节点'}</strong><p>{workflowsOpen ? 'Langflow 任务与本地 SVG 模拟相互独立。连接状态、流程输入和输出历史显示在中间工作区。' : '拖动节点调整步骤，连接节点两侧圆点定义交接。选中节点后，在画布下方查看角色职责、输入输出和配置。'}</p><span>{workflowsOpen ? '不会在此显示本地模拟素材作为 Langflow 结果' : '设为“调用代理”的提示词节点会执行单轮文本调用；角色工具声明不会执行。'}</span></div><div className="inspector-footer">{workflowsOpen ? <><ExternalLink size={15} /><span>流程图由 Langflow 原生编辑器管理</span></> : <><Bot size={15} /><span>代理节点使用角色提示词和配置模型执行</span></>}</div></> : <>
      <div className="inspector-heading"><span className="inspector-kicker">运行状态</span><h2 id="inspector-title">任务检查器</h2><span className={`inspector-connection ${studio.connected && !studio.error ? 'online' : ''}`}><span />{studio.connected && !studio.error ? '服务已连接' : '等待服务'}</span></div>
      {selectedRun ? <div className="inspector-run">
        <div className="inspector-section"><span className="inspector-label">当前任务</span><strong className="inspector-title">{runTemplate?.name || '品牌素材'}</strong><div className="inspector-status"><StatusBadge status={selectedRun.status} /><span>{formatDate(selectedRun.createdAt)}</span></div></div>
        <div className="inspector-section"><span className="inspector-label">工作流进度</span><RunProgress run={selectedRun} /><ol className="inspector-nodes">{selectedRun.nodes.map(node => <li key={node.id}><span className={`inspector-node-dot node-dot-${node.status}`} /><span>{node.name}</span><strong>{node.status === 'succeeded' ? '完成' : node.status === 'running' ? '执行中' : node.status === 'failed' ? '失败' : node.status === 'cancelled' ? '已取消' : '等待中'}</strong></li>)}</ol></div>
        <div className="inspector-section"><span className="inspector-label">本次输入</span><p className="inspector-prompt">{selectedRun.inputs.prompt}</p><span className="inspector-meta">{selectedRun.workflowSnapshot && `工作流 v${selectedRun.workflowSnapshot.revision} · `}{selectedRun.assets.length}{selectedRun.expectedAssetCount ? ` / ${selectedRun.expectedAssetCount}` : ''} 个模拟素材</span></div>
        {selectedRun.workflowSnapshot?.roleSnapshots.length ? <div className="inspector-section"><span className="inspector-label">本次运行固定的角色快照</span><ol className="inspector-role-snapshots">{selectedRun.workflowSnapshot.roleSnapshots.map(snapshot => {
          const nodeName = selectedRun.workflowSnapshot?.nodes.find(node => node.id === snapshot.nodeId)?.name || snapshot.nodeId;
          return <li key={`${snapshot.nodeId}-${snapshot.role.id}-${snapshot.role.revision}`}><strong>{localRoleName(snapshot.role)} · v{snapshot.role.revision}</strong><span>{snapshot.role.description}</span><small>{nodeName} · {roleModelSource(snapshot.role)}</small></li>;
        })}</ol><span className="inspector-meta">显示提交运行时的版本，不随角色库更新而变化。</span></div> : selectedRun.workflowSnapshot && <div className="inspector-section"><span className="inspector-label">角色快照</span><span className="inspector-meta">此工作流修订未引用代理角色。</span></div>}
        <div className="inspector-section"><span className="inspector-label">任务标识</span><code className="inspector-id">{selectedRun.id}</code></div>
      </div> : <div className="inspector-empty"><div className="inspector-empty-icon"><Layers3 size={20} /></div><strong>尚无选中的任务</strong><p>创建一次素材任务，或从左侧历史记录选择任务。检查器将显示真实的节点状态与运行结果。</p><span>{studio.runs.length} 条历史任务 · {studio.templates.length} 个模板</span></div>}
        <div className="inspector-footer"><FlaskConical size={15} /><span>{selectedRun?.mode === 'mixed' ? '文本代理调用 · 供应商账单另计 · SVG 本地生成' : '本地模拟 · 费用 ¥0'}</span></div>
      </>}
    </aside>
    <footer className="status-strip"><span className={`status-dot ${studio.connected && !studio.error ? 'online' : ''}`} /><span>{workflowsOpen ? 'Langflow 状态见工作区' : studio.connected && !studio.error ? 'API 已连接' : '等待 API 服务'}</span><span className="status-separator" /><span>{workflowsOpen ? <><WorkflowIcon size={13} /> Langflow 运行与本地素材模拟分开</> : workflowCanvasOpen ? <><WorkflowIcon size={13} /> React Flow 画布 · 当前节点执行仍为本地模拟</> : <><FlaskConical size={13} /> 模拟演示 · 生成仅输出 1024 × 1024 SVG</>}</span><span className="status-spacer" /><a href="#settings"><Settings2 size={14} />工作台配置</a></footer>
  </div>;
}
const EMPTY_ASSETS: Run['assets'] = [];
