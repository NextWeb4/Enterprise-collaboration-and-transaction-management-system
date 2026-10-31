# 参考产品研究

> 文档状态：Draft for Review  
> 版本：0.1.0  
> 日期：2026-10-31  
> 方法：阅读公开 README、产品文档与许可证；**未克隆/未复用任何项目代码**。  
> 结论：所有参考仅用于产品信息架构、业务流程、交互原则与数据建模思路；本项目独立设计、独立实现。

## 1. 研究边界

### 1.1 允许

- 阅读公开 README、文档、截图、许可证；
- 提炼信息架构、业务流程、交互原则、数据建模思路；
- 对比功能范围与取舍；
- 记录可借鉴点与明确不借鉴点。

### 1.2 禁止

- 克隆/复制业务代码、数据库 schema、迁移脚本、UI 资产；
- 把完整系统作为底座二次开发；
- 复制 AGPL/GPL/自定义限制许可证的代码；
- 复制商标、Logo、文案、截图用于产品；
- 用“参考”为名绕过许可证。

### 1.3 许可证提醒

许可证可能随版本变化；下表为 2026-10-31 查阅结果，**任何实际复用前必须重新核验**。本项目不使用下列完整系统的代码。

## 2. 六个给定 GitHub 项目

### 2.1 JeecgBoot

- 仓库：https://github.com/jeecgboot/JeecgBoot
- 定位：企业级 AI 低代码平台；Spring Boot + Vue3；代码生成、Online 表单、报表、Flowable 工作流、RBAC/数据权限、多租户。
- 许可证：**Apache-2.0 + 补充条款**（禁止开发“可能与本软件竞争”的软件；保留品牌/版权声明）。这不是纯 Apache-2.0，属于自定义限制。
- 可借鉴：
  - 企业中后台的模块清单与“基础能力”完整度（用户/角色/部门/岗位/字典/日志/消息）。
  - RBAC + 数据权限的分层表达。
  - 审批与业务表单分离的思路。
- 不借鉴：
  - 代码生成/Online 表单/低代码平台底座；
  - Flowable/BPMN 全家桶；
  - 微服务/多中间件架构；
  - 大量菜单与“功能堆叠”式信息架构。
- 结论：作为**能力清单与权限模型参考**，不作为底座、不复制代码/表结构/UI。

### 2.2 NocoBase

- 仓库：https://github.com/nocobase/nocobase
- 定位：开源 AI + 无代码平台；数据模型驱动、插件化微内核、可视化配置、权限与工作流。
- 许可证：**NocoBase License Agreement**（以 Apache-2.0 为基础 + 补充条款，2026-02-24 更新）；限制去除品牌、将软件用于对外提供同类无代码/低代码 SaaS/PaaS 等。
- 可借鉴：
  - 数据模型与 UI 解耦；
  - 插件化边界与权限控制；
  - “业务对象/字段/视图”的可配置思路（仅作为设计启发）。
- 不借鉴：
  - 通用对象建模/无代码配置引擎；
  - 插件市场/微内核运行时；
  - 通过配置生成页面的产品路线。
- 结论：参考“模型与界面分离、权限先行”，**不做通用低代码平台**；不复制代码/配置/界面。

### 2.3 Yudao Cloud（芋道）

- 仓库：https://github.com/YunaiV/yudao-cloud
- 定位：Spring Cloud Alibaba + MyBatis Plus + Vue 的后台管理系统，覆盖 RBAC、多租户、数据权限、工作流、支付、商城、CRM、ERP、MES、IM、AI 等大量模块。
- 许可证：**MIT**。
- 可借鉴：
  - 模块化后台的领域划分与权限/数据范围设计；
  - 工作流与业务表单分离；
  - 多租户字段与组织隔离的工程经验。
- 不借鉴：
  - Spring Cloud 微服务全家桶；
  - 大量业务模块（商城/ERP/MES/IM/AI）；
  - 任何代码/表结构/前端模板。
- 结论：MIT 允许复用，但**本项目仍不复用**，避免继承其复杂模块与架构；仅参考权限/工作流思路。

### 2.4 Plane

- 仓库：https://github.com/makeplane/plane
- 定位：现代项目管理平台；Work Items、Cycles、Modules、Views、Pages、Analytics。
- 许可证：**AGPL-3.0**。
- 可借鉴：
  - 项目/工作项/视图/周期的信息架构；
  - 工作项详情的专注布局与属性组织；
  - 看板/列表/筛选的交互一致性；
  - “项目内角色 + 工作项状态”的简洁模型。
