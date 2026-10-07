import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleLibraryPage } from './RoleLibraryPage';
import { makeSettingsResponse, sampleSettings } from '../test-fixtures';
import type { Role, RoleDefinition, RoleLibrary } from '../types';

const tool = { id: 'assets.read', name: '读取素材', description: '读取工作区内素材。', risk: 'read' as const, executable: false as const };
const role = (patch: Partial<Role> = {}): Role => ({
  id: 'scriptwriter', revision: 1, builtIn: true, lifecycle: 'published', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', modelStatus: 'inherit',
  name: '脚本编剧', category: 'media', description: '根据创意简报撰写脚本。', systemPrompt: '保持表达清晰。', inputContract: '创意简报与受众。', outputContract: '按场景组织的脚本。', tools: ['assets.read'], modelSelection: { kind: 'inherit' },
  limits: { maxSteps: 8, maxToolCalls: 20, deadlineMs: 120000, maxCost: 1 }, ...patch,
});
const customId = '58f6c899-3d50-4f9e-a737-2ad80c9e6817';
const customDraft = () => role({ id: customId, name: '品牌文案策划', builtIn: false, lifecycle: 'draft' });
const initialLibrary = (roles: Role[] = [role()]): RoleLibrary => ({ revision: 3, roles, tools: [tool], runtime: { enabled: false, mode: 'metadata-only' } });

