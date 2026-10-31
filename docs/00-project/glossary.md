# 术语表

> 文档状态：Draft for Review  
> 版本：0.1.0  
> 目的：统一产品、业务、数据存储、API 与测试语言。出现冲突时，以本表定义为准，并在 [决策记录](decision-log.md) 登记修订。

## 1. 组织与身份

| 术语 | 英文 / 代码 | 定义 |
|---|---|---|
| 组织 | Organization / `org_profile` | 单组织部署；组织资料为单例文档，不做多租户/组织切换。 |
| 用户 | User / `users` | 可登录系统的自然人账号。用户属于且仅属于一个组织；首版一个用户只属于一个主部门。 |
| 员工 | Employee | 产品语境中的用户，强调组织成员身份；首版不单独建员工实体库。 |
| 部门 | Department / `departments` | 组织树节点，可设负责人。支持父子层级，首版最大深度 10。 |
| 岗位 | Position / `positions` | 职务/岗位目录，与部门、角色相互独立。 |
| 角色 | Role / `roles` | 权限集合与数据范围的载体。分为系统内置角色与自定义角色。 |
| 权限 | Permission / `permissions` | 形如 `project:create` 的原子能力码。全局目录只读，不按组织复制。 |
| 数据范围 | Data Scope | 角色读取业务数据时的行级边界：`self`、`department`、`department_tree`、`organization`。 |
| 项目角色 | Project Role | 项目内的身份：`owner`、`manager`、`member`、`viewer`，与系统角色正交。 |
| 会话 | Session / `user_sessions` | 服务端保存的登录状态。浏览器只持有随机不透明令牌。 |
| 系统管理员 | System Admin | 负责账号、角色、配置、日志；默认不参与业务审批。 |
| 组织管理员 | Org Admin | 负责组织架构、全员数据、角色权限与系统配置。 |
| 部门负责人 | Department Manager | 部门负责人；可查看本部门（含子部门）数据并作为审批人。 |
| 项目负责人 | Project Manager | 项目内最高管理角色，可管理成员、任务与项目状态。 |
| 审计员 | Auditor | 只读查看审计日志、登录记录和报表，不可修改业务数据。 |

## 2. 项目与任务

| 术语 | 英文 / 代码 | 定义 |
|---|---|---|
| 项目 | Project / `projects` | 一组目标、成员、任务和日期的集合。项目有唯一短键（如 `WEB`）。 |
| 项目短键 | Project Key | 2–10 位大写字母/数字，组织内唯一；用于生成任务编号 `WEB-12`。 |
| 项目成员 | Project Member / `project_members` | 用户与项目的关系，携带项目角色与最近访问时间。 |
| 项目可见性 | Visibility | `private`：仅成员可见；`organization`：组织成员可读，但仅成员可写。 |
| 项目归档 | Archive | 项目进入只读终态，保留数据；不是删除。 |
| 任务 | Task / `tasks` | 项目内可分配、可跟踪进度的工作项。 |
| 任务编号 | Task Key | `项目短键-序号`，如 `WEB-12`；序号在项目内递增。 |
| 看板 | Kanban | 按任务状态分列的视图。首版列固定，不支持自定义列。 |
| 待办 | To-do | 分配给当前用户、尚未完成的任务；工作台聚合。 |
| 进度 | Progress | 0–100 的整数百分比。`done` 状态强制为 100。 |
| 逾期 | Overdue | 未完成且 `due_date` 早于组织当前日期。 |
| 项目健康度 | Project Health | 首版用完成率、逾期数、临近截止数三个客观指标表达，不做主观评分。 |

### 项目状态

| 值 | 中文 | 含义 |
|---|---|---|
| `planning` | 规划中 | 已创建，尚未正式启动 |
| `active` | 进行中 | 正常工作状态 |
| `on_hold` | 已暂停 | 暂时停止推进，可恢复 |
| `completed` | 已完成 | 项目目标完成，业务上只读（可归档） |
| `cancelled` | 已取消 | 项目终止，保留记录 |
| `archived` | 已归档 | 终态，只读；不出现在默认列表 |

### 任务状态

