import type { WorkbenchActivity, WorkbenchTask, NotificationView } from '@collab/shared/schemas.js';
import { api, apiPage, type PageResponse } from './api';
export function getActivity(): Promise<WorkbenchActivity> {
  return api('/workbench/activity');
}
export function getMyTasks(page: number, overdue: boolean): Promise<PageResponse<WorkbenchTask>> {
  return apiPage(`/workbench/tasks?page=${page}&pageSize=20&overdue=${overdue}`);
}
export function getNotifications(
  page: number,
  unread: boolean,
): Promise<PageResponse<NotificationView>> {
  return apiPage(`/notifications?page=${page}&pageSize=20&unread=${unread}`);
}
export function markNotificationRead(id: string, version: number): Promise<{ success: boolean }> {
  return api(`/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({ version }) });
}
export function markAllNotificationsRead(): Promise<{ success: boolean }> {
  return api('/notifications/read-all', { method: 'POST', body: '{}' });
}
export function recordProjectVisit(id: string): Promise<{ success: boolean }> {
  return api(`/projects/${id}/visit`, { method: 'POST', body: '{}' });
}
