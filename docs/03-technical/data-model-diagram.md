# 数据模型与引用关系图

> 文档状态：Draft for Review  
> 版本：0.2.0  
> 日期：2026-10-31  
> 说明：本文替代 SQL ER 图；不是数据库表结构，而是**业务实体、JSON 文档、引用关系、KV 键空间**。  
> 配套：[数据存储设计](data-storage-design.md)

## 1. 总览

```mermaid
flowchart TB
  subgraph ID[Identity]
    USER[users]
    SESS[sessions]
    ROLE[roles]
    PERM[permissions]
    LOGIN[login_records]
  end
  subgraph ORG[Organization]
    PROFILE[org_profile]
    DEPT[departments]
    POS[positions]
    SET[settings]
  end
  subgraph PRJ[Project / Task]
    PROJ[projects]
    MEMBER[project_members]
    TASK[tasks]
    CMT[task_comments]
  end
  subgraph WF[Workflow]
    APP[applications]
    ATT[application_attachments]
    TPL[workflow_templates]
    VER[workflow_versions]
    INST[workflow_instances]
    STEP[workflow_steps]
    REC[approval_records]
  end
  subgraph DOC[Document]
    DOCS[documents]
    DV[document_versions]
    CAT[document_categories]
    TAG[tags]
    DT[document_tags]
    ACL[document_acl]
    FILE[files]
  end
  subgraph CAL[Calendar P1]
    EVENT[events]
    REM[event_reminders]
  end
  subgraph SYS[Notification / Audit / Helper]
    NOTI[notifications]
    AUD[audit_logs]
    CNT[counters]
    IDEM[idempotency]
  end
  USER --> ROLE
  USER --> DEPT
  USER --> POS
  USER --> PROJ
  MEMBER --> PROJ
  PROJ --> TASK
  TASK --> CMT
  APP --> INST
  TPL --> VER
  VER --> INST
  INST --> STEP
  STEP --> REC
  APP --> ATT
  DOCS --> DV
  DOCS --> ACL
  DOCS --> DT
  TAG --> DT
  DV --> FILE
  ATT --> FILE
  USER --> NOTI
  USER --> AUD
```

> 箭头表示“引用/归属”，不是 SQL 外键；引用完整性由服务层 + 索引校验保证。

## 2. Identity 与 Organization

```mermaid
erDiagram
  USERS ||--o{ SESSIONS : "owns"
  USERS }o--o{ ROLES : "roleIds"
  ROLES }o--o{ PERMISSIONS : "permissionCodes"
  USERS ||--o{ LOGIN_RECORDS : "attempts"
  DEPARTMENTS ||--o{ DEPARTMENTS : "parent"
  DEPARTMENTS ||--o{ USERS : "members"
  POSITIONS ||--o{ USERS : "assigned"
  USERS ||--o{ USERS : "manager"

  USERS {
    string id
    string email
    string passwordHash
    string name
    string departmentId
    string positionId
    string managerId
    string status
    string[] roleIds
  }
  SESSIONS {
    string id
    string userId
    string tokenHash
    string idleExpiresAt
    string absoluteExpiresAt
    string revokedAt
  }
  ROLES {
    string id
    string code
    string dataScope
    string[] permissionCodes
    boolean isSystem
  }
  PERMISSIONS {
    string code
    string module
    string name
  }
  LOGIN_RECORDS {
    string id
    string userId
    string emailAttempted
    boolean success
    string failureReason
  }
  ORG_PROFILE {
    string key
    string name
    string timezone
    string initializedAt
  }
  DEPARTMENTS {
    string id
    string parentId
    string name
    string code
    string managerId
  }
  POSITIONS {
    string id
    string name
    string code
    string status
  }
  SETTINGS {
    string key
    number sessionIdleMinutes
    number maxUploadMb
    boolean allowMemberCreateProject
  }
```

关系规则：

