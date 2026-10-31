# 依赖与许可证合规

> 文档状态：Draft for Review  
> 版本：0.1.0  
> 日期：2026-10-31  
> 当前状态：正式项目尚未安装依赖；2026-10-31 在**项目外临时目录**安装 `lmdb`/`classic-level` 做原型验证，未写入项目 lockfile。下表为计划/候选，实际安装时逐项复核。  
> 原则：许可证不清不引入；来源不明不复用；完整业务系统不作为底座。

## 1. 合规边界

1. 本项目是独立研发，不基于 JeecgBoot、NocoBase、Yudao、Plane、ERPNext、Dolibarr 等完整系统二次开发。
2. 参考产品只用于设计研究；不复制源代码、数据库 schema、UI 资产、文案、商标。
3. 不引入 GPL/AGPL/SSPL/BUSL/Sustainable Use/自定义限制许可证的代码。
4. 依赖必须记录：名称、版本、用途、许可证、来源、是否运行时、替代方案。
5. 所有依赖许可证在安装时重新核验；许可证可随版本变化。
6. 生产依赖与开发依赖分开评估；开发工具也不能默认“无所谓”。
7. 任何例外必须书面记录并获得人工确认。

## 2. 许可证策略

### 2.1 允许（运行时，需保留版权/许可声明）

| 许可证 | 说明 |
|---|---|
| MIT | 宽松，保留版权/许可 |
| ISC | 宽松 |
| BSD-2-Clause / BSD-3-Clause | 宽松，保留声明 |
| Apache-2.0 | 宽松，保留 NOTICE/变更说明 |
| 0BSD / CC0 / Unlicense | 公共领域式 |

| MPL-2.0 | 文件级弱 copyleft；修改 MPL 文件需公开该文件；避免修改 |

### 2.2 条件允许

| 许可证 | 条件 |
|---|---|
| LGPL-2.1/3.0 | 仅动态链接、不修改库、允许替换；前端打包通常不适用 |
| EPL-2.0 | 避免修改 |
| CC BY 4.0（文档/图标） | 保留署名；不用于代码 |
| OFL（字体） | 保留许可；不单独售卖字体 |

### 2.3 禁止（未经书面例外）

| 许可证 | 原因 |
|---|---|
| GPL-2.0/3.0 | 衍生作品需 GPL；与专有/闭源分发冲突 |
| AGPL-3.0 | 网络使用触发源码提供义务；风险高 |
| SSPL | 非 OSI，限制服务化 |
| BUSL / Commons Clause | 商业限制 |
| Sustainable Use License | 仅内部/非商业，限制分发 |
| 自定义“非竞争”条款 | 法律边界不清 |
| 无许可证/未知 | 默认保留所有权利 |

> 说明：即使某些许可证允许商用，本项目仍可选择“不使用其代码”；本文的禁止清单是项目政策，不是法律意见。

## 3. 计划依赖清单

> 版本在初始化日锁定；下表的许可证为公开信息，安装时以包内 LICENSE 为准。标记“候选”表示尚未最终确定。

### 3.1 运行时（前端）

| 依赖 | 用途 | 许可证 | 备注 |
|---|---|---|---|
| react / react-dom | UI 框架 | MIT | |
| react-router | 路由 | MIT | |
| antd | 企业组件 | MIT | |
| @ant-design/icons | 图标 | MIT | 不额外引入图标包 |
| @tanstack/react-query | 服务端状态 | MIT | |
| zustand | UI 状态 | MIT | |
| react-hook-form | 表单 | MIT | |
| @hookform/resolvers | RHF + Zod | MIT | |
| zod | 校验/契约 | MIT | |
| dayjs | 日期 | MIT | AntD 已依赖 |
| echarts | 图表（P1） | Apache-2.0 | 按需加载 |
| react-markdown | Markdown 渲染 | MIT | 候选 |
| remark-gfm | GFM | MIT | 候选 |
| sanitize-html | HTML 白名单 | MIT | 候选；或使用 rehype-sanitize（MIT） |
| clsx | className 合并 | MIT | 可选 |

### 3.2 运行时（后端）

