import { indexStoreKey } from '../../storage/index-registry.js';
import type { StorageTransaction } from '../../storage/engine.js';
import { documentSchema, documentVersionSchema, documentTextSchema, documentAclSchema, categorySchema, tagSchema, documentTagSchema } from './repositories.js';

export const DOCUMENT_INDEX_NAMES = [
  'idx_documents_owner', 'idx_documents_project', 'idx_doc_versions_no',
  'idx_doc_versions_document', 'idx_document_texts_document', 'idx_acl_document_subject', 'idx_acl_document',
  'idx_document_categories_name', 'idx_tags_name', 'idx_document_tags_pair',
  'idx_document_tags_document',
] as const;

type ExpectedIndexes = Map<string, Map<string, string>>;

export interface DocumentStorageInspection {
  readonly issues: string[];
  readonly expected: ExpectedIndexes;
  /** Number of retained document-version references for each file ID. */
  readonly fileReferences: Map<string, number>;
}

const nonUnique = new Set<string>([
  'idx_documents_owner', 'idx_documents_project', 'idx_doc_versions_document',
  'idx_acl_document', 'idx_document_tags_document',
]);

function addIndex(expected: ExpectedIndexes, issues: string[], index: string, key: string, id: string): void {
  const entries = expected.get(index);
  if (!entries) throw new Error(`文档索引配置错误: ${index}`);
  const storeKey = nonUnique.has(index) ? indexStoreKey(key, id) : key;
  if (!nonUnique.has(index) && entries.has(storeKey)) {
    issues.push(`文档索引唯一键重复: ${index}`);
  }
  entries.set(storeKey, id);
}

function isActive(value: { deletedAt: string | null }): boolean {
  return value.deletedAt === null;
}

/**
 * Reconstruct document indexes and validate references from primary records.
 * This function never writes; callers decide whether to compare or rebuild.
 */
