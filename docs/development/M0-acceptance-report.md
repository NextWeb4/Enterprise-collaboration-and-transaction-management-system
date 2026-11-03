# R1/M0 阶段交付报告

> 当前结论：**M0 未通过；用户于 2026-11-02 授权并行开发后续模块**。并行开发不表示 M0 已通过或获准使用真实业务数据。本报告保留当时已实现项、验证证据和剩余门槛；详细逐项证据见[验收审查报告](../04-development/M0-acceptance-report.md)。隔离运行数据的结果不替代真实业务数据验收。

> 更新（2026-11-02）：当前工作区 `typecheck`、`lint`、`build` 与 coverage 均通过；API 75 项、前端 10 项测试通过（共 85 项）。API statements/branches/functions/lines 为 83.95%/74.26%/85.91%/87.30%，前端为 82.41%/63.63%/77.41%/80.59%。账号停用专项测试覆盖权限、CSRF、版本冲突、会话撤销、审计、自停用、最后管理员及并发保护；专项门槛仍未配置为自动门禁。安装与历史 exFAT 诊断见详细验收报告；M0 仍未通过。

## 1. 工程目录结构

采用批准工程契约定义的 `app/` 分层，而非最初建议的 `apps/`/`packages/`：

```text
app/backend/       Fastify API、核心服务、CLI、真实 LMDB 集成测试
app/frontend/      React SPA、Vite 构建、浏览器界面
app/shared/        前后端共享 Zod schema、权限码与错误契约
scripts/           普通进程启动、开发与浏览器 smoke 脚本
docs/              产品、业务、技术与验收文档
data/              运行时 DATA_DIR；不纳入源码，正式数据不提交 Git
```

程序与 `DATA_DIR` 分离；当前未在目标工作区初始化正式业务数据。仓库原有未提交内容均予保留，没有访问/修改/迁移历史项目，也没有初始化或重置 Git。

## 2. 技术依赖与环境

| 类别 | 当前锁定项 | 用途/许可依据 |
|---|---|---|
| 前端 | React 19.3.1、TypeScript 6.0.3、Vite 8.3.5、Ant Design 5.29.3 | SPA、类型与构建；直接依赖许可/用途清单见 [dependency-compliance.md](../05-research/dependency-compliance.md) |
| 后端 | Node.js 24.17.0、Fastify 5.12.7、Zod 3.25.76 | 单进程 HTTP/API、运行时校验 |
| 存储/安全 | lmdb 3.5.9、@node-rs/argon2 2.2.2 | 嵌入式 KV 与 Argon2id；LMDB/OpenLDAP、LZ4 等声明按依赖合规文档核对 |
| 测试/工程 | pnpm 11.18.0、Vitest 5.0.5、ESLint 10.14.0、Playwright 浏览器 smoke | 冻结依赖、自动化测试、静态检查及浏览器验收 |

环境复核：Windows 10 Pro 22H2（10.0.19045）、Node v24.17.0、pnpm 11.18.0、Git 2.53.0.windows.2；Git 可用，但仓库没有 remote，故无 hosted CI 结果。D: NTFS 副本已成功冻结安装并运行真实 LMDB 测试。干净 E: exFAT 副本 `E:\Codex\1a-m0-final-injected-2026-11-01` 使用当前锁文件完成 403/403 包冻结离线安装，`@collab/shared` 为普通目录，随后 typecheck、lint、38 项测试和 build 通过；正式根目录也已在保留原依赖树备份后完成同样复验。详见[详细验收审查报告](../04-development/M0-acceptance-report.md)。

## 3. 工程初始化

已建立 pnpm workspace、严格 TypeScript 配置、ESLint、Prettier、共享类型构建、统一 build/test/typecheck/lint 命令、环境变量校验、忽略规则和普通进程启动入口。未引入 SQL、ORM、Docker、服务包装器、反向代理或新型数据库服务。CI workflow 已落盘但未触发 hosted runner，且迁移、E2E、许可证/SCA 门禁仍未纳入完整流水线。

## 4. LMDB 存储层

