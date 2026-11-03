import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { buildApp } from '../src/server.js';

describe('Bootstrap LMDB', () => {
  it('writes through the API, reads after restart and restricts the development endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-bootstrap-test-'));
    const config = loadConfig({ NODE_ENV: 'development', DATA_DIR: dir, HOST: '127.0.0.1', WEB_ORIGIN: 'http://127.0.0.1:5173' });
    let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined;
    try {
      ({ app } = await buildApp({ config, logger: false }));
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json().data.storage.ok).toBe(true);
      const missingOrigin = await app.inject({ method: 'POST', url: '/api/bootstrap/storage', payload: { message: 'test' } });
      expect(missingOrigin.statusCode).toBe(403);
      const badOrigin = await app.inject({ method: 'POST', url: '/api/bootstrap/storage', headers: { origin: 'http://example.com' }, payload: { message: 'test' } });
      expect(badOrigin.statusCode).toBe(403);
      const written = await app.inject({ method: 'POST', url: '/api/bootstrap/storage', headers: { origin: 'http://127.0.0.1:5173' }, payload: { message: 'isolated persistence test' } });
      expect(written.statusCode).toBe(200);
      expect(written.json().data.readBack).toEqual(written.json().data.record);
      await app.close();
      app = undefined;
      ({ app } = await buildApp({ config, logger: false }));
      const reread = await app.inject({ method: 'GET', url: '/api/bootstrap/storage' });
      expect(reread.json().data.record).toEqual(written.json().data.record);
      await app.close();
      app = undefined;
      ({ app } = await buildApp({ config: { ...config, nodeEnv: 'production', isProduction: true }, logger: false }));
      expect((await app.inject({ method: 'GET', url: '/api/bootstrap/storage' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/bootstrap/storage', payload: {} })).statusCode).toBe(404);
    } finally {
      if (app) await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
