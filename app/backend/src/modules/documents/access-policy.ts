/**
 * Document access calculation only. All inputs must come from freshly loaded,
 * trusted server-side records; client-supplied memberships are not evidence.
 * Project and department lookups must be resolved inside the caller's transaction.
 */
export type DocumentLevel = 'view' | 'edit' | 'manage';
export type DocumentVisibility = 'organization' | 'project' | 'restricted';
export type DocumentAction = 'read' | 'update' | 'version:create' | 'delete' | 'acl:manage';

export interface DocumentPolicyActor {
  readonly userId: string;
  readonly active: boolean;
  readonly roleIds: readonly string[];
  readonly departmentIds: readonly string[];
  /** Ancestors of the actor's departments, excluding their own IDs. */
  readonly ancestorDepartmentIds: readonly string[];
  readonly permissions: readonly string[];
}

export interface DocumentPolicyResource {
  readonly ownerId: string;
  readonly visibility: DocumentVisibility;
  readonly projectId: string | null;
  readonly status: 'active' | 'archived';
  readonly deletedAt: string | null;
}

export interface DocumentGrant {
  readonly subjectType: 'user' | 'role' | 'department';
  readonly subjectId: string;
  readonly permission: DocumentLevel;
  readonly includeDescendants: boolean;
  readonly deletedAt: string | null;
}

/** Resolution of the *linked* project, not an actor-controlled claim. */
export type LinkedProjectAccess =
  | { readonly kind: 'none' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'allowed'; readonly isMember: boolean; readonly archived: boolean };

const rank: Readonly<Record<DocumentLevel, number>> = { view: 1, edit: 2, manage: 3 };
const requiredPermission: Readonly<Record<DocumentAction, string>> = {
  read: 'document:read',
  update: 'document:update',
  'version:create': 'document:version:create',
  delete: 'document:delete',
  'acl:manage': 'document:acl:manage',
};
const requiredLevel: Readonly<Record<DocumentAction, DocumentLevel>> = {
  read: 'view', update: 'edit', 'version:create': 'edit', delete: 'manage', 'acl:manage': 'manage',
};

function grantMatches(actor: DocumentPolicyActor, grant: DocumentGrant): boolean {
  if (grant.deletedAt !== null) return false;
  if (grant.subjectType === 'user') return grant.subjectId === actor.userId;
  if (grant.subjectType === 'role') return actor.roleIds.includes(grant.subjectId);
  return actor.departmentIds.includes(grant.subjectId)
    || (grant.includeDescendants && actor.ancestorDepartmentIds.includes(grant.subjectId));
}

/**
 * Null means not visible. A linked private project guard is evaluated before
 * document ACLs, including owner/admin grants. Incomplete project resolution
 * fails closed. Restricted documents never inherit project or organization view.
 */
export function effectiveDocumentLevel(
  actor: DocumentPolicyActor,
  document: DocumentPolicyResource,
  grants: readonly DocumentGrant[],
  project: LinkedProjectAccess,
): DocumentLevel | null {
  if (!actor.active || document.deletedAt !== null) return null;
  if (document.projectId !== null && project.kind !== 'allowed') return null;
  if (document.projectId === null && project.kind !== 'none') return null;
  if (document.visibility === 'project' && document.projectId === null) return null;

  if (actor.userId === document.ownerId || actor.permissions.includes('document:manage:all')) return 'manage';
  let level: DocumentLevel | null = null;
  if (document.visibility === 'organization') level = 'view';
  if (document.visibility === 'project' && project.kind === 'allowed' && project.isMember) level = 'view';
  for (const grant of grants) {
    if (grantMatches(actor, grant) && (level === null || rank[grant.permission] > rank[level])) level = grant.permission;
  }
  return level;
}

/** Operation permission and resource level are both required. */
export function canAccessDocument(
  actor: DocumentPolicyActor,
  document: DocumentPolicyResource,
  grants: readonly DocumentGrant[],
  project: LinkedProjectAccess,
  action: DocumentAction,
): boolean {
  if (!actor.permissions.includes(requiredPermission[action])) return false;
  const level = effectiveDocumentLevel(actor, document, grants, project);
  if (level === null || rank[level] < rank[requiredLevel[action]]) return false;
  if (action !== 'read' && project.kind === 'allowed' && project.archived) return false;
  if (action !== 'read' && action !== 'delete' && document.status === 'archived') return false;
  return true;
}
