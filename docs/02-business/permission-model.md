# 权限模型设计

> 文档状态：Draft for Review  
> 版本：0.1.0  
> 日期：2026-10-31  
> 关联：[用户角色](../01-product/user-roles.md)、[业务架构](business-architecture.md)、[安全设计](../03-technical/security-design.md)

## 1. 目标

1. 用**角色 + 权限码 + 数据范围 + 资源关系**表达“谁能看什么、做什么”。
2. 默认拒绝，允许取并集，首版不引入显式 deny。
3. 权限判断集中在服务端一个 `AuthorizationService`，前端隐藏按钮不作为安全边界。
4. 能解释“为什么能/不能”，便于管理员排查。
5. 防提权、防锁死、防跨用户/部门/项目越权。

## 2. 主体与属性

| 主体 | 属性 | 来源 |
|---|---|---|
| 用户 | id、org_id、status、department_id、manager_id、roles | users / user_roles |
| 角色 | id、code、data_scope、is_system | roles |
| 权限 | code、module | permissions（全局目录） |
| 部门负责人关系 | department_id、manager_id | departments |
| 项目成员关系 | project_id、project_role、visibility | project_members / projects |
| 文档 ACL | subject_type、subject_id、permission | document_permissions |
| 审批关系 | step.approver_id、instance.status | workflow_instance_steps |
| 资源 | org_id、owner_id、status、created_by、assignee_id、applicant_id | 各业务表 |

`Actor` 上下文在请求开始时构建一次，至少包含：

```ts
type Actor = {
  userId: string;

  departmentId: string | null;
  managerId: string | null;
  status: 'active';
  permissions: ReadonlySet<PermissionCode>;
  dataScope: DataScope; // self | department | department_tree | all
  roleCodes: string[];
};
```

不把权限写进 Cookie/JWT；每次请求从 LMDB/角色文档加载，或使用请求级缓存。角色变更下一次请求立即生效。

## 3. 权限码

格式：`resource:action` 或 `resource:subresource:action`，全小写、冒号分隔。权限码是稳定契约，改名视为破坏性变更。

### 3.1 目录

| 模块 | 权限码 | 说明 | 内置角色默认 |
|---|---|---|---|
| 工作台 | `workbench:read` | 查看工作台 | 全部 |
| 项目 | `project:create` | 创建项目 | member/org_admin |
| 项目 | `project:read` | 读取项目（受资源过滤） | 全部 |
| 项目 | `project:read:all` | 读取全部项目（治理） | org_admin |
| 项目 | `project:update` | 编辑项目 | 项目 owner/manager + org_admin |
| 项目 | `project:archive` | 归档/取消项目 | owner + org_admin |
| 项目 | `project:delete` | 软删除项目 | org_admin |
| 项目 | `project:member:manage` | 管理成员 | owner/manager + org_admin |
| 项目 | `project:owner:transfer` | 转让 owner | owner + org_admin |
| 任务 | `task:create` | 创建任务 | 项目成员 |
| 任务 | `task:read` | 读取任务 | 项目成员/组织可见 |
| 任务 | `task:update` | 更新任务（字段受策略） | 创建者/被分配者/PM |
| 任务 | `task:assign` | 分配/改期 | owner/manager |
| 任务 | `task:delete` | 删除任务 | owner/manager |
| 任务 | `task:comment` | 评论 | 项目成员（非 viewer） |
| 任务 | `task:comment:moderate` | 删除他人评论 | owner/manager/org_admin |
| 审批 | `application:create` | 发起申请 | 全部 |
| 审批 | `application:read:self` | 查看自己的申请 | 全部 |
| 审批 | `application:read:all` | 查看全部申请（受范围） | org_admin |
| 审批 | `application:submit` | 提交申请 | 全部 |
| 审批 | `application:withdraw` | 撤回自己的申请 | 全部 |
| 审批 | `application:approve` | 审批（仅当前步骤） | 全部（资源守卫） |
| 审批 | `workflow:template:manage` | 模板/版本管理 | org_admin |
| 审批 | `workflow:reassign` | 转交当前审批 | org_admin |
| 组织 | `organization:directory:read` | 通讯录/组织树 | 全部 |
| 组织 | `department:read` | 查看部门 | 全部 |
| 组织 | `department:manage` | 管理部门 | org_admin |
| 组织 | `position:read` | 查看岗位 | 全部 |
| 组织 | `position:manage` | 管理岗位 | org_admin |
| 组织 | `employee:read` | 查看员工档案（受范围） | org_admin；本人 |
| 组织 | `employee:manage` | 维护员工雇佣信息 | org_admin |
| 系统 | `user:manage` | 创建/停用/重置密码 | org_admin/system_admin |
| 系统 | `role:manage` | 角色/权限分配 | org_admin |
| 系统 | `permission:read` | 查看权限目录 | org_admin/system_admin/auditor |
| 系统 | `session:manage` | 强制下线/会话管理 | org_admin/system_admin |
| 系统 | `login:read` | 登录记录 | org_admin/system_admin/auditor |
| 系统 | `audit:read` | 操作日志 | org_admin/system_admin/auditor |
| 系统 | `setting:manage` | 系统配置 | org_admin/system_admin |
| 文档 | `document:read` | 读取文档（ACL） | 全部（受 ACL） |
| 文档 | `document:read:all` | 读取全部文档 | org_admin |
| 文档 | `document:create` | 上传文档 | 全部 |
| 文档 | `document:update` | 编辑元数据 | ACL edit/manage |
| 文档 | `document:delete` | 软删除 | ACL manage/org_admin |
| 文档 | `document:version:create` | 上传新版本 | ACL edit/manage |
| 文档 | `document:acl:manage` | 管理 ACL | ACL manage/org_admin |
| 文档 | `document:category:manage` | 分类管理 | org_admin |
| 文档 | `document:tag:manage` | 标签管理 | org_admin |
| 文档 | `document:manage:all` | 管理全部文档 | org_admin |
| 日程 P1 | `calendar:read` / `calendar:manage` | 日历 | P1 |
| 分析 P1 | `analytics:read:project` / `:department` / `:all` | 报表 | P1 |

