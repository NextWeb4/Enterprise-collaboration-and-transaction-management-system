# 项目经营分析服务（内部契约）

状态：服务、只读 HTTP API 与前端汇总页面已实现；以隔离真实 LMDB 和页面测试验证。该功能不改变 M0 验收结论。

实现位置：[ProjectAnalyticsService](../../app/backend/src/modules/analytics/project-analytics-service.ts)。该服务是只读的，不写入业务数据、审计或缓存。

## 已实现的契约

`projectCompletion(authContext, filter?)` 返回当前快照下当前主体可读取的项目任务汇总：

- 每个项目：任务总数、已完成数、取消数、有效任务数、未完成数、完成率、逾期未完成数和逾期率；
- 汇总：上述项目的合计，完成率和逾期率分别按汇总分子/分母计算，不取项目百分比平均；
- `有效任务数 = 非软删除任务总数 - cancelled`；`完成率 = done / 有效任务数 × 100`，有效任务为零时返回 `0`；
- 软删除任务不计入任何指标；`openTaskCount` 仅计 `todo`、`in_progress`、`in_review`；
- 逾期定义为 `dueDate` 早于组织时区的当前日期，且任务状态为 `todo`、`in_progress` 或 `in_review`；当天截止不算逾期；`逾期率 = 逾期未完成 / 未完成 × 100`，分母为零时返回 `0`；
- 逾期清单只返回任务标题、任务编号、项目和截止日，单页最多 100 条；清单与计数使用相同的可见项目集合；
- 结果是 `current_snapshot_filtered_by_project_creation_time`：可选 `createdFrom`（含）与 `createdTo`（不含）筛选的是项目 `createdAt`，不是历史状态趋势。

调用时服务在同一个 LMDB 事务内重新加载会话、用户和角色，拒绝失效主体。必须同时具备：

1. `analytics:read:project` 或 `analytics:read:all`；
2. `project:read` 或 `project:read:all`；
3. `task:read`。

`all` 分析范围只会纳入：作为 owner/manager 的项目，以及拥有 `project:read:all` 的 `all` 范围主体可读的组织可见项目。`self` 范围只纳入主体作为 owner/manager 的项目。无论任何权限或范围，私有项目非成员都不会出现在列表、汇总或指定项目查询中。部门/部门树范围当前拒绝（403），避免在未实现部门资源过滤前返回未经证明的数据。

## 当前明确不实现的内容

- 不产生历史趋势：任务状态变更历史不是完整、可回放的指标来源；
- 不实现部门工作量：部门成员关系和树形范围过滤尚不能可靠地完成；
- 审批耗时由独立 `ApprovalAnalyticsService` 实现，要求分析与审批读取权限的范围均为 `all`；
- 不实现客户、合同、收入、成本、利润等财务指标：当前没有对应的可信业务实体；
- CSV 项目汇总导出已实现；XLSX、异步作业/短时链接、历史图表和缓存尚未实现；
- 不用未经现有项目访问守卫验证的数据补零或伪造真实经营值。

## 集成边界

共享权限目录已加入 `analytics:read:project` 与 `analytics:read:all`；内置组织管理员通过完整目录种子获得这两个权限。API 在同一 LMDB 事务内重新读取主体并由服务执行权限、范围和资源过滤。部门权限码尚未开放，部门/部门树范围明确拒绝。

## 验证证据

`app/backend/test/project-analytics-service.test.ts` 使用临时目录的真实 LMDB，覆盖：

- 缺少分析权限时拒绝；
- 私有项目对非成员不泄露；
- 全范围与 self 范围的不同可见集合；
- 尚不支持的部门范围拒绝；
- 软删除/取消任务的分母、分子和汇总口径；
- 基于项目创建时间的筛选和非法时间区间拒绝。

该测试同时验证组织时区跨 UTC 日期边界的逾期判断、已取消任务排除、截止日当天任务不计逾期，以及逾期清单分页元数据。
