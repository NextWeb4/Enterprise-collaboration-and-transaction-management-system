# 文档中心实现与存储维护

状态：文档上传、追加版本、检索、分类/标签、项目关联、ACL、归档/软删除、鉴权下载及受限在线预览已实现；M0 仍未通过。本模块不提供 `/api/v1/files` 业务旁路。

## 业务边界

- 文档版本只追加；每个版本保存上传时的文件名、MIME、大小和 SHA-256。物理文件按内容寻址去重，但展示元数据属于版本而不是第一次上传者。
- TXT、Markdown、CSV 在上传、追加或版本恢复时会以严格 UTF-8 提取最多 1MiB 的当前版本正文到 `document_texts`。这是可重建的派生索引，不返回原文或命中片段；检索先执行文档 ACL，再匹配标题、说明、标签和该索引。非文本、超过上限和历史既有文件不自动产生正文索引。
- 文档下载先在 LMDB 事务内重验会话、文档 ACL、版本归属和文件元数据；打开文件后再次重验 ACL。具体资源越权返回 404。
- 在线预览沿用下载的双重会话/ACL 重验，但仅允许已通过上传文件头校验的 PDF、PNG、JPEG。响应使用 `inline`、`private, no-store`、`nosniff` 和独立的受限 CSP；预览在新标签页打开，并单独追加 `document.previewed` 审计。Office 与文本格式仍只支持下载。
- 写请求要求有效会话、权限码、Origin 和 CSRF；上传仅接受一个 `file` 与一个 JSON 字符串 `metadata`，失败时清理暂存文件。
- 项目私有性先于文档 ACL；归档文档/项目只读。文档软删除保留版本与文件引用用于审计，不释放历史文件。

## 存储维护

`inspectDocumentStorage(tx)` 只从 `documents`、`document_versions`、`document_texts`、`document_acl`、`document_categories`、`tags`、`document_tags` 主记录重建预期索引，并检查：版本序号连续、currentVersionId/versionCount、当前正文索引指向当前版本且 SHA-256 一致、分类树深度/父引用、ACL/标签引用、版本文件 SHA-256/大小。

`inspectDirectoryStorage(tx)` 校验部门父子关系和员工/岗位主记录、全部目录索引、员工与用户部门一致性以及岗位名称/编码历史唯一性。

`inspectFileReferences(tx)` 以业务引用为事实源：活动 `document_versions` 与活动 `application_attachments` 的引用数必须与 `files.refCount` 相等，文件状态、存在性、SHA-256、大小必须一致。孤立或低层 `FileService.save` 产生的未绑定文件会使 `storage:verify` 失败；维护命令不会猜测删除、绑定或迁移。

`storage:verify` 以允许读取旧标记的模式打开 LMDB，保留缺失或非法 `schemaVersion` 现场；它在只读事务中校验核心、组织、审批、文档和项目主记录、全部可重建索引及文件业务引用，并复核审计链和物理文件。`inspectFileReferences` 将活动 `document_versions` 与活动 `application_attachments` 分别计数后求和，再与 `files.refCount`、文件状态、哈希及大小核对；`refCount` 本身不作为引用事实源。

`storage:rebuild-indexes` 持有单实例锁，先校验审计链与物理文件；随后在维护事务内校验全部主记录、关系、唯一键、文件业务引用和扫描上限，并为全部索引生成预期键集合。只有预检无任何问题时，才在同一事务中清空并重建索引。任一检查失败均不改写索引；维护命令绝不重算/修复 `refCount`、历史链或业务源数据，也不删除或绑定文件。

## P1-DOC-04 批量操作

`POST /api/v1/documents/batch` 接受 `operation` 与 1–100 个唯一 `{id, version}` 项。支持 `move_category`、`add_tags`、`archive`。每个文档在单独的 LMDB 写事务中重新验证有效会话、`document:acl:manage`、该文档的 manage 级访问和乐观锁版本；状态变更与该项审计记录在同一事务提交。一个项目失败不会回滚其他项目，响应按请求顺序逐项返回 `{id, success, version}` 或 `{id, success, code, message}`，并给出成功/失败计数。请求结构错误、重复 ID 或超过 100 项则整体返回 422。

需求未定义打标签是追加还是替换，本实现采用较保守的**追加**语义，不移除已有标签；单文档最终标签数仍不得超过 10。分类 ID 为 `null` 表示移动到根分类。已归档文档或关联项目已归档的文档只读，逐项返回状态冲突。前端只允许选择当前可见且级别为 manage、状态 active 的文档，最多跨页选择 100 项；服务端仍逐项执行授权与版本检查。

## 验证证据

- `document-service.test.ts`：真实临时 LMDB 覆盖去重文件名、ACL 动态撤销、版本并发、回滚/暂存清理、分类树、软删除保留文件、Fastify multipart 下载。
- `DocumentsPage.test.tsx`：权限门禁、空结果/标题检索、只读下载链接、实际 File 上传与刷新。
- `project-storage-maintenance.test.ts`、`organization-department.test.ts`、`approval-service.test.ts`、`storage-maintenance-integrity.test.ts`：CLI 隔离目录的索引损坏检测、重建、重启持久化，以及文档版本+活动申请附件引用数对账、`refCount` 不一致不自动修复、唯一键冲突拒绝重建、schema 标记保留、目录上下级和审批引用完整性；维护回归使用真实 LMDB。
- `document-service.test.ts`：批量接口 Fastify 注入、管理权限/版本冲突/资源不可见的逐项结果、标签追加和归档、审计失败时回滚，以及 100 项上限；用例运行于真实临时 LMDB。
- `DocumentsPage.test.tsx`：manage 用户选择文档、批量归档并查看逐项部分失败结果。

## 已知限制

当前在线预览不包含 Office 转换、富文本渲染或二进制正文提取；不伪称 DOCX/XLSX/PPTX/TXT/MD/CSV 已可预览。全文检索当前仅覆盖不超过 1MiB 的 UTF-8 TXT、MD、CSV，未覆盖 PDF、图片或 Office 文件，也没有历史文件回填任务。文件白名单仍沿用安全设计的 PDF、PNG、JPEG、TXT、MD、CSV、OOXML ZIP 类型；旧 DOC/XLS/PPT 不因产品描述而放宽。目录员工 `avatarFileId` 仅是现有元数据字段，尚未接入文件绑定/引用对账，不能作为已实现的文件上传能力。
