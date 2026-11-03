import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { UnitOfWork } from '../src/storage/unit-of-work.js';
import { createCoreRepositories, seedCoreData } from '../src/modules/core/repositories.js';
import { createProjectRepositories } from '../src/modules/projects/project-service.js';
import { createOrganizationRepositories } from '../src/modules/organization/repositories.js';
import { createDocumentRepositories } from '../src/modules/documents/repositories.js';
import { DocumentService } from '../src/modules/documents/document-service.js';
import { registerDocumentRoutes } from '../src/modules/documents/routes.js';
import { AuditService } from '../src/modules/core/audit-service.js';
import { AuthService, type AuthContext } from '../src/modules/core/auth-service.js';
import { FileService } from '../src/modules/core/file-service.js';
import { AppError } from '../src/shared/errors.js';
import { ProjectService } from '../src/modules/projects/project-service.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture(): Promise<{
  dir: string; engine: LmdbStorageEngine; core: ReturnType<typeof createCoreRepositories>; repos: ReturnType<typeof createDocumentRepositories>;
  projects: ReturnType<typeof createProjectRepositories>; departments: ReturnType<typeof createOrganizationRepositories>['departments']; uow: UnitOfWork;
  audit: AuditService; auth: AuthService; files: FileService; service: DocumentService; owner: AuthContext; other: AuthContext; admin: AuthContext;
  stage: (who?: AuthContext, text?: string, filename?: string) => Promise<import('../src/modules/core/file-service.js').StagedUpload>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-documents-'));
  const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') }); await engine.open();
  cleanups.push(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  const core = createCoreRepositories(engine); await seedCoreData(core);
  const uow = new UnitOfWork(engine); const audit = new AuditService(core, uow); const auth = new AuthService(core, uow, audit);
  const files = new FileService(dir, core, uow, audit); await files.init();
  const repos = createDocumentRepositories(engine, core); const projects = createProjectRepositories(engine, core);
  const departments = createOrganizationRepositories(engine).departments;
  const service = new DocumentService(repos, core, projects, departments, uow, auth, audit, files);
  const role = await core.roles.getByUniqueIndex('idx_roles_code', 'member'); const adminRole = await core.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
  if (!role || !adminRole) throw new Error('missing seed roles');
  const permissions = ['document:read', 'document:create', 'document:update', 'document:version:create', 'document:delete', 'document:acl:manage'];
  const memberRole = await core.roles.update(role.id, role.version, (current) => ({ ...current, permissionCodes: [...new Set([...current.permissionCodes, ...permissions])] }));
  async function actor(name: string, admin = false): Promise<AuthContext> {
    const currentRole = admin ? adminRole! : memberRole;
    const user = await core.users.create({ name, email: 'document.' + name, passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [currentRole.id], departmentId: null });
    const session = await core.sessions.create({ userId: user.id, tokenHash: createHash('sha256').update(name).digest('hex'), csrfToken: 'x'.repeat(32), idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', revokedAt: null });
    return { user, session, roles: [currentRole], permissions: currentRole.permissionCodes };
  }
  const owner = await actor('owner'); const other = await actor('other'); const admin = await actor('admin', true);
  async function stage(who = owner, text = 'document content', filename = 'manual.txt'): Promise<import('../src/modules/core/file-service.js').StagedUpload> {
    return files.stage({ stream: (async function* (): AsyncGenerator<Buffer> { yield Buffer.from(text); })(), filename, mimetype: 'text/plain', uploadedBy: who.user.id, maxBytes: 1024 });
  }
  return { dir, engine, core, repos, projects, departments, uow, audit, auth, files, service, owner, other, admin, stage };
}
describe('document center against real isolated LMDB', () => {
  it('searches only the current bounded text index after applying document ACL', async () => {
    const f = await fixture();
    const created = await f.service.create(f.owner, await f.stage(f.owner, 'confidential needle alpha', 'notes.txt'), { title: 'Operations notes' });
    expect((await f.service.search(f.owner, { q: 'needle alpha' })).data.map((item) => item.id)).toEqual([created.document.id]);
    expect((await f.service.search(f.other, { q: 'needle alpha' })).meta.total).toBe(0);
    await f.service.appendVersion(f.owner, created.document.id, await f.stage(f.owner, 'replacement wording beta', 'notes.txt'), { version: created.document.version });
    expect((await f.service.search(f.owner, { q: 'needle alpha' })).meta.total).toBe(0);
    expect((await f.service.search(f.owner, { q: 'wording beta' })).data.map((item) => item.id)).toEqual([created.document.id]);
    expect(await f.audit.verifyChain()).toBe(true);
  });
  it('previews only authenticated PDF and image versions, preserving ACL checks and a distinct audit event', async () => {
    const f = await fixture();
    const pdf = await f.files.stage({
      stream: (async function* (): AsyncGenerator<Buffer> { yield Buffer.from('%PDF-1.7\npreview'); })(),
      filename: 'preview.pdf', mimetype: 'application/pdf', uploadedBy: f.owner.user.id, maxBytes: 1024,
    });
    const created = await f.service.create(f.owner, pdf, { title: 'Previewable document' });
    const preview = await f.service.preview(f.owner, created.document.id, null);
    expect(preview).toMatchObject({ fileName: 'preview.pdf', mime: 'application/pdf' });
    expect(await readFile(preview.path, 'utf8')).toContain('%PDF-1.7');
    await expect(f.service.preview(f.other, created.document.id, null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const text = await f.service.create(f.owner, await f.stage(), { title: 'Download-only document' });
    await expect(f.service.preview(f.owner, text.document.id, null)).rejects.toMatchObject({ code: 'FILE_TYPE_UNSUPPORTED' });
    const logs = await f.core.auditLogs.list({ page: 1, pageSize: 100 });
    expect(logs.items.some((entry) => entry.action === 'document.previewed' && entry.resourceId === created.document.id)).toBe(true);
    expect(await f.audit.verifyChain()).toBe(true);
  });
  it('checks current ACL for search and all versions, even when a caller uploaded the same content', async () => {
    const f = await fixture();
    const a = await f.service.create(f.owner, await f.stage(), { title: 'Restricted handbook' });
    const b = await f.service.create(f.other, await f.stage(f.other, 'document content', 'other-name.txt'), { title: 'Another handbook' });
    expect(a.version.fileId).toBe(b.version.fileId);
    expect(b.version.fileName).toBe('other-name.txt');
    expect((await f.service.search(f.other, { q: 'Restricted' })).meta.total).toBe(0);
    await expect(f.service.download(f.other, a.document.id, a.version.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const grant = await f.service.putGrant(f.owner, a.document.id, { subjectType: 'user', subjectId: f.other.user.id, permission: 'edit', includeDescendants: false });
    const appended = await f.service.appendVersion(f.other, a.document.id, await f.stage(f.other, 'second', 'second.txt'), { version: a.document.version, note: 'update' });
    expect(appended.versionNo).toBe(2);
    expect(await readFile((await f.service.download(f.other, a.document.id, a.version.id)).path, 'utf8')).toBe('document content');
    await f.service.revokeGrant(f.owner, a.document.id, grant.id);
    await expect(f.service.download(f.other, a.document.id, appended.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.download(f.owner, a.document.id, b.version.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await f.audit.verifyChain()).toBe(true);
  });
  it('serializes competing versions and rolls back the losing file reference and audit', async () => {
    const f = await fixture(); const created = await f.service.create(f.owner, await f.stage(), { title: 'Concurrency' });
    const first = await f.stage(f.owner, 'first new'); const second = await f.stage(f.owner, 'second new');
    const results = await Promise.allSettled([f.service.appendVersion(f.owner, created.document.id, first, { version: created.document.version }), f.service.appendVersion(f.owner, created.document.id, second, { version: created.document.version })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')[0]).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
    expect((await f.service.versions(f.owner, created.document.id)).map((version) => version.versionNo)).toEqual([1, 2]);
    expect((await f.core.files.list({ page: 1, pageSize: 100 })).total).toBe(2);
    expect(await readdir(join(f.dir, 'tmp'))).toEqual([]);
    expect((await f.files.verify()).ok).toBe(true); expect(await f.audit.verifyChain()).toBe(true);
  });
  it('restores a historical version as a new version with atomic reference and audit updates', async () => {
    const f = await fixture();
    const first = await f.service.create(f.owner, await f.stage(f.owner, 'original'), { title: 'Restorable guide' });
    await f.service.appendVersion(f.owner, first.document.id, await f.stage(f.owner, 'newer'), { version: first.document.version, note: 'newer' });
    const fileBefore = await f.core.files.require(first.version.fileId);
    const currentAfterSecond = await f.service.get(f.owner, first.document.id);
    const restored = await f.service.restoreVersion(f.owner, first.document.id, first.version.id, { version: currentAfterSecond.version });
    expect(restored.versionCount).toBe(3);
    expect(restored.currentVersionId).not.toBe(first.version.id);
    expect((await f.service.versions(f.owner, first.document.id)).map((version) => version.versionNo)).toEqual([1, 2, 3]);
    const history = await f.service.versions(f.owner, first.document.id);
    expect(history[0]?.fileName).toBe(first.version.fileName);
    expect(history[2]?.versionNote).toContain('恢复自 V1');
    expect(await readFile((await f.service.download(f.owner, first.document.id, restored.currentVersionId)).path, 'utf8')).toBe('original');
    expect((await f.core.files.require(fileBefore.id)).refCount).toBe(fileBefore.refCount + 1);
    const logs = await f.core.auditLogs.list({ page: 1, pageSize: 100 });
    expect(logs.items.some((entry) => entry.action === 'document.version_restored' && entry.resourceId === first.document.id && entry.metadata.sourceVersionId === first.version.id)).toBe(true);
    await f.service.putGrant(f.owner, first.document.id, { subjectType: 'user', subjectId: f.other.user.id, permission: 'view', includeDescendants: false });
    await expect(f.service.restoreVersion(f.other, first.document.id, first.version.id, { version: restored.version })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.service.archive(f.owner, first.document.id, restored.version);
    await expect(f.service.restoreVersion(f.owner, first.document.id, first.version.id, { version: (await f.service.get(f.owner, first.document.id)).version })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('enforces category hierarchy and uniqueness, tag linkage and filtered visibility before pagination', async () => {
    const f = await fixture(); const parent = await f.service.saveCategory(f.admin, null, null, { name: 'Guides' });
    const child = await f.service.saveCategory(f.admin, null, null, { name: 'Team guides', parentId: parent.id });
    await expect(f.service.saveCategory(f.admin, parent.id, parent.version, { name: 'Guides', parentId: child.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(f.service.saveCategory(f.admin, null, null, { name: 'guides' })).rejects.toMatchObject({ status: 409 });
    let cursor = child.id;
    for (let n = 3; n <= 5; n += 1) cursor = (await f.service.saveCategory(f.admin, null, null, { name: 'Level ' + n, parentId: cursor })).id;
    await expect(f.service.saveCategory(f.admin, null, null, { name: 'Level six', parentId: cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const tag = await f.service.saveTag(f.admin, null, null, { name: 'Release', color: 'green' });
    await expect(f.service.saveTag(f.admin, null, null, { name: 'release' })).rejects.toMatchObject({ status: 409 });
    const created = await f.service.create(f.owner, await f.stage(), { title: 'Visible guide', categoryId: child.id, tagIds: [tag.id], visibility: 'organization' });
    await f.service.create(f.owner, await f.stage(), { title: 'Secret guide', categoryId: child.id, tagIds: [tag.id] });
    const result = await f.service.search(f.other, { categoryId: parent.id, tagIds: [tag.id], q: 'guide', pageSize: 1 });
    expect(result.meta.total).toBe(1); expect(result.data[0]?.id).toBe(created.document.id);
    await expect(f.service.deleteCategory(f.admin, child.id, child.version)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await f.service.deleteTag(f.admin, tag.id, tag.version);
    expect((await f.service.get(f.owner, created.document.id)).tagIds).toEqual([]);
    expect((await f.service.search(f.other, { tagIds: [tag.id] })).meta.total).toBe(0);
    await expect(f.service.saveTag(f.owner, null, null, { name: 'Denied' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('protects archived content and retains historical bytes after soft deletion', async () => {
    const f = await fixture(); const created = await f.service.create(f.owner, await f.stage(), { title: 'Archive me' });
    const archived = await f.service.archive(f.owner, created.document.id, created.document.version);
    expect((await f.service.search(f.owner)).meta.total).toBe(0); expect((await f.service.search(f.owner, { archived: true })).meta.total).toBe(1);
    await expect(f.service.update(f.owner, archived.id, { version: archived.version, title: 'Changed' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(f.service.putGrant(f.owner, archived.id, { subjectType: 'user', subjectId: f.other.user.id, permission: 'view', includeDescendants: false })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await f.service.remove(f.owner, archived.id, archived.version);
    await expect(f.service.download(f.owner, archived.id, created.version.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const retained = await f.core.files.require(created.version.fileId); expect(retained.refCount).toBe(1);
    expect(await readFile(await f.files.pathFor(retained), 'utf8')).toBe('document content');
  });
  it('applies batch operations independently with manage checks, version locks and atomic audits', async () => {
    const f = await fixture();
    const category = await f.service.saveCategory(f.admin, null, null, { name: 'Batch folder' });
    const existingTag = await f.service.saveTag(f.admin, null, null, { name: 'Existing' });
    const addedTag = await f.service.saveTag(f.admin, null, null, { name: 'New' });
    const owned = await f.service.create(f.owner, await f.stage(), { title: 'Batch owned', tagIds: [existingTag.id] });
    const inaccessible = await f.service.create(f.other, await f.stage(f.other), { title: 'Private document' });

    const second = await f.service.create(f.owner, await f.stage(f.owner, 'second document'), { title: 'Batch second' });
    const mixed = await f.service.batch(f.owner, {
      operation: 'move_category', categoryId: category.id,
      items: [
        { id: owned.document.id, version: owned.document.version },
        { id: second.document.id, version: second.document.version + 1 },
        { id: inaccessible.document.id, version: inaccessible.document.version },
      ],
    });
    expect(mixed).toMatchObject({ succeeded: 1, failed: 2 });
    expect(mixed.results.map((item) => item.success ? 'ok' : item.code)).toEqual(['ok', 'VERSION_CONFLICT', 'NOT_FOUND']);
    const movedDocument = await f.service.get(f.owner, owned.document.id);
    expect(movedDocument.categoryId).toBe(category.id);
    expect(movedDocument.version).toBe(owned.document.version + 1);
    expect((await f.service.get(f.owner, second.document.id)).categoryId).toBeNull();

    const readerRole = await f.core.roles.create({ code: 'document_reader', name: '文档只读', description: '', dataScope: 'all', permissionCodes: ['document:read'], system: false });
    const readerUser = await f.core.users.create({ name: '只读所有者', email: 'document.reader', passwordHash: 'x'.repeat(30), status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: null, failedLoginCount: 0, lockedUntil: null, roleIds: [readerRole.id], departmentId: null });
    const readerSession = await f.core.sessions.create({ userId: readerUser.id, tokenHash: createHash('sha256').update('document.reader').digest('hex'), csrfToken: 'x'.repeat(32), idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', revokedAt: null });
    const reader: AuthContext = { user: readerUser, session: readerSession, roles: [readerRole], permissions: readerRole.permissionCodes };
    const readerOwned = await f.service.create(f.owner, await f.stage(), { title: 'Reader ACL document' });
    await f.service.putGrant(f.owner, readerOwned.document.id, { subjectType: 'user', subjectId: readerUser.id, permission: 'manage', includeDescendants: false });
    const noManage = await f.service.batch(reader, { operation: 'archive', items: [{ id: readerOwned.document.id, version: readerOwned.document.version }] });
    expect(noManage.results[0]).toMatchObject({ success: false, code: 'FORBIDDEN' });
    expect((await f.service.get(f.owner, readerOwned.document.id)).status).toBe('active');

    const tagged = await f.service.batch(f.owner, { operation: 'add_tags', tagIds: [addedTag.id], items: [{ id: owned.document.id, version: movedDocument.version }] });
    expect(tagged).toMatchObject({ succeeded: 1, failed: 0 });
    const afterTag = await f.service.get(f.owner, owned.document.id);
    expect(new Set(afterTag.tagIds)).toEqual(new Set([existingTag.id, addedTag.id]));

    const archived = await f.service.batch(f.owner, { operation: 'archive', items: [{ id: owned.document.id, version: afterTag.version }] });
    expect(archived).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await f.service.get(f.owner, owned.document.id)).status).toBe('archived');
    const logs = await f.core.auditLogs.list({ page: 1, pageSize: 100 });
    expect(logs.items.filter((entry) => entry.action.startsWith('document.batch_') && entry.resourceId === owned.document.id)).toHaveLength(3);
    expect(await f.audit.verifyChain()).toBe(true);
  });
  it('rolls back a batch item if its audit append fails and caps requests at 100 items', async () => {
    const f = await fixture();
    const created = await f.service.create(f.owner, await f.stage(), { title: 'Atomic batch' });
    vi.spyOn(f.audit, 'append').mockRejectedValueOnce(new Error('forced audit failure'));
    const failed = await f.service.batch(f.owner, { operation: 'archive', items: [{ id: created.document.id, version: created.document.version }] });
    expect(failed).toMatchObject({ succeeded: 0, failed: 1, results: [{ success: false, code: 'INTERNAL_ERROR' }] });
    expect((await f.service.get(f.owner, created.document.id)).status).toBe('active');
    expect((await f.service.get(f.owner, created.document.id)).version).toBe(created.document.version);

    const tooMany = Array.from({ length: 101 }, (_, index) => ({ id: `019a44cc-0000-7000-8000-${index.toString(16).padStart(12, '0')}`, version: 1 }));
    await expect(f.service.batch(f.owner, { operation: 'archive', items: tooMany })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('revalidates role/department grants and a linked private project on every access', async () => {
    const f = await fixture();
    const created = await f.service.create(f.owner, await f.stage(), { title: 'Department guide' });
    const parent = await f.departments.create({ name: 'Parent', code: null, parentId: null, managerId: null, description: '', sortOrder: 0 });
    const child = await f.departments.create({ name: 'Child', code: null, parentId: parent.id, managerId: null, description: '', sortOrder: 0 });
    await f.core.users.update(f.other.user.id, f.other.user.version, (user) => ({ ...user, departmentId: child.id }));
    await f.service.putGrant(f.owner, created.document.id, { subjectType: 'department', subjectId: parent.id, permission: 'view', includeDescendants: true });
    expect((await f.service.get(f.other, created.document.id)).level).toBe('view');
    const user = await f.core.users.require(f.other.user.id); await f.core.users.update(user.id, user.version, (value) => ({ ...value, departmentId: null }));
    await expect(f.service.get(f.other, created.document.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await f.service.putGrant(f.owner, created.document.id, { subjectType: 'role', subjectId: f.other.roles[0]!.id, permission: 'edit', includeDescendants: false });
    expect((await f.service.get(f.other, created.document.id)).level).toBe('edit');
    await expect(f.service.putGrant(f.owner, created.document.id, { subjectType: 'user', subjectId: f.owner.user.id, permission: 'view', includeDescendants: false })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const projects = new ProjectService(f.projects, f.core, f.uow, f.auth, f.audit);
    const project = await projects.create(f.owner, { name: 'Private docs', key: 'DOCS', description: '', visibility: 'private' }, { actorUserId: f.owner.user.id, action: 'project.create', resourceType: 'project' });
    const linked = await f.service.create(f.owner, await f.stage(), { title: 'Private project guide', projectId: project.id, visibility: 'organization' });
    await f.service.putGrant(f.owner, linked.document.id, { subjectType: 'user', subjectId: f.other.user.id, permission: 'manage', includeDescendants: false });
    await expect(f.service.get(f.other, linked.document.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.get(f.admin, linked.document.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('serves the registrar with authenticated multipart uploads and safe version downloads', async () => {
    const f = await fixture(); const app = Fastify(); await app.register(multipart);
    app.setErrorHandler((error, _request, reply) => {
      const problem = error instanceof AppError ? error : error instanceof ZodError ? new AppError('VALIDATION_FAILED') : new AppError('INTERNAL_ERROR');
      void reply.code(problem.status).send(problem.toProblem());
    });
    registerDocumentRoutes(app, { service: f.service, files: f.files, maxUploadBytes: 1024,
      requireAuth: async (request) => { const token = request.headers['x-test-token']; if (typeof token !== 'string') throw new AppError('UNAUTHENTICATED'); request.authContext = await f.auth.loadContext(token); },
      requireCsrf: async (request) => { if (request.headers.origin !== 'http://127.0.0.1' || request.headers['x-csrf-token'] !== request.authContext?.session.csrfToken) throw new AppError('CSRF_INVALID'); },
    });
    cleanups.push(() => app.close());
    const headers = { 'x-test-token': 'owner', origin: 'http://127.0.0.1', 'x-csrf-token': f.owner.session.csrfToken };
    const multipartBody = (fields: unknown, filename = 'my file.txt', content = 'route content'): string => '--doc-boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n' + JSON.stringify(fields) + '\r\n--doc-boundary\r\nContent-Disposition: form-data; name="file"; filename="' + filename + '"\r\nContent-Type: text/plain\r\n\r\n' + content + '\r\n--doc-boundary--\r\n';
    expect((await app.inject({ url: '/api/v1/documents' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/documents', headers: { 'x-test-token': 'owner' } })).statusCode).toBe(403);
    const uploaded = await app.inject({ method: 'POST', url: '/api/v1/documents', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=doc-boundary' }, payload: multipartBody({ title: 'Route manual' }) });
    expect(uploaded.statusCode, uploaded.body).toBe(201); const doc = uploaded.json().data as { id: string };
    const versions = await app.inject({ url: '/api/v1/documents/' + doc.id + '/versions', headers }); expect(versions.statusCode).toBe(200); expect(versions.body).not.toContain('fileId');
    const download = await app.inject({ url: '/api/v1/documents/' + doc.id + '/download', headers });
    expect(download.statusCode).toBe(200); expect(download.body).toBe('route content'); expect(download.headers['content-disposition']).toContain('attachment;'); expect(download.headers['cache-control']).toBe('private, no-store');
    const textPreview = await app.inject({ url: '/api/v1/documents/' + doc.id + '/preview', headers });
    expect(textPreview.statusCode).toBe(415);
    const previewUpload = await f.files.stage({
      stream: (async function* (): AsyncGenerator<Buffer> { yield Buffer.from('%PDF-1.7\nroute preview'); })(),
      filename: 'route-preview.pdf', mimetype: 'application/pdf', uploadedBy: f.owner.user.id, maxBytes: 1024,
    });
    const previewDocument = await f.service.create(f.owner, previewUpload, { title: 'Route preview' });
    const preview = await app.inject({ url: '/api/v1/documents/' + previewDocument.document.id + '/preview', headers });
    expect(preview.statusCode).toBe(200); expect(preview.body).toContain('%PDF-1.7'); expect(preview.headers['content-disposition']).toContain('inline;'); expect(preview.headers['cache-control']).toBe('private, no-store'); expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject({ url: '/api/v1/documents/' + previewDocument.document.id + '/preview', headers: { 'x-test-token': 'other' } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/documents/' + doc.id + '/download', headers: { 'x-test-token': 'other' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/documents', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=doc-boundary' }, payload: multipartBody({ title: 'x' }) })).statusCode).toBe(422);
    const initialVersions = versions.json().data as { id: string; versionNo: number }[];
    const current = (await app.inject({ url: '/api/v1/documents/' + doc.id, headers })).json().data as { version: number };
    const appended = await app.inject({ method: 'POST', url: '/api/v1/documents/' + doc.id + '/versions', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=doc-boundary' }, payload: multipartBody({ version: current.version, note: 'second version' }, 'second.txt', 'second bytes') });
    expect(appended.statusCode, appended.body).toBe(201);
    const latest = (await app.inject({ url: '/api/v1/documents/' + doc.id, headers })).json().data as { version: number };
    const restored = await app.inject({ method: 'POST', url: '/api/v1/documents/' + doc.id + '/versions/' + initialVersions[0]!.id + '/restore', headers, payload: { version: latest.version, note: 'restore through route' } });
    expect(restored.statusCode, restored.body).toBe(201);
    expect((restored.json().data as { versionCount: number }).versionCount).toBe(3);
    const finalVersions = await app.inject({ url: '/api/v1/documents/' + doc.id + '/versions', headers });
    expect((finalVersions.json().data as { versionNo: number }[]).map((version) => version.versionNo)).toEqual([1, 2, 3]);
    const restoredDocument = restored.json().data as { version: number };
    const batch = await app.inject({ method: 'POST', url: '/api/v1/documents/batch', headers, payload: { operation: 'archive', items: [{ id: doc.id, version: restoredDocument.version }] } });
    expect(batch.statusCode, batch.body).toBe(200);
    expect(batch.json().data).toMatchObject({ succeeded: 1, failed: 0, results: [{ id: doc.id, success: true, version: restoredDocument.version + 1 }] });
    const oversized = Array.from({ length: 101 }, (_, index) => ({ id: `019a44cc-0000-7000-8000-${index.toString(16).padStart(12, '0')}`, version: 1 }));
    const rejectedBatch = await app.inject({ method: 'POST', url: '/api/v1/documents/batch', headers, payload: { operation: 'archive', items: oversized } });
    expect(rejectedBatch.statusCode).toBe(422);
    expect(await readdir(join(f.dir, 'tmp'))).toEqual([]);
  });
});
