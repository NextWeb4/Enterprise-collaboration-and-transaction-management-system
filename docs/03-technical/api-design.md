# API 设计规范

> 文档状态：Draft for Review  
> 版本：0.1.0  
> 日期：2026-10-31  
> 风格：REST / JSON / OpenAPI 3.1  
> Base URL：`/api/v1`（健康检查例外：`/health/live`、`/health/ready` 不在 `/api/v1` 下）  
> 关联：[系统架构](system-architecture.md)、[数据存储设计](data-storage-design.md)、[安全设计](security-design.md)

## 1. 基本原则

1. 资源化 URL，名词复数；动作用子资源或明确的 action 端点，不把动词塞进路径。
2. 同源部署；Cookie 认证；不使用长期 JWT。
3. 所有输入 Zod 校验；所有输出 DTO 明确字段，不返回存储层文档。
4. 成功响应统一 `{ "data": ... }`；列表加 `meta`；错误用 `application/problem+json`。
5. 具体资源越权返回 404；功能无权限返回 403；状态冲突返回 409。
6. 更新携带 `version` 做乐观锁；审批用当前步骤/行锁，不依赖客户端版本。
7. 会创建资源的 POST 支持 `Idempotency-Key`（至少申请提交）。
8. 所有响应带 `X-Request-Id`；错误体也包含 `requestId`。
9. 时间 ISO 8601 UTC；日期 `YYYY-MM-DD`。
10. 单组织部署；不在 URL/Query 传组织标识。

## 2. 认证、CSRF 与请求头

| Header | 说明 |
|---|---|
| `Cookie: collab_session=...` | HttpOnly 会话 |
| `X-CSRF-Token` | 变更请求必带；值来自 `/auth/me` |
| `X-Request-Id` | 可选；客户端生成 UUID，服务端校验/生成并回写 |
| `Idempotency-Key` | 可选；创建类请求，UUID，24h 有效 |
| `Content-Type` | `application/json` 或 `multipart/form-data` |
| `Accept` | `application/json`；下载用 `*/*` |

CSRF 规则：

- 登录请求免 CSRF token，但校验 `Origin`/`Referer` 与 `WEB_ORIGIN`。
- 登录成功后，`/auth/me` 返回 `csrfToken`；同时设置可读的 `csrf_token` Cookie（双提交）。
- 所有 `POST/PATCH/PUT/DELETE` 校验 `X-CSRF-Token` 与 Cookie 值一致。
- 失败 403 `CSRF_INVALID`，不执行业务。

CORS：

- 生产同源，不启用跨域。
- 开发仅允许 `http://localhost:5173`；携带凭证；不允许 `*`。
- 不使用 `Access-Control-Allow-Origin: *` 与 Cookie 组合。

## 3. 响应格式

### 3.1 成功（单资源）

```json
{
  "data": {
    "id": "0192f1c4-7d3a-7b2e-9a11-3c5d8e9f0a12",
    "name": "官网改版",
    "status": "active"
  }
}
```

### 3.2 成功（列表）

```json
{
  "data": [
    { "id": "...", "title": "首页改版" }
  ],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 137
  }
}
```

### 3.3 成功（动作）

```json
{
  "data": {
    "status": "approved",
    "completedAt": "2026-11-03T09:21:00.000Z"
  }
}
```

### 3.4 错误（RFC 9457）

```json
{
  "type": "https://collab-office.local/errors/task-state-invalid",
  "title": "Task state invalid",
  "status": 409,
  "code": "TASK_STATE_INVALID",
  "detail": "任务已完成，不能直接改为待处理；请显式提交 0-99 的进度。",
  "instance": "/api/v1/tasks/0192...",
  "requestId": "req_01J...",
  "errors": [
    { "path": "status", "message": "invalid transition" }
  ]
}
```

规则：

- `code` 稳定，前端按 code 做提示；`detail` 可调整。
- 422 才带字段级 `errors`；500 不返回内部细节/堆栈/存储路径。
- 401 统一“邮箱或密码错误”或“会话已失效”，不泄露账号存在性。
- 403 页面级可说明缺少权限；具体资源越权用 404。

