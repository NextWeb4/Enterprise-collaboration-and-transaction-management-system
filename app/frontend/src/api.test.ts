import { afterEach, describe, expect, it, vi } from 'vitest';
import { listAllAccounts, login } from './api';

const jsonResponse = (payload: unknown): Response => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('frontend API contract', () => {
  it('unwraps the shared {data} response and sends credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { user: { id: 'u' } } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await login({ email: 'admin@example.com', password: 'password' });
    expect(result).toEqual({ user: { id: 'u' } });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3000/api/v1/auth/login', expect.objectContaining({ credentials: 'include' }));
  });

  it('loads accounts beyond the first page using response metadata', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `user-${index}`, name: `用户${index}`, email: `member-${index}`, status: 'active' as const, version: 1 }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: firstPage, meta: { page: 1, pageSize: 100, total: 101 } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'user-last', name: '最后一位', email: 'member-last', status: 'active', version: 1 }], meta: { page: 2, pageSize: 100, total: 101 } }));
    vi.stubGlobal('fetch', fetchMock);
    const accounts = await listAllAccounts();
    expect(accounts).toHaveLength(101);
    expect(accounts.at(-1)?.id).toBe('user-last');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3000/api/v1/users?page=1&pageSize=100',
      'http://127.0.0.1:3000/api/v1/users?page=2&pageSize=100',
    ]);
    vi.unstubAllGlobals();
  });
});
