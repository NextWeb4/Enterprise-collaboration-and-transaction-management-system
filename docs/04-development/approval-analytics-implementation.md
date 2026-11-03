# 审批耗时经营分析实现记录

日期：2026-11-03

## 交付内容

- `ApprovalAnalyticsService.approvalTiming` 读取审批申请、实例、模板和部门仓储，按 `submittedAt → completedAt` 计算自然小时。
- 仅统计 `approved`、`rejected`、`withdrawn` 的已完成申请；草稿和进行中申请不进入样本。
- 返回样本数、线性插值中位数、P90（结果保留两位小数）及经授权数据生成的类型/部门/模板选择项。
- 过滤器：申请类型、部门、模板。选项只由同一授权集合生成，避免把无权数据的维度泄露给调用者。
- `registerApprovalAnalyticsRoutes` 已挂载到 Fastify，提供 `/api/v1/analytics/approval-timing` 并使用现有 `requireAuth`。
- `AnalyticsPage` 增加审批耗时卡片，查询后展示自然小时统计和合法筛选器。

## 权限边界

服务在事务内重新加载当前 actor，要求 `analytics:read:all` 与 `application:read:all` 两个权限都存在，且两个权限的数据范围都为 `all`。不接受仅有项目分析、审批人待办、审计读取或部门范围的调用，避免把审批正文范围外的数据聚合进报告。

## 验证

- `app/backend/test/approval-analytics.test.ts`：真实隔离 LMDB；验证 2/4/8/10 小时样本的 median/P90、类型/部门/模板过滤、待审批排除和 scope 降级拒绝。
- `app/frontend/src/AnalyticsPage.test.tsx`：验证查询按钮、统计展示及筛选项渲染。
- OpenAPI：`docs/03-technical/analytics-approval.openapi.json`。

## 集成状态

`buildApp` 在创建 `organizationRepos`、`approvalRepos` 后实例化 `ApprovalAnalyticsService` 并调用 `registerApprovalAnalyticsRoutes`。服务路由、前端统计卡片和真实隔离 LMDB 测试均已接入。数据范围过滤仍只支持双权限 all/all；其他范围明确拒绝，未扩展部门级汇总。
