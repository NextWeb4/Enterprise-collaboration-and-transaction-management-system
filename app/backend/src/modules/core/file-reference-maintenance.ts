import type { StorageTransaction } from '../../storage/engine.js';
import {
  auditLogSchema,
  bootstrapRecordSchema,
  fileSchema,
  loginRecordSchema,
  organizationSchema,
  permissionSchema,
  roleSchema,
  sessionSchema,
  userSchema,
} from './models.js';
import { documentVersionSchema } from '../documents/repositories.js';
import { attachmentSchema } from '../approvals/models.js';

/** Validate every core primary record before a maintenance operation changes indexes. */
export function inspectCoreStorage(tx: StorageTransaction): { issues: string[] } {
  const issues: string[] = [];
  for (const [store, schema] of [
    ['bootstrap_records', bootstrapRecordSchema],
    ['users', userSchema],
    ['roles', roleSchema],
    ['permissions', permissionSchema],
    ['sessions', sessionSchema],
    ['org_profile', organizationSchema],
    ['login_records', loginRecordSchema],
    ['audit_logs', auditLogSchema],
    ['files', fileSchema],
  ] as const) {
    for (const entry of tx.range<unknown>(store, {})) {
      const parsed = schema.safeParse(entry.value);
      if (!parsed.success || parsed.data.id !== entry.key)
        issues.push(`${store}: ${entry.key} schema 或主键无效`);
    }
  }
  return { issues };
}

/** Business links, not refCount itself, are the independent reference source. */
export function inspectFileReferences(tx: StorageTransaction): { issues: string[]; references: number } {
  const issues: string[] = [];
  const counts = new Map<string, number>();
  const files = new Map<string, ReturnType<typeof fileSchema.parse>>();
  for (const entry of tx.range<unknown>('files', {})) {
    const parsed = fileSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`files: ${entry.key} schema 或主键无效`);
      continue;
    }
    files.set(entry.key, parsed.data);
  }
  for (const [store, schema] of [['document_versions', documentVersionSchema], ['application_attachments', attachmentSchema]] as const) {
    for (const entry of tx.range<unknown>(store, {})) {
      const parsed = schema.safeParse(entry.value);
      if (!parsed.success || parsed.data.id !== entry.key) {
        issues.push(`${store}: ${entry.key} schema 或主键无效`);
        continue;
      }
      const link = parsed.data;
      if (link.deletedAt !== null) continue;
      counts.set(link.fileId, (counts.get(link.fileId) ?? 0) + 1);
      const file = files.get(link.fileId);
      if (!file || file.deletedAt !== null || file.status !== 'active') {
        issues.push(`${store}: ${link.id} 引用文件不存在或非活动状态`);
      } else if (file.sha256 !== link.sha256 || file.size !== link.size) {
        issues.push(`${store}: ${link.id} 文件 SHA-256/大小与 files 不一致`);
      }
    }
  }
  for (const file of files.values()) {
    const expected = counts.get(file.id) ?? 0;
    if (file.refCount !== expected) issues.push(`files: ${file.id} refCount=${file.refCount} 与业务引用数=${expected} 不一致`);
    if ((expected > 0 && (file.status !== 'active' || file.deletedAt !== null)) || (expected === 0 && file.status !== 'deleted')) issues.push(`files: ${file.id} 文件状态与业务引用数不一致`);
  }
  return { issues, references: [...counts.values()].reduce((sum, count) => sum + count, 0) };
}
