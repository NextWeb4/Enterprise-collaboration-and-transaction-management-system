import { DATA_SCOPES, type DataScope } from '@collab/shared/permissions.js';
import type { RoleDocument } from './models.js';

/** Keep distinct scopes: a department scope does not necessarily contain self. */
export function scopesForPermission(roles: readonly RoleDocument[], permission: string): DataScope[] {
  const scopes = new Set(roles.filter((role) => role.deletedAt === null && role.permissionCodes.includes(permission)).map((role) => role.dataScope));
  return DATA_SCOPES.filter((scope) => scopes.has(scope));
}
