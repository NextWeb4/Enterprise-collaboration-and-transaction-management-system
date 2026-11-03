import { describe, expect, it } from 'vitest';
import {
  DATA_SCOPES,
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  SYSTEM_ROLE_CODES,
  SYSTEM_ROLE_SEEDS,
} from '@collab/shared/permissions.js';

describe('RBAC contract', () => {
  it('keeps the permission catalog unique and internally addressable', () => {
    const codes = PERMISSION_CATALOG.map((permission) => permission.code);

    expect(new Set(codes).size).toBe(codes.length);
    expect(PERMISSION_CODES).toEqual(codes);
    expect(PERMISSION_CATALOG.every((permission) => permission.code === permission.code.toLowerCase())).toBe(true);
  });

  it('keeps every system-role seed within the canonical permission and data-scope contracts', () => {
    const roleCodes = SYSTEM_ROLE_SEEDS.map((role) => role.code);
    const permissionSet = new Set(PERMISSION_CODES);
    const scopeSet = new Set(DATA_SCOPES);

    expect(roleCodes).toEqual([...SYSTEM_ROLE_CODES]);
    expect(new Set(roleCodes).size).toBe(roleCodes.length);
    for (const role of SYSTEM_ROLE_SEEDS) {
      expect(scopeSet.has(role.dataScope)).toBe(true);
      expect(new Set(role.permissionCodes).size).toBe(role.permissionCodes.length);
      expect(role.permissionCodes.every((permission) => permissionSet.has(permission))).toBe(true);
    }
  });

  it('keeps org_admin as the only built-in full-catalog seed', () => {
    const orgAdmin = SYSTEM_ROLE_SEEDS.find((role) => role.code === 'org_admin');
    expect(orgAdmin).toBeDefined();
    expect(new Set(orgAdmin?.permissionCodes)).toEqual(new Set(PERMISSION_CODES));

    for (const role of SYSTEM_ROLE_SEEDS.filter((candidate) => candidate.code !== 'org_admin')) {
      expect(role.permissionCodes.length).toBeLessThan(PERMISSION_CODES.length);
    }
  });
});
