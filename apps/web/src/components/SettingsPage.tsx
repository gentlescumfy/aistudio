import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, FlaskConical, Pin, PinOff, Plus, RotateCcw, Save, Search, Settings2, Trash2 } from 'lucide-react';
import { api, validateSettingsDraft } from '../api';
import type { AccountConfig, Capability, ImageRoute, ModelBinding, ModelConfig, ProviderConfig, SettingsResponse, StudioSettings } from '../types';

const capabilityLabels: Record<Capability, string> = { text: '文本', code: '代码', image: '图像', video: '视频', audio: '音频' };
const allCapabilities = Object.keys(capabilityLabels) as Capability[];
const newId = (kind: string) => `${kind}-${crypto.randomUUID()}`;
const bindingKey = (binding: ModelBinding) => `${binding.providerId}/${binding.accountId}/${binding.modelId}`;
function clearImageBinding(route: ImageRoute, accountId: string, modelId?: string): ImageRoute {
  if (route === 'mock-svg' || route.accountId !== accountId || modelId && route.modelId !== modelId) return route;
  return 'mock-svg';
}
const routeFor = (settings: StudioSettings, value: string): ModelBinding | null => {
  const [providerId, accountId, modelId] = value.split('/');
  if (!providerId || !accountId || !modelId) return null;
  const provider = settings.providers.find(item => item.id === providerId);
  const account = settings.accounts.find(item => item.id === accountId && item.providerId === providerId && item.enabled);
  const model = settings.models.find(item => item.id === modelId && item.accountId === accountId);
  return provider && account && model ? { providerId, accountId, modelId } : null;
};

