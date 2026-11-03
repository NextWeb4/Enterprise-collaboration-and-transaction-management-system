# 开源复用方案的架构影响

> 日期：2026-11-02  
> 依据：当前仓库代码/技术文档和五个候选项目的官方仓库入口；没有检查历史项目，没有引入依赖或迁移数据。
> 更新：下列源码审计保留研究时的快照；用户随后于 2026-11-02 授权 M0 未通过时并行开发后续模块，具体现状以代码及验收报告为准。

## 1. 当前架构基线

本仓库定义并实现的基线是单组织、模块化单体、一个 Node/Fastify 进程和一个 React SPA。业务数据经 Repository/UnitOfWork 存入 LMDB JSON 文档与独立可重建索引；文件由本地 FileService 管理。项目约束明确禁止 SQL/ORM/数据库服务、Docker、Redis/MQ/K8s、多租户、复制参考系统代码/表结构/UI。

当前源码审计（仅本仓库）可由以下路径复核：

| 审计面 | 代码证据 | 当前结论 |
|---|---|---|
| 技术栈/入口 | [server.ts](../app/backend/src/server.ts#L76)、[App.tsx](../app/frontend/src/App.tsx#L36)、[package.json](../package.json) | 一个 Fastify 后端和 React/Vite SPA；后端同时挂载 API、静态文件、Cookie/CSRF、限流、文件上传和健康检查。 |
| 目录/模块边界 | [core 模块](../app/backend/src/modules/core/)、[storage](../app/backend/src/storage/)、[frontend](../app/frontend/src/)、[shared](../app/shared/src/) | 后端业务模块目前只有 `core`；存储、共享契约、前端壳分开，尚无 project/task/workflow/document/customer/contract/analytics 业务模块。 |
| 身份/权限 | [auth-service.ts](../app/backend/src/modules/core/auth-service.ts)、[repositories.ts](../app/backend/src/modules/core/repositories.ts)、[permissions.ts](../app/shared/src/permissions.ts) | 已有用户、会话、角色、权限目录、角色分配、登录和基础账号停用；`dataScope` 仍未执行于业务查询，账号完整生命周期未完成。 |
| 审计/登录 | [audit-service.ts](../app/backend/src/modules/core/audit-service.ts)、[models.ts](../app/backend/src/modules/core/models.ts) | 已有追加式登录记录与审计模型/服务及哈希字段；旧格式迁移和全部 M0 验收缺口以 [M0 验收报告](04-development/M0-acceptance-report.md) 为准。 |
| 文件/文档 | [file-service.ts](../app/backend/src/modules/core/file-service.ts)、[models.ts](../app/backend/src/modules/core/models.ts) | 已有本地文件落盘、SHA-256 文件元数据和启动对账；没有完整文档中心的分类、标签、ACL、搜索和版本业务实体。 |
| 存储/事务 | [engine.ts](../app/backend/src/storage/engine.ts)、[repository.ts](../app/backend/src/storage/repository.ts)、[unit-of-work.ts](../app/backend/src/storage/unit-of-work.ts) | LMDB 是唯一存储适配；业务通过 Repository/UoW，关键写入可在同一事务中完成；没有 SQL/ORM/独立数据库服务。 |
| 前端功能状态 | [App.tsx](../app/frontend/src/App.tsx#L37) | 已有工作台、登录/个人设置和退出；项目与任务、行政审批、文档中心、组织与权限、系统设置菜单当前为 disabled，不能视为已交付。 |

因此，候选评估不能把规划文档中未来模块当作现有实现，也不能把参考系统集成称为“独立组件”。研究时账号停用基础 API 已实现，但当前审批人转交依赖 Workflow 模块，当时尚无可检查的 Workflow repository；M0 尚未通过。后续模块可依用户授权并行开发，但不能假定未落实的 M0 权限、存储与安全保证已经具备。


## 2. 候选架构冲突矩阵

| 候选 | 主要冲突面 | 若作为代码底座的影响 | 决策 |
|---|---|---|---|
| NocoBase | 平台元模型、插件运行时、数据访问及权限模型 | 将本产品从固定业务模型变为可配置低代码平台；引入候选 ORM/数据库兼容和插件生命周期；授权边界复杂 | 不接入运行时/插件；只做高层设计研究。 |
| JeecgBoot | Java/Spring、关系数据库、代码生成、工作流及企业后台底座 | 双运行时、SQL/ORM、额外部署/运维；表、生成代码与本平台业务模型耦合；许可证附加条款待法律确认 | 不作为底座，不抽取生成模块。 |
| Plane | Django/React 产品系统、独立数据存储/worker/缓存部署、AGPL 风险 | 第二身份和数据源；跨系统同步/授权/一致性；引入被禁止的基础设施并影响单进程部署 | 不集成 Plane 服务或前端组件。 |
| Yudao Cloud | Spring Cloud 服务拆分、MyBatis/SQL、缓存和中间件 | 与模块化单体相反，增加网络故障、服务发现、部署编排和数据迁移；MIT 不抵消工程边界 | 不引入其运行时/模块；仅对照能力清单。 |
| ERPNext | Frappe/DocType、MariaDB/Redis/worker、ERPNext GPL-3.0 许可风险（Frappe Framework 另标 MIT） | 需接受第二套元数据驱动应用平台和 ERP 领域；SQL/服务/插件依赖直接违约 | 不集成、不迁移 DocType 或单据。 |

## 3. 复用形态评估

### A. 直接复用独立组件

本轮没有发现经证据确认同时满足“组件边界独立、许可兼容、依赖可审计、可脱离上游运行、与当前技术栈一致、无第二身份/数据源”的组件。因此 A 类为零。五个候选是系统或平台，不应为了减少几周工作把其服务/页面当作可嵌入组件。

### B. 独立设计后自主实现

- 用户权限：角色、权限码、资源 scope 分层；规则仍由本平台业务和安全文档决定。
- 项目任务：同一任务在列表/看板等视图的交互一致性；本平台采用自身固定状态与规则。
- 行政审批：模板版本与实例快照分开，单审批人、状态机、追加历史及单事务写入。
- 文档：owner 保持管理权限、ACL 与版本只追加、FileService 与文档业务元数据分离。
- 客户合同、分析：仅在里程碑批准后先定义本项目指标/领域，再用本地只读查询实现；不抄 ERP/CRM schema。

B 类不得变成隐性代码复制：每项实施须有项目自己的需求、ADR、API/data model、测试与设计来源说明。

### C. 不建议复用

完整产品底座、低代码元模型、工作流/BPMN 引擎、ORM/SQL schema、微服务设施、项目管理完整实体、ERP/CRM 模块、候选 UI 组件/布局/图标/品牌、代码生成器模板及生成输出均归 C 类。依赖一个外部完整系统通过 iframe/API 代理交付功能，也会引入第二身份、权限、安全更新和数据同步边界，不作为“零成本组件复用”。

## 4. 推荐架构路径

1. 用户已授权与 M0 并行开发后续模块；继续补齐 M0 验收报告列出的身份、存储、迁移、CI 和崩溃恢复缺口，并保留 M0 未通过结论及人工签收要求。
2. 每个业务域在既有模块化单体内添加 service/repository/contracts/routes/tests 并独立验证；跨域通过应用服务或只读 query port，不直接访问其他模块 repository。尚未落实的 M0 保证不能视为已具备。
3. 项目、任务、审批、文档的关键跨记录写入使用一个 UoW；文件仍走 FileService 的落盘、事务元数据和补偿协议。
4. 不引入候选系统的数据库/worker/cache；不因参考项目表设计新增租户字段、动态属性引擎或通用表单平台。
5. 只有在需求确实需要某个可分离第三方库时，先通过依赖准入、许可证/SBOM、安全、运行方式和退出方案审查，再由负责人单独批准。

## 5. 未知与停止条件

- 本轮已核验官方仓库页面级分支、提交/发行版信号和主许可证入口；指定 tag 的传递依赖 license、SBOM、商业插件边界和安全响应数据仍未完成，不据此批准任何引入。
- 原请求中的历史项目 `NextWeb4/gw` 审计与当前 `AGENTS.md`“不得检查/复用历史项目”边界冲突。本报告遵守禁止项，只审计当前仓库，不对历史项目技术栈/模块/数据做任何结论。若仍需该项，需要先由负责人明确变更该禁令及访问范围。
- 如果后续需求要求引入 SQL/ORM/独立数据库服务、Docker/多租户、完整参考系统底座，或绕过仍有效的验收及安全约束，应停止并走架构决策/负责人确认，而不是在预研报告中默认批准。

逐功能分类见 [复用矩阵](reuse-matrix.md)，许可证义务见 [license-compliance.md](license-compliance.md)，候选证据与逐仓结论见 [open-source-research.md](open-source-research.md)。