已实现 `StorageEngine`、UnitOfWork、Repository/索引注册、JSON 文档信封、唯一索引冲突、事务及索引重建/校验 CLI。测试使用真实临时 LMDB，覆盖 CRUD、回滚、并发写入、迁移入口 fail-closed 与连续三轮子进程事务中途强杀恢复（task/document 原始存储记录、计数、审计和关联文件字节）。当前缺口是没有经批准的旧 schema/旧审计链转换器，且长时压力与完整文档业务恢复路径不足；当前 schema 的 no-op 仍不等于迁移完成。

## 5. 文件存储服务

已实现本地内容寻址、SHA-256、大小/类型校验、路径检查、受权上传下载、元数据维护、临时文件与孤儿对账、零引用文件 7 天隔离回收。新增真实 LMDB/临时文件系统测试覆盖流中断/截断、文件头失败清理、事务失败补偿、寻址碰撞、已有内容恢复、损坏记录对账、缺失目录失败关闭、陈旧临时上传隔离、文件名净化、路径/缺失/哈希错误下载拒绝、重复引用与最终释放，以及超出范围扫描上限时启动 fail-closed。只读 `verify()` 对未解决 orphan/`.upload` 失败关闭的回归也已通过。业务实体引用总数没有独立事实源，尚不能完成 `refCount` 全量对账；Office 格式检查也不足以验证 OOXML 内容。后续仍需稳定游标分页以支持超大清单的完整对账；当前 fail-closed 修复避免静默截断带来的误隔离。当前 FileService statements/branches/functions/lines 为 90.87%/86.41%/83.78%/98.96%，专项阈值尚未单独配置。

## 6. 身份认证

已实现 Argon2id 密码、会话 token 哈希存储、HttpOnly/SameSite Cookie、首次登录强制改密、登录/退出、失败限制、CSRF 双提交、请求 Origin 校验与登录审计。改密事务现在会重新校验当前用户和会话仍有效、未过期且归属正确；真实 LMDB 回归测试覆盖撤销、软删除、改绑、过期会话、停用用户拒绝改密，以及成功改密后撤销其他会话并保留当前会话。另保留仅信任配置 `WEB_ORIGIN` 与锁定期间不滚动延长的来源/登录回归。

## 7. 权限基础

已存在用户、内置角色、权限码目录、用户角色关联、角色权限码、服务端显式权限检查与默认拒绝。已实现自定义角色 CRUD、全量角色替换、有效权限预览与审计，以及账号停用基础闭环；敏感写入在同一事务中重新加载操作者及会话。`dataScope` 仍未在业务资源查询中执行；账号详情/编辑、启用、重置密码、强制下线和离职移交仍未闭环。部门模型、资源过滤和范围合并语义不得由当前基础 RBAC 推定。

## 8. 前端基础界面

已实现登录、主应用布局/导航、用户信息、个人设置与改密、工作台真实基础 API 数据、加载/错误/空页面与全局错误边界。项目、审批、文档等后续业务模块在 M0 显示规划状态，没有用虚构业务记录伪装上线能力。Playwright smoke 已验证生产登录、强制改密、390px 无横向溢出及单实例拒绝。

## 9. 测试结果与退出条件

最近一次当前工作区验证：`pnpm run typecheck`、`pnpm run lint`、`pnpm run build` 与 coverage 均通过；API **75/75**（8 个文件）、前端 **10/10**（2 个文件），共 **85** 项通过。API statements 83.95% / 74.26% / 85.91% / 87.30%；前端 82.41% / 63.63% / 77.41% / 80.59%。FileService 四项覆盖为 90.87% / 86.41% / 83.78% / 98.96%，当前均超过 service ≥80% 目标；专项阈值仍未单独配置，故没有自动门禁证据。前端用例覆盖登录成功/失败、会话失效重定向、工作台错误、404、改密确认与退出容错；后端新增账号停用、改密竞态、文件补偿及大清单 fail-closed 边界。Playwright 生产 smoke 的历史证据详见详细报告；本轮未重新执行带真实管理员凭据的浏览器流程，且 hosted CI 尚无结果。

未通过/待决门槛：Linux/Windows hosted CI；覆盖率门槛与更多前端测试；`dataScope`/角色管理范围决策；旧 schema 与旧审计链迁移；文件引用对账；更全面崩溃/压力验证。故 M0 不签收；新授权允许并行开发后续模块，但不改变这些验收缺口。逐项证据、隔离目录与风险见[详细 M0 验收审查报告](../04-development/M0-acceptance-report.md)。
