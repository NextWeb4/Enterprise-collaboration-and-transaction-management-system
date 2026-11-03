import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, afterEach } from 'vitest';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import type { RoleDocument, UserDocument } from '../src/modules/core/models.js';
import type { DocumentEnvelope } from '../src/storage/envelope.js';
import { AuditService } from '../src/modules/core/audit-service.js';
import { FileService, type UploadInput } from '../src/modules/core/file-service.js';
import { buildApp } from '../src/server.js';
import { SingleInstanceLock } from '../src/runtime/single-instance.js';
import { UnitOfWork } from '../src/storage/unit-of-work.js';
import { FakeClock } from '../src/shared/clock.js';
import { loadConfig } from '../src/config/env.js';
import { createUserRequestSchema, loginRequestSchema } from '@collab/shared/schemas.js';

const paths: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

describe('M0 configuration', () => {
  it('uses canonical local production origin and the Vite development origin by default', () => {
    expect(loadConfig({ NODE_ENV: 'production', DATA_DIR: './data' }).webOrigin).toBe('http://127.0.0.1:3000');
    expect(loadConfig({ NODE_ENV: 'development', DATA_DIR: './data' }).webOrigin).toBe('http://127.0.0.1:5173');
  });
  it('accepts normalized internal accounts and keeps legacy identifiers available for login', () => {
    expect(createUserRequestSchema.parse({ name: '测试', email: '  Test.User-1  ' }).email).toBe('test.user-1');
    expect(createUserRequestSchema.safeParse({ name: '测试', email: 'old@example.test' }).success).toBe(false);
    expect(createUserRequestSchema.safeParse({ name: '测试', email: '-invalid' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: 'old@example.test', password: 'x' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ email: 'internal.user', password: 'x' }).success).toBe(true);
  });
});

async function makeEngine(): Promise<{ engine: LmdbStorageEngine; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-office-test-'));
  paths.push(dir);
  const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
  await engine.open();
  cleanups.push(() => engine.close());
  return { engine, dir };
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const path of paths.splice(0)) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, '测试资源清理失败');
});

