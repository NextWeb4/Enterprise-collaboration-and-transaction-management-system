# 阶段 A：新项目初始化方案

> 文档状态：Draft for Review  
> 版本：0.1.0  
> 日期：2026-10-31  
> 适用范围：`collab-office` 全新工程  
> 重要说明：本文是**初始化方案**，不是已执行记录。当前工作区只有文档，没有业务代码、依赖或数据库。

## 1. 项目标识

| 项目 | 取值 | 说明 |
|---|---|---|
| 产品中文名 | 企业协同与事务管理平台 | 需求给定名称，暂定 |
| 产品简称 | 协同平台 | 文档内部使用 |
| 工程代号 | `collab-office` | 仓库名、包作用域 |
| npm 作用域 | `@collab-office/*` | 仅内部包使用 |
| 默认语言 | 简体中文 | 首版 UI 与文档 |
| 默认时区 | `Asia/Shanghai` | 组织可配置，数据库统一存 UTC |
| 默认货币 | CNY | 仅 OA 费用类字段使用，首版不做多币种 |
| 许可证 | 待定 | **不得在未确认前添加开源许可证文件**，见 Q-002 |

命名未做商标、域名和 npm 作用域检索。`collab-office` 是工程代号，不构成最终品牌名。

## 2. 初始化原则

1. **从零开始**：不读取、不引用、不迁移任何历史项目（包括 NextWeb4 / gw）。
2. **文档先行**：阶段 A–F 审查通过前，不创建正式 `app/` 代码目录。
3. **最小依赖**：每个依赖必须有明确用途、维护活跃、许可证可接受。
4. **单仓单应用**：模块化单体，不做微服务，不按“未来可能拆分”预设服务边界。
5. **可复现**：Node 与 pnpm 版本固定，依赖锁定，环境变量模板化。
6. **安全默认**：默认拒绝、最小权限、服务端校验、审计可追溯。

## 3. 目标目录结构（审查通过后创建）

```text
EnterprisePlatform/
├─ app/
│  ├─ backend/                  # Fastify API（模块化单体）
│  │  ├─ src/
│  │  │  ├─ app.ts              # 组装 Fastify 实例，不监听端口
│  │  │  ├─ server.ts           # 进程入口、优雅退出
│  │  │  ├─ config/             # 环境变量/配置校验
│  │  │  ├─ plugins/            # auth/security/error/swagger/audit
│  │  │  ├─ modules/
│  │  │  │  ├─ identity/
│  │  │  │  ├─ organization/
│  │  │  │  ├─ project/
│  │  │  │  ├─ task/
│  │  │  │  ├─ workflow/
│  │  │  │  ├─ document/
│  │  │  │  ├─ calendar/
│  │  │  │  ├─ notification/
│  │  │  │  ├─ analytics/
│  │  │  │  └─ audit/
│  │  │  └─ shared/             # 错误、分页、ID、事务、策略工具
│  │  └─ test/
│  ├─ frontend/                 # React SPA
│  │  ├─ src/
│  │  └─ e2e/
│  └─ shared/                   # 构建后的共享契约
├─ data/
│  ├─ config/                   # 非敏感配置
│  ├─ store/lmdb/               # LMDB
│  ├─ files/                    # 文件
│  ├─ logs/                     # 日志
│  ├─ tmp/                      # 临时
│  ├─ trash/                    # 回收
│  └─ locks/                    # 单实例锁
├─ scripts/                     # 启动/校验/重建索引
├─ docs/
├─ config.example.json
├─ .env.example
├─ .gitignore
├─ .npmrc
├─ .nvmrc
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ AGENTS.md
└─ README.md
```

**不创建**：额外 UI/domain/sdk 包、独立 `services/*`。首版只有一个 Web 客户端和一个 API；过早拆包会增加边界维护成本。

## 4. 技术栈与版本策略

### 4.1 已确认方向

| 层 | 技术 | 结论 | 依据 |
|---|---|---|---|
| 前端框架 | React + TypeScript | 采用 | 生态成熟、类型支持好 |
| 构建 | Vite | 采用 | SPA 构建快、配置简单 |
| UI | Ant Design 5.x | 采用 | 企业后台组件完整 |
| 路由 | React Router | 采用 | SPA 必需 |
| 服务端状态 | TanStack Query | 采用 | 缓存/失效/四态 |
| 客户端状态 | Zustand | 采用 | 仅 UI 状态 |
| 表单 | React Hook Form + Zod | 采用 | 性能 + 共享契约 |
| 后端 | Node.js + Fastify | 采用 | 低开销、插件化、Windows 友好 |
| 存储 | LMDB（`lmdb` 3.5.9） | 已确定 | 原型验证 ACID/并发/崩溃/索引 |
| 文件 | 本地文件系统 | 采用 | 无对象存储服务 |
| 测试 | Vitest + Playwright | 采用 | 与 Vite 生态一致 |
| 部署 | 本机 Node + 静态 SPA | 采用 | 无 Docker/DB 服务 |

### 4.2 运行时版本

| 组件 | 目标版本 | 当前环境 | 说明 |
|---|---|---|---|
| OS | Windows 10/11 64 位 | Windows 10.0.19045 | 生产 Windows 优先 |
| Node.js | **24.x LTS** | 24.17.0 | LTS 维护支持期；锁定 minor |
| pnpm | **11.x** | 11.18.0 | `packageManager` 固定 |
| LMDB | **`lmdb` 3.5.9** | 项目外原型验证通过 | 正式依赖待审查安装 |
| Docker/数据库服务 | — | 不需要 | 明确不使用 |
| Git | 2.53+ | 2.53.0 | 已安装 |

React、Fastify、LMDB、Vite 等库在初始化当天锁定稳定版；升级必须回归存储/崩溃/索引测试。

