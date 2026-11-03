# 项目完成分析 CSV 导出

## 范围

`GET /api/v1/analytics/project-completion/export` 导出经营分析页面已有的项目完成快照。它复用 `ProjectAnalyticsService.projectCompletion`，因此项目读取权限、分析权限、项目隐私、本人/全量范围及日期筛选与页面报表一致。CSV 仅含项目字段和聚合任务指标，不含用户标识、任务正文、文件路径或存储字段。

当前实现同步生成并直接返回 CSV，使用固定文件名、UTF-8 BOM、CRLF、CSV 引号转义和公式前缀防护。项目行数超过 10,000 时拒绝导出，不截断；成功响应使用 `Cache-Control: no-store` 并在发文件前追加审计，审计只记录格式、行数和筛选摘要。

## 与完整 P1-AN-06 的差异

完整需求还包括 XLSX、水印/来源、异步生成和短时下载链接。本切片仅交付 CSV 和来源/统计口径列；没有引入作业队列、导出文件存储或新的依赖。异步链接及其过期清理需另行设计和验收，不得将本接口描述为已覆盖完整 P1-AN-06。

## 接入

`buildApp` 已实例化 `ProjectAnalyticsExportService(analytics, audit)` 并注册 `registerProjectAnalyticsExportRoutes(app, { service: analyticsExport, requireAuth })`。真实 LMDB API 测试通过生产组合根和登录 Cookie 验证路由、权限拒绝与审计。