describe('LMDB storage foundation', () => {
  it('enforces unique indexes and removes stale unique keys on soft delete', async () => {
    const { engine } = await makeEngine();
    const repos = createCoreRepositories(engine);
    const input = { name: 'A', email: 'a@example.com', passwordHash: 'argon2id-hash-value-123456', status: 'active' as const, mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [], departmentId: null };
    const user = await repos.users.create(input as Omit<UserDocument, keyof DocumentEnvelope>);
    await expect(repos.users.create(input as Omit<UserDocument, keyof DocumentEnvelope>)).rejects.toMatchObject({ code: 'USER_EMAIL_TAKEN' });
    await repos.users.softDelete(user.id, user.version);
    expect(await repos.users.getByUniqueIndex('idx_users_email', input.email)).toBeUndefined();
    await repos.users.create(input as Omit<UserDocument, keyof DocumentEnvelope>);
    await engine.close();
  });

  it('does not remove a reused unique key when an old soft-deleted document is physically removed', async () => {
    const { engine } = await makeEngine();
    const repos = createCoreRepositories(engine);
    const input = { name: 'A', email: 'reused@example.com', passwordHash: 'argon2id-hash-value-123456', status: 'active' as const, mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [], departmentId: null };
    const oldUser = await repos.users.create(input as Omit<UserDocument, keyof DocumentEnvelope>);
    await repos.users.softDelete(oldUser.id, oldUser.version);
    const newUser = await repos.users.create(input as Omit<UserDocument, keyof DocumentEnvelope>);
    await repos.users.remove(oldUser.id);
    expect((await repos.users.getByUniqueIndex('idx_users_email', input.email))?.id).toBe(newUser.id);
    await expect(repos.users.create(input as Omit<UserDocument, keyof DocumentEnvelope>)).rejects.toMatchObject({ code: 'USER_EMAIL_TAKEN' });
    await engine.close();
  });

  it('rolls back a failed transaction and serializes concurrent writes', async () => {
    const { engine } = await makeEngine();
    await expect(engine.transaction((tx) => { tx.put('counters', 'n', 1); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await engine.transaction((tx) => tx.get<number>('counters', 'n'))).toBeUndefined();
    await engine.transaction((tx) => tx.put('counters', 'n', 0));
    await Promise.all(Array.from({ length: 100 }, () => engine.transaction((tx) => { const value = tx.get<number>('counters', 'n') ?? 0; tx.put('counters', 'n', value + 1); })));
    expect(await engine.transaction((tx) => tx.get<number>('counters', 'n'))).toBe(100);
    await engine.close();
  });

  it('rolls back business documents and audit records together through one unit of work', async () => {
    const { engine } = await makeEngine();
    const repos = createCoreRepositories(engine);
    const uow = new UnitOfWork(engine);
    const audit = new AuditService(repos, uow);
    await expect(uow.run(async (tx) => {
      const user = await repos.users.create({ name: '事务回滚', email: 'rollback@example.com', passwordHash: 'argon2id-hash-value-123456', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>, tx);
      await audit.append({ actorUserId: null, action: 'test.rollback', resourceType: 'user', resourceId: user.id }, tx);
      throw new Error('abort business operation');
    })).rejects.toThrow('abort business operation');
    expect((await repos.users.list({ page: 1, pageSize: 10 })).total).toBe(0);
    expect((await repos.auditLogs.list({ page: 1, pageSize: 10 })).total).toBe(0);
    await engine.close();
  });

  it('rebuilds a damaged unique index with the maintenance CLI', async () => {
    const { engine, dir } = await makeEngine();
    const repos = createCoreRepositories(engine);
    const user = await repos.users.create({ name: '索引重建', email: 'rebuild@example.com', passwordHash: 'argon2id-hash-value-123456', status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    await engine.transaction((tx) => tx.remove('idx_users_email', user.email));
    expect(await repos.users.getByUniqueIndex('idx_users_email', user.email)).toBeUndefined();
    await engine.close();

    const rebuilt = spawnSync(process.execPath, ['--import', 'tsx', 'app/backend/src/cli/rebuild-indexes.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(rebuilt.error?.message, rebuilt.stderr).toBeUndefined();
    expect(rebuilt.status, rebuilt.stderr).toBe(0);

    const reopened = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
    await reopened.open();
    cleanups.push(() => reopened.close());
    const rebuiltRepos = createCoreRepositories(reopened);
    expect((await rebuiltRepos.users.getByUniqueIndex('idx_users_email', user.email))?.id).toBe(user.id);
    await reopened.close();
  });

  it('bootstraps only the first administrator in an initialized data directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-bootstrap-'));
    paths.push(dir);
    const run = (account: string): SpawnSyncReturns<string> => spawnSync(process.execPath, ['--import', 'tsx', 'app/backend/src/cli/bootstrap-admin.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dir, BOOTSTRAP_ADMIN_ACCOUNT: account, BOOTSTRAP_ADMIN_PASSWORD: 'SafeBootstrapPass2026!', BOOTSTRAP_ADMIN_NAME: '首个管理员' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const first = run('First-Admin');
    expect(first.error?.message, first.stderr).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);
    const second = run('second-admin');
    expect(second.error?.message, second.stderr).toBeUndefined();
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('拒绝重复初始化首个管理员');
    const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
    await engine.open();
    cleanups.push(() => engine.close());
    const repos = createCoreRepositories(engine);
    expect((await repos.users.list({ page: 1, pageSize: 10 })).items.map((user) => user.email)).toEqual(['first-admin']);
    await engine.close();
    const config = loadConfig({ NODE_ENV: 'development', DATA_DIR: dir, WEB_ORIGIN: 'http://127.0.0.1:5173' });
    const { app } = await buildApp({ config, logger: false });
    cleanups.push(() => app.close());
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.webOrigin }, payload: { email: 'FIRST-ADMIN', password: 'SafeBootstrapPass2026!' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().data.user.email).toBe('first-admin');
  });

  it('recovers committed data after an abrupt process exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-crash-'));
    paths.push(dir);
    const storagePath = join(dir, 'store', 'lmdb');
    const childScript = `import { LmdbStorageEngine } from './app/backend/src/storage/engine.ts';\nconst engine = new LmdbStorageEngine({ path: process.env.LMDB_TEST_PATH });\nawait engine.open();\nawait engine.transaction((tx) => tx.put('counters', 'durable', 42));\nprocess.exit(0);`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      env: { ...process.env, LMDB_TEST_PATH: storagePath },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(child.error?.message, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const engine = new LmdbStorageEngine({ path: storagePath });
    await engine.open();
    cleanups.push(() => engine.close());
    expect(await engine.transaction((tx) => tx.get<number>('counters', 'durable'))).toBe(42);
    await engine.close();
  });

  it('keeps repeated task-audit-counter commits consistent when killed mid-transaction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-kill-tx-'));
    paths.push(dir);
    const storagePath = join(dir, 'store', 'lmdb');
    const childScript = `import { LmdbStorageEngine } from './app/backend/src/storage/engine.ts';
import { createCoreRepositories } from './app/backend/src/modules/core/repositories.ts';
import { AuditService } from './app/backend/src/modules/core/audit-service.ts';
import { UnitOfWork } from './app/backend/src/storage/unit-of-work.ts';
const engine = new LmdbStorageEngine({ path: process.env.LMDB_TEST_PATH });
await engine.open();
const repos = createCoreRepositories(engine);
const uow = new UnitOfWork(engine);
const audit = new AuditService(repos, uow);
for (let sequence = 1; sequence <= 50; sequence += 1) {
  await uow.run(async (tx) => {
    const taskId = 'task-' + String(sequence).padStart(4, '0');
    tx.put('tasks', taskId, { id: taskId, sequence });
    tx.put('counters', 'taskCount', sequence);
    await audit.append({ actorUserId: null, action: 'test.task-written', resourceType: 'task', resourceId: taskId }, tx);
  });
  process.stdout.write('COMMITTED:' + sequence + '\\n');
  if (sequence === 20) {
    await uow.run(async (tx) => {
      const taskId = 'task-0021';
      tx.put('tasks', taskId, { id: taskId, sequence: 21 });
      tx.put('counters', 'taskCount', 21);
      await audit.append({ actorUserId: null, action: 'test.task-written', resourceType: 'task', resourceId: taskId }, tx);
      process.stdout.write('IN_FLIGHT\\n');
      await new Promise(() => undefined);
    });
  }
}`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      env: { ...process.env, LMDB_TEST_PATH: storagePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`子进程未进入强杀检查点: ${stderr}`)), 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('IN_FLIGHT')) {
          clearTimeout(timeout);
          resolveReady();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', (error) => {
        clearTimeout(timeout);
        rejectReady(error);
      });
      child.once('exit', (code, signal) => {
        if (!stdout.includes('IN_FLIGHT')) {
          clearTimeout(timeout);
          rejectReady(new Error(`子进程提前退出 code=${code} signal=${signal}: ${stderr}`));
        }
      });
    });
    const exited = once(child, 'exit');
    try {
      await ready;
      expect(stdout).toContain('COMMITTED:20');
      expect(child.kill('SIGKILL')).toBe(true);
      const [exitCode] = await exited;
      expect(exitCode).not.toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
    }

    const engine = new LmdbStorageEngine({ path: storagePath });
    await engine.open();
    cleanups.push(() => engine.close());
    const recovered = await engine.transaction((tx) => ({
      tasks: [...tx.range<{ sequence: number }>('tasks', {})].map((entry) => entry.value.sequence).sort((left, right) => left - right),
      taskCount: tx.get<number>('counters', 'taskCount'),
      auditCount: [...tx.range('audit_logs', {})].length,
    }));
    expect(recovered.tasks).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(recovered.taskCount).toBe(20);
    expect(recovered.auditCount).toBe(20);
    expect(await engine.transaction((tx) => tx.get<number>('meta', 'auditSeq'))).toBe(20);
    const repos = createCoreRepositories(engine);
    expect(await new AuditService(repos, new UnitOfWork(engine)).verifyChain()).toBe(true);
    await engine.close();
  });

  it('keeps the audit hash chain linear under concurrent appends', async () => {
    const { engine } = await makeEngine();
    const clock = new FakeClock('2026-11-01T00:00:00.000Z');
    const repos = createCoreRepositories(engine, clock);
    const audit = new AuditService(repos, new UnitOfWork(engine), clock);
    await Promise.all(Array.from({ length: 25 }, (_, index) => audit.append({ actorUserId: null, action: `test.${index}`, resourceType: 'test', requestId: `req-${index}` })));
    const entries = (await repos.auditLogs.list({ page: 1, pageSize: 100 })).items;
    expect(entries.map((entry) => entry.seq).sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(entries.every((entry) => entry.createdAt === '2026-11-01T00:00:00.000Z')).toBe(true);
    expect(await engine.transaction((tx) => tx.get<number>('meta', 'auditSeq'))).toBe(25);
    expect(await engine.transaction((tx) => tx.get<string>('meta', 'auditLastHash'))).toBe(entries.find((entry) => entry.seq === 25)?.hash);
    expect(await audit.verifyChain()).toBe(true);
    await engine.close();
  });

  it('detects tampering with an audit actor field', async () => {
    const { engine } = await makeEngine();
    const repos = createCoreRepositories(engine);
    const audit = new AuditService(repos, new UnitOfWork(engine));
    const entry = await audit.append({ actorUserId: 'original-actor', action: 'test.tamper', resourceType: 'test' });
    await engine.transaction((tx) => tx.put('audit_logs', entry.id, { ...entry, actorUserId: 'forged-actor' }));
    expect(await audit.verifyChain()).toBe(false);
    await engine.close();
  });
});

