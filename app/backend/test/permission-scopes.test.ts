import { describe, expect, it } from 'vitest';
import type { RoleDocument } from '../src/modules/core/models.js';
import { scopesForPermission } from '../src/modules/core/permission-scopes.js';

function role(dataScope: RoleDocument['dataScope'], permissionCodes: string[], deletedAt: string | null = null): RoleDocument {
  return { id: dataScope, type: 'role', schemaVersion: 1, version: 1, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', deletedAt, code: dataScope, name: dataScope, description: '', dataScope, permissionCodes, system: false };
}

describe('permission scope union', () => {
  it('only includes scopes of active roles granting the requested permission', () => {
    const roles = [role('self', ['project:read']), role('department', ['project:read']), role('all', ['user:manage']), role('department_tree', ['project:read'], '2026-11-02T00:00:00.000Z')];
    expect(scopesForPermission(roles, 'project:read')).toEqual(['self', 'department']);
    expect(scopesForPermission(roles, 'user:manage')).toEqual(['all']);
    expect(scopesForPermission(roles, 'document:read')).toEqual([]);
  });

  it('deduplicates scopes without dropping self or expanding department privileges', () => {
    expect(scopesForPermission([role('self', ['read']), role('self', ['read']), role('department_tree', ['read'])], 'read')).toEqual(['self', 'department_tree']);
  });
});