## 4. 状态码

| 码 | 用途 |
|---|---|
| 200 | 查询/更新成功 |
| 201 | 创建成功，带 `Location` |
| 204 | 删除/无响应体动作 |
| 400 | 请求格式错误 |
| 401 | 未认证/会话失效 |
| 403 | 已认证但无功能权限/CSRF 失败 |
| 404 | 资源不存在/越权/跨用户或项目 |
| 409 | 状态冲突、重复、版本冲突、唯一约束 |
| 413 | 文件过大 |
| 415 | 文件类型不支持 |
| 422 | 字段校验失败 |
| 429 | 限流 |
| 500 | 未预期错误 |
| 503 | 依赖不可用/维护 |

## 5. 分页、筛选、排序

- `page` 默认 1，最小 1。
- `pageSize` 默认 20，可选 10/20/50/100，最大 100。
- 返回 `meta.total`；前端可计算总页数。深分页 >100 页提示缩小范围。
- 筛选参数用 camelCase，如 `status=active&assigneeId=...`。
- 日期范围 `from`/`to`（含边界按业务定义）。
- 排序 `sortBy` + `sortOrder=asc|desc`，仅白名单字段；默认由端点定义。
- 搜索 `q`，长度 1–100；不提供任意字段搜索。
- 数组参数用重复 key：`tagIds=a&tagIds=b`；最多 20 个。
- 不提供组织/租户参数；单组织部署。

## 6. 并发与幂等

### 6.1 乐观锁

- 可编辑资源（项目、任务、申请、文档）响应含 `version`。
- 更新请求体必须带当前 `version`。
- 服务端 `UPDATE ... WHERE id=? AND version=?`；影响 0 行 → 409 `VERSION_CONFLICT`。
- 前端收到 409 后刷新资源，不自动重放。

### 6.2 幂等键

- 适用：`POST /applications/{id}/submit`（必须支持）；其他创建类端点可选。
- Header `Idempotency-Key`：UUID，8–64 字符。
- 同用户 + 同 key + 同请求体 → 返回首次响应（状态码/体一致）。
- 同 key + 不同请求体 → 409 `IDEMPOTENCY_KEY_REUSED`。
- 24 小时过期；过期后同 key 视为新请求。
- 审批不使用幂等键：重复审批由状态/唯一约束返回 409。

## 7. 文件上传与下载

### 7.1 上传

`POST /api/v1/documents`、`POST /api/v1/applications/{id}/attachments`：

- `multipart/form-data`；文件字段 `file`；其他字段为文本/JSON。
- 单文件；服务端流式处理，限制大小（默认 25MB；申请附件 10MB）。
- 校验扩展名 + MIME + 文件头；禁止 HTML/SVG/脚本/可执行文件。
- 返回 201 + 文档/附件元数据；不返回存储绝对路径。
- 失败清理临时文件；不创建半成品记录。

### 7.2 下载

`GET /api/v1/documents/{id}/download?versionId=...`

- 必须先鉴权；不能直接暴露存储目录。
- 响应头：
  - `Content-Type: application/octet-stream`（下载）
  - `Content-Disposition: attachment; filename*=UTF-8''...`
  - `Content-Length`
  - `X-Content-Type-Options: nosniff`
- 支持 `Range`（P1 可选）；首版可整文件流式下载。
- 版本不存在/无权 → 404。

## 8. 端点目录

> 权限列为“权限码 + 资源守卫”；实际以服务层为准。所有端点默认要求登录，公开端点单独标注。

### 8.1 认证

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | 公开 + Origin | 登录；返回用户/权限/CSRF |
| POST | `/auth/logout` | 登录 | 撤销当前会话 |
| GET | `/auth/me` | 登录 | 当前用户/组织/权限/CSRF |
| POST | `/auth/change-password` | 登录 | 改密；撤销其他会话 |
| GET | `/health/live` | 公开 | 进程存活 |
| GET | `/health/ready` | 公开（内网） | DB/迁移/存储就绪 |

`/auth/me` 响应示例：

