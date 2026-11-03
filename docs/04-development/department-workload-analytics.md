# 部门工作量分析

状态：P1-AN-05 已实现为只读当前快照；不改变 M0 未通过结论。

## 统计口径

- 数据源是现有 `users`、`departments`、`projects` 与 `tasks`，不创建独立指标表、缓存或历史快照；
- 每个任务按其当前 `assigneeId` 对应 active 内部账号的当前 `departmentId` 归集；未分配、负责人已停用/删除、没有部门或部门不在允许范围的任务不计入；
- 仅纳入 `visibility = organization` 的未软删除项目。私有项目、其任务和任何任务明细均不进入报告，避免部门范围绕过项目 ACL；
- `taskCount` 含已取消任务；`completedTaskCount` 仅 `done`；`openTaskCount` 仅 `todo`、`in_progress`、`in_review`；`cancelledTaskCount` 单列；
- 逾期定义与项目分析一致：未完成任务的 `dueDate` 早于组织时区的当天，截止当天不算逾期；
- `activeUserCount` 是范围内当前 active、未删除且所属该部门的内部账号数，不等同于有任务的成员数。

## 权限与数据范围

服务在同一 LMDB 读事务中重载会话、账号和角色。它要求同时具有对应角色授予的 `analytics:read:project` 或 `analytics:read:all`，以及 `project:read` 和 `task:read`。

只合并**同时授予分析权限码**的活跃角色范围：

- `all` 返回所有活动部门；
- `department` 返回主体主部门；
- `department_tree` 返回主体主部门及其所有活动子部门；
- 仅 `self` 范围的主体无法读取部门聚合，返回 403；没有有效主部门时部门范围同样返回 403；
- 请求指定不在允许集合内的 `departmentId` 返回 404。

报告不输出任务 ID、标题、负责人、项目名称或项目 ID，因此部门聚合不会成为私有项目的明细侧信道。

## 接口与验证

`GET /api/v1/analytics/department-workload`，可选 `departmentId`；契约见 [analytics-department-workload.openapi.json](../03-technical/analytics-department-workload.openapi.json)。

`app/backend/test/department-workload.test.ts` 以隔离真实 LMDB 覆盖部门树范围、组织可见项目聚合、私有项目排除、越权筛选 404、`self` 范围拒绝以及 HTTP 路由。前端 `AnalyticsPage.test.tsx` 覆盖页面查询与服务端返回的表格渲染。
