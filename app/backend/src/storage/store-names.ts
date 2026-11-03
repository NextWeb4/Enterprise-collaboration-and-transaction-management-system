/** 命名子库清单（docs/03-technical/data-storage-design.md §8）。索引子库以 idx_ 前缀独立存在。 */
export const STORE_NAMES = [
  'meta',
  'bootstrap_records',
  'users',
  'sessions',
  'roles',
  'permissions',
  'login_records',
  'org_profile',
  'departments',
  'employees',
  'positions',
  'settings',
  'projects',
  'project_members',
  'tasks',
  'task_comments',
  'applications',
  'application_attachments',
  'workflow_templates',
  'workflow_versions',
  'workflow_instances',
  'workflow_steps',
  'approval_records',
  'documents',
  'document_versions',
  'document_texts',
  'document_categories',
  'tags',
  'document_tags',
  'document_acl',
  'files',
  'events',
  'event_reminders',
  'notifications',
  'audit_logs',
  'counters',
  'idempotency',
] as const;

export type StoreName = (typeof STORE_NAMES)[number];

export const INDEX_STORE_PREFIX = 'idx_';

export function isStoreName(name: string): name is StoreName {
  return (STORE_NAMES as readonly string[]).includes(name);
}

export function isIndexStoreName(name: string): boolean {
  return name.startsWith(INDEX_STORE_PREFIX);
}