```json
{
  "data": {
    "user": { "id": "...", "name": "李四", "email": "lisi@example.com" },
    "organization": { "id": "...", "name": "示例组织", "timezone": "Asia/Shanghai" },
    "roles": ["member"],
    "permissions": ["workbench:read", "project:create", "..."],
    "csrfToken": "..."
  }
}
```

### 8.2 工作台

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/workbench` | `workbench:read` | 聚合；`modules` 可选 |

响应：

```json
{
  "data": {
    "todos": { "items": [], "total": 3, "overdue": 1 },
    "approvals": { "items": [], "total": 2 },
    "notifications": { "items": [], "unread": 4 },
    "recentProjects": [],
    "overview": { "openTasks": 8, "dueThisWeek": 3, "completedThisWeek": 5 }
  },
  "meta": { "partial": false, "errors": [] }
}
```

模块级失败时 `partial=true`，`errors` 标记模块；HTTP 仍 200。

### 8.3 项目

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/projects` | `project:read` | 列表；`status`、`visibility`、`q`、分页 |
| POST | `/projects` | `project:create` | 创建；201 |
| GET | `/projects/{id}` | `project:read` + 守卫 | 详情 |
| PATCH | `/projects/{id}` | `project:update` + 守卫 | 编辑；带 version |
| DELETE | `/projects/{id}` | `project:delete` | 软删除；org_admin |
| POST | `/projects/{id}/transition` | `project:archive` / `project:update` | 状态迁移 |
| GET | `/projects/{id}/overview` | `project:read` | 完成率/逾期/待验收 |
| GET | `/projects/{id}/members` | `project:read` | 成员列表 |
| POST | `/projects/{id}/members` | `project:member:manage` | 添加成员 |
| PATCH | `/projects/{id}/members/{userId}` | `project:member:manage` | 改项目角色 |
| DELETE | `/projects/{id}/members/{userId}` | `project:member:manage` | 移除；有任务 409 |
| POST | `/projects/{id}/transfer-owner` | `project:owner:transfer` | 转让 owner |

创建示例：

```json
POST /api/v1/projects
{
  "name": "官网改版",
  "key": "WEB",
  "description": "2026 年官网重构",
  "visibility": "private",
  "startDate": "2026-11-05",
  "dueDate": "2027-01-31"
}
```

状态迁移：

```json
POST /api/v1/projects/{id}/transition
{
  "targetStatus": "completed",
  "reason": "目标达成",
  "version": 7
}
```

### 8.4 任务

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/projects/{id}/tasks` | `task:read` | 列表/筛选/分页 |
| POST | `/projects/{id}/tasks` | `task:create` | 创建；201 |
| GET | `/tasks/{id}` | `task:read` | 详情 |
| PATCH | `/tasks/{id}` | `task:update` + 字段策略 | 编辑；带 version |
| DELETE | `/tasks/{id}` | `task:delete` | 软删除 |
| PATCH | `/tasks/{id}/board` | `task:update` / `task:assign` | 跨列/排序 |
| GET | `/tasks/{id}/comments` | `task:read` | 评论列表 |
| POST | `/tasks/{id}/comments` | `task:comment` | 评论 |
| PATCH | `/comments/{id}` | `task:comment` + 作者 | 15 分钟内 |
| DELETE | `/comments/{id}` | 作者/`task:comment:moderate` | 软删除 |

创建示例：

```json
POST /api/v1/projects/{projectId}/tasks
{
  "title": "首页改版",
  "description": "按新品牌规范重做首屏",
  "priority": "high",
  "assigneeId": "0192...",
  "startDate": "2026-11-06",
  "dueDate": "2026-11-20"
}
```

看板移动：

```json
PATCH /api/v1/tasks/{id}/board
{
  "targetStatus": "in_progress",
  "targetIndex": 0,
  "version": 4
}
```

### 8.5 OA 申请与审批

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/applications` | `application:read:self` / `:all` | 我的/全部（按 scope） |
| POST | `/applications` | `application:create` | 创建草稿 |
| GET | `/applications/{id}` | 申请人/审批人/`:all` | 详情 |
| PATCH | `/applications/{id}` | 申请人 + draft | 编辑草稿；带 version |
| DELETE | `/applications/{id}` | 申请人 + draft | 删除草稿 |
| POST | `/applications/{id}/submit` | `application:submit` | 提交；Idempotency-Key |
| POST | `/applications/{id}/withdraw` | `application:withdraw` | 撤回 |
| POST | `/applications/{id}/duplicate` | `application:create` | 复制为草稿 |
| GET | `/applications/{id}/history` | 有权查看 | 审批时间线 |
| POST | `/applications/{id}/attachments` | 申请人 + draft | 上传附件 |
| DELETE | `/applications/{id}/attachments/{attachmentId}` | 申请人 + draft | 删除附件 |
| GET | `/approvals` | `application:approve` | 待我审批 |
| POST | `/applications/{id}/approve` | `application:approve` + 当前步骤 | 通过 |
| POST | `/applications/{id}/reject` | `application:approve` + 当前步骤 | 驳回；意见必填 |
| POST | `/applications/{id}/reassign` | `workflow:reassign` | 管理员转交 |
| GET | `/workflow-templates` | `workflow:template:manage` | 模板列表 |
| POST | `/workflow-templates` | 同上 | 创建草稿 |
| PATCH | `/workflow-templates/{id}` | 同上 | 编辑草稿步骤 |
| POST | `/workflow-templates/{id}/publish` | 同上 | 发布新版本 |
| POST | `/workflow-templates/{id}/deactivate` | 同上 | 停用 |

