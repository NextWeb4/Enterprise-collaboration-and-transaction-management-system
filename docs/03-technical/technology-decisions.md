# 技术选型与决策

> 文档状态：Draft for Review  
> 版本：0.2.0  
> 日期：2026-10-31  
> 原则：每个结论说明依据、替代方案、代价与复审条件；未验证的不写成事实。  
> 关联：[嵌入式存储评估](../05-research/embedded-storage-evaluation.md)、[数据存储设计](data-storage-design.md)

## 1. 新版约束

1. 单组织部署；不实现多租户/组织切换。
2. 不使用 Docker/Docker Compose/Kubernetes。
3. 不使用任何 SQL 数据库或 SQL ORM。
4. 不要求用户安装独立数据库服务。
5. Windows 本机优先；默认仅本机访问，局域网需显式配置。
6. 保留完整产品功能，不因存储改造缩减模块。
7. 只做文档修订 + 独立存储原型，不开发正式业务模块。

## 2. 技术栈总览

| 层 | 选择 | 理由 | 代价 |
|---|---|---|---|
| 前端 | React + TypeScript + Vite | 生态成熟、SPA 简单 | 无 SSR/SEO |
| UI | Ant Design 5 | 企业中后台组件完整 | 需主题定制 |
| 路由 | React Router | 成熟、嵌套布局 | 需自行组织权限 |
| 服务端状态 | TanStack Query | 缓存/失效/四态 | query key 设计 |
| 客户端状态 | Zustand | 轻量 UI 状态 | 不适合领域数据 |
| 表单 | RHF + Zod | 性能 + 共享契约 | 动态表单需封装 |
| 后端 | Node 24 + Fastify 5 | 低开销、插件化、Windows 友好 | 生态比 Nest 小 |
| API | REST + OpenAPI 3.1 | 简单、文档化、文件友好 | 无 GraphQL 聚合 |
| 存储 | **LMDB（`lmdb` 3.5.9）** | ACID、事务读改写、崩溃恢复、Windows 预编译 | 原生模块/OpenLDAP 许可 |
| 数据格式 | JSON 文档 + 索引子库 | 可读、可迁移、无 SQL | 需自管索引/唯一约束 |
| 文件 | 本地文件系统 + SHA-256 | 无服务依赖、可去重 | 单机/对账 |
| 认证 | LMDB 会话 + Cookie | 可撤销、可审计 | 每请求读会话 |
| 密码 | Argon2id | 抗 GPU | 参数/并发 |
| 测试 | Vitest + Playwright | 与 Vite 生态一致 | 存储集成需真实目录 |
| 部署 | 本机 Node + 静态 SPA | 无 Docker/DB 服务 | 需手动启动/停止 |
| 包管理 | pnpm workspace | 严格、快 | 原生模块预编译 |

## 3. 存储选型（核心）

### TD-01 采用嵌入式 KV，不采用 SQL/ORM

- **选择**：LMDB 命名子库 + JSON 文档；Repository/UnitOfWork 抽象。
- **替代**：
  - SQL（PostgreSQL/MySQL/SQLite）：明确禁止；
  - 单 JSON 文件：无事务/并发/索引，禁止；
  - 纯内存：不持久化，禁止；
  - 自研 JSON 日志：恢复/索引/并发成本高。
- **依据**：需求明确无数据库服务、无 SQL；LMDB 原型通过事务/并发/崩溃/索引测试。
- **代价**：唯一约束/索引/引用完整性需自研；无 SQL 查询/报表。
- **复审**：LMDB 无法在目标 Windows 加载，或数据量/并发超出验证范围。

### TD-02 LMDB 作为首选存储引擎

- **选择**：`lmdb@3.5.9`，`encoding:'json'`，`maxDbs:128`，`mapSize:2–4GB`。
- **替代**：
  - ClassicLevel：原生 LevelDB，batch 原子但无事务读改写；100 并发计数器只保留 1；
  - RocksDB：包体积/构建风险，未验证；
  - NeDB/lowdb：事务/单文件问题。
- **依据**（原型，项目外临时目录）：
  - 100 并发事务计数器 = 100；
  - 2 进程各 300 事务 = 600；
  - 强杀后 4146 任务/审计/计数一致；
  - 50k 任务：写入 1.46s、索引查询 7.84ms、1000 读取 3.89ms、RSS 65MB、DB 25.7MB；
  - Windows 10 + Node 24 加载成功，有 TS 声明。
- **代价**：原生模块；OpenLDAP 2.8；无 repair；单写者；不适合网络盘。
- **复审**：目标环境加载失败、法务否决、需要跨网络盘/多主写入。

