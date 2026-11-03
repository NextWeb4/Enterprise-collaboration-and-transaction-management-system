# 系统管理：FR-SYS-03/04/05

状态：实现了独立服务、已挂载路由、前端页面与真实 LMDB 服务测试。该切片不改变 M0 验收结论。

## 已实现范围

- `SystemService` 在同一 LMDB 只读事务内重新读取用户、会话与角色；系统配置写入、版本校验与审计追加在同一个写事务内完成。
- 配置 API 只允许本阶段明确的组织显示名（2–80 字、拒绝控制字符）和经 `Intl.DateTimeFormat` 验证的 IANA 时区；`workflowAllowSelfApproval` 只读且始终为 `false`。
- 登录记录可按时间、账号、成功/失败和 IP 筛选；操作日志可按时间、操作者、动作、资源类型、结果和请求 ID 筛选。两者默认近 7 天、最大 90 天，分页限制为 1–100。
- 操作日志继续只追加：没有新增修改或删除路由。输出的元数据会再次剔除名称中含 `password`、`token`、`cookie`、`secret`、`content` 或 `body` 的值。
- 前端提供 `SystemSettingsPage`、`SystemLogsPage` 与独立 API 客户端；已由应用导航接入，并由后端 `registerSystemRoutes()` 挂载。

## 授权与数据边界

- 配置读取/修改要求 `setting:manage` 且该权限的数据范围为 `all`。
- 登录记录要求 `login:read` 且范围为 `all`；操作日志要求 `audit:read` 且范围为 `all`。
- 对 `self`、`department`、`department_tree` 一律返回 403，而不是在尚无资源范围策略时放宽为全组织。
- 每个服务入口均从存储重载主体、会话和角色；传入的旧 `AuthContext` 不可绕过角色变化、会话撤销或密码强制修改状态。

## 明确限制

- 本次仅实现用户所指明的组织名和时区；会话时长、上传大小和项目默认值仍是运行时配置，不能通过这个接口伪装为已生效的持久配置。
- 历史登录记录是否已覆盖“锁定事件”取决于登录服务现有记录行为；查询页面不会伪造不存在的记录。
- 路由由 `registerSystemRoutes()` 显式挂载，避免覆盖既有 `/api/v1/audit-logs`。

## 验证

`app/backend/test/system-service.test.ts` 在临时真实 LMDB 中覆盖：

- 合法配置更新、非法名称/时区拒绝、版本更新和审计链；
- 登录/操作日志筛选、分页字段、敏感元数据二次脱敏与 90 天范围限制；
- 当前角色被缩窄到 `self` 后 fail-closed。

对应 HTTP 契约见 [system-management.openapi.json](../03-technical/system-management.openapi.json)。
