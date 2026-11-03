import type { LoginRequest, MeResponse, WorkbenchResponse } from '@collab/shared/schemas.js';
import type { DataScope, PermissionDef } from '@collab/shared/permissions.js';

export interface ProblemResponse { code?: string; title?: string; detail?: string; requestId?: string }

export interface HealthResponse {
  ok: boolean;
  status: 'ok' | 'degraded';
  storage: { ok: boolean; schemaVersion: number; writable: boolean };
}

export interface BootstrapRecord {
  id: string;
  type: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  message: string;
  source: string;
}

export interface BootstrapStorageResponse {
  record: BootstrapRecord | null;
  readBack?: BootstrapRecord;
}

function csrfToken(): string | undefined {
  return document.cookie.split('; ').find((item) => item.startsWith('csrf_token='))?.slice('csrf_token='.length);
}

async function requestPayload<T>(url: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (url.startsWith('/api/v1/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const token = csrfToken();
    if (token) headers.set('X-CSRF-Token', token);
  }
  const origin = import.meta.env.DEV ? (import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:3000') : '';
  const response = await fetch(`${origin}${url}`, { ...init, headers, credentials: 'include' });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as ProblemResponse;
    throw new Error(problem.detail ?? problem.title ?? `请求失败 (${response.status})`);
  }
  return await response.json() as T;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  return (await requestPayload<{ data: T }>(url, init)).data;
}

export function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestJson<T>(`/api/v1${path}`, init);
}

export async function apiDownload(path: string): Promise<Blob> {
  const url = `/api/v1${path}`;
  const origin = import.meta.env.DEV ? (import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:3000') : '';
  const response = await fetch(`${origin}${url}`, { credentials: 'include' });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as ProblemResponse;
    throw new Error(problem.detail ?? problem.title ?? `请求失败 (${response.status})`);
  }
  return response.blob();
}

export function apiPage<T>(path: string, init: RequestInit = {}): Promise<PageResponse<T>> {
  return requestPayload<PageResponse<T>>(`/api/v1${path}`, init);
}

export function health(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/api/health');
}

export function readBootstrapStorage(): Promise<BootstrapStorageResponse> {
  return requestJson<BootstrapStorageResponse>('/api/bootstrap/storage');
}

