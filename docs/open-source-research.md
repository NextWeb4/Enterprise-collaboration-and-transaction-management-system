# 开源项目复用可行性研究

> 日期：2026-11-02  
> 状态：预研结论；本轮已读取官方仓库页面和主许可证入口，依赖树、SBOM、商业插件边界仍需在任何代码复用前重新核验。  
> 范围：NocoBase、JeecgBoot、Plane、Yudao Cloud、ERPNext。未克隆候选仓库，未复制代码、数据库 schema、界面资产或文案。

## 1. 结论摘要

这五个项目均不适合作为当前平台的运行底座或大型子系统。它们的技术栈、数据库、进程模型、领域边界或许可证义务与当前已批准架构存在显著冲突。建议当前**不引入候选项目代码或运行依赖**；只在产品设计中抽象通用业务原则，由本项目独立设计、建模和实现。

可借鉴范围限定为 B 类：角色/数据范围的概念分层、项目任务状态流、审批模板与运行实例分离、记录版本与审计、文档 ACL 的决策问题。不能把候选项目的实体字段、表关系、端点、状态文案、页面布局或测试直接转写为本项目产物。

## 2. 调研方法与证据等级

首选资料为各项目官方 GitHub 仓库、仓库许可证文件和官方文档。本轮（2026-11-02）通过只读浏览器读取了官方仓库页面及许可证入口；`cases/state.json`、`kb_router`、`kb_read_file`、`send_http2_request`、`http_probe` 均未在工作区/工具中提供，GitHub API 凭据不可用且通用网页检索返回 503。故不声称已取得 API 级 `pushed_at`、完整 issue 响应统计或传递依赖清单。仓库页面上的分支、最近提交/发行版和许可证摘要只作为本轮采集时点证据，采用前仍须固定 commit 并复核。

结论标记：

- **已知架构特征**：基于项目官方公开材料的稳定定位和本仓库已有研究记录；代码级版本差异仍需检查指定 commit。
- **待核验**：依赖/插件/镜像许可证、完整 SBOM、商业边界和安全响应数据应在实际候选 commit、官方文档、LICENSE/NOTICE 和锁文件中核对后才能作为准入依据。
- **不采用**：本平台架构/项目政策禁止，或法律义务/耦合成本不接受。

未读取或检查 `NextWeb4/gw` 或其他历史项目；没有对照其代码、数据库或 UI。当前工程审计仅限本仓库，并以 [系统架构](03-technical/system-architecture.md)、[数据存储设计](03-technical/data-storage-design.md)、[M0 验收报告](04-development/M0-acceptance-report.md) 为依据。

## 3. 候选项目

### 3.1 NocoBase

