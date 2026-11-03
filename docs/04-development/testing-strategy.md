# 测试策略

> 文档状态：Draft for Review  
> 版本：0.2.0  
> 日期：2026-10-31  
> 工具：Vitest + Fastify inject + Playwright + 真实 LMDB 临时目录 + 本地文件系统  
> 关联：[验收标准](acceptance-criteria.md)、[数据存储设计](../03-technical/data-storage-design.md)

## 1. 目标

1. 证明四条业务闭环可用。
2. 证明权限/数据边界/审计在服务端成立。
3. 证明 LMDB 事务、并发、崩溃恢复、索引重建可靠。
4. 证明文件元数据与文件一致。
5. 测试可在 Windows 本机运行，不依赖 Docker/数据库服务。

## 2. 分层

```text
E2E（Playwright）             关键路径
集成（API + 真实 LMDB）       权限/事务/状态机/文件
存储（LMDB 直接测试）         崩溃/并发/索引
单元（Vitest）                策略/校验/纯函数
```

| 层 | 范围 | 工具 |
|---|---|---|
| 单元 | 状态机、审批人、ACL、Zod、键编码 | Vitest |
| 存储 | CRUD、唯一索引、事务回滚、并发、崩溃、重建 | Vitest + 临时目录 |
| 集成 | routes + service + 真实 LMDB | Vitest + `app.inject()` |
| E2E | 登录、项目、OA、权限、文档、手机审批 | Playwright |
| 迁移 | schemaVersion、停机迁移 | 脚本 + Vitest |
| 安全 | 权限矩阵、IDOR、CSRF、上传 | 集成 + E2E |
| 性能 | 50k/100k 数据、工作台、看板 | autocannon/k6（M4 选型） |
| 可访问性 | 关键页面 | axe-core |

## 3. 覆盖率

- `policies/`（状态机、审批人、ACL、权限）≥90%。
- service ≥80%；全仓 ≥70%。
- 关键 E2E 100% 通过。
- 不为覆盖率写无断言测试。

## 4. 测试环境

- 每个测试套件创建独立临时目录：`<tmp>/collab-test-<uuid>/`。
- 使用真实 `lmdb`，`encoding:'json'`，`maxDbs:128`，不 mock 存储。
- 测试结束关闭 DB、删除临时目录；失败保留现场（可配置）。
- 文件测试使用独立 `files/tmp/trash` 目录。
- 时间通过 `Clock`/fake timers 注入；会话/审批窗口/逾期可控制。
- 测试数据用 factory；两用户/两部门/私有项目/受限文档用于越权。
- CI：Windows 与 Linux 各跑一次；原生模块预编译验证。

## 5. 存储测试（新增重点）

### 5.1 事务/索引

- CRUD。
- 唯一邮箱/项目短键/任务编号冲突。
- 事务内写实体+索引+审计，抛错后全部回滚。
- 索引重建后计数/样本一致。
- 软删除后索引移除，唯一值可复用（按业务规则）。

### 5.2 并发

- 100 个并发事务对计数器/任务序号读改写，结果准确。
- 两进程写同一 LMDB（可选）验证不丢数据。
- 审批/提交并发只成功一次。
- 乐观锁 `version` 冲突 409。

### 5.3 崩溃恢复

- 子进程持续写“任务+审计+计数”事务，`taskkill /F` 强杀。
- 重启后任务数=审计数=计数；文档可读。
- 记录测试次数/结果；不断言每次都有写入，但必须一致。

当前已落地的 [storage-recovery.test.ts](../../app/backend/test/storage-recovery.test.ts) 是一个有限的存储级 fixture：同一真实 LMDB 临时目录连续运行 3 个子进程；每轮先提交 task、counter、审计、`documents` 子库记录和一份内容寻址文件，再进入第二笔未提交事务并输出确定性检查点后被强杀。每次重开后测试校验仅已提交的 task/document/counter/audit 存在、审计链有效，且 document 记录关联的 file 元数据、SHA-256 和实际字节可读一致。

这三次强杀不等于长时压力、损坏介质恢复、完整文档业务模块、文档 ACL/版本，或项目/审批业务恢复验收；这些仍需按本策略的独立场景验证。

### 5.4 损坏/对账

- 截断 `data.mdb` → 读取报 `MDB_CORRUPTED`，应用进入维护/返回 503。
- 文件缺失/哈希不符 → 410/409，不返回空文件。
- orphan 文件 → 启动移入 trash；pending 清理。
- 审计链断裂 → verify 失败并告警。

`app/backend/test/file-service.test.ts` 当前以真实临时 LMDB 和临时文件目录覆盖文件存储边界：中断/截断流与魔数不符时清理 `.upload` 且不写元数据；元数据/审计事务失败时验证 LMDB 回滚并补偿删除新建内容文件；内容寻址已存在的正确文件可恢复，错误碰撞拒绝且保留现场；verify 检出大小、哈希及存储键语义不一致，并对缺失数据目录失败关闭；陈旧 `.upload` 在只读 verify 中报告、启动时隔离；路径穿越、文件缺失和哈希不符时不返回下载路径；文件名路径/控制字符被净化；重复内容引用计数递增，最后一次 release 才将元数据标记 deleted 并移入 trash。此套件不校验业务实体的引用总数，因为当前没有文档版本/申请附件事实源。2026-11-02 API 覆盖采样中 FileService statements/branches/functions/lines 为 90.87%/86.41%/83.78%/98.96%；该数字是当前采样结果，专项门槛仍未配置为独立自动门禁。

