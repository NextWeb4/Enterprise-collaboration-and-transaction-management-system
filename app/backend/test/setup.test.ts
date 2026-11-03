import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';

describe('web initialization and managed accounts', () => {
  it('allows one local setup, enforces origins and authorization, then creates an account with an initial password', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-web-setup-'));
    const config = loadConfig({ NODE_ENV: 'development', DATA_DIR: dir, HOST: '127.0.0.1', PORT: '3309', WEB_ORIGIN: 'http://127.0.0.1:5173' });
    const { app, deps } = await buildApp({ config, logger: false });
    const host = '127.0.0.1:3309';
    const headers = { host, origin: config.webOrigin };
    const payload = { name: '管理员', email: 'admin.one', password: 'StrongSetupPassword42!' };
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/setup/status', headers: { host } })).json().data.required).toBe(true);
      expect((await app.inject({ method: 'GET', url: '/api/v1/setup/status', headers: { host }, remoteAddress: '::ffff:127.0.0.1' })).json().data.required).toBe(true);
      expect((await app.inject({ method: 'POST', url: '/api/v1/setup/admin', headers: { host }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/setup/admin', headers: { host, origin: 'http://evil.example' }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/setup/admin', headers: { host: 'evil.example', origin: config.webOrigin }, payload })).statusCode).toBe(403);
      const results = await Promise.all(['admin.one', 'admin.two'].map((email) => app.inject({ method: 'POST', url: '/api/v1/setup/admin', headers, payload: { ...payload, email } })));
      expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
      const winner = results[0]?.statusCode === 201 ? 'admin.one' : 'admin.two';
      expect(await deps.repos.users.countAll()).toBe(1);
      expect((await app.inject({ method: 'GET', url: '/api/v1/setup/status', headers: { host } })).json().data.required).toBe(false);
      expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers, payload: { name: '成员', email: 'member.one', password: 'MemberPasswordStrong42!' } })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: winner, password: payload.password } });
      expect(login.statusCode).toBe(200);
      const cookies = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
      const csrf = login.json().data.csrfToken as string;
      const userHeaders = { ...headers, cookie: cookies, 'x-csrf-token': csrf };
      const created = await app.inject({ method: 'POST', url: '/api/v1/users', headers: userHeaders, payload: { name: '成员', email: 'member.one', password: 'MemberPasswordStrong42!' } });
      expect(created.statusCode).toBe(201);
      expect(created.body).not.toContain('MemberPasswordStrong42!');
      expect(created.json().data.user.mustChangePassword).toBe(true);
      expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: userHeaders, payload: { name: '成员', email: 'member.two', password: '123456789012' } })).statusCode).toBe(422);
      expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: userHeaders, payload: { name: '成员', email: 'MEMBER.ONE', password: 'MemberPasswordStrong42!' } })).statusCode).toBe(409);
      const memberLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { email: 'member.one', password: 'MemberPasswordStrong42!' } });
      expect(memberLogin.statusCode).toBe(200);
      expect(memberLogin.json().data.user.mustChangePassword).toBe(true);
      const memberCookies = memberLogin.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
      const memberCsrf = memberLogin.json().data.csrfToken as string;
      const memberHeaders = { ...headers, cookie: memberCookies, 'x-csrf-token': memberCsrf };
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: memberHeaders, payload: { currentPassword: 'MemberPasswordStrong42!', newPassword: 'MemberNewPasswordStrong42!' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/v1/users', headers: memberHeaders, payload: { name: '越权', email: 'forbidden.user', password: 'MemberPasswordStrong42!' } })).statusCode).toBe(403);
      const users = (await deps.repos.users.list({ page: 1, pageSize: 10 })).items;
      for (const user of users) await deps.repos.users.softDelete(user.id, user.version);
      expect((await app.inject({ method: 'GET', url: '/api/v1/setup/status', headers: { host } })).json().data.required).toBe(false);
      await expect(deps.auth.setupAdmin(payload, {})).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect((await app.inject({ method: 'POST', url: '/api/v1/setup/admin', headers, payload })).statusCode).toBe(429);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
