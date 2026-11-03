import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AuthContext } from '../core/auth-service.js';
import type { ApprovalAnalyticsService } from './approval-analytics-service.js';

export interface AnalyticsRouteOptions {
  readonly service: ApprovalAnalyticsService;
  readonly requireAuth: preHandlerHookHandler;
}

export function registerApprovalAnalyticsRoutes(app: FastifyInstance, options: AnalyticsRouteOptions): void {
  app.get('/api/v1/analytics/approval-timing', { preHandler: [options.requireAuth] }, async (request) => ({
    data: await options.service.approvalTiming((request as FastifyRequest & { authContext?: AuthContext }).authContext!, request.query as Record<string, string>),
  }));
}