### TD-03 JSON 文档 + 独立索引子库

- **选择**：每个实体一个命名 DB；索引独立 DB；键为实体 ID 或复合键。
- **依据**：避免单个 JSON 文件；索引可重建；JSON 可读/可迁移。
- **代价**：索引与文档需同事务维护；唯一约束需手写；复杂查询需预建索引。
- **复审**：复杂报表/全文检索需求增加时，评估专用索引/搜索引擎（仍不含 SQL 服务）。

### TD-04 StorageEngine / Repository / UnitOfWork 抽象

- **选择**：业务模块只依赖接口；LMDB 适配器是唯一实现。
- **依据**：未来可替换存储；测试可注入临时目录；防止业务模块直接访问 `data.mdb`。
- **代价**：抽象层代码量；事务上下文传递需纪律。
- **禁止**：模块自行 `open()`、直接读写文件、绕过 UnitOfWork 多步写。

### TD-05 单组织，删除 organization_id

- **选择**：组织为单例 `org_profile`；所有实体无 `organizationId`。
- **依据**：需求明确不实现多租户/组织切换；去掉冗余字段与隔离复杂度。
- **代价**：未来多组织需重构；当前不承诺。
- **复审**：只有产品明确转为多组织 SaaS 时才重新设计。

### TD-06 本机 Node 托管 SPA，不使用 Docker

- **选择**：Node 进程提供 API + 静态 SPA；单端口；普通进程启动/停止；默认 127.0.0.1。
- **依据**：无 Docker；单机局域网；降低运维。
- **代价**：无容器隔离/编排；进程退出即停止；需手动启动、日志轮转、防火墙。
- **复审**：需要多实例/容器编排时，另立架构。

### TD-07 本地文件系统 + 内容寻址

- **选择**：`data/files/<sha256>`；元数据 `files`；文档版本/附件引用 fileId。
- **依据**：无对象存储服务；SHA-256 去重/校验；对账简单。
- **代价**：文件与 KV 非原子；需补偿/对账；单机容量。
- **复审**：多实例/大容量/对象存储需求。

## 4. 前端决策

### TD-08 React + TypeScript + Vite

- **依据**：需求候选；生态/组件/类型；SPA 无需 SSR。
- **替代**：Vue（也可行）、Next.js（引入服务端复杂度）。
- **代价**：需路由/错误边界/代码分割。

### TD-09 Ant Design 5 + 主题 token

- **依据**：表格/表单/树/上传/弹窗完整；中文 locale；减少自研。
- **代价**：视觉同质化；包体积；需主题规范。
- **禁止**：复制参考产品 UI 资产。

### TD-10 TanStack Query + Zustand + RHF + Zod

- **依据**：服务端状态/客户端 UI 状态分离；表单性能；Zod 共享契约。
- **代价**：query key/错误映射需规范。
- **禁止**：Zustand 复制业务列表作为第二数据源。

### TD-11 Markdown 文本域，不做富文本编辑器

- **依据**：避免 Slate/ProseMirror/TipTap 复杂度与 XSS 面。
- **代价**：用户需少量 Markdown；复杂排版后续评估。

## 5. 后端决策

### TD-12 Node 24 LTS + Fastify 5

- **依据**：当前环境 Node 24.17；Fastify 低开销、插件、inject 测试、Pino。
- **替代**：NestJS（重）、Express（校验/结构弱）。
- **代价**：需手工组织模块/DI。

### TD-13 REST + OpenAPI 3.1

- **依据**：资源模型简单；文件上传/下载；OpenAPI 文档/测试。
- **替代**：GraphQL/tRPC（首版无收益）。
- **代价**：工作台需专用聚合端点。

### TD-14 LMDB 会话，而非 JWT

- **选择**：随机 token，LMDB 存 SHA-256；Cookie。
- **依据**：强制下线/改密撤销/审计；同源 SPA 无需 JWT。
- **代价**：每请求读会话；单进程/共享本机。

### TD-15 Argon2id

- **依据**：内存硬、抗 GPU；Node 预编译。
- **代价**：参数校准/并发限制。

### TD-16 自研顺序审批，不引入 BPMN

- **依据**：R1 五类申请顺序单审批人；BPMN 过重。
- **代价**：不支持会签/条件/委托；P1 再评估。
- **存储实现**：一个 LMDB 事务内更新申请/实例/步骤 + 追加记录 + 通知/审计。

### TD-17 审批/审计哈希链

