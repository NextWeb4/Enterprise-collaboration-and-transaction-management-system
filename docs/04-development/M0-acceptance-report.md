# M0 验收报告

> 日期：2026-11-02  
> 结论：**未通过；用户于 2026-11-02 授权并行开发后续模块**  
> 验收代码：当前工作区已完成根目录 pnpm/编译/测试复验；未使用或迁移任何既有业务数据。

## 总结

已完成并验证 pnpm workspace、基础存储/身份骨架、迁移入口保护、生产构建运行路径，以及登录/改密/个人设置/窄屏浏览器闭环。账号停用基础闭环已落地，并由真实 LMDB/Fastify 集成测试覆盖权限、CSRF、版本冲突、会话撤销、审计、自停用、最后管理员及并发保护；当前审批人转交校验仍待 Workflow 模块。2026-11-02 当前工作区 `typecheck`、`lint`、`test:coverage` 与 production build 均通过；测试数量和覆盖率以本轮命令输出为准。新增真实 LMDB 改密事务回归，验证旧上下文面对撤销/删除/改绑/过期会话和停用/删除用户均被拒绝；正常改密保留当前会话、撤销其他会话并追加可验证审计。FileService 集成用例覆盖中断/截断、魔数拒绝、事务失败补偿、寻址碰撞与恢复、损坏对账、路径校验、临时上传隔离、文件名净化、重复引用、最终释放及超出范围扫描上限时的启动 fail-closed。既有浏览器 smoke、隔离启动与三轮强杀恢复证据仍见下表；它们使用专用隔离数据，不代表真实业务数据验收。

M0 仍**不能签收**：冻结安装和基础工程检查已有通过证据；exFAT 上旧配置 `EISDIR`、历史 `EPERM` 和 PnP 映射错误仍仅作诊断记录。三轮确定性强杀覆盖 LMDB 提交一致性，长时压力与完整文档业务恢复路径仍未验证。2026-11-03 增加了隔离真实 LMDB CLI 对账：`storage:verify` 以活动 `document_versions` 和活动 `application_attachments` 为独立事实源比对 `files.refCount`；引用漂移时 `storage:rebuild-indexes` 拒绝执行，不修复计数或索引。稳定游标分页及超过 200,000 条安全扫描上限时的可恢复全量维护仍未实现。审计旧格式/schema 转换迁移、`dataScope` 执行、账号完整生命周期（启用/重置/强制下线及离职依赖）、Workflow 当前审批人转交校验仍未完成或验证。账号停用基础闭环已有实现和专项证据，但不满足完整生命周期退出条件。CI workflow 已配置但尚无 hosted runner 结果。策略/service 专项覆盖率门槛也尚未配置。

## 验收证据

> 本轮根目录复验（2026-11-02）：API coverage：75/75；前端 coverage：10/10。API statements/branches/functions/lines 83.95%/74.26%/85.91%/87.30%，前端 82.41%/63.63%/77.41%/80.59%。FileService 同四项覆盖为 90.87%/86.41%/83.78%/98.96%。当前 `typecheck`、`lint`、`build` 亦通过；冻结离线安装证据及保留的旧依赖树见 2026-11-01 历史记录。

> 当前安装证据以本报告本轮根目录复验段为准。下方早期失败记录仅用于追踪旧 workspace-link 配置，不代表当前 injected 配置。

