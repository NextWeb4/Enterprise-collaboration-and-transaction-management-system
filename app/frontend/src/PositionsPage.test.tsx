import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@collab/shared/schemas.js';
import { PositionsPage } from './PositionsPage';
import { createPosition, listPositions } from './organization-directory-api';

vi.mock('./organization-directory-api', () => ({ createPosition: vi.fn(), deletePosition: vi.fn(), listPositions: vi.fn(), updatePosition: vi.fn() }));
const identity: MeResponse = { user: { id: 'admin', name: '管理员', email: 'admin', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null }, organization: { name: '测试组织', timezone: 'Asia/Shanghai' }, roles: [], permissions: ['position:read', 'position:manage'], csrfToken: 'csrf' };
const originalMatchMedia = window.matchMedia;
beforeAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string): MediaQueryList => ({ matches: false, media, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) }); });
afterAll(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia }); });
beforeEach(() => { vi.mocked(listPositions).mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('岗位管理', () => {
  it('无读取权限时不请求岗位列表', () => {
    render(<PositionsPage identity={{ ...identity, permissions: [] }} />);
    expect(screen.getByText('没有查看岗位的权限')).toBeTruthy(); expect(listPositions).not.toHaveBeenCalled();
  });

  it('创建岗位后失效查询并重新读取列表', async () => {
    vi.mocked(listPositions).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'position-1', version: 1, name: '工程师', code: 'ENG', description: '', sortOrder: 0, status: 'active' }]);
    vi.mocked(createPosition).mockResolvedValue({ id: 'position-1', version: 1, name: '工程师', code: 'ENG', description: '', sortOrder: 0, status: 'active' });
    const user = userEvent.setup(); render(<PositionsPage identity={identity} />); await screen.findByText('暂无岗位'); await user.click(screen.getByRole('button', { name: '新建岗位' })); const modal = await screen.findByRole('dialog');
    await user.type(within(modal).getByLabelText('岗位名称'), '工程师'); await user.type(within(modal).getByLabelText('岗位编码'), 'ENG'); await user.click(within(modal).getByRole('button', { name: /OK/ }));
    await waitFor(() => expect(createPosition).toHaveBeenCalledWith({ name: '工程师', code: 'ENG', description: '', sortOrder: 0, status: 'active' })); expect(await screen.findByText('工程师')).toBeTruthy();
  });
});