describe('storage migration guard', () => {
  const runMigration = (dir: string): SpawnSyncReturns<string> => spawnSync(process.execPath, ['--import', 'tsx', 'app/backend/src/cli/migrate.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dir },
    encoding: 'utf8',
    timeout: 30_000,
  });

  it('reports the current schema as a no-op without changing data', async () => {
    const { engine, dir } = await makeEngine();
    await engine.close();
    const result = runMigration(dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('无需迁移，schemaVersion=1');
    const inspect = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
    await inspect.open({ allowSchemaMismatch: true });
    expect(inspect.maintenanceDb('meta').get('schemaVersion')).toBe(1);
    await inspect.close();
  });

  it('refuses an old schema without mutating the legacy version', async () => {
    const { engine, dir } = await makeEngine();
    await engine.transaction((tx) => tx.put('meta', 'schemaVersion', 0));
    await engine.close();
    const result = runMigration(dir);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('meta.schemaVersion 无效（0）');
    const inspect = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
    await inspect.open({ allowSchemaMismatch: true });
    expect(inspect.maintenanceDb('meta').get('schemaVersion')).toBe(0);
    await inspect.close();
  });

  it('refuses a missing schema version instead of silently initializing it', async () => {
    const { engine, dir } = await makeEngine();
    await engine.transaction((tx) => tx.remove('meta', 'schemaVersion'));
    await engine.close();
    const result = runMigration(dir);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('缺少 meta.schemaVersion');
    const inspect = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
    await inspect.open({ allowSchemaMismatch: true });
    expect(inspect.maintenanceDb('meta').get('schemaVersion')).toBeUndefined();
    await inspect.close();
  });
});

describe('single-instance lock', () => {
  it('rejects a second instance until the current owner releases the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-lock-'));
    paths.push(dir);
    const first = new SingleInstanceLock(dir);
    const second = new SingleInstanceLock(dir);
    cleanups.push(() => second.release(), () => first.release());

    await first.acquire();
    await expect(second.acquire()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await first.release();
    await second.acquire();
    await second.release();
  });

  it('recovers a lock owned by a process that no longer exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-lock-'));
    paths.push(dir);
    const deadProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 30_000 });
    if (deadProcess.status !== 0 || !deadProcess.pid) throw new Error(`无法创建已退出的测试进程: ${deadProcess.stderr}`);
    const lockDir = join(dir, 'locks');
    const lockPath = join(lockDir, 'app.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockPath, `${deadProcess.pid}\n2020-01-01T00:00:00.000Z\nstale-token\n`);
    const lock = new SingleInstanceLock(dir);
    cleanups.push(() => lock.release());

    await lock.acquire();
    expect((await readFile(lockPath, 'utf8')).split(/\r?\n/u)[0]).toBe(String(process.pid));
    await lock.release();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent recovery attempts so only one owner can acquire the lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-lock-'));
    paths.push(dir);
    const deadProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 30_000 });
    if (deadProcess.status !== 0 || !deadProcess.pid) throw new Error(`无法创建已退出的测试进程: ${deadProcess.stderr}`);
    const lockDir = join(dir, 'locks');
    const lockPath = join(lockDir, 'app.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockPath, `${deadProcess.pid}\n2020-01-01T00:00:00.000Z\nstale-token\n`);
    const first = new SingleInstanceLock(dir);
    const second = new SingleInstanceLock(dir);
    cleanups.push(() => second.release(), () => first.release());

    const attempts = await Promise.allSettled([first.acquire(), second.acquire()]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(Number((await readFile(lockPath, 'utf8')).split(/\r?\n/u)[0])).toBe(process.pid);
  });

  it('fails closed when a recovery marker already exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-lock-'));
    paths.push(dir);
    const deadProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 30_000 });
    if (deadProcess.status !== 0 || !deadProcess.pid) throw new Error(`无法创建已退出的测试进程: ${deadProcess.stderr}`);
    const lockDir = join(dir, 'locks');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'app.lock'), `${deadProcess.pid}\n2020-01-01T00:00:00.000Z\nstale-token\n`);
    await writeFile(join(lockDir, 'app.lock.recovery'), `${process.pid}\n2026-11-01T00:00:00.000Z\nrecovery-token\n`);
    const lock = new SingleInstanceLock(dir);

    await expect(lock.acquire()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect((await readFile(join(lockDir, 'app.lock'), 'utf8'))).toContain('stale-token');
  });

  it('does not delete a lock file whose ownership token changed before release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-lock-'));
    paths.push(dir);
    const lockPath = join(dir, 'locks', 'app.lock');
    const lock = new SingleInstanceLock(dir);
    cleanups.push(() => lock.release());

    await lock.acquire();
    await writeFile(lockPath, '123\n2026-11-01T00:00:00.000Z\nreplacement-token\n');
    await lock.release();
    expect(await readFile(lockPath, 'utf8')).toContain('replacement-token');
  });
});

