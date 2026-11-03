import type { StorageTransaction } from '../../storage/engine.js';
import { departmentIndexKeys, DEPARTMENT_INDEX_NAMES } from './repositories.js';
import { departmentSchema } from './models.js';
import { employeeSchema, positionSchema } from './directory-models.js';
import { employeeIndexKeys, positionIndexKeys, EMPLOYEE_INDEX_NAMES, POSITION_INDEX_NAMES } from './directory-repositories.js';
import { indexStoreKey } from '../../storage/index-registry.js';
import { userSchema } from '../core/models.js';

export interface DirectoryStorageInspection {
  readonly issues: string[];
  readonly expected: Map<string, Map<string, string>>;
}

/** Read-only directory integrity/index inspection used by storage maintenance. */
export function inspectDirectoryStorage(tx: StorageTransaction): DirectoryStorageInspection {
  const issues: string[] = [];
  const expected = new Map<string, Map<string, string>>([...DEPARTMENT_INDEX_NAMES, ...EMPLOYEE_INDEX_NAMES, ...POSITION_INDEX_NAMES].map((name) => [name, new Map()]));
  const users = new Map<string, ReturnType<typeof userSchema.parse>>();
  for (const entry of tx.range<unknown>('users', {})) {
    const parsed = userSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`users: ${entry.key} schema 或主键无效`);
      continue;
    }
    users.set(parsed.data.id, parsed.data);
  }
  const departments = new Map<string, ReturnType<typeof departmentSchema.parse>>();
  for (const entry of tx.range<unknown>('departments', {})) {
    const parsed = departmentSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) {
      issues.push(`departments: ${entry.key} schema 或主键无效`);
      continue;
    }
    const department = parsed.data;
    departments.set(department.id, department);
    if (department.deletedAt !== null) continue;
    const keys = departmentIndexKeys(department);
    for (const name of DEPARTMENT_INDEX_NAMES) {
      const bucket = expected.get(name)!;
      for (const key of keys[name]) {
        if (bucket.has(key)) issues.push(`${name}: 唯一键重复`);
        bucket.set(key, department.id);
      }
    }
  }
  for (const department of departments.values()) {
    if (department.deletedAt !== null || department.parentId === null) continue;
    const parent = departments.get(department.parentId);
    if (!parent || parent.deletedAt !== null) issues.push(`departments: ${department.id} 父部门不存在`);
    const seen = new Set<string>();
    let cursor: string | null = department.id;
    while (cursor !== null) {
      if (seen.has(cursor) || seen.size >= 10) {
        issues.push(`departments: ${department.id} 存在循环或超过十层`);
        break;
      }
      seen.add(cursor);
      cursor = departments.get(cursor)?.parentId ?? null;
    }
  }
  const positions = new Map<string, ReturnType<typeof positionSchema.parse>>();
  const historicalNames = new Set<string>(); const historicalCodes = new Set<string>();
  for (const entry of tx.range<unknown>('positions', {})) {
    const parsed = positionSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) { issues.push(`positions: ${entry.key} schema 或主键无效`); continue; }
    const position = parsed.data; positions.set(position.id, position);
    if (historicalNames.has(position.name) || historicalCodes.has(position.code)) issues.push(`positions: ${position.id} 名称或编码与历史记录重复`);
    historicalNames.add(position.name); historicalCodes.add(position.code);
    if (position.deletedAt !== null) continue;
    for (const name of POSITION_INDEX_NAMES) for (const key of positionIndexKeys(position)[name]) expected.get(name)!.set(key, position.id);
  }
  for (const entry of tx.range<unknown>('employees', {})) {
    const parsed = employeeSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.id !== entry.key) { issues.push(`employees: ${entry.key} schema 或主键无效`); continue; }
    const employee = parsed.data;
    if (employee.deletedAt !== null) continue;
    for (const name of EMPLOYEE_INDEX_NAMES) {
      const unique = name === 'idx_employees_user' || name === 'idx_employees_employee_no';
      for (const key of employeeIndexKeys(employee)[name]) {
        const bucket = expected.get(name)!; const storeKey = unique ? key : indexStoreKey(key, employee.id);
        if (unique && bucket.has(storeKey)) issues.push(`${name}: 唯一键重复`);
        bucket.set(storeKey, employee.id);
      }
    }
    const user = users.get(employee.userId);
    if (!user || user.deletedAt !== null || user.status !== 'active') issues.push(`employees: ${employee.id} 关联用户不存在或已停用`);
    else if (user.departmentId !== employee.departmentId) issues.push(`employees: ${employee.id} 部门与 users 不一致`);
    if (employee.departmentId !== null && (!departments.has(employee.departmentId) || departments.get(employee.departmentId)!.deletedAt !== null)) issues.push(`employees: ${employee.id} 关联部门不存在`);
    if (employee.positionId !== null && (!positions.has(employee.positionId) || positions.get(employee.positionId)!.deletedAt !== null)) issues.push(`employees: ${employee.id} 关联岗位不存在`);
  }
  for (const user of users.values()) {
    if (user.deletedAt !== null || user.status !== 'active' || user.managerId === null || user.managerId === undefined) continue;
    const seen = new Set<string>([user.id]);
    let cursor: string | null = user.managerId;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        issues.push(`users: ${user.id} 直属上级关系存在循环`);
        break;
      }
      seen.add(cursor);
      const manager = users.get(cursor);
      if (!manager || manager.deletedAt !== null || manager.status !== 'active') {
        issues.push(`users: ${user.id} 直属上级不存在或已停用`);
        break;
      }
      cursor = manager.managerId ?? null;
    }
  }
  return { issues, expected };
}