- 单组织；不存在 `organizationId`/组织切换。
- 一个用户一个主部门、一个岗位、一个直属上级。
- 用户 `roleIds` 直接内嵌；角色 `permissionCodes` 内嵌；不再单独建 user_roles/role_permissions。
- 部门 parent 不能成环，最大深度 10。
- 用户删除用 `status=disabled`，不物理删除。

## 3. Project / Task

```mermaid
erDiagram
  USERS ||--o{ PROJECTS : "owner"
  PROJECTS ||--o{ PROJECT_MEMBERS : "has"
  USERS ||--o{ PROJECT_MEMBERS : "joins"
  PROJECTS ||--o{ TASKS : "contains"
  USERS ||--o{ TASKS : "assignee/reporter"
  TASKS ||--o{ TASK_COMMENTS : "has"
  USERS ||--o{ TASK_COMMENTS : "writes"

  PROJECTS {
    string id
    string key
    string name
    string status
    string visibility
    string ownerId
    number taskSeq
    number version
  }
  PROJECT_MEMBERS {
    string projectId
    string userId
    string projectRole
    string lastViewedAt
  }
  TASKS {
    string id
    string projectId
    number taskNo
    string title
    string status
    string priority
    string assigneeId
    string reporterId
    number progress
    number boardOrder
    number version
  }
  TASK_COMMENTS {
    string id
    string taskId
    string authorId
    string content
    string editedAt
    string deletedAt
  }
```

关系规则：

- `project_members` 主键为 `projectId\u001FuserId`。
- 每项目仅 1 个 owner；owner 转让需事务更新项目与成员。
- 任务 `projectId + taskNo` 唯一；`taskNo` 来自项目 `taskSeq`。
- 任务负责人必须为项目成员；可为空。
- 任务软删除不回收编号。

## 4. Workflow

```mermaid
erDiagram
  APPLICATIONS ||--o{ APPLICATION_ATTACHMENTS : "has"
  APPLICATIONS ||--o| WORKFLOW_INSTANCES : "one instance"
  WORKFLOW_TEMPLATES ||--o{ WORKFLOW_VERSIONS : "publishes"
  WORKFLOW_TEMPLATES ||--o{ WORKFLOW_INSTANCES : "instantiated"
  WORKFLOW_VERSIONS ||--o{ WORKFLOW_INSTANCES : "snapshot"
  WORKFLOW_INSTANCES ||--o{ WORKFLOW_STEPS : "has"
  WORKFLOW_STEPS ||--o{ APPROVAL_RECORDS : "records"
  USERS ||--o{ WORKFLOW_STEPS : "approver"
  USERS ||--o{ APPROVAL_RECORDS : "operator"

  APPLICATIONS {
    string id
    string applicationNo
    string type
    string title
    object formData
    number formSchemaVersion
    string status
    string applicantId
    string departmentId
  }
  APPLICATION_ATTACHMENTS {
    string id
    string applicationId
    string fileId
    string fileName
    string sha256
  }
  WORKFLOW_TEMPLATES {
    string id
    string applicationType
    string status
    object[] draftSteps
    string activeVersionId
  }
  WORKFLOW_VERSIONS {
    string id
    string templateId
    number versionNo
    object[] steps
    string publishedAt
  }
  WORKFLOW_INSTANCES {
    string id
    string templateId
    string templateVersionId
    string applicationId
    string status
    number currentStepNo
  }
  WORKFLOW_STEPS {
    string id
    string instanceId
    number stepNo
    string approverType
    string approverId
    string status
  }
  APPROVAL_RECORDS {
    string id
    string instanceId
    string stepId
    number seq
    string action
    string operatorId
    string prevHash
    string hash
  }
```

关系规则：

- 一个申请最多一个实例；实例必须引用已发布模板版本。
- 步骤提交时解析审批人并快照；模板更新不影响进行中实例。
- 一个实例最多一个 active 步骤；一步最多一条 approve/reject；一实例最多一条 withdraw。
- 审批记录只追加，实例内哈希链；不覆盖历史。

