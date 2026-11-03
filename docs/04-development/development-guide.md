# 开发指南

> 文档状态：工作稿（M0 开发/验收指引）
> 版本：0.2.0  
> 日期：2026-11-01
> 适用：已获准的 R1/M0 基础、存储、身份开发与验收
> 当前阶段：R1/M0 已获准；用户于 2026-11-02 授权在 M0 尚未通过时并行开发后续业务模块。

## 1. 前置条件

| 工具 | 版本 | 当前环境 |
|---|---|---|
| Node.js | 24.x LTS | 24.17.0 ✅ |
| pnpm | 11.x | 11.18.0 ✅ |
| Git | 2.40+ | 2.53.0 ✅ |
| Windows | 10/11 64 位 | Windows 10.0.19045 ✅ |
| LMDB | `lmdb@3.5.9` | 已声明并锁定；NTFS 隔离副本安装验证通过，E: 目标卷安装验收未通过 |
| Docker/数据库服务 | — | **不需要** |

没有 PostgreSQL/MySQL/SQLite/Prisma/Docker 前置要求。若 `lmdb` 的 Windows 预编译不可用，需要 Node 构建工具（Python/VS Build Tools），但首选预编译。

## 2. 安装与初始化（受控开发/隔离数据目录）

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
```

- workspace 为 `@collab/frontend`、`@collab/backend`、`@collab/shared`；统一从根目录运行脚本。
- 初始化必须显式指定隔离/目标 `DATA_DIR`；先运行 `pnpm run data:init`，再通过 `BOOTSTRAP_ADMIN_ACCOUNT`、`BOOTSTRAP_ADMIN_PASSWORD` 运行 `pnpm run bootstrap:admin`。
- 不使用 SQL/ORM/Docker；不要在已有数据目录上重复初始化或运行破坏性操作。
- `data/` 默认在项目外/可配置；开发用 `./.data` 或 `%LOCALAPPDATA%`。
- 测试使用独立临时目录，不共享开发数据。

## 3. 目录

```text
EnterprisePlatform/
  app/frontend, app/backend, app/shared
  data/config, data/store/lmdb, data/files, data/logs, data/tmp, data/trash, data/locks
  scripts/
  docs/
