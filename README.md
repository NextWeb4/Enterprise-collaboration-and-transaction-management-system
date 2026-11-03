# 企业协同与事务管理平台

> 英文名：Enterprise Collaboration & Office Management Platform  
> 工程代号：`collab-office`  
> 当前阶段：**R1 · M0 开发与验收中（M0 尚未通过）**
> 文档版本：0.3.0（2026-10-31）  
> 状态：**M0 基础工程与验收进行中；已获授权并行开发后续业务模块**

## 1. 项目是什么

一个从零自主研发的轻量级 **OA + 项目管理** Web 平台，把日常办公、项目与任务协同、行政审批、组织与权限管理整合到一个统一工作台。

**新版架构约束**：

- 单组织部署；不做多租户/组织切换。
- 无 SQL 数据库、无 SQL ORM、无独立数据库服务。
- 无 Docker/Docker Compose/Kubernetes。
- 嵌入式 LMDB + 本地文件系统 + 本机 Node.js。
- Windows 本机优先；默认仅 127.0.0.1，局域网需显式配置并接受 HTTP 明文风险。
- 普通进程启动/停止；不注册 Windows 服务；不使用反代/HTTPS/Caddy/IIS。
- 不建设自动备份/异地备份/备份管理/恢复 UI。
- 文档中心、日程、统计等模块按完整业务需求规划，不人为缩减。

## 2. 当前阶段边界

架构审查已获批准，用户于 2026-11-02 授权在 M0 尚未通过时并行开发后续业务模块。M0 的未通过项与验收要求仍然有效；并行开发须独立验证，不得假定尚未落实的权限、存储与安全保证已具备。初始化与浏览器验收仅使用显式隔离的数据目录；不得迁移既有数据库或对历史项目（NextWeb4/gw 等）进行检查、复用或迁移。

Docker、SQL/ORM、多租户及其他架构禁项仍不允许。

## Windows Bootstrap 启动

以下是本机开发环境的最小启动检查，M0 整体验收仍未通过。需要 Node.js 24.17.0（24.x）和 pnpm 11.18.0；在 PowerShell 中进入项目根目录：

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm dev
```

打开 [http://127.0.0.1:5173/](http://127.0.0.1:5173/)，页面显示后端连接状态；点击“写入并读取”验证 LMDB，重启后可看到已有记录。默认后端地址为 `http://127.0.0.1:3000`。在启动终端按 Ctrl+C 停止；后端源码变更后需重启开发进程。生产构建使用 `pnpm build`，Bootstrap 读写接口仅用于本机开发环境。

默认开发数据目录为 `%LOCALAPPDATA%\collab-office-bootstrap\data`，LMDB 位于其中的 `store\lmdb`，不位于源码目录。应使用本地 NTFS 盘，避免网络共享和同步目录；首次运行会初始化该目录，已有目录将被继续使用。需要隔离测试或 3000 端口已占用时，可在启动前设置：

```powershell
$env:DATA_DIR = 'C:\collab-office-bootstrap-test\data'
$env:PORT = '3309'
pnpm dev
```

使用一个专门的新目录，勿指向正式数据。变量只影响当前 PowerShell 会话；`Remove-Item Env:DATA_DIR, Env:PORT` 可恢复默认设置。`.env.example` 仅作配置参考，`pnpm dev` 不会自动加载 `.env`。

### 设置管理员与添加内部账号

系统没有默认账号和密码。首次在新的本机数据目录启动后，打开首页并在“设置首个管理员”页面填写姓名、内部账号和密码。设置成功后使用该账号登录，在侧栏“内部账号”中创建成员并设置初始密码；成员首次登录时必须修改密码。

内部账号为 3–64 位字母、数字、点、下划线或连字符，首位须为字母或数字，不区分大小写。密码须为 12–128 位且不能是常见弱密码。首次设置只在监听本机且数据目录没有用户或审计历史时可用；已有数据不会被重置。需使用和 `pnpm dev` 一致的数据目录。命令行初始化仍可按 [开发指南](docs/04-development/development-guide.md) 使用。

## 3. 文档导航

