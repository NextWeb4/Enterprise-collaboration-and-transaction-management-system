import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DocumentView, MeResponse } from '@collab/shared/schemas.js';
import { DocumentsPage } from './DocumentsPage';
import * as docs from './documents-api';
import { listProjects } from './api';
vi.mock('./api', () => ({ listProjects: vi.fn() }));
vi.mock('./documents-api', () => ({ searchDocuments: vi.fn(), classifications: vi.fn(), getDocument: vi.fn(), documentVersions: vi.fn(), documentDownloadUrl: vi.fn(), documentPreviewUrl: vi.fn(), uploadDocument: vi.fn(), archiveDocument: vi.fn(), batchDocuments: vi.fn(), deleteDocument: vi.fn(), updateDocument: vi.fn(), uploadVersion: vi.fn(), documentGrants: vi.fn(), documentSubjects: vi.fn(), saveDocumentGrant: vi.fn(), revokeDocumentGrant: vi.fn(), saveCategory: vi.fn(), deleteCategory: vi.fn(), saveTag: vi.fn(), deleteTag: vi.fn() }));
const identity: MeResponse = { user: { id: 'owner', name: '用户', email: 'owner', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null }, organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: ['member'], permissions: ['document:read', 'document:create'], csrfToken: 'csrf' };
const doc: DocumentView = { id: '019a44cc-0000-7000-8000-000000000001', title: '团队手册', description: '欢迎阅读', categoryId: null, projectId: null, ownerId: 'owner', visibility: 'restricted', status: 'active', currentVersionId: 'v1', versionCount: 1, version: 2, updatedAt: '2026-11-02T00:00:00.000Z', createdAt: '2026-11-02T00:00:00.000Z', tagIds: [], level: 'view', readOnly: false, currentFile: { fileName: 'handbook.txt', size: 30, mime: 'text/plain' } };
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) }); });
beforeEach(() => {
  vi.mocked(docs.searchDocuments).mockResolvedValue({ data: [], meta: { total: 0, page: 1, pageSize: 20 } });
  vi.mocked(docs.classifications).mockResolvedValue({ categories: [], tags: [] }); vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(docs.getDocument).mockResolvedValue(doc); vi.mocked(docs.documentVersions).mockResolvedValue([]);
  vi.mocked(docs.documentDownloadUrl).mockImplementation((id) => '/api/v1/documents/' + id + '/download');
  vi.mocked(docs.documentPreviewUrl).mockImplementation((id) => '/api/v1/documents/' + id + '/preview');
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('document center UI', () => {
  it('does not query business data without read permission', () => {
    render(<DocumentsPage identity={{ ...identity, permissions: [] }} />);
    expect(screen.getByText('没有查看文档中心的权限')).toBeTruthy(); expect(docs.searchDocuments).not.toHaveBeenCalled();
  });
  it('shows the empty state and sends title searches to the server', async () => {
    const user = userEvent.setup(); render(<DocumentsPage identity={identity} />);
    expect(await screen.findByText('没有符合条件的文档')).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: '搜索文档标题、标签或正文' }), 'manual{Enter}');
    await waitFor(() => expect(docs.searchDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'manual', page: 1 })));
  });
  it('uses authorized download URLs and hides edit controls for view grants', async () => {
    vi.mocked(docs.searchDocuments).mockResolvedValue({ data: [doc], meta: { total: 1, page: 1, pageSize: 20 } });
    const user = userEvent.setup(); render(<DocumentsPage identity={{ ...identity, permissions: [...identity.permissions, 'document:update', 'document:delete'] }} />);
    await user.click(await screen.findByRole('button', { name: '团队手册' }));
    expect(await screen.findByText('欢迎阅读')).toBeTruthy(); expect(screen.queryByRole('button', { name: '编辑信息' })).toBeNull();
    expect(screen.getByRole('link', { name: '下载当前版本' }).getAttribute('href')).toContain('/documents/' + doc.id + '/download');
  });
  it('opens only PDF and image previews in a separate browser context', async () => {
    const previewable = { ...doc, currentFile: { fileName: 'handbook.pdf', size: 30, mime: 'application/pdf' } };
    vi.mocked(docs.searchDocuments).mockResolvedValue({ data: [previewable], meta: { total: 1, page: 1, pageSize: 20 } });
    vi.mocked(docs.getDocument).mockResolvedValue(previewable);
    const user = userEvent.setup(); render(<DocumentsPage identity={identity} />);
    await user.click(await screen.findByRole('button', { name: '团队手册' }));
    const link = await screen.findByRole('link', { name: '预览当前版本' });
    expect(link.getAttribute('href')).toContain('/documents/' + doc.id + '/preview');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
  it('uploads one selected file with restricted visibility and refreshes the document list', async () => {
    vi.mocked(docs.uploadDocument).mockResolvedValue(doc);
    const user = userEvent.setup(); render(<DocumentsPage identity={identity} />);
    await user.click(screen.getByRole('button', { name: '上传文档' }));
    const modal = screen.getByRole('dialog'); const file = new File(['handbook'], 'handbook.txt', { type: 'text/plain' });
    await user.upload(within(modal).getByLabelText('文档文件'), file);
    await user.click(within(modal).getByRole('button', { name: /OK/ }));
    await waitFor(() => expect(docs.uploadDocument).toHaveBeenCalledWith(file, expect.objectContaining({ title: 'handbook.txt', visibility: 'restricted', tagIds: [], categoryId: null })));
    await waitFor(() => expect(docs.searchDocuments).toHaveBeenCalledTimes(2));
  });
  it('shows batch operation results per selected manageable document', async () => {
    const second: DocumentView = { ...doc, id: '019a44cc-0000-7000-8000-000000000002', title: '项目制度', version: 4, level: 'manage' };
    const manageable = { ...doc, level: 'manage' as const };
    vi.mocked(docs.searchDocuments).mockResolvedValue({ data: [manageable, second], meta: { total: 2, page: 1, pageSize: 20 } });
    vi.mocked(docs.batchDocuments).mockResolvedValue({
      results: [
        { id: manageable.id, success: true, version: manageable.version + 1 },
        { id: second.id, success: false, code: 'VERSION_CONFLICT', message: '文档已更新，请刷新后重试' },
      ], succeeded: 1, failed: 1,
    });
    const user = userEvent.setup();
    render(<DocumentsPage identity={{ ...identity, permissions: [...identity.permissions, 'document:acl:manage'] }} />);
    const row = await screen.findByRole('row', { name: /团队手册/ });
    await user.click(within(row).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '批量归档' }));
    const modal = screen.getByRole('dialog');
    await user.click(within(modal).getByRole('button', { name: /OK/ }));
    await waitFor(() => expect(docs.batchDocuments).toHaveBeenCalledWith({ operation: 'archive', items: [{ id: manageable.id, version: manageable.version }] }));
    expect(await screen.findByText('成功 1 项，失败 1 项。')).toBeTruthy();
    expect(screen.getByText(/VERSION_CONFLICT/)).toBeTruthy();
  });
});
