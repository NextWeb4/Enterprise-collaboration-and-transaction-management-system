import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Descriptions, Empty, Input, Select, Space, Table, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import type { MeResponse } from '@collab/shared/schemas.js';
import { projectCompletionReport } from './api';
import type { ProjectCompletionMetric, ProjectCompletionReport } from './api';
import { approvalTimingReport, departmentWorkloadReport, projectCompletionCsv } from './analytics-api';
import type { ApprovalApplicationType, ApprovalTimingReport, DepartmentWorkloadReport } from './analytics-api';

function localDayStart(value: string): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toISOString();
}

function nextLocalDayStart(value: string): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1).toISOString();
}

export function AnalyticsPage({ identity }: { identity: MeResponse }): ReactNode {
  const allowed = identity.permissions.includes('analytics:read:project') || identity.permissions.includes('analytics:read:all');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [report, setReport] = useState<ProjectCompletionReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalType, setApprovalType] = useState<ApprovalApplicationType>();
  const [approvalDepartment, setApprovalDepartment] = useState<string>();
  const [approvalTemplate, setApprovalTemplate] = useState<string>();
  const [approvalReport, setApprovalReport] = useState<ApprovalTimingReport | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [departmentReport, setDepartmentReport] = useState<DepartmentWorkloadReport | null>(null);
  const [departmentLoading, setDepartmentLoading] = useState(false);
  const [departmentError, setDepartmentError] = useState<string | null>(null);

  const load = async (overduePage = 1): Promise<void> => {
    setLoading(true); setError(null);
    try {
      setReport(await projectCompletionReport({ createdFrom: localDayStart(createdFrom), createdTo: nextLocalDayStart(createdTo), overduePage, overduePageSize: 20 }));
    } catch (err) { setError(err instanceof Error ? err.message : '经营分析加载失败'); }
    finally { setLoading(false); }
  };
  const loadApprovalTiming = async (): Promise<void> => {
    setApprovalLoading(true); setApprovalError(null);
    try { setApprovalReport(await approvalTimingReport({ applicationType: approvalType, departmentId: approvalDepartment, templateId: approvalTemplate })); }
    catch (err) { setApprovalError(err instanceof Error ? err.message : '审批耗时加载失败'); }
    finally { setApprovalLoading(false); }
  };
  const exportProjectCompletion = async (): Promise<void> => {
    setExportLoading(true); setError(null);
    try {
      const blob = await projectCompletionCsv({ createdFrom: localDayStart(createdFrom), createdTo: nextLocalDayStart(createdTo) });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'project-completion.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) { setError(err instanceof Error ? err.message : 'CSV 导出失败'); }
    finally { setExportLoading(false); }
  };
  const loadDepartmentWorkload = async (): Promise<void> => {
    setDepartmentLoading(true); setDepartmentError(null);
    try { setDepartmentReport(await departmentWorkloadReport()); }
    catch (err) { setDepartmentError(err instanceof Error ? err.message : '部门工作量加载失败'); }
    finally { setDepartmentLoading(false); }
  };

  if (!allowed) return <Alert type="warning" showIcon message="没有查看经营分析的权限" />;

  return <div className="page-stack">
    <div className="page-heading"><div><Typography.Title level={2}>经营数据分析</Typography.Title><Typography.Text type="secondary">项目与任务完成情况。</Typography.Text></div></div>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
    <Card title="筛选条件">
      <Space wrap align="end">
        <label>项目创建日期从<Input type="date" value={createdFrom} onChange={(event) => setCreatedFrom(event.target.value)} /></label>
        <label>到<Input type="date" value={createdTo} onChange={(event) => setCreatedTo(event.target.value)} /></label>
        <Button type="primary" loading={loading} onClick={() => void load()}>查询</Button>
        <Button icon={<DownloadOutlined />} loading={exportLoading} onClick={() => void exportProjectCompletion()}>导出 CSV</Button>
      </Space>
    </Card>
    {report && <>
      <Card title="汇总">
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
          <Descriptions.Item label="项目数">{report.totals.projectCount}</Descriptions.Item>
          <Descriptions.Item label="有效任务">{report.totals.effectiveTaskCount}</Descriptions.Item>
          <Descriptions.Item label="已完成">{report.totals.completedTaskCount}</Descriptions.Item>
          <Descriptions.Item label="完成率">{report.totals.completionRate}%</Descriptions.Item>
          <Descriptions.Item label="逾期未完成">{report.totals.overdueTaskCount}</Descriptions.Item>
          <Descriptions.Item label="逾期率">{report.totals.overdueRate}%</Descriptions.Item>
        </Descriptions>
        <Typography.Text type="secondary">任务完成率和逾期率均为当前快照；逾期按组织时区 {report.timezone} 的 {report.overdueAsOfLocalDate} 计算。</Typography.Text>
      </Card>
      <Card title="项目明细">
        {report.projects.length === 0 ? <Empty description="当前筛选条件下没有可见项目" /> : <Table<ProjectCompletionMetric> rowKey="projectId" loading={loading} dataSource={report.projects} pagination={{ pageSize: 20 }} columns={[
          { title: '项目', render: (_: unknown, item: ProjectCompletionMetric) => `${item.projectName} (${item.projectKey})` },
          { title: '状态', dataIndex: 'projectStatus' },
          { title: '任务', dataIndex: 'taskCount' },
          { title: '已完成', dataIndex: 'completedTaskCount' },
          { title: '未完成', dataIndex: 'openTaskCount' },
          { title: '完成率', render: (_: unknown, item: ProjectCompletionMetric) => `${item.completionRate}%` },
          { title: '逾期未完成', dataIndex: 'overdueTaskCount' },
          { title: '逾期率', render: (_: unknown, item: ProjectCompletionMetric) => `${item.overdueRate}%` },
        ]} />}
      </Card>
      <Card title="逾期任务">
        {report.overdueMeta.total === 0 ? <Empty description="当前可见项目没有逾期未完成任务" /> : <Table rowKey="taskId" dataSource={report.overdueTasks} pagination={{ current: report.overdueMeta.page, pageSize: report.overdueMeta.pageSize, total: report.overdueMeta.total }} onChange={(pagination) => void load(pagination.current ?? 1)} columns={[
          { title: '项目', render: (_: unknown, item) => `${item.projectName} (${item.projectKey})` },
          { title: '任务', dataIndex: 'title' },
          { title: '任务编号', dataIndex: 'taskKey' },
          { title: '截止日期', dataIndex: 'dueDate' },
        ]} />}
      </Card>
    </>}
    <Card title="审批耗时（自然小时）">
      <Space wrap align="end">
        <label>申请类型<Select aria-label="审批申请类型" allowClear value={approvalType} onChange={(value: ApprovalApplicationType | undefined) => { setApprovalType(value); setApprovalDepartment(undefined); setApprovalTemplate(undefined); }} options={[{ value: 'leave', label: '请假' }, { value: 'travel', label: '出差' }, { value: 'field', label: '外勤' }, { value: 'seal', label: '用印' }, { value: 'general', label: '通用事务' }]} /></label>
        <label>部门<Select aria-label="审批部门" allowClear value={approvalDepartment} onChange={setApprovalDepartment} options={(approvalReport?.options.departments ?? []).map((item) => ({ value: item.id, label: item.name }))} /></label>
        <label>模板<Select aria-label="审批模板" allowClear value={approvalTemplate} onChange={setApprovalTemplate} options={(approvalReport?.options.templates ?? []).map((item) => ({ value: item.id, label: item.name }))} /></label>
        <Button type="primary" loading={approvalLoading} onClick={() => void loadApprovalTiming()}>查询审批耗时</Button>
      </Space>
      {approvalError && <Alert type="error" showIcon message={approvalError} closable onClose={() => setApprovalError(null)} style={{ marginTop: 16 }} />}
      {approvalReport && <Descriptions size="small" column={{ xs: 1, sm: 3 }} style={{ marginTop: 20 }}>
        <Descriptions.Item label="样本数">{approvalReport.sampleCount}</Descriptions.Item>
        <Descriptions.Item label="中位数">{approvalReport.medianHours === null ? '—' : `${approvalReport.medianHours} 小时`}</Descriptions.Item>
        <Descriptions.Item label="P90">{approvalReport.p90Hours === null ? '—' : `${approvalReport.p90Hours} 小时`}</Descriptions.Item>
      </Descriptions>}
      {!approvalReport && !approvalLoading && <Typography.Text type="secondary">仅汇总你有权查看的已完成审批；待审批申请不计入样本。</Typography.Text>}
    </Card>
    <Card title="部门工作量">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap align="center">
          <Button type="primary" loading={departmentLoading} onClick={() => void loadDepartmentWorkload()}>查询部门工作量</Button>
          <Typography.Text type="secondary">仅统计组织可见项目中已分配任务，按任务当前负责人所在部门归集。</Typography.Text>
        </Space>
        {departmentError && <Alert type="error" showIcon message={departmentError} closable onClose={() => setDepartmentError(null)} />}
        {departmentReport && (departmentReport.departments.length === 0 ? <Empty description="当前数据范围内没有部门" /> : <Table<DepartmentWorkloadReport['departments'][number]> rowKey="departmentId" loading={departmentLoading} dataSource={departmentReport.departments} pagination={false} columns={[
          { title: '部门', dataIndex: 'departmentName' },
          { title: '在职成员', dataIndex: 'activeUserCount' },
          { title: '任务数', dataIndex: 'taskCount' },
          { title: '已完成', dataIndex: 'completedTaskCount' },
          { title: '未完成', dataIndex: 'openTaskCount' },
          { title: '已取消', dataIndex: 'cancelledTaskCount' },
          { title: '逾期未完成', dataIndex: 'overdueTaskCount' },
        ]} />)}
      </Space>
    </Card>
    {!report && !loading && <Card><Empty description="选择项目创建日期范围后查询" /></Card>}
  </div>;
}
