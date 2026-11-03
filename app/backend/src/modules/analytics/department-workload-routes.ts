import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../core/auth-service.js';
import type { DepartmentWorkloadService } from './department-workload-service.js';

export function registerDepartmentWorkloadRoutes(
  app: FastifyInstance,
  options: { readonly service: DepartmentWorkloadService; readonly requireAuth: preHandlerHookHandler },
): void {
  app.get('/api/v1/analytics/department-workload', { preHandler: [options.requireAuth] }, async (request) => {
    const actor = (request as FastifyRequest & { authContext?: AuthContext }).authContext;
    if (!actor) throw new AppError('UNAUTHENTICATED', '请先登录');
    return { data: await options.service.departmentWorkload(actor, request.query as Record<string, string>) };
  });
}