| 阶段 | 文档 | 说明 |
|---|---|---|
| A | [项目初始化方案](docs/00-project/project-init.md) | 目录、环境、依赖、Git 规范 |
| A | [术语表](docs/00-project/glossary.md) | 业务/技术术语 |
| A | [决策记录](docs/00-project/decision-log.md) | 新旧决策、待确认问题 |
| B | [产品概述](docs/01-product/product-overview.md) | 定位、用户、价值、边界 |
| B | [产品需求](docs/01-product/product-requirements.md) | 完整产品需求与 R1/P1 顺序 |
| B | [用户角色](docs/01-product/user-roles.md) | 角色、数据范围、权限矩阵 |
| B | [用户故事](docs/01-product/user-stories.md) | 故事与验收场景 |
| B | [交付范围与顺序](docs/01-product/mvp-scope.md) | R1/P1、切片、冲突处理 |
| C | [业务架构](docs/02-business/business-architecture.md) | 领域、依赖、数据归属 |
| C | [业务流程](docs/02-business/business-processes.md) | 端到端流程与异常 |
| C | [项目管理](docs/02-business/project-management.md) | 项目/任务规则 |
| C | [OA 审批](docs/02-business/oa-workflow.md) | 申请/模板/审批实例 |
| C | [权限模型](docs/02-business/permission-model.md) | RBAC/范围/项目/ACL |
| D | [系统架构](docs/03-technical/system-architecture.md) | 九层架构、本机部署 |
| D | [数据存储设计](docs/03-technical/data-storage-design.md) | LMDB、键空间、索引、事务、文件 |
| D | [数据模型图](docs/03-technical/data-model-diagram.md) | 业务实体/引用/键空间 |
| D | [API 设计](docs/03-technical/api-design.md) | REST/错误/并发/幂等 |
| D | [安全设计](docs/03-technical/security-design.md) | 认证/权限/文件/本地数据 |
| D | [技术决策](docs/03-technical/technology-decisions.md) | 选型依据与替代方案 |
| E | [AGENTS.md](AGENTS.md) | AI/开发者工程契约 |
| E | [开发指南](docs/04-development/development-guide.md) | 环境、目录、规范、数据迁移 |
| E | [测试策略](docs/04-development/testing-strategy.md) | 存储/崩溃/并发/索引测试 |
| E | [开发路线图](docs/04-development/development-roadmap.md) | 切片、里程碑、工期 |
| E | [验收标准](docs/04-development/acceptance-criteria.md) | 四条闭环 + 存储/部署门禁 |
| F | [参考产品研究](docs/05-research/reference-products.md) | 产品设计参考与边界 |
| F | [嵌入式存储评估](docs/05-research/embedded-storage-evaluation.md) | LMDB/ClassicLevel 原型结果 |
| F | [依赖合规](docs/05-research/dependency-compliance.md) | 许可证、来源、准入 |
| F | [开源项目研究](docs/open-source-research.md) | 五个候选项目的架构、功能、许可证与复用结论 |
| F | [复用矩阵](docs/reuse-matrix.md) | A/B/C 复用分类与功能决策 |
| F | [许可证合规](docs/license-compliance.md) | 许可证、软著与第三方依赖边界 |
| F | [架构影响](docs/architecture-impact.md) | 候选项目对当前架构的冲突与推荐路径 |
| 审查 | [技术架构重构审查报告](docs/第一阶段技术架构重构审查报告.md) | 原问题、修改、选型、验证、结论 |
| 历史 | [第一阶段审查报告（旧）](docs/06-review/phase-1-review.md) | 已被重构版替代，仅留痕 |

## 4. 核心业务闭环

1. **项目管理**：创建项目 → 添加成员 → 创建任务 → 分配负责人 → 更新进度 → 完成任务 → 项目归档。
2. **OA 审批**：提交申请 → 审批处理 → 通过/驳回 → 状态更新 → 历史留档。
3. **权限管理**：创建用户 → 分配角色 → 授予权限 → 验证访问范围 → 记录关键操作。
4. **文档管理**：上传 → 分类 → 授权 → 检索 → 下载 → 版本记录。

## 5. 当前技术基线

- 前端：React + TypeScript + Vite + Ant Design + Zustand + TanStack Query + React Hook Form + Zod + React Router
- 后端：Node.js 24 LTS + Fastify + Zod + Repository/UnitOfWork
- 存储：**LMDB（`lmdb` 3.5.9，首选）** + JSON 文档 + 可重建索引
- 文件：本地文件系统 + SHA-256 内容寻址
- 部署：Windows 本机 Node + 静态 SPA，无 Docker/数据库服务
- 测试：Vitest + Playwright + 真实 LMDB 临时目录
- 明确不用：SQL/Prisma/TypeORM/Sequelize/Drizzle/PostgreSQL/MySQL/SQLite/Docker/K8s/多租户

详细依据见 [技术决策](docs/03-technical/technology-decisions.md) 与 [嵌入式存储评估](docs/05-research/embedded-storage-evaluation.md)。

## 6. 重要约束

- 所有业务数据经 `StorageRepository`/`UnitOfWork`；模块不得直接读写 LMDB/`data.mdb`。
- 关键写操作必须在一个 LMDB 事务内完成；索引不是唯一数据源。
- 审批记录、审计日志、登录记录只追加；审计/审批使用哈希链。
- 文件元数据与文件必须可对账；不提供备份/恢复系统。
- 所有页面必须设计加载、空、错误、无权限四类状态。
- 未验证的技术结论必须标记，不得写成既成事实。

## 7. 下一步

1. 按 [M0 验收报告](docs/04-development/M0-acceptance-report.md) 处理未通过/未验证项并补充可复现证据。
2. 并行开发后续业务模块并独立验证，持续补齐 M0 未落实的安全与存储保证；不得将并行开发视为 M0 通过。
3. 历史 [技术架构重构审查报告](docs/第一阶段技术架构重构审查报告.md) 记录的是文档阶段结论；当前门禁以本文件、[AGENTS.md](AGENTS.md) 和 M0 验收报告为准。





