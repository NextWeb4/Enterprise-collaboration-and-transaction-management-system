import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';

describe('department endpoints', () => {
  it('authenticates, validates and protects department mutations with audit and transaction guards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-department-api-'));
    const config = loadConfig({ NODE_ENV: 'development', DATA_DIR: dir, HOST: '127.0.0.1', PORT: '3310', WEB_ORIGIN: 'http://127.0.0.1:5173' });
    const { app, deps } = await buildApp({ config, logger: false });
    const base = { host: '127.0.0.1:3310', origin: config.webOrigin };
    const fields = { name: '研发部', parentId: null, code: 'DEV', managerId: null, description: '', sortOrder: 0 };
    try {
      expect((await app.inject({ method: 'POST', url: '/api/v1/setup/admin', headers: base, payload: { name: '管理员', email: 'admin.test', password: 'AdminPasswordStrong42!' } })).statusCode).toBe(201);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: base, payload: { email: 'admin.test', password: 'AdminPasswordStrong42!' } });
      expect(login.statusCode).toBe(200);
      const headers = { ...base, cookie: login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '), 'x-csrf-token': login.json().data.csrfToken as string };
      expect((await app.inject({ method: 'GET', url: '/api/v1/organization/departments', headers: base })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/v1/organization/departments', headers: { ...base, cookie: headers.cookie }, payload: fields })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/organization/departments', headers, payload: { ...fields, name: '' } })).statusCode).toBe(422);
      for (const invalid of [{ ...fields, name: ' \t ' }, { ...fields, name: '研发\n部' }, { ...fields, sortOrder: -1 }, { ...fields, unexpected: true }]) {
        expect((await app.inject({ method: 'POST', url: '/api/v1/organization/departments', headers, payload: invalid })).statusCode).toBe(422);
      }
      const created = await app.inject({ method: 'POST', url: '/api/v1/organization/departments', headers, payload: fields });
      expect(created.statusCode, created.body).toBe(201);
      const root = created.json().data as { id: string; version: number; name: string };
      expect(root.name).toBe(fields.name);
      expect((await app.inject({ method: 'POST', url: '/api/v1/organization/departments', headers, payload: fields })).statusCode).toBe(409);
      const childResult = await app.inject({ method: 'POST', url: '/api/v1/organization/departments', headers, payload: { ...fields, parentId: root.id, name: '平台组', code: null } });
      expect(childResult.statusCode).toBe(201);
      const child = childResult.json().data as { id: string };
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/organization/departments/${root.id}`, headers, payload: { ...fields, parentId: child.id, version: root.version } })).statusCode).toBe(422);
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/organization/departments/${root.id}`, headers, payload: { ...fields, version: 99 } })).statusCode).toBe(409);
      const updated = await app.inject({ method: 'PATCH', url: `/api/v1/organization/departments/${root.id}`, headers, payload: { ...fields, name: '产品研发部', version: root.version } });
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json().data.version).toBe(root.version + 1);
      const list = await app.inject({ method: 'GET', url: '/api/v1/organization/departments', headers });
      expect(list.statusCode).toBe(200);
      expect(list.json().data).toHaveLength(2);
      expect(await deps.audit.verifyChain()).toBe(true);
      const role = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
      if (!role) throw new Error('missing org_admin');
      await deps.repos.roles.update(role.id, role.version, (current) => ({ ...current, dataScope: 'department' }));
      expect((await app.inject({ method: 'GET', url: '/api/v1/organization/departments', headers })).statusCode).toBe(403);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