```

规则：

- `app/` 只读；`data/` 可写。
- 业务模块不得直接 `open()` LMDB 或读写 `data.mdb`。
- 文件只经 `FileService`；路径不暴露。
- 不建额外 UI/domain 包。

## 4. 环境变量

```dotenv
NODE_ENV=development
PORT=3000
HOST=127.0.0.1
DATA_DIR=./.data
WEB_ORIGIN=http://localhost:5173
SESSION_COOKIE_NAME=collab_session
SESSION_IDLE_MINUTES=480
SESSION_ABSOLUTE_DAYS=7
MAX_UPLOAD_MB=25
LOG_LEVEL=debug
TRUST_PROXY=false
```

- 敏感配置走环境变量；不入库/不入 Git。
- 启动时 Zod 校验；缺失/非法失败。
- 生产 `DATA_DIR` 使用绝对路径（如 `C:\EnterprisePlatform\data`）。

## 5. 脚本

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 并行 web/api |
| `pnpm build` | 构建 SPA/API |
| `pnpm typecheck` / `lint` / `test` | 质量门禁 |
| `pnpm test:e2e` | Playwright |
| `pnpm data:init` | 创建目录/打开 LMDB/seed |
| `pnpm bootstrap:admin` | 组织/管理员初始化 |
| `pnpm storage:verify` | schema/索引/审计链/文件校验 |
| `pnpm storage:rebuild-indexes` | 维护模式重建索引 |
| `pnpm storage:migrate` | schemaVersion 迁移 |

## 6. 后端规范

- 路由只做 HTTP/认证/序列化。
- service 负责用例/事务/权限/审计/通知。
- 领域策略负责状态机/审批人/ACL/数据范围。
- Repository 封装 LMDB 文档/索引/分页；业务模块不导入 `lmdb`。
- 一个关键用例一个 `UnitOfWork.run` 事务；事务短小；不做文件/网络 IO。
- 错误 `AppError`；统一 problem+json；不暴露存储路径/堆栈。
- 日志 Pino；requestId；脱敏。
- 日期存 UTC ISO；展示本地时区；纯日期 `YYYY-MM-DD`。
- 输入 Zod 严格校验；拒绝未知字段/原型污染键。
- 唯一约束通过索引；冲突 409；更新用 `version` 乐观锁。

## 7. 前端规范

- React Router + AntD + TanStack Query + Zustand + RHF/Zod。
- Query key 集中；变更精准失效；不 `clear()`。
- 列表筛选进 URL；四态（加载/空/错误/无权限）。
- 权限只控制显示；服务端最终校验。
- 表单错误映射字段；409 提示刷新。
- 响应式：≥1200 完整侧栏，768–1199 折叠，<768 抽屉/单栏。
- 可访问性：label/键盘/焦点/对比度。

## 8. 数据/存储开发

1. 实体 schema（Zod）+ TypeScript 类型。
2. 命名子库 + 主键/复合键。
3. 索引定义（唯一/非唯一）。
4. Repository 方法。
5. 应用服务事务。
6. 审计/通知。
7. 测试：CRUD/唯一/回滚/并发/索引。
8. 迁移：schemaVersion + 分块 + 停机。

禁止：

- 业务模块直接 `open()` LMDB。
- 每个模块自建 JSON 文件。
- 单 JSON 文件存全部数据。
- 无事务多步写。
- 把索引当唯一数据源。

## 9. 文件开发

- 上传：临时文件 → fsync → SHA-256 → 原子 rename → 元数据事务。
- 下载：鉴权 → 流式响应 → 不暴露路径。
- 删除：软删 + refCount → trash 延迟清理。
- 启动/定时对账 orphan/missing/pending。
- 不实现备份；文件完整性用 SHA-256/对账。

## 10. 数据迁移

- 无 SQL migration；使用 `meta.schemaVersion` + 迁移脚本。
- 升级前停止进程；维护模式；分块事务；可重入。
- 破坏性字段用双读/双写/停机迁移。
- 迁移后重建/校验索引、审计链、文件引用。
- 失败时保留现场；不提供自动恢复；不手工改 `data.mdb`。

## 11. 测试

- 见 [测试策略](testing-strategy.md)。
- 本地提交前：typecheck + 相关单测 + lint。
- PR 前：全部单测/存储集成 + 关键 E2E。
- 存储测试必须在临时目录；不污染 `data/`。

## 12. Git

- `main` 可构建；短分支。
- Conventional Commits；迁移与代码同提交。
- 不提交 `node_modules`、`.env`、`data/`、构建产物。
- PR：变更/验证/风险/截图/迁移/回滚。

## 13. 部署（Windows）

```powershell
$env:NODE_ENV="production"
$env:DATA_DIR="C:\EnterprisePlatform\data"
node app\backend\dist\server.js
```

- 启动：`start.cmd` 或 `node app\backend\dist\server.js`。
- 生产 `start.cmd` 固定配置 `WEB_ORIGIN=http://127.0.0.1:3000`；若显式开放局域网，应同时把 `WEB_ORIGIN` 配为用户实际访问的完整 Origin（协议、主机、端口），否则登录/变更请求会被 CSRF 来源校验拒绝。
- 停止：终端 `Ctrl+C` 或关闭进程窗口；不注册 Windows 服务。
- 单端口；默认不开放防火墙；需要局域网时显式放行并提示风险。
- 普通进程运行；运行账号仅 `data/` 权限。
- 本地 HTTP；默认仅 127.0.0.1；局域网需显式开放并接受明文风险。
- 升级：停止进程 → 替换 app → 迁移/verify → 启动。
- 不需要 Docker/数据库服务。

## 14. 常见问题

| 问题 | 处理 |
|---|---|
| `lmdb` 加载失败 | 检查 `@lmdb/lmdb-win32-x64`、Node ABI、构建工具；保留回退 |
| 数据目录被占用/双实例 | 单实例锁；检查进程 |
| 数据损坏 | 停写；保留现场；不提供自动恢复 |
| 文件缺失 | 运行 `storage:verify`；禁止返回空文件；无备份恢复 |
| 端口占用 | 改 `PORT`；检查双实例 |
| 杀毒软件锁文件 | 评估排除数据目录/性能；记录安全取舍 |

## 15. 当前门禁

- 架构审查已获批准，允许进行 R1/M0 基础、存储、身份工程与验收。
- M0 尚未通过；后续业务模块可以并行开发并须独立验证，不能假定尚未落实的安全和存储保证已经具备。M0 验收要求及人工确认仍然有效；具体未通过/未验证项见 [M0 验收报告](M0-acceptance-report.md)。
- 初始化与运行验收只能使用明确隔离的数据目录；不得迁移现有数据库或覆盖非验收数据目录。
- 任何 AI 代理遵守当前 [AGENTS.md](../../AGENTS.md)；本指南与阶段门禁冲突时以 AGENTS.md 和最新 M0 验收报告为准。