export function writeBootstrapStorage(message: string): Promise<BootstrapStorageResponse> {
  return requestJson<BootstrapStorageResponse>('/api/bootstrap/storage', {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export function login(input: LoginRequest): Promise<MeResponse> {
  return api<MeResponse>('/auth/login', { method: 'POST', body: JSON.stringify(input) });
}

export function setupStatus(): Promise<{ required: boolean }> {
  return api('/setup/status');
}

export function setupAdmin(input: { name: string; email: string; password: string }): Promise<{ success: boolean }> {
  return api('/setup/admin', { method: 'POST', body: JSON.stringify(input) });
}

export function createUser(input: { name: string; email: string; password: string }): Promise<{ user: { id: string; name: string; email: string } }> {
  return api('/users', { method: 'POST', body: JSON.stringify(input) });
}

export function me(): Promise<MeResponse> {
  return api<MeResponse>('/auth/me');
}

export function workbench(): Promise<WorkbenchResponse> {
  return api<WorkbenchResponse>('/workbench');
}

export function logout(): Promise<{ success: boolean }> {
  return api<{ success: boolean }>('/auth/logout', { method: 'POST' });
}

export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<{ success: boolean }> {
  return api<{ success: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify(input) });
}

export interface Project {
  id: string; name: string; key: string; description: string; visibility: 'private' | 'organization';
  status: 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled' | 'archived';
  ownerId: string; taskSeq: number; startDate: string | null; dueDate: string | null; version: number;
}

export interface Task {
  id: string; projectId: string; taskNo: number; taskKey: string; title: string; description: string;
  status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  progress: number; priority: 'low' | 'medium' | 'high' | 'urgent'; assigneeId: string | null; startDate: string | null; dueDate: string | null; createdBy: string; version: number; boardOrder?: number; createdAt?: string;
}

export async function listProjects(): Promise<Project[]> {
  const projects: Project[] = [];
  let page = 1;
  for (;;) {
    const batch = await api<Project[]>(`/projects?page=${page}&pageSize=100`);
    projects.push(...batch);
    if (batch.length < 100) return projects;
    page += 1;
  }
}
export function createProject(input: { name: string; key: string; description?: string; visibility: 'private' | 'organization'; startDate?: string | null; dueDate?: string | null }): Promise<Project> {
  return api('/projects', { method: 'POST', body: JSON.stringify(input) });
}
export function getProject(id: string): Promise<Project> { return api(`/projects/${encodeURIComponent(id)}`); }
export function updateProject(id: string, input: { version: number; name?: string; description?: string; visibility?: Project['visibility']; startDate?: string | null; dueDate?: string | null }): Promise<Project> {
  return api(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}
export function deleteProject(id: string, version: number): Promise<{ success: boolean }> {
  return api(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ version }) });
}
export function transitionProject(id: string, input: { targetStatus: Project['status']; version: number; reason?: string }): Promise<Project> {
  return api(`/projects/${encodeURIComponent(id)}/transition`, { method: 'POST', body: JSON.stringify(input) });
}
export async function listTasks(projectId: string): Promise<Task[]> {
  const tasks: Task[] = [];
  let page = 1;
  for (;;) {
    const batch = await api<Task[]>(`/projects/${encodeURIComponent(projectId)}/tasks?page=${page}&pageSize=100`);
    tasks.push(...batch);
    if (batch.length < 100) return tasks;
    page += 1;
  }
}
export function createTask(projectId: string, input: { title: string; description?: string; priority?: Task['priority']; assigneeId?: string | null; startDate?: string | null; dueDate?: string | null }): Promise<Task> {
  return api(`/projects/${encodeURIComponent(projectId)}/tasks`, { method: 'POST', body: JSON.stringify(input) });
}
export function updateTask(id: string, input: { version: number; title?: string; description?: string; status?: Task['status']; progress?: number; priority?: Task['priority']; assigneeId?: string | null; startDate?: string | null; dueDate?: string | null }): Promise<Task> {
  return api(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}
export function deleteTask(id: string, version: number): Promise<{ success: boolean }> {
  return api(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ version }) });
}
export function moveTask(id: string, input: { version: number; targetStatus: Exclude<Task['status'], 'cancelled'>; targetIndex: number; progress?: number }): Promise<{ task: Task; columns: Partial<Record<Task['status'], Task[]>> }> {
  return api(`/tasks/${encodeURIComponent(id)}/board`, { method: 'PATCH', body: JSON.stringify(input) });
}
export interface TaskComment { id: string; taskId: string; authorId: string; content: string; createdAt: string; editedAt: string | null; removedAt: string | null; version: number }
export async function listTaskComments(taskId: string): Promise<TaskComment[]> {
  const comments: TaskComment[] = [];
  let page = 1;
  for (;;) {
    const batch = await api<TaskComment[]>(`/tasks/${encodeURIComponent(taskId)}/comments?page=${page}&pageSize=100`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
    page += 1;
  }
}
export function createTaskComment(taskId: string, content: string): Promise<TaskComment> { return api(`/tasks/${encodeURIComponent(taskId)}/comments`, { method: 'POST', body: JSON.stringify({ content }) }); }
export function updateTaskComment(id: string, version: number, content: string): Promise<TaskComment> { return api(`/comments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ version, content }) }); }
export function deleteTaskComment(id: string, version: number, reason?: string): Promise<{ success: boolean }> { return api(`/comments/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ version, ...(reason ? { reason } : {}) }) }); }

