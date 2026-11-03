import { z } from 'zod';
import { documentCreateSchema, documentVersionInputSchema, documentGrantSchema, documentUpdateSchema, documentSearchSchema, documentCategorySchema, documentTagSchema } from '@collab/shared/schemas.js';
import type { DocumentCreateInput, DocumentUpdateInput, DocumentSearchInput, DocumentView, DocumentCategoryInput, DocumentTagInput, DocumentBatchRequest, DocumentBatchResponse } from '@collab/shared/schemas.js';
import { documentBatchRequestSchema } from '@collab/shared/schemas.js';
import type { DocumentEnvelope } from '../../storage/envelope.js';
import { AppError } from '../../shared/errors.js';
import type { StorageTransaction } from '../../storage/engine.js';
import type { UnitOfWork } from '../../storage/unit-of-work.js';
import type { Repository } from '../../storage/repository.js';
import type { DepartmentDocument } from '../organization/models.js';
import type { ProjectRepositories } from '../projects/project-service.js';
import type { CoreRepositories } from '../core/repositories.js';
import type { AuthContext, AuthService } from '../core/auth-service.js';
import type { AuditService } from '../core/audit-service.js';
import type { FileService, StagedUpload } from '../core/file-service.js';
import type { FileDocument } from '../core/models.js';
import { canAccessDocument, effectiveDocumentLevel, type DocumentAction, type DocumentPolicyActor, type LinkedProjectAccess } from './access-policy.js';
import type { Document, DocumentAcl, DocumentRepositories, DocumentVersion, DocumentCategory, DocumentTag } from './repositories.js';

type VersionInput = z.input<typeof documentVersionInputSchema>;
const restoreVersionSchema = z.object({ version: z.number().int().positive(), note: z.string().trim().max(200).default('') }).strict();
type RestoreVersionInput = { version: number; note?: string };
type GrantInput = z.infer<typeof documentGrantSchema>;
type Context = { readonly requestId?: string | null; readonly ip?: string | null; readonly userAgent?: string | null; readonly metadata?: Record<string, string | number | boolean | null> };
type ReadableDocumentFile = { readonly file: FileDocument; readonly version: DocumentVersion };
const previewableMimeTypes = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const MAX_SEARCHABLE_TEXT_BYTES = 1024 * 1024;

/** Inputs identifying the actor are server-side session contexts only. */
export class DocumentService {
  constructor(private readonly repos: DocumentRepositories, private readonly core: CoreRepositories,
    private readonly projects: ProjectRepositories, private readonly departments: Repository<DepartmentDocument>,
    private readonly uow: UnitOfWork, private readonly auth: AuthService, private readonly audit: AuditService,
    private readonly files: FileService) {}