## 5. Document / File

```mermaid
erDiagram
  USERS ||--o{ DOCUMENTS : "owner"
  PROJECTS ||--o{ DOCUMENTS : "optional project"
  DOCUMENT_CATEGORIES ||--o{ DOCUMENTS : "classifies"
  DOCUMENTS ||--o{ DOCUMENT_VERSIONS : "versions"
  DOCUMENTS ||--o{ DOCUMENT_ACL : "ACL"
  DOCUMENTS ||--o{ DOCUMENT_TAGS : "tagged"
  TAGS ||--o{ DOCUMENT_TAGS : "labels"
  DOCUMENT_VERSIONS }o--|| FILES : "fileId"
  APPLICATION_ATTACHMENTS }o--|| FILES : "fileId"

  DOCUMENTS {
    string id
    string title
    string categoryId
    string projectId
    string ownerId
    string visibility
    string status
    string currentVersionId
    number versionCount
  }
  DOCUMENT_VERSIONS {
    string id
    string documentId
    number versionNo
    string fileId
    string fileName
    string sha256
  }
  DOCUMENT_CATEGORIES {
    string id
    string parentId
    string name
  }
  TAGS {
    string id
    string name
    string color
  }
  DOCUMENT_TAGS {
    string documentId
    string tagId
  }
  DOCUMENT_ACL {
    string id
    string documentId
    string subjectType
    string userId
    string roleId
    string departmentId
    string permission
  }
  FILES {
    string id
    string sha256
    string storageKey
    number size
    string mime
    string status
    number refCount
  }
```

关系规则：

- `documents.currentVersionId` 指向最新版本；版本只追加。
- `files` 按 SHA-256 内容寻址；文档版本/申请附件通过 `fileId` 引用。
- 文件内容在本地文件系统；`files` 只存元数据。
- 文档 ACL 独立实体；owner 始终 manage；组织管理员绕过。
- 标签/ACL 变更与文档写入同一事务；文件删除延迟清理。

## 6. Calendar / Notification / Audit / Helper

```mermaid
erDiagram
  USERS ||--o{ EVENTS : "creates"
  EVENTS ||--o{ EVENT_REMINDERS : "reminds"
  USERS ||--o{ NOTIFICATIONS : "receives"
  USERS ||--o{ AUDIT_LOGS : "acts"
  EVENTS {
    string id
    string title
    string startAt
    string endAt
    string projectId
    string visibility
    string status
    string[] attendeeUserIds
  }
  EVENT_REMINDERS {
    string id
    string eventId
    string userId
    number minutesBefore
    string sendAt
    string sentAt
  }
  NOTIFICATIONS {
    string id
    string recipientId
    string type
    string title
    string linkPath
    string readAt
  }
  AUDIT_LOGS {
    string id
    number seq
    string actorId
    string action
    string resourceType
    string resourceId
    string result
    string prevHash
    string hash
  }
```

补充：

- `events.attendees` 内嵌参与人及响应；`event_reminders` 单独存放调度。
- `audit_logs` 全局 seq + 哈希链；只追加。
- `counters` / `idempotency` 是辅助键空间，不属于业务实体图。

## 7. KV 键空间与主键