创建草稿示例：

```json
POST /api/v1/applications
{
  "type": "leave",
  "title": "11 月 3-4 日年假",
  "formData": {
    "leaveType": "annual",
    "startAt": "2026-11-03T01:00:00.000Z",
    "endAt": "2026-11-04T10:00:00.000Z",
    "durationDays": 2,
    "reason": "家庭事务",
    "handoverUserId": "0192..."
  }
}
```

提交：

```http
POST /api/v1/applications/{id}/submit
Idempotency-Key: 7b1e...
```

审批：

```json
POST /api/v1/applications/{id}/approve
{ "comment": "同意" }
```

转交：

```json
POST /api/v1/applications/{id}/reassign
{
  "newApproverId": "0192...",
  "reason": "原审批人出差，授权转交"
}
```

### 8.6 通知

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/notifications` | 登录 | 列表；`unreadOnly` |
| POST | `/notifications/{id}/read` | 本人 | 标记已读 |
| POST | `/notifications/read-all` | 登录 | 全部已读 |

### 8.7 组织

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/organization` | `organization:directory:read` | 组织信息（脱敏） |
| GET | `/organization/departments/tree` | `department:read` | 部门树 + 人数 |
| POST | `/organization/departments` | `department:manage` | 创建 |
| PATCH | `/organization/departments/{id}` | `department:manage` | 编辑 |
| DELETE | `/organization/departments/{id}` | `department:manage` | 软删除 |
| GET | `/organization/positions` | `position:read` | 岗位列表 |
| POST | `/organization/positions` | `position:manage` | 创建 |
| PATCH | `/organization/positions/{id}` | `position:manage` | 编辑 |
| DELETE | `/organization/positions/{id}` | `position:manage` | 软删除 |
| GET | `/organization/employees` | `employee:read` + scope | 员工档案列表 |
| GET | `/organization/employees/{userId}` | 本人/`employee:read` | 详情 |
| PATCH | `/organization/employees/{userId}` | 本人有限字段/`employee:manage` | 更新 |
| GET | `/organization/roles` | `role:manage` | 角色列表 |
| POST | `/organization/roles` | `role:manage` | 创建自定义角色 |
| PATCH | `/organization/roles/{id}` | `role:manage` | 更新权限/范围 |
| DELETE | `/organization/roles/{id}` | `role:manage` | 未被引用才可删 |
| GET | `/organization/permissions` | `permission:read` | 权限目录 |
| GET | `/organization/users/{userId}/effective-permissions` | `role:manage` | 有效权限预览 |