export function inspectDocumentStorage(tx: StorageTransaction): DocumentStorageInspection {
  const issues: string[] = [];
  const expected: ExpectedIndexes = new Map(DOCUMENT_INDEX_NAMES.map((name) => [name, new Map()]));
  const fileReferences = new Map<string, number>();
  const add = (index: string, key: string, id: string): void => addIndex(expected, issues, index, key, id);
  const documents = new Map<string, ReturnType<typeof documentSchema.parse>>();
  const versions = new Map<string, ReturnType<typeof documentVersionSchema.parse>[]>();
  const texts = new Map<string, ReturnType<typeof documentTextSchema.parse>>();
  const categories = new Map<string, ReturnType<typeof categorySchema.parse>>();
  const tags = new Map<string, ReturnType<typeof tagSchema.parse>>();

  for (const entry of tx.range<unknown>('documents', {})) {
    const parsed = documentSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`documents: ${entry.key} schema 或主键无效`);
      continue;
    }
    const doc = parsed.data;
    documents.set(doc.id, doc);
    if (isActive(doc)) {
      add('idx_documents_owner', doc.ownerId, doc.id);
      if (doc.projectId !== null) add('idx_documents_project', doc.projectId, doc.id);
    }
  }
  for (const entry of tx.range<unknown>('document_versions', {})) {
    const parsed = documentVersionSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`document_versions: ${entry.key} schema 或主键无效`);
      continue;
    }
    const version = parsed.data;
    if (!isActive(version)) issues.push(`document_versions: ${version.id} 版本只追加，禁止软删除`);
    if (!documents.has(version.documentId)) issues.push(`document_versions: ${version.id} 引用不存在的文档 ${version.documentId}`);
    const history = versions.get(version.documentId) ?? [];
    history.push(version);
    versions.set(version.documentId, history);
    if (isActive(version)) {
      add('idx_doc_versions_no', JSON.stringify([version.documentId, version.versionNo]), version.id);
      add('idx_doc_versions_document', version.documentId, version.id);
      fileReferences.set(version.fileId, (fileReferences.get(version.fileId) ?? 0) + 1);
    }
  }
  for (const entry of tx.range<unknown>('document_texts', {})) {
    const parsed = documentTextSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`document_texts: ${entry.key} schema 或主键无效`);
      continue;
    }
    const text = parsed.data;
    if (!isActive(text)) continue;
    add('idx_document_texts_document', text.documentId, text.id);
    if (texts.has(text.documentId)) issues.push(`document_texts: ${text.documentId} 存在多个活动索引记录`);
    texts.set(text.documentId, text);
  }
  for (const entry of tx.range<unknown>('document_acl', {})) {
    const parsed = documentAclSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`document_acl: ${entry.key} schema 或主键无效`);
      continue;
    }
    const acl = parsed.data;
    if (isActive(acl)) {
      add('idx_acl_document_subject', JSON.stringify([acl.documentId, acl.subjectType, acl.subjectId]), acl.id);
      add('idx_acl_document', acl.documentId, acl.id);
    }
    if (!documents.has(acl.documentId)) issues.push(`document_acl: ${acl.id} 引用不存在的文档 ${acl.documentId}`);
  }
  for (const entry of tx.range<unknown>('document_categories', {})) {
    const parsed = categorySchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`document_categories: ${entry.key} schema 或主键无效`);
      continue;
    }
    const category = parsed.data;
    categories.set(category.id, category);
    if (isActive(category)) add('idx_document_categories_name', JSON.stringify([category.parentId, category.name.toLocaleLowerCase()]), category.id);
  }
  for (const category of categories.values()) {
    if (!isActive(category) || category.parentId === null) continue;
    const parent = categories.get(category.parentId);
    if (!parent || !isActive(parent)) issues.push(`document_categories: ${category.id} 父分类不存在`);
    let cursor: string | null = category.id;
    const seen = new Set<string>();
    while (cursor !== null) {
      if (seen.has(cursor) || seen.size >= 5) {
        issues.push(`document_categories: ${category.id} 存在循环或超过五层`);
        break;
      }
      seen.add(cursor);
      cursor = categories.get(cursor)?.parentId ?? null;
    }
  }
  for (const entry of tx.range<unknown>('tags', {})) {
    const parsed = tagSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`tags: ${entry.key} schema 或主键无效`);
      continue;
    }
    const tag = parsed.data;
    tags.set(tag.id, tag);
    if (isActive(tag)) add('idx_tags_name', tag.name.toLocaleLowerCase(), tag.id);
  }
  for (const entry of tx.range<unknown>('document_tags', {})) {
    const parsed = documentTagSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`document_tags: ${entry.key} schema 或主键无效`);
      continue;
    }
    const link = parsed.data;
    if (isActive(link)) {
      add('idx_document_tags_pair', JSON.stringify([link.documentId, link.tagId]), link.id);
      add('idx_document_tags_document', link.documentId, link.id);
      if (!documents.has(link.documentId)) issues.push(`document_tags: ${link.id} 引用不存在的文档 ${link.documentId}`);
      if (!tags.has(link.tagId) || !isActive(tags.get(link.tagId)!)) issues.push(`document_tags: ${link.id} 引用不存在的标签 ${link.tagId}`);
    }
  }
  for (const doc of documents.values()) {
    const history = (versions.get(doc.id) ?? []).filter(isActive).sort((a, b) => a.versionNo - b.versionNo);
    if (history.length !== doc.versionCount) issues.push(`documents: ${doc.id} versionCount 与版本记录不一致`);
    const highest = history.at(-1);
    if ((highest?.id ?? null) !== doc.currentVersionId) issues.push(`documents: ${doc.id} currentVersionId 不匹配`);
    if (isActive(doc) && doc.categoryId !== null && (!categories.has(doc.categoryId) || !isActive(categories.get(doc.categoryId)!))) issues.push(`documents: ${doc.id} 引用不存在的分类 ${doc.categoryId}`);
    for (const [index, version] of history.entries()) if (version.versionNo !== index + 1) issues.push(`document_versions: ${version.id} 版本序号不连续`);
    const text = texts.get(doc.id);
    if (text && (text.versionId !== doc.currentVersionId || text.sourceSha256 !== highest?.sha256)) issues.push(`document_texts: ${text.id} 与当前版本不一致`);
  }
  for (const text of texts.values()) if (!documents.has(text.documentId)) issues.push(`document_texts: ${text.id} 引用不存在的文档 ${text.documentId}`);
  return { issues, expected, fileReferences };
}
