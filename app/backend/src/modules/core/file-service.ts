import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError } from '../../shared/errors.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import type { CoreRepositories } from './repositories.js';
import type { FileDocument } from './models.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { AuditService } from './audit-service.js';
import { systemClock, type Clock } from '../../shared/clock.js';

const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// All FileService instances for a data directory share a process-local gate.
// The deployment's data-directory lock still provides cross-process exclusion.
const directoryTails = new Map<string, Promise<void>>();
const activeTemps = new Map<string, StagedData | null>();
async function withDirectoryGate<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const previous = directoryTails.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const tail = previous.then(() => current);
  directoryTails.set(directory, tail);
  await previous;
  try { return await work(); } finally {
    release();
    if (directoryTails.get(directory) === tail) directoryTails.delete(directory);
  }
}

declare const stagedBrand: unique symbol;
/** Opaque, in-process capability; never expose to HTTP clients. */
export interface StagedUpload { readonly [stagedBrand]: true }
interface StagedData {
  readonly tempPath: string;
  readonly sha256: string;
  readonly size: number;
  readonly filename: string;
  readonly mimetype: string;
  readonly uploadedBy: string;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly extension: string;
  readonly stagedAt: number;
  state: 'ready' | 'binding' | 'consumed';
}

const ALLOWED: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/markdown': 'md',
  'text/csv': 'csv',
};
const SEARCHABLE_TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv']);

export interface UploadInput {
  readonly stream: AsyncIterable<Buffer> & { readonly truncated?: boolean };
  readonly filename: string;
  readonly mimetype: string;
  readonly uploadedBy: string;
  readonly maxBytes: number;
  readonly requestId?: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface FileReconciliationReport {
  readonly ok: boolean;
  readonly activeFiles: number;
  readonly missingFiles: number;
  readonly checksumMismatches: number;
  readonly orphanFiles: number;
  readonly quarantinedOrphans: number;
  readonly pendingUploads: number;
  readonly quarantinedTemps: number;
  readonly expiredTrashEntries: number;
  readonly cleanedTrashEntries: number;
}

export class FileService {
  private readonly filesDir: string;
  private readonly tmpDir: string;
  private readonly trashDir: string;
  private readonly staged = new WeakMap<StagedUpload, StagedData>();

  constructor(dataDir: string, private readonly repos: CoreRepositories, private readonly uow: UnitOfWork, private readonly audit: AuditService, private readonly clock: Clock = systemClock) {
    this.filesDir = resolve(dataDir, 'files');
    this.tmpDir = resolve(dataDir, 'tmp');
    this.trashDir = resolve(dataDir, 'trash');
  }

  async init(): Promise<FileReconciliationReport> {
    return withDirectoryGate(this.filesDir, async () => {
      await mkdir(this.filesDir, { recursive: true });
      await mkdir(this.tmpDir, { recursive: true });
      await mkdir(this.trashDir, { recursive: true });
      return this.reconcile(true);
    });
  }

  async verify(): Promise<FileReconciliationReport> {
    return withDirectoryGate(this.filesDir, () => this.reconcile(false));
  }

  private isStorageKey(storageKey: string, sha256: string): boolean {
    return /^[a-f0-9]{64}$/u.test(sha256) && storageKey === `${sha256.slice(0, 2)}/${sha256}`;
  }

  private async checkedPath(storageKey: string): Promise<string | null> {
    const filesRoot = await realpath(this.filesDir).catch(() => null);
    if (!filesRoot) return null;
    const expected = resolve(this.filesDir, storageKey);
    const actual = await realpath(expected).catch(() => null);
    if (!actual) return null;
    const pathFromRoot = relative(filesRoot, actual);
    if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) return null;
    return actual;
  }

