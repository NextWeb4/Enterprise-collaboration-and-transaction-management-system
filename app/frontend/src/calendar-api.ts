import { api } from './api';

export type CalendarKind = 'personal' | 'milestone' | 'meeting';
export type CalendarResponse = 'pending' | 'accepted' | 'declined' | 'tentative';
export interface CalendarParticipant { userId: string; response: CalendarResponse; respondedAt: string | null }
export interface CalendarEvent {
  id: string; version: number; ownerId: string; projectId: string | null; kind: CalendarKind;
  title: string; description: string; location: string; startAt: string; endAt: string;
  reminderMinutes: 5 | 15 | 30 | 60 | null; participants: CalendarParticipant[]; createdAt: string;
}
export interface CalendarConflict { userId: string; startAt: string; endAt: string }
export interface CalendarRange { from: string; to: string; projectId?: string }
export interface CalendarInput {
  kind: CalendarKind; projectId: string | null; title: string; description: string; location: string;
  startAt: string; endAt: string; reminderMinutes: 5 | 15 | 30 | 60 | null; participantIds: string[];
}
export interface CalendarMutationResult { data: CalendarEvent; conflicts: CalendarConflict[] }

export function listCalendarEvents(range: CalendarRange): Promise<{ data: CalendarEvent[]; conflicts: CalendarConflict[]; timezone: string }> {
  const query = new URLSearchParams({ from: range.from, to: range.to });
  if (range.projectId) query.set('projectId', range.projectId);
  return api(`/calendar/events?${query.toString()}`);
}
export function listCalendarParticipants(search = ''): Promise<Array<{ id: string; name: string }>> {
  return api(`/calendar/participants?${new URLSearchParams({ search }).toString()}`);
}
export function getCalendarEvent(id: string): Promise<CalendarEvent> {
  return api(`/calendar/events/${encodeURIComponent(id)}`);
}
export function createCalendarEvent(input: CalendarInput): Promise<CalendarMutationResult> {
  return api('/calendar/events', { method: 'POST', body: JSON.stringify(input) });
}
export function updateCalendarEvent(id: string, version: number, input: CalendarInput): Promise<CalendarMutationResult> {
  return api(`/calendar/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...input, version }) });
}
export function deleteCalendarEvent(id: string, version: number): Promise<{ success: boolean }> {
  return api(`/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ version }) });
}
export function respondCalendarEvent(id: string, version: number, response: Exclude<CalendarResponse, 'pending'>): Promise<CalendarEvent> {
  return api(`/calendar/events/${encodeURIComponent(id)}/response`, { method: 'POST', body: JSON.stringify({ version, response }) });
}