| 实体 | 子库 | 主键 | 复合键示例 |
|---|---|---|---|
| users | `users` | userId | — |
| sessions | `sessions` | sessionId | — |
| roles | `roles` | roleId | — |
| permissions | `permissions` | permissionCode | — |
| login_records | `login_records` | recordId | — |
| org_profile | `org_profile` | `profile` | — |
| departments | `departments` | departmentId | — |
| positions | `positions` | positionId | — |
| settings | `settings` | `settings` | — |
| projects | `projects` | projectId | — |
| project_members | `project_members` | projectId + userId | `p1\u001Fu1` |
| tasks | `tasks` | taskId | — |
| task_comments | `task_comments` | commentId | — |
| applications | `applications` | applicationId | — |
| application_attachments | `application_attachments` | attachmentId | — |
| workflow_templates | `workflow_templates` | templateId | — |
| workflow_versions | `workflow_versions` | versionId | — |
| workflow_instances | `workflow_instances` | instanceId | — |
| workflow_steps | `workflow_steps` | stepId | — |
| approval_records | `approval_records` | recordId | — |
| documents | `documents` | documentId | — |
| document_versions | `document_versions` | versionId | — |
| document_categories | `document_categories` | categoryId | — |
| tags | `tags` | tagId | — |
| document_tags | `document_tags` | documentId + tagId | `d1\u001Ft1` |
| document_acl | `document_acl` | aclId | — |
| files | `files` | fileId | — |
| events | `events` | eventId | — |
| event_reminders | `event_reminders` | reminderId | — |
| notifications | `notifications` | notificationId | — |
| audit_logs | `audit_logs` | seq + recordId | `000000000123\u001Fa1` |
| counters | `counters` | scope + period | `application\u001F20261103` |
| idempotency | `idempotency` | userId + key | `u1\u001Fabc` |

## 8. 引用与删除规则

| 引用 | 规则 |
|---|---|
| user.departmentId → departments | 部门删除前必须无员工；用户部门必须 active |
| user.positionId → positions | 岗位删除前检查引用 |
| user.managerId → users | 不能自引用/成环 |
| project.ownerId → users | owner 必须是项目成员；唯一 |
| project_members.userId → users | 停用用户不能新增；移除前检查未完成任务 |
| task.projectId → projects | 项目归档后任务只读 |
| task.assigneeId → users | 必须是项目成员 |
| application.applicantId → users | 提交后不变 |
| application_attachments.fileId → files | 删除附件软删；文件 refCount |
| workflow_instance.applicationId → applications | 一个申请最多一个实例 |
| workflow_step.approverId → users | 提交时快照；失效走转交 |
| approval_records.stepId → workflow_steps | 只追加；不删除 |
| document.categoryId → categories | 删除分类前检查文档 |
| document.projectId → projects | 项目文档继承项目可见性 |
| document_versions.fileId → files | 版本不可变 |
| document_acl.documentId → documents | 主体三选一；唯一 |
| events.projectId → projects | 项目归档后只读 |
| notifications.recipientId → users | 接收人 active |
| audit_logs.actorId → users | 可为空（系统） |

删除策略：

- 软删除：users（disabled）、departments、positions、projects、tasks、comments、documents、categories、tags、events。
- 只追加：approval_records、audit_logs、login_records、document_versions。
- 物理删除：draft applications、未引用临时文件、过期 sessions/notifications（维护任务）。
- 不做级联删除；服务层先检查引用，必要时阻止并提示。

## 9. 索引与查询映射

| 查询 | 键空间 |
|---|---|
| 登录 | `idx_users_email` |
| 我的待办 | `idx_tasks_assignee` |
| 项目看板 | `idx_tasks_project_status` |
| 待我审批 | `idx_steps_approver` |
| 我的申请 | `idx_applications_applicant` |
| 最近项目 | `idx_members_user` |
| 文档列表 | `idx_documents_updated` |
| 文档搜索 | `idx_documents_title` + ACL 过滤 |
| 通知 | `idx_notifications_recipient` |
| 审计 | `idx_audit_actor` / `idx_audit_resource` |

## 10. 数据模型验收

- [ ] 实体字段、类型、必填/可空、引用规则明确。
- [ ] 无 `organization_id`/多租户字段。
- [ ] 无 SQL 表/外键/ORM 类型。
- [ ] 每个高频查询有索引。
- [ ] 唯一约束通过索引键实现。
- [ ] 审批/审计只追加。
- [ ] 文件元数据与文件引用清晰。