export function SettingsPage() {
  const [snapshot, setSnapshot] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<StudioSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const dirty = !!snapshot && !!draft && JSON.stringify(snapshot.settings) !== JSON.stringify(draft);
  const visibleModels = useMemo(() => new Set((draft?.models || []).filter(model => {
    const account = draft?.accounts.find(item => item.id === model.accountId);
    const provider = draft?.providers.find(item => item.id === account?.providerId);
    const haystack = `${provider?.name || ''} ${account?.label || ''} ${model.name} ${model.externalId}`.toLocaleLowerCase();
    return (!pinnedOnly || model.pinned) && haystack.includes(search.trim().toLocaleLowerCase());
  }).map(model => model.id)), [draft, pinnedOnly, search]);

  const load = async () => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(null); setSaved(false);
    try {
      const response = await api.settings(current.signal);
      if (!current.signal.aborted) { setSnapshot(response); setDraft(structuredClone(response.settings)); }
    } catch (failure) { if (!current.signal.aborted) setError((failure as Error).message); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  useEffect(() => { void load(); return () => { controller.current?.abort(); }; }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    const navigate = (event: MouseEvent) => {
      if (!dirty || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href^="#"]');
      if (!link || link.hash === '#settings') return;
      event.preventDefault();
      if (window.confirm('配置尚未保存。离开此页会丢弃修改，确定离开吗？')) window.location.hash = link.hash;
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', navigate, true); };
  }, [dirty]);

  const change = (update: (current: StudioSettings) => StudioSettings) => {
    setSaved(false); setDraft(current => current && update(current));
  };
  const addProvider = () => change(current => current.providers.length >= 8 ? current : ({ ...current, providers: [...current.providers, { id: newId('provider'), name: '', transport: 'api', protocol: 'openai-compatible', baseUrl: '' }] }));
  const addAccount = (providerId: string) => change(current => current.accounts.length >= 16 ? current : ({ ...current, accounts: [...current.accounts, { id: newId('account'), providerId, label: '', secretEnv: '', enabled: true }] }));
  const addModel = (accountId: string) => change(current => current.models.length >= 64 ? current : ({ ...current, models: [...current.models, { id: newId('model'), accountId, externalId: '', name: '', capabilities: ['text'], pinned: false }] }));
  const clearBinding = (route: ImageRoute | ModelBinding | null, accountId: string, modelId?: string): ImageRoute | ModelBinding | null => {
    if (!route || route === 'mock-svg') return route;
    if (route.accountId === accountId && (!modelId || route.modelId === modelId)) return null;
    return route;
  };
  const removeProvider = (providerId: string) => {
    if (!draft) return;
    const accountIds = draft.accounts.filter(item => item.providerId === providerId).map(item => item.id);
    const modelIds = draft.models.filter(item => accountIds.includes(item.accountId)).map(item => item.id);
    const references = ([draft.routes.text, draft.routes.video, draft.routes.image === 'mock-svg' ? null : draft.routes.image]).filter(route => route?.providerId === providerId).length;
    const details = `${accountIds.length} 个账号、${modelIds.length} 个模型${references ? `及 ${references} 条默认路由` : ''}`;
    if (!window.confirm(`删除供应商“${draft.providers.find(item => item.id === providerId)?.name || '未命名供应商'}”将同时移除${details}，确定继续吗？`)) return;
    change(current => ({ ...current, providers: current.providers.filter(item => item.id !== providerId), accounts: current.accounts.filter(item => item.providerId !== providerId), models: current.models.filter(item => !accountIds.includes(item.accountId)), routes: {
      text: current.routes.text?.providerId === providerId ? null : current.routes.text,
      video: current.routes.video?.providerId === providerId ? null : current.routes.video,
      image: current.routes.image !== 'mock-svg' && current.routes.image.providerId === providerId ? 'mock-svg' : current.routes.image,
    } }));
  };
  const removeAccount = (accountId: string) => {
    if (!draft) return;
    const dependentModels = draft.models.filter(item => item.accountId === accountId);
    const routes = [draft.routes.text, draft.routes.video, draft.routes.image === 'mock-svg' ? null : draft.routes.image];
    const references = routes.filter(route => route?.accountId === accountId).length;
    const label = draft.accounts.find(item => item.id === accountId)?.label || '未命名账号';
    if (!window.confirm(`删除账号“${label}”将同时移除 ${dependentModels.length} 个模型${references ? `及 ${references} 条默认路由` : ''}，确定继续吗？`)) return;
    change(current => ({ ...current, accounts: current.accounts.filter(item => item.id !== accountId), models: current.models.filter(item => item.accountId !== accountId), routes: {
      text: clearBinding(current.routes.text, accountId) as ModelBinding | null,
      video: clearBinding(current.routes.video, accountId) as ModelBinding | null,
      image: clearImageBinding(current.routes.image, accountId),
    } }));
  };
  const removeModel = (model: ModelConfig) => {
    if (!draft) return;
    const references = ([draft.routes.text, draft.routes.video, draft.routes.image === 'mock-svg' ? null : draft.routes.image]).filter(route => route?.modelId === model.id).length;
    if (!window.confirm(`删除模型“${model.name || model.externalId || '未命名模型'}”${references ? `将清除 ${references} 条默认路由` : ''}，确定继续吗？`)) return;
    change(current => ({ ...current, models: current.models.filter(item => item.id !== model.id), routes: {
      text: clearBinding(current.routes.text, model.accountId, model.id) as ModelBinding | null,
      video: clearBinding(current.routes.video, model.accountId, model.id) as ModelBinding | null,
      image: clearImageBinding(current.routes.image, model.accountId, model.id),
    } }));
  };
  const updateRoute = (name: 'text' | 'video', value: string) => change(current => ({ ...current, routes: { ...current.routes, [name]: value ? routeFor(current, value) : null } }));
  const updateImageRoute = (value: string) => change(current => ({ ...current, routes: { ...current.routes, image: value === 'mock-svg' ? 'mock-svg' : routeFor(current, value) || 'mock-svg' } }));
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || !snapshot || busy) return;
    const validation = validateSettingsDraft(draft);
    if (validation) { setError(validation); return; }
    setBusy(true); setError(null); setSaved(false);
    const current = new AbortController(); controller.current = current;
    try {
      const response = await api.saveSettings(snapshot.revision, draft, current.signal);
      if (!current.signal.aborted) { setSnapshot(response); setDraft(structuredClone(response.settings)); setSaved(true); }
    } catch (failure) { if (!current.signal.aborted) setError((failure as Error).message); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };

  const routeOptions = (capability: Capability) => draft ? draft.models.filter(model => {
    const account = draft.accounts.find(item => item.id === model.accountId);
    return account?.enabled && (model.capabilities.includes(capability) || capability === 'text' && model.capabilities.includes('code'));
  }).map(model => {
    const account = draft.accounts.find(item => item.id === model.accountId)!;
    const provider = draft.providers.find(item => item.id === account.providerId)!;
    return { value: bindingKey({ providerId: provider.id, accountId: account.id, modelId: model.id }), label: `${provider.name || '未命名供应商'} / ${account.label || '未命名账号'} / ${model.name || model.externalId || '未命名模型'}` };
  }) : [];
  const selectedRoute = (route: ModelBinding | null) => route ? bindingKey(route) : '';
  const routeDetails = (route: ModelBinding | null) => {
    if (!route || !draft) return '尚未设置默认模型';
    const provider = draft.providers.find(item => item.id === route.providerId);
    const account = draft.accounts.find(item => item.id === route.accountId);
    const model = draft.models.find(item => item.id === route.modelId);
    return [provider?.name, account?.label, model?.name || model?.externalId].filter(Boolean).join(' / ');
  };
  const credentialStatus = (account: AccountConfig) => {
    const configured = snapshot?.credentials.find(item => item.accountId === account.id)?.configured;
    const savedAccount = snapshot?.settings.accounts.find(item => item.id === account.id);
    if (configured && savedAccount?.secretEnv && savedAccount.secretEnv === account.secretEnv) return '服务端检测到变量存在 · 供应商身份尚未验证';
    return account.secretEnv ? '变量存在状态未知或尚未保存 · 未验证供应商身份' : '未填写密钥变量名 · 未进行身份验证';
  };

  return <section aria-labelledby="settings-title" className="settings-page">
    <div className="page-heading"><div><div className="eyebrow">连接与运行偏好</div><h1 id="settings-title">工作台配置</h1><p>分层管理供应商、账号与模型目录。仅保存手工声明的配置草稿。</p></div><Settings2 size={26} /></div>
    <div className="settings-runtime"><FlaskConical size={22} /><div className="settings-runtime-copy"><strong>{snapshot?.runtime.externalProvidersEnabled ? '代理文本调用：检测到可用模型配置' : '代理文本调用：尚未配置可用模型'}</strong><p>在供应商、账号和模型目录中填入配置，并设置默认文本路由或在代理角色中单独绑定模型。API 服务从账号声明的环境变量读取密钥。图像生成仍使用本地 SVG，代理文本调用可能产生供应商费用。</p>
    </div><span className="mock-badge">{snapshot?.runtime.externalProvidersEnabled ? '文本模型已配置' : '等待模型配置'}</span></div>
    {error && <div className="inline-error" role="alert">{error}<button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}><RotateCcw size={14} />重新加载配置</button><p>重新加载会丢弃未保存的修改；版本冲突时请先记录修改内容。</p></div>}
    {!draft || !snapshot ? <p role="status">{busy ? '正在加载配置…' : '配置暂不可用，请重新加载。'}</p> :
      <form onSubmit={event => void save(event)}>
        <fieldset disabled={busy} className="settings-fields">
          <section className="panel"><div className="section-heading"><h2>创作默认值</h2><span>保存后用于新创作</span></div><div className="settings-default"><label htmlFor="default-count">默认生成数量<span className="muted small">图像路由仍由本地模拟器执行。</span></label><input id="default-count" type="number" min={1} max={8} required value={Number.isNaN(draft.defaultCount) ? '' : draft.defaultCount} onChange={event => change(current => ({ ...current, defaultCount: event.target.valueAsNumber }))} /></div></section>
          <section className="panel"><div className="section-heading"><div><h2>供应商</h2><p className="panel-description">每家供应商可配置多个账号，每个账号有独立的手工模型目录。</p></div><button type="button" className="secondary-button" disabled={draft.providers.length >= 8} onClick={addProvider}><Plus size={14} />添加供应商</button></div>
            <div className="catalog-tools"><label className="catalog-search"><Search size={16} /><span className="sr-only">搜索供应商、账号或模型</span><input type="search" value={search} placeholder="搜索供应商、账号或模型…" onChange={event => setSearch(event.target.value)} /></label><button type="button" className={`secondary-button pin-filter ${pinnedOnly ? 'is-selected' : ''}`} aria-pressed={pinnedOnly} onClick={() => setPinnedOnly(value => !value)}><Pin size={14} />仅显示收藏 <span>{draft.models.filter(model => model.pinned).length}</span></button><span className="catalog-count">{draft.providers.length}/8 供应商 · {draft.accounts.length}/16 账号 · {draft.models.length}/64 模型</span></div>
            {draft.providers.length === 0 && <div className="settings-empty">暂无供应商。添加供应商，再为其建立账号与手工维护的模型目录。</div>}
            <div className="provider-list">{draft.providers.map((provider, providerIndex) => <section className="provider-card" key={provider.id} aria-label={`供应商 ${provider.name || providerIndex + 1}`}>
              <div className="section-heading"><div><span className="provider-index">{String(providerIndex + 1).padStart(2, '0')}</span><div><h3>{provider.name || `新供应商 ${providerIndex + 1}`}</h3><span className="unverified-tag">声明草稿 · 尚未验证</span></div></div><button className="icon-button destructive-icon" type="button" onClick={() => removeProvider(provider.id)} aria-label={`删除供应商 ${provider.name || providerIndex + 1}`}><Trash2 size={17} /></button></div>
              <div className="settings-grid provider-meta"><label>供应商名称<input required maxLength={80} value={provider.name} placeholder="例如：OpenAI Compatible" onChange={event => change(current => ({ ...current, providers: current.providers.map(item => item.id === provider.id ? { ...item, name: event.target.value } : item) }))} /></label><label>传输方式<select aria-label={`${provider.name || '供应商'}传输方式`} value={provider.transport} onChange={event => change(current => ({ ...current, providers: current.providers.map(item => item.id === provider.id ? { ...item, transport: event.target.value as ProviderConfig['transport'] } : item) }))}><option value="api">远程 API</option><option value="local">本地服务</option></select></label><label>协议声明<select aria-label={`${provider.name || '供应商'}协议声明`} value={provider.protocol} onChange={event => change(current => ({ ...current, providers: current.providers.map(item => item.id === provider.id ? { ...item, protocol: event.target.value as ProviderConfig['protocol'] } : item) }))}><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="google">Google</option></select><span>协议尚未进行兼容性或连通验证。</span></label><label>服务基础地址<input required type="url" maxLength={1000} value={provider.baseUrl} placeholder={provider.transport === 'local' ? 'http://localhost:1234/v1' : 'https://api.example.com/v1'} onChange={event => change(current => ({ ...current, providers: current.providers.map(item => item.id === provider.id ? { ...item, baseUrl: event.target.value } : item) }))} /><span>HTTPS 或本机 HTTP；不包含查询参数、片段或 URL 密钥。</span></label></div>
              <div className="account-heading"><div><h4>账号 <span>{draft.accounts.filter(item => item.providerId === provider.id).length}</span></h4><p>账号独立保存服务端密钥引用与可用状态。</p></div><button type="button" className="secondary-button" disabled={draft.accounts.length >= 16} onClick={() => addAccount(provider.id)}><Plus size={14} />添加账号</button></div>
              {draft.accounts.filter(item => item.providerId === provider.id).length === 0 && <div className="nested-empty">尚未添加账号。供应商目录与账号登录、密钥验证相互独立。</div>}
              <div className="account-list">{draft.accounts.filter(item => item.providerId === provider.id).map((account, accountIndex) => <section className="account-card" key={account.id} aria-label={`账号 ${account.label || accountIndex + 1}`}>
                <div className="section-heading"><div><h4>{account.label || `新账号 ${accountIndex + 1}`}</h4><span className={`account-enabled ${account.enabled ? '' : 'disabled-account'}`}>{account.enabled ? '可用于默认绑定' : '已停用'}</span></div><div className="inline-actions"><label className="switch-label"><input type="checkbox" checked={account.enabled} onChange={event => change(current => ({ ...current, accounts: current.accounts.map(item => item.id === account.id ? { ...item, enabled: event.target.checked } : item) }))} />启用账号</label><button className="icon-button destructive-icon" type="button" onClick={() => removeAccount(account.id)} aria-label={`删除账号 ${account.label || accountIndex + 1}`}><Trash2 size={16} /></button></div></div>
                <div className="settings-grid account-fields"><label>账号名称<input required maxLength={80} value={account.label} placeholder="例如：团队主账号" onChange={event => change(current => ({ ...current, accounts: current.accounts.map(item => item.id === account.id ? { ...item, label: event.target.value } : item) }))} /></label><label>密钥环境变量名 <span className="not-secret">仅变量名，不是密钥</span><input maxLength={100} pattern="[A-Z][A-Z0-9_]*|" value={account.secretEnv} placeholder="例如：MODEL_API_KEY" onChange={event => change(current => ({ ...current, accounts: current.accounts.map(item => item.id === account.id ? { ...item, secretEnv: event.target.value } : item) }))} /><span>变量名称由服务端读取；此页面不接收或持久化密钥值。</span></label></div>
                <p className="credential-state" role="status"><FlaskConical size={14} />{credentialStatus(account)}</p>
                <div className="model-heading"><div><h5>手工模型目录 <span>{draft.models.filter(item => item.accountId === account.id).length}</span></h5><p>维护模型 ID 与未验证的能力声明。</p></div><button type="button" className="secondary-button" disabled={draft.models.length >= 64} onClick={() => addModel(account.id)}><Plus size={14} />添加模型</button></div>
                {draft.models.filter(item => item.accountId === account.id && visibleModels.has(item.id)).length === 0 && <p className="model-empty">{draft.models.some(item => item.accountId === account.id) ? '没有符合当前搜索条件的模型。' : '账号目录为空，请手工添加供应商提供的模型 ID。'}</p>}
                <div className="model-list">{draft.models.filter(item => item.accountId === account.id && visibleModels.has(item.id)).map(model => <article className="model-card" key={model.id}>
                  <div className="model-card-heading"><div><span className="model-mark">◎</span><div><strong>{model.name || model.externalId || '未命名模型'}</strong><code>{model.externalId || '填写外部模型 ID'}</code></div></div><div className="inline-actions"><button className={`icon-button ${model.pinned ? 'is-pinned' : ''}`} type="button" aria-pressed={model.pinned} aria-label={model.pinned ? `取消收藏 ${model.name || model.externalId || '模型'}` : `收藏 ${model.name || model.externalId || '模型'}`} onClick={() => change(current => ({ ...current, models: current.models.map(item => item.id === model.id ? { ...item, pinned: !item.pinned } : item) }))}>{model.pinned ? <Pin size={16} fill="currentColor" /> : <PinOff size={16} />}</button><button className="icon-button destructive-icon" type="button" onClick={() => removeModel(model)} aria-label={`删除模型 ${model.name || model.externalId || '模型'}`}><Trash2 size={15} /></button></div></div>
                  <div className="model-fields"><label>显示名称<input required maxLength={80} value={model.name} placeholder="例如：轻量文本模型" onChange={event => change(current => ({ ...current, models: current.models.map(item => item.id === model.id ? { ...item, name: event.target.value } : item) }))} /></label><label>供应商模型 ID<input required maxLength={160} value={model.externalId} placeholder="例如：example-model-v1" onChange={event => change(current => ({ ...current, models: current.models.map(item => item.id === model.id ? { ...item, externalId: event.target.value } : item) }))} /></label></div>
                  <fieldset className="capability-fieldset"><legend>能力声明 <span>由你手工填写，未经供应商验证</span></legend><div className="capability-options">{allCapabilities.map(capability => <label className="capability-option" key={capability}><input type="checkbox" checked={model.capabilities.includes(capability)} onChange={event => change(current => ({ ...current, models: current.models.map(item => item.id === model.id ? { ...item, capabilities: event.target.checked ? [...item.capabilities, capability] : item.capabilities.filter(value => value !== capability) } : item) }))} />{capabilityLabels[capability]}</label>)}</div></fieldset>
                </article>)}</div>
              </section>)}</div>
            </section>)}</div>
            {draft.models.length > 0 && search && visibleModels.size === 0 && <p className="no-search-results">没有找到匹配的模型，请调整搜索词。</p>}
          </section>
          <section className="panel routing-panel"><div className="section-heading"><div><h2>默认模型绑定</h2><p className="panel-description">每条默认路由明确绑定供应商、启用账号和具体模型。</p></div><span>生效来源：工作区默认</span></div>
            <label className="route-field">文本与代码 <small>文本路由允许声明 text 或 code 能力</small><span className="route-source">工作区默认</span><select aria-label="文本与代码" value={selectedRoute(draft.routes.text)} onChange={event => updateRoute('text', event.target.value)}><option value="">未绑定</option>{routeOptions('text').map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><span className="route-resolved">{routeDetails(draft.routes.text)}</span></label>
            <label className="route-field">图像生成 <small>当前执行仍固定使用本地模拟 SVG</small><span className="route-source">工作区默认 · 实际运行仅模拟</span><select aria-label="默认图像模型绑定" value={draft.routes.image === 'mock-svg' ? 'mock-svg' : selectedRoute(draft.routes.image)} onChange={event => updateImageRoute(event.target.value)}><option value="mock-svg">本地模拟 SVG（当前实际生效）</option>{routeOptions('image').map(option => <option key={option.value} value={option.value}>{option.label}（未启用草稿）</option>)}</select>{draft.routes.image !== 'mock-svg' && <span className="route-resolved">草稿选择：{routeDetails(draft.routes.image)} · 尚未启用</span>}</label>
            <label className="route-field">视频生成 <small>需要手工声明 video 能力</small><span className="route-source">工作区默认</span><select aria-label="视频生成" value={selectedRoute(draft.routes.video)} onChange={event => updateRoute('video', event.target.value)}><option value="">未绑定</option>{routeOptions('video').map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><span className="route-resolved">{routeDetails(draft.routes.video)}</span></label>
          </section>
        </fieldset>
        <div className="settings-save"><p role="status">{saved ? <><Check size={15} />配置已保存</> : dirty ? '有未保存的修改' : `已保存版本 ${snapshot.revision}`}</p><button type="submit" className="primary-button" disabled={busy || !dirty}><Save size={16} />{busy ? '正在保存…' : '保存配置'}</button></div>
      </form>}
  </section>;
}
