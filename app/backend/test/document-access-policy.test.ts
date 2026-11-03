import { describe, expect, it } from 'vitest';
import {
  canAccessDocument, effectiveDocumentLevel,
  type DocumentGrant, type DocumentPolicyActor, type DocumentPolicyResource,
} from '../src/modules/documents/access-policy.js';

const actor: DocumentPolicyActor = {
  userId: 'alice', active: true, roleIds: ['editor'], departmentIds: ['child'],
  ancestorDepartmentIds: ['parent'],
  permissions: ['document:read', 'document:update', 'document:version:create', 'document:delete', 'document:acl:manage'],
};
const doc: DocumentPolicyResource = { ownerId: 'owner', visibility: 'restricted', projectId: null, status: 'active', deletedAt: null };
const grant = (subjectType: DocumentGrant['subjectType'], subjectId: string, permission: DocumentGrant['permission'], includeDescendants = false): DocumentGrant =>
  ({ subjectType, subjectId, permission, includeDescendants, deletedAt: null });
const none = { kind: 'none' } as const;
const member = { kind: 'allowed', isMember: true, archived: false } as const;
const nonmember = { kind: 'allowed', isMember: false, archived: false } as const;
const denied = { kind: 'denied' } as const;

describe('document ACL policy', () => {
  it('defaults to no access and requires the corresponding operation permission even for owner', () => {
    expect(effectiveDocumentLevel(actor, doc, [], none)).toBeNull();
    expect(canAccessDocument(actor, doc, [], none, 'read')).toBe(false);
    const owner = { ...actor, userId: 'owner', permissions: ['document:read'] };
    expect(canAccessDocument(owner, doc, [], none, 'read')).toBe(true);
    expect(canAccessDocument(owner, doc, [], none, 'delete')).toBe(false);
    expect(effectiveDocumentLevel({ ...actor, active: false }, doc, [], none)).toBeNull();
    expect(effectiveDocumentLevel(actor, { ...doc, deletedAt: '2026-11-02T00:00:00Z' }, [], none)).toBeNull();
  });

  it('inherits organization and project access only for the selected visibility', () => {
    expect(effectiveDocumentLevel(actor, { ...doc, visibility: 'organization' }, [], none)).toBe('view');
    const projectDoc = { ...doc, visibility: 'project' as const, projectId: 'project' };
    expect(effectiveDocumentLevel(actor, projectDoc, [], member)).toBe('view');
    expect(effectiveDocumentLevel(actor, projectDoc, [], nonmember)).toBeNull();
    expect(effectiveDocumentLevel(actor, { ...projectDoc, visibility: 'restricted' }, [], member)).toBeNull();
    expect(effectiveDocumentLevel(actor, { ...doc, visibility: 'project' }, [], none)).toBeNull();
  });

  it('does not let owner, administrator or explicit ACL bypass a denied linked project', () => {
    const linked = { ...doc, projectId: 'private' };
    const privileged = { ...actor, userId: 'owner', permissions: [...actor.permissions, 'document:manage:all'] };
    expect(effectiveDocumentLevel(privileged, linked, [grant('user', 'owner', 'manage')], denied)).toBeNull();
    expect(effectiveDocumentLevel(privileged, linked, [], none)).toBeNull();
    expect(effectiveDocumentLevel(privileged, doc, [], member)).toBeNull();
    expect(effectiveDocumentLevel(privileged, linked, [], member)).toBe('manage');
  });

  it('combines user, role and department grants by highest level, respecting descendants and deletions', () => {
    const grants = [grant('user', 'alice', 'view'), grant('role', 'editor', 'edit'), grant('department', 'parent', 'manage')];
    expect(effectiveDocumentLevel(actor, doc, grants, none)).toBe('edit');
    expect(effectiveDocumentLevel(actor, doc, [...grants, grant('department', 'parent', 'manage', true)], none)).toBe('manage');
    expect(effectiveDocumentLevel(actor, doc, [grant('department', 'child', 'edit')], none)).toBe('edit');
    expect(effectiveDocumentLevel(actor, doc, [{ ...grant('user', 'alice', 'manage'), deletedAt: '2026-11-02T00:00:00Z' }], none)).toBeNull();
    expect(effectiveDocumentLevel(actor, doc, [grant('role', 'other', 'manage')], none)).toBeNull();
  });

  it('requires edit or manage as appropriate and keeps archived documents or projects read-only', () => {
    const edit = [grant('user', 'alice', 'edit')];
    expect(canAccessDocument(actor, doc, edit, none, 'read')).toBe(true);
    expect(canAccessDocument(actor, doc, edit, none, 'update')).toBe(true);
    expect(canAccessDocument(actor, doc, edit, none, 'version:create')).toBe(true);
    expect(canAccessDocument(actor, doc, edit, none, 'delete')).toBe(false);
    expect(canAccessDocument(actor, doc, edit, none, 'acl:manage')).toBe(false);
    const manage = [grant('user', 'alice', 'manage')];
    expect(canAccessDocument(actor, doc, manage, none, 'delete')).toBe(true);
    expect(canAccessDocument(actor, doc, manage, none, 'acl:manage')).toBe(true);
    expect(canAccessDocument(actor, { ...doc, status: 'archived' }, manage, none, 'read')).toBe(true);
    expect(canAccessDocument(actor, { ...doc, status: 'archived' }, manage, none, 'update')).toBe(false);
    const projectDoc = { ...doc, projectId: 'p' };
    expect(canAccessDocument(actor, projectDoc, manage, { ...member, archived: true }, 'version:create')).toBe(false);
  });
});
