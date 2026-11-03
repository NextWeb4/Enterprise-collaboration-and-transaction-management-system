# 组织目录、员工档案与岗位管理

状态：组织服务、路由、独立前端页面、OpenAPI 和真实 LMDB 服务测试已实现。该模块不改变 M0 验收结论。

## 页面与交互

- `OrganizationDirectoryPage` 使用 TanStack Query 获取服务端已脱敏的通讯录，可按姓名、内部账号、部门和岗位本地搜索；搜索不改变服务端授权结果。
- `EmployeesPage` 是独立的员工管理页面，使用 TanStack Query、React Hook Form 和 Zod。具备 `employee:read` 的主体可查看；同时具备 `employee:manage` 可新建、编辑员工档案，并从现有安全接口选择在职账号、部门、岗位及直属上级。
- `PositionsPage` 使用相同的数据获取/表单机制，具备 `position:manage` 时可新建、编辑、启用/停用及删除岗位。删除仍由服务端确认不存在员工引用。
- `EmployeeProfilePage` 保持作为“我的员工档案”独立路由。前端导航/路由接入由宿主 `App` 统一负责。

## 数据与安全边界

- 直属上级的唯一权威字段是 `UserDocument.managerId`；员工档案 API 的 `managerId` 在同一 LMDB 写事务内更新该字段，`EmployeeDocument` 不重复保存。
- 头像上传、文件授权和 `refCount` 维护尚未形成闭环，`avatarFileId` 目前只能为 `null`；服务端会拒绝非空值，员工表单也明确提示该限制。
- 创建或编辑档案会校验账号、部门、启用岗位和直属上级存在性，并拒绝汇报关系循环；员工编号及一人一档由唯一索引和服务校验保证。
- 通讯录不返回电话；员工档案电话只对本人、组织/系统管理员或拥有全局员工管理范围的主体以脱敏形式返回。
- `department` 和 `department_tree` 数据范围必须能由部门树证明；无法证明时返回 403，不会退化为全组织结果。
- 岗位名称和编码包含软删除历史在内均不可重用；被任一未软删除员工档案引用的岗位不能删除。

## HTTP 契约

完整请求/响应和 CSRF 契约见 [organization-directory.openapi.json](../03-technical/organization-directory.openapi.json)。

关键端点：

- `GET /api/v1/organization/directory`：脱敏通讯录；
- `GET /api/v1/organization/active-users`：不依赖员工档案的在职账号最小选择器；
- `GET/POST /api/v1/organization/employees`、`GET/PATCH /api/v1/organization/employees/{id}`；
- `GET/POST/PATCH/DELETE /api/v1/organization/positions`；
- `GET /api/v1/organization/departments/tree`。

## 验证

`app/backend/test/organization-directory.test.ts` 使用临时真实 LMDB 覆盖账号/部门/岗位引用校验、员工/岗位唯一性、手机号脱敏、岗位引用删除保护和未证明部门范围的 fail-closed 行为。