  private parse<T, I>(schema: z.ZodType<T, z.ZodTypeDef, I>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new AppError('VALIDATION_FAILED', '文档输入无效');
    return result.data;
  }
  private async actor(context: AuthContext, permission: string, tx: StorageTransaction): Promise<AuthContext> {
    const actor = await this.auth.loadCurrentActor(context, tx);
    if (actor.user.mustChangePassword) throw new AppError('FORBIDDEN', '请先修改初始密码');
    if (!actor.permissions.includes(permission)) throw new AppError('FORBIDDEN', '没有执行此操作的权限');
    return actor;
  }
  private async project(actor: AuthContext, id: string | null, tx: StorageTransaction): Promise<LinkedProjectAccess> {
    if (id === null) return { kind: 'none' };
    const project = await this.projects.projects.get(id, tx);
    if (!project || project.deletedAt !== null) return { kind: 'denied' };
    const entry = await this.projects.members.getByUniqueIndex('idx_project_members_key', `${id}:${actor.user.id}`, tx);
    const isMember = !!entry && entry.deletedAt === null && entry.projectId === id && entry.userId === actor.user.id;
    if (project.visibility === 'private' && !isMember) return { kind: 'denied' };
    return { kind: 'allowed', isMember, archived: project.status === 'archived' };
  }
  private async policyActor(actor: AuthContext, tx: StorageTransaction): Promise<DocumentPolicyActor> {
    const departmentIds: string[] = []; const ancestors: string[] = []; const seen = new Set<string>();
    let id = actor.user.departmentId;
    while (id !== null) {
      if (seen.has(id) || seen.size >= 10) throw new AppError('STORAGE_CORRUPTED', '部门关系无效');
      seen.add(id);
      const department = await this.departments.get(id, tx);
      if (!department || department.deletedAt !== null) throw new AppError('STORAGE_CORRUPTED', '用户部门不存在');
      if (departmentIds.length === 0) departmentIds.push(id); else ancestors.push(id);
      id = department.parentId;
    }
    return { userId: actor.user.id, active: true, roleIds: actor.roles.map((role) => role.id), departmentIds,
      ancestorDepartmentIds: ancestors, permissions: actor.permissions };
  }
  private async allAcl(documentId: string, tx: StorageTransaction): Promise<DocumentAcl[]> {
    const first = await this.repos.acl.list({ indexName: 'idx_acl_document', prefix: documentId, page: 1, pageSize: 100 }, tx);
    const result = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) result.push(...(await this.repos.acl.list({ indexName: 'idx_acl_document', prefix: documentId, page, pageSize: 100 }, tx)).items);
    return result.filter((item) => item.documentId === documentId && item.deletedAt === null);
  }
  private async guarded(actor: AuthContext, id: string, action: DocumentAction, tx: StorageTransaction): Promise<Document> {
    const doc = await this.repos.documents.get(id, tx);
    if (!doc || doc.deletedAt !== null) throw new AppError('NOT_FOUND', '文档不存在');
    const grants = await this.allAcl(id, tx);
    const policyActor = await this.policyActor(actor, tx); const project = await this.project(actor, doc.projectId, tx);
    if (effectiveDocumentLevel(policyActor, doc, grants, project) === null) throw new AppError('NOT_FOUND', '文档不存在');
    if (!canAccessDocument(policyActor, doc, grants, project, action)) {
      if (doc.status === 'archived' || (project.kind === 'allowed' && project.archived)) throw new AppError('VERSION_CONFLICT', '归档文档或项目只读');
      throw new AppError('FORBIDDEN', '文档授权不足');
    }
    return doc;
  }
  private async log(actor: AuthContext, action: string, resourceId: string, tx: StorageTransaction, ctx: Context): Promise<void> {
    await this.audit.append({ actorUserId: actor.user.id, action, resourceType: 'document', resourceId, ...ctx }, tx);
  }
  private async assertProjectUpload(actor: AuthContext, projectId: string | null, visibility: Document['visibility'], tx: StorageTransaction): Promise<void> {
    if (visibility === 'project' && projectId === null) throw new AppError('VALIDATION_FAILED', '项目文档必须关联项目');
    if (projectId === null) return;
    const project = await this.project(actor, projectId, tx);
    if (project.kind !== 'allowed') throw new AppError('NOT_FOUND', '项目不存在');
    if (project.archived) throw new AppError('VERSION_CONFLICT', '归档项目只读');
    const member = await this.projects.members.getByUniqueIndex('idx_project_members_key', `${projectId}:${actor.user.id}`, tx);
    if (!member || member.deletedAt !== null || member.projectId !== projectId || member.userId !== actor.user.id || member.role === 'viewer') throw new AppError('FORBIDDEN', '项目角色无权上传文档');
  }
  private async saveSearchText(documentId: string, version: DocumentVersion, content: string | null, tx: StorageTransaction): Promise<void> {
    const existing = await this.repos.texts.getByUniqueIndex('idx_document_texts_document', documentId, tx);
    if (content === null) {
      if (existing && existing.deletedAt === null) await this.repos.texts.softDelete(existing.id, existing.version, tx);
      return;
    }
    if (existing && existing.deletedAt === null) {
      await this.repos.texts.update(existing.id, existing.version, () => ({ ...existing, versionId: version.id, sourceSha256: version.sha256, content }), tx);
      return;
    }
    await this.repos.texts.create({ documentId, versionId: version.id, sourceSha256: version.sha256, content }, tx);
  }
  async create(context: AuthContext, upload: StagedUpload, input: DocumentCreateInput, ctx: Context = {}): Promise<{ document: Document; version: DocumentVersion }> {
    const fields = this.parse(documentCreateSchema, input);
    const metadata = this.files.metadata(upload, context.user.id);
    const searchableText = await this.files.searchTextFromStaged(upload, context.user.id, MAX_SEARCHABLE_TEXT_BYTES);
    return this.files.bind(upload, context.user.id, async (file, tx) => {
      const actor = await this.actor(context, 'document:create', tx);
      await this.assertProjectUpload(actor, fields.projectId, fields.visibility, tx);
      await this.validateClassification(fields.categoryId, fields.tagIds, tx);
      const doc = await this.repos.documents.create({ title: fields.title, description: fields.description, categoryId: fields.categoryId,
        projectId: fields.projectId, ownerId: actor.user.id, visibility: fields.visibility, status: 'active', currentVersionId: null, versionCount: 0 }, tx);
      const version = await this.repos.versions.create({ documentId: doc.id, versionNo: 1, fileId: file.id, ...metadata, versionNote: fields.versionNote, uploadedBy: actor.user.id }, tx);
      const document = await this.repos.documents.update(doc.id, doc.version, (current) => ({ ...current, currentVersionId: version.id, versionCount: 1 }), tx);
      await this.saveSearchText(doc.id, version, searchableText, tx);
      await this.setTags(doc.id, fields.tagIds, tx);
      await this.log(actor, 'document.created', doc.id, tx, ctx);
      return { document, version };
    });
  }
  async appendVersion(context: AuthContext, id: string, upload: StagedUpload, input: VersionInput, ctx: Context = {}): Promise<DocumentVersion> {
    const fields = this.parse(documentVersionInputSchema, input);
    const metadata = this.files.metadata(upload, context.user.id);
    const searchableText = await this.files.searchTextFromStaged(upload, context.user.id, MAX_SEARCHABLE_TEXT_BYTES);
    return this.files.bind(upload, context.user.id, async (file, tx) => {
      const actor = await this.actor(context, 'document:version:create', tx);
      const doc = await this.guarded(actor, id, 'version:create', tx);
      if (doc.version !== fields.version) throw new AppError('VERSION_CONFLICT', '文档已更新');
      const version = await this.repos.versions.create({ documentId: id, versionNo: doc.versionCount + 1, fileId: file.id,
        ...metadata, versionNote: fields.note, uploadedBy: actor.user.id }, tx);
      await this.repos.documents.update(id, doc.version, (current) => ({ ...current, currentVersionId: version.id, versionCount: version.versionNo }), tx);
      await this.saveSearchText(id, version, searchableText, tx);
      await this.log(actor, 'document.version_created', id, tx, ctx);
      return version;
    });
  }

  async restoreVersion(context: AuthContext, id: string, sourceVersionId: string, input: RestoreVersionInput, ctx: Context = {}): Promise<DocumentView> {
    const fields = this.parse(restoreVersionSchema, input);
    const source = await this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:version:create', tx);
      const doc = await this.guarded(actor, id, 'version:create', tx);
      if (doc.version !== fields.version) throw new AppError('VERSION_CONFLICT', '文档已更新');
      const version = await this.repos.versions.get(sourceVersionId, tx);
      if (!version || version.deletedAt !== null || version.documentId !== id) throw new AppError('NOT_FOUND', '版本不存在');
      if (version.id === doc.currentVersionId) throw new AppError('VERSION_CONFLICT', '只能恢复历史版本');
      const file = await this.core.files.get(version.fileId, tx);
      if (!file || file.deletedAt !== null || file.status !== 'active') throw new AppError('FILE_MISSING', '文件不存在');
      if (file.sha256 !== version.sha256 || file.size !== version.size) throw new AppError('STORAGE_CORRUPTED', '历史版本文件元数据不一致');
      return { doc, version, file };
    });
    // Verify bytes before increasing refCount; retainWithMutation rechecks the
    // file and document lock in the same transaction after this filesystem read.
    await this.files.pathFor(source.file);
    const searchableText = await this.files.searchTextFromFile(source.file, MAX_SEARCHABLE_TEXT_BYTES);
    return this.files.retainWithMutation(source.file.id, async (file, tx) => {
      const actor = await this.actor(context, 'document:version:create', tx);
      const doc = await this.guarded(actor, id, 'version:create', tx);
      if (doc.version !== fields.version) throw new AppError('VERSION_CONFLICT', '文档已更新');
      const currentSource = await this.repos.versions.get(source.version.id, tx);
      if (!currentSource || currentSource.documentId !== id || currentSource.fileId !== file.id || currentSource.deletedAt !== null) throw new AppError('NOT_FOUND', '版本不存在');
      const version = await this.repos.versions.create({ documentId: id, versionNo: doc.versionCount + 1, fileId: file.id,
        fileName: currentSource.fileName, mime: currentSource.mime, size: currentSource.size, sha256: currentSource.sha256,
        versionNote: fields.note ? `${fields.note}；恢复自 V${currentSource.versionNo}` : `恢复自 V${currentSource.versionNo}`, uploadedBy: actor.user.id }, tx);
      const updated = await this.repos.documents.update(id, doc.version, (current) => ({ ...current, currentVersionId: version.id, versionCount: version.versionNo }), tx);
      await this.saveSearchText(id, version, searchableText, tx);
      await this.log(actor, 'document.version_restored', id, tx, {
        ...ctx,
        metadata: {
          ...ctx.metadata,
          sourceVersionId: currentSource.id,
          sourceVersionNo: currentSource.versionNo,
        },
      });
      return this.view(actor, updated, tx);
    });
  }
  async detail(context: AuthContext, id: string): Promise<Document> {
    return this.uow.run(async (tx) => { const actor = await this.actor(context, 'document:read', tx); return this.guarded(actor, id, 'read', tx); });
  }
  async versions(context: AuthContext, id: string): Promise<DocumentVersion[]> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:read', tx); await this.guarded(actor, id, 'read', tx);
      const first = await this.repos.versions.list({ indexName: 'idx_doc_versions_document', prefix: id, page: 1, pageSize: 100 }, tx);
      const result = [...first.items];
      for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) result.push(...(await this.repos.versions.list({ indexName: 'idx_doc_versions_document', prefix: id, page, pageSize: 100 }, tx)).items);
      return result.filter((entry) => entry.documentId === id && entry.deletedAt === null).sort((a, b) => a.versionNo - b.versionNo);
    });
  }
  async grants(context: AuthContext, id: string): Promise<DocumentAcl[]> {
    return this.uow.run(async (tx) => { const actor = await this.actor(context, 'document:acl:manage', tx); await this.guarded(actor, id, 'acl:manage', tx); return this.allAcl(id, tx); });
  }
  async grantSubjects(context: AuthContext, id: string): Promise<{ users: { id: string; name: string }[]; roles: { id: string; name: string }[]; departments: { id: string; name: string }[] }> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:acl:manage', tx); await this.guarded(actor, id, 'acl:manage', tx);
      return { users: (await this.all(this.core.users, tx)).filter((user) => user.status === 'active').map(({ id, name }) => ({ id, name })),
        roles: (await this.all(this.core.roles, tx)).filter((role) => role.system).map(({ id, name }) => ({ id, name })),
        departments: (await this.all(this.departments, tx)).map(({ id, name }) => ({ id, name })) };
    });
  }
  private async all<T extends DocumentEnvelope>(repository: Repository<T>, tx: StorageTransaction): Promise<T[]> {
    const first = await repository.list({ page: 1, pageSize: 100 }, tx);
    const items = [...first.items];
    for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) items.push(...(await repository.list({ page, pageSize: 100 }, tx)).items);
    return items.filter((item) => item.deletedAt === null);
  }
  private async tagIds(id: string, tx: StorageTransaction): Promise<string[]> {
    return (await this.all(this.repos.documentTags, tx)).filter((link) => link.documentId === id).map((link) => link.tagId);
  }
  private async validateClassification(categoryId: string | null, tagIds: readonly string[], tx: StorageTransaction): Promise<void> {
    if (categoryId !== null) {
      const category = await this.repos.categories.get(categoryId, tx);
      if (!category || category.deletedAt !== null) throw new AppError('VALIDATION_FAILED', '分类不存在');
    }
    if (new Set(tagIds).size !== tagIds.length) throw new AppError('VALIDATION_FAILED', '不能重复选择标签');
    for (const id of tagIds) {
      const tag = await this.repos.tags.get(id, tx);
      if (!tag || tag.deletedAt !== null) throw new AppError('VALIDATION_FAILED', '标签不存在');
    }
  }
  private async setTags(id: string, tagIds: readonly string[], tx: StorageTransaction): Promise<void> {
    const links = (await this.all(this.repos.documentTags, tx)).filter((link) => link.documentId === id);
    for (const link of links) if (!tagIds.includes(link.tagId)) await this.repos.documentTags.softDelete(link.id, link.version, tx);
    for (const tagId of tagIds) if (!links.some((link) => link.tagId === tagId)) await this.repos.documentTags.create({ documentId: id, tagId }, tx);
  }
  private async view(actor: AuthContext, doc: Document, tx: StorageTransaction): Promise<DocumentView> {
    const project = await this.project(actor, doc.projectId, tx);
    const level = effectiveDocumentLevel(await this.policyActor(actor, tx), doc, await this.allAcl(doc.id, tx), project);
    if (level === null) throw new AppError('NOT_FOUND', '文档不存在');
    const current = doc.currentVersionId ? await this.repos.versions.get(doc.currentVersionId, tx) : null;
    return { id: doc.id, title: doc.title, description: doc.description, categoryId: doc.categoryId, projectId: doc.projectId, ownerId: doc.ownerId,
      visibility: doc.visibility, status: doc.status, currentVersionId: doc.currentVersionId, versionCount: doc.versionCount,
      version: doc.version, updatedAt: doc.updatedAt, createdAt: doc.createdAt, tagIds: await this.tagIds(doc.id, tx), level,
      readOnly: doc.status === 'archived' || (project.kind === 'allowed' && project.archived),
      currentFile: current ? { fileName: current.fileName, size: current.size, mime: current.mime } : null };
  }
  async get(context: AuthContext, id: string): Promise<DocumentView> {
    return this.uow.run(async (tx) => { const actor = await this.actor(context, 'document:read', tx); return this.view(actor, await this.guarded(actor, id, 'read', tx), tx); });
  }
  async search(context: AuthContext, input: DocumentSearchInput = {}): Promise<{ data: DocumentView[]; meta: { total: number; page: number; pageSize: number } }> {
    const filter = this.parse(documentSearchSchema, input);
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:read', tx);
      const policyActor = await this.policyActor(actor, tx);
      const categories = await this.all(this.repos.categories, tx);
      const allTags = await this.all(this.repos.tags, tx);
      const tagNamesById = new Map(allTags.map((tag) => [tag.id, tag.name]));
      const categoryIds = new Set(filter.categoryId ? [filter.categoryId] : []);
      for (let depth = 0; depth < 5; depth += 1) for (const category of categories) if (category.parentId && categoryIds.has(category.parentId)) categoryIds.add(category.id);
      const matches: { document: Document; textScore: number }[] = [];
      const q = filter.q.toLocaleLowerCase();
      for (const doc of await this.all(this.repos.documents, tx)) {
        if (doc.status === 'archived' !== filter.archived || (filter.categoryId && (!doc.categoryId || !categoryIds.has(doc.categoryId)))) continue;
        if (filter.projectId && doc.projectId !== filter.projectId || filter.ownerId && doc.ownerId !== filter.ownerId || filter.visibility && doc.visibility !== filter.visibility) continue;
        if (filter.from && doc.updatedAt < filter.from || filter.to && doc.updatedAt > filter.to) continue;
        if (!canAccessDocument(policyActor, doc, await this.allAcl(doc.id, tx), await this.project(actor, doc.projectId, tx), 'read')) continue;
        const tags = await this.tagIds(doc.id, tx);
        if (filter.tagIds.some((id) => !tags.includes(id))) continue;
        const tagText = tags.map((id) => tagNamesById.get(id) ?? '').join(' ');
        const text = await this.repos.texts.getByUniqueIndex('idx_document_texts_document', doc.id, tx);
        const title = doc.title.toLocaleLowerCase();
        const metadata = `${doc.description} ${tagText}`.toLocaleLowerCase();
        const content = text?.deletedAt === null && text.versionId === doc.currentVersionId ? text.content.toLocaleLowerCase() : '';
        if (q && !title.includes(q) && !metadata.includes(q) && !content.includes(q)) continue;
        const textScore = !q ? 0 : title === q ? 4 : title.startsWith(q) ? 3 : title.includes(q) ? 2 : metadata.includes(q) ? 1 : 0;
        matches.push({ document: doc, textScore });
      }
      matches.sort((a, b) => b.textScore - a.textScore || b.document.updatedAt.localeCompare(a.document.updatedAt) || b.document.id.localeCompare(a.document.id));
      const data: DocumentView[] = [];
      for (const match of matches.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize)) data.push(await this.view(actor, match.document, tx));
      return { data, meta: { total: matches.length, page: filter.page, pageSize: filter.pageSize } };
    });
  }
  async update(context: AuthContext, id: string, input: DocumentUpdateInput, ctx: Context = {}): Promise<DocumentView> {
    const fields = this.parse(documentUpdateSchema, input);
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:update', tx); const doc = await this.guarded(actor, id, 'update', tx);
      if (fields.visibility !== doc.visibility) {
        await this.actor(context, 'document:acl:manage', tx); await this.guarded(actor, id, 'acl:manage', tx);
        if (fields.visibility === 'project' && !doc.projectId) throw new AppError('VALIDATION_FAILED', '项目文档必须关联项目');
      }
      await this.validateClassification(fields.categoryId, fields.tagIds, tx);
      const updated = await this.repos.documents.update(id, fields.version, (current) => ({ ...current, title: fields.title, description: fields.description, categoryId: fields.categoryId, visibility: fields.visibility }), tx);
      await this.setTags(id, fields.tagIds, tx); await this.log(actor, 'document.updated', id, tx, ctx);
      return this.view(actor, updated, tx);
    });
  }
  async archive(context: AuthContext, id: string, version: number, ctx: Context = {}): Promise<DocumentView> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:acl:manage', tx); await this.guarded(actor, id, 'acl:manage', tx);
      const updated = await this.repos.documents.update(id, version, (doc) => ({ ...doc, status: 'archived' }), tx);
      await this.log(actor, 'document.archived', id, tx, ctx); return this.view(actor, updated, tx);
    });
  }
  async batch(context: AuthContext, input: DocumentBatchRequest, ctx: Context = {}): Promise<DocumentBatchResponse> {
    const fields = this.parse(documentBatchRequestSchema, input);
    const results: DocumentBatchResponse['results'] = [];
    for (const item of fields.items) {
      try {
        const version = await this.uow.run(async (tx) => {
          const actor = await this.actor(context, 'document:acl:manage', tx);
          const doc = await this.guarded(actor, item.id, 'acl:manage', tx);
          if (doc.version !== item.version) throw new AppError('VERSION_CONFLICT', '文档已更新，请刷新后重试');
          let updated: Document;
          if (fields.operation === 'move_category') {
            await this.validateClassification(fields.categoryId, [], tx);
            updated = await this.repos.documents.update(doc.id, item.version, (current) => ({ ...current, categoryId: fields.categoryId }), tx);
            await this.log(actor, 'document.batch_category_moved', doc.id, tx, { ...ctx, metadata: { ...ctx.metadata, categoryId: fields.categoryId } });
          } else if (fields.operation === 'add_tags') {
            await this.validateClassification(null, fields.tagIds, tx);
            const currentTagIds = await this.tagIds(doc.id, tx);
            const nextTagIds = [...new Set([...currentTagIds, ...fields.tagIds])];
            if (nextTagIds.length > 10) throw new AppError('VALIDATION_FAILED', '文档标签总数不能超过 10 个');
            updated = await this.repos.documents.update(doc.id, item.version, (current) => current, tx);
            await this.setTags(doc.id, nextTagIds, tx);
            await this.log(actor, 'document.batch_tags_added', doc.id, tx, { ...ctx, metadata: { ...ctx.metadata, tagCount: fields.tagIds.length } });
          } else {
            updated = await this.repos.documents.update(doc.id, item.version, (current) => ({ ...current, status: 'archived' }), tx);
            await this.log(actor, 'document.batch_archived', doc.id, tx, ctx);
          }
          return updated.version;
        });
        results.push({ id: item.id, success: true, version });
      } catch (error) {
        results.push({
          id: item.id,
          success: false,
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof AppError ? error.message : '操作未提交，请稍后重试',
        });
      }
    }
    const succeeded = results.filter((result) => result.success).length;
    return { results, succeeded, failed: results.length - succeeded };
  }
  async remove(context: AuthContext, id: string, version: number, ctx: Context = {}): Promise<void> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:delete', tx); await this.guarded(actor, id, 'delete', tx);
      await this.repos.documents.softDelete(id, version, tx);
      // Historical versions and file references are retained for audit.
      await this.log(actor, 'document.deleted', id, tx, ctx);
    });
  }
  async download(context: AuthContext, id: string, versionId: string | null, ctx: Context = {}): Promise<{ path: string; fileName: string; mime: string; size: number }> {
    const selected = await this.selectReadableFile(context, id, versionId);
    const path = await this.files.pathFor(selected.file);
    await this.confirmRead(context, id, 'document.downloaded', ctx);
    return { path, fileName: selected.version.fileName, mime: selected.version.mime, size: selected.version.size };
  }
  async preview(context: AuthContext, id: string, versionId: string | null, ctx: Context = {}): Promise<{ path: string; fileName: string; mime: string; size: number }> {
    const selected = await this.selectReadableFile(context, id, versionId);
    if (!previewableMimeTypes.has(selected.version.mime) || selected.file.mimeType !== selected.version.mime) {
      throw new AppError('FILE_TYPE_UNSUPPORTED', '该文件类型不支持在线预览');
    }
    const path = await this.files.pathFor(selected.file);
    await this.confirmRead(context, id, 'document.previewed', ctx);
    return { path, fileName: selected.version.fileName, mime: selected.version.mime, size: selected.version.size };
  }
  private async selectReadableFile(context: AuthContext, id: string, versionId: string | null): Promise<ReadableDocumentFile> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:read', tx); const doc = await this.guarded(actor, id, 'read', tx);
      const version = await this.repos.versions.get(versionId ?? doc.currentVersionId ?? '', tx);
      if (!version || version.deletedAt !== null || version.documentId !== id) throw new AppError('NOT_FOUND', '版本不存在');
      const file = await this.core.files.get(version.fileId, tx);
      if (!file || file.deletedAt !== null) throw new AppError('FILE_MISSING', '文件不存在');
      return { file, version };
    });
  }
  private async confirmRead(context: AuthContext, id: string, action: 'document.downloaded' | 'document.previewed', ctx: Context): Promise<void> {
    await this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:read', tx); await this.guarded(actor, id, 'read', tx);
      await this.log(actor, action, id, tx, ctx);
    });
  }
  async classifications(context: AuthContext): Promise<{ categories: DocumentCategory[]; tags: DocumentTag[] }> {
    return this.uow.run(async (tx) => {
      await this.actor(context, 'document:read', tx);
      return { categories: (await this.all(this.repos.categories, tx)).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), tags: (await this.all(this.repos.tags, tx)).sort((a, b) => a.name.localeCompare(b.name)) };
    });
  }
  async saveCategory(context: AuthContext, id: string | null, version: number | null, input: DocumentCategoryInput, ctx: Context = {}): Promise<DocumentCategory> {
    const fields = this.parse(documentCategorySchema, input);
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:category:manage', tx);
      const categories = await this.all(this.repos.categories, tx);
      if (id && !categories.some((item) => item.id === id)) throw new AppError('NOT_FOUND', '分类不存在');
      if (fields.parentId && !categories.some((item) => item.id === fields.parentId)) throw new AppError('VALIDATION_FAILED', '父分类不存在');
      const tree = categories.filter((item) => item.id !== id).map((item) => ({ id: item.id, parentId: item.parentId }));
      tree.push({ id: id ?? 'new', parentId: fields.parentId });
      for (const item of tree) {
        let cursor: string | null = item.id; const seen = new Set<string>();
        while (cursor) {
          if (seen.has(cursor) || seen.size >= 5) throw new AppError('VALIDATION_FAILED', '分类不能循环或超过五层');
          seen.add(cursor); cursor = tree.find((entry) => entry.id === cursor)?.parentId ?? null;
        }
      }
      const category = id ? await this.repos.categories.update(id, version ?? 0, (current) => ({ ...current, ...fields }), tx) : await this.repos.categories.create(fields, tx);
      await this.log(actor, 'document.category_saved', category.id, tx, ctx); return category;
    });
  }
  async deleteCategory(context: AuthContext, id: string, version: number, ctx: Context = {}): Promise<void> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:category:manage', tx);
      if ((await this.all(this.repos.categories, tx)).some((item) => item.parentId === id) || (await this.all(this.repos.documents, tx)).some((item) => item.categoryId === id)) throw new AppError('VERSION_CONFLICT', '分类仍有文档或子分类');
      await this.repos.categories.softDelete(id, version, tx); await this.log(actor, 'document.category_deleted', id, tx, ctx);
    });
  }
  async saveTag(context: AuthContext, id: string | null, version: number | null, input: DocumentTagInput, ctx: Context = {}): Promise<DocumentTag> {
    const fields = this.parse(documentTagSchema, input);
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:tag:manage', tx);
      const tag = id ? await this.repos.tags.update(id, version ?? 0, (current) => ({ ...current, ...fields }), tx) : await this.repos.tags.create(fields, tx);
      await this.log(actor, 'document.tag_saved', tag.id, tx, ctx); return tag;
    });
  }
  async deleteTag(context: AuthContext, id: string, version: number, ctx: Context = {}): Promise<void> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:tag:manage', tx);
      await this.repos.tags.softDelete(id, version, tx);
      for (const link of await this.all(this.repos.documentTags, tx)) if (link.tagId === id) await this.repos.documentTags.softDelete(link.id, link.version, tx);
      await this.log(actor, 'document.tag_deleted', id, tx, ctx);
    });
  }
  private async validSubject(input: GrantInput, tx: StorageTransaction): Promise<void> {
    if (input.subjectType !== 'department' && input.includeDescendants) throw new AppError('VALIDATION_FAILED', '仅部门支持子部门授权');
    if (input.subjectType === 'user') {
      const user = await this.core.users.get(input.subjectId, tx);
      if (!user || user.deletedAt !== null || user.status !== 'active') throw new AppError('VALIDATION_FAILED', '用户不存在或已停用');
    } else if (input.subjectType === 'role') {
      const role = await this.core.roles.get(input.subjectId, tx);
      if (!role || role.deletedAt !== null || !role.system) throw new AppError('VALIDATION_FAILED', '系统角色不存在');
    } else {
      const dept = await this.departments.get(input.subjectId, tx);
      if (!dept || dept.deletedAt !== null) throw new AppError('VALIDATION_FAILED', '部门不存在');
      const first = await this.core.users.list({ page: 1, pageSize: 100 }, tx);
      const users = [...first.items];
      for (let page = 2; page <= Math.ceil(first.total / 100); page += 1) users.push(...(await this.core.users.list({ page, pageSize: 100 }, tx)).items);
      let populated = false;
      for (const user of users) {
        if (user.deletedAt !== null || user.status !== 'active' || user.departmentId === null) continue;
        let cursor: string | null = user.departmentId; const seen = new Set<string>();
        while (cursor !== null && !seen.has(cursor) && seen.size < 10) {
          if (cursor === dept.id) { populated = true; break; }
          if (!input.includeDescendants) break;
          seen.add(cursor); const parent: DepartmentDocument | undefined = await this.departments.get(cursor, tx);
          if (!parent || parent.deletedAt !== null) break;
          cursor = parent.parentId;
        }
        if (populated) break;
      }
      if (!populated) throw new AppError('VALIDATION_FAILED', '不能授权空部门');
    }
  }
  async putGrant(context: AuthContext, id: string, input: GrantInput, ctx: Context = {}): Promise<DocumentAcl> {
    const fields = this.parse(documentGrantSchema, input);
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:acl:manage', tx); const doc = await this.guarded(actor, id, 'acl:manage', tx);
      await this.validSubject(fields, tx);
      if (fields.subjectType === 'user' && fields.subjectId === doc.ownerId && fields.permission !== 'manage') throw new AppError('VERSION_CONFLICT', '所有者始终拥有管理权限');
      const key = JSON.stringify([id, fields.subjectType, fields.subjectId]);
      const existing = await this.repos.acl.getByUniqueIndex('idx_acl_document_subject', key, tx);
      const result = existing
        ? await this.repos.acl.update(existing.id, existing.version, (current) => ({ ...current, permission: fields.permission, includeDescendants: fields.includeDescendants }), tx)
        : await this.repos.acl.create({ documentId: id, ...fields, createdBy: actor.user.id }, tx);
      await this.log(actor, 'document.acl_changed', id, tx, ctx); return result;
    });
  }
  async revokeGrant(context: AuthContext, id: string, grantId: string, ctx: Context = {}): Promise<void> {
    return this.uow.run(async (tx) => {
      const actor = await this.actor(context, 'document:acl:manage', tx); const doc = await this.guarded(actor, id, 'acl:manage', tx);
      const grant = await this.repos.acl.get(grantId, tx);
      if (!grant || grant.deletedAt !== null || grant.documentId !== id) throw new AppError('NOT_FOUND', '授权不存在');
      if (grant.subjectType === 'user' && grant.subjectId === doc.ownerId) throw new AppError('VERSION_CONFLICT', '不能移除所有者权限');
      await this.repos.acl.softDelete(grant.id, grant.version, tx);
      await this.log(actor, 'document.acl_revoked', id, tx, ctx);
    });
  }
}