### 8.8 系统

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/users` | `user:manage` | 账号列表 |
| POST | `/users` | `user:manage` | 创建；返回一次性临时密码 |
| GET | `/users/{id}` | `user:manage` | 账号详情 |
| PATCH | `/users/{id}` | `user:manage` | 基础信息/状态 |
| POST | `/users/{id}/disable` | `user:manage` | 停用；保护规则 |
| POST | `/users/{id}/enable` | `user:manage` | 启用 |
| POST | `/users/{id}/reset-password` | `user:manage` | 重置；返回一次性密码 |
| POST | `/users/{id}/revoke-sessions` | `session:manage` | 强制下线 |
| PUT | `/users/{id}/roles` | `role:manage` | 设置角色（全量） |
| GET | `/login-records` | `login:read` | 登录记录 |
| GET | `/operation-logs` | `audit:read` | 操作日志 |
| GET | `/settings` | `setting:manage` | 系统配置 |
| PATCH | `/settings` | `setting:manage` | 部分更新 |

创建用户：

```json
POST /api/v1/users
{
  "name": "王五",
  "email": "wangwu@example.com",
  "departmentId": "0192...",
  "positionId": "0192...",
  "managerId": "0192...",
  "roleIds": ["0192..."]
}
```

响应中的临时密码只出现一次：

```json
{
  "data": {
    "user": { "id": "..." },
    "temporaryPassword": "Xk9#...",
    "mustChangePassword": true
  }
}
```

### 8.9 文档

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/documents` | `document:read` | 列表/搜索/筛选 |
| POST | `/documents` | `document:create` | 上传；multipart |
| GET | `/documents/{id}` | `document:read` + ACL | 详情 |
| PATCH | `/documents/{id}` | `document:update` + ACL edit | 元数据；带 version |
| DELETE | `/documents/{id}` | `document:delete` + ACL manage | 软删除 |
| GET | `/documents/{id}/download` | ACL view | 下载当前/指定版本 |
| GET | `/documents/{id}/versions` | ACL view | 版本列表 |
| POST | `/documents/{id}/versions` | `document:version:create` + ACL edit | 上传新版本 |
| GET | `/documents/{id}/permissions` | ACL manage | ACL 列表 |
| POST | `/documents/{id}/permissions` | `document:acl:manage` | 添加/更新 ACL |
| DELETE | `/documents/{id}/permissions/{aclId}` | `document:acl:manage` | 撤销 |
| GET | `/document-categories` | `document:read` | 分类树 |
| POST | `/document-categories` | `document:category:manage` | 创建 |
| PATCH | `/document-categories/{id}` | `document:category:manage` | 编辑 |
| DELETE | `/document-categories/{id}` | `document:category:manage` | 删除 |
| GET | `/document-tags` | `document:read` | 标签 |
| POST | `/document-tags` | `document:tag:manage` | 创建 |
| DELETE | `/document-tags/{id}` | `document:tag:manage` | 删除 |

上传示例（multipart）：

```text
POST /api/v1/documents
file=@contract.pdf
title=2026 年服务合同
categoryId=0192...
visibility=restricted
tagIds=0192...,0192...
```

## 9. 权限与数据过滤

- 每个端点声明权限码；服务层执行资源守卫。
- 列表查询先按权限码判断，再按资源关系/数据范围过滤；禁止先查全量再前端过滤。
- 审批端点额外校验“当前步骤审批人”，仅有 `application:approve` 不够。
- 文档端点额外校验 ACL（owner/role/department/project/org）。
- 管理员端点也写审计；`system_admin` 默认不读业务正文。
- 具体资源越权返回 404；功能无权限 403。

## 10. 错误码目录（节选）

