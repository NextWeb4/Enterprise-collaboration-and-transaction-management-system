import { api, apiDownload } from './api';

export type ApprovalApplicationType = 'leave' | 'travel' | 'field' | 'seal' | 'general';
export interface ApprovalTimingDimension { id: string; name: string }
export interface ApprovalTimingFilter { applicationType?: ApprovalApplicationType; departmentId?: string; templateId?: string }
export interface ApprovalTimingReport {
  generatedAt: string;
  filter: ApprovalTimingFilter;
  sampleCount: number;
  medianHours: number | null;
  p90Hours: number | null;
  options: { applicationTypes: ApprovalApplicationType[]; departments: ApprovalTimingDimension[]; templates: ApprovalTimingDimension[] };
}
export function approvalTimingReport(filter: ApprovalTimingFilter = {}): Promise<ApprovalTimingReport> {
  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value)).toString();
  return api(`/analytics/approval-timing${query ? `?${query}` : ''}`);
}

export interface ProjectCompletionExportFilter { createdFrom?: string; createdTo?: string }

export function projectCompletionCsv(filter: ProjectCompletionExportFilter = {}): Promise<Blob> {
  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value)).toString();
  return apiDownload(`/analytics/project-completion/export${query ? `?${query}` : ''}`);
}

export interface DepartmentWorkloadMetric {
  departmentId: string;
  departmentName: string;
  activeUserCount: number;
  taskCount: number;
  completedTaskCount: number;
  cancelledTaskCount: number;
  openTaskCount: number;
  overdueTaskCount: number;
}

export interface DepartmentWorkloadReport {
  generatedAt: string;
  timezone: string;
  overdueAsOfLocalDate: string;
  filter: { departmentId?: string };
  departments: DepartmentWorkloadMetric[];
}

export function departmentWorkloadReport(departmentId?: string): Promise<DepartmentWorkloadReport> {
  const query = departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : '';
  return api(`/analytics/department-workload${query}`);
}