### 5.5 迁移

- 旧 schemaVersion 数据 → 停机 → 分块迁移 → 重建索引 → 校验 → 新版本。
- 迁移失败保留现场；不提供自动恢复。
- 迁移幂等/可重入。

## 6. 权限/安全测试

### 6.0 M0 已落地的 RBAC 契约与集成门禁

`app/backend/test/rbac-contract.test.ts` 校验共享权限目录与内置角色 seed，当前覆盖：

- 权限目录 code 唯一，`PERMISSION_CODES` 与目录顺序/集合一致；
- 四个系统角色 code 与 seed 一致，角色权限只能引用目录中的 code；
- 角色 `dataScope` 只能取 `self`、`department`、`department_tree`、`all`；
- `org_admin` 是唯一完整权限目录 seed，避免系统角色意外漂移。

`app/backend/test/m0.test.ts` 另以 Fastify inject 和真实 LMDB 覆盖已实现的角色 CRUD、未知权限码拒绝、被引用角色不可删、系统角色不可删、有效权限预览、全量角色替换、角色变更审计、事务内重新授权/会话重验，以及管理员角色授予/撤销边界。用例断言自改角色返回 403；这不等于账号停用时最后一个管理员保护已实现。端点的精确请求/响应契约见 [m0-rbac.openapi.json](../03-technical/m0-rbac.openapi.json)。

上述证据不包括 `dataScope` 的部门过滤或多角色合并，也不代表完整用户生命周期闭环：账号停用基础接口已有独立真实 LMDB/Fastify 用例，覆盖权限、CSRF、版本冲突、会话撤销、审计、自停用、最后管理员及并发保护；用户详情/编辑、启用、重置密码、会话强制下线，以及离职时项目/审批/任务移交尚未实现或验证。项目、审批、文档 ACL/IDOR 的完整矩阵仍必须在相应业务模块实现后按下列场景补齐。

- 4 内置角色 × 主要动作。
- 项目 4 角色 × 项目/任务。
- 数据范围 self/department/department_tree/all。
- 文档 ACL user/role/department + owner/admin。
- 申请申请人/当前审批人/历史审批人/管理员/审计员。
- IDOR：跨用户/部门/项目/文档全部 404。
- CSRF 缺失/错误 token/跨 Origin → 403，无副作用。
- 上传类型伪装/超大/路径穿越/下载头。
- Markdown XSS/原型污染 `__proto__`。
- 登录锁定/会话撤销/角色提权。账号停用基础闭环已有专项测试；当前审批人转交、项目/任务依赖和启用/重置/强制下线仍需在相应模块实现后补测。
- 审计/审批只追加、哈希链可校验。

## 7. E2E 关键路径

1. 初始化 → 创建部门/用户/角色 → 首次登录改密。
2. 项目创建 → 成员 → 任务 → 看板 → 完成 → 归档。
3. 请假提交 → 两级审批 → 通过 → 历史。
4. 驳回 → 复制新建。
5. 撤回 → 待办消失。
6. 管理员转交 → 新审批人处理。
7. 权限：部门范围/私有项目/受限文档。
8. 文档上传 → 分类/标签 → 授权 → 搜索/下载。
9. 文档新版本 → 历史版本。
10. 手机视口审批；无权限/空/错误状态。
11. 强杀进程后重启，登录/项目/文档可读（集成）。

## 8. 性能测试

- 50k 任务：列表/看板/索引 P95。
- 100k 申请：我的申请/待审批。
- 工作台 5 模块 P95。
- 25MB 文件上传/下载。
- 索引重建耗时。
- 记录环境/数据/脚本/结果；不把原型数字当 SLA。

## 9. CI

```text
install --frozen-lockfile
→ typecheck
→ lint
→ unit
→ storage integration (temp dirs)
→ migrate/schema tests
→ build
→ E2E
→ audit/license
```

- Windows runner 验证 LMDB 预编译；Linux 也跑。
- 失败保留测试数据目录/截图/日志。
- 不把 `data/` 或临时 DB 提交。

当前基础流水线见 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)：Windows/Linux 冻结安装、typecheck、lint、现有 Vitest（含真实 LMDB 临时目录集成测试）和 build。迁移专用测试、Playwright E2E、依赖许可证/SCA 检查尚未接入；在对应脚本与受控证据可用前，不视为本节完整目标已达成。

## 10. 发布门禁

- [ ] 单测/集成/E2E 全绿；覆盖率达标。
- [ ] 事务/并发/崩溃/索引重建测试通过。
- [ ] 权限矩阵/IDOR/CSRF/上传测试通过。
- [ ] 文件/元数据一致。
- [ ] Windows 本机部署 + 局域网访问验证。
- [ ] 无 P0/P1 缺陷。
- [ ] 无备份功能（按决策）。