> “内置角色默认”只是种子权限；自定义角色可组合权限码，但受第 9 节提权限制。  
> 项目角色（owner/manager/member/viewer）不是权限码，而是在 `project:update` 等检查后的资源守卫。

### 3.2 权限码来源

- 权限目录由 `app/shared` 的常量定义，迁移时 seed 到 `permissions`。
- 不允许管理员在 UI 创建新权限码。
- 测试必须校验：代码常量集合 = 权限 seed 集合，避免“代码有、存储没有”导致 403。

## 4. 系统角色

| code | 名称 | 关键权限 | data_scope |
|---|---|---|---|
| `member` | 普通成员 | workbench、project create/read、task create/read/update/comment、application create/read self/submit/withdraw/approve、directory、document read/create | `self` |
| `org_admin` | 组织管理员 | 全部业务与管理权限 | `all` |
| `system_admin` | 系统管理员 | user/session/login/audit/setting、permission read | `all`（仅管理数据） |
| `auditor` | 审计员 | login/audit/analytics read、permission read | `all`（只读） |

规则：

- 内置角色不可删除、改名、改权限；只能分配。
- 自定义角色从 `member` 复制或空白创建；名称 2–30 字；data_scope 四选一。
- 一个用户至少一个角色；默认 `member`。
- 只有 org_admin 能授予/撤销 `org_admin`、`system_admin`、`auditor`。
- `system_admin` 不能授予 `org_admin`，避免 IT 提权。
- 不能撤销自己最后一个管理员角色。

## 5. 数据范围

```text
self              → 仅本人创建/被分配/申请的资源
department        → 本人主部门
department_tree   → 本人主部门 + 所有子部门
all               → 全部署
```

应用范围：

| 资源 | 是否用 data_scope | 额外资源守卫 |
|---|---|---|
| 项目/任务 | **否**（除 `project:read:all`） | 项目成员、项目可见性、项目角色 |
| 申请 | 是（仅 `application:read:all`） | 本人、审批人、org_admin |
| 员工档案 | 是（`employee:read`） | 本人、部门范围 |
| 文档 | **否** | ACL、项目继承、org_admin |
| 工作台 | 是（仅聚合查询） | 当前用户 |
| 报表（P1） | 是 | 报表权限 |
| 审计/登录 | 是（org_admin/auditor 默认全组织） | 只读 |

关键取舍：

- **部门范围不能绕过项目隐私**。一个部门负责人不会因为“部门范围”看到部门内私有项目；项目访问仍看成员关系/可见性。
- **文档访问看 ACL**，不看部门范围；部门授权是显式 ACL 的一种。
- 部门负责人若负责多个部门，首版 data_scope 仍按主部门计算；跨部门聚合 P1。审批人解析则按 `departments.manager_id`，不受此限制。

