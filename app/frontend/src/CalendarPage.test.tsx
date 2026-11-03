import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@collab/shared/schemas.js';
import { CalendarPage } from './CalendarPage';
import { createCalendarEvent, listCalendarEvents, listCalendarParticipants } from './calendar-api';
import { listProjects } from './api';
import type { CalendarEvent } from './calendar-api';

vi.mock('./calendar-api', () => ({ createCalendarEvent: vi.fn(), deleteCalendarEvent: vi.fn(), listCalendarEvents: vi.fn(), listCalendarParticipants: vi.fn(), respondCalendarEvent: vi.fn(), updateCalendarEvent: vi.fn() }));
vi.mock('./api', () => ({ listProjects: vi.fn() }));

const identity: MeResponse = { user: { id: 'owner', name: '负责人', email: 'owner', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null }, organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: ['org_admin'], permissions: ['calendar:read', 'calendar:create', 'calendar:update', 'calendar:delete', 'calendar:invite', 'calendar:respond', 'project:read', 'organization:directory:read'], csrfToken: 'csrf' };
const currentParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
const currentDay = ['year', 'month', 'day'].map((type) => currentParts.find((part) => part.type === type)?.value).join('-');
const eventStart = new Date(`${currentDay}T03:00:00.000Z`).toISOString();
const event: CalendarEvent = { id: '1b35d4ae-77c5-4a6f-9164-6d6bc84b21cd', version: 1, ownerId: 'owner', projectId: null, kind: 'personal', title: '季度计划', description: '', location: '', startAt: eventStart, endAt: new Date(Date.parse(eventStart) + 3_600_000).toISOString(), reminderMinutes: 15, participants: [], createdAt: eventStart };
const originalMatchMedia = window.matchMedia;
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) }); });
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });

beforeEach(() => {
  vi.mocked(listCalendarEvents).mockResolvedValue({ data: [event], conflicts: [], timezone: 'Asia/Shanghai' });
  vi.mocked(listCalendarParticipants).mockResolvedValue([]);
  vi.mocked(listProjects).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('CalendarPage', () => {
  it('loads calendar in organization timezone and offers month/week views', async () => {
    render(<CalendarPage identity={identity} />);
    expect(await screen.findByText(/季度计划/)).toBeTruthy();
    expect(screen.getByText(/当前没有后台调度器/)).toBeTruthy();
    await userEvent.setup().click(screen.getByText('周'));
    expect(await screen.findByText('周')).toBeTruthy();
    expect(listCalendarEvents).toHaveBeenCalled();
  });

  it('creates a calendar item and reloads the range', async () => {
    vi.mocked(createCalendarEvent).mockResolvedValue({ data: event, conflicts: [] });
    const user = userEvent.setup();
    render(<CalendarPage identity={identity} />);
    await screen.findByText(/季度计划/);
    await user.click(screen.getByRole('button', { name: '新建日程' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: '新会谈' } });
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ title: '新会谈', kind: 'personal', projectId: null, startAt: expect.any(String), endAt: expect.any(String) })));
    await waitFor(() => expect(listCalendarEvents).toHaveBeenCalledTimes(2));
  });

  it('shows a usable retry state on load failure and denies missing calendar permission', async () => {
    vi.mocked(listCalendarEvents).mockRejectedValueOnce(new Error('网络暂不可用'));
    const { rerender } = render(<CalendarPage identity={identity} />);
    expect(await screen.findByText('网络暂不可用')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
    rerender(<CalendarPage identity={{ ...identity, permissions: [] }} />);
    expect(screen.getByText('没有日历读取权限')).toBeTruthy();
  });
});