| 项目 | 状态 | 证据 |
|---|---|---|
| pnpm workspace / injected 配置安装复验（2026-11-01） | **通过（正式根目录与干净 E: exFAT 副本）** | 正式根目录在保留原依赖树备份后使用当时锁文件完成冻结离线安装 403/403，并完成当时 typecheck、lint、API 28/28、前端 10/10 与 build；`E:\Codex\1a-m0-final-injected-2026-11-01` 亦完成同样安装检查，`node_modules/@collab/shared` 为普通目录。此行是安装/环境历史证据，不代表当前测试数。 |
| pnpm workspace / 旧配置历史记录 | **历史失败，不代表当前配置** | 旧 `link:../shared` 配置在 E: 隔离副本创建 workspace symlink 时返回 `EISDIR`；PnP 冻结安装在 E:/D: 隔离探针也曾因内部映射错误失败。当前 injected 配置的根目录和干净 E: 副本均已通过冻结安装，见上一行。 |
| TypeScript | **通过（当前工作区，2026-11-02）** | 当前 `pnpm run typecheck` 退出码 0；2026-11-01 干净 E: injected 副本另有当日复验。 |
| Lint | **通过（当前工作区，2026-11-02）** | 当前 `pnpm run lint` 退出码 0；2026-11-01 干净 E: injected 副本另有当日复验。 |
| 自动化测试 | **通过（当前工作区）** | 2026-11-02 当前工作区 coverage：API 8 files/75 tests、前端 2 files/10 tests，共 85 项通过。API statements/branches/functions/lines 83.95%/74.26%/85.91%/87.30%，前端 82.41%/63.63%/77.41%/80.59%；全局门槛通过。FileService 四项 90.87%/86.41%/83.78%/98.96%。账号停用专项覆盖权限、CSRF、版本冲突、会话撤销、审计、自停用、最后管理员及并发保护；新增 FileService 超过 200,000 条元数据时启动对账 fail-closed 回归，确认有效 blob 未被移动且未创建 `trash/orphan`。既有 CSRF、审计篡改/并发、schema fail-closed、文件回收、强杀恢复和 UI 测试仍通过。 |
| Production build | **通过（当前工作区，2026-11-02）** | 当前 backend、frontend、shared 构建完成。主 JS chunk 约 816.51 kB，超过 500 kB 提示线；非构建失败。 |
| 运行时入口与静态 SPA | **通过（隔离数据）** | 本轮以生产构建启动 `node app/backend/dist/server.js`，在独立数据目录使用端口 3308 与未显式覆盖的 production `WEB_ORIGIN`；服务监听 `127.0.0.1:3308`，最新浏览器 smoke 通过。数据目录为专用隔离目录。 |
| 初始化与管理员 | **通过（隔离数据）** | `D:\collab-office-m0-runtime-2026-11-01` 执行 `data:init` 与显式 `bootstrap:admin` 成功。 |
| 存储校验/索引重建 | **通过（隔离数据）** | 重建前后 verify 均为 schemaVersion 1、审计链有效、唯一索引问题 0；文件 missing/hash mismatch/orphan/pending 均为 0；users=1、roles=4、permissions=48、files=0。 |
| Playwright 浏览器 smoke | **通过（2026-11-03，当前隔离开发环境）** | [m0-browser-smoke.py](../../scripts/m0-browser-smoke.py) 以新的 `data/tmp/browser-smoke-*` LMDB 目录、API 端口 3217 和 SPA 端口 5173 执行。浏览器完成首个管理员设置，明确断言不出现“工作邮箱”、只出现“内部账号”，验证管理员登录、系统时间问候、390px 布局、文档中心入口、管理员创建内部账号、成员首登强制改密、ready API 与第二实例拒绝。未使用或迁移真实业务数据。 |
| CI | **已配置但未运行；门禁未满足** | 新增 `.github/workflows/ci.yml`，Windows/Linux 矩阵运行冻结安装、typecheck、lint、覆盖率门禁测试和 build；三个官方 GitHub Actions 固定到当前核验的完整 commit SHA。当前仓库未配置 Git remote，未取得 hosted runner 结果；策略文档中的 E2E、迁移专用 fixture 和许可证检查尚未纳入本 workflow。路线图把“CI 全绿”列为 M0 退出条件，因此不能判为通过。 |
| 覆盖率门槛 | **基础配置门槛通过；专项门槛未配置** | 当前 API statements/branches/functions/lines 83.95% / 74.26% / 85.91% / 87.30%，前端 82.41% / 63.63% / 77.41% / 80.59%；FileService 四项为 90.87% / 86.41% / 83.78% / 98.96%，当前实测均超过 service ≥80% 目标。Vitest 仅执行全局 70/60/70/70 门槛；`policies/ ≥90%` 与独立 service 分组阈值尚未配置，且测试策略未定义专项指标口径，因此不能称专项自动门禁已通过。 |

## 未通过 / 未验证项

> 历史安装记录（2026-11-01）：正式根目录与干净 E: 隔离副本 `E:\Codex\1a-m0-final-injected-2026-11-01` 使用当时锁文件完成 `pnpm install --offline --frozen-lockfile`（403/403，退出码 0）；`node_modules/@collab/shared` 为普通目录，当日 typecheck、lint、API 28/28、前端 10/10 和 build 通过。配置使用 `injectWorkspacePackages: true`、`dedupeInjectedDeps: false`、消费者 `dependenciesMeta.injected: true`，由 [sync-injected-shared.mjs](../../scripts/sync-injected-shared.mjs) 复制 shared `dist`。正式根目录早先的 `ERR_PNPM_EPERM`、旧 symlink `EISDIR` 与 PnP 映射错误均为历史诊断；原依赖树保留为回滚备份。

第 1 项下方的早期 E: workspace-link 失败记录为历史证据；当前配置的干净 E: 副本和根目录安装均已通过，原依赖树也已保留为可回滚备份。该安装门槛不再是 M0 阻塞项。

