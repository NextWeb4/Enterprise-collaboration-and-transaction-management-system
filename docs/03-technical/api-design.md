# API 设计规范

> 文档状态：Draft for Review  
> 版本：0.1.0  
> 日期：2026-10-31  
> 风格：REST / JSON / OpenAPI 3.1  
> Base URL：`/api/v1`（健康检查例外：`/health/live`、`/health/ready` 不在 `/api/v1` 下）  
> 关联：[系统架构](system-architecture.md)、[数据存储设计](data-storage-design.md)、[安全设计](security-design.md)

> Bootstrap 开发检查例外：`GET /api/health` 返回存储健康状态；`GET /api/bootstrap/storage` 读取最近一条测试记录，`POST /api/bootstrap/storage` 写入并读回测试记录。后两者仅在 development 且监听 `127.0.0.1` 时可用，POST 校验配置的 Web Origin；这些测试接口不属于业务 API。`pnpm dev` 时 Vite 与 API 分别监听 5173 和配置的后端端口，浏览器通过 CORS 直接访问后端；正式同源部署原则不变。

> 2026-11-02：登录标识改为内部账号。为兼容已有客户端和数据，本版请求和响应仍使用字段名 `email`；新建账号接受 3–64 位字母、数字、点、下划线、连字符，首位为字母或数字，统一转小写。登录额外兼容已有邮箱格式标识；这不要求使用或收取工作邮箱。

> 首次部署可用 `GET /api/v1/setup/status` 检查状态，`POST /api/v1/setup/admin` 设置首个管理员。仅本机可初始化，需校验 Host 和 Origin；无用户及审计历史的判断、创建与审计在单事务完成。`POST /users` 可传初始 `password`，仍需认证、CSRF 和 `user:manage`；用户首次登录必须改密。未传密码时保留原随机临时密码行为。

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
- 401 统一“账号或密码错误”或“会话已失效”，不泄露账号存在性。
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

### 7.3 在线预览

`GET /api/v1/documents/{id}/preview` 与 `GET /api/v1/documents/{id}/versions/{versionId}/preview` 复用下载的会话、文档 ACL、版本归属、文件路径和哈希校验，且在打开文件前后再次校验当前会话与 ACL。仅允许 `application/pdf`、`image/png`、`image/jpeg`；其他已授权文件返回 `415 FILE_TYPE_UNSUPPORTED`，无权或版本不属于文档仍返回 404。响应使用 `Content-Disposition: inline`、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff` 与受限 CSP，并追加 `document.previewed` 审计。首版不提供 Office、Markdown、CSV 或 TXT 的在线渲染。文档列表的 `q` 同时匹配标题、说明、标签，以及当前版本的 UTF-8 TXT/MD/CSV 正文索引（每个文件最多 1MiB）；授权在匹配正文前执行，响应不含正文或命中片段。

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
    "user": { "id": "...", "name": "李四", "email": "lisi" },
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

2026-11-02：以下路径已接入；机器契约见 [OA OpenAPI](oa-approval.openapi.json)，验证证据与限制见 [OA 实现记录](../04-development/oa-approval-implementation.md)。所有变更均需会话、Origin 与 CSRF；资源越权统一 404。草稿仅本人可见；审计角色只获得正文、附件、意见、项目和时间范围均脱敏的摘要。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/applications` | `application:read:self` / `:all` / `:approve` / 审计摘要 | `view=mine/pending/involved/all`；先过滤权限再分页 |
| POST | `/applications` | `application:create` | 创建草稿 |
| GET | `/applications/{id}` | 申请人/审批人/`:all` | 详情 |
| PATCH | `/applications/{id}` | 申请人 + draft | 编辑草稿；带 version |
| DELETE | `/applications/{id}` | 申请人 + draft | 软删除草稿；带 version；保留附件引用 |
| POST | `/applications/{id}/submit` | `application:submit` | 提交；Idempotency-Key |
| POST | `/applications/{id}/withdraw` | `application:withdraw` | 撤回；带 version/reason |
| POST | `/applications/{id}/copy` | `application:create` + 本人 | 将驳回或撤回申请复制为新草稿 |
| GET | `/applications/{id}/history` | 有权查看 | 审批时间线 |
| POST | `/applications/{id}/attachments?version=N` | 申请人 + draft | 单文件 multipart；PDF/JPG/PNG ≤10MB |
| DELETE | `/applications/{id}/attachments/{attachmentId}` | 申请人 + draft | 删除附件；带 version；事务维护 refCount |
| GET | `/applications/{id}/attachments/{attachmentId}/download` | 完整正文访问权 | 鉴权下载；审计摘要不可下载 |
| POST | `/applications/{id}/approve` | `application:approve` + 当前步骤 | 通过；带 version/comment |
| POST | `/applications/{id}/reject` | `application:approve` + 当前步骤 | 驳回；带 version；意见 10–500 字 |
| POST | `/applications/{id}/reassign` | 系统 org_admin + `workflow:reassign` | 管理员转交；带 version；原因 5–500 字 |
| GET | `/workflow/templates` | 系统 org_admin + `workflow:template:manage` | 模板列表 |
| POST | `/workflow/templates` | 同上 | 创建草稿 |
| PATCH | `/workflow/templates/{id}` | 同上 | 编辑草稿步骤；带 version |
| POST | `/workflow/templates/{id}/publish` | 同上 | 发布不可变新版本；带 version |
| POST | `/workflow/templates/{id}/deactivate` | 同上 | 停用；带 version |
| GET | `/workflow/templates/{id}/versions` | 同上 | 只读已发布版本 |
| POST | `/workflow/templates/defaults` | 同上 | 显式创建五类缺失模板；不覆盖已配置类型 |

