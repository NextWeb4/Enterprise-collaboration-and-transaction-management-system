# 企业协同与事务管理平台

> 英文名：Enterprise Collaboration & Office Management Platform  
> 工程代号：`collab-office`  
> 当前阶段：**第一阶段 · 技术架构重构完成，待人工审查**  
> 文档版本：0.3.0（2026-10-31）  
> 状态：**禁止进入正式业务编码**

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

本阶段只做规划文档修订、存储方案研究、独立原型验证，不包含：

- 正式业务模块/API/前端页面；
- 正式项目依赖安装；
- 正式数据库/数据目录初始化；
- Docker/数据库服务；
- 对历史项目（NextWeb4/gw 等）的检查、复用或迁移。

阶段完成后必须等待人工审查，审查通过前不得进入编码。

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
| 审查 | [技术架构重构审查报告](docs/第一阶段技术架构重构审查报告.md) | 原问题、修改、选型、验证、结论 |
| 历史 | [第一阶段审查报告（旧）](docs/06-review/phase-1-review.md) | 已被重构版替代，仅留痕 |

## 4. 核心业务闭环

1. **项目管理**：创建项目 → 添加成员 → 创建任务 → 分配负责人 → 更新进度 → 完成任务 → 项目归档。
2. **OA 审批**：提交申请 → 审批处理 → 通过/驳回 → 状态更新 → 历史留档。
3. **权限管理**：创建用户 → 分配角色 → 授予权限 → 验证访问范围 → 记录关键操作。
4. **文档管理**：上传 → 分类 → 授权 → 检索 → 下载 → 版本记录。

## 5. 技术基线（待审查确认）

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

1. 人工审查 [技术架构重构审查报告](docs/第一阶段技术架构重构审查报告.md)。
2. Q-015～Q-019 已关闭；等待人工审核本报告。
3. 审查通过后才进入 R1/M0；未确认前不编码。