该段旧安装失败记录已被当前根目录复验取代：原 `node_modules` 已原样保留在 `E:\Codex\1a-node_modules-pre-injected-2026-11-01`，当前 injected 配置已在根目录完成冻结安装。其余旧细节仅作诊断历史。

1. **安装历史记录（已关闭，不再阻塞 M0）。** 项目目标位置在 E: exFAT。早期一次冻结安装探针误在原工作区启动，于 399/402 包时因 `EPERM` 失败；较早的 E: 隔离副本在创建 workspace symlink 时返回 `EISDIR`，PnP 探针也曾因内部映射错误失败。这些结果均已按当时路径和参数留档，不外推为所有 exFAT 环境的通用限制。2026-11-01 的 injected 配置在正式根目录与干净 E: 隔离副本通过冻结离线安装、typecheck、lint、当时的 38 项测试和 build；2026-11-02 当前工作区另通过 85 项测试及 typecheck/lint/build，见本报告前文。已知端口 3308 smoke 服务已停止；旧依赖树保留在 `E:\Codex\1a-node_modules-pre-injected-2026-11-01`。

2. **崩溃恢复基本一致性用例已通过，压力覆盖仍有限。** [m0.test.ts](../../app/backend/test/m0.test.ts) 在真实 LMDB 子进程中先连续提交 20 笔任务+审计+计数事务，再于第 21 笔事务写入但尚未提交时强制终止进程。重开后确认任务序号恰为 1–20、任务计数=20、审计记录数=20、auditSeq=20 且哈希链有效，覆盖 [测试策略 §5.3](testing-strategy.md) 的任务/审计/计数一致性核心要求。此为确定性单次用例，不等同于长时间压力测试；文档读取恢复路径也未在该用例中覆盖。该结果来自 NTFS 隔离副本，不替代 E: 目标卷验证。

3. **dataScope 与账号完整生命周期未完成。** 自定义角色 CRUD、用户角色全量替换、有效权限预览与审计现已实现并由真实 LMDB/Fastify 测试覆盖；`AuthContext`/`loadContext()` 仍不合并或执行 `dataScope`，也没有部门/员工资源模型可验证范围过滤，详见 [api-design.md](../03-technical/api-design.md) 与 [权限模型](../02-business/permission-model.md)。多角色 scope 合并语义尚未决定。`dataScope` canonical 值为 `self`/`department`/`department_tree`/`all`，仅作为角色契约字段校验/存储/返回。账号停用基础接口已实现：事务内重验操作者和 `user:manage`，拒绝自停用，仅统计未软删除且 active 的管理员以保护最后一个活跃 `org_admin`，按版本更新状态，撤销全部活跃会话并追加审计；真实集成测试已覆盖上述关键路径。停用原因当前保存在审计 metadata；存储设计虽定义 Session `revokeReason`，现有 Session schema/model 尚未包含该字段，需后续经 schema 兼容决策后对齐。用户详情/编辑、启用、重置密码、强制下线、当前审批人转交及离职移交仍无服务/API 闭环。直接仓储软删测试只证明下次请求会话失效，不代表完整生命周期用例完成。

4. **认证安全回归已通过。** [auth-service.test.ts](../../app/backend/test/auth-service.test.ts) 使用真实临时 LMDB 验证改密事务对撤销/删除/改绑/过期会话、停用/删除用户 fail closed；成功改密会保留当前会话、撤销其他会话并写入有效审计链。[user-disable.test.ts](../../app/backend/test/user-disable.test.ts) 另覆盖停用权限、CSRF、版本冲突、会话撤销、审计、自停用、最后管理员及并发保护。[m0.test.ts](../../app/backend/test/m0.test.ts) 覆盖 Cookie、CSRF、Origin、Host 伪造来源和登录锁定期限边界。启用/重置/强制下线和 Workflow 当前审批人转交不属于本轮实现范围。

5. **文件引用对账已有 CLI 闭环，容量与格式验证仍有限。** [file-service.ts](../../app/backend/src/modules/core/file-service.ts) 现将 refCount 降至 0 的内容移入 `trash/files/<epochMillis>/`，只在启动时清理受管类别下已满 7 天的时间戳目录；兼容清理旧版严格匹配的 SHA-256+时间戳平铺文件。固定时钟测试验证新旧格式均在未满 7 天时保留、到期后清理。`storage:verify` 现将活动 `document_versions` 与活动 `application_attachments` 作为独立引用事实源，分别计数并核对 `files.refCount`、状态、物理存在性、SHA-256 和大小；`storage:rebuild-indexes` 在引用或主记录预检失败时不改写索引，且不修复 `refCount`、历史链或源数据。隔离真实 LMDB 用例覆盖文档版本和申请附件共同引用同一文件、计数漂移及拒绝重建。另有回归证明 `files` 元数据超过 200,000 条范围扫描上限时启动对账 fail-closed，未隔离排序末尾的有效 blob。完整维护尚未改为稳定游标分页；超过安全上限只能失败关闭，需后续实现可验证的游标遍历。Office 类型仍只校验 ZIP `PK` 头，不能确认 OOXML 内容。参见 [data-storage-design.md §15](../03-technical/data-storage-design.md)。