| code | HTTP | 场景 |
|---|---|---|
| `VALIDATION_FAILED` | 422 | 字段校验失败 |
| `UNAUTHENTICATED` | 401 | 未登录/会话失效 |
| `ACCOUNT_DISABLED` | 401 | 账号停用 |
| `FORBIDDEN` | 403 | 功能无权限 |
| `CSRF_INVALID` | 403 | CSRF 失败 |
| `NOT_FOUND` | 404 | 资源不存在/越权 |
| `VERSION_CONFLICT` | 409 | 乐观锁冲突 |
| `PROJECT_KEY_TAKEN` | 409 | 项目短键重复 |
| `PROJECT_STATE_INVALID` | 409 | 项目状态迁移非法 |
| `PROJECT_HAS_OPEN_TASKS` | 409 | 完成/删除项目时仍有未完成任务 |
| `TASK_STATE_INVALID` | 409 | 任务状态迁移非法 |
| `TASK_PROGRESS_INVALID` | 422 | 进度与状态不一致 |
| `COMMENT_EDIT_WINDOW_EXPIRED` | 409 | 评论超过 15 分钟 |
| `WORKFLOW_TEMPLATE_MISSING` | 409 | 无 active 模板 |
| `APPROVER_UNRESOLVED` | 422 | 审批人无法解析 |
| `SELF_APPROVAL_FORBIDDEN` | 422 | 审批人是申请人 |
| `APPLICATION_STATE_INVALID` | 409 | 申请状态不允许 |
| `APPROVAL_ALREADY_DECIDED` | 409 | 重复审批 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 同 key 不同请求体 |
| `FILE_TOO_LARGE` | 413 | 文件超限 |
| `FILE_TYPE_UNSUPPORTED` | 415 | 类型不允许 |
| `USER_EMAIL_TAKEN` | 409 | 邮箱重复 |
| `LAST_ADMIN_PROTECTED` | 409 | 最后一个管理员 |
| `CURRENT_APPROVER_ACTIVE` | 409 | 停用当前审批人前需转交 |
| `RATE_LIMITED` | 429 | 限流 |
| `STORAGE_UNAVAILABLE` | 503 | LMDB/数据目录不可用/维护中 |
| `STORAGE_CORRUPTED` | 503 | 存储校验失败；需恢复 |
| `FILE_MISSING` | 410 | 元数据存在但文件缺失 |
| `FILE_CHECKSUM_MISMATCH` | 409 | 文件校验失败 |

## 11. OpenAPI 与契约

- 使用 `fastify-type-provider-zod` 从 Zod schema 生成 OpenAPI 3.1。
- 每个端点必须有 `summary`、`description`、`tags`、`security`、`responses`。
- `/api/docs` 仅开发/内网；生产默认关闭或加管理员认证。
- `app/shared` 导出请求/响应 schema、枚举、权限码；前端直接复用类型。
- CI 校验 OpenAPI 可生成、无重复 operationId。
- 破坏性变更：新版本 `/api/v2` 或兼容字段；首版不承诺外部 API 稳定性。

## 12. 限流

| 端点 | 限制 |
|---|---|
| `POST /auth/login` | 5 次/分钟/IP；5 次失败锁定账号 15 分钟 |
| `POST /auth/change-password` | 5 次/分钟/用户 |
| 通用读 | 300 次/分钟/用户 |
| 通用写 | 120 次/分钟/用户 |
| 上传 | 20 次/分钟/用户 |
| 审批 | 60 次/分钟/用户 |

限流返回 429，带 `Retry-After`。不以 IP 作为唯一用户标识（NAT 场景）。

## 13. API 反模式

禁止：

- `POST /projects/create`、`POST /tasks/update` 这类动词路径；
- 返回 `password_hash`、`token_hash`、存储绝对路径；
- 在 query 传用户/部门/项目标识作为授权；
- 用 200 包裹业务错误（`{success:false}`）；
- 前端根据 `permissions` 决定是否调用敏感接口；
- 用 `DELETE` 物理删除审批/审计；
- 对写操作自动重试（除幂等键）；
- 直接暴露 LMDB 错误/数据目录路径/堆栈；
- 未鉴权的静态文件下载链接。

## 14. 端点与权限追踪

完整端点清单在实现时由 OpenAPI 输出；本文第 8 节为基线。新增/修改端点必须同步：

1. `app/shared` schema；
2. 权限码与角色 seed；
3. API 文档；
4. 集成测试（允许/拒绝/越权）；
5. 审计事件（写操作）。