| 依赖 | 用途 | 许可证 | 备注 |
|---|---|---|---|
| fastify | HTTP 框架 | MIT | |
| @fastify/cookie | Cookie | MIT | |
| @fastify/cors | 开发跨域 | MIT | 生产同源 |
| @fastify/helmet | 安全头 | MIT | |
| @fastify/multipart | 上传 | MIT | |
| @fastify/rate-limit | 限流 | MIT | |
| @fastify/static | 静态资源/SPA | MIT | 由 Node 直接托管 |
| @fastify/swagger | OpenAPI | MIT | |
| @fastify/swagger-ui | 文档 UI | MIT | 生产关闭/保护 |
| fastify-type-provider-zod | Zod 集成 | MIT | 候选；安装时核验 |
| lmdb | 嵌入式 KV 存储 | MIT（包装）；OpenLDAP 2.8（LMDB）；BSD-2（LZ4） | 首选；保留全部声明 |
| classic-level | 备选嵌入式 KV | MIT；LevelDB BSD-3 | 仅备选，未采用 |
| pino | 日志 | MIT | Fastify 内置 |
| @node-rs/argon2 | 密码哈希 | MIT | 预编译二进制；核验平台支持 |
| uuidv7 | UUIDv7 | MIT | 候选；或自实现并测试 |
| sanitize-html | 服务端清洗 | MIT | 若前端未用 |
| pino-pretty | 开发日志 | MIT | dev only |

### 3.3 测试/工程

| 依赖 | 用途 | 许可证 | 备注 |
|---|---|---|---|
| typescript | 类型 | Apache-2.0 | dev |
| vite | 构建 | MIT | dev |
| vitest | 单测 | MIT | dev |
| @vitest/coverage-v8 | 覆盖率 | MIT | dev |
| @playwright/test | E2E | Apache-2.0 | dev；浏览器二进制另有许可 |
| @testing-library/react | 组件测试 | MIT | dev |
| @testing-library/jest-dom | 断言 | MIT | dev |
| jsdom | DOM 环境 | MIT | dev |
| eslint | Lint | MIT | dev |
| typescript-eslint | TS Lint | MIT | dev |
| prettier | 格式化 | MIT | dev |
| autocannon | 压测 | MIT | dev；M4 |
| axe-core | 可访问性 | MPL-2.0 | dev；不修改，保留声明 |

### 3.4 本机运行组件

| 组件 | 许可证 | 备注 |
|---|---|---|
| Node.js 24 | MIT | 本机运行时 |
| LMDB（`lmdb`） | MIT + OpenLDAP 2.8 + BSD-2 | 嵌入式；无独立服务 |

> 不使用 Docker/PostgreSQL/MySQL/SQLite/任何数据库服务镜像。

### 3.5 P1 候选（不安装）

| 依赖 | 用途 | 许可证 | 备注 |
|---|---|---|---|
| @aws-sdk/client-s3 | S3/MinIO | Apache-2.0 | P1 |
| nodemailer | 邮件 | MIT | P1 |
| otplib | TOTP/MFA | MIT | P1 |
| sharp | 图像处理 | Apache-2.0 | P1；注意 libvips |
| @sentry/node | 错误追踪 | MIT | P1；数据出境评估 |

## 4. 明确不引入的“依赖”

| 项目 | 许可证 | 结论 |
|---|---|---|
| JeecgBoot | Apache-2.0 + 非竞争补充条款 | 不引入代码/作为底座 |
| NocoBase | 自定义（Apache-2.0 + 补充限制） | 不引入代码/作为底座 |
| Yudao Cloud | MIT | 虽宽松，但不复用代码/模块 |
| Plane | AGPL-3.0 | 不引入代码 |
| ERPNext | GPL-3.0 | 不引入代码 |
| Dolibarr | GPL-3.0-or-later | 不引入代码 |
| AppFlowy | AGPL-3.0 | 不引入代码 |
| n8n | Sustainable Use License | 不引入代码 |
| Twenty | AGPL-3.0 + 商业文件/MIT 包 | 不引入代码 |
| Linear | 专有 | 不复制 UI/代码/资产 |