| 值 | 中文 | 含义 |
|---|---|---|
| `todo` | 待处理 | 尚未开始 |
| `in_progress` | 进行中 | 正在处理 |
| `in_review` | 待验收 | 等待项目负责人或指定验收人确认 |
| `done` | 已完成 | 已完成，进度 100 |
| `cancelled` | 已取消 | 不再执行，不计入完成率 |

## 3. OA 与审批

| 术语 | 英文 / 代码 | 定义 |
|---|---|---|
| 申请 | Application / `applications` | 员工提交的 OA 事务，含类型、表单数据、状态与审批实例。 |
| 申请类型 | Application Type | `leave` 请假、`travel` 出差、`field` 外勤、`seal` 用印、`general` 通用事务。 |
| 草稿 | Draft | 尚未提交的申请，仅申请人可见、可编辑。 |
| 审批模板 | Workflow Template | 某类申请的可复用审批配置，包含有序步骤。 |
| 模板版本 | Template Version | 发布后的不可变快照。进行中的实例永远引用提交时的版本。 |
| 审批实例 | Workflow Instance | 一次申请对应的审批运行实例。 |
| 审批步骤 | Instance Step | 实例中的一个顺序节点，含审批人与状态。 |
| 审批记录 | Approval Record | 对审批动作的追加式记录，不更新、不删除。 |
| 待我审批 | Pending My Approval | 当前步骤审批人是登录用户、且实例处于运行中的事项。 |
| 或签 | Any-one Approval | 多人中任一人通过即可。**首版不支持。** |
| 会签 | All-must Approval | 多人全部通过才通过。**首版不支持。** |
| 条件分支 | Conditional Branch | 按金额、天数等条件走不同路径。**首版不支持。** |
| 转交 / 委托 | Delegation | 将审批权临时转给他人。**首版不支持。** |
| 加签 | Add Approver | 审批过程中临时增加审批人。**首版不支持。** |
| 撤回 | Withdraw | 申请人在无人审批前主动终止审批。 |
| 驳回 | Reject | 审批人拒绝申请，实例终止。 |
| 审批耗时 | Approval Duration | 从提交到终态的时长；首版以小时计，P1 按工作日/小时段计算。 |

### 申请状态

| 值 | 中文 | 含义 |
|---|---|---|
| `draft` | 草稿 | 仅申请人可见，可编辑/删除 |
| `pending` | 审批中 | 已提交，实例运行中 |
| `approved` | 已通过 | 所有步骤通过 |
| `rejected` | 已驳回 | 任一步骤驳回 |
| `withdrawn` | 已撤回 | 申请人在首个人工审批动作前撤回 |

### 审批实例状态

| 值 | 中文 |
|---|---|
| `running` | 运行中 |
| `approved` | 已通过 |
| `rejected` | 已驳回 |
| `withdrawn` | 已撤回 |

### 审批步骤状态

| 值 | 中文 |
|---|---|
| `waiting` | 等待激活 |
| `active` | 当前待处理 |
| `approved` | 已通过 |
| `rejected` | 已驳回 |
| `cancelled` | 因撤回而关闭 |

### 审批人解析方式

| 值 | 中文 | 规则 |
|---|---|---|
| `user` | 指定用户 | 模板发布时固定用户；用户停用则提交失败 |
| `department_manager` | 部门负责人 | 取申请人提交时所属部门的负责人；为空则失败 |
| `direct_manager` | 直属上级 | 取申请人 `manager_id`；为空或解析为本人则失败 |

## 4. 文档

| 术语 | 英文 / 代码 | 定义 |
|---|---|---|
| 文档 | Document / `documents` | 文件的逻辑对象，含标题、分类、标签、权限和当前版本。 |
| 文档版本 | Document Version | 某次上传形成的不可变文件快照。 |
| 当前版本 | Current Version | 文档对外默认展示/下载的版本。 |
| 分类 | Category | 组织内的树形文件夹，一个文档最多属于一个分类。 |
| 标签 | Tag | 组织内的扁平标签，一个文档可有多个。 |
| 文档权限 | Document Permission | 对用户/角色/部门的 `view`、`edit`、`manage` 授权。 |
| 受限文档 | Restricted Document | 不继承项目/组织可见性，仅所有者与显式授权对象可见。 |
| 版本恢复 | Restore | 把历史版本复制为新版本。**P1，不在 R1。** |