describe('M0 auth, CSRF and files', () => {
  it('logs in, protects mutations with CSRF, and uploads/downloads content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-api-'));
    paths.push(dir);
    const config = loadConfig({ ...process.env, DATA_DIR: dir, MAX_UPLOAD_MB: '1', WEB_ORIGIN: 'http://127.0.0.1:3000', HOST: '127.0.0.1', PORT: '3000' });
    const { app, deps } = await buildApp({ config, logger: false });
    cleanups.push(() => app.close());
    const role = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
    if (!role) throw new Error('seed role missing');
    const auth = deps.auth;
    const user = await deps.repos.users.create({ name: '管理员', email: 'admin@example.com', passwordHash: await auth.createPasswordHash('CorrectHorseBattery12!'), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const sameOriginLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }, payload: { email: user.email, password: 'CorrectHorseBattery12!' } });
    expect(sameOriginLogin.statusCode, sameOriginLogin.body).toBe(200);
    const hostHeaderDoesNotGrantTrust = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: 'attacker.example', origin: 'http://attacker.example' }, payload: { email: user.email, password: 'CorrectHorseBattery12!' } });
    expect(hostHeaderDoesNotGrantTrust.statusCode).toBe(403);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:3000' }, payload: { email: user.email, password: 'CorrectHorseBattery12!' } });
    expect(login.statusCode).toBe(200);
    const setCookieHeaders = login.headers['set-cookie'];
    const cookieHeaders = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const sessionCookieHeader = cookieHeaders.find((value) => value?.startsWith('collab_session='));
    const csrfCookieHeader = cookieHeaders.find((value) => value?.startsWith('csrf_token='));
    expect(sessionCookieHeader).toBeDefined();
    expect(csrfCookieHeader).toBeDefined();
    expect(sessionCookieHeader).toMatch(/;\s*HttpOnly(?:;|$)/iu);
    expect(sessionCookieHeader).toMatch(/;\s*SameSite=Lax(?:;|$)/iu);
    expect(sessionCookieHeader).toMatch(/;\s*Path=\/(?:;|$)/iu);
    expect(sessionCookieHeader).toMatch(/;\s*Max-Age=604800(?:;|$)/iu);
    expect(sessionCookieHeader).not.toMatch(/;\s*Secure(?:;|$)/iu);
    expect(csrfCookieHeader).not.toMatch(/;\s*HttpOnly(?:;|$)/iu);
    expect(csrfCookieHeader).toMatch(/;\s*SameSite=Lax(?:;|$)/iu);
    expect(csrfCookieHeader).toMatch(/;\s*Path=\/(?:;|$)/iu);
    expect(csrfCookieHeader).not.toMatch(/;\s*Secure(?:;|$)/iu);
    const cookies = cookieHeaders.map((value) => value?.split(';')[0]).filter((value): value is string => Boolean(value)).join('; ');
    const csrf = cookies.match(/csrf_token=([^;]+)/)?.[1];
    const token = cookies.match(/collab_session=([^;]+)/)?.[1];
    expect(csrf).toBeTruthy();
    expect(token).toBeTruthy();
    if (!csrf || !token) throw new Error('登录 cookie 缺失');
    const originalContext = await deps.auth.loadContext(token);
    const denied = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: cookies, origin: 'http://127.0.0.1:3000' } });
    expect(denied.statusCode).toBe(403);
    const invalidToken = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: cookies, origin: 'http://127.0.0.1:3000', 'x-csrf-token': 'invalid-csrf-token' } });
    expect(invalidToken.statusCode).toBe(403);
    const crossOrigin = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: cookies, origin: 'http://attacker.example', 'x-csrf-token': csrf } });
    expect(crossOrigin.statusCode).toBe(403);
    expect((await deps.repos.sessions.get(originalContext.session.id))?.revokedAt).toBeNull();

    const expiredLogin = await deps.auth.verifyLogin(user.email, 'CorrectHorseBattery12!', { ip: null, userAgent: null });
    const expiredContext = await deps.auth.loadContext(expiredLogin.token);
    await deps.repos.sessions.update(expiredContext.session.id, expiredContext.session.version, (session) => ({ ...session, absoluteExpiresAt: new Date(0).toISOString() }));
    const expired = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `collab_session=${expiredLogin.token}` } });
    expect(expired.statusCode).toBe(401);
    expect((await deps.repos.sessions.get(expiredContext.session.id))?.revokedAt).not.toBeNull();

    const missingMultipart = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie: cookies, origin: 'http://127.0.0.1:3000', 'x-csrf-token': csrf } });
    expect(missingMultipart.statusCode).toBe(422);
    const boundary = '----collab-office-test-boundary';
    const metadataPart = `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify({ title: 'M0 文件验收', visibility: 'restricted' })}\r\n`;
    const multipartBody = Buffer.from(`${metadataPart}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hello.txt"\r\nContent-Type: text/plain\r\n\r\nhello M0\r\n--${boundary}--\r\n`);
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: { cookie: cookies, origin: 'http://127.0.0.1:3000', 'x-csrf-token': csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    expect(await deps.audit.verifyChain()).toBe(true);
    const uploadedId = (upload.json() as { data: { id: string } }).data.id;
    const download = await app.inject({ method: 'GET', url: `/api/v1/documents/${uploadedId}/download`, headers: { cookie: cookies } });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('hello M0');
    const storedFile = (await deps.repos.files.list({ page: 1, pageSize: 10 })).items[0]!;
    expect(storedFile.refCount).toBe(1);
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${storedFile.id}/download`, headers: { cookie: cookies } })).statusCode).toBe(404);
    const oversizedContent = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const oversizedPayload = Buffer.concat([
      Buffer.from(metadataPart),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      oversizedContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const oversizedUpload = await app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: { cookie: cookies, origin: 'http://127.0.0.1:3000', 'x-csrf-token': csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: oversizedPayload,
    });
    expect(oversizedUpload.statusCode, oversizedUpload.body).toBe(413);
    expect(oversizedUpload.json().code).toBe('FILE_TOO_LARGE');
    expect((await deps.repos.files.list({ page: 1, pageSize: 10 })).total).toBe(1);
    expect((await deps.files.verify()).orphanFiles).toBe(0);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookies } });
    expect(me.statusCode).toBe(200);
    const loginRecords = await deps.repos.loginRecords.list({ page: 1, pageSize: 10 });
    expect(loginRecords.items.some((item) => item.success)).toBe(true);
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: cookies, origin: 'http://127.0.0.1:3000', 'x-csrf-token': csrf } });
    expect(logout.statusCode).toBe(200);
    expect((await deps.repos.sessions.get(originalContext.session.id))?.revokedAt).not.toBeNull();
    const oldSession = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookies } });
    expect(oldSession.statusCode).toBe(401);
    expect(await deps.audit.verifyChain()).toBe(true);
  });

  it('forces a temporary-password user to change it before using protected features', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-password-change-'));
    paths.push(dir);
    const { app, deps } = await buildApp({ dataDir: dir, logger: false });
    cleanups.push(() => app.close());
    const role = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
    if (!role) throw new Error('seed role missing');
    const password = 'TemporaryPassword12!';
    const user = await deps.repos.users.create({ name: '新成员', email: 'new-member@example.com', passwordHash: await deps.auth.createPasswordHash(password), status: 'active', mustChangePassword: true, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:5173' }, payload: { email: user.email, password } });
    expect(login.statusCode).toBe(200);
    const cookies = (login.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
    const csrf = cookies.match(/csrf_token=([^;]+)/)?.[1];
    const token = cookies.match(/collab_session=([^;]+)/)?.[1];
    if (!csrf || !token) throw new Error('login cookies missing');

    const context = await deps.auth.loadContext(token);
    const oldIdleExpiry = new Date(Date.now() + 120_000).toISOString();
    const oldLastSeen = new Date(Date.now() - 120_000).toISOString();
    await deps.repos.sessions.update(context.session.id, context.session.version, (session) => ({ ...session, lastSeenAt: oldLastSeen, idleExpiresAt: oldIdleExpiry }));
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookies } });
    expect(me.statusCode).toBe(200);
    const touchedSession = await deps.repos.sessions.get(context.session.id);
    expect(touchedSession?.lastSeenAt).not.toBe(oldLastSeen);
    expect(Date.parse(touchedSession?.idleExpiresAt ?? '')).toBeGreaterThan(Date.parse(oldIdleExpiry));

    const blocked = await app.inject({ method: 'GET', url: '/api/v1/workbench', headers: { cookie: cookies } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    const changed = await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: { cookie: cookies, origin: 'http://127.0.0.1:5173', 'x-csrf-token': csrf }, payload: { currentPassword: password, newPassword: 'ChangedPassword12!' } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await deps.repos.users.get(user.id))?.mustChangePassword).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/v1/workbench', headers: { cookie: cookies } })).statusCode).toBe(200);
  });

  it('rejects common weak replacement passwords and locks an account after repeated failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-login-lock-'));
    paths.push(dir);
    const { app, deps } = await buildApp({ dataDir: dir, logger: false });
    cleanups.push(() => app.close());
    const role = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
    if (!role) throw new Error('seed role missing');
    const password = 'OriginalPassword2026!';
    const user = await deps.repos.users.create({ name: '登录锁定用户', email: 'lock-test@example.com', passwordHash: await deps.auth.createPasswordHash(password), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:5173' }, payload: { email: user.email, password } });
    const cookies = (login.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
    const csrf = cookies.match(/csrf_token=([^;]+)/)?.[1];
    if (!csrf) throw new Error('CSRF cookie missing');
    const weakPassword = await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: { cookie: cookies, origin: 'http://127.0.0.1:5173', 'x-csrf-token': csrf }, payload: { currentPassword: password, newPassword: 'Password12345!' } });
    expect(weakPassword.statusCode).toBe(422);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:5173' }, payload: { email: user.email, password: 'WrongPassword123!' } });
      expect(failed.statusCode).toBe(401);
    }
    const lockedUser = await deps.repos.users.get(user.id);
    expect(lockedUser?.lockedUntil).not.toBeNull();
    const originalLockDeadline = lockedUser?.lockedUntil;
    const locked = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:5173' }, payload: { email: user.email, password } });
    expect(locked.statusCode).toBe(401);
    const repeatedLockedAttempt = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:5173' }, payload: { email: user.email, password: 'WrongPassword123!' } });
    expect(repeatedLockedAttempt.statusCode).toBe(401);
    const stillLockedUser = await deps.repos.users.get(user.id);
    expect(stillLockedUser?.lockedUntil).toBe(originalLockDeadline);
    expect(stillLockedUser?.failedLoginCount).toBe(5);
  });

  it('prevents system administrators from granting admin roles or accessing ungranted modules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-rbac-'));
    paths.push(dir);
    const { app, deps } = await buildApp({ dataDir: dir, logger: false });
    cleanups.push(() => app.close());
    const systemRole = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'system_admin');
    if (!systemRole) throw new Error('seed system_admin role missing');
    const user = await deps.repos.users.create({ name: '系统管理员', email: 'system-admin@example.com', passwordHash: await deps.auth.createPasswordHash('SystemPassword12!'), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [systemRole.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://127.0.0.1:5173' }, payload: { email: user.email, password: 'SystemPassword12!' } });
    expect(login.statusCode).toBe(200);
    const cookies = (login.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
    const csrf = cookies.match(/csrf_token=([^;]+)/)?.[1];
    if (!csrf) throw new Error('CSRF cookie missing');

    const workbench = await app.inject({ method: 'GET', url: '/api/v1/workbench', headers: { cookie: cookies } });
    expect(workbench.statusCode).toBe(403);
    const upload = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie: cookies, origin: 'http://127.0.0.1:5173', 'x-csrf-token': csrf } });
    expect(upload.statusCode).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: cookies, origin: 'http://127.0.0.1:5173', 'x-csrf-token': csrf },
      payload: { name: '提权目标', email: 'privilege-target', roleCode: 'org_admin' },
    });
    expect(created.statusCode).toBe(403);
    expect(await deps.repos.users.getByUniqueIndex('idx_users_email', 'privilege-target')).toBeUndefined();
    const defaultMember = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: cookies, origin: 'http://127.0.0.1:5173', 'x-csrf-token': csrf },
      payload: { name: '默认成员', email: 'default-member' },
    });
    expect(defaultMember.statusCode, defaultMember.body).toBe(201);
    expect((defaultMember.json() as { data: { user: { id: string; email: string } } }).data.user.email).toBe('default-member');
  });

  it('manages custom roles and full user-role replacement with transactional authorization and audit records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-rbac-management-'));
    paths.push(dir);
    const config = loadConfig({ ...process.env, DATA_DIR: dir, WEB_ORIGIN: 'http://localhost:5173', HOST: '127.0.0.1', PORT: '3000' });
    const { app, deps } = await buildApp({ config, logger: false });
    cleanups.push(() => app.close());
    const orgAdmin = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
    const member = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
    if (!orgAdmin || !member) throw new Error('seed roles missing');
    const password = 'RoleManagerPassword12!';
    const actor = await deps.repos.users.create({ name: '角色管理员', email: 'role-manager@example.com', passwordHash: await deps.auth.createPasswordHash(password), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [orgAdmin.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.webOrigin }, payload: { email: actor.email, password } });
    expect(login.statusCode).toBe(200);
    const cookies = (login.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
    const csrf = cookies.match(/csrf_token=([^;]+)/)?.[1];
    if (!csrf) throw new Error('CSRF cookie missing');
    const mutationHeaders = { cookie: cookies, origin: config.webOrigin, 'x-csrf-token': csrf };

    const invalidRole = await app.inject({
      method: 'POST',
      url: '/api/v1/organization/roles',
      headers: mutationHeaders,
      payload: { code: 'invalid_permission', name: '无效权限', description: '', dataScope: 'self', permissionCodes: ['unknown:permission'] },
    });
    expect(invalidRole.statusCode).toBe(422);
    const createdRole = await app.inject({
      method: 'POST',
      url: '/api/v1/organization/roles',
      headers: mutationHeaders,
      payload: { code: 'task_observer', name: '任务观察员', description: '查看任务', dataScope: 'self', permissionCodes: ['task:read'] },
    });
    expect(createdRole.statusCode, createdRole.body).toBe(201);
    const customRole = (createdRole.json() as { data: { id: string; version: number; permissionCodes: string[] } }).data;
    expect(createdRole.headers.location).toBe(`/api/v1/organization/roles/${customRole.id}`);

    const userCreated = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: mutationHeaders,
      payload: { name: '角色目标', email: 'role-target', roleCode: 'member' },
    });
    expect(userCreated.statusCode, userCreated.body).toBe(201);
    const targetId = (userCreated.json() as { data: { user: { id: string } } }).data.user.id;
    expect(userCreated.headers.location).toBe(`/api/v1/users/${targetId}`);
    const effective = await app.inject({ method: 'GET', url: `/api/v1/organization/users/${targetId}/effective-permissions`, headers: { cookie: cookies } });
    expect(effective.statusCode).toBe(200);
    const targetBefore = (effective.json() as { data: { version: number; roleIds: string[]; roles: string[] } }).data;
    expect(targetBefore.roleIds).toEqual([member.id]);
    expect(targetBefore.roles).toEqual(['member']);

    const assigned = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${targetId}/roles`,
      headers: mutationHeaders,
      payload: { roleIds: [customRole.id], version: targetBefore.version },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const customUpdated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organization/roles/${customRole.id}`,
      headers: mutationHeaders,
      payload: { version: customRole.version, dataScope: 'all', permissionCodes: ['task:read', 'task:create'] },
    });
    expect(customUpdated.statusCode, customUpdated.body).toBe(200);
    const updatedRole = (customUpdated.json() as { data: { version: number } }).data;
    const cannotDeleteReferenced = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organization/roles/${customRole.id}`,
      headers: mutationHeaders,
      payload: { version: updatedRole.version },
    });
    expect(cannotDeleteReferenced.statusCode).toBe(409);

    const targetAfter = await app.inject({ method: 'GET', url: `/api/v1/organization/users/${targetId}/effective-permissions`, headers: { cookie: cookies } });
    const targetAfterData = (targetAfter.json() as { data: { version: number; roleIds: string[]; permissions: string[] } }).data;
    expect(targetAfterData.roleIds).toEqual([customRole.id]);
    expect(targetAfterData.permissions).toEqual(expect.arrayContaining(['task:read', 'task:create']));
    const restored = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${targetId}/roles`,
      headers: mutationHeaders,
      payload: { roleIds: [member.id], version: targetAfterData.version },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const deletedRole = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organization/roles/${customRole.id}`,
      headers: mutationHeaders,
      payload: { version: updatedRole.version },
    });
    expect(deletedRole.statusCode, deletedRole.body).toBe(200);
    const deletedRoleAssignment = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${targetId}/roles`,
      headers: mutationHeaders,
      payload: { roleIds: [customRole.id], version: (await deps.repos.users.require(targetId)).version },
    });
    expect(deletedRoleAssignment.statusCode).toBe(422);
    const systemRoleDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organization/roles/${member.id}`,
      headers: mutationHeaders,
      payload: { version: member.version },
    });
    expect(systemRoleDelete.statusCode).toBe(403);
    const audits = await deps.repos.auditLogs.list({ page: 1, pageSize: 100 });
    expect(audits.items.some((item) => item.action === 'role.created' && item.resourceId === customRole.id && item.metadata.dataScope === 'self')).toBe(true);
    expect(audits.items.some((item) => item.action === 'role.updated' && item.resourceId === customRole.id && item.metadata.dataScopeAfter === 'all' && item.metadata.permissionsAdded === 'task:create')).toBe(true);
    expect(audits.items.some((item) => item.action === 'role.assigned' && item.resourceId === customRole.id && item.metadata.userId === targetId)).toBe(true);
    expect(audits.items.some((item) => item.action === 'role.revoked' && item.resourceId === customRole.id && item.metadata.userId === targetId)).toBe(true);
    expect(await deps.audit.verifyChain()).toBe(true);
  });

  it('rejects role self-modification and invalidates sessions for soft-deleted users', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-rbac-deleted-user-'));
    paths.push(dir);
    const config = loadConfig({ ...process.env, DATA_DIR: dir, WEB_ORIGIN: 'http://localhost:5173', HOST: '127.0.0.1', PORT: '3000' });
    const { app, deps } = await buildApp({ config, logger: false });
    cleanups.push(() => app.close());
    const orgAdmin = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
    const member = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
    if (!orgAdmin || !member) throw new Error('seed roles missing');
    const password = 'SelfRolePassword12!';
    const actor = await deps.repos.users.create({ name: '自改管理员', email: 'self-role@example.com', passwordHash: await deps.auth.createPasswordHash(password), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [orgAdmin.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.webOrigin }, payload: { email: actor.email, password } });
    const cookies = (login.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
    const csrf = cookies.match(/csrf_token=([^;]+)/)?.[1];
    if (!csrf) throw new Error('CSRF cookie missing');
    const selfNoop = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${actor.id}/roles`,
      headers: { cookie: cookies, origin: config.webOrigin, 'x-csrf-token': csrf },
      payload: { roleIds: [orgAdmin.id], version: actor.version },
    });
    expect(selfNoop.statusCode).toBe(403);
    const selfLastAdminRemoval = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${actor.id}/roles`,
      headers: { cookie: cookies, origin: config.webOrigin, 'x-csrf-token': csrf },
      payload: { roleIds: [member.id], version: actor.version },
    });
    expect(selfLastAdminRemoval.statusCode).toBe(403);
    expect(selfLastAdminRemoval.json().code).toBe('FORBIDDEN');
    const current = await deps.repos.users.require(actor.id);
    await deps.repos.users.softDelete(current.id, current.version);
    const meAfterDeletion = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookies } });
    expect(meAfterDeletion.statusCode).toBe(401);
  });

  it('rechecks actor permissions and session state inside RBAC write transactions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-rbac-transaction-'));
    paths.push(dir);
    const config = loadConfig({ ...process.env, DATA_DIR: dir, WEB_ORIGIN: 'http://localhost:5173', HOST: '127.0.0.1', PORT: '3000' });
    const { app, deps } = await buildApp({ config, logger: false });
    cleanups.push(() => app.close());
    const member = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
    if (!member) throw new Error('seed member role missing');
    const managerRole = await deps.repos.roles.create({ code: 'role_manager', name: '角色管理', description: '', dataScope: 'self', permissionCodes: ['role:manage'], system: false } as Omit<RoleDocument, keyof DocumentEnvelope>);
    const password = 'TransactionPassword12!';
    const actor = await deps.repos.users.create({ name: '事务管理员', email: 'transaction-manager@example.com', passwordHash: await deps.auth.createPasswordHash(password), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [managerRole.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.webOrigin }, payload: { email: actor.email, password } });
    const token = (login.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ').match(/collab_session=([^;]+)/)?.[1];
    if (!token) throw new Error('session cookie missing');
    const staleContext = await deps.auth.loadContext(token);
    const current = await deps.repos.users.require(actor.id);
    await deps.repos.users.update(current.id, current.version, (user) => ({ ...user, roleIds: [member.id] }));
    await expect(deps.auth.createRole(staleContext, { code: 'stale_permission_role', name: '过期权限', description: '', dataScope: 'self', permissionCodes: [] }, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'stale_permission_role')).toBeUndefined();

    const restored = await deps.repos.users.require(actor.id);
    await deps.repos.users.update(restored.id, restored.version, (user) => ({ ...user, roleIds: [managerRole.id] }));
    await deps.auth.revoke(staleContext.session);
    await expect(deps.auth.createRole(staleContext, { code: 'revoked_session_role', name: '撤销会话', description: '', dataScope: 'self', permissionCodes: [] }, {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'revoked_session_role')).toBeUndefined();
  });

  it('keeps org-admin-only role revocation and the dual-admin org-admin grant restriction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-office-rbac-admin-boundaries-'));
    paths.push(dir);
    const config = loadConfig({ ...process.env, DATA_DIR: dir, WEB_ORIGIN: 'http://localhost:5173', HOST: '127.0.0.1', PORT: '3000' });
    const { app, deps } = await buildApp({ config, logger: false });
    cleanups.push(() => app.close());
    const orgAdmin = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
    const systemAdmin = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'system_admin');
    const member = await deps.repos.roles.getByUniqueIndex('idx_roles_code', 'member');
    if (!orgAdmin || !systemAdmin || !member) throw new Error('seed roles missing');
    const adminPassword = 'BoundaryAdminPassword12!';
    const admin = await deps.repos.users.create({ name: '边界管理员', email: 'boundary-admin@example.com', passwordHash: await deps.auth.createPasswordHash(adminPassword), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [orgAdmin.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.webOrigin }, payload: { email: admin.email, password: adminPassword } });
    const adminCookies = (adminLogin.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
    const adminCsrf = adminCookies.match(/csrf_token=([^;]+)/)?.[1];
    if (!adminCsrf) throw new Error('admin CSRF cookie missing');
    const adminHeaders = { cookie: adminCookies, origin: config.webOrigin, 'x-csrf-token': adminCsrf };
    const managerRoleResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/organization/roles',
      headers: adminHeaders,
      payload: { code: 'security_role_manager', name: '安全角色管理员', description: '', dataScope: 'self', permissionCodes: ['role:manage'] },
    });
    expect(managerRoleResponse.statusCode, managerRoleResponse.body).toBe(201);
    const managerUserResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: adminHeaders,
      payload: { name: '角色管理员', email: 'non-org-role-manager', roleCode: 'security_role_manager' },
    });
    expect(managerUserResponse.statusCode, managerUserResponse.body).toBe(201);
    const managerPayload = managerUserResponse.json() as { data: { user: { id: string; email: string }; temporaryPassword: string } };
    const managerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.webOrigin }, payload: { email: managerPayload.data.user.email, password: managerPayload.data.temporaryPassword } });
    const managerCookies = (managerLogin.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
    const managerCsrf = managerCookies.match(/csrf_token=([^;]+)/)?.[1];
    if (!managerCsrf) throw new Error('manager CSRF cookie missing');
    const passwordChanged = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie: managerCookies, origin: config.webOrigin, 'x-csrf-token': managerCsrf },
      payload: { currentPassword: managerPayload.data.temporaryPassword, newPassword: 'RoleManagerChanged12!' },
    });
    expect(passwordChanged.statusCode, passwordChanged.body).toBe(200);
    const systemUserResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: adminHeaders,
      payload: { name: '系统账户', email: 'system-role-target', roleCode: 'system_admin' },
    });
    expect(systemUserResponse.statusCode, systemUserResponse.body).toBe(201);
    const systemTargetId = (systemUserResponse.json() as { data: { user: { id: string } } }).data.user.id;
    const systemTarget = await app.inject({ method: 'GET', url: `/api/v1/organization/users/${systemTargetId}/effective-permissions`, headers: { cookie: adminCookies } });
    const systemTargetVersion = (systemTarget.json() as { data: { version: number } }).data.version;
    const nonOrgRevocation = await app.inject({
      method: 'PUT',
      url: `/api/v1/users/${systemTargetId}/roles`,
      headers: { cookie: managerCookies, origin: config.webOrigin, 'x-csrf-token': managerCsrf },
      payload: { roleIds: [member.id], version: systemTargetVersion },
    });
    expect(nonOrgRevocation.statusCode).toBe(403);

    const dualPassword = 'DualAdminPassword12!';
    const dualAdmin = await deps.repos.users.create({ name: '双管理员', email: 'dual-admin@example.com', passwordHash: await deps.auth.createPasswordHash(dualPassword), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [orgAdmin.id, systemAdmin.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>);
    const dualLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: config.webOrigin }, payload: { email: dualAdmin.email, password: dualPassword } });
    const dualCookies = (dualLogin.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
    const dualCsrf = dualCookies.match(/csrf_token=([^;]+)/)?.[1];
    if (!dualCsrf) throw new Error('dual-admin CSRF cookie missing');
    const dualGrant = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { cookie: dualCookies, origin: config.webOrigin, 'x-csrf-token': dualCsrf },
      payload: { name: '组织管理员目标', email: 'dual-grant-target', roleCode: 'org_admin' },
    });
    expect(dualGrant.statusCode).toBe(403);
  });

  it('rejects unsafe file types before writing', async () => {
    const { engine, dir } = await makeEngine();
    const repos = createCoreRepositories(engine);
    const uow = new UnitOfWork(engine);
    const files = new FileService(dir, repos, uow, new AuditService(repos, uow));
    await files.init();
    await expect(files.save({ stream: (async function* () { yield Buffer.from('<script>'); })(), filename: 'x.html', mimetype: 'text/html', uploadedBy: 'u', maxBytes: 1000 })).rejects.toMatchObject({ code: 'FILE_TYPE_UNSUPPORTED' });
    await engine.close();
  });

  it('rejects filename and declared MIME mismatches before creating temp files', async () => {
    const { engine, dir } = await makeEngine();
    const repos = createCoreRepositories(engine);
    const uow = new UnitOfWork(engine);
    const files = new FileService(dir, repos, uow, new AuditService(repos, uow));
    await files.init();
    await expect(files.save({ stream: (async function* () { yield Buffer.from('plain text'); })(), filename: 'payload.jpg', mimetype: 'text/plain', uploadedBy: 'u', maxBytes: 1000 })).rejects.toMatchObject({ code: 'FILE_TYPE_UNSUPPORTED' });
    await expect(files.save({ stream: (async function* () { yield Buffer.alloc(0); })(), filename: 'empty.txt', mimetype: 'text/plain', uploadedBy: 'u', maxBytes: 1000 })).rejects.toMatchObject({ code: 'FILE_INVALID' });
    expect((await readdir(join(dir, 'tmp'))).filter((name) => name.endsWith('.upload'))).toHaveLength(0);
    await engine.close();
  });

  it('reactivates a content-addressed file when the same content is uploaded after release', async () => {
    const { engine, dir } = await makeEngine();
    const repos = createCoreRepositories(engine);
    const uow = new UnitOfWork(engine);
    const files = new FileService(dir, repos, uow, new AuditService(repos, uow));
    await files.init();
    const makeInput = (): UploadInput => ({ stream: (async function* () { yield Buffer.from('reusable content'); })(), filename: 'reusable.txt', mimetype: 'text/plain', uploadedBy: 'u', maxBytes: 1000 });
    const first = await files.save(makeInput());
    await files.release(first);
    const second = await files.save(makeInput());
    expect(second.id).toBe(first.id);
    expect(second.refCount).toBe(1);
    expect(second.status).toBe('active');
    await expect(files.pathFor(second)).resolves.toContain(second.sha256);
    await engine.close();
  });

  it('retains released file content for seven days and reclaims it on startup after expiry', async () => {
    const { engine, dir } = await makeEngine();
    const clock = new FakeClock('2026-11-01T00:00:00.000Z');
    const repos = createCoreRepositories(engine, clock);
    const uow = new UnitOfWork(engine);
    const files = new FileService(dir, repos, uow, new AuditService(repos, uow, clock), clock);
    await files.init();
    const legacyTrashFile = join(dir, 'trash', `${'ab'.repeat(32)}-${clock.now().getTime()}`);
    await writeFile(legacyTrashFile, 'legacy quarantined bytes');
    const file = await files.save({ stream: (async function* () { yield Buffer.from('retained content'); })(), filename: 'retained.txt', mimetype: 'text/plain', uploadedBy: 'u', maxBytes: 1000 });
    await files.release(file);
    const retainedDir = join(dir, 'trash', 'files', String(clock.now().getTime()));
    expect(await readdir(retainedDir)).toHaveLength(1);

    clock.advanceMinutes(7 * 24 * 60 - 1);
    expect((await files.init()).cleanedTrashEntries).toBe(0);
    expect(await readdir(retainedDir)).toHaveLength(1);
    await expect(readFile(legacyTrashFile)).resolves.toEqual(Buffer.from('legacy quarantined bytes'));

    clock.advanceMinutes(2);
    const cleanup = await files.init();
    expect(cleanup.expiredTrashEntries).toBe(2);
    expect(cleanup.cleanedTrashEntries).toBe(2);
    await expect(readdir(retainedDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(legacyTrashFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await engine.close();
  });

  it('reports missing active content and quarantines orphaned content at startup', async () => {
    const { engine, dir } = await makeEngine();
    const repos = createCoreRepositories(engine);
    const uow = new UnitOfWork(engine);
    const files = new FileService(dir, repos, uow, new AuditService(repos, uow));
    const orphanHash = 'ab'.repeat(32);
    const orphanPath = join(dir, 'files', orphanHash.slice(0, 2), orphanHash);
    await mkdir(join(dir, 'files', orphanHash.slice(0, 2)), { recursive: true });
    await writeFile(orphanPath, 'orphan');
    const initialReport = await files.init();
    expect(initialReport.orphanFiles).toBe(1);
    expect(initialReport.quarantinedOrphans).toBe(1);
    expect(initialReport.ok).toBe(true);
    await expect(readFile(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const remainingOrphanHash = 'cd'.repeat(32);
    const remainingOrphanPath = join(dir, 'files', remainingOrphanHash.slice(0, 2), remainingOrphanHash);
    await mkdir(join(dir, 'files', remainingOrphanHash.slice(0, 2)), { recursive: true });
    await writeFile(remainingOrphanPath, 'unresolved orphan');
    const active = await files.save({ stream: (async function* () { yield Buffer.from('will be missing'); })(), filename: 'missing.txt', mimetype: 'text/plain', uploadedBy: 'u', maxBytes: 1000 });
    await rm(join(dir, 'files', active.storageKey));
    await writeFile(join(dir, 'tmp', 'recent.upload'), 'pending bytes');
    const verification = await files.verify();
    expect(verification.ok).toBe(false);
    expect(verification.missingFiles).toBe(1);
    expect(verification.orphanFiles).toBe(1);
    expect(verification.pendingUploads).toBe(1);
    await engine.close();
  });
});
