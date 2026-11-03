import { z } from 'zod';
import type { StorageEngine } from '../../storage/engine.js';
import { BaseRepository, type Repository } from '../../storage/repository.js';
import type { CoreRepositories } from '../core/repositories.js';
import { systemClock } from '../../shared/clock.js';
import { documentCategorySchema as categoryFields, documentTagSchema as tagFields } from '@collab/shared/schemas.js';

const envelope = {
  id: z.string().min(1).max(64), schemaVersion: z.literal(1), version: z.number().int().positive(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), deletedAt: z.string().datetime().nullable(),
};
const id = z.string().min(1).max(64);
export const documentSchema = z.object({
  ...envelope, type: z.literal('document'), title: z.string().min(2).max(100), description: z.string().max(1000),
  categoryId: id.nullable(), projectId: id.nullable(), ownerId: id,
  visibility: z.enum(['organization', 'project', 'restricted']), status: z.enum(['active', 'archived']),
  currentVersionId: id.nullable(), versionCount: z.number().int().nonnegative().safe(),
}).strict();
export const documentVersionSchema = z.object({
  ...envelope, type: z.literal('document_version'), documentId: id, versionNo: z.number().int().positive().safe(),
  fileId: id, fileName: z.string().min(1).max(240), mime: z.string().min(1).max(200), size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), versionNote: z.string().max(200), uploadedBy: id,
}).strict();
export const documentTextSchema = z.object({
  ...envelope, type: z.literal('document_text'), documentId: id, versionId: id,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u), content: z.string().max(1024 * 1024),
}).strict();
export const documentAclSchema = z.object({
  ...envelope, type: z.literal('document_acl'), documentId: id,
  subjectType: z.enum(['user', 'role', 'department']), subjectId: id,
  permission: z.enum(['view', 'edit', 'manage']), includeDescendants: z.boolean(), createdBy: id,
}).strict();
export type Document = z.infer<typeof documentSchema>;
export type DocumentVersion = z.infer<typeof documentVersionSchema>;
export type DocumentText = z.infer<typeof documentTextSchema>;
export type DocumentAcl = z.infer<typeof documentAclSchema>;
export const categorySchema = categoryFields.extend({ ...envelope, type: z.literal('document_category'), parentId: categoryFields.shape.parentId.removeDefault(), sortOrder: categoryFields.shape.sortOrder.removeDefault() }).strict();
export const tagSchema = tagFields.extend({ ...envelope, type: z.literal('tag'), color: tagFields.shape.color.removeDefault() }).strict();
export const documentTagSchema = z.object({ ...envelope, type: z.literal('document_tag'), documentId: id, tagId: id }).strict();
export type DocumentCategory = z.infer<typeof categorySchema>;
export type DocumentTag = z.infer<typeof tagSchema>;
export type DocumentTagLink = z.infer<typeof documentTagSchema>;
export interface DocumentRepositories {
  readonly documents: Repository<Document>;
  readonly versions: Repository<DocumentVersion>;
  readonly texts: Repository<DocumentText>;
  readonly acl: Repository<DocumentAcl>;
  readonly categories: Repository<DocumentCategory>;
  readonly tags: Repository<DocumentTag>;
  readonly documentTags: Repository<DocumentTagLink>;
}
export function createDocumentRepositories(engine: StorageEngine, core: CoreRepositories): DocumentRepositories {
  const documents = new BaseRepository<Document>({ store: 'documents', type: 'document', schemaVersion: 1, schema: documentSchema, clock: systemClock,
    indexes: [
      { name: 'idx_documents_owner', source: 'documents', unique: false, indexKeys: (doc) => [doc.ownerId] },
      { name: 'idx_documents_project', source: 'documents', unique: false, indexKeys: (doc) => doc.projectId ? [doc.projectId] : [] },
    ],
  }, core.registry, engine);
  const versions = new BaseRepository<DocumentVersion>({ store: 'document_versions', type: 'document_version', schemaVersion: 1, schema: documentVersionSchema, clock: systemClock,
    indexes: [
      { name: 'idx_doc_versions_no', source: 'document_versions', unique: true, indexKeys: (doc) => [JSON.stringify([doc.documentId, doc.versionNo])] },
      { name: 'idx_doc_versions_document', source: 'document_versions', unique: false, indexKeys: (doc) => [doc.documentId] },
    ],
  }, core.registry, engine);
  const texts = new BaseRepository<DocumentText>({ store: 'document_texts', type: 'document_text', schemaVersion: 1, schema: documentTextSchema, clock: systemClock,
    indexes: [{ name: 'idx_document_texts_document', source: 'document_texts', unique: true, indexKeys: (doc) => [doc.documentId] }],
  }, core.registry, engine);
  const acl = new BaseRepository<DocumentAcl>({ store: 'document_acl', type: 'document_acl', schemaVersion: 1, schema: documentAclSchema, clock: systemClock,
    indexes: [
      { name: 'idx_acl_document_subject', source: 'document_acl', unique: true, indexKeys: (doc) => [JSON.stringify([doc.documentId, doc.subjectType, doc.subjectId])] },
      { name: 'idx_acl_document', source: 'document_acl', unique: false, indexKeys: (doc) => [doc.documentId] },
    ],
  }, core.registry, engine);
  const categories = new BaseRepository<DocumentCategory>({ store: 'document_categories', type: 'document_category', schemaVersion: 1, schema: categorySchema, clock: systemClock, indexes: [
    { name: 'idx_document_categories_name', source: 'document_categories', unique: true, indexKeys: (doc) => [JSON.stringify([doc.parentId, doc.name.toLocaleLowerCase()])] },
  ] }, core.registry, engine);
  const tags = new BaseRepository<DocumentTag>({ store: 'tags', type: 'tag', schemaVersion: 1, schema: tagSchema, clock: systemClock, indexes: [
    { name: 'idx_tags_name', source: 'tags', unique: true, indexKeys: (doc) => [doc.name.toLocaleLowerCase()] },
  ] }, core.registry, engine);
  const documentTags = new BaseRepository<DocumentTagLink>({ store: 'document_tags', type: 'document_tag', schemaVersion: 1, schema: documentTagSchema, clock: systemClock, indexes: [
    { name: 'idx_document_tags_pair', source: 'document_tags', unique: true, indexKeys: (doc) => [JSON.stringify([doc.documentId, doc.tagId])] },
    { name: 'idx_document_tags_document', source: 'document_tags', unique: false, indexKeys: (doc) => [doc.documentId] },
  ] }, core.registry, engine);
  return { documents, versions, texts, acl, categories, tags, documentTags };
}