6. **迁移转换能力仍未完成，但入口已 fail-closed。** [migrate.ts](../../app/backend/src/cli/migrate.ts) 现使用受限的 `open({ allowSchemaMismatch: true })` 读取旧/缺失版本，持有 [SingleInstanceLock](../../app/backend/src/runtime/single-instance.ts)，进入维护模式；当前版本只输出 no-op，缺失版本、非法版本、高版本和未注册旧版本均拒绝，且临时 LMDB 回归测试确认 schema 元数据不被静默改写。当前仍没有经批准的旧 schema transformer、`migrationState` 分块续跑、V1 审计 verifier/golden fixture 或旧审计链双版本校验，因此不得对既有数据执行迁移，也不得猜测重算哈希。审计仓储仍以 UUID 文档键/schemaVersion 1 为实体主键，尚未实现设计中的 `pad12(seq)+id` 物理键/序号索引；这些仍是 M0 缺口。 |

7. **设计文档尚有语义冲突待负责人确认。** 单组织决策与部分产品/权限文档中的 `org_id` 描述不一致；系统架构一处写不提供备份/恢复，另一处列有恢复 `store/files` 步骤。权限目录中的 `document:read:all` 是否绕过 ACL、以及是否仅授予 view，也与当前 ACL 伪代码不一致。M0 工程不得自行改写产品决策来消除冲突。

8. **审计哈希链完整性缺口已修复源码，旧格式迁移仍未完成。** 隔离 LMDB 复现表明旧实现篡改 `actorUserId` 后 `verifyChain()` 仍返回 true。当前源码现以 UoW 同事务维护 `meta.auditSeq`/`meta.auditLastHash`，按 seq 校验连续性及链头，canonical JSON SHA-256 覆盖 actor、action、resource、result、IP、user-agent、requestId、metadata、createdAt 与 prevHash；HTTP 调用点传递可用请求上下文。新增篡改 actor 负测、固定时钟下 25 路同毫秒并发序号与 meta 链头断言均通过。**此改动与旧审计行不兼容**：旧数据没有序号/result/IP/UA，且使用旧哈希算法；新校验会拒绝旧格式，追加也会在缺少链头时失败关闭。没有静默重写既有 append-only 数据。需先实现批准设计中的停机、分块、迁移状态记录、双版本哈希校验和旧链接续迁移，并在隔离副本验证后才能对已有数据使用。另当前仓储仍以 UUID 文档 ID 为实体主键，尚未实现设计中的 `pad12(seq)+id` 审计物理键/序号索引，列表校验目前需收集后排序；这仍是存储设计差距。

## 变更记录