- 不借鉴：
  - 代码、数据库结构、前端组件/样式；
  - Cycles/Modules/Pages 全量复制；
  - 复杂自定义视图/属性系统。
- 结论：**AGPL 代码不可进入本项目**；只参考交互与 IA，自主设计。

### 2.5 ERPNext

- 仓库：https://github.com/frappe/erpnext
- 定位：开源 ERP；Frappe 框架、DocType 元数据、财务/供应链/制造/HR 等。
- 许可证：**GPL-3.0**。
- 可借鉴：
  - DocType 的“元数据 + 权限 + 工作流”统一建模；
  - 单据状态与审批/权限的绑定；
  - 模块化但单体的部署思路。
- 不借鉴：
  - 任何 GPL 代码/表结构；
  - ERP 的财务/库存/制造模型；
  - 通过元数据配置一切业务的路线。
- 结论：GPL 代码不可用于闭源/专有分发；**不作为底座**，只参考“单据-状态-权限-审计”的建模。

### 2.6 Dolibarr

- 仓库：https://github.com/Dolibarr/Dolibarr
- 定位：PHP ERP/CRM；模块可开关；联系人、发票、订单、库存、项目、HR、日历、文档等。
- 许可证：**GPL-3.0-or-later**。
- 可借鉴：
  - 模块化开关与轻量部署；
  - 小型组织的“够用即可”功能取舍；
  - 项目/任务/HR/文档的基础信息架构。
- 不借鉴：
  - PHP 代码/数据库；
  - 大量 ERP/财务模块；
  - 传统后台的视觉/交互。
- 结论：参考“轻量、模块可选”，不复用代码。

## 3. 设计参考产品

| 产品 | 类型/许可 | 研究点 | 借鉴 | 不借鉴 |
|---|---|---|---|---|
| Linear | 专有 SaaS | 任务/项目/收件箱、键盘优先、极快交互 | 命令菜单、快捷操作、任务详情的专注感、状态/优先级表达 | 视觉/图标/文案/快捷键体系/专有交互资产 |
| AppFlowy | AGPL-3.0 | 文档、数据库、看板、本地优先 | 文档与块的内容组织、分类/视图思路 | 代码、块编辑器、本地优先/协同编辑 |
| n8n | Sustainable Use License（非 OSI） | 节点式工作流编排 | 流程节点的可视化表达、错误/重试提示 | 代码、节点编辑器、通用自动化平台 |
| Twenty | AGPL-3.0 + 商业文件/MIT 包 | 对象/记录/视图、CRM | 对象元数据与记录视图的分层思路 | 代码、通用对象建模、商业版功能 |
| Plane | AGPL-3.0 | 项目/工作项/视图 | 信息架构、看板/列表一致性 | 代码/表结构/UI 资产 |

> 许可说明：Linear 为专有产品；n8n 为 source-available 的 Sustainable Use License，不是 OSI 开源；Twenty 为 AGPL + 商业文件混合。均不复制代码。

## 4. 借鉴矩阵

| 维度 | 参考 | 本项目决策 |
|---|---|---|
| 工作台 | Linear Inbox、Plane Home | 统一工作台：待办/审批/通知/最近项目/概览；模块按权限组合 |
| 项目 IA | Plane | 项目列表 + 项目详情（概览/任务/看板/成员/设置）；不做 Cycles/Modules |
| 任务详情 | Linear | 标题/描述/状态/负责人/优先级/日期/进度/评论；单栏专注 |
| 看板 | Plane | 固定四列；拖拽改状态/排序；不做自定义列 |
| 审批 | Jeecg/Yudao/ERPNext | 模板版本 + 实例 + 步骤 + 追加记录；顺序单审批人 |
| 权限 | Jeecg/Yudao/NocoBase | RBAC + data_scope + 项目角色 + 文档 ACL；默认拒绝 |
| 数据建模 | NocoBase/Twenty/ERPNext | 关系模型 + 受控 JSONB 表单；不做通用对象平台 |
| 文档 | AppFlowy/Plane Pages | 文件/分类/标签/ACL/版本；不做块编辑器/协同编辑 |
| 自动化 | n8n | 首版不做通用工作流编排；只做审批状态机 |
| 部署 | Dolibarr/Plane self-host | 本机 Node + 本地数据目录；无 Docker/数据库服务 |
| 交互 | Linear/Plane | 快速创建、清晰状态、少弹窗；不复制视觉 |

## 5. 功能覆盖对比

