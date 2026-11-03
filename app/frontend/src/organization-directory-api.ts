import { api } from './api';

export interface DirectoryEntry {
  id: string; userId: string; name: string; email: string; status: 'active' | 'disabled';
  departmentId: string | null; departmentName: string | null; positionId: string | null; positionName: string | null;
}
export interface Employee extends DirectoryEntry {
  version: number; employeeNo: string | null; phone: string | null; managerId: string | null; hireDate: string | null; avatarFileId: string | null;
}
export interface Position { id: string; version: number; name: string; code: string; description: string; sortOrder: number; status: 'active' | 'inactive'; }
export interface DepartmentNode { id: string; name: string; code: string | null; parentId: string | null; sortOrder: number; employeeCount: number; children: DepartmentNode[]; }
export interface EmployeeInput { userId: string; employeeNo: string | null; phone: string | null; departmentId: string | null; positionId: string | null; managerId: string | null; hireDate: string | null; avatarFileId: string | null; }
export interface PositionInput { name: string; code: string; description: string; sortOrder: number; status: Position['status']; }
export interface ActiveUserOption { userId: string; name: string; }

export function listDirectory(): Promise<DirectoryEntry[]> { return api('/organization/directory'); }
export function listActiveUsers(): Promise<ActiveUserOption[]> { return api('/organization/active-users'); }
export function listEmployees(): Promise<Employee[]> { return api('/organization/employees'); }
export function getEmployee(id: string): Promise<Employee> { return api(`/organization/employees/${encodeURIComponent(id)}`); }
export function createEmployee(input: EmployeeInput): Promise<Employee> { return api('/organization/employees', { method: 'POST', body: JSON.stringify(input) }); }
export function updateEmployee(id: string, input: EmployeeInput & { version: number }): Promise<Employee> { return api(`/organization/employees/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }); }
export function listPositions(): Promise<Position[]> { return api('/organization/positions'); }
export function createPosition(input: PositionInput): Promise<Position> { return api('/organization/positions', { method: 'POST', body: JSON.stringify(input) }); }
export function updatePosition(id: string, input: PositionInput & { version: number }): Promise<Position> { return api(`/organization/positions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }); }
export function deletePosition(id: string, version: number): Promise<{ success: boolean }> { return api(`/organization/positions/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ version }) }); }
export function listDepartmentTree(): Promise<DepartmentNode[]> { return api('/organization/departments/tree'); }