### 文档状态

| 值 | 中文 |
|---|---|
| `active` | 正常 |
| `archived` | 已归档（只读） |

## 5. 通知、审计与系统

| 术语 | 英文 / 代码 | 定义 |
|---|---|---|
| 通知 | Notification / `notifications` | 站内消息，含类型、标题、链接、已读时间。 |
| 操作日志 | Operation Log / `operation_logs` | 对状态变更操作的追加式审计记录。 |
| 登录记录 | Login Record / `login_records` | 登录成功/失败尝试，含 IP 与 User-Agent。 |
| 系统配置 | System Setting / `system_settings` | 组织级、类型受控的配置键值。 |
| 软删除 | Soft Delete | 写 `deleted_at` 而非物理删除；默认查询排除。 |
| 归档 | Archive | 业务只读终态，不是软删除。 |
| 乐观锁 | Optimistic Lock | 通过 `version` 字段检测并发修改，冲突返回 409。 |
| 幂等键 | Idempotency Key | 客户端为提交类请求提供的唯一键，防止重复创建。 |
| 请求 ID | Request ID | 每次请求的唯一标识，贯穿日志、审计与错误响应。 |

## 6. 技术术语

| 术语 | 定义 |
|---|---|
| 模块化单体 | 一个部署单元，内部按业务域分模块，模块间通过明确接口协作。 |
| 领域 | 一组内聚的业务规则与数据，如 Project、Workflow。 |
| 应用服务 | 编排用例、事务、权限与领域规则的服务层。 |
| 仓储 | 封装 LMDB 文档/索引访问的持久化层；不向上暴露 LMDB 类型。 |
| 策略 | 权限/可见性判断的纯函数或小服务，供服务层调用。 |
| DTO | 面向前端/API 的数据传输对象，由 Zod schema 定义并推导类型。 |
| 契约包 | `app/shared`，前后端共享的 Zod schema、枚举、权限码。 |
| 数据边界 | 单组织内的用户/部门/项目/文档 ACL 边界；默认拒绝。 |
| 数据归属 | 每个实体子库只有一个写入领域；其他领域只读或通过接口调用。 |
| 事务边界 | 一次用例内的原子写入范围；由 UnitOfWork 开启一个 LMDB 写事务。 |
| Outbox | 事务内写消息记录、事务后投递的可靠事件模式。**首版不引入。** |
| LMDB | 嵌入式内存映射 KV 存储；ACID 事务、单写多读。 |
| 命名子库 | LMDB 内的一个命名数据库，用于实体或索引。 |
| 键空间 | 命名子库 + 键编码规则。 |
| UnitOfWork | 跨仓储的写事务边界。 |
| schemaVersion | 数据 schema 版本，用于升级迁移。 |
| ADR | Architecture Decision Record，架构决策记录。 |
| RBAC | Role-Based Access Control，基于角色的访问控制。 |
| CSRF | Cross-Site Request Forgery，跨站请求伪造。 |
| IDOR | Insecure Direct Object Reference，越权直接访问对象。 |
| P95 | 95% 请求的响应时间上限。 |

## 7. 优先级与状态

| 标记 | 含义 |
|---|---|
| P0 | R1 必须交付，缺失则不能验收 |
| P1 | 首个正式版本后的扩展 |
| P2 | 远期，不在当前路线图承诺 |
| `Draft for Review` | 文档待人工审查，不能作为编码依据的最终版 |
| `Accepted` | 已确认，可作为实现依据 |
| `Superseded` | 已被新决策替代 |

## 8. 命名约定

- 命名子库：`snake_case` 复数，如 `project_members`。
- 文档字段：`camelCase`，如 `projectId`、`createdAt`。
- TypeScript：类型/组件 `PascalCase`，函数/变量 `camelCase`，常量 `UPPER_SNAKE_CASE`。
- API 路径：`kebab-case` 复数资源，如 `/api/v1/project-members`。
- 权限码：`resource:action` 或 `resource:subresource:action`，全小写。
- 枚举值：存储与 API 均使用 `snake_case` 字符串，如 `in_progress`。
- 日期时间：API 使用 ISO 8601 UTC（`2026-10-31T10:00:00.000Z`）；纯日期使用 `YYYY-MM-DD`。