## 6. 判定算法

```text
can(actor, permission, resource?, context?):
  1. actor.status == active，否则 false/404
  2. actor.permissions.has(permission)，否则 false（403）
  3. 若 permission 是全局管理类（user:manage 等），返回 true
  4. 按资源类型执行守卫：
     project  → canAccessProject(actor, project, level)
     task     → canAccessProject(project) && task state/field policy
     application → applicant/approver/read:all+scope
     document → ACL/project inheritance/org admin
  5. 业务状态守卫（如仅 active 步骤可审批）
  6. 返回 allow/deny + reason code
```

`AuthorizationService` 返回结构化结果：

```ts
type Decision = {
  allowed: boolean;
  reason:
    | 'OK'
    | 'NO_PERMISSION'
    | 'OUT_OF_SCOPE'
    | 'NOT_MEMBER'
    | 'NOT_OWNER'
    | 'INVALID_STATE'
    | 'CROSS_ORG';
};
```

路由层只根据 `allowed` 返回 403/404/409；日志记录 reason（不把内部原因泄露给用户，除非是页面级说明）。

## 7. 项目与任务策略

### 7.1 项目访问

```text
canReadProject(actor, project):
  // 单组织，无 org 校验
  && (
       project.visibility == 'all'
       || isMember(actor, project)
       || actor.permissions.has('project:read:all')
     )
```

- `project:read:all` 只给 org_admin；自定义角色如获得该权限，等同全组织项目可见，需高风险确认。
- 归档项目仍可读（有权限），但默认列表过滤。
- 软删除项目仅审计/管理员可见。

### 7.2 项目写

| 动作 | 权限码 | 资源守卫 |
|---|---|---|
| 编辑基本信息 | `project:update` | member role owner/manager 或 `project:read:all` + org_admin |
| 管理成员 | `project:member:manage` | owner/manager；manager 不能动 owner/其他 manager |
| 转让 owner | `project:owner:transfer` | 当前 owner 或 org_admin |
| 归档/取消 | `project:archive` | owner 或 org_admin |
| 删除 | `project:delete` | org_admin；且无未完成任务 |

### 7.3 任务

| 动作 | 权限码 | 资源守卫 |
|---|---|---|
| 读取 | `task:read` | 项目可读 |
| 创建 | `task:create` | 项目成员且项目 active；非 viewer |
| 更新字段 | `task:update` | 创建者/被分配者仅限状态/进度；owner/manager 全部 |
| 分配/改期 | `task:assign` | owner/manager |
| 删除 | `task:delete` | owner/manager |
| 评论 | `task:comment` | 项目成员非 viewer |
| 删除他人评论 | `task:comment:moderate` | owner/manager/org_admin |

组织可见项目的非成员：只有 `task:read`，没有 `task:create/update/comment`。

## 8. 审批、文档、通讯录策略

### 8.1 审批

| 动作 | 规则 |
|---|---|
| 发起 | `application:create` + active 用户 |
| 查看自己的 | `application:read:self` + applicant_id=actor |
| 查看全部 | `application:read:all` + data_scope |
| 审批 | `application:approve` + instance running + step active + approver=actor |
| 撤回 | `application:withdraw` + applicant=actor + 无 approve/reject |
| 转交 | `workflow:reassign` + org_admin + current step |
| 模板 | `workflow:template:manage` + org_admin |

- 部门负责人没有“查看本部门全部申请”的默认权限；只有作为审批人时可见。
- 管理员查看全部申请用于治理，必须审计；不能修改表单/历史。
- 审计员仅摘要。

### 8.2 文档

访问级别：`view < edit < manage`。

```text
effectiveDocumentLevel(actor, doc):
  if actor has document:manage:all → manage
  if doc.owner == actor → manage
  level = NONE
  if doc.visibility == 'all' → view
  if doc.project_id && isProjectMember(actor, doc.project_id) → view
  for acl in doc.acls:
    if acl matches actor (user / role / department incl. children) → max(level, acl.permission)
  return level
```

- `restricted` 不继承组织/项目，仅 owner + ACL。
- 组织管理员绕过 ACL；其他角色即使有 `document:read` 也必须通过资源守卫。
- `edit` 可改元数据/上传版本；`manage` 可改 ACL/删除。
- 首版无 deny、无公开链接、无到期授权。

### 8.3 通讯录