- **选择**：全局审计链 + 实例内审批链。
- **依据**：检测删除/篡改；比普通 append-only 更强。
- **代价**：每次写计算哈希；哈希链不能防拥有 OS 完全权限的管理员；需 ACL/审计。
- **复审**：需要外部 WORM/签名时增加导出。

### TD-18 单写者/单实例锁

- **选择**：一个 API 进程；`data/locks/app.lock` 防双实例。
- **依据**：LMDB 单写者；应用层缓存/调度简单；目标单机。
- **代价**：无法多 API 实例；水平扩展需重构。
- **复审**：需要多实例时，需共享存储/队列/锁。

## 6. 工程决策

### TD-19 pnpm workspace + 三个包

- **选择**：`app/frontend`、`app/backend`、`app/shared`；不做 Turborepo。
- **依据**：包少、构建快；减少配置。
- **复审**：包 >8 或 CI >10 分钟。

### TD-20 Vitest + Fastify inject + Playwright

- **选择**：LMDB 临时目录集成测试；真实文件系统；E2E。
- **依据**：无数据库服务；测试可复现；真实存储行为。
- **代价**：测试隔离/清理；原生模块。

### TD-21 不建设备份系统

- **选择**：不提供自动/异地备份、保留策略、备份加密、备份恢复 UI；数据安全由用户负责。
- **依据**：LMDB 无 repair；数据完整性优先。
- **代价**：数据损坏/误删无产品内恢复能力。

### TD-22 日志轮转 + 审计分离

- **选择**：Pino 文件日志 + LMDB 审计；保留 30 天。
- **依据**：可观测与合规分离；日志可轮转，审计不可覆盖。
- **代价**：磁盘管理；审计查询需索引。

### TD-23 不引入 Redis/MQ/搜索集群

- **依据**：单机 500 用户；LMDB/索引足够；减少组件。
- **代价**：异步/缓存/全文检索需后续评估。
- **复审**：明确瓶颈/集成需求。

## 7. 被否决/替代的旧决策

| 旧决策 | 新决策 | 原因 |
|---|---|---|
| PostgreSQL 17 | LMDB | 无 SQL/无数据库服务 |
| Prisma | StorageRepository/UnitOfWork | 禁止 ORM |
| SQL 表/外键/迁移 | JSON 文档/索引/schemaVersion | 存储模型改变 |
| Docker Compose | 本机 Node + 普通进程 | 部署限制 |
| 多组织 + organization_id | 单组织 | 明确不实现多租户 |
| RLS/复合外键 | 服务层引用校验 + 索引 | 无 SQL |
| SQL 行锁 | LMDB 写事务 + 乐观锁 | 存储模型改变 |
| PostgreSQL 备份 | 不建设备份系统 | 人工决策 |
| 人为最小闭环 | 完整文档中心规划 | 不人为缩减功能 |

## 8. 版本策略

- Node 24.x LTS；pnpm 11.x；`packageManager` 固定。
- `lmdb` 固定 3.5.9（原型验证版本）；升级前跑存储/崩溃/索引测试。
- 前端/后端依赖初始化日锁定；`pnpm-lock.yaml` 入库。
- 每月补丁升级；major 升级写 ADR + 回归。
- 原生模块升级需确认 Windows 预编译/Node ABI；保留回退版本。

## 9. 风险与已关闭决策

| 项 | 风险 | 待确认 |
|---|---|---|
| LMDB 最终选型 | 已确定 | Q-015 已关闭 |
| 备份 | 不建设 | Q-016 已关闭 |
| 静态加密 | 暂不实现 | Q-017 已关闭 |
| HTTPS/反代 | 本地 HTTP，不引入 | Q-018 已关闭 |
| Windows 服务 | 普通进程，不注册 | Q-019 已关闭 |
| 数据量 | 超过 5 万任务/10 万申请 | M4 压测 |
| 断电 | 仅进程强杀测试 | 上线前演练 |
| 杀毒软件 | 文件锁/性能 | 评估排除策略 |

## 10. 依据来源

- LMDB：https://github.com/kriszyp/lmdb-js
- lmdb-js 文档：https://github.com/kriszyp/lmdb-js#readme
- ClassicLevel：https://github.com/Level/classic-level
- React：https://react.dev/
- Vite：https://vite.dev/
- Ant Design：https://ant.design/
- Fastify：https://fastify.dev/
- TanStack Query：https://tanstack.com/query
- Zod：https://zod.dev/
- OWASP ASVS：https://owasp.org/www-project-application-security-verification-standard/

> 原型结果见 [嵌入式存储评估](../05-research/embedded-storage-evaluation.md)；不把原型数字当作生产 SLA。