### 4.3 版本与依赖规则

- `package.json` 使用精确版本（无 `^`、`~`），避免“今天能装、明天不同”。
- 提交 `pnpm-lock.yaml`；CI 使用 `pnpm install --frozen-lockfile`。
- `packageManager` 固定 pnpm 版本，`engines` 固定 Node major。
- 禁止在生产依赖中使用 `latest`、Git URL、本地 `file:` 路径。
- 新依赖准入必须记录：用途、许可证、维护状态、替代方案、体积/安全影响。
- 禁止依赖执行未经审查的 `postinstall` 脚本；pnpm 默认关闭依赖脚本，需要时逐项白名单。
- 每月集中升级一次补丁版本；major 升级必须写 ADR 并回归。

## 5. 环境与配置

### 5.1 计划环境变量

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
LOG_LEVEL=info
TRUST_PROXY=false
```

规则：

- `.env` 不入库，只提交 `.env.example`。
- 启动时用 Zod 校验环境变量；缺失或非法立即失败。
- 密钥只从环境注入，不入库、不写日志。
- `DATA_DIR` 生产使用绝对路径（如 `C:\EnterprisePlatform\data`）。
- 本地 HTTP；不引入反代/HTTPS；`TRUST_PROXY` 保持 false。

### 5.2 本地依赖

开发不需要 PostgreSQL/Docker。需要：

1. Node 24 + pnpm 11；
2. `lmdb` 的 Windows 预编译（`@lmdb/lmdb-win32-x64`）；若不可用，准备 Node 构建工具；
3. 一个本地数据目录（开发可用 `./.data`，测试用临时目录）。

测试使用独立临时目录，不共享开发/生产数据。

## 6. 依赖管理方式

- 单一 pnpm workspace，根目录统一安装，禁止各子包独立 lockfile。
- 运行时依赖放在对应 app/package；根目录只放工程工具。
- `app/shared` 不允许依赖 React、Fastify、LMDB，保持纯 TypeScript + Zod。
- `app/frontend` 不允许直接依赖 LMDB 或存储层类型。
- 循环依赖用 `dependency-cruiser` 或 ESLint 规则在 CI 阻断（初始化时评估，不预先安装）。
- 依赖审计：`pnpm audit` 作为 CI 信息项；高危漏洞阻断发布。

## 7. Git 规范

### 7.1 仓库初始化（审查后执行）

```bash
git init -b main
git add .
git commit -m "chore: initialize collab-office documentation baseline"
```

当前工作区**尚未执行** `git init`，以保持“仅文档产出”的边界。

### 7.2 分支模型

采用 trunk-based development：

- `main`：始终可构建、可部署；禁止直接推送，必须通过短生命周期分支合并。
- `feat/<scope>-<short-desc>`：功能。
- `fix/<scope>-<short-desc>`：缺陷。
- `docs/<short-desc>`：文档。
- `chore/<short-desc>`：工程杂项。
- 分支存活目标 ≤ 3 个工作日；超过必须拆分或关闭。

单人开发也保留分支与合并记录，避免“全部直接堆在 main”导致无法回溯。

### 7.3 提交信息

Conventional Commits：

```text
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

允许的 type：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`perf`、`build`、`ci`。  
scope 使用业务域：`identity`、`org`、`project`、`task`、`workflow`、`document`、`calendar`、`notification`、`analytics`、`audit`、`web`、`api`、`infra`。

示例：

```text
feat(workflow): enforce sequential approval with row lock
fix(task): reject done transition when progress is below 100
docs(api): document idempotency for application submission
```

禁止无意义提交（`update`、`fix bug`、`111`）。一个提交只做一件事；数据库迁移与业务代码在同一提交中，保证可回滚。

### 7.4 合并与发布

- 使用 squash merge，保持 main 线性历史。
- PR 描述必须包含：变更、验证方式、风险、截图（UI）、迁移说明（DB）。
- 合并前必须通过：类型检查、lint、单元/集成测试、构建。
- 版本标签：`v0.x.y`；首版前不承诺语义化版本。
- 发布记录写入 `CHANGELOG.md`（初始化后创建）。

## 8. 工程门禁

阶段 A 审查通过后，初始化必须满足：

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

全部通过才允许提交第一个业务切片。第一阶段不执行这些命令。

## 9. 当前环境事实与缺口

| 项 | 事实 | 影响 |
|---|---|---|
| 工作区 | `E:\Codex\1a`，仅有 `docs/` 与根文档 | 符合“从零开始” |
| Git 仓库 | 尚未初始化 | 审查后再执行 |
| Node | 24.17.0 | 可直接作为目标 LTS |
| pnpm | 11.18.0 | 可用 |
| LMDB | 项目外原型验证通过 | 正式依赖待审查安装 |
| Docker/数据库服务 | 不需要 | 明确不使用 |
| 历史项目 | 未检查、未引用 | 符合隔离要求 |

## 10. 风险

1. **LMDB 原生模块/预编译**可能在目标 Windows 失败；需保留构建工具/备选。
2. **单人开发 + AI 辅助**容易“页面多、闭环弱”；以闭环/存储测试为里程碑。
3. **文件与 KV 非原子**；必须补偿/对账/校验。
4. **无 SQL/ORM**；唯一约束/索引/迁移需自研，测试成本高。
5. **数据目录**必须本地盘；误放网络盘/同步目录有损坏风险。
6. **LMDB 许可证**（OpenLDAP 2.8）需法务确认。

## 11. 阶段 A 退出条件

- [x] 名称、目录、技术栈、环境、依赖、Git 规范形成文档。
- [x] 明确当前环境缺口。
- [x] Q-001/003/006/015～019 已关闭；等待人工审核。
- [ ] 审查通过后再执行工程初始化。







