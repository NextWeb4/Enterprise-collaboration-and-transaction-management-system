import type { Clock } from '../../shared/clock.js';
import { systemClock } from '../../shared/clock.js';
import type { StorageEngine } from '../../storage/engine.js';
import { BaseRepository, type Repository } from '../../storage/repository.js';
import { SchemaRegistry } from '../../storage/schema-registry.js';
import { departmentSchema, type DepartmentDocument } from './models.js';

export const DEPARTMENT_INDEX_NAMES = ['idx_departments_parent_name', 'idx_departments_code'] as const;

export function departmentIndexKeys(doc: DepartmentDocument): Record<(typeof DEPARTMENT_INDEX_NAMES)[number], readonly string[]> {
  return {
    idx_departments_parent_name: [JSON.stringify([doc.parentId, doc.name])],
    idx_departments_code: doc.code === null ? [] : [doc.code],
  };
}

export interface OrganizationRepositories {
  readonly departments: Repository<DepartmentDocument>;
  readonly registry: SchemaRegistry;
}

export function createOrganizationRepositories(
  engine: StorageEngine,
  clock: Clock = systemClock,
): OrganizationRepositories {
  const registry = new SchemaRegistry();
  const departments = new BaseRepository<DepartmentDocument>({
    store: 'departments', type: 'department', schemaVersion: 1, schema: departmentSchema, clock,
    indexes: [
      { name: 'idx_departments_parent_name', source: 'departments', unique: true, indexKeys: (doc) => departmentIndexKeys(doc).idx_departments_parent_name },
      { name: 'idx_departments_code', source: 'departments', unique: true, indexKeys: (doc) => departmentIndexKeys(doc).idx_departments_code },
    ],
  }, registry, engine);
  return { departments, registry };
}