## 5. 新依赖准入流程

任何新依赖（含传递依赖的直接引入）必须回答：

1. **用途**：解决什么问题？不用它能否在 1 天内实现？
2. **替代**：标准库/现有依赖能否替代？
3. **维护**：最近 12 个月是否有发布/修复？issue 是否活跃？
4. **安全**：是否有已知高危漏洞？是否执行 postinstall？
5. **许可证**：包内 LICENSE 是什么？是否与政策冲突？
6. **体积/性能**：前端 bundle/后端启动/镜像大小影响？
7. **数据/隐私**：是否上报遥测/外部请求？能否关闭？
8. **锁定**：精确版本、lockfile、来源（npm registry）。
9. **退出成本**：如何替换？

记录到 `docs/05-research/dependency-compliance.md` 或实现阶段的 `THIRD_PARTY_NOTICES.md`。

## 6. 供应链安全

- 只从官方 npm registry 安装；不使用未知镜像/Git URL。
- 关闭依赖 `postinstall` 脚本（pnpm 默认），需要时逐项白名单并审查。
- `pnpm-lock.yaml` 入库；CI `--frozen-lockfile`。
- 每月 `pnpm audit`；高危阻断发布。
- 基础镜像固定 digest；定期重建。
- 生成 SBOM（P1）；记录直接/传递依赖许可证。
- 不使用被盗/弃用包；检查包名相似性（typosquatting）。
- AI 生成代码不自动信任；审查是否包含第三方代码/许可证头。

## 7. 版权与声明

实现阶段必须创建：

- `THIRD_PARTY_NOTICES.md`：直接依赖、许可证、版权声明、NOTICE（Apache-2.0）。
- `LICENSE`：项目自身许可证（待 Q-002 确认；当前不添加）。
- 前端打包保留必要 license 注释（如工具支持）。
- 文档/图标/字体来源记录；不使用未授权素材。

## 8. CI 合规检查

建议流水线：

```text
pnpm install --frozen-lockfile
pnpm licenses list --json > licenses.json
node scripts/check-licenses.mjs   # 允许清单，失败阻断
pnpm audit --prod
```

- 允许清单与本文一致；未知许可证阻断。
- 传递依赖也检查。
- 例外需 `docs/05-research/license-exceptions.md`（实现阶段）记录批准人/范围/到期。

## 9. 参考产品的许可证事实（2026-10-31）

| 项目 | 许可证 | 关键限制 | 本项目 |
|---|---|---|---|
| JeecgBoot | Apache-2.0 + 补充条款 | 不得开发竞争软件；保留品牌/版权 | 不复制 |
| NocoBase | NocoBase License Agreement | 不得去除品牌；不得对外提供同类无代码 SaaS/PaaS | 不复制 |
| Yudao Cloud | MIT | 保留版权/许可 | 不复制 |
| Plane | AGPL-3.0 | 网络使用需提供源码 | 不复制 |
| ERPNext | GPL-3.0 | 衍生/分发需 GPL | 不复制 |
| Dolibarr | GPL-3.0-or-later | 同上 | 不复制 |
| AppFlowy | AGPL-3.0 | 网络使用需提供源码 | 不复制 |
| n8n | Sustainable Use License | 仅内部/非商业分发限制 | 不复制 |
| Twenty | AGPL-3.0 + 商业文件/MIT 包 | 混合许可，商业文件需订阅 | 不复制 |
| Linear | 专有 | 无开源许可 | 不复制 |

> 以上为公开仓库信息；保留来源/版本/许可证声明，不额外建立许可证审查流程。

## 10. 当前状态与待办

- [x] 正式项目未安装任何依赖。
- [x] 项目外临时目录完成 lmdb/classic-level 原型验证（见嵌入式存储评估）。
- [x] 未复制任何参考项目代码。
- [x] 计划依赖许可证已初步核对。
- [ ] 初始化时逐项核验包内 LICENSE。
- [ ] 确认项目自身许可证（Q-002）。
- [ ] 创建 `THIRD_PARTY_NOTICES.md`。
- [ ] CI 许可证检查脚本。
- [ ] 生成 SBOM（P1）。






