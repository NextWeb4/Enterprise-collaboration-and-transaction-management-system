import type { ApplicationDraftRequest } from '@collab/shared/schemas.js';
import { api, apiPage, type PageResponse } from './api';

export type ApplicationType = ApplicationDraftRequest['applicationType'];
export type ApplicationStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'withdrawn';
export interface ApplicationSummary {
  id: string;
  version: number;
  applicationNo: string | null;
  applicationType: ApplicationType;
  title: string;
  applicantId: string;
  applicantName: string;
  departmentId: string | null;
  departmentName: string | null;
  status: ApplicationStatus;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  redacted: boolean;
}
export interface Attachment {
  id: string;
  fileName: string;
  mime: string;
  size: number;
  sha256: string;
}
export interface ApprovalHistory {
  submittedAt: string | null;
  steps: Array<{
    id: string;
    stepNo: number;
    name: string;
    status: 'waiting' | 'active' | 'approved' | 'rejected' | 'cancelled';
    approverId: string | null;
    approverName: string | null;
  }>;
  records: Array<{
    id: string;
    stepId: string;
    action: 'approve' | 'reject' | 'withdraw' | 'reassign';
    operatorId: string;
    operatorName: string;
    createdAt: string;
    comment: string | null;
    fromApproverName: string | null;
    toApproverName: string | null;
  }>;
}
export interface ApplicationDetail extends ApplicationSummary {
  formSchemaVersion: number;
  formData: Record<string, unknown> | null;
  startAt: string | null;
  endAt: string | null;
  projectId: string | null;
  attachments: Attachment[];
  history: ApprovalHistory;
  actions: {
    edit: boolean;
    submit: boolean;
    withdraw: boolean;
    approve: boolean;
    reassign: boolean;
    copy: boolean;
  };
}
export interface TemplateStep {
  stepNo: number;
  name: string;
  approverType: 'user' | 'department_manager' | 'direct_manager';
  userId: string | null;
}
export interface WorkflowTemplate {
  id: string;
  name: string;
  applicationType: ApplicationType;
  version: number;
  status: 'draft' | 'active' | 'inactive';
  lastVersionNo: number;
  activeVersionId: string | null;
  draftSteps: TemplateStep[];
}
export interface TemplateVersion {
  id: string;
  versionNo: number;
  steps: TemplateStep[];
  publishedAt: string;
}
export interface ApprovalUser {
  userId: string;
  name: string;
}
export type TemplateInput = Pick<WorkflowTemplate, 'name' | 'applicationType' | 'draftSteps'>;
const path = (id: string): string => `/applications/${encodeURIComponent(id)}`;
export function listApplications(query: {
  page: number;
  pageSize: number;
  view: string;
  status?: ApplicationStatus;
  applicationType?: ApplicationType;
  q?: string;
}): Promise<PageResponse<ApplicationSummary>> {
  const search = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  );
  return apiPage(`/applications?${search}`);
}
export function getApplication(id: string): Promise<ApplicationDetail> {
  return api(path(id));
}
export function createApplication(
  input: ApplicationDraftRequest,
): Promise<{ id: string; version: number }> {
  return api('/applications', { method: 'POST', body: JSON.stringify(input) });
}
export function updateApplication(
  id: string,
  version: number,
  input: ApplicationDraftRequest,
): Promise<{ id: string; version: number }> {
  return api(path(id), { method: 'PATCH', body: JSON.stringify({ ...input, version }) });
}
export function removeApplication(id: string, version: number): Promise<unknown> {
  return api(path(id), { method: 'DELETE', body: JSON.stringify({ version }) });
}
export function copyApplication(id: string): Promise<{ id: string }> {
  return api(`${path(id)}/copy`, { method: 'POST' });
}
export function submitApplication(id: string, key: string): Promise<unknown> {
  return api(`${path(id)}/submit`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: '{}',
  });
}
export function actOnApplication(
  id: string,
  action: 'approve' | 'reject' | 'withdraw' | 'reassign',
  version: number,
  comment: string,
  newApproverId?: string,
): Promise<unknown> {
  return api(`${path(id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify(
      action === 'reassign'
        ? { version, reason: comment, newApproverId }
        : action === 'withdraw'
          ? { version, reason: comment }
          : { version, comment },
    ),
  });
}
export function attachApplicationFile(
  id: string,
  version: number,
  file: File,
): Promise<Attachment> {
  const body = new FormData();
  body.append('file', file);
  return api(`${path(id)}/attachments?version=${version}`, { method: 'POST', body });
}
export function removeApplicationFile(
  id: string,
  version: number,
  attachmentId: string,
): Promise<unknown> {
  return api(`${path(id)}/attachments/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ version }),
  });
}
export function attachmentDownloadUrl(id: string, attachmentId: string): string {
  const origin = import.meta.env.DEV
    ? (import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:3000')
    : '';
  return `${origin}/api/v1${path(id)}/attachments/${encodeURIComponent(attachmentId)}/download`;
}
export function listTemplates(): Promise<WorkflowTemplate[]> {
  return api('/workflow/templates');
}
export function listTemplateVersions(id: string): Promise<TemplateVersion[]> {
  return api(`/workflow/templates/${encodeURIComponent(id)}/versions`);
}
export function saveTemplate(
  input: TemplateInput,
  existing?: WorkflowTemplate,
): Promise<WorkflowTemplate> {
  return api(`/workflow/templates${existing ? `/${encodeURIComponent(existing.id)}` : ''}`, {
    method: existing ? 'PATCH' : 'POST',
    body: JSON.stringify({
      name: input.name,
      applicationType: input.applicationType,
      steps: input.draftSteps,
      ...(existing ? { version: existing.version } : {}),
    }),
  });
}
export function templateAction(
  template: WorkflowTemplate,
  action: 'publish' | 'deactivate',
): Promise<unknown> {
  return api(`/workflow/templates/${encodeURIComponent(template.id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ version: template.version }),
  });
}
export function initializeTemplates(): Promise<WorkflowTemplate[]> {
  return api('/workflow/templates/defaults', { method: 'POST', body: '{}' });
}
export function listApprovalUsers(): Promise<ApprovalUser[]> {
  return api('/organization/active-users');
}
