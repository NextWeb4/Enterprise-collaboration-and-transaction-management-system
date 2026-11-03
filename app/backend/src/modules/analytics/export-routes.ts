import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { AppError } from '../../shared/errors.js';
import type { AuthContext } from '../core/auth-service.js';
import type { ProjectAnalyticsExportService } from './export-service.js';

export interface ProjectAnalyticsExportRouteOptions {
  readonly service: ProjectAnalyticsExportService;
  readonly requireAuth: preHandlerHookHandler;
}

export function registerProjectAnalyticsExportRoutes(
  app: FastifyInstance,
  options: ProjectAnalyticsExportRouteOptions,
): void {
  app.get(
    '/api/v1/analytics/project-completion/export',
    { preHandler: [options.requireAuth] },
    async (request, reply) => {
      const authContext = (request as FastifyRequest & { authContext?: AuthContext }).authContext;
      if (!authContext) throw new AppError('UNAUTHENTICATED', '请先登录');
      const filter = request.query as Record<string, string>;
      const csv = await options.service.projectCompletionCsv(authContext, filter, {
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="project-completion.csv"')
        .header('Cache-Control', 'no-store')
        .send(csv);
    },
  );
}
