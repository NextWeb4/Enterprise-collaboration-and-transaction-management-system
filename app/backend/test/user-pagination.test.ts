import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';
import type { UserDocument } from '../src/modules/core/models.js';
import type { DocumentEnvelope } from '../src/storage/envelope.js';

const directories: string[] = [];
const applications: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  for (const { app } of applications.splice(0)) await app.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('GET /api/v1/users pagination', () => {
  it('returns stable pages and only safe account fields from real LMDB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'collab-user-pagination-'));
    directories.push(directory);
    const config = loadConfig({ ...process.env, DATA_DIR: directory, WEB_ORIGIN: 'http://localhost:5173', HOST: '127.0.0.1', PORT: '3000' });
    const built = await buildApp({ config, logger: false });
    applications.push(built);
    const password = 'UserPaginationAdminPassword42!';
    await built.deps.auth.setupAdmin({ name: '分页管理员', email: 'pagination-admin', password }, { requestId: 'pagination-setup' });
    const passwordHash = await built.deps.auth.createPasswordHash(password);
    const member = await built.deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
    if (!member) throw new Error('missing member seed');
    for (let index = 0; index < 24; index += 1) {
      await built.deps.repos.users.create({
        name: `成员${index.toString().padStart(2, '0')}`,
        email: `pagination-member-${index.toString().padStart(2, '0')}`,
        passwordHash,
        status: 'active',
        mustChangePassword: false,
        lastLoginAt: null,
        passwordChangedAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        roleIds: [member.id],
        departmentId: null,
      } as Omit<UserDocument, keyof DocumentEnvelope>);
    }
    const login = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://localhost:5173' },
      payload: { email: 'pagination-admin', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.split(';')[0])
      .join('; ');

    const first = await built.app.inject({ method: 'GET', url: '/api/v1/users?page=1&pageSize=10', headers: { cookie: cookies } });
    const second = await built.app.inject({ method: 'GET', url: '/api/v1/users?page=2&pageSize=10', headers: { cookie: cookies } });
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    const firstPayload = first.json() as { data: Array<Record<string, unknown>>; meta: { page: number; pageSize: number; total: number } };
    const secondPayload = second.json() as typeof firstPayload;
    expect(firstPayload.meta).toEqual({ page: 1, pageSize: 10, total: 25 });
    expect(secondPayload.meta).toEqual({ page: 2, pageSize: 10, total: 25 });
    expect(firstPayload.data).toHaveLength(10);
    expect(secondPayload.data).toHaveLength(10);
    expect(new Set([...firstPayload.data, ...secondPayload.data].map((user) => user.id)).size).toBe(20);
    expect(Object.keys(firstPayload.data[0] ?? {}).sort()).toEqual(['email', 'id', 'lastLoginAt', 'mustChangePassword', 'name', 'passwordChangedAt', 'status', 'version'].sort());
  });
});
