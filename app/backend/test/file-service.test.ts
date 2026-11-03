import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/modules/core/audit-service.js';
import { FileService, type UploadInput } from '../src/modules/core/file-service.js';
import type { FileDocument } from '../src/modules/core/models.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { UnitOfWork } from '../src/storage/unit-of-work.js';

const cleanupDirs: string[] = [];
const cleanupEngines: LmdbStorageEngine[] = [];

interface FileFixture {
  readonly dir: string;
  readonly repos: ReturnType<typeof createCoreRepositories>;
  readonly files: FileService;
  readonly audit: AuditService;
  readonly uow: UnitOfWork;
}

async function createFixture(): Promise<FileFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-office-file-service-'));
  cleanupDirs.push(dir);
  const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
  await engine.open();
  cleanupEngines.push(engine);
  const repos = createCoreRepositories(engine);
  const uow = new UnitOfWork(engine);
  const audit = new AuditService(repos, uow);
  const files = new FileService(dir, repos, uow, audit);
  await files.init();
  return { dir, repos, files, audit, uow };
}

function input(content: Buffer, overrides: Partial<Omit<UploadInput, 'stream'>> = {}): UploadInput {
  return {
    stream: (async function* (): AsyncGenerator<Buffer> {
      yield content;
    })(),
    filename: 'upload.txt',
    mimetype: 'text/plain',
    uploadedBy: 'test-user',
    maxBytes: 1024,
    ...overrides,
  };
}

async function tempUploads(dir: string): Promise<string[]> {
  return (await readdir(join(dir, 'tmp'))).filter((entry) => entry.endsWith('.upload'));
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const engine of cleanupEngines.splice(0).reverse()) {
    try {
      await engine.close();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const dir of cleanupDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, '文件服务测试清理失败');
});