  private async reconcile(quarantine: boolean): Promise<FileReconciliationReport> {
    const firstPage = await this.repos.files.list({ page: 1, pageSize: 100 });
    const records: FileDocument[] = [...firstPage.items];
    const pageCount = Math.ceil(firstPage.total / 100);
    for (let page = 2; page <= pageCount; page += 1) {
      records.push(...(await this.repos.files.list({ page, pageSize: 100 })).items);
    }

    const active = records.filter((record) => record.status === 'active');
    const expectedPaths = new Set(active.filter((record) => this.isStorageKey(record.storageKey, record.sha256)).map((record) => record.storageKey));
    let missingFiles = 0;
    let checksumMismatches = 0;
    for (const file of active) {
      if (!this.isStorageKey(file.storageKey, file.sha256)) {
        checksumMismatches += 1;
        continue;
      }
      const path = await this.checkedPath(file.storageKey);
      const statResult = path ? await stat(path).catch(() => null) : null;
      if (!statResult?.isFile()) {
        missingFiles += 1;
        continue;
      }
      if (!path || statResult.size !== file.size || await this.hashFile(path) !== file.sha256) checksumMismatches += 1;
    }

    let orphanFiles = 0;
    let quarantinedOrphans = 0;
    const prefixes = await readdir(this.filesDir, { withFileTypes: true }).catch(() => []);
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
      const entries = await readdir(join(this.filesDir, prefix.name), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const storageKey = `${prefix.name}/${entry.name}`;
        if (expectedPaths.has(storageKey)) continue;
        orphanFiles += 1;
        if (quarantine) {
          const source = join(this.filesDir, prefix.name, entry.name);
          const destination = join(this.trashDir, 'orphan', String(Date.now()), prefix.name, entry.name);
          await mkdir(resolve(destination, '..'), { recursive: true });
          try {
            await rename(source, destination);
            quarantinedOrphans += 1;
          } catch {
            // Preserve the file in place; the next verify/startup pass will report it again.
          }
        }
      }
    }

    let pendingUploads = 0;
    let quarantinedTemps = 0;
    const tempEntries = await readdir(this.tmpDir, { withFileTypes: true }).catch(() => []);
    for (const entry of tempEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.upload')) continue;
      const source = join(this.tmpDir, entry.name);
      if (activeTemps.has(source)) {
        const active = activeTemps.get(source);
        // A running stream cannot be quarantined. A completed capability can
        // expire; invalidation happens before its bytes are moved.
        if (!active || active.state === 'binding' || Date.now() - active.stagedAt < 60 * 60 * 1000) {
          pendingUploads += 1;
          continue;
        }
        if (quarantine) { active.state = 'consumed'; activeTemps.delete(source); }
      }
      const statResult = await stat(source).catch(() => null);
      if (!statResult) continue;
      if (Date.now() - statResult.mtimeMs < 60 * 60 * 1000) {
        pendingUploads += 1;
        continue;
      }
      if (quarantine) {
        const destination = join(this.trashDir, 'pending', String(Date.now()), entry.name);
        await mkdir(resolve(destination, '..'), { recursive: true });
        try {
          await rename(source, destination);
          quarantinedTemps += 1;
        } catch {
          pendingUploads += 1;
        }
      } else {
        pendingUploads += 1;
      }
    }

    const trashReport = await this.reconcileTrash(this.clock.now().getTime(), quarantine);

    const unresolvedOrphans = quarantine ? orphanFiles !== quarantinedOrphans : orphanFiles > 0;
    const ok = missingFiles === 0 && checksumMismatches === 0 && !unresolvedOrphans && (quarantine || pendingUploads === 0);