- 官方材料：[GitHub 仓库](https://github.com/nocobase/nocobase)、[v3-develop 根目录](https://github.com/nocobase/nocobase/tree/v3-develop)、[main LICENSE.txt](https://github.com/nocobase/nocobase/blob/main/LICENSE.txt)、[官方文档](https://docs.nocobase.com/)。本轮（2026-11-02）页面显示 `v3-develop` 为 NocoBase 3，最新提交 [242a683](https://github.com/nocobase/nocobase/commit/242a683f138427cda304aca64bd4c9290da46ae9)，仓库标示约 1,225 commits；该分支当前没有 `LICENSE.txt`，因此不能把 `main` 的协议自动外推到 v3。
- **源码/接口证据**：[v3 README](https://github.com/nocobase/nocobase/blob/v3-develop/README.md)、[v3 package.json](https://github.com/nocobase/nocobase/blob/v3-develop/package.json)、[v3 docs](https://github.com/nocobase/nocobase/tree/v3-develop/docs)、[Core API reference](https://docs.nocobase.com/core/reference/api/)、[插件定义 API](https://docs.nocobase.com/core/using-plugins/development/client)、[审批（商业插件）](https://docs.nocobase.com/core/using-plugins/collaboration/approval/)。在线文档注明 v3 package 仍处 beta，API/界面可能变化。
- **技术栈/架构**：Node.js/TypeScript 服务端、React client，以数据模型、应用运行时和插件构成的平台型架构；Core API reference 明示 `defineClientPlugin`、`defineServerPlugin`、`defineApiRoutes` 等扩展入口。v3 官方 README 要求 Node.js 24+、pnpm 11，Quick Start 使用 SQLite；数据库适配器、商业插件和构建工具仍须按固定 tag 核实。
- **功能/数据模型**：通用集合、字段、关系、视图/区块、用户权限和工作流等可配置能力。它的数据模型是可配置平台元模型，不等同于本平台的项目、任务、审批申请和文档领域实体。
- **API/扩展**：官方 v3 文档将 Core 定义为可扩展应用基础，并明确所有 v3 package 仍处 beta、API/界面可能变化；不可将 v2 插件 API 假定为 v3 的稳定扩展契约。审批页面将 `@nocobase/app-plugin-approval` 标为 **commercial**，且说明应用仍需自行提供业务 collections、生命周期、存储、权限、API、页面和任务；因此它不是可脱离平台的独立审批组件。当前可确认的扩展/插件兼容边界须以固定 v3 文档和 package 为准。
- **活动度**：本轮 `v3-develop` 页面显示约 1,225 commits、最新提交 `242a683`；main 页面显示 854 releases、最新 release [v2.2.37](https://github.com/nocobase/nocobase/releases/tag/v2.2.37)。这些是页面采集信号，不替代固定版本的维护/安全审查。
- **许可证**：`main/LICENSE.txt`（2026-02-24 更新）是 NocoBase License Agreement，明确叠加 Apache-2.0，并限制移除品牌/知识产权信息及向公众提供同类 no-code/low-code/AI SaaS/PaaS。`v3-develop` 没有该路径，v3 许可证必须单独取得并留档。
- **依赖许可证**：未审计该 tag 的 lockfile、插件和运行时依赖许可证。不得将“主仓库许可证”当作所有依赖的许可证。
- **二开难度/适配**：高。作为完整运行时会引入可配置元模型、插件运行时和其数据访问/部署假设，与本项目严格领域模型、LMDB Repository/UoW 及禁止复制参考系统代码的边界冲突。
- **建议**：不复用代码/底座。只可借鉴“模型、权限与呈现分层”的问题意识，不复制元模型、插件 API 或屏幕布局。

### 3.2 JeecgBoot

- 官方材料：[GitHub 仓库 main](https://github.com/jeecgboot/JeecgBoot)、[main LICENSE](https://github.com/jeecgboot/JeecgBoot/blob/main/LICENSE)、[springboot2 分支](https://github.com/jeecgboot/JeecgBoot/tree/springboot2)、[官方文档](https://help.jeecg.com/)。本轮 main 页面显示最新 release `v3.9.5`（2026-08-27）；采用前仍需固定 commit、分支和商业模块边界。
- **源码/接口证据**：[main README](https://github.com/jeecgboot/JeecgBoot/blob/main/README.md)、[springboot2 README](https://github.com/jeecgboot/JeecgBoot/blob/springboot2/README.md)、[后端模块](https://github.com/jeecgboot/JeecgBoot/tree/main/jeecg-boot)、[Vue3 前端](https://github.com/jeecgboot/JeecgBoot/tree/main/jeecgboot-vue3)、[文档中心](https://help.jeecg.com/)。`springboot2` README 明示 v3.8.3 为最终版本、后续不再维护；README 与文档门户的 Spring Boot 版本描述有漂移，应按锁定 tag 的 manifests 判定。
- **技术栈/架构**：main README 描述 Spring Boot 4.1、Spring Cloud Alibaba 2025.1、MyBatis-Plus 3.5.16、Vue 3、TypeScript、Vite 8、Ant Design Vue 4；`springboot2` 分支 README 描述 Boot 2.7/3.5、Vite 6 线且已结束维护。官方帮助站首页仍写 Spring Boot 2.x/3、Vue3+TypeScript+Vite6+Ant Design Vue4，构成可见的版本/分支漂移。代码布局含 `jeecg-boot` 与 `jeecgboot-vue3`；具体版本以拟采用分支的 Maven/package 清单为准。
- **功能/数据模型**：用户、角色、部门、字典、日志、表单/代码生成、报表、工作流等后台平台能力；通常围绕关系型持久化、配置元数据和业务表组织。实际表结构、租户字段和迁移必须以指定 commit 源码为准，本报告不复用或转写。
- **API/扩展**：官方 README 宣称前后端代码生成、Swagger 接口文档和单体/微服务切换；扩展主要表现为 Spring 模块/starter、Online 表单和代码生成工作流，不能据此视为与 Spring/数据模型解耦的独立插件 SDK。生成器输出也可能携带模板及依赖许可义务，不能视为无来源的原创代码。
- **活动度**：本轮 main 页面显示最新提交 [a4d5234](https://github.com/jeecgboot/JeecgBoot/commit/a4d5234)、约 2,409 commits，最新 release [v3.9.5](https://github.com/jeecgboot/JeecgBoot/releases/tag/v3.9.5)（2026-08-27）；`springboot2` 分支页面显示约 1,856 commits、最新提交 [74d8045](https://github.com/jeecgboot/JeecgBoot/commit/74d8045)（2025-11-28），且 README 明示不再维护。不以 README 的能力描述替代安全和维护审查。
- **许可证**：`main/LICENSE`（[竞争性限制条款](https://github.com/jeecgboot/JeecgBoot/blob/main/LICENSE#L203)）与 `springboot2/LICENSE`（[对应条款](https://github.com/jeecgboot/JeecgBoot/blob/springboot2/LICENSE#L213)）页面均在 Apache-2.0 正文后加入不得开发竞争软件、品牌/发行方和解释权文字；README 中的社区倡议或免责声明不能覆盖 LICENSE。两个分支均须固定 commit 并由法务解释，不能按纯 Apache-2.0 直接放行。
- **依赖许可证**：Java/Vue 工作区依赖、Flowable、图表/报表、代码生成器和商业插件均未按版本审计；需 SBOM、NOTICE、传递依赖清单及商业模块边界。
- **二开难度/适配**：很高。Java/关系数据库/工作流和低代码平台架构与单 Node/Fastify 进程、React SPA、LMDB JSON 文档的目标不一致；提取单个模块也需跨服务、权限、表结构和生成器耦合审查。
- **建议**：不复用代码、模板、生成器输出或 schema。可独立研究“组织/RBAC/数据范围”表达和审批表单与流程状态解耦的概念。

### 3.3 Plane

- 官方材料：[GitHub 仓库](https://github.com/makeplane/plane)、[preview LICENSE.txt](https://github.com/makeplane/plane/blob/preview/LICENSE.txt)、[官方文档](https://docs.plane.so/)。本轮页面显示 `preview` 最新提交信号为 2026-10-29；采用前固定 tag 并核对组件例外。
- **源码/接口证据**：[preview README](https://github.com/makeplane/plane/blob/preview/README.md)、[apps](https://github.com/makeplane/plane/tree/preview/apps)、[deployments](https://github.com/makeplane/plane/tree/preview/deployments)、[官方开发/产品文档](https://docs.plane.so/)。在线文档列出 API、集成、MCP、Pages、审批和 Analytics。
- **技术栈/架构**：Python/Django 服务端与 React/TypeScript 前端，面向自托管部署的多服务项目；具体 tag 的 API、worker、数据库和缓存依赖须由 compose/lockfile 核实。
- **功能/数据模型**：workspace、project、issue/work item、cycle、module、view、page 等项目协作对象。此模型围绕产品型项目跟踪，不是本平台规定的轻量项目/任务实体。
- **API/扩展**：官方开发者文档列出 API、自定义集成及 MCP/agent 扩展；API/集成可用于外部系统互通，但没有据此确认可嵌入本项目的独立组件 SDK。官方文档还覆盖客户、Analytics、Pages 等产品模块；本轮未把“审批”作为已核验的独立官方模块依据。
- **活动度**：本轮 `preview` 页面显示最新提交 [b98e1de](https://github.com/makeplane/plane/commit/b98e1de)，日期为 2026-10-29；仓库显示 7,306 commits，并包含 `docker-compose*.yml`、`pnpm-lock.yaml` 和多应用结构，仍需固定版本审查维护与安全记录。
- **许可证**：官方 `preview/LICENSE.txt` 明确为 GNU AGPL v3.0，并包含网络使用时提供对应源代码的义务；目录级例外、enterprise/commercial 文件和第三方资源仍需逐一核对。未经书面例外不引入 AGPL 代码。
- **依赖许可证**：前后端及部署栈均未审计；容器镜像、前端 bundle、Python/Node 传递依赖、图标和字体可能具有不同许可，必须单独清点。
- **二开难度/适配**：高。完整部署带来额外服务/基础设施和另一套领域模型；只做 API 集成也会造成第二套身份、权限和数据源，违反本项目模块化单体边界。
- **建议**：不复用代码/数据库/UI。可借鉴 issue 详情的属性分组、列表与看板对同一工作项的多视图这一抽象，但需独立设计固定范围的本项目任务交互。

### 3.4 Yudao Cloud

- 官方材料：[GitHub 仓库](https://github.com/YunaiV/yudao-cloud)、[LICENSE](https://github.com/YunaiV/yudao-cloud/blob/master/LICENSE)、[云原生文档](https://cloud.iocoder.cn/)。不同仓库/版本、商业增强包和前端子项目应分别固定和核验；旧的 `doc.iocoder.cn` 门户本轮标题为 `ruoyi-vue-pro`，不作为 yudao-cloud 分支规范的唯一来源。
- **源码/接口证据**：[README](https://github.com/YunaiV/yudao-cloud/blob/master/README.md)、[Maven 根配置](https://github.com/YunaiV/yudao-cloud/blob/master/pom.xml)、[系统模块](https://github.com/YunaiV/yudao-cloud/tree/master/yudao-module-system)、[BPM 模块](https://github.com/YunaiV/yudao-cloud/tree/master/yudao-module-bpm)、[cloud quick-start](https://cloud.iocoder.cn/quick-start/)。采用前应先匹配产品/分支再采用 API 说明。
- **技术栈/架构**：官方 README/pom.xml 的 master 线为 JDK8/Spring Boot 2.7，并列出 Spring Cloud Alibaba、Nacos、Gateway、Sentinel、Seata、MyBatis-Plus、Redis/Redisson、RocketMQ 等服务与中间件；JDK17/21 + Boot 3.5、JDK25 + Boot 4.x 是其他分支或发行变体，不能混写为 master 的单一栈。
- **功能/数据模型**：覆盖系统/RBAC、工作流及 CRM/ERP 等多业务域。基础 RBAC 与流程数据通常面向关系型数据库和服务模块；本研究不引用其表定义作为本项目模型。
- **API/扩展**：README 展示 Spring 模块拆分、代码生成和多个独立业务模块；具体 REST/OpenAPI 契约、模块间 API 和代码生成模板需按对应分支源码核验，未确认存在可独立分发的插件 ABI。
- **活动度**：本轮 master 页面显示最新提交 [5eede7c](https://github.com/YunaiV/yudao-cloud/commit/5eede7c)、2,978 commits；发行页列出 [v2026.10 的 JDK8/11、JDK17/21、JDK25 变体](https://github.com/YunaiV/yudao-cloud/releases)，并列出 JDK8/17/25 分支。发行变体不能反推 master 的技术栈；这些仅是活跃度信号，不替代固定版本审查。
- **许可证**：官方 `LICENSE` 是标准 MIT（版权和许可文本保留条件）。该结论只适用于该仓库文件，不覆盖第三方依赖、子项目或外部商业资源。
- **依赖许可证**：未审计 BOM/锁文件及第三方服务组件。MIT 主许可证不覆盖其依赖，也不自动解决组件 NOTICE、商标或商业扩展许可。
- **二开难度/适配**：高。即使 MIT 在法律上可能允许复用，完整模块仍会带入 Java 服务、SQL、缓存/中间件、迁移和运维架构；项目政策明确不以其模块为底座。
- **建议**：不复用代码/模块/schema。只可借鉴模块边界、角色与权限能力清单，以及流程模板与运行中实例分离的设计问题。

### 3.5 ERPNext

- 官方材料：[GitHub 仓库](https://github.com/frappe/erpnext)、[license.txt](https://github.com/frappe/erpnext/blob/develop/license.txt)、[官方文档](https://docs.frappe.io/erpnext)。应固定 ERPNext 与 Frappe Framework 的兼容版本并分别阅读许可文件。
- **源码/接口证据**：[README](https://github.com/frappe/erpnext/blob/develop/README.md)、[ERPNext app tree](https://github.com/frappe/erpnext/tree/develop/erpnext)、[pyproject.toml](https://github.com/frappe/erpnext/blob/develop/pyproject.toml)、[package.json](https://github.com/frappe/erpnext/blob/develop/package.json)、[ERPNext 文档](https://docs.frappe.io/erpnext/introduction)。文档导航明确列出 Data Model、Customization、Integrations；Frappe Framework 许可证与 API 文档需另行审查。
- **技术栈/架构**：Python/Frappe 框架，采用 DocType 元数据、后台任务与应用生态；ERPNext README/官方安装资料显示部署通常依赖 MariaDB、Redis、Bench/worker 等组件。Frappe Framework 自身官方仓库页面标示 MIT，但 ERPNext 应用仓库本身为 GPL-3.0；两者必须分开核验，不能用框架许可证覆盖 ERPNext 代码。
- **功能/数据模型**：ERP、财务、采购、库存、制造、人力、CRM 等 DocType 和单据工作流。其通用元数据模型与单据语义远超本平台范围，不能复制为本项目文档或审批模型。
- **API/扩展**：官方 ERPNext 文档目录包含 Data Model、Customization、Integrations；[Frappe Framework REST API 文档](https://docs.frappe.io/framework/user/en/api/rest)说明 REST API 由框架提供。Hooks、自定义 app/DocType 是 Frappe 扩展方式，依赖框架生命周期与数据库/后台任务，不能作为本项目内部独立组件直接接入。
- **活动度**：本轮 develop 页面显示最新提交 [c1ebcdb](https://github.com/frappe/erpnext/commit/c1ebcdb)、65,811 commits；发布页同时显示 [v16.53.0](https://github.com/frappe/erpnext/releases/tag/v16.53.0) 与 [v15.124.3](https://github.com/frappe/erpnext/releases/tag/v15.124.3) 两条版本线（GitHub Latest 标签可能仍指向 v15）。仓库也提供 SECURITY、TRADEMARK_POLICY 和 attributions 文件，仍需与 Frappe Framework 版本矩阵一并审查。
- **许可证**：官方 `license.txt` 明确为 GNU GPL v3.0。Frappe Framework、主题、图标和依赖必须分别审查；未经法律批准不纳入 GPL 代码。
- **依赖许可证**：未核验 Python/Node 锁文件、前端资源、Frappe app 和部署组件；GPL 本身不能代替对组合分发、网络服务、NOTICE 与第三方资源的分析。
- **二开难度/适配**：很高。需要接受 Frappe 应用生命周期、DocType 和 SQL/服务依赖，与本项目 Node/LMDB/单进程架构直接冲突。
- **建议**：不复用代码、DocType、单据 schema 或 UI。审批状态、审计只追加和权限联动仅作为抽象设计检查项。

## 4. 活动度与依赖审计待办

在提出任何复用/采购决定前，对每个候选固定同一个具体 tag/commit，并保存：

1. GitHub repository API 的 `pushed_at`、`archived`、默认分支、最近 release、近 12 个月提交和安全公告；记录采集时间与 URL。
2. 该 commit 的 LICENSE、NOTICE、子目录许可证、商标政策和商业版边界。
3. lockfile/构建清单生成的完整 SBOM；分别标注运行时、构建时、嵌入式二进制、字体/图标、容器镜像及插件依赖。
4. 每个许可证的义务、修改文件、分发方式、网络提供服务场景、源码提供/NOTICE/署名/商标要求，由法务确认。

本轮已取得仓库页面级活动度和主许可证证据，但没有生成指定 commit 的 SBOM，也没有完成传递依赖、商业插件和安全响应审计；这些仍是**待验证**，不得据此批准代码引入。

## 5. 推荐方案

- 不采用完整候选项目作为底座，不建立第二套身份/权限或业务数据源。
- 继续沿用本项目已批准的 React 19/TypeScript/Vite/Ant Design 与 Node 24/Fastify 5/Zod/LMDB JSON + Repository/UoW 架构。
- A 类独立可直接复用组件：**当前没有**。候选产品不是可移植且许可已清点的独立组件包。
- B 类设计启发：权限分层、项目与任务同实体多视图、审批模板/实例分离、文档 ACL/版本与审计等，由本项目自行建模、写需求、实现和测试。
- C 类不建议复用：低代码/元数据运行时、工作流引擎、CRM/ERP 全模块、项目系统整套服务、数据库表和 UI/源码/生成器输出。

完整功能分类见 [复用矩阵](reuse-matrix.md)，法律边界见 [许可证合规](license-compliance.md)，工程冲突与推荐路线见 [架构影响](architecture-impact.md)。
