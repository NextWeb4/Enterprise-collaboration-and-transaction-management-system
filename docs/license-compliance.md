# 开源许可证与知识产权合规

> 日期：2026-11-02  
> 本文是工程风险记录，不是法律意见。实际引入、发行或提供网络服务前，应由法务按固定版本审阅 LICENSE、NOTICE、商标及全部依赖。

## 1. 候选主仓库许可状态

| 项目 | 官方许可证入口 | 当前判断 | 项目决策 |
|---|---|---|---|
| NocoBase | [LICENSE.txt](https://github.com/nocobase/nocobase/blob/main/LICENSE.txt)、[v3 审批插件说明](https://docs.nocobase.com/core/using-plugins/collaboration/approval/) | main 文件（2026-02-24）是自有 License Agreement，叠加 Apache-2.0，并含品牌/知识产权和同类 SaaS/PaaS 限制；v3-develop 当前无该路径，审批插件另标 commercial。 | 不复制代码/运行时；无书面法律批准不引入。 |
| JeecgBoot | [main LICENSE](https://github.com/jeecgboot/JeecgBoot/blob/main/LICENSE)、[springboot2/LICENSE](https://github.com/jeecgboot/JeecgBoot/blob/springboot2/LICENSE) | main 与 springboot2 LICENSE 页面均在 Apache-2.0 正文后附非竞争、品牌/发行方和解释权文字；README 免责声明不能覆盖 LICENSE，仍须固定 commit 并由法务解释。 | 不引入代码/生成器模板；未经法务确认不按纯 Apache-2.0 放行。 |
| Plane | [LICENSE.txt](https://github.com/makeplane/plane/blob/preview/LICENSE.txt) | 官方 preview 文件明确 GNU AGPL v3.0，网络使用触发对应源代码提供义务。 | 项目政策禁止未经例外引入 AGPL 代码；不复制。 |
| Yudao Cloud | [LICENSE](https://github.com/YunaiV/yudao-cloud/blob/master/LICENSE) | 官方仓库 LICENSE 是标准 MIT；仅覆盖仓库作品，不覆盖第三方依赖、子项目或外部资源。 | 即使 MIT 可允许部分复用，当前架构契约仍禁止完整系统底座和模块复制；只做设计研究。 |
| ERPNext | [license.txt](https://github.com/frappe/erpnext/blob/develop/license.txt) | 官方 develop 文件明确 GNU GPL v3.0；[Frappe Framework](https://github.com/frappe/frappe) 官方仓库标示 MIT，但不覆盖 ERPNext app、主题和资源。 | 不引入 GPL 代码、DocType、界面或生成物。 |

本轮已通过只读浏览器读取上述官方页面；GitHub API 凭据不可用，且未完成指定 commit 的 SBOM、传递依赖、目录级例外和商业插件审计。ERPNext 与 Frappe Framework 的许可证边界已明确区分，但不代表依赖链已经获准；候选 tag 的完整许可证审计仍是任何进一步复用的前置条件。

## 2. 第三方依赖许可证

目前**没有**生成候选仓库指定版本的 SBOM，也没有按目录核验其锁文件、NOTICE、图标/字体、容器镜像、插件和可选商业模块。故不能作出“第三方依赖都兼容”的结论。

本轮仓库页面可见的主要依赖清单入口与审计状态如下；“可见”仅表示定位到清单文件，不代表逐项许可证扫描完成：

| 项目 | 官方依赖清单入口 | 当前审计状态 |
|---|---|---|
| NocoBase | [v3 package.json](https://github.com/nocobase/nocobase/blob/v3-develop/package.json)、[pnpm-lock.yaml](https://github.com/nocobase/nocobase/blob/v3-develop/pnpm-lock.yaml) | 未解析 workspace/插件/商业模块依赖，未生成 SBOM。 |
| JeecgBoot | [后端 Maven 模块](https://github.com/jeecgboot/JeecgBoot/tree/springboot2/jeecg-boot)、[Vue3 前端目录](https://github.com/jeecgboot/JeecgBoot/tree/springboot2/jeecgboot-vue3) | 未固定各 Maven/前端子项目的具体版本，未扫描传递依赖、生成器模板和商业模块。 |
| Plane | [preview package.json](https://github.com/makeplane/plane/blob/preview/package.json)、[pnpm-lock.yaml](https://github.com/makeplane/plane/blob/preview/pnpm-lock.yaml)、[apps](https://github.com/makeplane/plane/tree/preview/apps) | 未解析 Python/Node workspace、镜像、字体/图标及 enterprise/commercial 文件，未生成 SBOM。 |
| Yudao Cloud | [pom.xml](https://github.com/YunaiV/yudao-cloud/blob/master/pom.xml)、[yudao-dependencies](https://github.com/YunaiV/yudao-cloud/tree/master/yudao-dependencies)、[yudao-ui 目录](https://github.com/YunaiV/yudao-cloud/tree/master/yudao-ui) | Maven BOM/子模块和包含多个前端项目的 `yudao-ui` 目录均未锁定审计，未扫描传递依赖或外部组件；不能将该目录视为单一前端 lockfile。 |
| ERPNext | [pyproject.toml](https://github.com/frappe/erpnext/blob/develop/pyproject.toml)、[package.json](https://github.com/frappe/erpnext/blob/develop/package.json)、[yarn.lock](https://github.com/frappe/erpnext/blob/develop/yarn.lock) | 未核验 Frappe Framework/bench/其他 apps 与镜像；未生成 Python/Node 依赖 SBOM。 |

候选复核应至少包括：

- 固定 commit/tag、lockfile 和构建选项；直接与传递运行时/开发依赖分开；
- 软件包许可证、版权人、NOTICE、源文件头、子模块/submodule、嵌入资源和镜像；
- 动态/静态链接和前端 bundle 是否把代码交付给用户；
- 服务端修改、网络提供服务和 SaaS/托管场景的源码提供义务；
- 依赖中 GPL/AGPL、SSPL、BUSL/Sustainable Use、自定义限制、无许可证或双许可证组件；
- 输出 SBOM、第三方声明、源码/offer/修改说明义务和法务意见。

仓库自己的 MIT、Apache 或其他主许可证不自动覆盖上述依赖或商标。

## 3. 衍生作品与独立开发边界

许可证义务取决于实际采用的代码、素材、修改方式和分发/服务场景。仅做架构上互通或调用独立服务不必然等于衍生作品；复制/改写代码、生成模板、数据库迁移、特有数据模型、UI 资产或具有实质表达的设计可能形成版权或合同风险。应由法务针对具体事实判断，不以“重写变量名”或“只复制少量”推定安全。

独立开发的工程控制：

1. 先写本项目需求、领域规则和 ADR，依据本项目资料确定实体、字段、状态机和 API；不把候选仓库代码/数据库 schema/UI 作为输入。
2. 参考产品研究仅记录高层功能观察和来源链接；不留存源码片段、截图、图标、文案或候选字段清单作为实施规格。
3. 代码、测试、迁移、UI 和产品文案由项目成员基于已批准需求独立编写；保留作者、提交历史、设计决策与评审记录。
4. 如果曾接触可能相关的受限实现，应记录人员、时间和接触范围；有实质相似疑点时暂停合并并做独立法律审查。
5. 第三方/AI 生成代码必须保留来源和许可证据；未知来源、复制片段和自动生成模板不得直接入库。

独立创作记录可支持事实核查，但不替代法定原创性审查或律师意见。

## 4. 软件著作权申报边界

- 只能将实际独立创作并由本项目掌握权利的源代码作为软件著作权材料；不可把开源项目原始功能、原始源文件或轻度改写包装为本项目原创。
- MIT/Apache 许可即使允许某些使用，也不自动将上游代码变成本项目原创；如未来依法采用，必须保留上游版权/许可证/NOTICE，并清楚区分原始部分、修改部分和独立新增部分。
- GPL/AGPL、自定义限制代码或来源不明的代码不得混入本项目软著材料；上游模块、复制的表结构、生成器模板、UI 资产及翻译文本须排除并经法务判断。
- 申报前保存独立需求、设计/ADR、源码版本、提交记录、作者/雇佣或委托权属、第三方清单和代码来源扫描结果；抽取申报代码段时核实不包含生成文件、依赖/vendor、密钥及第三方代码。
- 软著材料应如实描述本平台实际独立功能，不把“具有类似用户管理/审批/任务管理功能”本身当成独占的原创表达。

## 5. 项目政策与准入

当前工程契约禁止 GPL/AGPL/自定义限制代码、复制参考系统、引入大型依赖、改变架构或未经批准新增依赖。许可证可能允许的行为不等于工程决策已批准。准入前须完成 [依赖与许可证合规流程](05-research/dependency-compliance.md) 并取得负责人及法务确认；本次推荐为零代码复用。
