import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../core/auth-service.js';
import type { OrganizationDirectoryService } from './directory-service.js';
import { employeeFieldsSchema, positionFieldsSchema } from './directory-models.js';

type AuthenticatedRequest = FastifyRequest & { authContext?: AuthContext };

export interface OrganizationDirectoryRouteOptions {
  readonly service: OrganizationDirectoryService;
  readonly requireAuth: preHandlerHookHandler;
  readonly requireCsrf: preHandlerHookHandler;
}

function actor(request: FastifyRequest): AuthContext {
  const context = (request as AuthenticatedRequest).authContext;
  if (!context) throw new AppError('UNAUTHENTICATED', '会话已失效');
  return context;
}

function resourceId(request: FastifyRequest): string {
  const parsed = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '资源标识无效');
  return parsed.data.id;
}

export function registerOrganizationDirectoryRoutes(app: FastifyInstance, options: OrganizationDirectoryRouteOptions): void {
  app.get('/api/v1/organization/directory', { preHandler: [options.requireAuth] }, async (request) => ({ data: await options.service.directory(actor(request)) }));
  app.get('/api/v1/organization/active-users', { preHandler: [options.requireAuth] }, async (request) => ({ data: await options.service.activeUsers(actor(request)) }));
  app.get('/api/v1/organization/departments/tree', { preHandler: [options.requireAuth] }, async (request) => ({ data: await options.service.departmentTree(actor(request)) }));
  app.get('/api/v1/organization/employees', { preHandler: [options.requireAuth] }, async (request) => ({ data: await options.service.listEmployees(actor(request)) }));
  app.get('/api/v1/organization/employees/:id', { preHandler: [options.requireAuth] }, async (request) => ({ data: await options.service.getEmployee(actor(request), resourceId(request)) }));
  app.post('/api/v1/organization/employees', { preHandler: [options.requireAuth, options.requireCsrf] }, async (request, reply) => {
    const input = employeeFieldsSchema.parse(request.body);
    return reply.code(201).send({ data: await options.service.createEmployee(actor(request), input) });
  });
  app.patch('/api/v1/organization/employees/:id', { preHandler: [options.requireAuth, options.requireCsrf] }, async (request) => {
    const body = employeeFieldsSchema.extend({ version: z.number().int().min(1) }).strict().parse(request.body);
    const { version, ...fields } = body;
    return { data: await options.service.updateEmployee(actor(request), resourceId(request), version, fields) };
  });
  app.get('/api/v1/organization/positions', { preHandler: [options.requireAuth] }, async (request) => ({ data: await options.service.listPositions(actor(request)) }));
  app.post('/api/v1/organization/positions', { preHandler: [options.requireAuth, options.requireCsrf] }, async (request, reply) => {
    const input = positionFieldsSchema.parse(request.body);
    return reply.code(201).send({ data: await options.service.createPosition(actor(request), input) });
  });
  app.patch('/api/v1/organization/positions/:id', { preHandler: [options.requireAuth, options.requireCsrf] }, async (request) => {
    const body = positionFieldsSchema.extend({ version: z.number().int().min(1) }).strict().parse(request.body);
    const { version, ...fields } = body;
    return { data: await options.service.updatePosition(actor(request), resourceId(request), version, fields) };
  });
  app.delete('/api/v1/organization/positions/:id', { preHandler: [options.requireAuth, options.requireCsrf] }, async (request) => {
    const body = z.object({ version: z.number().int().min(1) }).strict().parse(request.body);
    await options.service.deletePosition(actor(request), resourceId(request), body.version);
    return { data: { success: true } };
  });
}
