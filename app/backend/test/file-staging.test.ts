import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/modules/core/audit-service.js';
import { FileService, type UploadInput, type StagedUpload } from '../src/modules/core/file-service.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { UnitOfWork } from '../src/storage/unit-of-work.js';

const dirs: string[] = [];
const engines: LmdbStorageEngine[] = [];
async function fixture(): Promise<{ dir: string; files: FileService; other: FileService; repos: ReturnType<typeof createCoreRepositories>; uow: UnitOfWork; audit: AuditService }> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-file-stage-'));
  dirs.push(dir);
  const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
  await engine.open(); engines.push(engine);
  const repos = createCoreRepositories(engine);
  const uow = new UnitOfWork(engine);
  const audit = new AuditService(repos, uow);
  const files = new FileService(dir, repos, uow, audit);
  const other = new FileService(dir, repos, uow, audit);
  await files.init();
  return { dir, files, other, repos, uow, audit };
}
function input(content: string, uploadedBy = 'alice'): UploadInput {
  return { stream: (async function* (): AsyncGenerator<Buffer> { yield Buffer.from(content); })(), filename: 'a.txt', mimetype: 'text/plain', uploadedBy, maxBytes: 1024 };
}
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe('file staging and transaction binding', () => {
  it('binds one opaque capability to its owner once and commits the reference and business data together', async () => {
    const { files, repos, uow, audit } = await fixture();
    const upload = await files.stage(input('staged content'));
    expect((await repos.files.list({ page: 1, pageSize: 10 })).total).toBe(0);
    await expect(files.bind(upload, 'bob', async () => null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const file = await files.bind(upload, 'alice', async (saved, tx) => { tx.put('meta', 'test-file-id', saved.id); return saved; });
    expect(await uow.run((tx) => tx.get('meta', 'test-file-id'))).toBe(file.id);
    expect(file.refCount).toBe(1);
    expect(await audit.verifyChain()).toBe(true);
    await expect(files.bind(upload, 'alice', async () => null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(files.bind({} as StagedUpload, 'alice', async () => null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rolls back business data, reference and audit together if the business write fails', async () => {
    const { dir, files, repos, uow } = await fixture();
    const content = 'must roll back';
    const hash = createHash('sha256').update(content).digest('hex');
    const upload = await files.stage(input(content));
    await expect(files.bind(upload, 'alice', async (_file, tx) => { tx.put('meta', 'failure-test', true); throw new Error('business failed'); })).rejects.toThrow('business failed');
    expect(await uow.run((tx) => tx.get('meta', 'failure-test'))).toBeUndefined();
    expect((await repos.files.list({ page: 1, pageSize: 10 })).total).toBe(0);
    expect((await repos.auditLogs.list({ page: 1, pageSize: 10 })).total).toBe(0);
    await expect(readFile(join(dir, 'files', hash.slice(0, 2), hash))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('serializes identical uploads across service instances and protects a committed copy from a later rollback', async () => {
    const { files, other, repos, audit } = await fixture();
    const [a, b, c] = await Promise.all([files.stage(input('same')), other.stage(input('same')), files.stage(input('same'))]);
    const [first, second] = await Promise.all([
      files.bind(a, 'alice', async (file) => file),
      other.bind(b, 'alice', async (file) => file),
    ]);
    await expect(files.bind(c, 'alice', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(second.id).toBe(first.id);
    const stored = await repos.files.require(first.id);
    expect(stored.refCount).toBe(2);
    await expect(readFile(await files.pathFor(stored), 'utf8')).resolves.toBe('same');
    expect(await audit.verifyChain()).toBe(true);
  });
  it('protects a staged upload from startup reconciliation and supports explicit discard', async () => {
    const { files, dir } = await fixture();
    const upload = await files.stage(input('pending'));
    expect((await files.init()).pendingUploads).toBe(1);
    expect((await readdir(join(dir, 'tmp'))).length).toBe(1);
    await expect(files.discard(upload, 'bob')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await files.discard(upload, 'alice');
    expect(await readdir(join(dir, 'tmp'))).toEqual([]);
    await expect(files.bind(upload, 'alice', async () => null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects tampered staged bytes without writing a reference', async () => {
    const { files, repos, dir } = await fixture();
    const upload = await files.stage(input('original'));
    const names = await readdir(join(dir, 'tmp'));
    await writeFile(join(dir, 'tmp', names[0]!), 'tampered');
    await expect(files.bind(upload, 'alice', async () => null)).rejects.toMatchObject({ code: 'FILE_CHECKSUM_MISMATCH' });
    expect((await repos.files.list({ page: 1, pageSize: 10 })).total).toBe(0);
  });
  it('does not allow reconciliation to quarantine a file while its binding transaction is in progress', async () => {
    const { files, other } = await fixture();
    const upload = await files.stage(input('concurrent verification'));
    let start!: () => void; let finish!: () => void;
    const started = new Promise<void>((resolvePromise) => { start = resolvePromise; });
    const wait = new Promise<void>((resolvePromise) => { finish = resolvePromise; });
    const binding = files.bind(upload, 'alice', async (file) => { start(); await wait; return file; });
    await started;
    let verified = false;
    const verification = other.init().then((report) => { verified = true; return report; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(verified).toBe(false);
    finish(); const file = await binding; const report = await verification;
    expect(report.quarantinedOrphans).toBe(0);
    await expect(readFile(await files.pathFor(file), 'utf8')).resolves.toBe('concurrent verification');
  });
  it('coordinates final release and re-upload of identical content', async () => {
    const { files, other, repos } = await fixture();
    const old = await files.save(input('reused'));
    const staged = await other.stage(input('reused'));
    const [, revived] = await Promise.all([files.release(old), other.bind(staged, 'alice', async (file) => file)]);
    const stored = await repos.files.require(revived.id);
    expect(stored.refCount).toBe(1);
    expect(stored.status).toBe('active');
    await expect(readFile(await files.pathFor(stored), 'utf8')).resolves.toBe('reused');
  });
  it('recovers a killed process at staged, uncommitted and committed checkpoints', async () => {
    const program = `
      import { LmdbStorageEngine } from './app/backend/src/storage/engine.ts';
      import { createCoreRepositories } from './app/backend/src/modules/core/repositories.ts';
      import { UnitOfWork } from './app/backend/src/storage/unit-of-work.ts';
      import { AuditService } from './app/backend/src/modules/core/audit-service.ts';
      import { FileService } from './app/backend/src/modules/core/file-service.ts';
      const dir = process.env.STAGE_DIR; const phase = process.env.STAGE_PHASE;
      const engine = new LmdbStorageEngine({ path: dir + '/store/lmdb' }); await engine.open();
      const repos = createCoreRepositories(engine); const uow = new UnitOfWork(engine);
      const audit = new AuditService(repos, uow); const files = new FileService(dir, repos, uow, audit); await files.init();
      async function* stream() { yield Buffer.from('crash-content'); }
      const stage = await files.stage({ stream: stream(), filename:'a.txt', mimetype:'text/plain', uploadedBy:'alice', maxBytes:1024 });
      const checkpoint = async () => { process.stdout.write('CHECKPOINT\\n'); await new Promise(() => { setInterval(() => {}, 1000); }); };
      if (phase === 'staged') await checkpoint();
      await files.bind(stage, 'alice', async (file, tx) => {
        tx.put('meta', 'test-business-file', file.id);
        if (phase === 'inflight') await checkpoint();
      });
      await checkpoint();
    `;
    for (const phase of ['staged', 'inflight', 'committed']) {
      const dir = await mkdtemp(join(tmpdir(), `collab-file-crash-${phase}-`)); dirs.push(dir);
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
        cwd: process.cwd(), env: { ...process.env, STAGE_DIR: dir, STAGE_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exit = once(child, 'exit'); let stdout = ''; let stderr = '';
      const checkpoint = new Promise<void>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error(`checkpoint timeout: ${stderr}`)), 15000);
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.includes('CHECKPOINT')) { clearTimeout(timer); resolvePromise(); } });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once('error', (error) => { clearTimeout(timer); rejectPromise(error); });
        child.once('exit', () => { if (!stdout.includes('CHECKPOINT')) { clearTimeout(timer); rejectPromise(new Error(`child exited early: ${stderr}`)); } });
      });
      try { await checkpoint; child.kill('SIGKILL'); await exit; } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
      const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') }); await engine.open(); engines.push(engine);
      const repos = createCoreRepositories(engine); const uow = new UnitOfWork(engine); const audit = new AuditService(repos, uow);
      const files = new FileService(dir, repos, uow, audit);
      if (phase === 'staged') {
        const names = await readdir(join(dir, 'tmp'));
        const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await utimes(join(dir, 'tmp', names[0]!), stale, stale);
      }
      const report = await files.init();
      const businessId = await uow.run((tx) => tx.get<string>('meta', 'test-business-file'));
      if (phase === 'committed') {
        expect(report.ok).toBe(true);
        expect(businessId).toBeDefined();
        const file = await repos.files.require(businessId!);
        expect(file.refCount).toBe(1);
        await expect(readFile(await files.pathFor(file), 'utf8')).resolves.toBe('crash-content');
      } else {
        expect(businessId).toBeUndefined();
        expect((await repos.files.list({ page: 1, pageSize: 10 })).total).toBe(0);
        expect(phase === 'inflight' ? report.quarantinedOrphans : report.quarantinedTemps).toBe(1);
      }
      expect(await audit.verifyChain()).toBe(true);
      await engine.close(); engines.splice(engines.indexOf(engine), 1);
    }
  }, 60000);
});
