# 日历与会议模块

状态：P1 日历/项目日程/会议 CRUD、站内通知及单进程后台提醒已实现，并已由组合根注册服务与路由。

## 能力

- 个人日程、里程碑、会议；月/周视图；事件创建、编辑、软删除；使用 UTC ISO 时间持久化，按组织 IANA 时区输入和展示。
- 会议可邀请最多 50 个 active 内部账号；项目会议的组织者和参与人都必须是有效项目成员。受邀人可接受、拒绝或标为待定，组织者可查看各自响应。
- 创建/改期时扫描事件重叠，返回参与人 ID 和重叠时间；不返回冲突事件 ID、标题、说明或地点。冲突是警告，不阻止保存。
- 项目关联日程除 `calendar:*` 权限外仍受 `project:read`、项目成员关系和项目状态守卫约束。组织可见项目非成员、被移出成员、管理员角色都不能绕过私有项目 ACL。归档项目只读。
- 关键写操作与审计、邀请/响应通知在单个 LMDB UnitOfWork 内提交。日期时间范围最大 93 天。

## 权限与路由

权限码目录：`calendar:read`、`calendar:create`、`calendar:update`、`calendar:delete`、`calendar:invite`、`calendar:respond`。内置 member 和 org_admin 角色已包含这些权限；服务端仍须检查事件所有者/受邀人/项目成员或项目管理角色。候选内部账号接口另需 `organization:directory:read`。

API 契约见 [calendar.openapi.json](calendar.openapi.json)。服务和 route 注册应在组合根创建 `calendarRepos = createCalendarRepositories(engine, repos.registry)`、`calendarService = new CalendarService(calendarRepos, repos, projectRepos, uow, auth, audit)`，然后调用 `registerCalendarRoutes(app, { service: calendarService, core: repos, requireAuth, requireCsrf })`。`WorkbenchService` 的可选第 7 参数也应传入 `calendarRepos`，以便通知铃铛重新校验日历目标权限。前端 `CalendarPage` 需要由 `/app/calendar` 路由渲染，并在 `MeResponse.permissions` 包含 `calendar:read` 时显示入口；此 UI 条件仅用于呈现，后端服务始终执行授权。

## 提醒能力边界

事件可选提前 5/15/30/60 分钟提醒。应用进程启动后立即扫描一次，随后每 60 秒扫描；调度器位于 Fastify 组合根，进程关闭时显式停止，不依赖浏览器计时器、Redis、队列或额外进程。扫描按事件和未拒绝参与人生成候选项，再在独立 LMDB 事务中重新核验账号 active、`calendar:read`、项目成员关系和 `project:read`；通过后原子写入唯一投递标记、站内通知和系统审计记录。

唯一索引以事件、收件人、开始时间和提前分钟去重，重复扫描不会重复通知；某一候选项失败不会阻塞其余候选项，失败会记录脱敏服务日志并在下一分钟重试。事件已开始、已删除、参与人拒绝、账号停用或权限/项目成员关系被收回时不投递。单机进程停止期间不运行提醒；重启后仅会补发仍在“提醒时刻至事件开始”窗口内的项目，开始后错过的提醒不补发。因此该功能不承诺跨停机准点 SLA。

## 存储

- `events`：`calendar_event` JSON 文档，唯一来源；非唯一索引包含 owner、project、startAt。
- `event_reminders`：`calendar_reminder_delivery` 投递去重记录，唯一键由事件、收件人、起始时刻和提前分钟组成；事件改期后会产生新提醒实例。
- `notifications`：沿用共享通知仓储，namespace `calendar`，只保存通用标题/空正文和日程链接；铃铛渲染时读取当前权限并失效链接脱敏。
- 事件删除为软删除；不需要数据库迁移或新依赖。

## 验证

`app/backend/test/calendar.test.ts` 使用隔离临时目录、真实 LMDB 和 Fastify inject，覆盖 CRUD、权限范围、冲突隐私、会议响应、项目 ACL 和提醒去重。`app/frontend/src/CalendarPage.test.tsx` 覆盖月/周、创建操作、错误重试和无权限状态。