| 能力 | JeecgBoot | NocoBase | Yudao | Plane | ERPNext | Dolibarr | 本项目 R1 |
|---|---|---|---|---|---|---|---|
| 项目管理 | 部分/插件 | 可配置 | 有 | 强 | 有 | 有 | 强（轻量） |
| 任务/看板 | 部分 | 可配置 | 有 | 强 | 有 | 有 | 强 |
| OA 审批 | 强（Flowable） | 可配置 | 强 | 弱 | 强 | 有 | 中（顺序） |
| 组织/RBAC | 强 | 强 | 强 | 中 | 强 | 强 | 强 |
| 文档 | 有 | 有 | 有 | Pages | 有 | 有 | 最小闭环 |
| 低代码 | 强 | 强 | 部分 | 无 | 元数据 | 模块 | **无** |
| 多租户 | 有 | 有 | 有 | 有 | 多公司 | 插件 | 单组织（不设计多租户） |
| 技术栈 | Java/Vue | Node/TS | Java/Vue | React/Django | Python | PHP | React/Node + LMDB |
| 许可证 | Apache+限制 | 自定义 | MIT | AGPL | GPL | GPL | 待定 |
| 作为底座 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — |

## 6. 本项目差异化

1. **项目 + OA 一体**：任务与审批互相回链，而不是两个系统。
2. **统一工作日视图**：待办、待审批、通知、最近项目、概览在一页。
3. **轻量治理**：RBAC + 数据范围 + 项目角色 + 文档 ACL，但界面不做“权限迷宫”。
4. **确定性审批**：顺序单审批人、模板版本快照、历史不可篡改；不引入 BPMN 复杂度。
5. **中文优先、自托管、低运维**：单机 Compose，适合 20–500 人组织。
6. **明确不做低代码/ERP/AI 堆料**：把闭环做稳。

## 7. 明确不复制清单

- 不复制任何项目的源代码、数据库 schema、迁移、测试、UI 组件、图标、截图、文案。
- 不采用其菜单结构作为“标准答案”；本项目 IA 由工作台/项目/OA/组织/系统五层自主设计。
- 不引入 Cycles/Modules/Pages/低代码/对象建模等非 R1 概念。
- 不使用 AGPL/GPL 代码；不使用 NocoBase/Jeecg 的自定义限制代码。
- 不把参考产品的商标/品牌用于本项目命名、域名、宣传。

## 8. 研究结论

1. 成熟产品的共同点是**信息架构稳定、状态清晰、操作路径短**，而不是功能数量。
2. 项目管理与 OA 的交叉点是“事项 + 人 + 状态 + 历史”；本项目用统一工作台连接两者。
3. 权限必须分层：系统角色、组织关系、项目角色、文档 ACL；单一 RBAC 不够，通用 ACL 又过重。
4. 审批不需要 BPMN 才能解决 80% 场景；顺序单审批人 + 版本快照 + 审计足够 R1。
5. 参考产品的代码/许可证风险高于设计借鉴价值；本项目坚持独立实现。

## 9. 来源

- JeecgBoot：https://github.com/jeecgboot/JeecgBoot ，LICENSE：https://github.com/jeecgboot/JeecgBoot/blob/master/LICENSE
- NocoBase：https://github.com/nocobase/nocobase ，LICENSE：https://github.com/nocobase/nocobase/blob/main/LICENSE.txt
- Yudao Cloud：https://github.com/YunaiV/yudao-cloud ，LICENSE：https://github.com/YunaiV/yudao-cloud/blob/master/LICENSE
- Plane：https://github.com/makeplane/plane ，LICENSE：https://github.com/makeplane/plane/blob/master/LICENSE.txt
- ERPNext：https://github.com/frappe/erpnext ，LICENSE：https://github.com/frappe/erpnext/blob/develop/license.txt
- Dolibarr：https://github.com/Dolibarr/Dolibarr ，LICENSE：https://github.com/Dolibarr/Dolibarr/blob/develop/COPYING
- Linear：https://linear.app/
- AppFlowy：https://github.com/AppFlowy-IO/AppFlowy ，LICENSE：https://github.com/AppFlowy-IO/AppFlowy/blob/main/LICENSE
- n8n：https://github.com/n8n-io/n8n ，LICENSE：https://github.com/n8n-io/n8n/blob/master/LICENSE.md
- Twenty：https://github.com/twentyhq/twenty ，LICENSE：https://github.com/twentyhq/twenty/blob/main/LICENSE




