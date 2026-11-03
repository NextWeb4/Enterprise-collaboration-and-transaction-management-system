import { api, apiPage, type PageResponse } from './api';

export interface SystemSettings { id: string; version: number; displayName: string; timezone: string; workflowAllowSelfApproval: false; }
export interface LoginRecord { id: string; userId: string | null; email: string; success: boolean; reason: string | null; ip: string | null; userAgent: string | null; createdAt: string; }
export interface OperationLog { id: string; seq: number | null; actorUserId: string | null; actorName: string | null; action: string; resourceType: string; resourceId: string | null; result: 'success' | 'failure'; ip: string | null; userAgent: string | null; requestId: string | null; metadata: Record<string, string | number | boolean | null>; createdAt: string; }

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value)); const text = params.toString(); return text === '' ? '' : `?${text}`;
}
export function getSystemSettings(): Promise<SystemSettings> { return api('/system/settings'); }
export function updateSystemSettings(input: Pick<SystemSettings, 'version' | 'displayName' | 'timezone'>): Promise<SystemSettings> { return api('/system/settings', { method: 'PATCH', body: JSON.stringify(input) }); }
export function listLoginRecords(filters: { page: number; pageSize: number; email?: string; result?: 'success' | 'failure'; ip?: string; from?: string; to?: string }): Promise<PageResponse<LoginRecord>> { return apiPage(`/system/login-records${query(filters)}`); }
export function listOperationLogs(filters: { page: number; pageSize: number; actorUserId?: string; action?: string; resourceType?: string; result?: 'success' | 'failure'; requestId?: string; from?: string; to?: string }): Promise<PageResponse<OperationLog>> { return apiPage(`/system/operation-logs${query(filters)}`); }
