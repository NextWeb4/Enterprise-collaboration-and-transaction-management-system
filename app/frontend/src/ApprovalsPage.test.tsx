import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MeResponse } from '@collab/shared/schemas.js';
import { ApprovalsPage } from './ApprovalsPage';
import * as approvals from './approvals-api';
import { listProjects } from './api';

vi.mock('./api', () => ({ listProjects: vi.fn() }));
vi.mock('./approvals-api', () => ({ actOnApplication: vi.fn(), attachApplicationFile: vi.fn(), attachmentDownloadUrl: vi.fn(), copyApplication: vi.fn(), createApplication: vi.fn(), getApplication: vi.fn(), initializeTemplates: vi.fn(), listApplications: vi.fn(), listApprovalUsers: vi.fn(), listTemplates: vi.fn(), listTemplateVersions: vi.fn(), removeApplication: vi.fn(), removeApplicationFile: vi.fn(), saveTemplate: vi.fn(), submitApplication: vi.fn(), templateAction: vi.fn(), updateApplication: vi.fn() }));
const identity: MeResponse = { user: { id: 'owner', name: '申请人', email: 'owner', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null }, organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: ['member'], permissions: ['application:read:self', 'application:create', 'organization:directory:read'], csrfToken: 'csrf' };
const detail: approvals.ApplicationDetail = { id: 'application-1', version: 2, applicationNo: 'OA-20261102-0001', applicationType: 'general', title: '行政事务申请', applicantId: 'owner', applicantName: '申请人', departmentId: null, departmentName: null, status: 'pending', createdAt: '2026-11-02T01:00:00.000Z', submittedAt: '2026-11-02T01:00:00.000Z', completedAt: null, redacted: false, formSchemaVersion: 1, formData: { subject: '行政事项', content: '需要处理的行政事务详细说明' }, startAt: null, endAt: null, projectId: null, attachments: [], history: { submittedAt: '2026-11-02T01:00:00.000Z', records: [], steps: [] }, actions: { edit: false, submit: false, withdraw: false, approve: false, reassign: false, copy: false } };
function page(path = '/app/applications', user = identity): ReturnType<typeof render> { return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/app/applications/*" element={<ApprovalsPage identity={user} />} /></Routes></MemoryRouter>); }
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) }); });
beforeEach(() => {
  vi.mocked(approvals.listApplications).mockResolvedValue({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
  vi.mocked(approvals.getApplication).mockResolvedValue(detail);
  vi.mocked(approvals.listApprovalUsers).mockResolvedValue([{ userId: 'owner', name: '申请人' }, { userId: 'other', name: '交接同事' }]);
  vi.mocked(approvals.listTemplates).mockResolvedValue([]);
  vi.mocked(listProjects).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('OA approval pages', () => {
  it('refuses business queries without read permissions', () => {
    page('/app/applications', { ...identity, permissions: [] });
    expect(screen.getByText('没有查看申请的权限，请联系组织管理员')).toBeTruthy();
    expect(approvals.listApplications).not.toHaveBeenCalled();
  });

  it('displays empty state, sends search and hides template management for ordinary members', async () => {
    const user = userEvent.setup(); page();
    expect(await screen.findByText('此范围暂无申请')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '审批模板' })).toBeNull();
    await user.type(screen.getByRole('searchbox', { name: '搜索申请' }), '办公{Enter}');
    await waitFor(() => expect(approvals.listApplications).toHaveBeenLastCalledWith(expect.objectContaining({ q: '办公', page: 1 })));
  });

  it('renders all five real form variants and submits a general draft from RHF state', async () => {
    const user = userEvent.setup(); page('/app/applications/new');
    const choose = async (label: string): Promise<void> => { await user.click(screen.getByRole('combobox', { name: '申请类型' })); await user.click(await screen.findByTitle(label)); };
    await choose('请假'); expect(screen.getByRole('combobox', { name: '请假类型' })).toBeTruthy(); expect(screen.getByRole('combobox', { name: '交接人' })).toBeTruthy();
    await choose('出差'); expect(screen.getByRole('textbox', { name: '目的地' })).toBeTruthy();
    await choose('外勤'); expect(screen.getByRole('textbox', { name: '外勤地点' })).toBeTruthy();
    await choose('用印'); expect(screen.getByRole('textbox', { name: '文件名称' })).toBeTruthy(); expect(screen.getByText('保存草稿后，请上传一个待用印文件再提交审批。')).toBeTruthy();
    await choose('通用事务');
    await user.type(screen.getByRole('textbox', { name: '标题' }), '行政事务申请');
    await user.type(screen.getByRole('textbox', { name: '主题' }), '行政事项');
    await user.type(screen.getByRole('textbox', { name: '事项说明' }), '需要处理的行政事务详细说明');
    vi.mocked(approvals.createApplication).mockResolvedValue({ id: detail.id, version: 1 });
    await user.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(approvals.createApplication).toHaveBeenCalledWith({ applicationType: 'general', title: detail.title, formData: detail.formData, startAt: null, endAt: null, projectId: null }));
    expect(await screen.findByRole('heading', { name: detail.title })).toBeTruthy();
  });

  it('uses backend action capabilities and sends the rendered application version on approval', async () => {
    vi.mocked(approvals.getApplication).mockResolvedValue({ ...detail, actions: { ...detail.actions, approve: true } });
    vi.mocked(approvals.actOnApplication).mockResolvedValue({ success: true });
    const user = userEvent.setup(); page('/app/applications/application-1', { ...identity, permissions: ['application:approve'] });
    await user.click(await screen.findByRole('button', { name: /通\s*过/ }));
    const modal = screen.getByRole('dialog');
    await user.type(within(modal).getByRole('textbox', { name: '审批意见或原因' }), '同意');
    await user.click(within(modal).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(approvals.actOnApplication).toHaveBeenCalledWith(detail.id, 'approve', detail.version, '同意', undefined));
    expect(screen.queryByRole('button', { name: '编辑草稿' })).toBeNull();
  });

  it('does not render attachment controls or hidden body for audit summaries', async () => {
    vi.mocked(approvals.getApplication).mockResolvedValue({ ...detail, title: '申请摘要', redacted: true, formData: null });
    page('/app/applications/application-1', { ...identity, roles: ['auditor'], permissions: ['audit:read'] });
    expect(await screen.findByText('审计摘要：正文、附件和审批意见已隐藏')).toBeTruthy();
    expect(screen.queryByText('需要处理的行政事务详细说明')).toBeNull();
    expect(screen.queryByRole('button', { name: '上传附件' })).toBeNull();
    expect(screen.queryByText('附件')).toBeNull();
  });
});
