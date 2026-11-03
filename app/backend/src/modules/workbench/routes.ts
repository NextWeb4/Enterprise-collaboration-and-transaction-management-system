import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../core/auth-service.js';
import type { WorkbenchService } from './workbench-service.js';

export function registerWorkbenchRoutes(
  app: FastifyInstance,
  options: {
    service: WorkbenchService;
    requireAuth: preHandlerHookHandler;
    requireCsrf: preHandlerHookHandler;
  },
): void {
  const read = { preHandler: [options.requireAuth] };
  const write = { preHandler: [options.requireAuth, options.requireCsrf] };
  const actor = (request: FastifyRequest): AuthContext => {
    if (!request.authContext) throw new AppError('UNAUTHENTICATED');
    return request.authContext;
  };
  const id = (request: FastifyRequest): string =>
    z.object({ id: z.string().uuid() }).parse(request.params).id;
  const pagination = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      unread: z.enum(['true', 'false']).optional(),
      overdue: z.enum(['true', 'false']).optional(),
    })
    .strict();
  app.get('/api/v1/workbench/activity', read, async (request) => ({
    data: await options.service.activity(actor(request)),
  }));
  app.get('/api/v1/workbench/tasks', read, async (request) => {
    const query = pagination.parse(request.query);
    return options.service.tasks(
      actor(request),
      query.page,
      query.pageSize,
      query.overdue === 'true',
    );
  });
  app.get('/api/v1/notifications', read, async (request) => {
    const query = pagination.parse(request.query);
    return options.service.notifications(
      actor(request),
      query.page,
      query.pageSize,
      query.unread === 'true',
    );
  });
  app.post('/api/v1/notifications/read-all', write, async (request) => {
    await options.service.markRead(actor(request), null);
    return { data: { success: true } };
  });
  app.post('/api/v1/notifications/:id/read', write, async (request) => {
    const input = z.object({ version: z.number().int().positive() }).strict().parse(request.body);
    await options.service.markRead(actor(request), id(request), input.version);
    return { data: { success: true } };
  });
  app.post('/api/v1/projects/:id/visit', write, async (request) => {
    await options.service.visit(actor(request), id(request));
    return { data: { success: true } };
  });
}