- 全员可读：姓名、部门、岗位、工作邮箱。
- 手机号：本人、org_admin、system_admin（账号用途）可见；其他人不可见。
- 员工列表（含筛选/导出）需要 `employee:read` + data_scope；普通成员只能看通讯录字段，不能看完整档案。

## 9. 防提权与防锁死

| 规则 | 实现 |
|---|---|
| 不能授予自己没有的权限 | 角色编辑/分配时做权限子集校验 |
| 只有 org_admin 能授予管理员角色 | 角色 code 白名单 + actor 角色校验 |
| 不能修改自己的角色 | `user_id != actor.id`，除非是 org_admin 调整他人 |
| 不能撤销最后一个 org_admin | 事务内计数，409 |
| 不能停用自己 | `user_id != actor.id` |
| 系统管理员不能授予 org_admin | 显式拒绝 |
| 自定义角色不能包含 `project:read:all`/`document:manage:all` 除非 actor 拥有 | 子集校验 |
| 角色变更立即失效 | 无长期权限缓存；下一请求重新加载 |
| 审计所有授权变更 | role.assigned/revoked/updated |

## 10. 仓储层数据边界

所有查询必须经过统一 guard：

```ts
// 概念代码，不是最终实现
function visibleTo(actor: Actor, query: Query) {
  return applyDataScope(query, actor); // 不接收客户端传入的“组织/租户”
}
```

规则：

1. 禁止无权限条件的全量 `Repository.list()`；列表必须带 actor 数据范围/资源关系。
2. 按 ID 查询后必须执行资源守卫；不得直接返回文档。
3. 关联写入校验引用存在、active、属于允许范围。
4. 不接受前端传入“用户/部门/项目可见性”作为授权依据。
5. 跨用户/部门/项目/文档越权返回 404。
6. 代码审查 + 集成测试（多用户/多部门/私有项目 fixture）兜底。
7. 无 SQL，因此无 RLS；数据边界由 Repository/AuthorizationService 保证。

## 11. 403 与 404

| 场景 | 响应 | 理由 |
|---|---|---|
| 未登录/会话过期 | 401 | 需要认证 |
| 页面/功能无权限码 | 403 | 用户知道功能存在 |
| 具体资源不在数据范围/非成员 | 404 | 防止枚举资源 |
| 跨用户/部门/项目资源 | 404 | 不泄露存在性 |
| 业务状态不允许 | 409 | 资源可见，但当前不可操作 |
| 参数非法 | 422 | 输入问题 |

前端：403 页面说明所需权限/联系管理员；404 页面不提示“存在但无权”。

## 12. 审计事件

| 事件 | 内容 |
|---|---|
| `role.created/updated/deleted` | 角色、权限差异、data_scope |
| `role.assigned/revoked` | 目标用户、角色、操作者 |
| `permission.denied` | 可选：高风险接口的拒绝（避免日志洪水） |
| `user.disabled/enabled` | 目标用户、原因 |
| `session.revoked` | 目标用户、原因 |
| `project.member_added/removed` | 项目、用户、角色 |
| `document.acl.changed` | 文档、主体、级别 |
| `workflow.reassigned` | 申请、原/新审批人、原因 |

不记录密码、令牌、完整申请正文。

## 13. 测试矩阵

至少覆盖：

1. 4 个内置角色 × 主要资源/动作的允许/拒绝。
2. 项目 4 个项目角色 × 项目/任务动作。
3. 项目可见性 `private/all` × 成员/非成员。
4. 文档 `all/project/restricted` × owner/ACL 用户/角色/部门/无关用户。
5. 申请 申请人/当前审批人/历史审批人/部门负责人/org_admin/auditor。
6. 数据范围 self/department/department_tree/all。
7. 提权路径：自定义角色、角色分配、最后管理员、system_admin→org_admin。
8. IDOR：所有 `/:id` 端点跨用户/部门/项目/文档。
9. 权限码一致性：代码常量 vs 权限 seed。
10. 审批状态守卫：非当前步骤、重复审批、已结束实例。

## 14. 已知限制

- 无字段级权限（如隐藏薪资字段）；首版员工档案字段少，敏感字段通过接口裁剪。
- 无临时授权/到期回收；P1。
- 无 deny 规则；复杂“例外拒绝”场景不支持。
- 部门负责人多部门的数据范围按主部门；P1 支持多部门 scope。
- 系统管理员与组织管理员可由同一人持有；建议分离但不强制。
- 权限每次请求加载，未做缓存；在 500 用户规模可接受，若成为瓶颈再加请求级/短 TTL 缓存并处理失效。