创建草稿示例：

```json
POST /api/v1/applications
{
  "applicationType": "leave",
  "title": "11 月 3-4 日年假",
  "formData": {
    "leaveType": "annual",
    "durationDays": 2,
    "reason": "家中有重要事务需要请假处理",
    "handoverUserId": "0192..."
  },
  "startAt": "2026-11-03T01:00:00.000Z",
  "endAt": "2026-11-04T10:00:00.000Z",
  "projectId": null
}
```

提交：

```http
POST /api/v1/applications/{id}/submit
Idempotency-Key: 7b1e672c-ae20-4de7-a7f8-42a8a88c65cc
```

审批：

```json
POST /api/v1/applications/{id}/approve
{ "version": 2, "comment": "同意" }
```

转交：

```json
POST /api/v1/applications/{id}/reassign
{
  "newApproverId": "0192...",
  "version": 2,
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
| GET | `/organization/directory` | `organization:directory:read` + scope | 已实现：脱敏通讯录 |
| GET | `/organization/active-users` | `organization:directory:read` 或 `employee:read` | 已实现：全部在职账号最小选择器；不要求已有员工档案 |
| GET | `/organization/departments` | `department:read` | 当前切片：扁平部门列表，含 parentId |
| GET | `/organization/departments/tree` | `organization:directory:read` + scope | 已实现：当前数据范围的部门树 + 人数 |
| POST | `/organization/departments` | `department:manage` | 创建 |
| PATCH | `/organization/departments/{id}` | `department:manage` | 编辑 |
| DELETE | `/organization/departments/{id}` | `department:manage` | 规划：软删除，跨模块引用检查完成前不可用 |
| GET | `/organization/positions` | `position:read` | 岗位列表 |
| POST | `/organization/positions` | `position:manage` | 创建 |
| PATCH | `/organization/positions/{id}` | `position:manage` | 编辑 |
| DELETE | `/organization/positions/{id}` | `position:manage` | 软删除 |
| GET | `/organization/employees` | `employee:read` + scope | 员工档案列表 |
| GET | `/organization/employees/{id}` | `employee:read` + scope | 已实现：按员工档案 ID 读取详情 |
| POST | `/organization/employees` | `employee:manage` + `all` | 已实现：创建档案并同步直属上级到 UserDocument |
| PATCH | `/organization/employees/{id}` | `employee:manage` + `all` | 已实现：完整更新档案；版本校验 |
| GET | `/roles` | `role:manage` | M0 兼容别名；与 `/organization/roles` 相同 |
| GET | `/organization/roles` | `role:manage` | 角色列表 |
| POST | `/organization/roles` | `role:manage` | 创建自定义角色 |
| PATCH | `/organization/roles/{id}` | `role:manage` | 更新权限/范围 |
| DELETE | `/organization/roles/{id}` | `role:manage` | 未被引用才可删 |
| GET | `/organization/permissions` | `permission:read` | 权限目录 |
| GET | `/organization/users/{id}/effective-permissions` | `role:manage` | 已实现：角色、权限并集和用户版本预览 |

M0 已实现上述角色 CRUD、权限目录、有效权限预览与用户角色全量替换。准确的已实现子集、请求体和响应字段见 [m0-rbac.openapi.json](m0-rbac.openapi.json)；组织目录、员工和岗位的请求体及响应字段见 [organization-directory.openapi.json](organization-directory.openapi.json)。服务端在同一 LMDB 事务内重新读取 actor、会话、角色和权限，不能以请求开始时或前端缓存的权限结果完成写入。

- `POST/PATCH/DELETE /organization/roles` 仅操作自定义角色；系统角色不可改名、改权限或删除。
- 角色创建/更新的 `permissionCodes` 必须来自共享权限目录，且必须是操作者当前有效权限的子集；`dataScope` 只能取 `self`、`department`、`department_tree`、`all`。
- `GET /organization/users/{id}/effective-permissions` 返回用户安全视图、`version`、`roleIds`、角色 code 与权限并集；调用方用该 `version` 进行后续替换，但该接口不计算多角色 `dataScope`。
- `PUT /users/{id}/roles` 是全量替换，不接受空数组或重复 roleId；事务内校验角色存在、禁止自改、限制管理员角色授予/撤销并防止 `system_admin` 授予 `org_admin`，追加 `user.roles.updated`、`role.assigned`、`role.revoked` 审计。自改角色一律以 403 拒绝。账号停用接口在独立事务内重新校验操作者、保护最后一个活跃 `org_admin`，并撤销目标会话；角色替换路径仍依赖禁止自改与管理员角色授予/撤销约束，未另行实现组织管理员计数器。
- 角色权限变更在下一次请求重新加载后生效；不得把前端权限列表当作安全边界。

部门 API 的 POST/PATCH 接受完整字段 `{parentId,name,code,managerId,description,sortOrder}`，PATCH 另带正整数 `version`；可空字段必须显式传 `null`。返回 `{data}`，GET 返回扁平数组，POST 成功 201、PATCH 成功 200。部门名称同父级唯一、非空编码全局唯一；循环、超过 10 层、无效字段返回 422，重复或版本冲突返回 409，不存在的上级/负责人返回 404。变更请求需要登录、CSRF 和 Origin 校验，所有操作在事务内重新校验会话、活跃角色及权限，并仅允许授予对应权限的角色具有 `all` 范围；较窄范围暂不支持并返回 403。写入与审计同事务。具体契约见 [部门 OpenAPI](organization-department.openapi.json)。

`dataScope` 已有按权限合并的范围集合计算；部门服务当前仅支持授予相应权限的 `all` 范围，未实现部门树过滤。其他业务资源查询不能据此视为已执行范围授权。

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

上表是 R1 用户管理目标。M0 当前实现 `GET /users`、`POST /users`、上节的有效权限预览、`PUT /users/{id}/roles`，以及 `POST /users/{id}/disable` 的基础停用闭环。停用要求版本号，执行认证/CSRF/`user:manage` 校验，在单个写事务内更新状态、撤销目标全部活跃会话并追加审计，同时保护最后一个活跃 `org_admin`。`GET/PATCH /users/{id}`、启用、重置密码和强制下线仍无路由或服务闭环；当前审批人转交、项目 owner/未完成任务等离职依赖校验需待对应业务模块实现。因此用户生命周期仍未完整交付。

M0 创建用户仅接受初始单角色：

```json
POST /api/v1/users
{
  "name": "王五",
  "email": "wangwu",
  "roleCode": "member"
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
| GET | `/documents/{id}/preview` | ACL view | 仅 PDF/PNG/JPEG 的受鉴权新标签页预览 |
| GET | `/documents/{id}/versions/{versionId}/preview` | ACL view | 指定 PDF/PNG/JPEG 版本预览 |
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

### 8.10 经营分析

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/analytics/project-completion` | `analytics:read:project` 或 `analytics:read:all`，并需项目/任务读取权限 | 当前快照；支持项目创建时间筛选、逾期率和分页逾期清单 |
| GET | `/analytics/project-completion/export` | 同项目完成分析 | 以 CSV 导出当前已授权项目汇总；最多 10,000 行；成功写审计 |
| GET | `/analytics/department-workload` | 对应分析权限 + `project:read` + `task:read` | 按允许部门聚合组织可见项目任务，不输出任务/项目明细 |

项目完成响应包括按项目明细、按有效任务总数加权的汇总完成率，以及按组织时区计算的逾期率和分页逾期任务清单。逾期定义为截止日期早于组织本地当前日期的未完成任务；当天截止不算逾期。取消任务从有效任务分母排除；软删除任务不计入。私有项目仍执行项目成员守卫。该项目完成报表对部门范围返回 403；部门工作量应改用下述独立聚合端点。CSV 导出字段仅包含项目状态和聚合任务指标，采用 UTF-8 BOM、CRLF、公式前缀防护、`Cache-Control: no-store`；未实现 XLSX、异步生成或短时下载链接。部门工作量只统计组织可见项目中分配给 active 内部账号的任务，并依分析权限的角色范围并集执行 `department`、`department_tree`、`all`；仅 `self` 返回 403，越权 `departmentId` 返回 404。它不会返回私有项目、任务或负责人明细。历史趋势、合同/财务分析仍未实现。机器契约见 [项目 OpenAPI](analytics-project.openapi.json)、[导出 OpenAPI](analytics-export.openapi.json) 和 [部门工作量 OpenAPI](analytics-department-workload.openapi.json)；实现证据见 [项目分析](../04-development/project-analytics-service.md)、[CSV 导出](../04-development/analytics-export-implementation.md) 和 [部门工作量](../04-development/department-workload-analytics.md)。

### 8.11 日历与会议

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/calendar/participants` | `organization:directory:read` | 在职内部账号候选，最多 50 人 |
| GET | `/calendar/events` | `calendar:read` + 事件/项目守卫 | 在明确 `from`/`to` 区间内查询日程 |
| POST | `/calendar/events` | `calendar:create` | 创建个人日程、里程碑或会议；返回隐私保护的冲突提示 |
| GET | `/calendar/events/{id}` | `calendar:read` + 事件/项目守卫 | 日程详情 |
| PATCH | `/calendar/events/{id}` | `calendar:update` + 所有者守卫 | 带 version 更新日程 |
| DELETE | `/calendar/events/{id}` | `calendar:delete` + 所有者守卫 | 软删除；带 version |
| POST | `/calendar/events/{id}/response` | `calendar:respond` + 受邀人守卫 | 接受、拒绝或暂定参加；带 version |

会议最多邀请 50 名 active 内部账号；关联项目时，组织者和参与人必须是有效项目成员，私有项目 ACL 不可由管理员角色绕过。冲突仅返回参与人和时间区间，不泄露冲突日程的 ID、标题、描述或地点。提醒仅支持提前 5/15/30/60 分钟：服务启动立即扫描，此后每分钟扫描一次，并在每次投递前重新验证账号、日历权限和项目关系。唯一投递标记、站内通知与系统审计在同一事务写入；停机期间错过且事件已开始的提醒不补发。详见 [日历 OpenAPI](calendar.openapi.json) 与 [日历模块说明](calendar-module.md)。

## 9. 权限与数据过滤

- 每个端点声明权限码；服务层执行资源守卫。
- R1 列表查询先按权限码判断，再按资源关系/数据范围过滤；禁止先查全量再前端过滤。该原则不能被当前 M0 的基础角色管理端点视为已完成的业务范围过滤。
- `dataScope` 的有效值固定为 `self`、`department`、`department_tree`、`all`；当前部门服务仅支持对应权限的 `all` 范围，较窄范围过滤尚未实现。
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
| `USER_EMAIL_TAKEN` | 409 | 账号重复 |
| `LAST_ADMIN_PROTECTED` | 409 | 最后一个管理员 |
| `CURRENT_APPROVER_ACTIVE` | 409 | 停用当前审批人前需转交 |
| `RATE_LIMITED` | 429 | 限流 |
| `STORAGE_UNAVAILABLE` | 503 | LMDB/数据目录不可用/维护中 |
| `STORAGE_CORRUPTED` | 503 | 存储校验失败；需恢复 |
| `FILE_MISSING` | 410 | 元数据存在但文件缺失 |
| `FILE_CHECKSUM_MISMATCH` | 409 | 文件校验失败 |

## 11. OpenAPI 与契约

- 已实现 M0 RBAC 子集的可审查工件为 [m0-rbac.openapi.json](m0-rbac.openapi.json)，包含角色 CRUD、权限目录、有效权限预览、用户角色替换和创建用户的精确契约；它明确 `dataScope` 未执行，且不覆盖完整 R1 API。
- R1 后续计划使用 `fastify-type-provider-zod` 从 Zod schema 生成完整 OpenAPI 3.1；M0 尚未引入该依赖或自动生成流水线，当前 RBAC 工件应与 `app/shared/src/schemas.ts` 和服务端路由同步审查。
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








### 当前项目与任务 API 的已实现子集（2026-11-02）

上文第 8.3–8.4 节是目标端点表，并非全部已交付。当前实际实现 `GET/POST /projects`、`GET/PATCH/DELETE /projects/{id}`、`POST /projects/{id}/transition`、`GET/POST /projects/{id}/members`、`PATCH/DELETE /projects/{id}/members/{userId}`、`POST /projects/{id}/transfer-owner`、`GET/POST /projects/{id}/tasks` 和 `GET/PATCH/DELETE /tasks/{id}`，详见 [project-task.openapi.json](project-task.openapi.json) 和共享 Zod schema。项目和任务列表支持 `page`、`pageSize`（默认 1、20；最大 100），项目列表默认不显示归档。项目/任务详细筛选、评论与看板已提供基础端点，通知和筛选视图拖拽语义尚未实现。

创建项目自动建立唯一 owner；项目仅在 `active` 状态允许新建任务。短键唯一、任务编号在事务内递增，任务写入、项目计数与审计同事务；状态流转记录版本，暂停和取消需原因。权限码、有效会话和项目成员关系在写事务内重验；私有项目非成员返回 404，组织可见项目非成员只读。移除成员要求成员 `version`、不能移除 owner、且不能存在分配给该成员的未完成任务；转让请求为 `{ "userId": "新负责人ID", "version": 项目版本 }`，新负责人必须为活跃项目成员。账号停用前在同一事务检查目标用户是否仍为项目 owner。

本子集尚未实现文档所述全部业务规则或功能，不能据此认定 M1 已完成或 M0 已验收通过。该 OpenAPI 使用默认会话 Cookie 名称，部署可配置其他名称。

项目短键在所有历史项目（含软删除项目）中永久唯一；创建事务检查主库历史文档，避免删除后重新使用短键造成历史任务编号冲突。项目删除仅限项目成员中的组织管理员，且无未完成任务；角色修改不能直接变更 owner。

当前看板移动通过 `PATCH /tasks/{id}/board` 接收 `{version,targetStatus,targetIndex,progress?}`；目标索引按完整列计算，返回移动任务及受影响完整列。同一事务校验状态/进度并将源列及目标列重排为 1024 的倍数。任务评论通过 `/tasks/{id}/comments` 和 `/comments/{id}` 读写；评论不接受原始 HTML，作者可在 15 分钟内编辑，删除返回 `removedAt` 和空 `content`，界面显示“评论已删除”。对他人评论删除必须具有审核权限并提供理由。评论通知及按筛选结果相邻位置拖拽尚未实现，禁止描述为完整看板交付。