function installRolesApi(initialRoles: Role[] = [role()]) {
  let library = initialLibrary(initialRoles);
  const history = [...initialRoles];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace('http://localhost:4000', '');
    if (path === '/api/roles' && init?.method !== 'POST') return Response.json(library);
    if (path === '/api/settings') return Response.json(makeSettingsResponse(sampleSettings()));
    if (path.endsWith('/revisions')) return Response.json({ revisions: history });
    if (path === '/api/roles' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { role: RoleDefinition };
      const created = role({ ...body.role, id: customId, revision: 1, builtIn: false, lifecycle: 'draft' });
      history.push(created);
      library = { ...library, revision: library.revision + 1, roles: [...library.roles, created] };
      return Response.json({ revision: library.revision, role: created }, { status: 201 });
    }
    if (path === `/api/roles/${customId}` && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { role: RoleDefinition };
      const updated = role({ ...body.role, id: customId, revision: 2, builtIn: false, lifecycle: 'draft' });
      library = { ...library, revision: library.revision + 1, roles: library.roles.map(item => item.id === customId ? updated : item) };
      return Response.json({ revision: library.revision, role: updated });
    }
    if (path === `/api/roles/${customId}/archive` && init?.method === 'POST') {
      const archived = role({ ...(library.roles.find(item => item.id === customId) || customDraft()), builtIn: false, lifecycle: 'archived', revision: 2 });
      library = { ...library, revision: library.revision + 1, roles: library.roles.map(item => item.id === customId ? archived : item) };
      return Response.json({ revision: library.revision, role: archived });
    }
    return Response.json({ error: { code: 'NOT_FOUND', message: '未找到' } }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('代理角色 metadata 工作流', () => {
  beforeEach(() => { vi.stubGlobal('confirm', vi.fn(() => true)); });

  it('搜索内置模板并复制成可编辑的自定义草稿', async () => {
    const fetchMock = installRolesApi(); const user = userEvent.setup(); render(<RoleLibraryPage />);
    expect(await screen.findByRole('heading', { name: '脚本编剧' })).toBeVisible();
    expect(screen.getByText(/代理运行功能尚未启用/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /运行角色/ })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: '搜索角色' }), '脚本编剧');
    await user.click(screen.getByRole('button', { name: '复制为自定义角色' }));
    await screen.findByRole('heading', { name: '脚本编剧 副本' });
    expect(screen.getAllByText('草稿').length).toBeGreaterThan(0);
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/roles') && init?.method === 'POST');
    expect(JSON.parse(createCall![1]!.body as string)).toMatchObject({ revision: 3, role: { name: '脚本编剧 副本', modelSelection: { kind: 'inherit' }, tools: ['assets.read'] } });
  });

  it('创建草稿并显示已保存修订历史', async () => {
    const fetchMock = installRolesApi(); const user = userEvent.setup(); render(<RoleLibraryPage />);
    await user.click(await screen.findByRole('button', { name: '新建自定义角色' }));
    await user.type(screen.getByLabelText(/角色名称/), '品牌文案策划');
    await user.type(screen.getByLabelText(/角色描述/), '为品牌写简洁文案。');
    await user.type(screen.getByLabelText(/系统提示词/), '以清楚、温暖的方式写作。');
    await user.type(screen.getByLabelText(/输入契约说明/), '需要品牌信息和受众。');
    await user.type(screen.getByLabelText(/输出契约说明/), '输出标题与正文。');
    await user.click(screen.getByRole('button', { name: '创建角色草稿' }));
    await screen.findByRole('heading', { name: '品牌文案策划' });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === 'http://localhost:4000/api/roles' && init?.method === 'POST')).toBe(true);
    await user.click(screen.getByRole('button', { name: '查看修订历史' }));
    expect(await screen.findByRole('region', { name: '角色修订历史' })).toHaveTextContent('以清楚、温暖的方式写作。');
  });

  it('dirty 时刷新会先确认；取消确认后保留正在编辑的内容', async () => {
    const fetchMock = installRolesApi([customDraft()]); const user = userEvent.setup(); render(<RoleLibraryPage />);
    await user.click(await screen.findByRole('button', { name: '编辑草稿' }));
    const prompt = screen.getByLabelText(/系统提示词/);
    await user.clear(prompt); await user.type(prompt, '不要在取消确认时丢失。');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: '刷新角色库' }));
    expect(prompt).toHaveValue('不要在取消确认时丢失。');
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/roles') && init?.method !== 'POST')).toHaveLength(1);
    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: '刷新角色库' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存角色草稿' })).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/roles') && init?.method !== 'POST')).toHaveLength(2);
  });

  it('写请求期间禁用历史、刷新和角色切换，读操作不会中止未完成的复制', async () => {
    let complete!: (response: Response) => void;
    const pendingResponse = new Promise<Response>(resolve => { complete = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace('http://localhost:4000', '');
      if (path === '/api/roles' && init?.method === 'POST') return pendingResponse;
      if (path === '/api/roles') return Response.json(initialLibrary());
      if (path === '/api/settings') return Response.json(makeSettingsResponse(sampleSettings()));
      if (path.endsWith('/revisions')) return Response.json({ revisions: [role()] });
      return Response.json({ error: { code: 'NOT_FOUND', message: '未找到' } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup(); render(<RoleLibraryPage />);
    await user.click(await screen.findByRole('button', { name: '复制为自定义角色' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '查看修订历史' })).toBeDisabled());
    expect(screen.getByRole('button', { name: '刷新角色库' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /脚本编剧/ })).toBeDisabled();
    const postCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/roles') && init?.method === 'POST');
    expect((postCall?.[1]?.signal as AbortSignal).aborted).toBe(false);
    complete(Response.json({ revision: 4, role: role({ ...JSON.parse(postCall?.[1]?.body as string).role, id: customId, builtIn: false, lifecycle: 'draft' }) }, { status: 201 }));
    expect(await screen.findByRole('heading', { name: '脚本编剧 副本' })).toBeVisible();
    expect((postCall?.[1]?.signal as AbortSignal).aborted).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/revisions'))).toBe(false);
  });

  it('409 时保留编辑草稿并允许重新加载，归档需确认且从默认列表隐藏', async () => {
    const fetchMock = installRolesApi([customDraft()]);
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace('http://localhost:4000', '');
      if (path === `/api/roles/${customId}` && init?.method === 'POST') return Response.json({ error: { code: 'REVISION_CONFLICT', message: '版本冲突' } }, { status: 409 });
      if (path === '/api/roles') return Response.json(initialLibrary([customDraft()]));
      if (path === '/api/settings') return Response.json(makeSettingsResponse(sampleSettings()));
      if (path.endsWith('/archive')) return Response.json({ revision: 4, role: role({ ...customDraft(), lifecycle: 'archived', builtIn: false, revision: 2 }) });
      return Response.json({ error: { code: 'NOT_FOUND', message: '未找到' } }, { status: 404 });
    });
    const user = userEvent.setup(); render(<RoleLibraryPage />);
    await user.click(await screen.findByRole('button', { name: /品牌文案策划/ }));
    await user.click(screen.getByRole('button', { name: '编辑草稿' }));
    const persona = screen.getByLabelText(/系统提示词/);
    await user.clear(persona); await user.type(persona, '保留这份草稿。');
    await user.click(screen.getByRole('button', { name: '保存角色草稿' }));
    expect(await screen.findByRole('button', { name: '重新加载最新版本' })).toBeVisible();
    expect(persona).toHaveValue('保留这份草稿。');
    await user.click(screen.getByRole('button', { name: '重新加载最新版本' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存角色草稿' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /品牌文案策划/ }));
    const archiveButton = screen.getByRole('button', { name: '归档角色' });
    await user.click(archiveButton);
    await waitFor(() => expect(screen.queryByRole('button', { name: /品牌文案策划/ })).not.toBeInTheDocument());
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('归档'));
  });
});
