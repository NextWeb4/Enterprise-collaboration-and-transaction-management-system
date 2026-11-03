import type { Clock } from '../../shared/clock.js';
import { systemClock } from '../../shared/clock.js';
import type { StorageEngine } from '../../storage/engine.js';
import { BaseRepository, type Repository } from '../../storage/repository.js';
import { SchemaRegistry } from '../../storage/schema-registry.js';
import type { EmployeeDocument, PositionDocument } from './directory-models.js';
import { employeeSchema, positionSchema } from './directory-models.js';

export const EMPLOYEE_INDEX_NAMES = ['idx_employees_user', 'idx_employees_employee_no', 'idx_employees_department', 'idx_employees_position'] as const;
export const POSITION_INDEX_NAMES = ['idx_positions_name', 'idx_positions_code'] as const;

export function employeeIndexKeys(doc: EmployeeDocument): Record<(typeof EMPLOYEE_INDEX_NAMES)[number], readonly string[]> {
  return {
    idx_employees_user: [doc.userId],
    idx_employees_employee_no: doc.employeeNo === null ? [] : [doc.employeeNo],
    idx_employees_department: doc.departmentId === null ? [] : [doc.departmentId],
    idx_employees_position: doc.positionId === null ? [] : [doc.positionId],
  };
}

export function positionIndexKeys(doc: PositionDocument): Record<(typeof POSITION_INDEX_NAMES)[number], readonly string[]> {
  return { idx_positions_name: [doc.name], idx_positions_code: [doc.code] };
}

export interface OrganizationDirectoryRepositories {
  readonly employees: Repository<EmployeeDocument>;
  readonly positions: Repository<PositionDocument>;
  readonly registry: SchemaRegistry;
}

export function createOrganizationDirectoryRepositories(engine: StorageEngine, clock: Clock = systemClock, registry = new SchemaRegistry()): OrganizationDirectoryRepositories {
  const employees = new BaseRepository<EmployeeDocument>({
    store: 'employees', type: 'employee', schemaVersion: 1, schema: employeeSchema, clock,
    indexes: [
      { name: 'idx_employees_user', source: 'employees', unique: true, indexKeys: (doc) => employeeIndexKeys(doc).idx_employees_user },
      { name: 'idx_employees_employee_no', source: 'employees', unique: true, indexKeys: (doc) => employeeIndexKeys(doc).idx_employees_employee_no },
      { name: 'idx_employees_department', source: 'employees', unique: false, indexKeys: (doc) => employeeIndexKeys(doc).idx_employees_department },
      { name: 'idx_employees_position', source: 'employees', unique: false, indexKeys: (doc) => employeeIndexKeys(doc).idx_employees_position },
    ],
  }, registry, engine);
  const positions = new BaseRepository<PositionDocument>({
    store: 'positions', type: 'position', schemaVersion: 1, schema: positionSchema, clock,
    indexes: [
      { name: 'idx_positions_name', source: 'positions', unique: true, indexKeys: (doc) => positionIndexKeys(doc).idx_positions_name },
      { name: 'idx_positions_code', source: 'positions', unique: true, indexKeys: (doc) => positionIndexKeys(doc).idx_positions_code },
    ],
  }, registry, engine);
  return { employees, positions, registry };
}
