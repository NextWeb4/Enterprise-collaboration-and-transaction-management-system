import { z } from 'zod';
import type { DocumentEnvelope } from '../../storage/envelope.js';

const safeText = z.string().trim().refine((value) => [...value].every((character) => {
  const code = character.codePointAt(0) ?? 0;
  return code >= 32 && code !== 127;
}), '不允许控制字符');

export interface EmployeeDocument extends DocumentEnvelope {
  type: 'employee';
  userId: string;
  employeeNo: string | null;
  phone: string | null;
  departmentId: string | null;
  positionId: string | null;
  hireDate: string | null;
  avatarFileId: string | null;
}

export interface PositionDocument extends DocumentEnvelope {
  type: 'position';
  name: string;
  code: string;
  description: string;
  sortOrder: number;
  status: 'active' | 'inactive';
}

const employeeDocumentFieldsSchema = z.object({
  userId: z.string().min(1).max(64),
  employeeNo: safeText.pipe(z.string().min(1).max(64)).nullable(),
  phone: safeText.pipe(z.string().min(3).max(40)).nullable(),
  departmentId: z.string().min(1).max(64).nullable(),
  positionId: z.string().min(1).max(64).nullable(),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  /** 头像文件绑定尚未具备文件授权与 refCount 闭环；当前仅接受 null。 */
  avatarFileId: z.null(),
}).strict();

/** API input includes managerId, which is written to UserDocument.managerId (the sole authority). */
export const employeeFieldsSchema = employeeDocumentFieldsSchema.extend({
  managerId: z.string().min(1).max(64).nullable(),
}).strict();

export const employeeSchema = employeeDocumentFieldsSchema.extend({
  id: z.string().min(1).max(64), type: z.literal('employee'), schemaVersion: z.literal(1),
  version: z.number().int().min(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
}).strict();

export const positionFieldsSchema = z.object({
  name: safeText.pipe(z.string().min(1).max(80)),
  code: safeText.pipe(z.string().min(1).max(64)),
  description: safeText.pipe(z.string().max(300)),
  sortOrder: z.number().int().min(0).max(1000000),
  status: z.enum(['active', 'inactive']),
}).strict();

export const positionSchema = positionFieldsSchema.extend({
  id: z.string().min(1).max(64), type: z.literal('position'), schemaVersion: z.literal(1),
  version: z.number().int().min(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
}).strict();

export type EmployeeInput = z.infer<typeof employeeFieldsSchema>;
export type PositionInput = z.infer<typeof positionFieldsSchema>;