describe('FileService storage boundaries', () => {
  it('removes temporary bytes and creates no metadata when a source stream fails or is truncated', async () => {
    const { dir, repos, files } = await createFixture();
    const failedStream = (async function* (): AsyncGenerator<Buffer> {
      yield Buffer.from('first chunk');
      throw new Error('source disconnected');
    })();
    await expect(files.save({ ...input(Buffer.alloc(0)), stream: failedStream })).rejects.toThrow(
      'source disconnected',
    );

    const truncatedStream = Object.assign(
      (async function* (): AsyncGenerator<Buffer> {
        yield Buffer.from('incomplete content');
      })(),
      { truncated: true },
    );
    await expect(
      files.save({ ...input(Buffer.alloc(0)), stream: truncatedStream }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await tempUploads(dir)).toEqual([]);
    expect((await repos.files.list({ page: 1, pageSize: 10 })).total).toBe(0);
  });

  it('rejects magic-header failures after streaming and compensates the temporary file', async () => {
    const { dir, repos, files } = await createFixture();
    await expect(
      files.save(
        input(Buffer.from('not a PDF'), { filename: 'contract.pdf', mimetype: 'application/pdf' }),
      ),
    ).rejects.toMatchObject({ code: 'FILE_INVALID' });
    await expect(
      files.save(
        input(Buffer.from('contains\0binary'), { filename: 'notes.csv', mimetype: 'text/csv' }),
      ),
    ).rejects.toMatchObject({ code: 'FILE_INVALID' });
    expect(await tempUploads(dir)).toEqual([]);
    expect((await repos.files.list({ page: 1, pageSize: 10 })).total).toBe(0);
  });

  it('adopts a correct content-addressed file left before metadata commit but rejects a corrupt collision', async () => {
    const { dir, repos, files } = await createFixture();
    const content = Buffer.from('recovered content-addressed bytes');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const finalPath = join(dir, 'files', sha256.slice(0, 2), sha256);
    await mkdir(join(dir, 'files', sha256.slice(0, 2)), { recursive: true });
    await writeFile(finalPath, content);

    const adopted = await files.save(input(content, { filename: 'recovered.txt' }));
    expect(adopted.sha256).toBe(sha256);
    expect(adopted.refCount).toBe(1);
    expect(await readFile(finalPath)).toEqual(content);

    const collisionContent = Buffer.from('expected content');
    const collisionHash = createHash('sha256').update(collisionContent).digest('hex');
    const collisionPath = join(dir, 'files', collisionHash.slice(0, 2), collisionHash);
    await mkdir(join(dir, 'files', collisionHash.slice(0, 2)), { recursive: true });
    await writeFile(collisionPath, Buffer.from('different bytes'));
    await expect(
      files.save(input(collisionContent, { filename: 'collision.txt' })),
    ).rejects.toMatchObject({ code: 'FILE_CHECKSUM_MISMATCH' });
    expect(await readFile(collisionPath)).toEqual(Buffer.from('different bytes'));
    expect(await tempUploads(dir)).toEqual([]);
    expect((await repos.files.list({ page: 1, pageSize: 10 })).total).toBe(1);
  });

  it('removes a newly placed content file when the metadata and audit transaction fails', async () => {
    const { dir, repos, audit, uow } = await createFixture();
    const content = Buffer.from('transaction rollback content');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const finalPath = join(dir, 'files', sha256.slice(0, 2), sha256);
    const failingAudit = new Proxy(audit, {
      get(target, property, receiver) {
        if (property === 'append')
          return async () => {
            throw new Error('audit unavailable');
          };
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const failingFiles = new FileService(dir, repos, uow, failingAudit);

    await expect(failingFiles.save(input(content))).rejects.toThrow('audit unavailable');

    expect(await tempUploads(dir)).toEqual([]);
    await expect(readFile(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await repos.files.list({ page: 1, pageSize: 10 })).total).toBe(0);
    expect((await repos.auditLogs.list({ page: 1, pageSize: 10 })).total).toBe(0);
  });

  it('rejects invalid, missing, and modified paths before returning a download path', async () => {
    const { dir, files } = await createFixture();
    const saved = await files.save(input(Buffer.from('original file content')));
    const invalidKey: FileDocument = { ...saved, storageKey: `../../${saved.sha256}` };
    await expect(files.pathFor(invalidKey)).rejects.toMatchObject({ code: 'FILE_MISSING' });

    await rm(join(dir, 'files', saved.storageKey));
    await expect(files.pathFor(saved)).rejects.toMatchObject({ code: 'FILE_MISSING' });
    await mkdir(join(dir, 'files', saved.sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(dir, 'files', saved.storageKey), 'tampered file content');
    await expect(files.pathFor(saved)).rejects.toMatchObject({ code: 'FILE_CHECKSUM_MISMATCH' });
  });

  it('reports active content with size or checksum mismatches during read-only verification', async () => {
    const { dir, repos, files } = await createFixture();
    const sizeMismatch = await files.save(input(Buffer.from('original bytes')));
    const checksumMismatch = await files.save(input(Buffer.from('same size bytes')));
    await writeFile(join(dir, 'files', sizeMismatch.storageKey), 'short');
    await writeFile(join(dir, 'files', checksumMismatch.storageKey), 'same size byte!');
    await repos.files.create({
      originalName: 'invalid-key.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'a'.repeat(64),
      storageKey: `bb/${'a'.repeat(64)}`,
      refCount: 1,
      uploadedBy: 'test-user',
      status: 'active',
    } as Omit<
      FileDocument,
      'id' | 'type' | 'schemaVersion' | 'version' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >);

    const report = await files.verify();

    expect(report.ok).toBe(false);
    expect(report.missingFiles).toBe(0);
    expect(report.checksumMismatches).toBe(3);
  });

  it('fails closed when storage directories disappear and tolerates cleanup of missing content', async () => {
    const { dir, repos, files } = await createFixture();
    const saved = await files.save(input(Buffer.from('content before directory loss')));
    await rm(join(dir, 'files'), { recursive: true, force: true });
    await rm(join(dir, 'tmp'), { recursive: true, force: true });
    await rm(join(dir, 'trash'), { recursive: true, force: true });

    const report = await files.verify();
    expect(report.ok).toBe(false);
    expect(report.missingFiles).toBe(1);
    await expect(files.pathFor(saved)).rejects.toMatchObject({ code: 'FILE_MISSING' });

    await expect(files.release(saved)).resolves.toBeUndefined();
    const released = await repos.files.require(saved.id);
    expect(released.refCount).toBe(0);
    expect(released.status).toBe('deleted');
  });

  it('reports stale uploads without mutation in verify and quarantines them at startup', async () => {
    const { dir, files } = await createFixture();
    const tempPath = join(dir, 'tmp', 'stale.upload');
    const content = Buffer.from('interrupted upload bytes');
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await writeFile(tempPath, content);
    await utimes(tempPath, staleTime, staleTime);

    const verification = await files.verify();
    expect(verification.ok).toBe(false);
    expect(verification.pendingUploads).toBe(1);
    await expect(readFile(tempPath)).resolves.toEqual(content);

    const startup = await files.init();
    expect(startup.ok).toBe(true);
    expect(startup.pendingUploads).toBe(0);
    expect(startup.quarantinedTemps).toBe(1);
    const pendingDirectories = await readdir(join(dir, 'trash', 'pending'));
    const quarantinedPath = join(dir, 'trash', 'pending', pendingDirectories[0]!, 'stale.upload');
    await expect(readFile(quarantinedPath)).resolves.toEqual(content);
    expect(await tempUploads(dir)).toEqual([]);
  });

  it('sanitizes path and control characters in stored names and supplies an empty-name fallback', async () => {
    const { files } = await createFixture();
    const unsafe = await files.save(
      input(Buffer.from('unsafe name'), { filename: 'folder/private\nnotes' }),
    );
    const empty = await files.save(input(Buffer.from('empty name'), { filename: '   ' }));

    expect(unsafe.originalName).toBe('folder_private_notes.txt');
    expect(empty.originalName).toBe('upload.txt');
  });

  it('maintains duplicate references until the final release and then makes the record unavailable', async () => {
    const { dir, repos, files, audit } = await createFixture();
    const first = await files.save(input(Buffer.from('shared content')));
    const second = await files.save(
      input(Buffer.from('shared content'), { filename: 'renamed.txt' }),
    );
    expect(second.id).toBe(first.id);
    expect(second.refCount).toBe(2);

    await files.release(first);
    const retained = await repos.files.require(first.id);
    expect(retained.refCount).toBe(1);
    expect(retained.status).toBe('active');
    await expect(files.pathFor(retained)).resolves.toContain(retained.sha256);

    await files.release(second);
    const released = await repos.files.require(first.id);
    expect(released.refCount).toBe(0);
    expect(released.status).toBe('deleted');
    await expect(files.pathFor(released)).rejects.toMatchObject({ code: 'FILE_MISSING' });
    await expect(readdir(join(dir, 'trash', 'files'))).resolves.not.toEqual([]);
    expect(await audit.verifyChain()).toBe(true);
  });

  it('fails closed before quarantining files when the metadata inventory exceeds the scan bound', async () => {
    const { dir, files, uow } = await createFixture();
    const content = Buffer.from('inventory boundary content');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const storageKey = `${sha256.slice(0, 2)}/${sha256}`;
    const finalPath = join(dir, 'files', storageKey);
    await mkdir(join(dir, 'files', sha256.slice(0, 2)), { recursive: true });
    await writeFile(finalPath, content);

    const now = new Date().toISOString();
    await uow.run((tx) => {
      for (let index = 0; index < 200_000; index += 1) {
        tx.put('files', `file-${String(index).padStart(6, '0')}`, {
          id: `file-${String(index).padStart(6, '0')}`,
          type: 'file',
          schemaVersion: 1,
          version: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          originalName: `placeholder-${index}.txt`,
          mimeType: 'text/plain',
          size: 0,
          sha256: 'a'.repeat(64),
          storageKey: `aa/${'a'.repeat(64)}`,
          refCount: 0,
          uploadedBy: 'boundary-test',
          status: 'deleted',
        });
      }
      tx.put('files', 'file-200000', {
        id: 'file-200000',
        type: 'file',
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        originalName: 'boundary.txt',
        mimeType: 'text/plain',
        size: content.length,
        sha256,
        storageKey,
        refCount: 1,
        uploadedBy: 'boundary-test',
        status: 'active',
      });
    });

    await expect(files.init()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: '范围扫描超出安全上限',
    });
    await expect(readFile(finalPath)).resolves.toEqual(content);
    await expect(readdir(join(dir, 'trash', 'orphan'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});
