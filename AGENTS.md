# AGENTS.md

> 本文件是 AI 代理与人类开发者的工程契约。  
> 项目：企业协同与事务管理平台（`collab-office`）  
> 当前阶段：**R1 · M0 开发与验收中（尚未通过）**
> 最后更新：2026-11-02
> 冲突优先级：用户当前明确指令 > 本文件 > 其他文档 > 一般惯例。

## 1. 当前阶段门禁

架构审查已获明确批准。用户于 2026-11-02 明确授权在 M0 验收尚未通过时并行开发后续业务模块。M0 仍须按原验收要求完成并经人工确认；并行开发不表示 M0 已通过。未落实的权限、存储和安全保证不得被假定为已具备，后续模块须独立验证并保持默认拒绝。M0 未通过项必须如实保留，不得以文档改写规避。

持续禁止：

- 初始化/覆盖任何非隔离验收数据目录或迁移现有数据库；
- 引入 Docker、SQL、ORM、多租户或本协议明确禁止的依赖/架构；
- 把原型或参考产品代码复制进项目。

允许：

- 在 M0 范围内实现基础/存储/身份能力；
- 并行开发和验证后续业务模块；
- 在明确隔离的临时目录验证初始化、认证、存储和浏览器流程；
- 完善规划、验收、架构与开发文档。

M0 门禁：依赖冻结安装、typecheck/lint/test/build、存储/崩溃验收、身份安全及单机运行检查须有可复现证据。Q-015～Q-019 已关闭。

## 2. 项目边界

- 全新自主研发；不以 JeecgBoot、NocoBase、Yudao、Plane、ERPNext、Dolibarr 等完整系统为底座。
- 不检查、不修改、不迁移、不复用 NextWeb4/gw 或任何历史项目。
- 参考产品只用于产品/交互/数据建模研究；不复制代码、表结构、UI 资产。
- 单组织；不做多租户/组织切换。
- 不使用 SQL 数据库/SQL ORM/独立数据库服务/Docker/K8s。
- 首版 Web；不做 Electron/原生 App。

## 3. 必读文档

1. `README.md`
2. `docs/第一阶段技术架构重构审查报告.md`
3. `docs/00-project/decision-log.md`
4. `docs/01-product/product-overview.md`
5. `docs/01-product/product-requirements.md`
6. `docs/01-product/mvp-scope.md`
7. `docs/02-business/business-architecture.md`
8. `docs/02-business/permission-model.md`
9. `docs/03-technical/system-architecture.md`
10. `docs/03-technical/data-storage-design.md`
11. `docs/03-technical/api-design.md`
12. `docs/03-technical/security-design.md`

与任务相关的业务规则必须同时阅读。

## 4. 不可违反的约束

### 4.1 架构

- 单组织 + 模块化单体；一个 Node/Fastify 进程 + 一个 SPA。
- 无 SQL/ORM/数据库服务/Docker/Redis/MQ/K8s。
- 存储：LMDB + JSON 文档 + 独立索引子库；文件：本地文件系统 + SHA-256。
- 业务模块只依赖 Repository/UnitOfWork，不直接 `open()` LMDB、不读写 `data.mdb`。
- 关键写操作必须在一个 LMDB 写事务内。
- 索引可重建，不是唯一数据源。

### 4.2 数据

- 主键 UUIDv7；文档信封含 `schemaVersion/version/createdAt/updatedAt/deletedAt`。
- 无 `organization_id`/多租户字段。
- 唯一约束通过唯一索引键实现；冲突 409。
- 软删除字段 `deletedAt`；审批/审计/登录只追加。
- 审计全局哈希链；审批实例内哈希链。
- 文件元数据与文件必须对账；refCount 维护。
- 数据目录必须本地盘；禁止 SMB/NFS/OneDrive 同步目录。

### 4.3 安全

- 密码 Argon2id；会话 token 只存 SHA-256；Cookie HttpOnly/SameSite=Lax（本地 HTTP 不设 Secure）。
- 所有已认证变更请求校验 CSRF token + Origin；登录至少校验 Origin。
- 后端权限默认拒绝；前端隐藏不是安全边界。
- 审批只能当前步骤审批人操作；管理员不能代批。
- 文件上传白名单/大小/文件头；下载鉴权；不暴露路径。
- 日志禁止密码/token/Cookie/文件内容/完整申请正文。
- 无默认 admin/123456；首个管理员显式创建。
- 数据目录 ACL；无应用层静态加密；无备份系统。

### 4.4 业务

- 项目短键创建后不可改；任务编号不复用；owner 唯一且不可直接移除。
- `done` ⇔ 进度 100；项目完成时不能有未完成任务。
- 审批顺序单审批人；申请提交后不可编辑；撤回仅在无审批动作前。
- 文档版本只追加；owner 始终 manage。
- 普通成员不能看私有项目；部门范围不能绕过项目隐私。
- 文档中心按完整范围实现，不做事先缩减范围的人为最小闭环。

## 5. 技术栈

