import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MeResponse } from '@collab/shared/schemas.js';
import { AnalyticsPage } from './AnalyticsPage';
import { projectCompletionReport } from './api';
import type { ProjectCompletionReport } from './api';
import { approvalTimingReport, departmentWorkloadReport, projectCompletionCsv } from './analytics-api';
import type { ApprovalTimingReport, DepartmentWorkloadReport } from './analytics-api';

vi.mock('./api', () => ({ projectCompletionReport: vi.fn() }));
vi.mock('./analytics-api', () => ({ approvalTimingReport: vi.fn(), departmentWorkloadReport: vi.fn(), projectCompletionCsv: vi.fn() }));
const identity: MeResponse = {
  user: { id: 'admin', name: '管理员', email: 'internal.admin', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null },
  organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: ['org_admin'],
  permissions: ['analytics:read:all'], csrfToken: 'csrf',
};
const report: ProjectCompletionReport = {
  generatedAt: '2026-11-02T10:00:00.000Z', timezone: 'Asia/Shanghai', overdueAsOfLocalDate: '2026-11-02', temporalSemantics: 'current_snapshot_filtered_by_project_creation_time',
  filter: { overduePage: 1, overduePageSize: 20 }, projects: [], overdueTasks: [], overdueMeta: { page: 1, pageSize: 20, total: 0 },
  totals: { projectCount: 3, taskCount: 8, completedTaskCount: 5, cancelledTaskCount: 1, effectiveTaskCount: 7, openTaskCount: 2, completionRate: 71.43, overdueTaskCount: 1, overdueRate: 50 },
};
const approvalReport: ApprovalTimingReport = {
  generatedAt: '2026-11-03T00:00:00.000Z', filter: {}, sampleCount: 4, medianHours: 6, p90Hours: 9.4,
  options: { applicationTypes: ['general'], departments: [{ id: 'dept-a', name: '研发部' }], templates: [{ id: 'template-a', name: '标准模板' }] },
};
const departmentReport: DepartmentWorkloadReport = {
  generatedAt: '2026-11-03T00:00:00.000Z', timezone: 'Asia/Shanghai', overdueAsOfLocalDate: '2026-11-03', filter: {},
  departments: [{ departmentId: 'dept-a', departmentName: '研发部', activeUserCount: 5, taskCount: 12, completedTaskCount: 7, cancelledTaskCount: 1, openTaskCount: 4, overdueTaskCount: 2 }],
};
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const originalMatchMedia = window.matchMedia;
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({
    matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined,
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
  }) });
});
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });

describe('经营数据分析', () => {
  it('按项目创建日期筛选并呈现服务端汇总', async () => {
    vi.mocked(projectCompletionReport).mockResolvedValue(report);
    render(<AnalyticsPage identity={identity} />);
    fireEvent.change(screen.getByLabelText('项目创建日期从'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('到'), { target: { value: '2026-11-02' } });
    fireEvent.click(screen.getAllByRole('button', { name: /查\s*询/u })[0]!);
    expect(await screen.findByText('71.43%')).toBeTruthy();
    await waitFor(() => expect(projectCompletionReport).toHaveBeenCalledWith({
      createdFrom: new Date(2026, 10, 1).toISOString(),
      createdTo: new Date(2026, 10, 3).toISOString(),
      overduePage: 1,
      overduePageSize: 20,
    }));
    expect(screen.getByText('逾期未完成')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('查询并展示受权限约束的审批耗时统计与筛选选项', async () => {
    vi.mocked(approvalTimingReport).mockResolvedValue(approvalReport);
    render(<AnalyticsPage identity={identity} />);
    fireEvent.click(screen.getByRole('button', { name: /查询审批耗时/u }));
    expect(await screen.findByText('6 小时')).toBeTruthy();
    expect(screen.getByText('9.4 小时')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    await waitFor(() => expect(approvalTimingReport).toHaveBeenCalledWith({ applicationType: undefined, departmentId: undefined, templateId: undefined }));
    expect(screen.getByRole('combobox', { name: '审批部门' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '审批模板' })).toBeTruthy();
  });

  it('按当前项目日期筛选下载 CSV', async () => {
    vi.mocked(projectCompletionReport).mockResolvedValue(report);
    vi.mocked(projectCompletionCsv).mockResolvedValue(new Blob(['csv'], { type: 'text/csv' }));
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<AnalyticsPage identity={identity} />);
    fireEvent.change(screen.getByLabelText('项目创建日期从'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('到'), { target: { value: '2026-11-02' } });
    fireEvent.click(screen.getAllByRole('button', { name: /查\s*询/u })[0]!);
    await screen.findByText('71.43%');
    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/u }));
    await waitFor(() => expect(projectCompletionCsv).toHaveBeenCalledWith({
      createdFrom: new Date(2026, 10, 1).toISOString(),
      createdTo: new Date(2026, 10, 3).toISOString(),
    }));
    expect(click).toHaveBeenCalledOnce();
  });

  it('renders department workload only from the authorized report response', async () => {
    vi.mocked(departmentWorkloadReport).mockResolvedValue(departmentReport);
    render(<AnalyticsPage identity={identity} />);
    fireEvent.click(screen.getByRole('button', { name: '查询部门工作量' }));
    expect(await screen.findByText('研发部')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    await waitFor(() => expect(departmentWorkloadReport).toHaveBeenCalledWith());
  });
});
