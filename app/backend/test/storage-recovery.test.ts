import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/modules/core/audit-service.js';
import { FileService } from '../src/modules/core/file-service.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { UnitOfWork } from '../src/storage/unit-of-work.js';

interface RecoveryTask {
  readonly id: string;
  readonly kind: 'storage-recovery-task';
  readonly round: number;
}

interface RecoveryDocument {
  readonly id: string;
  readonly kind: 'storage-recovery-document';
  readonly round: number;
  readonly taskId: string;
  readonly fileId: string;
  readonly fileSha256: string;
  readonly fileStorageKey: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function contentFor(round: number): Buffer {
  return Buffer.from(`storage recovery document bytes, round=${round}\n`, 'utf8');
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function childProgram(): string {
  return `
import { LmdbStorageEngine } from './app/backend/src/storage/engine.ts';
import { AuditService } from './app/backend/src/modules/core/audit-service.ts';
import { FileService } from './app/backend/src/modules/core/file-service.ts';
import { createCoreRepositories } from './app/backend/src/modules/core/repositories.ts';
import { UnitOfWork } from './app/backend/src/storage/unit-of-work.ts';

const round = Number(process.env.RECOVERY_ROUND);
const dataDir = process.env.RECOVERY_DATA_DIR;
if (!Number.isInteger(round) || round < 1 || !dataDir) throw new Error('invalid recovery test input');

const engine = new LmdbStorageEngine({ path: dataDir + '/store/lmdb' });
await engine.open();
const repos = createCoreRepositories(engine);
const uow = new UnitOfWork(engine);
const audit = new AuditService(repos, uow);
const files = new FileService(dataDir, repos, uow, audit);
await files.init();
const content = Buffer.from('storage recovery document bytes, round=' + round + '\\n', 'utf8');
async function* chunks() { yield content; }
const file = await files.save({
  stream: chunks(),
  filename: 'recovery-round-' + round + '.txt',
  mimetype: 'text/plain',
  uploadedBy: 'recovery-actor',
  maxBytes: 1024,
  requestId: 'recovery-file-' + round,
});

const taskId = 'recovery-task-' + round;
const documentId = 'recovery-document-' + round;
await uow.run(async (tx) => {
  tx.put('tasks', taskId, { id: taskId, kind: 'storage-recovery-task', round });
  tx.put('documents', documentId, {
    id: documentId,
    kind: 'storage-recovery-document',
    round,
    taskId,
    fileId: file.id,
    fileSha256: file.sha256,
    fileStorageKey: file.storageKey,
  });
  tx.put('counters', 'storageRecoveryTaskCount', round);
  await audit.append({
    actorUserId: 'recovery-actor',
    action: 'storage-recovery.committed',
    resourceType: 'document',
    resourceId: documentId,
    requestId: 'recovery-commit-' + round,
  }, tx);
});
process.stdout.write('COMMITTED:' + round + '\\n');

await uow.run(async (tx) => {
  tx.put('tasks', 'inflight-task-' + round, { id: 'inflight-task-' + round, kind: 'inflight', round });
  tx.put('documents', 'inflight-document-' + round, { id: 'inflight-document-' + round, kind: 'inflight', round });
  tx.put('counters', 'storageRecoveryTaskCount', round + 1000);
  await audit.append({
    actorUserId: 'recovery-actor',
    action: 'storage-recovery.inflight',
    resourceType: 'document',
    resourceId: 'inflight-document-' + round,
    requestId: 'recovery-inflight-' + round,
  }, tx);
  process.stdout.write('CHECKPOINT:' + round + '\\n');
  await new Promise(() => undefined);
});
`;
}

async function killAtCheckpoint(dataDir: string, round: number): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childProgram()], {
    cwd: process.cwd(),
    env: { ...process.env, RECOVERY_DATA_DIR: dataDir, RECOVERY_ROUND: String(round) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const exited = once(child, 'exit');
  const checkpoint = new Promise<void>((resolveCheckpoint, rejectCheckpoint) => {
    const timer = setTimeout(() => rejectCheckpoint(new Error(`child did not reach checkpoint ${round}: ${stderr}`)), 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(`CHECKPOINT:${round}`)) {
        clearTimeout(timer);
        resolveCheckpoint();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectCheckpoint(error);
    });
    child.once('exit', (code, signal) => {
      if (!stdout.includes(`CHECKPOINT:${round}`)) {
        clearTimeout(timer);
        rejectCheckpoint(new Error(`child exited before checkpoint ${round}: code=${code} signal=${signal}; ${stderr}`));
      }
    });
  });

  try {
    await checkpoint;
    expect(stdout).toContain(`COMMITTED:${round}`);
    expect(child.kill('SIGKILL')).toBe(true);
    const [code] = await exited;
    expect(code).not.toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
  }
}

async function verifyRecoveredRound(dataDir: string, expectedRounds: number): Promise<void> {
  const engine = new LmdbStorageEngine({ path: join(dataDir, 'store', 'lmdb') });
  await engine.open();
  try {
    const repos = createCoreRepositories(engine);
    const audit = new AuditService(repos, new UnitOfWork(engine));
    const files = new FileService(dataDir, repos, new UnitOfWork(engine), audit);
    const recovered = await engine.transaction((tx) => ({
      tasks: tx.range<RecoveryTask>('tasks', {}),
      documents: tx.range<RecoveryDocument>('documents', {}),
      counter: tx.get<number>('counters', 'storageRecoveryTaskCount'),
      auditActions: tx.range<{ action: string }>('audit_logs', {}).map((entry) => entry.value.action),
    }));

    expect(recovered.counter).toBe(expectedRounds);
    expect(recovered.tasks.map((entry) => entry.value.round).sort((left, right) => left - right)).toEqual(
      Array.from({ length: expectedRounds }, (_, index) => index + 1),
    );
    expect(recovered.tasks.some((entry) => entry.key.startsWith('inflight-'))).toBe(false);
    expect(recovered.documents.map((entry) => entry.value.round).sort((left, right) => left - right)).toEqual(
      Array.from({ length: expectedRounds }, (_, index) => index + 1),
    );
    expect(recovered.documents.some((entry) => entry.key.startsWith('inflight-'))).toBe(false);
    expect(recovered.auditActions).toHaveLength(expectedRounds * 2);
    expect(recovered.auditActions.filter((action) => action === 'file.uploaded')).toHaveLength(expectedRounds);
    expect(recovered.auditActions.filter((action) => action === 'storage-recovery.committed')).toHaveLength(expectedRounds);
    expect(recovered.auditActions).not.toContain('storage-recovery.inflight');
    expect(await audit.verifyChain()).toBe(true);

    for (const entry of recovered.documents) {
      const document = entry.value;
      const expectedContent = contentFor(document.round);
      const file = await repos.files.get(document.fileId);
      expect(file).toBeDefined();
      expect(document.fileSha256).toBe(sha256(expectedContent));
      expect(file?.sha256).toBe(document.fileSha256);
      expect(file?.storageKey).toBe(document.fileStorageKey);
      expect(await readFile(await files.pathFor(file!))).toEqual(expectedContent);
    }
  } finally {
    await engine.close();
  }
}

describe('storage recovery', () => {
  it('preserves committed task, audit, counter, document-record, and file bytes across three deterministic kills', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'collab-office-storage-recovery-'));
    temporaryDirectories.push(dataDir);

    for (const round of [1, 2, 3]) {
      await killAtCheckpoint(dataDir, round);
      await verifyRecoveredRound(dataDir, round);
    }
  });
});