    return {
      ok,
      activeFiles: active.length,
      missingFiles,
      checksumMismatches,
      orphanFiles,
      quarantinedOrphans,
      pendingUploads,
      quarantinedTemps,
      ...trashReport,
    };
  }

  private async reconcileTrash(nowMs: number, removeExpired: boolean): Promise<Pick<FileReconciliationReport, 'expiredTrashEntries' | 'cleanedTrashEntries'>> {
    let expiredTrashEntries = 0;
    let cleanedTrashEntries = 0;
    const legacyEntries = await readdir(this.trashDir, { withFileTypes: true }).catch(() => []);
    for (const entry of legacyEntries) {
      const match = /^[a-f0-9]{64}-(\d{1,13})$/u.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const createdAt = Number(match[1]);
      if (!Number.isSafeInteger(createdAt) || nowMs - createdAt < TRASH_RETENTION_MS) continue;
      expiredTrashEntries += 1;
      if (!removeExpired) continue;
      try {
        await rm(join(this.trashDir, entry.name), { force: false });
        cleanedTrashEntries += 1;
      } catch {
        // Preserve expired data if cleanup fails; a later startup can retry.
      }
    }
    for (const category of ['files', 'orphan', 'pending']) {
      const categoryPath = join(this.trashDir, category);
      const entries = await readdir(categoryPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d{1,13}$/u.test(entry.name)) continue;
        const createdAt = Number(entry.name);
        if (!Number.isSafeInteger(createdAt) || nowMs - createdAt < TRASH_RETENTION_MS) continue;
        expiredTrashEntries += 1;
        if (!removeExpired) continue;
        try {
          await rm(join(categoryPath, entry.name), { recursive: true, force: false });
          cleanedTrashEntries += 1;
        } catch {
          // Preserve expired data if cleanup fails; a later startup can retry.
        }
      }
    }
    return { expiredTrashEntries, cleanedTrashEntries };
  }

  /** Stage validated bytes without creating a file record or incrementing references. */
  async stage(input: UploadInput): Promise<StagedUpload> {
    const extension = ALLOWED[input.mimetype];
    if (!extension) throw new AppError('FILE_TYPE_UNSUPPORTED', '文件类型不支持');
    const suppliedExtension = extname(input.filename).toLowerCase();
    const acceptedExtensions = extension === 'jpg' ? ['.jpg', '.jpeg'] : [`.${extension}`];
    if (suppliedExtension && !acceptedExtensions.includes(suppliedExtension)) {
      throw new AppError('FILE_TYPE_UNSUPPORTED', '文件扩展名与声明类型不匹配');
    }
    const tempPath = join(this.tmpDir, `${randomUUID()}.upload`);
    const hash = createHash('sha256');
    let size = 0;
    activeTemps.set(tempPath, null);
    const output = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    try {
      for await (const chunk of input.stream) {
        size += chunk.length;
        if (size > input.maxBytes) throw new AppError('FILE_TOO_LARGE', '文件超过大小限制');
        hash.update(chunk);
        if (!output.write(chunk)) await new Promise<void>((resolvePromise) => output.once('drain', resolvePromise));
      }
      if (input.stream.truncated === true) throw new AppError('FILE_TOO_LARGE', '文件超过大小限制');
      if (size === 0) throw new AppError('FILE_INVALID', '不能上传空文件');
      output.end();
      await finished(output);
      const handle = await open(tempPath, 'r+');
      await handle.sync();
      const bytes = Buffer.alloc(16);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      await handle.close();
      this.validateMagic(input.mimetype, bytes.subarray(0, bytesRead));
      const sha256 = hash.digest('hex');
      const capability = Object.freeze({}) as StagedUpload;
      const data: StagedData = {
        tempPath, sha256, size, filename: input.filename, mimetype: input.mimetype,
        uploadedBy: input.uploadedBy, requestId: input.requestId ?? null, ip: input.ip ?? null,
        userAgent: input.userAgent ?? null, extension, stagedAt: Date.now(), state: 'ready',
      };
      this.staged.set(capability, data);
      activeTemps.set(tempPath, data);
      return capability;
    } catch (error) {
      output.destroy();
      await finished(output).catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      activeTemps.delete(tempPath);
      throw error;
    }
  }

  /**
   * Atomically increments the reference and invokes the owning business write in
   * the same LMDB transaction. Callback must not perform filesystem/network IO
   * or re-enter FileService. File publication precedes the transaction; startup
   * reconciliation quarantines uncommitted bytes after a process crash.
   */
  async bind<T>(upload: StagedUpload, actorId: string, write: (file: FileDocument, tx: StorageTransaction) => Promise<T>): Promise<T> {
    const staged = this.staged.get(upload);
    if (!staged || staged.state !== 'ready' || staged.uploadedBy !== actorId) throw new AppError('FORBIDDEN', '上传凭据无效');
    staged.state = 'binding';
    return withDirectoryGate(this.filesDir, async () => {
      const storageKey = `${staged.sha256.slice(0, 2)}/${staged.sha256}`;
      const finalPath = resolve(this.filesDir, storageKey);
      let createdFinal = false;
      try {
        const stagedInfo = await stat(staged.tempPath);
        if (!stagedInfo.isFile() || stagedInfo.size !== staged.size || await this.hashFile(staged.tempPath) !== staged.sha256) {
          throw new AppError('FILE_CHECKSUM_MISMATCH', '暂存文件校验失败');
        }
        await mkdir(join(this.filesDir, staged.sha256.slice(0, 2)), { recursive: true });
        const exists = await stat(finalPath).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
        if (exists) {
          if (await this.hashFile(finalPath) !== staged.sha256) throw new AppError('FILE_CHECKSUM_MISMATCH', '内容寻址文件校验失败');
          await rm(staged.tempPath);
        } else {
          await rename(staged.tempPath, finalPath);
          createdFinal = true;
        }
        return await this.uow.run(async (tx) => {
          const existing = await this.repos.files.getByUniqueIndex('idx_files_storage_key', storageKey, tx);
          const saved = existing
            ? await this.repos.files.update(existing.id, existing.version, (current) => ({ ...current, refCount: current.refCount + 1, status: 'active' }), tx)
            : await this.repos.files.create({ originalName: this.cleanName(staged.filename, staged.extension), mimeType: staged.mimetype,
                size: staged.size, sha256: staged.sha256, storageKey, refCount: 1, uploadedBy: actorId, status: 'active' } as Omit<FileDocument, keyof DocumentEnvelope>, tx);
          await this.audit.append({ actorUserId: actorId, action: 'file.uploaded', resourceType: 'file', resourceId: saved.id,
            requestId: staged.requestId, ip: staged.ip, userAgent: staged.userAgent,
            metadata: { size: saved.size, mimeType: saved.mimeType } }, tx);
          return write(saved, tx);
        });
      } catch (error) {
        // The directory gate excludes all in-process publishers and releases.
        if (createdFinal) await rm(finalPath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        staged.state = 'consumed';
        activeTemps.delete(staged.tempPath);
        await rm(staged.tempPath, { force: true }).catch(() => undefined);
      }
    });
  }

  /** Validated upload metadata, independent of the deduplicated physical file. */
  metadata(upload: StagedUpload, actorId: string): { readonly fileName: string; readonly mime: string; readonly size: number; readonly sha256: string } {
    const staged = this.staged.get(upload);
    if (!staged || staged.state !== 'ready' || staged.uploadedBy !== actorId) throw new AppError('FORBIDDEN', '上传凭据无效');
    return { fileName: this.cleanName(staged.filename, staged.extension), mime: staged.mimetype, size: staged.size, sha256: staged.sha256 };
  }

  /**
   * Extract a bounded, validated UTF-8 source text before a document write.
   * Binary and oversized files deliberately have no content index entry.
   */
  async searchTextFromStaged(upload: StagedUpload, actorId: string, maxBytes: number): Promise<string | null> {
    const staged = this.staged.get(upload);
    if (!staged || staged.state !== 'ready' || staged.uploadedBy !== actorId) throw new AppError('FORBIDDEN', '上传凭据无效');
    if (!SEARCHABLE_TEXT_MIME_TYPES.has(staged.mimetype) || staged.size > maxBytes) return null;
    return this.decodeSearchText(await readFile(staged.tempPath));
  }

  /** Extract bounded UTF-8 text from a referenced file after integrity verification. */
  async searchTextFromFile(file: FileDocument, maxBytes: number): Promise<string | null> {
    if (!SEARCHABLE_TEXT_MIME_TYPES.has(file.mimeType) || file.size > maxBytes) return null;
    return this.decodeSearchText(await readFile(await this.pathFor(file)));
  }

  /** Discard an unused staged upload. It is invalid after cancellation. */
  async discard(upload: StagedUpload, actorId: string): Promise<void> {
    const staged = this.staged.get(upload);
    if (!staged || staged.state !== 'ready' || staged.uploadedBy !== actorId) throw new AppError('FORBIDDEN', '上传凭据无效');
    staged.state = 'consumed';
    try { await rm(staged.tempPath, { force: true }); } finally { activeTemps.delete(staged.tempPath); }
  }

  async save(input: UploadInput): Promise<FileDocument> {
    const staged = await this.stage(input);
    return this.bind(staged, input.uploadedBy, async (file) => file);
  }

  async pathFor(file: FileDocument): Promise<string> {
    if (file.status !== 'active') throw new AppError('FILE_MISSING', '文件已删除');
    if (!this.isStorageKey(file.storageKey, file.sha256)) throw new AppError('FILE_MISSING', '文件路径无效');
    const expected = await this.checkedPath(file.storageKey);
    if (!expected) throw new AppError('FILE_MISSING', '文件路径无效');
    const info = await stat(expected).catch(() => null);
    if (!info || !info.isFile()) throw new AppError('FILE_MISSING', '文件不存在');
    const actual = await this.hashFile(expected);
    if (actual !== file.sha256) throw new AppError('FILE_CHECKSUM_MISMATCH', '文件校验失败');
    return expected;
  }

  async release(file: FileDocument): Promise<void> {
    return withDirectoryGate(this.filesDir, () => this.releaseUnderGate(file));
  }

  async releaseWithMutation<T>(fileId: string, mutate: (file: FileDocument, tx: StorageTransaction) => Promise<T>): Promise<T> {
    return withDirectoryGate(this.filesDir, async () => {
      const result = await this.uow.run(async (tx) => {
        const current = await this.repos.files.get(fileId, tx);
        if (!current || current.status !== 'active') throw new AppError('FILE_MISSING', '文件不存在');
        const value = await mutate(current, tx);
        const updated = await this.repos.files.update(current.id, current.version, (document) => ({ ...document, refCount: Math.max(0, document.refCount - 1), status: document.refCount <= 1 ? 'deleted' : document.status }), tx);
        return { value, file: updated };
      });
      if (result.file.status === 'deleted') {
        const source = resolve(this.filesDir, result.file.storageKey);
        const trashDir = resolve(this.dataDir(), 'trash', 'files', String(this.clock.now().getTime()));
        await mkdir(trashDir, { recursive: true });
        await rename(source, join(trashDir, `${result.file.sha256}-${randomUUID()}`)).catch(() => undefined);
      }
      return result.value;
    });
  }

  /** Retain an existing content-addressed file while atomically creating a business reference. */
  async retainWithMutation<T>(fileId: string, mutate: (file: FileDocument, tx: StorageTransaction) => Promise<T>): Promise<T> {
    return withDirectoryGate(this.filesDir, () => this.uow.run(async (tx) => {
      const current = await this.repos.files.get(fileId, tx);
      if (!current || current.status !== 'active' || current.deletedAt !== null) throw new AppError('FILE_MISSING', '文件不存在');
      const value = await mutate(current, tx);
      await this.repos.files.update(current.id, current.version, (document) => ({ ...document, refCount: document.refCount + 1, status: 'active' }), tx);
      return value;
    }));
  }

  private async releaseUnderGate(file: FileDocument): Promise<void> {
    const next = await this.uow.run(async (tx) => {
      const current = await this.repos.files.get(file.id, tx);
      if (!current) throw new AppError('NOT_FOUND', '文件不存在');
      return this.repos.files.update(current.id, current.version, (document) => ({ ...document, refCount: Math.max(0, document.refCount - 1), status: document.refCount <= 1 ? 'deleted' : document.status }), tx);
    });
    if (next.status === 'deleted') {
      const source = resolve(this.filesDir, next.storageKey);
      const trashDir = resolve(this.dataDir(), 'trash', 'files', String(this.clock.now().getTime()));
      await mkdir(trashDir, { recursive: true });
      await rename(source, join(trashDir, `${next.sha256}-${randomUUID()}`)).catch(() => undefined);
    }
  }

  private cleanName(name: string, extension: string): string {
    const clean = [...name].map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return char === '\\' || char === '/' || code < 32 || code === 127 ? '_' : char;
    }).join('').trim().slice(0, 240);
    const candidate = clean || `upload.${extension}`;
    return extname(candidate) ? candidate : `${candidate}.${extension}`;
  }

  private decodeSearchText(bytes: Buffer): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\s+/gu, ' ').trim();
    } catch {
      throw new AppError('FILE_INVALID', '文本文件不是有效 UTF-8');
    }
  }

  private validateMagic(mimetype: string, bytes: Buffer): void {
    if (mimetype === 'application/pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') throw new AppError('FILE_INVALID', 'PDF 文件头无效');
    if (mimetype === 'image/png' && bytes.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0) throw new AppError('FILE_INVALID', 'PNG 文件头无效');
    if (mimetype === 'image/jpeg' && (bytes[0] !== 0xff || bytes[1] !== 0xd8)) throw new AppError('FILE_INVALID', 'JPEG 文件头无效');
    if (mimetype.endsWith('wordprocessingml.document') && bytes.subarray(0, 2).toString() !== 'PK') throw new AppError('FILE_INVALID', 'DOCX 文件头无效');
    if ((mimetype.includes('spreadsheetml') || mimetype.includes('presentationml')) && bytes.subarray(0, 2).toString() !== 'PK') throw new AppError('FILE_INVALID', 'Office 文件头无效');
    if ((mimetype === 'text/plain' || mimetype === 'text/markdown' || mimetype === 'text/csv') && bytes.includes(0)) throw new AppError('FILE_INVALID', '文本文件包含二进制内容');
  }

  private dataDir(): string {
    return resolve(this.filesDir, '..');
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }
}