- 前端：React 19、TypeScript、Vite、Ant Design 5、TanStack Query、Zustand、RHF、Zod、React Router。
- 后端：Node 24 LTS、Fastify 5、Zod。
- 存储：`lmdb` 3.5.9 + JSON + 索引子库；`StorageEngine`/`Repository`/`UnitOfWork`。
- 文件：本地 `data/files`，SHA-256 内容寻址。
- 测试：Vitest、Fastify inject、Playwright、真实 LMDB 临时目录。
- 部署：Windows 本机 Node + 静态 SPA；普通进程；默认 127.0.0.1；无 Docker/DB/服务/反代。

## 6. 目录

```text
EnterprisePlatform/
  app/frontend, app/backend, app/shared
  data/config, data/store/lmdb, data/files, data/logs, data/tmp, data/trash
  scripts/
docs/
```

- `app/` 只读；`data/` 可写；程序与数据分离。
- 不建额外 UI/domain 包，除非有 3 个以上业务域复用并经 ADR。

## 7. 编码规范

- TypeScript strict；禁止 `any`；公共函数显式返回类型。
- 路由：校验 → service → 序列化；不写存储细节/业务规则。
- service：一个用例一个方法；事务/权限/审计/通知在此。
- 错误：`AppError(code, status, message)`；统一 problem+json。
- 日期：存 UTC ISO；展示本地时区；纯日期 `YYYY-MM-DD`。
- 日志：Pino；requestId；脱敏。
- 前端：TanStack Query 管服务端状态；Zustand 只放 UI；RHF + Zod。
- UI：AntD token；四态（加载/空/错误/无权限）；响应式；可访问性。
- 禁止 React 组件复制状态机/权限判断作为安全依据。

## 8. API/契约

- Base `/api/v1`；成功 `{data}`；列表 `{data, meta}`；错误 problem+json。
- 资源化 URL；更新带 `version`；冲突 409。
- 创建类 POST 支持 `Idempotency-Key`（至少申请提交）。
- 具体资源越权 404；功能无权限 403；状态冲突 409。
- 新增/修改端点同步 contracts、权限码、OpenAPI、测试、文档。
- 不返回 passwordHash/tokenHash/存储路径。

## 9. 测试要求

- 新功能必须带测试；bug 修复先写复现测试。
- 状态机/审批人/ACL/权限策略单测 ≥90%；service ≥80%；全仓 ≥70%。
- API 用 `app.inject()` + 真实 LMDB 临时目录；不用 mock 存储。
- 必测：事务回滚、并发读改写、崩溃恢复、索引重建、文件对账。
- 每切片至少 1 条 E2E；M4 覆盖关键闭环。
- 合并前：typecheck、lint、测试、build 全绿。

## 10. Git

- `main` 始终可构建；短分支 `feat/fix/docs/chore`。
- Conventional Commits；一个提交一件事。
- 不提交 `node_modules`、`.env`、`data/`、构建产物。
- PR 描述：变更/验证/风险/截图/数据迁移/回滚。
- 不合并未通过 CI 的变更。

## 11. 文档同步

| 变更 | 更新 |
|---|---|
| 范围/优先级 | PRD、交付范围、路线图、验收 |
| 业务规则/状态 | 业务文档、PRD、测试 |
| 实体/索引/键空间 | 数据存储设计、数据模型图 |
| API/权限码 | API 设计、contracts、权限模型 |
| 安全边界 | 安全设计、验收 |
| 技术选型 | 技术决策/ADR |

不确定内容必须标记“待确认/待验证”。

## 12. 代理工作流程

1. 确认阶段门禁。
2. 读相关文档/代码。
3. 列计划/todo。
4. 最小变更，不顺手重构。
5. 验证：类型/lint/测试/构建/存储测试。
6. 自审：权限、事务、审计、文件、数据目录。
7. 报告：改了什么、依据、验证、风险、下一步。

## 13. 停止条件

遇到以下必须停止并提问：

- 需求与文档/架构冲突；
- 需要 SQL/ORM/DB 服务/Docker/多租户；
- 需要引入 Redis/MQ/搜索服务；
- 数据库/数据目录破坏性迁移；
- 权限模型无法表达；
- 发现跨用户/项目/文档泄露风险；
- 用户要求绕过仍有效的验收或安全约束。

## 14. 禁止清单

- 读取/复用 NextWeb4/gw 或历史项目。
- 克隆/复制参考系统代码/表结构/UI。
- 引入 GPL/AGPL/自定义限制代码。
- SQL/Prisma/TypeORM/Sequelize/Drizzle/SQLite/PostgreSQL/MySQL。
- Docker/K8s/Electron/多租户。
- 自研富文本编辑器/表格/表单设计器。
- 默认管理员/弱密码/明文密码。
- 前端权限作为安全边界。
- 物理删除审批/审计；覆盖审批历史。
- 日志输出敏感信息。
- 未经确认安装正式依赖/迁移/开始编码。

## 15. 完成报告模板

```markdown
## 完成内容
## 关键决策/依据
## 验证
- [ ] typecheck
- [ ] lint
- [ ] test
- [ ] build
- [ ] 存储/崩溃测试
## 风险/待确认
## 下一步
```

## 16. 当前交付

当前并行推进 R1/M0 基础工程、验收及后续业务模块；验收结论、证据、未通过项与数据边界见 `docs/04-development/M0-acceptance-report.md`。M0 尚未通过，并行开发不得假定未落实的安全保证已经具备。不得通过改写状态文档规避验收差距；阶段门禁详见第 1 节。