export interface ProjectMember { userId: string; name: string; role: 'owner' | 'manager' | 'member' | 'viewer'; version: number }
export interface Account { id: string; name: string; email: string; status: 'active' | 'disabled'; version: number }
export interface PageResponse<T> { data: T[]; meta: { page: number; pageSize: number; total: number } }
export function listProjectMembers(id: string): Promise<ProjectMember[]> { return api(`/projects/${encodeURIComponent(id)}/members`); }
export function listAccounts(page = 1, pageSize = 100): Promise<PageResponse<Account>> { return apiPage(`/users?page=${page}&pageSize=${pageSize}`); }
export async function listAllAccounts(): Promise<Account[]> {
  const accounts: Account[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (accounts.length < total) {
    const result = await listAccounts(page, 100);
    accounts.push(...result.data);
    total = result.meta.total;
    if (result.data.length === 0) break;
    page += 1;
  }
  return accounts;
}
export interface Role {
  id: string; code: string; name: string; description: string; dataScope: DataScope;
  permissionCodes: string[]; system: boolean; version: number;
}
export interface EffectivePermissions {
  user: Pick<Account, 'id' | 'name' | 'email' | 'status'>;
  version: number; roleIds: string[]; roles: string[]; permissions: string[];
}
export function listRoles(page = 1, pageSize = 100): Promise<PageResponse<Role>> { return apiPage(`/organization/roles?page=${page}&pageSize=${pageSize}`); }
export async function listAllRoles(): Promise<Role[]> {
  const roles: Role[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (roles.length < total) {
    const result = await listRoles(page, 100);
    roles.push(...result.data);
    total = result.meta.total;
    if (result.data.length === 0) break;
    page += 1;
  }
  return roles;
}
export function listPermissionCatalog(): Promise<PermissionDef[]> { return api('/organization/permissions'); }
export function getEffectivePermissions(userId: string): Promise<EffectivePermissions> { return api(`/organization/users/${encodeURIComponent(userId)}/effective-permissions`); }
export function createRole(input: { code: string; name: string; description: string; dataScope: DataScope; permissionCodes: string[] }): Promise<Role> { return api('/organization/roles', { method: 'POST', body: JSON.stringify(input) }); }
export function updateRole(id: string, input: { version: number; name?: string; description?: string; dataScope?: DataScope; permissionCodes?: string[] }): Promise<Role> { return api(`/organization/roles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }); }
export function deleteRole(id: string, version: number): Promise<{ success: boolean }> { return api(`/organization/roles/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ version }) }); }
export function replaceUserRoles(userId: string, roleIds: string[], version: number): Promise<Account> { return api(`/users/${encodeURIComponent(userId)}/roles`, { method: 'PUT', body: JSON.stringify({ roleIds, version }) }); }
export interface ProjectCompletionMetric {
  projectId: string; projectKey: string; projectName: string; projectStatus: Project['status']; projectCreatedAt: string;
  taskCount: number; completedTaskCount: number; cancelledTaskCount: number; effectiveTaskCount: number; openTaskCount: number; completionRate: number; overdueTaskCount: number; overdueRate: number;
}
export interface OverdueTaskMetric {
  taskId: string; taskKey: string; title: string; dueDate: string; projectId: string; projectKey: string; projectName: string;
}
export interface ProjectCompletionReport {
  generatedAt: string; timezone: string; overdueAsOfLocalDate: string; temporalSemantics: 'current_snapshot_filtered_by_project_creation_time';
  filter: { projectId?: string; createdFrom?: string; createdTo?: string; overduePage: number; overduePageSize: number };
  projects: ProjectCompletionMetric[];
  overdueTasks: OverdueTaskMetric[]; overdueMeta: { page: number; pageSize: number; total: number };
  totals: { projectCount: number; taskCount: number; completedTaskCount: number; cancelledTaskCount: number; effectiveTaskCount: number; openTaskCount: number; completionRate: number; overdueTaskCount: number; overdueRate: number };
}
export function projectCompletionReport(filter: { createdFrom?: string; createdTo?: string; overduePage?: number; overduePageSize?: number } = {}): Promise<ProjectCompletionReport> {
  const query = new URLSearchParams(
    Object.entries(filter)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  ).toString();
  return api(`/analytics/project-completion${query ? `?${query}` : ''}`);
}
export function disableAccount(id: string, version: number): Promise<Pick<Account, 'id' | 'name' | 'email' | 'status'>> { return api(`/users/${encodeURIComponent(id)}/disable`, { method: 'POST', body: JSON.stringify({ version }) }); }
export function addProjectMember(id: string, input: { userId: string; role: 'manager' | 'member' | 'viewer' }): Promise<ProjectMember> {
  return api(`/projects/${encodeURIComponent(id)}/members`, { method: 'POST', body: JSON.stringify(input) });
}
export function removeProjectMember(id: string, member: ProjectMember): Promise<{ success: boolean }> {
  return api(`/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(member.userId)}`, { method: 'DELETE', body: JSON.stringify({ version: member.version }) });
}
export function updateProjectMember(id: string, member: ProjectMember, role: 'manager' | 'member' | 'viewer'): Promise<ProjectMember> {
  return api(`/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(member.userId)}`, { method: 'PATCH', body: JSON.stringify({ role, version: member.version }) });
}
export function transferProjectOwner(id: string, member: ProjectMember, version: number): Promise<Project> {
  return api(`/projects/${encodeURIComponent(id)}/transfer-owner`, { method: 'POST', body: JSON.stringify({ userId: member.userId, version }) });
}

export interface Department { id: string; version: number; name: string; code: string | null; parentId: string | null; managerId: string | null; description: string; sortOrder: number }
export type DepartmentInput = Pick<Department, 'name' | 'code' | 'parentId' | 'managerId' | 'description' | 'sortOrder'>;
export function listDepartments(): Promise<Department[]> { return api('/organization/departments'); }
export function createDepartment(input: DepartmentInput): Promise<Department> { return api('/organization/departments', { method: 'POST', body: JSON.stringify(input) }); }
export function updateDepartment(id: string, input: DepartmentInput & { version: number }): Promise<Department> { return api(`/organization/departments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }); }