- 收紧 CSRF 来源信任：仅接受配置的 `WEB_ORIGIN`，不再以请求 Host 扩展白名单；开发默认保留 Vite 来源，生产本地默认与启动脚本统一为 `http://127.0.0.1:3000`。增加 Host 伪造同源负测。登录锁定期间的请求仍记登录记录，但不递增失败计数或滚动延长 15 分钟锁定，增加回归断言。
- 在 D: NTFS 隔离副本重跑当前应用/脚本源码的完整 typecheck、lint、API+前端测试及 build，前端测试增至 10 项，并执行 API/前端 coverage 采样。生产 smoke 最新记录仍对应 file verify 修复之前的构建。
- 修复只读文件 `verify()` 在有未解决孤儿文件/待处理上传时仍可能报告成功的问题；扩展真实临时文件系统回归用例，确认成功隔离与只读未解决状态分别报告。
- pnpm 11 项目级设置从 `.npmrc` 移至 `pnpm-workspace.yaml`；仅为已审查的三个依赖启用构建脚本。
- 将 npm 安装脚本改为精确 pnpm 冻结锁安装；移除已被 pnpm workspace 取代的根 `package-lock.json`。
- 修正 backend/frontend 实际构建目录与生产启动脚本、smoke 脚本不一致的问题。
- 文件零引用回收改为保留 7 天、启动时按受管时间戳目录清理；加入固定时钟边界测试。扩展 LMDB 强杀测试为连续 20 笔任务+审计+计数提交后，于第 21 笔事务中途终止并校验重启后全量一致；修正强杀检查点退出监听器与子进程输出标记不一致的问题。
- 补记只读权限/迁移审计结论：dataScope 多角色语义与 M0 验收口径待负责人决策；缺失 V1 审计 golden fixture，故不实现猜测性旧链转换。
- RBAC 契约审计历史先统一了 `dataScope` 枚举并新增目录/系统角色 seed 测试；2026-11-02 随后交付角色 CRUD/全量替换/effective-permissions 契约与真实 LMDB 集成测试。范围过滤仍未实现。
- 实现自定义角色 CRUD、用户角色全量替换、有效权限预览和事务内 actor/session recheck；补充权限子集、管理员角色授予/撤销、会话/权限竞态测试。纠正自改角色测试为明确 403；新增账号停用基础闭环、最后管理员保护、会话撤销和审计的真实 LMDB/Fastify 集成测试。Workflow 当前审批人转交和其余账号生命周期能力仍未实现。
- 修复 `changePassword` 使用旧认证上下文继续写入的竞态：事务内重新读取活跃用户和有效会话，并核对账号密码版本；新增 8 个真实 LMDB service 测试（7 种失效状态拒绝、正常改密和多会话撤销）。
- FileService 真实 LMDB/临时文件系统集成用例增至 10 个，覆盖中断/截断与魔数失败清理、事务失败补偿、内容寻址碰撞/恢复、损坏数据对账、路径/哈希校验、目录丢失、陈旧上传隔离、文件名净化、重复引用和最终释放；四项覆盖率当前均超过 80%。
- 修复范围扫描达到 200,000 条时的静默截断风险：隐式全量 `range()` 现在在超出安全上限时抛错，文件启动对账在任何 orphan 隔离前 fail-closed；新增 200,001 条元数据隔离回归，确认有效 blob 保留且未创建 orphan quarantine 目录。完整游标分页仍待后续设计与验证。
- 更新 M0 开发阶段状态及相关部署/依赖文档，未改业务数据模型、未迁移数据。

## 最终判定

- 基础工程质量（NTFS 隔离副本）：**通过**。
- 初始化、首管理员、存储校验/索引重建、生产启动、身份浏览器闭环：**已取得隔离验证通过证据**；本轮额外确认生产默认 Origin 下的登录闭环。
- 数据范围执行、账号完整生命周期（启用/重置/强制下线、当前审批人转交和离职依赖）、业务文件引用对账、旧审计格式与旧 schema 转换迁移、长时间/多路径恢复压力验证、Windows/Linux hosted CI、策略/service 专项覆盖率门槛：**未通过或未验证**。账号停用基础闭环和最后管理员保护已有专项证据，但不能替代上述未完成项。
- **M0 总判定：未通过。** 用户于 2026-11-02 授权并行开发后续模块；并行开发不表示 M0 通过或获准使用真实业务数据，也不能假定尚未落实的安全与存储保证已具备。当前工作区冻结安装、typecheck/lint/test/build 及基础 coverage 阈值有通过证据；仍需 Windows/Linux hosted CI 全绿、批准的旧审计/schema 转换迁移、范围授权口径与执行、文件业务引用对账、完整账号生命周期与 Workflow 依赖校验、长时间/多路径恢复验证及策略/service 覆盖率门槛，再由人工签署。如需调整验收标准，须由负责人正式变更并记录。

## 环境与数据边界

- Node.js 24.17.0、pnpm 11.18.0、Windows x64。
- E: 为 exFAT；D: 为 NTFS。早期 E: 安装探针/旧配置 workspace-link 的 `EPERM`/`EISDIR` 与 PnP 映射错误均为历史诊断。2026-11-01 的安装复验和 NTFS 隔离生产 smoke 按当日记录执行；2026-11-02 本轮 typecheck、lint、coverage、build 在当前 E: 工作区执行，所有测试数据均为临时 LMDB/文件目录。Git remote 为空，CI workflow 无 hosted runner 结果，且未覆盖策略计划中的 E2E、迁移与许可证步骤。验收报告仅在当前工作区更新。
- 未读取/修改 NextWeb4/gw 或其他历史项目；未迁移任何现有数据库/数据目录。
- 验收用 LMDB 与账号数据保留在三个明确的 D: 隔离目录中，没有作为生产数据使用。
- `cases/` 不存在；当前环境没有 `kb_router`、`kb_read_file` 或 HTTP probe 工具，因此未查询知识库。验收依据为本仓库代码/文档与隔离运行结果。
